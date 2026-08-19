// Serverless publish endpoint for the Go-Live Dashboard (tools/go-live-dashboard.html).
//
// The dashboard is a static page and viewers need no credentials, so the weekly export
// has to live in the repo. An admin drops the Zoho Projects export into the hidden panel
// (Ctrl+A), the browser parses it with SheetJS, and posts the parsed rows here. This
// commits data/golive.json, Vercel auto-redeploys, and every viewer picks it up.
//
// Parsing deliberately happens in the browser: this repo has no package.json and no
// node_modules, so a serverless function cannot require an xlsx library.
//
// Required env vars (already configured for api/add-tool.js):
//   GITHUB_TOKEN    - PAT with Contents: Read and write on this repo
//   GITHUB_OWNER    - repo owner
//   GITHUB_REPO     - repo name
//   GITHUB_BRANCH   - optional, defaults to "main"
//   ADMIN_PASSWORD  - same shared password the Add Tool form uses

const GITHUB_API = 'https://api.github.com';
const DATA_PATH = 'data/golive.json';
const MAX_PROJECTS = 5000;
const MAX_JSON_BYTES = 3 * 1024 * 1024;   // well under the ~4.5MB Vercel body cap

// Every field the dashboard renders. Anything else in the payload is discarded rather
// than committed, so a stray spreadsheet column cannot end up in the published file.
const STRING_FIELDS = ['name', 'sa', 'ba', 'owner', 'status', 'eta', 'etaMonth', 'start', 'url', 'comments'];

async function githubRequest(path, token, options = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

// data/golive.json does not exist on the very first publish, and GitHub needs the blob
// sha only when replacing an existing file.
async function existingSha(path, token, owner, repo, branch) {
  try {
    const file = await githubRequest(`/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, token);
    return file.sha || null;
  } catch (err) {
    if (/failed: 404/.test(err.message)) return null;
    throw err;
  }
}

// The dashboard builds table rows and the drawer with innerHTML, so angle brackets are
// stripped here rather than trusting every future spreadsheet to be well behaved.
function cleanString(v, max) {
  return String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, max);
}

// A javascript: or data: URL would become a live link in the drawer. Only http(s) passes.
function cleanUrl(v) {
  const s = cleanString(v, 500);
  return /^https?:\/\//i.test(s) ? s : '';
}

function sanitize(rows) {
  return rows.map((row) => {
    const out = {};
    STRING_FIELDS.forEach((k) => {
      out[k] = k === 'url' ? cleanUrl(row[k]) : cleanString(row[k], k === 'comments' ? 4000 : 300);
    });
    const n = Number(row.amount);
    out.amount = isFinite(n) && n > 0 ? Math.round(n) : 0;
    return out;
  }).filter((r) => r.name);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, ADMIN_PASSWORD } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !ADMIN_PASSWORD) {
    res.status(500).json({ error: 'Server is missing required configuration. Check Vercel environment variables.' });
    return;
  }
  const branch = GITHUB_BRANCH || 'main';
  const { password, projects, source } = req.body || {};

  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Incorrect password.' });
    return;
  }
  if (!Array.isArray(projects) || !projects.length) {
    res.status(400).json({ error: 'No projects in the upload.' });
    return;
  }
  if (projects.length > MAX_PROJECTS) {
    res.status(400).json({ error: `That file has ${projects.length} rows, over the ${MAX_PROJECTS} limit.` });
    return;
  }

  const clean = sanitize(projects);
  if (!clean.length) {
    res.status(400).json({ error: 'Every row was discarded — none had a project name.' });
    return;
  }

  const payload = {
    updated_at: new Date().toISOString(),
    count: clean.length,
    source: {
      filename: cleanString(source && source.filename, 200),
      rows_in_file: Number(source && source.rows) || null,
    },
    projects: clean,
  };
  const text = JSON.stringify(payload, null, 1) + '\n';
  if (Buffer.byteLength(text, 'utf-8') > MAX_JSON_BYTES) {
    res.status(400).json({ error: 'That export is too large to publish.' });
    return;
  }

  try {
    const sha = await existingSha(DATA_PATH, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, branch);
    const body = {
      message: `Go-Live Dashboard: publish export (${clean.length} projects`
        + (payload.source.filename ? `, ${payload.source.filename}` : '') + ')',
      content: Buffer.from(text, 'utf-8').toString('base64'),
      branch,
    };
    if (sha) body.sha = sha;

    const result = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${DATA_PATH}`,
      GITHUB_TOKEN,
      { method: 'PUT', body: JSON.stringify(body) }
    );

    res.status(200).json({
      ok: true,
      count: clean.length,
      path: DATA_PATH,
      commit: (result.commit && result.commit.sha || '').slice(0, 7),
      updated_at: payload.updated_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unknown error' });
  }
};
