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

    /* The host is pointer-events:none so it can never be a click trap; the
       things the user actually interacts with opt back in. */
    .launcher, .hint, .uid-toggle { pointer-events: auto; }

    /* Show/Hide UID control, parked directly above the launcher. Deliberately a
       neutral pill rather than a second orange one — it is a state toggle, not a
       primary action, and should not compete with the launcher. */
    /* Solid charcoal, not white. A white pill with a #E6E6E6 border sitting on
       Zuper's white page was effectively invisible. */
    .uid-toggle {
      position: fixed;
      bottom: 76px;
      z-index: 2147483000;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 32px;
      padding: 0 13px;
      font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: #FFFFFF;
      background: #191919;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      box-shadow: 0 6px 18px rgba(25, 25, 25, 0.28);
      cursor: pointer;
      white-space: nowrap;
      transition: box-shadow 200ms cubic-bezier(0.16, 1, 0.3, 1),
                  transform 200ms cubic-bezier(0.16, 1, 0.3, 1),
                  background-color 160ms linear;
    }
    .uid-toggle.side-right { right: 22px; }
    .uid-toggle.side-left  { left: 22px; }
    .uid-toggle:hover {
      transform: translateY(-1px);
      background: #2A2A2A;
      box-shadow: 0 10px 26px rgba(25, 25, 25, 0.34);
    }
    .uid-toggle:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px rgba(253, 80, 0, 0.45), 0 6px 18px rgba(25, 25, 25, 0.28);
    }
    .uid-toggle.off { color: #C9C9CC; }
    .uid-toggle.loading { color: #FFFFFF; }
    .uid-toggle.error { border-color: rgba(255, 122, 61, 0.65); }

    /* A light border keeps the charcoal pill defined on a dark page too. */
    .uid-toggle.on-dark { border-color: rgba(255, 255, 255, 0.28); }

    .uid-dot {
      width: 7px;
      height: 7px;
      flex: none;
      border-radius: 50%;
      background: #FD5000;
      box-sizing: border-box;
    }
    .uid-toggle.off .uid-dot {
      background: transparent;
      border: 1.5px solid #8A8A8E;
    }
    .uid-toggle.error .uid-dot { background: #FF7A3D; }
    .uid-toggle.loading .uid-dot { animation: uid-pulse 900ms ease-in-out infinite; }

    @keyframes uid-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.35; transform: scale(0.7); }
    }

    .uid-count {
      font-family: ui-monospace, 'Cascadia Mono', 'Segoe UI Mono', Menlo, monospace;
      font-size: 10.5px;
      font-weight: 500;
      color: rgba(255, 255, 255, 0.62);
    }
    .uid-count[hidden] { display: none; }

    @media (prefers-reduced-motion: reduce) {
      .uid-toggle.loading .uid-dot { animation: none; opacity: 0.6; }
    }

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
      /* Clears both the launcher (bottom 22, 44 tall) and the UID toggle above it. */
      bottom: 118px;
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

  // The logomark is drawn inline rather than loaded from icons/icon48.png. An
  // <img> in the page's DOM pointing at a chrome-extension:// URL needs the file
  // listed in web_accessible_resources, and is still blocked by a strict img-src
  // CSP on the host page. Inline SVG is markup, not a subresource fetch, so
  // neither applies. Points come from assets/logos/zuper-logomark.svg.
  const LOGOMARK = [
    { points: '316.8,180.5 433.5,181.1 371.1,277.2 254,277.2', opacity: 1 },
    { points: '229.9,71 387.5,71.2 317.5,180.5 157.6,181.1', opacity: 1 },
    { points: '130.3,222.2 247,222.8 184.6,318.9 67.5,318.9', opacity: 0.72 },
    { points: '184.7,318.9 342.3,319.1 270.3,428.4 112.4,429', opacity: 0.72 },
  ];

  function buildLogomark() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '58 62 386 376');
    svg.setAttribute('class', 'mark');
    svg.setAttribute('aria-hidden', 'true');
    for (const part of LOGOMARK) {
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', part.points);
      poly.setAttribute('fill', '#FFFFFF');
      if (part.opacity !== 1) poly.setAttribute('opacity', String(part.opacity));
      svg.appendChild(poly);
    }
    return svg;
  }

  // An unpacked extension that gets reloaded orphans the content scripts already
  // running in open tabs: chrome.storage calls throw and its onChanged listeners
  // are dead. Detecting that lets us say "reload the page" instead of appearing
  // to do nothing.
  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  let hostEl = null;
  let launcherEl = null;
  let hintEl = null;
  let hintTimer = 0;
  let dismissedForSession = false;
  // Every mounted Show/Hide UID control. There is always the floating pill, and
  // when an anchor can be found in the page's own toolbar, one inline beside it.
  const toggles = [];
  let floatingToggleEl = null;
  let inlineHost = null;
  let inlineTimer = 0;
  let copyBtnEl = null;
  let uidSelection = { count: 0, selected: false };
  let uidOn = true;
  let uidBadged = 0;
  let currentSide = 'right';
  let pageIsDark = false;
  let uidFeedbackTimer = 0;
  let uidStatus = { state: 'idle', message: '', module: null, apiCount: 0 };
  let uidStatusHintTimer = 0;

  // Is the page behind the pill dark? Walks up for an opaque background, since
  // app containers are often transparent. Duplicated in uid-badges.js on purpose
  // — the chips must keep working when this launcher is switched off.
  function isDarkBackdrop(el) {
    let node = el;
    for (let i = 0; i < 12 && node && node.nodeType === 1; i++) {
      let bg = '';
      try { bg = getComputedStyle(node).backgroundColor || ''; } catch (e) {}
      const m = bg.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const parts = m[1].split(',').map((n) => parseFloat(n));
        const alpha = parts.length > 3 ? parts[3] : 1;
        if (alpha > 0.5) {
          const lum = (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
          return lum < 0.5;
        }
      }
      node = node.parentElement;
    }
    return false;
  }

  function renderUidToggle() {
    if (!toggles.length) return;
    const loading = uidOn && uidStatus.state === 'loading';
    // A failed lookup only counts as a failure if it left the page with nothing.
    // Rows can be badged straight from the markup without the API, and flagging an
    // error over working badges is just crying wolf.
    const failed = uidOn && uidBadged === 0 &&
      (uidStatus.state === 'error' || uidStatus.state === 'no-key' ||
       uidStatus.state === 'no-module');

    const title = !uidOn
      ? 'Show a copyable record UID on each listing row'
      : loading
        ? 'Fetching ' + (uidStatus.module || 'record') + ' records from Zuper…'
        : failed
          ? uidStatus.message + '\n\nClick to hide.'
          : 'Record UID chips are on' +
            (uidStatus.message ? '\n' + uidStatus.message : '') +
            '\n\nClick to hide them.';

    // The count area doubles as the status readout.
    let countText = '';
    if (uidOn) {
      if (loading) countText = '…';
      else if (uidBadged > 0) countText = String(uidBadged);
      else if (failed) countText = '!';
    }

    const state = (uidOn ? '' : ' off') + (loading ? ' loading' : '') + (failed ? ' error' : '');

    for (const t of toggles) {
      if (!t.root || !t.root.isConnected) continue;
      // Rebuilt wholesale so a side change cannot drop the theme class, or vice versa.
      t.root.className = t.kind === 'inline'
        ? 'uid-inline' + state
        : 'uid-toggle side-' + currentSide + (pageIsDark ? ' on-dark' : '') + state;
      t.root.setAttribute('aria-checked', uidOn ? 'true' : 'false');
      t.root.title = title;
      // The toolbar is tight, so the inline copy uses a shorter busy label.
      t.labelEl.textContent = !uidOn ? 'Show UID'
        : loading ? (t.kind === 'inline' ? 'Fetching…' : 'Fetching records')
        : 'Hide UID';
      t.countEl.hidden = !countText;
      if (countText) t.countEl.textContent = countText;
    }

    // Once the control is sitting in the toolbar, the floating pill is clutter.
    if (floatingToggleEl) {
      floatingToggleEl.style.display = (inlineHost && inlineHost.isConnected) ? 'none' : '';
    }
    renderCopyBtn();
  }

  // -------------------------------------------------- copy UIDs
  //
  // The list is requested from uid-badges.js at click time rather than cached, so
  // a checkbox ticked a moment ago is always included.
  function requestUids() {
    return new Promise((resolve) => {
      let done = false;
      try {
        window.dispatchEvent(new CustomEvent('zuper-uid-collect', {
          detail: { resolve: (r) => { done = true; resolve(r); } },
        }));
      } catch (e) {}
      if (!done) resolve(null);   // badge script absent — nothing to copy
    });
  }

  function renderCopyBtn() {
    if (!copyBtnEl) return;
    const show = uidOn && uidSelection.count > 0;
    copyBtnEl.hidden = !show;
    if (!show) return;
    if (copyBtnEl.classList.contains('done')) return;   // mid-confirmation
    copyBtnEl.textContent = 'Copy ' + uidSelection.count + ' UID' +
      (uidSelection.count === 1 ? '' : 's');
    copyBtnEl.title = (uidSelection.selected
      ? 'Copy the UIDs of the ' + uidSelection.count + ' selected row(s)'
      : 'No rows are ticked, so this copies all ' + uidSelection.count +
        ' UIDs on this page') +
      '\n\nOne per line. Hold Shift to copy them comma separated.';
  }

  async function onCopyUidsClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const res = await requestUids();
    const uids = (res && res.uids) || [];
    if (!uids.length) return;

    const text = e.shiftKey ? uids.join(', ') : uids.join('\n');
    const label = 'Copied ' + uids.length;
    try {
      await navigator.clipboard.writeText(text);
      copyBtnEl.textContent = '✓ ' + label;
    } catch (err) {
      copyBtnEl.textContent = '✗ Copy failed';
    }
    copyBtnEl.classList.add('done');
    setTimeout(() => {
      copyBtnEl.classList.remove('done');
      renderCopyBtn();
    }, 1500);
  }

  window.addEventListener('zuper-uid-selection', (e) => {
    uidSelection = e.detail || { count: 0, selected: false };
    renderCopyBtn();
  });

  // Shared by the floating pill and the inline toolbar control.
  function onUidToggleClick(e) {
    e.stopPropagation();
    e.preventDefault();

    // Without this the control would flip its label and nothing else would ever
    // happen, which is indistinguishable from a broken button.
    if (!extensionAlive()) {
      showHint('The extension was reloaded, so this page is no longer connected to it. Refresh the page (Ctrl+Shift+R) to restore the UID badges.');
      return;
    }

    uidOn = !uidOn;
    if (!uidOn) uidBadged = 0;
    renderUidToggle();

    // Drive uid-badges.js directly. Both scripts share this frame's isolated
    // world, so this applies instantly and does not depend on the
    // storage.onChanged round-trip, which is the part that silently dies when the
    // extension is reloaded under an open tab.
    try {
      window.dispatchEvent(new CustomEvent('zuper-uid-set', { detail: { on: uidOn } }));
    } catch (err) {}

    // Persist for other tabs and for the options page checkbox.
    try {
      chrome.storage.local.set({ showUidBadges: uidOn });
    } catch (err) {}

    // Turning it on with nothing to show is the symptom of row detection failing
    // on this page — say so rather than leaving a silent no-op.
    clearTimeout(uidFeedbackTimer);
    if (uidOn) {
      uidFeedbackTimer = setTimeout(() => {
        if (uidOn && uidBadged === 0) {
          showHint('No record UIDs found on this page. If it is a listing, open the extension options and send the Diagnostics.');
        }
      }, 2000);
    }
  }

  // ---------------------------------------- inline toolbar control
  //
  // Preferred placement: right beside the listing's own view chip ("All
  // Customers"), where the eye already is, rather than floating in a corner.
  // Rendered inside its own shadow root so Zuper's toolbar CSS cannot restyle it
  // and ours cannot leak out.

  const INLINE_HOST_ID = 'zuper-tools-uid-inline';

  const INLINE_CSS = `
    :host { all: initial; }

    .uid-inline {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 30px;
      padding: 0 11px;
      font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      font-size: 12.5px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: #191919;
      background: #FFFFFF;
      border: 1px solid #D1D5DB;
      border-radius: 8px;
      cursor: pointer;
      white-space: nowrap;
      transition: border-color 140ms linear, background-color 140ms linear, color 140ms linear;
    }
    .uid-inline:hover {
      color: #FD5000;
      background: #FFF5F0;
      border-color: rgba(253, 80, 0, 0.55);
    }
    .uid-inline:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px rgba(253, 80, 0, 0.32);
    }
    .uid-inline.off { color: #6B7280; }
    .uid-inline.error { border-color: rgba(255, 122, 61, 0.8); }

    .uid-dot {
      width: 7px; height: 7px; flex: none;
      border-radius: 50%;
      background: #FD5000;
      box-sizing: border-box;
    }
    .uid-inline.off .uid-dot { background: transparent; border: 1.5px solid #9CA3AF; }
    .uid-inline.loading .uid-dot { animation: uid-pulse 900ms ease-in-out infinite; }

    .uid-count {
      font-family: ui-monospace, 'Cascadia Mono', 'Segoe UI Mono', Menlo, monospace;
      font-size: 10.5px;
      font-weight: 500;
      color: #6B7280;
    }
    .uid-count[hidden] { display: none; }

    /* Copy control, sharing the toggle's shape but visually secondary to it. */
    .uid-copy {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 30px;
      padding: 0 11px;
      margin-left: 6px;
      font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      font-size: 12.5px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: #4B5563;
      background: #FFFFFF;
      border: 1px solid #D1D5DB;
      border-radius: 8px;
      cursor: pointer;
      white-space: nowrap;
      transition: border-color 140ms linear, background-color 140ms linear, color 140ms linear;
    }
    .uid-copy:hover {
      color: #FD5000;
      background: #FFF5F0;
      border-color: rgba(253, 80, 0, 0.55);
    }
    .uid-copy:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px rgba(253, 80, 0, 0.32);
    }
    .uid-copy[hidden] { display: none; }
    .uid-copy.done {
      color: #1E854B;
      background: #E7F6EC;
      border-color: rgba(30, 133, 75, 0.45);
    }

    @keyframes uid-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.35; transform: scale(0.7); }
    }
    @media (prefers-reduced-motion: reduce) {
      .uid-inline.loading .uid-dot { animation: none; opacity: 0.6; }
    }
  `;

  // "All Customers" is the target; "Create New View" is the backup anchor. Both
  // are matched on their visible text rather than a class, because Zuper's class
  // names are not ours to depend on.
  function findToolbarAnchor() {
    if (!document.body) return null;
    const els = document.body.querySelectorAll('button, a, li, span, div');
    const cap = Math.min(els.length, 3000);
    let fallback = null;
    for (let i = 0; i < cap; i++) {
      const el = els[i];
      if (el.children.length > 2) continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 40) continue;

      // Match the text before measuring. getBoundingClientRect forces layout, and
      // running it on every short-text element in a real app page — thousands of
      // them, on every re-render — is enough to make the page feel sticky.
      const isAll = /^all\s+\S+/i.test(text);
      const isNewView = /^create\s+new\s+view$/i.test(text);
      if (!isAll && !isNewView) continue;
      if (el.id === INLINE_HOST_ID || el.closest('#' + INLINE_HOST_ID)) continue;

      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 12 || r.top < 0 || r.top > window.innerHeight) continue;
      if (isAll) return el;
      if (!fallback) fallback = el;
    }
    return fallback;
  }

  function mountInlineToggle() {
    if (!hostEl) return;                                  // launcher disabled entirely
    if (inlineHost && inlineHost.isConnected) return;
    const anchor = findToolbarAnchor();
    if (!anchor || !anchor.parentNode) return;

    const host = document.createElement('span');
    host.id = INLINE_HOST_ID;
    host.style.cssText = [
      'all: initial !important',
      'display: inline-flex !important',
      'vertical-align: middle !important',
      'margin: 0 0 0 8px !important',
      'line-height: normal !important',
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(INLINE_CSS);
    shadow.adoptedStyleSheets = [sheet];

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'switch');

    const dot = document.createElement('span');
    dot.className = 'uid-dot';
    const label = document.createElement('span');
    label.className = 'uid-label';
    const count = document.createElement('span');
    count.className = 'uid-count';
    count.hidden = true;

    btn.append(dot, label, count);
    btn.addEventListener('click', onUidToggleClick);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'uid-copy';
    copy.hidden = true;
    copy.addEventListener('click', onCopyUidsClick);

    shadow.append(btn, copy);
    copyBtnEl = copy;

    anchor.parentNode.insertBefore(host, anchor.nextSibling);
    inlineHost = host;

    for (let i = toggles.length - 1; i >= 0; i--) {
      if (toggles[i].kind === 'inline') toggles.splice(i, 1);
    }
    toggles.push({ root: btn, labelEl: label, countEl: count, kind: 'inline' });
    renderUidToggle();
  }

  function queueInlineMount() {
    clearTimeout(inlineTimer);
    inlineTimer = setTimeout(mountInlineToggle, 350);
  }

  function build(side) {
    currentSide = side;
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

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Zuper Tools';

    chip.append(buildLogomark(), label);

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'dismiss';
    dismiss.textContent = '×';
    dismiss.title = 'Hide until this page reloads';
    dismiss.setAttribute('aria-label', 'Hide the Zuper Tools button until this page reloads');

    // Show/Hide UID toggle.
    const uidToggle = document.createElement('button');
    uidToggle.type = 'button';
    uidToggle.setAttribute('role', 'switch');   // className is set by renderUidToggle

    const uidDot = document.createElement('span');
    uidDot.className = 'uid-dot';

    const uidLabel = document.createElement('span');
    uidLabel.className = 'uid-label';

    const uidCount = document.createElement('span');
    uidCount.className = 'uid-count';
    uidCount.hidden = true;

    uidToggle.append(uidDot, uidLabel, uidCount);

    const hint = document.createElement('div');
    hint.className = 'hint side-' + side;
    hint.hidden = true;

    launcher.append(chip, dismiss);
    shadow.append(uidToggle, launcher, hint);

    floatingToggleEl = uidToggle;
    toggles.push({ root: uidToggle, labelEl: uidLabel, countEl: uidCount, kind: 'floating' });
    uidToggle.addEventListener('click', onUidToggleClick);
    renderUidToggle();

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
    if (inlineHost && inlineHost.parentNode) inlineHost.parentNode.removeChild(inlineHost);
    clearTimeout(inlineTimer);
    toggles.length = 0;
    hostEl = null;
    launcherEl = null;
    hintEl = null;
    floatingToggleEl = null;
    inlineHost = null;
    copyBtnEl = null;
  }

  // Zuper is a single-page app; if a route change wipes our nodes we put them
  // back. The toolbar control needs the deeper subtree watch, because navigating
  // between listings re-renders the toolbar without touching document.body's own
  // children.
  function watch() {
    const observer = new MutationObserver((mutations) => {
      if (dismissedForSession || !hostEl) return;
      if (!document.getElementById(HOST_ID) && document.body) {
        document.body.appendChild(hostEl);
      }
      // Ignore our own insertions or this would re-enter continuously.
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.id === HOST_ID || n.id === INLINE_HOST_ID) return;
        }
      }
      if (!inlineHost || !inlineHost.isConnected) queueInlineMount();
    });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  }

  // uid-badges.js is a separate content script but runs in the same isolated
  // world for this frame, so a window event is a per-tab channel between them.
  // Storage would be wrong here: it is global, so another tab's scan would
  // overwrite this tab's count.
  // Fetch progress and failures from uid-badges.js. A failure has to surface on
  // the pill — the whole complaint about the old build was that clicking it
  // produced no visible response whatsoever.
  window.addEventListener('zuper-uid-status', (e) => {
    uidStatus = e.detail || uidStatus;
    renderUidToggle();

    const state = uidStatus.state;
    if (state !== 'no-key' && state !== 'error' && state !== 'no-module') return;

    // Wait for the scan to land before complaining. If the page ended up badged
    // from its own markup, a failed API lookup is not worth interrupting over.
    clearTimeout(uidStatusHintTimer);
    uidStatusHintTimer = setTimeout(() => {
      if (!uidOn || uidBadged > 0) return;
      if (state === 'no-key') {
        showHint('No Zuper API key saved, so UIDs cannot be looked up. Add one in the extension options — right-click the toolbar icon and choose Options.');
      } else if (state === 'error') {
        showHint('Could not load UIDs: ' + uidStatus.message);
      } else {
        showHint('This page does not look like a records listing, so there is nothing to look up.');
      }
    }, 1400);
  });

  window.addEventListener('zuper-uid-report', (e) => {
    const d = e.detail || {};
    // `total` is the page-wide chip count; exact+matched is only what the latest
    // pass added, which is zero on any re-scan of an already-badged list.
    uidBadged = typeof d.total === 'number' ? d.total : (d.exact || 0) + (d.matched || 0);
    renderUidToggle();
  });

  async function start() {
    let settings;
    try {
      settings = await chrome.storage.local.get(['showButton', 'buttonSide', 'showUidBadges']);
    } catch (e) {
      settings = {};
    }
    if (settings.showButton === false) return;
    uidOn = settings.showUidBadges !== false;
    try { pageIsDark = isDarkBackdrop(document.body); } catch (e) { pageIsDark = false; }
    build(settings.buttonSide === 'left' ? 'left' : 'right');
    watch();
    // The toolbar usually renders after document_idle, so try now and let the
    // observer catch it if the anchor is not there yet.
    mountInlineToggle();
    queueInlineMount();
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
      currentSide = changes.buttonSide.newValue === 'left' ? 'left' : 'right';
      launcherEl.className = 'launcher side-' + currentSide;
      if (hintEl) hintEl.className = 'hint side-' + currentSide;
      renderUidToggle();
    }
    // Keeps the pill honest when the badges are toggled from the options page.
    if (changes.showUidBadges) {
      uidOn = changes.showUidBadges.newValue !== false;
      if (!uidOn) uidBadged = 0;
      renderUidToggle();
    }
  });

  start();
})();
