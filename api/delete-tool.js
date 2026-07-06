// Serverless function: deletes a registered tool — removes its HTML file and its
// entry in assets/tools.config.js via GitHub commits. Vercel then auto-redeploys.
//
// Security: the target path is only ever accepted if it matches a `file` already
// registered in tools.config.js, so this can only delete real tool files — never
// arbitrary repo paths. Same env vars as add-tool.js (ADMIN_PASSWORD gate).

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
  const { toolFile, password } = req.body || {};

  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Incorrect password." });
    return;
  }
  if (!toolFile || typeof toolFile !== "string") {
    res.status(400).json({ error: "Missing toolFile." });
    return;
  }

  try {
    const configPath = "assets/tools.config.js";
    const configFile = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${configPath}?ref=${branch}`,
      GITHUB_TOKEN
    );
    const configText = Buffer.from(configFile.content, "base64").toString("utf-8");
    const configMatch = configText.match(/const TOOLS = (\[[\s\S]*\]);\s*$/);
    if (!configMatch) throw new Error("Could not find `const TOOLS = [...]` in tools.config.js");
    const tools = JSON.parse(configMatch[1]);

    const tool = tools.find((t) => t.file === toolFile);
    if (!tool) {
      res.status(400).json({ error: "That tool isn't registered in tools.config.js." });
      return;
    }

    // Delete the tool file (look up its blob sha first). Tolerate a missing file.
    try {
      const existing = await githubRequest(
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${toolFile}?ref=${branch}`,
        GITHUB_TOKEN
      );
      await githubRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${toolFile}`, GITHUB_TOKEN, {
        method: "DELETE",
        body: JSON.stringify({ message: `Delete tool file: ${tool.name}`, sha: existing.sha, branch })
      });
    } catch (e) {
      // If the file was already gone, keep going to clean up the config entry.
    }

    const remaining = tools.filter((t) => t.file !== toolFile);
    const newConfigText = configText.replace(configMatch[0], `const TOOLS = ${JSON.stringify(remaining, null, 2)};\n`);
    await githubRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${configPath}`, GITHUB_TOKEN, {
      method: "PUT",
      body: JSON.stringify({
        message: `Unregister tool: ${tool.name}`,
        content: Buffer.from(newConfigText, "utf-8").toString("base64"),
        sha: configFile.sha,
        branch
      })
    });

    res.status(200).json({ ok: true, file: toolFile });
  } catch (err) {
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
