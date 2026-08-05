// Side-panel launcher.
//
// The tool list is read from the live dashboard's assets/tools.config.js so
// adding a tool to the dashboard makes it appear here with no extension update.
// That file is documented as strict-JSON-inside-a-const (the Add/Delete/Reorder
// serverless endpoints JSON.parse it too), so we slice the array out and parse
// it rather than eval'ing — MV3's script-src 'self' forbids eval anyway.
//
// Order of play on open: render the cached list immediately (instant panel),
// then refetch in the background and re-render only if it actually changed.

const FALLBACK_URL = 'tools.fallback.json';
const CACHE_KEY = 'toolsCache';
// Kept deliberately short. The dashboard ships changes in bursts, so a wider
// window badges most of the list at once and the badge stops carrying signal.
const NEW_BADGE_DAYS = 10;

const el = {
  viewList: document.getElementById('view-list'),
  viewTool: document.getElementById('view-tool'),
  list: document.getElementById('tool-list'),
  search: document.getElementById('search'),
  status: document.getElementById('list-status'),
  empty: document.getElementById('list-empty'),
  refresh: document.getElementById('btn-refresh'),
  options: document.getElementById('btn-options'),
  back: document.getElementById('btn-back'),
  reload: document.getElementById('btn-reload'),
  newtab: document.getElementById('btn-newtab'),
  frame: document.getElementById('tool-frame'),
  frameLoading: document.getElementById('frame-loading'),
  toolTitle: document.getElementById('tool-title'),
  ctxFoot: document.getElementById('context-foot'),
  ctxLabel: document.getElementById('ctx-label'),
  ctxCopy: document.getElementById('ctx-copy'),
  diag: document.getElementById('badge-diag'),
  diagText: document.getElementById('badge-diag-text'),
  recheck: document.getElementById('badge-recheck'),
};

let tools = [];
let dashboardBase = 'https://internal-tool-repo.vercel.app';
let currentTool = null;
let contextUid = '';

// ---------------------------------------------------------------- utilities

function trimBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function toolUrl(tool) {
  return dashboardBase + '/' + String(tool.file || '').replace(/^\/+/, '');
}

function setStatus(text, kind) {
  if (!text) {
    el.status.hidden = true;
    return;
  }
  el.status.textContent = text;
  el.status.className = 'list-status' + (kind ? ' ' + kind : '');
  el.status.hidden = false;
}

function isRecent(isoDate) {
  if (!isoDate) return false;
  const then = Date.parse(isoDate);
  if (Number.isNaN(then)) return false;
  return (Date.now() - then) / 86400000 <= NEW_BADGE_DAYS;
}

// Pull the TOOLS array out of assets/tools.config.js.
function parseToolsConfig(text) {
  const marker = text.indexOf('const TOOLS');
  const start = text.indexOf('[', marker < 0 ? 0 : marker);
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('Could not find the TOOLS array.');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('TOOLS array was empty.');
  return parsed;
}

// ---------------------------------------------------------------- rendering

function render() {
  const query = el.search.value.trim().toLowerCase();
  const matches = !query
    ? tools
    : tools.filter((t) =>
        (t.name + ' ' + (t.description || '') + ' ' + (t.help || ''))
          .toLowerCase()
          .includes(query)
      );

  el.list.textContent = '';

  for (const tool of matches) {
    const li = document.createElement('li');

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tool-row';
    row.title = tool.help || tool.description || tool.name;

    const icon = document.createElement('span');
    icon.className = 'tool-icon';
    icon.textContent = tool.icon || '\u{1F527}';

    const body = document.createElement('div');
    body.className = 'tool-body';

    const name = document.createElement('div');
    name.className = 'tool-name';
    const nameText = document.createElement('span');
    nameText.textContent = tool.name;
    name.appendChild(nameText);
    if (isRecent(tool.updated)) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'New';
      name.appendChild(badge);
    }

    const desc = document.createElement('div');
    desc.className = 'tool-desc';
    desc.textContent = tool.description || '';

    body.append(name, desc);
    row.append(icon, body);
    row.addEventListener('click', () => openTool(tool));

    li.appendChild(row);
    el.list.appendChild(li);
  }

  el.empty.hidden = matches.length > 0 || !tools.length;
}

// ---------------------------------------------------------------- tool view

function openTool(tool) {
  currentTool = tool;
  el.toolTitle.textContent = tool.name;
  el.frameLoading.hidden = false;
  el.frame.src = toolUrl(tool);
  el.viewList.hidden = true;
  el.viewTool.hidden = false;
}

function closeTool() {
  el.viewTool.hidden = true;
  el.viewList.hidden = false;
  // Drop the iframe so a heavy tool (the training deck is ~7MB) is not left
  // parked in memory, and so reopening it starts clean.
  el.frame.src = 'about:blank';
  currentTool = null;
  el.search.focus();
}

el.frame.addEventListener('load', () => {
  el.frameLoading.hidden = true;
});

el.back.addEventListener('click', closeTool);

el.reload.addEventListener('click', () => {
  if (!currentTool) return;
  el.frameLoading.hidden = false;
  el.frame.src = toolUrl(currentTool);
});

el.newtab.addEventListener('click', () => {
  if (currentTool) window.open(toolUrl(currentTool), '_blank');
});

el.options.addEventListener('click', () => chrome.runtime.openOptionsPage());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.viewTool.hidden) closeTool();
});

// ---------------------------------------------------------------- data load

async function loadFallback() {
  const res = await fetch(FALLBACK_URL);
  return res.json();
}

async function fetchLive() {
  const res = await fetch(dashboardBase + '/assets/tools.config.js', { cache: 'no-store' });
  if (!res.ok) throw new Error('Dashboard returned HTTP ' + res.status);
  return parseToolsConfig(await res.text());
}

async function refresh(userInitiated) {
  if (userInitiated) el.refresh.classList.add('spinning');
  try {
    const live = await fetchLive();
    const changed = JSON.stringify(live) !== JSON.stringify(tools);
    if (changed) {
      tools = live;
      render();
    }
    await chrome.storage.local.set({ [CACHE_KEY]: { tools: live, at: Date.now() } });
    if (userInitiated) {
      setStatus(changed ? 'Tool list updated.' : 'Already up to date.', 'ok');
      setTimeout(() => setStatus(''), 2500);
    } else {
      setStatus('');
    }
  } catch (err) {
    // A stale cached list is far more useful than an error wall, so we keep
    // whatever is on screen and just say the refresh failed.
    const detail = String((err && err.message) || err);
    setStatus(
      tools.length
        ? 'Showing the cached list — could not reach the dashboard (' + detail + ').'
        : 'Could not load the tool list: ' + detail,
      'error'
    );
  } finally {
    el.refresh.classList.remove('spinning');
  }
}

el.refresh.addEventListener('click', () => refresh(true));
el.search.addEventListener('input', render);

// ---------------------------------------------------------------- page context

// Read what we can from the active Zuper tab's URL. Deliberately URL-only: it
// needs no assumptions about Zuper's DOM, so a Zuper UI change can't break it.
// The common win is lifting a record UID out of the address bar to paste into a
// tool.
async function readContext() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch (e) {
    return;
  }
  if (!tab || !tab.url) return;

  let url;
  try {
    url = new URL(tab.url);
  } catch (e) {
    return;
  }
  if (!/(^|\.)zuper\.co$|(^|\.)zuperpro\.com$/.test(url.hostname)) return;

  const haystack = url.pathname + url.search + url.hash;
  const UID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const uidMatch = haystack.match(UID_RE);

  // Take the deepest word-ish path segment rather than the first: on
  // /app/jobs/<uid> the useful label is "jobs", not the "app" mount point.
  const segments = haystack
    .split(/[/?#&=]+/)
    .filter((s) => /^[a-z][a-z_-]{2,}$/i.test(s) && !UID_RE.test(s));
  const section = segments.length ? segments[segments.length - 1] : '';

  const bits = [url.hostname];
  if (section) bits.push(section.toLowerCase());
  if (uidMatch) bits.push(uidMatch[0].slice(0, 8) + '…');

  contextUid = uidMatch ? uidMatch[0] : '';
  el.ctxLabel.textContent = bits.join(' · ');
  el.ctxCopy.hidden = !contextUid;
  el.ctxFoot.hidden = false;
}

// ------------------------------------------------- UID badge status readout
//
// Reports whether the badge script is alive on the active tab. This lives in the
// panel because it is the only surface that can tell the difference between
// "injected but found nothing" and "never injected here at all" — an in-page
// message cannot report that it was never inserted.
function setDiag(text, kind) {
  el.diagText.textContent = text;
  el.diag.className = 'badge-diag' + (kind ? ' ' + kind : '');
  el.diag.hidden = false;
}

async function readBadgeStatus() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch (e) {
    return;
  }
  if (!tab) return;

  // A hidden URL means the extension holds no permission for this tab's host,
  // which is exactly why nothing would be injected there.
  if (!tab.url) {
    setDiag('UID badges: this extension has no access to the current tab, so nothing can run on it. If this is your Zuper app, its host is not in the extension\'s match list — send me the URL.', 'warn');
    return;
  }

  let host = '';
  try { host = new URL(tab.url).hostname; } catch (e) { return; }

  if (/^chrome:|^edge:|^about:/.test(tab.url)) {
    el.diag.hidden = true;
    return;
  }

  let res = null;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'uid-ping' });
  } catch (e) {
    res = null;
  }

  if (!res || !res.ok) {
    setDiag('UID badges are NOT running on ' + host + '. Either that host is not in the ' +
            'extension\'s match list (currently *.zuper.co and *.zuperpro.com), or this tab ' +
            'was open before the extension was reloaded — try Ctrl+Shift+R first.', 'warn');
    return;
  }

  if (!res.enabled) {
    setDiag('UID badges are switched off on ' + host + '. Use the Show UID button on the page, or the checkbox in options.', '');
    return;
  }
  if (res.chips > 0) {
    setDiag('UID badges: ' + res.chips + ' shown on ' + host +
            (res.module ? ' · ' + res.module : '') + '.', 'ok');
    return;
  }

  // Injected and on, but nothing badged — name the reason.
  let why;
  if (res.apiState === 'no-key') {
    why = 'no API key saved yet — add one in the extension options.';
  } else if (res.apiState === 'no-module') {
    why = 'the module could not be read from this URL, so there is nothing to look up.';
  } else if (res.apiState === 'loading') {
    why = 'still fetching records…';
  } else if (res.apiState === 'error') {
    why = 'the record fetch failed: ' + (res.apiMessage || 'unknown error');
  } else if (!res.rows) {
    why = 'no listing rows were detected on the page (' + (res.kind || 'no list found') + ').';
  } else {
    why = res.rows + ' rows found and ' + res.indexed +
          ' records indexed, but none matched confidently.';
  }
  setDiag('UID badges are running on ' + host + ' but nothing is badged: ' + why, 'warn');
}

if (el.recheck) el.recheck.addEventListener('click', readBadgeStatus);

el.ctxCopy.addEventListener('click', async () => {
  if (!contextUid) return;
  try {
    await navigator.clipboard.writeText(contextUid);
    el.ctxCopy.textContent = 'Copied';
  } catch (e) {
    el.ctxCopy.textContent = 'Copy failed';
  }
  setTimeout(() => { el.ctxCopy.textContent = 'Copy UID'; }, 1600);
});

// ---------------------------------------------------------------- boot

(async function init() {
  const stored = await chrome.storage.local.get(['dashboardBase', CACHE_KEY]);
  if (stored.dashboardBase) dashboardBase = trimBase(stored.dashboardBase);

  const cached = stored[CACHE_KEY];
  if (cached && Array.isArray(cached.tools) && cached.tools.length) {
    tools = cached.tools;
  } else {
    try {
      tools = await loadFallback();
    } catch (e) {
      tools = [];
    }
  }
  render();
  readContext();
  readBadgeStatus();
  refresh(false);
  el.search.focus();
})();
