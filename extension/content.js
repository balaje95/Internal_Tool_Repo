// Injects the floating "Zuper Tools" launcher into the Zuper web app.
//
// Everything lives inside a shadow root and its styles are applied with a
// constructable stylesheet. That matters for two reasons: Zuper's own CSS can
// never leak in and restyle the button, and a constructed CSSStyleSheet is not
// an inline <style>, so a strict style-src CSP on the Zuper page cannot block it.

(function () {
  const HOST_ID = 'zuper-tools-launcher-host';
  if (window.__zuperToolsLauncherInjected) return;
  window.__zuperToolsLauncherInjected = true;

  const CSS = `
    :host { all: initial; }

    /* The host is pointer-events:none so it can never be a click trap; the two
       things the user actually interacts with opt back in. */
    .launcher, .hint { pointer-events: auto; }

    .launcher {
      position: fixed;
      bottom: 22px;
      z-index: 2147483000;
      display: flex;
      align-items: center;
      gap: 0;
      height: 44px;
      padding: 0;
      font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      background: #FD5000;
      color: #FFFFFF;
      border: 0;
      border-radius: 999px;
      box-shadow: 0 8px 24px rgba(253, 80, 0, 0.34), 0 1px 3px rgba(25, 25, 25, 0.18);
      cursor: pointer;
      overflow: hidden;
      transition: box-shadow 200ms cubic-bezier(0.16, 1, 0.3, 1),
                  transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .launcher.side-right { right: 22px; }
    .launcher.side-left  { left: 22px; }

    .launcher:hover {
      transform: translateY(-1px);
      box-shadow: 0 12px 32px rgba(253, 80, 0, 0.42), 0 1px 3px rgba(25, 25, 25, 0.2);
    }
    .launcher:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px rgba(253, 80, 0, 0.32), 0 8px 24px rgba(253, 80, 0, 0.34);
    }

    .chip {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 100%;
      padding: 0 6px 0 6px;
      background: transparent;
      border: 0;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    .mark {
      width: 32px;
      height: 32px;
      flex: none;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.16);
      padding: 4px;
      box-sizing: border-box;
      display: block;
    }

    .label {
      max-width: 0;
      opacity: 0;
      overflow: hidden;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: -0.01em;
      transition: max-width 260ms cubic-bezier(0.16, 1, 0.3, 1),
                  opacity 180ms cubic-bezier(0.16, 1, 0.3, 1),
                  padding-right 260ms cubic-bezier(0.16, 1, 0.3, 1);
      padding-right: 0;
    }
    .launcher:hover .label,
    .launcher:focus-within .label,
    .launcher.show-label .label {
      max-width: 130px;
      opacity: 1;
      padding-right: 6px;
    }

    .dismiss {
      width: 0;
      opacity: 0;
      overflow: hidden;
      flex: none;
      height: 100%;
      background: rgba(0, 0, 0, 0.14);
      border: 0;
      color: inherit;
      font: inherit;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      transition: width 200ms cubic-bezier(0.16, 1, 0.3, 1),
                  opacity 160ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .launcher:hover .dismiss,
    .launcher:focus-within .dismiss {
      width: 26px;
      opacity: 1;
    }
    .dismiss:hover { background: rgba(0, 0, 0, 0.26); }

    .hint {
      position: fixed;
      bottom: 76px;
      z-index: 2147483000;
      max-width: 240px;
      padding: 10px 12px;
      font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      line-height: 1.45;
      color: #FFFFFF;
      background: #191919;
      border-radius: 12px;
      box-shadow: 0 12px 40px rgba(25, 25, 25, 0.28);
    }
    .hint.side-right { right: 22px; }
    .hint.side-left  { left: 22px; }
    .hint[hidden] { display: none; }

    @media (prefers-reduced-motion: reduce) {
      .launcher, .label, .dismiss { transition-duration: 1ms; }
      .launcher:hover { transform: none; }
    }
  `;

  let hostEl = null;
  let launcherEl = null;
  let hintEl = null;
  let hintTimer = 0;
  let dismissedForSession = false;

  function build(side) {
    const host = document.createElement('div');
    host.id = HOST_ID;
    // The host must not affect layout or intercept clicks. Every declaration is
    // !important because a page rule like `div { border: 5px !important }` would
    // otherwise beat a plain inline style and inflate the host into a click trap
    // in the top-left corner. Inline !important outranks author !important.
    host.style.cssText = [
      'all: initial !important',
      'position: fixed !important',
      'top: 0 !important',
      'left: 0 !important',
      'width: 0 !important',
      'height: 0 !important',
      'margin: 0 !important',
      'padding: 0 !important',
      'border: 0 !important',
      'outline: 0 !important',
      'overflow: visible !important',
      'pointer-events: none !important',
      'z-index: 2147483000 !important',
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];

    const launcher = document.createElement('div');
    launcher.className = 'launcher side-' + side;

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.setAttribute('aria-label', 'Open Zuper internal tools (Alt+Z)');
    chip.title = 'Zuper internal tools — Alt+Z';

    const mark = document.createElement('img');
    mark.className = 'mark';
    mark.src = chrome.runtime.getURL('icons/icon48.png');
    mark.alt = '';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Zuper Tools';

    chip.append(mark, label);

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'dismiss';
    dismiss.textContent = '×';
    dismiss.title = 'Hide until this page reloads';
    dismiss.setAttribute('aria-label', 'Hide the Zuper Tools button until this page reloads');

    const hint = document.createElement('div');
    hint.className = 'hint side-' + side;
    hint.hidden = true;

    launcher.append(chip, dismiss);
    shadow.append(launcher, hint);

    chip.addEventListener('click', onLaunch);
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissedForSession = true;
      teardown();
    });

    hostEl = host;
    launcherEl = launcher;
    hintEl = hint;
    (document.body || document.documentElement).appendChild(host);
  }

  function showHint(text) {
    if (!hintEl) return;
    hintEl.textContent = text;
    hintEl.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { if (hintEl) hintEl.hidden = true; }, 6000);
  }

  function onLaunch() {
    // The side panel can only be opened from the extension side, and only in
    // response to a real user gesture — hence the round trip.
    chrome.runtime.sendMessage({ type: 'open-panel' }, (res) => {
      if (chrome.runtime.lastError) {
        showHint('Could not reach the extension. Try reloading this page.');
        return;
      }
      if (res && res.ok) {
        if (hintEl) hintEl.hidden = true;
        return;
      }
      showHint('Chrome blocked opening the panel from the page. Click the Zuper Tools icon in the toolbar, or press Alt+Z.');
    });
  }

  function teardown() {
    if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
    hostEl = null;
    launcherEl = null;
    hintEl = null;
  }

  // Zuper is a single-page app; if a route change wipes our node we put it back.
  function watch() {
    const observer = new MutationObserver(() => {
      if (dismissedForSession || !hostEl) return;
      if (!document.getElementById(HOST_ID) && document.body) {
        document.body.appendChild(hostEl);
      }
    });
    if (document.body) observer.observe(document.body, { childList: true });
  }

  async function start() {
    let settings;
    try {
      settings = await chrome.storage.local.get(['showButton', 'buttonSide']);
    } catch (e) {
      settings = {};
    }
    if (settings.showButton === false) return;
    build(settings.buttonSide === 'left' ? 'left' : 'right');
    watch();
  }

  // React to the options page without needing a reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.showButton) {
      if (changes.showButton.newValue === false) {
        teardown();
      } else if (!hostEl && !dismissedForSession) {
        start();
      }
    }
    if (changes.buttonSide && launcherEl) {
      const side = changes.buttonSide.newValue === 'left' ? 'left' : 'right';
      launcherEl.className = 'launcher side-' + side;
      if (hintEl) hintEl.className = 'hint side-' + side;
    }
  });

  start();
})();
