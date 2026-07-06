// Vercel Edge Middleware — gates the whole site behind a login cookie.
//
// FAIL-OPEN: if AUTH_USERNAME / AUTH_PASSWORD / AUTH_COOKIE_SECRET are not set in
// the environment, the gate does nothing and the site stays open. This means
// deploying this file is safe on its own — it only starts protecting once those
// env vars are configured in Vercel.
//
// The login cookie is `zuper_auth = <exp>.<hmac-sha256(exp)>`, signed with
// AUTH_COOKIE_SECRET. Issued by /api/login (Node crypto), verified here (Web Crypto).

export const config = {
  // Run on everything except the login page, the login API, and static assets.
  matcher: ['/((?!api/login|login.html|assets/|favicon.ico|robots.txt).*)'],
};

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  const m = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function verifyToken(token, secret) {
  if (!token) return false;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return false;
  const exp = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!/^\d+$/.test(exp) || Date.now() > Number(exp)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const macBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(exp));
  const expected = Array.from(new Uint8Array(macBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export default async function middleware(request) {
  const secret = process.env.AUTH_COOKIE_SECRET;
  const user = process.env.AUTH_USERNAME;
  const pass = process.env.AUTH_PASSWORD;

  // Fail-open: no auth configured -> let everything through.
  if (!secret || !user || !pass) return;

  const url = new URL(request.url);
  const p = url.pathname;

  // Explicit allow-list (belt-and-suspenders alongside the matcher).
  if (p === '/login.html' || p.startsWith('/api/login') || p.startsWith('/assets/')
      || p === '/favicon.ico' || p === '/robots.txt') {
    return;
  }

  const ok = await verifyToken(getCookie(request, 'zuper_auth'), secret);
  if (ok) return;

  // Unauthenticated: API calls get 401 JSON; pages redirect to login.
  if (p.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  const loginUrl = new URL('/login.html', request.url);
  loginUrl.searchParams.set('next', p + url.search);
  return Response.redirect(loginUrl, 302);
}
