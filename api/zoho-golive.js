// Serverless read-only proxy for the Go-Live Dashboard (tools/go-live-dashboard.html).
//
// Why this exists: projectsapi.zoho.com sends no Access-Control-Allow-Origin header
// and the Zoho REST API only accepts an OAuth access token (never a browser session
// cookie), so the dashboard cannot call Zoho directly. This function refreshes an
// access token server-side, pages through every project in the portal, and returns
// the normalized rows the dashboard renders. The refresh token never reaches the
// browser.
//
// Required env vars (Vercel -> Project Settings -> Environment Variables):
//   ZOHO_CLIENT_ID      - Self Client id from api-console.zoho.com
//   ZOHO_CLIENT_SECRET  - Self Client secret
//   ZOHO_REFRESH_TOKEN  - permanent refresh token (scope ZohoProjects.projects.READ)
//
// Optional env vars:
//   ZOHO_PORTAL_ID      - defaults to the zuperinc portal (756086486)
//   ZOHO_ACCOUNTS_HOST  - defaults to accounts.zoho.com (use accounts.zoho.eu or
//                         accounts.zoho.in for those data centres)
//   ZOHO_API_HOST       - defaults to projectsapi.zoho.com
//
// Query params:
//   ?since=YYYY-MM-DD   - only projects created on or after this date. Defaults to
//                         the cohort start below; pass since=all to disable.
//   ?industry=Roofing   - industry custom field to match; industry=all disables.
//   ?debug=1            - adds page_info plus one raw project so field drift shows.
//   ?portals=1          - lists the portals this token can see (to find a portal id).
//   ?diag=1             - reports which credential Zoho is unhappy with, without
//                         printing any secret (lengths and the shared 1000. prefix
//                         only). Use this first when the dashboard says invalid_code.

const DEFAULT_PORTAL_ID = '756086486';        // zuperinc
const DEFAULT_SINCE = '2025-10-20';           // start of the tracked roofing cohort
const DEFAULT_INDUSTRY = 'Roofing';
const EXCLUDED_TAG = 'InActive User';         // internal / test projects
const HUBSPOT_DEAL_BASE = 'https://app.hubspot.com/contacts/8599304/record/0-3/';
const PER_PAGE = 100;
const MAX_PAGES = 20;                         // backstop against a paging loop

// Cached across warm invocations so a burst of Refresh clicks costs one token call.
let tokenCache = { token: null, expiresAt: 0 };

function accountsHost() { return (process.env.ZOHO_ACCOUNTS_HOST || 'accounts.zoho.com').trim(); }
function apiHost() { return (process.env.ZOHO_API_HOST || 'projectsapi.zoho.com').trim(); }

// Pasting a credential into the Vercel UI very easily carries a trailing newline or
// space, and Zoho answers that with a flat "invalid_code" — indistinguishable from a
// genuinely wrong token. Trim before use so that failure mode cannot happen.
function env(name) { return String(process.env[name] || '').trim(); }

// Enough to tell a wrong value from a whitespace problem, without printing a secret.
// Every Zoho id/code/token shares the "1000." prefix, so showing it reveals nothing.
function inspect(name) {
  const raw = String(process.env[name] || '');
  return {
    present: raw.length > 0,
    length: raw.length,
    length_trimmed: raw.trim().length,
    had_surrounding_whitespace: raw !== raw.trim(),
    has_inner_whitespace: /\s/.test(raw.trim()),
    prefix: raw.trim().slice(0, 5),
  };
}

// Keep the Zoho error text (it is specific and useful) but never echo secrets.
async function readErr(res) {
  const body = await res.text().catch(() => '');
  return body.slice(0, 400).replace(/\s+/g, ' ').trim();
}

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const params = new URLSearchParams({
    refresh_token: env('ZOHO_REFRESH_TOKEN'),
    client_id: env('ZOHO_CLIENT_ID'),
    client_secret: env('ZOHO_CLIENT_SECRET'),
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://' + accountsHost() + '/oauth/v2/token?' + params.toString(), {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error('Zoho token refresh failed (' + res.status + '): ' + (await readErr(res)));
  }

  const json = await res.json();
  // Zoho answers 200 with bodies like {"error":"invalid_client"}, so check the payload.
  if (json.error) throw new Error('Zoho token refresh rejected: ' + json.error);
  if (!json.access_token) throw new Error('Zoho token refresh returned no access_token.');

  const ttlMs = (Number(json.expires_in) || 3600) * 1000;
  tokenCache = { token: json.access_token, expiresAt: Date.now() + ttlMs - 60000 };
  return tokenCache.token;
}

async function zohoGet(path, token) {
  const res = await fetch('https://' + apiHost() + path, {
    headers: { Authorization: 'Zoho-oauthtoken ' + token, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error('Zoho API ' + path + ' failed (' + res.status + '): ' + (await readErr(res)));
  }
  return res.json();
}

// The V3 envelope is not identical across endpoints, and the MCP connector used while
// prototyping wrapped it again, so accept every shape rather than bet on one.
function rowsOf(json) {
  if (Array.isArray(json)) return json;
  if (!json) return [];
  if (Array.isArray(json.projects)) return json.projects;
  if (Array.isArray(json.result)) return json.result;
  if (json.data) {
    if (Array.isArray(json.data)) return json.data;
    if (Array.isArray(json.data.result)) return json.data.result;
    if (Array.isArray(json.data.projects)) return json.data.projects;
  }
  return [];
}

async function fetchAllProjects(token, portalId) {
  const base = '/api/v3/portal/' + portalId + '/projects';
  const out = [];
  let pageInfo = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await zohoGet(base + '?per_page=' + PER_PAGE + '&page=' + page, token);
    const rows = rowsOf(json);
    out.push(...rows);
    pageInfo = (json && json.page_info) || null;

    const hasNext = pageInfo && typeof pageInfo.has_next_page === 'boolean'
      ? pageInfo.has_next_page
      : rows.length === PER_PAGE;
    if (!rows.length || !hasNext) break;
  }

  // Zoho can repeat a record across page boundaries while data shifts underneath.
  const seen = new Set();
  const unique = out.filter((p) => {
    const id = String((p && (p.id_string || p.id)) || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { projects: unique, fetched: out.length, pageInfo: pageInfo };
}

function fullName(user) {
  if (!user) return '';
  return String(user.full_name || user.name || '').trim();
}

// Several status names carry a trailing space in Zoho ("Churned "), which would break
// every status comparison in the dashboard. Trim before the data leaves this file.
function normalize(p) {
  const eta = p.current_eta || '';
  const dealId = p.deal_id ? String(p.deal_id) : '';
  return {
    name: String(p.name || '').trim(),
    key: p.key || '',
    sa: fullName(p.secondary_owner),
    ba: fullName(p.ba_sa),
    owner: fullName(p.owner),
    status: String((p.status && p.status.name) || '').trim(),
    isClosed: !!(p.status && p.status.is_closed_type),
    eta: eta,
    etaMonth: eta ? String(eta).slice(0, 7) : '',
    start: p.start_date || '',
    actualGoLive: p.actual_go_live || '',
    amount: Number(p.arr_in_usd || 0) || 0,
    url: p.deal_url || (dealId ? HUBSPOT_DEAL_BASE + dealId : ''),
    comments: String(p.project_comments || p.churn_note || '').trim(),
    percentComplete: typeof p.percent_complete === 'number' ? p.percent_complete : null,
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!env('ZOHO_CLIENT_ID') || !env('ZOHO_CLIENT_SECRET') || !env('ZOHO_REFRESH_TOKEN')) {
    res.status(500).json({
      error: 'Zoho is not configured on the server. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET '
        + 'and ZOHO_REFRESH_TOKEN in the Vercel environment variables, then redeploy.',
    });
    return;
  }

  const q = req.query || {};
  const portalId = process.env.ZOHO_PORTAL_ID || DEFAULT_PORTAL_ID;

  // Always live — a cached CDN copy would defeat the Refresh button.
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (q.diag) {
    let tokenResult = 'ok';
    try { await getAccessToken(); } catch (e) { tokenResult = e.message; }
    res.status(200).json({
      accounts_host: accountsHost(),
      api_host: apiHost(),
      portal_id: portalId,
      token_refresh: tokenResult,
      credentials: {
        ZOHO_CLIENT_ID: inspect('ZOHO_CLIENT_ID'),
        ZOHO_CLIENT_SECRET: inspect('ZOHO_CLIENT_SECRET'),
        ZOHO_REFRESH_TOKEN: inspect('ZOHO_REFRESH_TOKEN'),
      },
      hint: 'A Zoho refresh token is typically 70+ chars and starts with 1000. '
        + 'If ZOHO_REFRESH_TOKEN is much shorter, or had_surrounding_whitespace is true, '
        + 'or you pasted the Generate Code value instead of the exchanged refresh_token, '
        + 'Zoho answers invalid_code. Remember to redeploy after changing an env var.',
    });
    return;
  }

  try {
    const token = await getAccessToken();

    if (q.portals) {
      res.status(200).json({ portals: await zohoGet('/api/v3/portals', token) });
      return;
    }

    const pull = await fetchAllProjects(token, portalId);
    const projects = pull.projects;

    const industry = q.industry === 'all' ? null : (q.industry || DEFAULT_INDUSTRY);
    const since = q.since === 'all' ? null : (q.since || DEFAULT_SINCE);
    const sinceTs = since ? Date.parse(since) : null;

    const matched = projects.filter((p) => {
      if (industry && String(p.industry || '') !== industry) return false;
      const tags = Array.isArray(p.business_tag) ? p.business_tag : [];
      if (tags.indexOf(EXCLUDED_TAG) !== -1) return false;
      if (sinceTs && p.created_time && Date.parse(p.created_time) < sinceTs) return false;
      return true;
    });

    const payload = {
      generated_at: new Date().toISOString(),
      portal_id: portalId,
      count: matched.length,
      total_active_projects: projects.length,
      filters: { industry: industry || 'all', since: since || 'all', excluded_tag: EXCLUDED_TAG },
      projects: matched.map(normalize),
    };

    if (q.debug) {
      payload.debug = {
        rows_fetched_before_dedupe: pull.fetched,
        page_info: pull.pageInfo,
        raw_sample: projects[0] || null,
        raw_keys: projects[0] ? Object.keys(projects[0]).sort() : [],
      };
    }

    res.status(200).json(payload);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Unknown error talking to Zoho.' });
  }
};
