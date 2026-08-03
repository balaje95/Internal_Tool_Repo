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
