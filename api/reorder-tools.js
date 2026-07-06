// Serverless function: rewrites assets/tools.config.js with the tools in a new
// order. Accepts { order: [file, file, ...], password }. Only reorders existing
// entries — unknown files are ignored, and any registered tool missing from
// `order` is appended at the end so nothing is ever dropped. ADMIN_PASSWORD gated.

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
  const { order, password } = req.body || {};

  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Incorrect password." });
    return;
  }
  if (!Array.isArray(order) || !order.length) {
    res.status(400).json({ error: "Missing or empty `order` array." });
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

    const byFile = new Map(tools.map((t) => [t.file, t]));
    const reordered = [];
    order.forEach((file) => {
      if (byFile.has(file)) { reordered.push(byFile.get(file)); byFile.delete(file); }
    });
    // Append any tools not mentioned in `order` (safety — never drop entries).
    byFile.forEach((t) => reordered.push(t));

    if (reordered.length !== tools.length) {
      res.status(400).json({ error: "Order did not account for all tools; aborting to avoid data loss." });
      return;
    }

    const newConfigText = configText.replace(configMatch[0], `const TOOLS = ${JSON.stringify(reordered, null, 2)};\n`);
    await githubRequest(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${configPath}`, GITHUB_TOKEN, {
      method: "PUT",
      body: JSON.stringify({
        message: "Reorder dashboard tools",
        content: Buffer.from(newConfigText, "utf-8").toString("base64"),
        sha: configFile.sha,
        branch
      })
    });

    res.status(200).json({ ok: true, count: reordered.length });
  } catch (err) {
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
