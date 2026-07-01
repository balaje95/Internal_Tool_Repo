// Vercel serverless function: commits a new tool's HTML file + a new entry in
// assets/tools.config.js straight to the GitHub repo. Vercel's GitHub integration
// then auto-redeploys, so the new tile shows up for everyone on the live URL.
//
// Required env vars (set in Vercel -> Project -> Settings -> Environment Variables):
//   GITHUB_TOKEN    - a GitHub Personal Access Token with `repo` scope (or fine-grained
//                      "Contents: Read and write" on this repo). Server-side only, never
//                      sent to the browser.
//   GITHUB_OWNER    - the GitHub username/org that owns the repo, e.g. "balajen"
//   GITHUB_REPO     - the repo name, e.g. "internal-tools-dashboard"
//   GITHUB_BRANCH   - optional, defaults to "main"
//   ADMIN_PASSWORD  - shared password required in the request body; without this,
//                      anyone who finds the deployed URL could inject arbitrary HTML
//                      onto the dashboard.
//
// Known limits: Vercel serverless functions cap the request body around ~4.5MB, and
// base64 encoding adds ~33% overhead, so uploaded tool files bigger than roughly 3MB
// will be rejected by the platform before this code even runs.

const GITHUB_API = "https://api.github.com";

function slugify(name) {
  const slug = String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "tool";
}

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
  return { arrayText: match[1], fullMatch: match[0] };
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
  const { name, description, icon, password, filename, fileContent } = req.body || {};

  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Incorrect password." });
    return;
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Tool name is required." });
    return;
  }
  if (!description || typeof description !== "string" || !description.trim()) {
    res.status(400).json({ error: "Tool description is required." });
    return;
  }
  if (!filename || !/\.html?$/i.test(filename)) {
    res.status(400).json({ error: "Uploaded file must be an .html file." });
    return;
  }
  if (!fileContent || typeof fileContent !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(fileContent)) {
    res.status(400).json({ error: "Missing or invalid (non-base64) file content." });
    return;
  }

  const trimmedName = name.trim().slice(0, 120);
  const trimmedDescription = description.trim().slice(0, 300);
  const trimmedIcon = (icon || "🔧").trim().slice(0, 8) || "🔧";

  try {
    const configPath = "assets/tools.config.js";
    const configFile = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${configPath}?ref=${branch}`,
      GITHUB_TOKEN
    );
    const configText = Buffer.from(configFile.content, "base64").toString("utf-8");
    const { arrayText, fullMatch } = extractToolsArray(configText);
    const tools = JSON.parse(arrayText);

    let slug = slugify(trimmedName);
    const existingFiles = new Set(tools.map((t) => t.file));
    let candidate = `tools/${slug}.html`;
    let suffix = 2;
    while (existingFiles.has(candidate)) {
      candidate = `tools/${slug}-${suffix}.html`;
      suffix += 1;
    }
    const toolFilePath = candidate;

    // Create the new tool's HTML file first; if this fails we never touch the config.
    await githubRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${toolFilePath}`, GITHUB_TOKEN, {
      method: "PUT",
      body: JSON.stringify({
        message: `Add tool: ${trimmedName}`,
        content: fileContent,
        branch
      })
    });

    tools.push({
      name: trimmedName,
      description: trimmedDescription,
      file: toolFilePath,
      icon: trimmedIcon
    });

    const newConfigText = configText.replace(
      fullMatch,
      `const TOOLS = ${JSON.stringify(tools, null, 2)};\n`
    );

    await githubRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${configPath}`, GITHUB_TOKEN, {
      method: "PUT",
      body: JSON.stringify({
        message: `Register tool in dashboard: ${trimmedName}`,
        content: Buffer.from(newConfigText, "utf-8").toString("base64"),
        sha: configFile.sha,
        branch
      })
    });

    res.status(200).json({ ok: true, file: toolFilePath });
  } catch (err) {
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
