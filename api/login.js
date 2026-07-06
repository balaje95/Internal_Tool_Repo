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

  // Constant-time-ish comparison to avoid trivial timing leaks.
  const uOk = crypto.timingSafeEqual(Buffer.from(username.padEnd(64).slice(0, 64)), Buffer.from(AUTH_USERNAME.padEnd(64).slice(0, 64)));
  const pOk = crypto.timingSafeEqual(Buffer.from(password.padEnd(64).slice(0, 64)), Buffer.from(AUTH_PASSWORD.padEnd(64).slice(0, 64)));
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
