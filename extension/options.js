const DEFAULTS = {
  dashboardBase: 'https://internal-tool-repo.vercel.app',
  showButton: true,
  buttonSide: 'right',
  showUidBadges: true,
  uidDeepMode: true,
  uidApiMode: true,
  apiKey: '',
  autofillKey: true,
  extraHosts: '',
};

// Mirrors parseHosts() in background.js.
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

const f = {
  base: document.getElementById('dashboardBase'),
  show: document.getElementById('showButton'),
  side: document.getElementById('buttonSide'),
  badges: document.getElementById('showUidBadges'),
  deep: document.getElementById('uidDeepMode'),
  api: document.getElementById('uidApiMode'),
  apiKey: document.getElementById('apiKey'),
  autofillKey: document.getElementById('autofillKey'),
  testKey: document.getElementById('test-key'),
  clearRecords: document.getElementById('clear-records'),
  keyStatus: document.getElementById('key-status'),
  extraHosts: document.getElementById('extraHosts'),
  hostsStatus: document.getElementById('hosts-status'),
  save: document.getElementById('save'),
  saveStatus: document.getElementById('save-status'),
  clear: document.getElementById('clear-cache'),
  cacheStatus: document.getElementById('cache-status'),
  shortcuts: document.getElementById('open-shortcuts'),
  diag: document.getElementById('diag'),
  copyDiag: document.getElementById('copy-diag'),
  diagStatus: document.getElementById('diag-status'),
};

function flash(node, text, isError) {
  node.textContent = text;
  node.className = 'inline-status' + (isError ? ' error' : '');
  setTimeout(() => { node.textContent = ''; }, 2600);
}

function renderDiag(r) {
  if (!r || !r.url) return;
  const added = (r.exact || 0) + (r.matched || 0);
  const total = typeof r.total === 'number' ? r.total : added;
  f.diag.textContent = [
    'page            ' + r.url,
    'scanned at      ' + (r.at || '?'),
    'list type       ' + (r.kind || '?'),
    'rows found      ' + (r.rows || 0),
    'module detected ' + (r.module || '?'),
    'api fetch       ' + (r.apiState || '?') + (r.apiCount ? ' — ' + r.apiCount + ' records' : ''),
    'api detail      ' + (r.apiMessage || '—'),
    'badged on page  ' + total,
    'added last pass ' + added + '  (' + (r.exact || 0) + ' read from the page, ' +
      (r.matched || 0) + ' matched)',
    'records indexed ' + (r.records || 0),
  ].join('\n');
}

async function load() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS).concat(['uidReport']));
  f.base.value = s.dashboardBase || DEFAULTS.dashboardBase;
  f.show.checked = s.showButton !== false;
  f.side.value = s.buttonSide === 'left' ? 'left' : 'right';
  f.badges.checked = s.showUidBadges !== false;
  f.deep.checked = s.uidDeepMode !== false;
  f.api.checked = s.uidApiMode !== false;
  f.apiKey.value = s.apiKey || '';
  f.autofillKey.checked = s.autofillKey !== false;
  f.extraHosts.value = s.extraHosts || '';
  renderDiag(s.uidReport);
}

function showHostsStatus(text, isError) {
  f.hostsStatus.textContent = text;
  f.hostsStatus.style.color = isError ? 'var(--zb-error)' : 'var(--zb-success)';
  f.hostsStatus.hidden = !text;
}

f.testKey.addEventListener('click', async () => {
  const key = f.apiKey.value.trim();
  if (!key) { flash(f.keyStatus, 'Enter an API key first.', true); return; }
  f.keyStatus.className = 'inline-status';
  f.keyStatus.textContent = 'Checking every Zuper region…';
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'uid-test-key', apiKey: key });
  } catch (e) {
    flash(f.keyStatus, 'Could not reach the extension worker.', true);
    return;
  }
  if (res && res.ok) {
    flash(f.keyStatus, '✓ ' + (res.account || 'Connected') +
      (res.region ? ' — ' + res.region : '') + '. Remember to Save.');
  } else {
    flash(f.keyStatus, (res && res.error) || 'Connection failed.', true);
  }
});

f.clearRecords.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'uid-clear-cache' });
    flash(f.keyStatus, 'Cached records cleared — the next page will refetch.');
  } catch (e) {
    flash(f.keyStatus, 'Could not reach the extension worker.', true);
  }
});

// The report is written by the content script on another tab, so reflect updates
// live rather than making the user reopen this page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.uidReport) renderDiag(changes.uidReport.newValue);
});

f.copyDiag.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(f.diag.textContent);
    flash(f.diagStatus, 'Copied.');
  } catch (e) {
    flash(f.diagStatus, 'Copy failed — select the text manually.', true);
  }
});

f.save.addEventListener('click', async () => {
  const raw = f.base.value.trim() || DEFAULTS.dashboardBase;
  const base = raw.replace(/\/+$/, '');

  // A bad base URL silently breaks the whole panel, so validate before storing.
  let parsed;
  try {
    parsed = new URL(base);
  } catch (e) {
    flash(f.saveStatus, 'That is not a valid URL.', true);
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    flash(f.saveStatus, 'Use an http:// or https:// URL.', true);
    return;
  }

  // Host permissions must be requested from a user gesture, so it happens here
  // on the Save click rather than in the worker.
  const hosts = parseHosts(f.extraHosts.value);
  const hostsRaw = f.extraHosts.value.trim();
  if (hostsRaw && !hosts.length) {
    showHostsStatus('Could not read a hostname from that. Try "app.mycompany.com".', true);
    return;
  }
  if (hosts.length) {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: hosts });
    } catch (err) {
      showHostsStatus('Chrome refused the permission request: ' + err.message, true);
      return;
    }
    if (!granted) {
      showHostsStatus('Permission was declined, so the extension still cannot run on ' +
        hosts.join(', ') + '.', true);
      return;
    }
    showHostsStatus('✓ Allowed on ' + hosts.join(', ') + '. Reload the Zuper tab.', false);
  } else {
    showHostsStatus('', false);
  }

  await chrome.storage.local.set({
    dashboardBase: base,
    extraHosts: hostsRaw,
    showButton: f.show.checked,
    buttonSide: f.side.value === 'left' ? 'left' : 'right',
    showUidBadges: f.badges.checked,
    uidDeepMode: f.deep.checked,
    uidApiMode: f.api.checked,
    apiKey: f.apiKey.value.trim(),
    autofillKey: f.autofillKey.checked,
  });
  f.base.value = base;
  flash(f.saveStatus, 'Saved.');
});

f.clear.addEventListener('click', async () => {
  await chrome.storage.local.remove('toolsCache');
  flash(f.cacheStatus, 'Cleared — the panel will refetch on next open.');
});

// chrome://extensions/shortcuts cannot be opened with tabs.create from an
// extension page, so hand it to the user as selectable text instead.
f.shortcuts.addEventListener('click', async () => {
  const url = 'chrome://extensions/shortcuts';
  try {
    await navigator.clipboard.writeText(url);
    flash(f.saveStatus, 'Copied ' + url + ' — paste it in the address bar.');
  } catch (e) {
    flash(f.saveStatus, 'Open ' + url + ' in the address bar.', true);
  }
});

load();
