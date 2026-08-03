const DEFAULTS = {
  dashboardBase: 'https://internal-tool-repo.vercel.app',
  showButton: true,
  buttonSide: 'right',
};

const f = {
  base: document.getElementById('dashboardBase'),
  show: document.getElementById('showButton'),
  side: document.getElementById('buttonSide'),
  save: document.getElementById('save'),
  saveStatus: document.getElementById('save-status'),
  clear: document.getElementById('clear-cache'),
  cacheStatus: document.getElementById('cache-status'),
  shortcuts: document.getElementById('open-shortcuts'),
};

function flash(node, text, isError) {
  node.textContent = text;
  node.className = 'inline-status' + (isError ? ' error' : '');
  setTimeout(() => { node.textContent = ''; }, 2600);
}

async function load() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  f.base.value = s.dashboardBase || DEFAULTS.dashboardBase;
  f.show.checked = s.showButton !== false;
  f.side.value = s.buttonSide === 'left' ? 'left' : 'right';
}

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

  await chrome.storage.local.set({
    dashboardBase: base,
    showButton: f.show.checked,
    buttonSide: f.side.value === 'left' ? 'left' : 'right',
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
