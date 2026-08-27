// CompanyCam read-only relay.
//
// Why this exists: CompanyCam's API sends no CORS headers, so the browser can't
// call it directly from the tool page. Public CORS proxies are useless here
// because they strip the Authorization header (that's the mystery 401). This
// relay forwards it untouched.
//
// It lives in this repo on purpose — the tool page and this function share an
// origin, so no CORS headers are needed and middleware.js's login gate already
// covers /api/*. An unauthenticated caller gets 401 from the middleware before
// reaching this code.
//
// Used by tools/companycam-sync.html as: /api/companycam?url=<encoded CC url>

const ALLOW_HOSTS = new Set([
  'api.companycam.com',      // the REST API
  'static.companycam.com',   // document / photo assets
]);

const TIMEOUT_MS = 20000;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  // Read-only relay: listing projects and documents is all the tool needs.
  // Attachments are handed to Zuper as URLs, so file bytes never pass through here.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'missing ?url=' });

  let u;
  try { u = new URL(target); } catch { return res.status(400).json({ error: 'bad url' }); }
  if (u.protocol !== 'https:') return res.status(400).json({ error: 'https only' });
  if (!ALLOW_HOSTS.has(u.hostname)) {
    return res.status(403).json({ error: 'host not allowed', host: u.hostname });
  }

  // Forward only what CompanyCam needs. Never log the Authorization value.
  const headers = {};
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  headers.accept = req.headers.accept || 'application/json';

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(u.toString(), {
      method: req.method,
      headers,
      signal: ac.signal,
      redirect: 'follow',
    });
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    // Surface CompanyCam's rate-limit budget so the tool can back off.
    for (const h of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (req.method === 'HEAD') return res.end();
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return res.status(aborted ? 504 : 502).json({
      error: aborted ? 'upstream timed out' : 'upstream fetch failed',
      detail: String(e && e.message || e),
    });
  } finally {
    clearTimeout(timer);
  }
}
