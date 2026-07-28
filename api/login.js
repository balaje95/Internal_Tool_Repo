// Serverless login endpoint. Verifies credentials against env vars and issues a
// signed, HTTP-only cookie that middleware.js checks on every route.
//
// Required env vars:
//   AUTH_USERNAME       - e.g. "admin"
//   AUTH_PASSWORD       - the shared passphrase
//   AUTH_COOKIE_SECRET  - a long random string used to sign the cookie
//
// Cookie: zuper_auth = <exp>.<hmac-sha256(exp, AUTH_COOKIE_SECRET)>, 12h lifetime.

const crypto = require('crypto');

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

// Compare via SHA-256 digests so both buffers are always 32 bytes. Comparing
// `padEnd(64).slice(0,64)` strings directly is unsafe: padEnd/slice count UTF-16
// code units while Buffer.from() encodes UTF-8, so any multi-byte character
// (accent, emoji) yields different byte lengths and timingSafeEqual throws —
// turning every login into a 500. Digesting also removes the 64-char truncation,
// which previously let a 64-char prefix authenticate.
function secureEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const db = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(da, db);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const { AUTH_USERNAME, AUTH_PASSWORD, AUTH_COOKIE_SECRET } = process.env;
  if (!AUTH_USERNAME || !AUTH_PASSWORD || !AUTH_COOKIE_SECRET) {
    res.status(500).json({ error: 'Auth is not configured on the server (missing AUTH_* env vars).' });
    return;
  }

  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';

  // Constant-time comparison to avoid trivial timing leaks.
  const uOk = secureEqual(username, AUTH_USERNAME);
  const pOk = secureEqual(password, AUTH_PASSWORD);
  if (!uOk || !pOk) {
    res.status(401).json({ error: 'Incorrect username or password.' });
    return;
  }

  const maxAgeSec = 12 * 60 * 60;
  const exp = Date.now() + maxAgeSec * 1000;
  const token = exp + '.' + sign(String(exp), AUTH_COOKIE_SECRET);
  res.setHeader('Set-Cookie', `zuper_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`);
  res.status(200).json({ ok: true });
};
