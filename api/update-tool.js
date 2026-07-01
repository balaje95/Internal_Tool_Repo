// Vercel serverless function: overwrites an EXISTING tool's HTML file in the GitHub
// repo with newly uploaded content. Unlike add-tool.js, this does not touch
// assets/tools.config.js — the tool's name/description/icon/path stay the same,
// only the file content changes.
//
// Security: the target file path is only ever taken from tools.config.js's own
// TOOLS list (never trusted from the client as a free-form path), so this endpoint
// can only ever overwrite files that are already registered as tools — never
// arbitrary repo paths like api/*.js.
//
// Required env vars: same as api/add-tool.js (GITHUB_TOKEN, GITHUB_OWNER,
// GITHUB_REPO, GITHUB_BRANCH, ADMIN_PASSWORD).

const GITHUB_API = "https://api.github.com";

async function githubRequest(path, token, options = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${options.method || "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

function extractToolsArray(fileText) {
  const match = fileText.match(/const TOOLS = (\[[\s\S]*\]);\s*$/);
  if (!match) {
    throw new Error("Could not find `const TOOLS = [...]` in tools.config.js");
  }
  return JSON.parse(match[1]);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, ADMIN_PASSWORD } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !ADMIN_PASSWORD) {
    res.status(500).json({ error: "Server is missing required configuration. Check Vercel environment variables." });
    return;
  }

  const branch = GITHUB_BRANCH || "main";
  const { toolFile, password, fileContent } = req.body || {};

  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Incorrect password." });
    return;
  }
  if (!toolFile || typeof toolFile !== "string") {
    res.status(400).json({ error: "Missing toolFile." });
    return;
  }
  if (!fileContent || typeof fileContent !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(fileContent)) {
    res.status(400).json({ error: "Missing or invalid (non-base64) file content." });
    return;
  }

  try {
    const configPath = "assets/tools.config.js";
    const configFile = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${configPath}?ref=${branch}`,
      GITHUB_TOKEN
    );
    const configText = Buffer.from(configFile.content, "base64").toString("utf-8");
    const tools = extractToolsArray(configText);

    const tool = tools.find((t) => t.file === toolFile);
    if (!tool) {
      res.status(400).json({ error: "That tool isn't registered in tools.config.js." });
      return;
    }

    const existing = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${toolFile}?ref=${branch}`,
      GITHUB_TOKEN
    );

    await githubRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${toolFile}`, GITHUB_TOKEN, {
      method: "PUT",
      body: JSON.stringify({
        message: `Update tool: ${tool.name}`,
        content: fileContent,
        sha: existing.sha,
        branch
      })
    });

    res.status(200).json({ ok: true, file: toolFile });
  } catch (err) {
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
