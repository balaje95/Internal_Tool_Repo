// Service worker. Three jobs:
//   1. make the toolbar icon open the side panel,
//   2. open the panel on behalf of the in-page floating button,
//   3. seed default settings.
//
// Nothing here talks to Zuper or to the dashboard — the panel and the tools do
// their own fetching from their own origins, so no API keys pass through here.

const DEFAULTS = {
  dashboardBase: 'https://internal-tool-repo.vercel.app',
  showButton: true,
  buttonSide: 'right',
  showUidBadges: true,
  uidDeepMode: true,
};

// Clicking the toolbar icon opens the side panel. Safe to call on every worker
// wake-up; it is idempotent.
function wireActionButton() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
}
wireActionButton();
chrome.runtime.onStartup.addListener(wireActionButton);

chrome.runtime.onInstalled.addListener(async () => {
  wireActionButton();
  // Only fill in keys the user has never set, so an update never resets prefs.
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (current[key] === undefined) patch[key] = DEFAULTS[key];
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

// Alt+Z from anywhere.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-panel') return;
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch (e) {
    /* no usable window */
  }
});

// ===========================================================================
// Extra hosts.
//
// The manifest can only match hosts guessed up front (*.zuper.co,
// *.zuperpro.com). A Zuper app served from anywhere else — a white-labelled or
// custom domain — would get no content scripts at all, and the symptom is total
// silence: no launcher, no badges, nothing to debug. Rather than widening the
// static match list to every site, hosts entered in options are granted
// individually and their scripts registered at runtime.
// ===========================================================================

const DYNAMIC_SCRIPT_IDS = ['dyn-launcher', 'dyn-uid-hook', 'dyn-uid-badges'];

// Accepts "example.com", "app.example.com/*", "https://app.example.com/*".
function parseHosts(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => {
      let out = h;
      if (!/^[a-z*]+:\/\//i.test(out)) out = '*://' + out;
      if (!/\/\*$/.test(out)) out = out.replace(/\/+$/, '') + '/*';
      return out;
    })
    .filter((h) => /^[a-z*]+:\/\/[^/]+\/\*$/i.test(h));
}

async function syncDynamicScripts() {
  let hosts = [];
  try {
    const s = await chrome.storage.local.get('extraHosts');
    hosts = parseHosts(s.extraHosts);
  } catch (e) { /* keep going — we still want stale registrations cleared */ }

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const mine = existing.filter((s) => DYNAMIC_SCRIPT_IDS.indexOf(s.id) >= 0);
    if (mine.length) {
      await chrome.scripting.unregisterContentScripts({ ids: mine.map((s) => s.id) });
    }
  } catch (e) {}

  if (!hosts.length) return;

  // Registering a match we hold no permission for throws and would take the
  // whole batch down with it, so filter to what was actually granted.
  const granted = [];
  for (const h of hosts) {
    const ok = await chrome.permissions.contains({ origins: [h] }).catch(() => false);
    if (ok) granted.push(h);
  }
  if (!granted.length) return;

  try {
    await chrome.scripting.registerContentScripts([
      { id: 'dyn-launcher', matches: granted, js: ['content.js'], runAt: 'document_idle' },
      { id: 'dyn-uid-hook', matches: granted, js: ['uid-hook.js'], runAt: 'document_start', world: 'MAIN' },
      { id: 'dyn-uid-badges', matches: granted, js: ['uid-badges.js'], css: ['uid-badges.css'], runAt: 'document_idle' },
    ]);
    console.info('[Zuper Tools] content scripts registered for', granted.join(', '));
  } catch (err) {
    console.warn('[Zuper Tools] could not register scripts for extra hosts:', err);
  }
}

syncDynamicScripts();
chrome.runtime.onStartup.addListener(syncDynamicScripts);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extraHosts) syncDynamicScripts();
});

// ===========================================================================
// Zuper API access for the UID badges.
//
// Fetches happen HERE, not in the content script: a content-script fetch is
// treated as coming from the page's origin and would be blocked by CORS, while
// the service worker can use the extension's host_permissions.
//
// Endpoints, uid keys and the paginated response shape are all taken from the
// Data Manager tool (tools/data-manager.html MODULES), which is the proven
// reference for this API.
// ===========================================================================

const ZUPER_DCS = [
  'us-east-1', 'us-east-1a', 'us-east-1b', 'us-east-1c',
  'us-west-1', 'us-west-1a', 'us-west-1b', 'us-west-1c', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-central-1',
  'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2',
  'ca-central-1', 'sa-east-1',
].map((r) => 'https://' + r + '.zuperpro.com');

// `fields` are the values shown in a listing row, and are what a row is matched
// on. Dotted paths are resolved.
const API_MODULES = {
  customers: {
    endpoint: 'customers',
    uid: ['customer_uid', 'uid', '_id'],
    fields: ['customer_first_name', 'customer_last_name', 'customer_email',
             'customer_phone', 'customer_company_name', 'company_name'],
  },
  jobs: {
    endpoint: 'jobs',
    uid: ['job_uid', 'uid', '_id'],
    fields: ['work_order_number', 'job_number', 'job_title', 'customer_name',
             'customer.customer_first_name', 'customer.customer_last_name'],
  },
  property: {
    endpoint: 'property',
    uid: ['property_uid', 'uid', '_id'],
    fields: ['property_name', 'property_address', 'city', 'zip_code'],
  },
  product: {
    endpoint: 'product/filter',
    method: 'POST',
    body: (page, count) => ({ page, count }),
    uid: ['product_uid', 'uid', '_id'],
    fields: ['product_name', 'product_code', 'sku', 'product_description'],
  },
  invoice: {
    endpoint: 'invoice',
    uid: ['invoice_uid', 'uid', '_id'],
    fields: ['invoice_no', 'invoice_number', 'invoice_title', 'customer_name'],
  },
  estimate: {
    endpoint: 'estimate',
    uid: ['estimate_uid', 'quote_uid', 'uid'],
    fields: ['estimate_no', 'estimate_number', 'proposal_title', 'estimate_title'],
  },
  assets: {
    endpoint: 'assets',
    uid: ['asset_uid', 'uid', '_id'],
    fields: ['asset_name', 'serial_number', 'asset_type'],
  },
  vendor: {
    endpoint: 'vendors/filter',
    method: 'POST',
    body: (page, count) => ({ page, limit: count, filter_rules: [] }),
    uid: ['vendor_uid', 'uid', '_id'],
    fields: ['vendor_name', 'vendor_display_name', 'vendor_email', 'vendor_phone',
             'company_name'],
  },
  user: {
    endpoint: 'user/all',
    uid: ['user_uid', 'uid', '_id'],
    fields: ['first_name', 'last_name', 'email', 'mobile_phone_number'],
  },
  team: {
    endpoint: 'team',
    uid: ['team_uid', 'uid', '_id'],
    fields: ['team_name', 'team_description'],
  },
  organization: {
    endpoint: 'organization',
    uid: ['organization_uid', 'uid', '_id'],
    fields: ['organization_name', 'organization_email', 'organization_phone'],
  },
  purchase_orders: {
    endpoint: 'purchase_orders',
    uid: ['purchase_order_uid', 'uid', '_id'],
    fields: ['reference_number', 'purchase_order_number', 'purchase_order_type'],
  },

  // ---------------------------------------------------------------- settings
  // The configuration modules behind Zuper's Settings section. Same source as
  // above — Data Manager's MODULES — including the endpoints that are not
  // page/count paginated (`single`) and the ones that need fixed query params.
  job_category: {
    endpoint: 'jobs/category',
    params: 'populate_statuses=true',
    single: true,
    uid: ['category_uid', 'uid', '_id'],
    fields: ['category_name'],
  },
  // Statuses are nested inside their category on the same endpoint, so the list
  // is flattened before records are compacted.
  job_status: {
    endpoint: 'jobs/category',
    params: 'populate_statuses=true',
    single: true,
    flatten: (list) => list.reduce(
      (out, cat) => out.concat(Array.isArray(cat.job_statuses) ? cat.job_statuses : []),
      []
    ),
    uid: ['status_uid', 'uid', '_id'],
    fields: ['status_name', 'status_type'],
  },
  customer_notification: {
    endpoint: 'customer_notification',
    uid: ['customer_notification_uid', 'notification_uid', 'uid', '_id'],
    fields: ['notification_name', 'notification_type'],
  },
  email_template: {
    endpoint: 'misc/email_template',
    params: 'sort=DESC&sort_by=created_at&filter.keyword=',
    uid: ['template_uid', 'uid', '_id'],
    fields: ['template_name', 'template_subject', 'template_module'],
  },
  product_category: {
    endpoint: 'products/category',
    params: 'filter.keyword=',
    single: true,
    uid: ['category_uid', 'product_category_uid', 'uid'],
    fields: ['category_name', 'category_description'],
  },
  trade_type: {
    endpoint: 'business_units',
    params: 'filter.keyword=&filter.show_all_bu=true',
    single: true,
    uid: ['bu_uid', 'business_unit_uid', 'uid'],
    fields: ['bu_name'],
  },
  service_task: {
    endpoint: 'service_tasks/master',
    uid: ['service_task_master_uid', 'service_task_uid', 'uid', '_id'],
    fields: ['service_task_title', 'task_type'],
  },
  asset_form: {
    endpoint: 'assets/inspection_form/master',
    params: 'sort=DESC&sort_by=created_at&filter.keyword=',
    uid: ['asset_form_uid', 'uid', '_id'],
    fields: ['asset_form_name', 'asset_form_description'],
  },
  formula: {
    endpoint: 'invoice_estimate/cpq/formulas',
    uid: ['formula_uid', 'uid', '_id'],
    fields: ['formula_name', 'formula_key'],
  },
  package: {
    endpoint: 'invoice_estimate/package',
    params: 'count=1000',
    single: true,
    uid: ['package_uid', 'uid', '_id'],
    fields: ['package_name', 'package_description'],
  },
  proposal_template: {
    endpoint: 'invoice_estimate/proposal_template',
    params: 'filter.keyword=',
    uid: ['proposal_template_uid', 'template_uid', 'uid', '_id'],
    fields: ['template_name', 'proposal_template_name', 'name'],
  },
  measurement_category: {
    endpoint: 'measurements/categories',
    params: 'sort=ASC&sort_by=created_at',
    single: true,
    uid: ['measurement_category_uid', 'category_uid', 'uid', '_id'],
    fields: ['measurement_category_name'],
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_LIMIT = 150;
const PAGE_BATCH = 6;
const MAX_PAGES = 60;          // 9000 records — beyond that, matching is the wrong tool
const CACHE_TTL_MS = 10 * 60 * 1000;

const dcCache = new Map();     // apiKey -> { dcUrl, accountName }
const recordCache = new Map(); // dcUrl|module -> { records, at }

function apiHeaders(apiKey, json) {
  const h = {
    'x-api-key': apiKey,
    'x-zuper-client': 'WEB_APP',
    'x-zuper-client-version': '3.0',
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function getPath(obj, path) {
  if (path.indexOf('.') < 0) return obj[path];
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// Which data centre does this key belong to? Probed in parallel; first hit wins.
async function resolveDc(apiKey) {
  const cached = dcCache.get(apiKey);
  if (cached) return cached;

  const endpoints = ['user/company', 'company', 'users/me', 'user/me'];
  const attempts = ZUPER_DCS.map(async (dc) => {
    for (const ep of endpoints) {
      const res = await fetch(dc + '/api/' + ep, { headers: apiHeaders(apiKey, false) })
        .catch(() => null);
      if (res && res.ok) {
        const data = await res.json().catch(() => ({}));
        const d = data && data.data;
        const name = (data && (data.company_name || data.name))
          || (d && (d.company_name || d.name))
          || '';
        return { dcUrl: dc, accountName: name };
      }
    }
    throw new Error('no match');
  });

  let resolved;
  try {
    resolved = await Promise.any(attempts);
  } catch (e) {
    throw new Error('API key was not recognised on any Zuper server. Check the key.');
  }
  dcCache.set(apiKey, resolved);
  return resolved;
}

// Settings endpoints are not uniform: some take page/count, some serve the whole
// list in one response (`single`), and several need fixed query params before they
// return anything at all.
function listUrl(base, cfg, endpoint, page) {
  const qs = [];
  if (!cfg.single) qs.push('page=' + page, 'count=' + PAGE_LIMIT);
  if (cfg.params) qs.push(cfg.params);
  return base + endpoint + (qs.length ? '?' + qs.join('&') : '');
}

// The paginated shape is {data:[...]}, but a few config endpoints wrap the array
// one level deeper. Nothing is guessed beyond "the first array in there".
function extractList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.data)) return data.data;
  const inner = data.data;
  if (inner && typeof inner === 'object') {
    for (const k of Object.keys(inner)) if (Array.isArray(inner[k])) return inner[k];
  }
  return [];
}

async function fetchPage(base, cfg, endpoint, apiKey, page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    if (cfg.method === 'POST') {
      const body = cfg.body ? cfg.body(page, PAGE_LIMIT) : { page, count: PAGE_LIMIT };
      res = await fetch(base + endpoint, {
        method: 'POST',
        headers: apiHeaders(apiKey, true),
        body: JSON.stringify(body),
      });
    } else {
      res = await fetch(listUrl(base, cfg, endpoint, page), {
        headers: apiHeaders(apiKey, false),
      });
    }

    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || (attempt + 1) * 2;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + ' — ' + text.slice(0, 160));
    }
    const data = await res.json();
    let list = extractList(data);
    if (cfg.flatten) {
      try { list = cfg.flatten(list) || []; } catch (e) { list = []; }
    }
    return { list, totalPages: data.total_pages || data.totalPages || null };
  }
  throw new Error('Rate limited by Zuper after 3 attempts.');
}

// Reduce a full record to just what the matcher needs, so we are not holding
// thousands of complete records in the worker.
function compact(rec, cfg) {
  let uid = null;
  for (const key of cfg.uid) {
    const v = rec[key];
    if (typeof v === 'string' && UUID_RE.test(v)) { uid = v; break; }
  }
  if (!uid) return null;

  const fields = [];
  for (const path of cfg.fields) {
    const v = getPath(rec, path);
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const s = String(v).trim();
    if (s.length < 3 || s.length > 80 || UUID_RE.test(s)) continue;
    if (fields.indexOf(s) < 0) fields.push(s);
  }
  return fields.length ? { uid, fields } : null;
}

async function fetchModuleRecords(moduleKey, apiKey) {
  const cfg = API_MODULES[moduleKey];
  if (!cfg) throw new Error('No API mapping for "' + moduleKey + '".');

  const { dcUrl, accountName } = await resolveDc(apiKey);
  const cacheKey = dcUrl + '|' + moduleKey;
  const hit = recordCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return {
      records: hit.records, accountName, dcUrl,
      cached: true, fetchedAt: hit.at, truncated: !!hit.truncated,
    };
  }

  const base = dcUrl + '/api/';
  const endpoint = cfg.endpoint || moduleKey;
  const records = [];
  let page = 1;
  let stop = false;

  // A `single` endpoint ignores page/count, so the batched loop below would fetch
  // the identical URL six times and index every record six times over.
  if (cfg.single) {
    const { list } = await fetchPage(base, cfg, endpoint, apiKey, 1);
    for (const rec of list) {
      const c = compact(rec, cfg);
      if (c) records.push(c);
    }
    recordCache.set(cacheKey, { records, at: Date.now(), truncated: false });
    return { records, accountName, dcUrl, cached: false, truncated: false, fetchedAt: Date.now() };
  }

  // Whether we ran out of pages naturally or hit the cap. A capped fetch leaves
  // later rows unmatched, and a bare row with no explanation reads as "this record
  // has no UID" rather than "we never looked it up".
  while (!stop && page <= MAX_PAGES) {
    const pages = [];
    for (let i = 0; i < PAGE_BATCH && page <= MAX_PAGES; i++) pages.push(page++);
    const results = await Promise.all(pages.map((p) => fetchPage(base, cfg, endpoint, apiKey, p)));
    for (let i = 0; i < results.length; i++) {
      const { list, totalPages } = results[i];
      if (!list.length) { stop = true; continue; }
      for (const rec of list) {
        const c = compact(rec, cfg);
        if (c) records.push(c);
      }
      if (list.length < PAGE_LIMIT || (totalPages && pages[i] >= totalPages)) stop = true;
    }
  }

  const truncated = !stop && page > MAX_PAGES;
  recordCache.set(cacheKey, { records, at: Date.now(), truncated });
  return { records, accountName, dcUrl, cached: false, truncated, fetchedAt: Date.now() };
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg) return false;

  // Records for the UID badges.
  if (msg.type === 'uid-fetch') {
    (async () => {
      const { apiKey } = await chrome.storage.local.get('apiKey');
      if (!apiKey) {
        respond({ ok: false, error: 'No Zuper API key saved. Add one in the extension options.' });
        return;
      }
      try {
        const out = await fetchModuleRecords(msg.module, apiKey);
        respond({
          ok: true,
          records: out.records,
          account: out.accountName,
          region: (out.dcUrl.match(/\/\/([^.]+)\./) || [])[1] || '',
          cached: out.cached,
          fetchedAt: out.fetchedAt || Date.now(),
          truncated: !!out.truncated,
          maxRecords: MAX_PAGES * PAGE_LIMIT,
        });
      } catch (err) {
        respond({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }

  // Options page "Test connection".
  if (msg.type === 'uid-test-key') {
    (async () => {
      try {
        const out = await resolveDc(msg.apiKey);
        respond({
          ok: true,
          account: out.accountName,
          region: (out.dcUrl.match(/\/\/([^.]+)\./) || [])[1] || '',
        });
      } catch (err) {
        respond({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;
  }

  if (msg.type === 'uid-clear-cache') {
    recordCache.clear();
    dcCache.clear();
    respond({ ok: true });
    return false;
  }

  return false;
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== 'open-panel') return false;

  // sidePanel.open() requires a user gesture. The gesture from the content
  // script's click carries through this message, but if Chrome declines it we
  // tell the button so it can fall back to a "use the toolbar icon" hint
  // rather than silently doing nothing.
  const windowId = sender.tab && sender.tab.windowId;
  const target = windowId != null ? { windowId } : null;
  if (!target) {
    respond({ ok: false, error: 'no window' });
    return false;
  }
  chrome.sidePanel
    .open(target)
    .then(() => respond({ ok: true }))
    .catch((err) => respond({ ok: false, error: String(err && err.message || err) }));
  return true; // keep the message channel open for the async respond
});
