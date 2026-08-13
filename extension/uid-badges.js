// Adds a copyable UID chip to each row of a Zuper listing page.
//
// The extension cannot know Zuper's markup, and hard-coded selectors would rot
// the first time the app is restyled. So this is deliberately selector-agnostic
// and works in two layers, most trustworthy first:
//
//   1. EXACT  — the row's own DOM already contains a UUID (detail links usually
//               do). No API data needed and no guessing involved.
//   2. MATCH  — pair the row against records captured from the app's own API
//               responses (see uid-hook.js) by scoring shared rare tokens.
//
// Layer 2 only labels a row when one record wins clearly. An empty row is a
// non-event; a row showing the wrong UID would be actively dangerous, since the
// whole point is to paste these into bulk edit and delete tools.

(function () {
  if (window.__zuperUidBadgesInjected) return;
  window.__zuperUidBadgesInjected = true;

  const CHIP_CLASS = 'zuper-uid-chip';
  const DONE_ATTR = 'data-zuper-uid';
  const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  const MAX_ROWS = 400;
  const MAX_SCAN_ELEMENTS = 4000;
  const MAX_ROW_ELEMENTS = 60;
  const COMMON_TOKEN_DF = 25;   // a token in >25 records is not evidence
  const MIN_SCORE = 3;
  const MIN_MARGIN = 2;
  const DEBOUNCE_MS = 400;

  const records = new Map();      // uid -> { uid, key, fields }
  const tokenIndex = new Map();   // token -> Set(uid)
  const prefixIndex = new Map();  // first 5 chars -> Set(uid), for truncated cells
  const PREFIX_LEN = 5;

  // Listing cells are ellipsised ("hannah@hiredgunsre…"), so the visible token is
  // a truncated form of the stored one and can never match exactly. A short
  // prefix index recovers those at a lower weight.
  // Settings routes come FIRST, and the order is load-bearing. Their slugs contain
  // the generic words too — "job-categories" contains "job", "product-category"
  // contains "product", "service-task" contains "service" — so a generic hint
  // placed above would claim the page and every row would be badged with a
  // different module's UID.
  const ROUTE_HINTS = [
    [/job[-_ ]?categor/, 'job_category'],
    [/job[-_ ]?status|status[-_ ]?workflow/, 'job_status'],
    [/(customer|client)[-_ ]?notification/, 'customer_notification'],
    [/(email|sms|message)[-_ ]?template/, 'email_template'],
    [/(product|part|item)[-_ ]?categor/, 'product_category'],
    [/trade[-_ ]?type|business[-_ ]?unit/, 'trade_type'],
    [/service[-_ ]?task/, 'service_task'],
    [/(asset|inspection)[-_ ]?form|inspection[-_ ]?checklist/, 'asset_form'],
    [/formula/, 'formula'],
    [/service[-_ ]?package|\bpackages?\b/, 'package'],
    [/(proposal|quote)[-_ ]?template/, 'proposal_template'],
    [/measurement/, 'measurement_category'],
    [/purchase[-_ ]?order/, 'purchase_orders'],
    [/propert/, 'property'],
    [/customer|client/, 'customers'],
    [/\bjobs?\b|work[-_ ]?order/, 'jobs'],
    [/product|\bparts?\b|service|inventory/, 'product'],
    [/invoice/, 'invoice'],
    [/estimate|quote|proposal/, 'estimate'],
    [/asset/, 'assets'],
    [/vendor|supplier/, 'vendor'],
    [/\busers?\b|employee|technician|\bstaff\b/, 'user'],
    [/\bteams?\b/, 'team'],
    [/organi[sz]ation|\bcompan/, 'organization'],
  ];

  // Whichever rule matches LATEST in the text wins, not whichever is declared
  // first. A route names its module at the end, so /job-category/<uid>/job-status
  // lists statuses — taking the first matching rule labelled those rows with a
  // category_uid. Equal positions fall back to declaration order, which is why the
  // specific settings rules above sit ahead of the generic ones ("job-categories"
  // is matched by both at the same offset).
  function bestHint(text) {
    let mod = null;
    let at = -1;
    for (const [re, candidate] of ROUTE_HINTS) {
      const m = re.exec(text);
      if (m && m.index > at) { at = m.index; mod = candidate; }
    }
    return mod;
  }

  // The route names the module. Path and fragment are checked before the query
  // string, so /jobs?customer=… is read as jobs rather than customers.
  function detectModuleFromUrl() {
    // Only the tail of the path is considered. A route name lives at the end, and
    // matching the whole path lets an unrelated ancestor decide the module — a
    // tenant folder, a deploy prefix, or (as this was caught by) a path
    // containing "Users" turning every page into the users module.
    const tail = location.pathname.split('/').filter(Boolean).slice(-3).join('/');
    const path = (tail + ' ' + location.hash.split('?')[0]).toLowerCase();
    return bestHint(path) || bestHint((location.search + ' ' + location.hash).toLowerCase());
  }

  // Fallback for routes that do not name their module (opaque ids, /list, #/home).
  // Zuper prints the listing name beside its total — "Customers 3043" — which is a
  // reliable second source. Memoised per URL because it walks the DOM.
  let pageModuleCache = { href: '', mod: null };

  function detectModuleFromPage() {
    if (pageModuleCache.href === location.href) return pageModuleCache.mod;

    const texts = [];
    if (document.title) texts.push(document.title);
    const heads = document.querySelectorAll('h1, h2, h3, [role="heading"]');
    for (let i = 0; i < heads.length && i < 12; i++) {
      texts.push((heads[i].textContent || '').trim());
    }

    // "<Name> <count>" near the top of the page.
    const els = document.body ? document.body.querySelectorAll('span, div, p, a') : [];
    const cap = Math.min(els.length, 1500);
    for (let i = 0; i < cap; i++) {
      const el = els[i];
      if (el.children.length) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 30) continue;
      if (!/^[A-Za-z][A-Za-z &/-]+\s+[\d,]{1,9}$/.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.top >= 0 && r.top < 260 && r.width > 20) texts.push(t);
    }

    let found = null;
    for (const t of texts) {
      found = bestHint(t.toLowerCase());
      if (found) break;
    }
    pageModuleCache = { href: location.href, mod: found };
    return found;
  }

  function detectModule() {
    return detectModuleFromUrl() || detectModuleFromPage();
  }
  let enabled = true;
  let deepMode = true;   // observation currently active
  let deepPref = true;   // the user's setting, preserved across on/off cycles
  let apiPref = true;    // fetch records from the Zuper API
  let annotating = false;
  let scanTimer = 0;
  let observer = null;
  let report = { rows: 0, exact: 0, matched: 0, records: 0, url: location.href };

  // ------------------------------------------------------------- tokenising

  // textContent runs adjacent cells together ("Kirkbride" + "oleander@..." reads
  // as one token "kirkbrideoleander"), which destroys exactly the rare tokens the
  // matcher depends on. innerText inserts the boundaries but omits hidden cells,
  // so both are used and the union is tokenised.
  function rowText(row) {
    let rendered = '';
    try { rendered = row.innerText || ''; } catch (e) {}
    return rendered + ' ' + (row.textContent || '');
  }

  function tokenize(text) {
    const out = [];
    const parts = String(text).toLowerCase().split(/[^a-z0-9]+/);
    for (const p of parts) if (p.length >= 3) out.push(p);
    return out;
  }

  function indexRecord(rec) {
    if (records.has(rec.uid)) return;
    records.set(rec.uid, rec);
    const tokens = new Set();
    for (const field of rec.fields) for (const t of tokenize(field)) tokens.add(t);
    for (const t of tokens) {
      let set = tokenIndex.get(t);
      if (!set) { set = new Set(); tokenIndex.set(t, set); }
      set.add(rec.uid);
      if (t.length >= PREFIX_LEN) {
        const p = t.slice(0, PREFIX_LEN);
        let ps = prefixIndex.get(p);
        if (!ps) { ps = new Set(); prefixIndex.set(p, ps); }
        ps.add(rec.uid);
      }
    }
  }

  // --------------------------------------------------------- row discovery

  function isOurs(node) {
    return !!(node && node.classList && node.classList.contains(CHIP_CLASS));
  }

  // Layer 1: any UUID already present in this row's markup. Anchors are checked
  // first because a detail-page link is the most reliable carrier.
  function uuidFromRow(row) {
    const anchors = row.querySelectorAll('a[href]');
    for (let i = 0; i < anchors.length && i < 10; i++) {
      const m = String(anchors[i].getAttribute('href') || '').match(UUID_G);
      if (m) return m[0];
    }
    const els = row.querySelectorAll('*');
    const limit = Math.min(els.length, MAX_ROW_ELEMENTS);
    for (let i = -1; i < limit; i++) {
      const el = i === -1 ? row : els[i];
      const attrs = el.attributes;
      if (!attrs) continue;
      for (let a = 0; a < attrs.length; a++) {
        const m = String(attrs[a].value || '').match(UUID_G);
        if (m) return m[0];
      }
    }
    return null;
  }

  // Find listing rows without knowing the markup.
  //
  // Tables and ARIA grids are unambiguous structures, so every one of them is
  // annotated — a page can hold several lists (a job's line items beside its
  // attachments) and badging only the biggest would silently skip the rest.
  // The repeated-sibling sweep is a heuristic that can latch onto a nav menu, so
  // only its single best group is used.
  function findRows() {
    const rows = [];
    const kinds = [];
    const seen = new Set();

    function add(list, kind) {
      let added = 0;
      for (const r of list) {
        if (!r || seen.has(r)) continue;
        seen.add(r);
        rows.push(r);
        added++;
      }
      if (added) kinds.push(kind + ':' + added);
    }

    // One row is enough for a real table or ARIA grid. Requiring two meant a
    // listing filtered or searched down to a single result got no badges at all.
    // The "at least a few" rule is a property of the repeated-sibling guess below,
    // where it guards against latching onto a nav menu; a <tbody> is not a guess.
    document.querySelectorAll('table').forEach((t) => {
      const trs = Array.prototype.filter.call(
        t.querySelectorAll('tbody tr'),
        (r) => r.children.length >= 2
      );
      if (trs.length) add(trs, 'table');
    });

    const ariaRows = Array.prototype.filter.call(
      document.querySelectorAll('[role="row"]'),
      (r) => !r.closest('thead') && r.children.length >= 2
    );
    if (ariaRows.length) add(ariaRows, 'aria');

    // Repeated-sibling fallback for card/div listings — best group only.
    let bestSiblings = null;
    const all = document.body ? document.body.querySelectorAll('*') : [];
    const cap = Math.min(all.length, MAX_SCAN_ELEMENTS);
    for (let i = 0; i < cap; i++) {
      const kids = all[i].children;
      if (kids.length < 3 || kids.length > 500) continue;
      const sig = (k) => k.tagName + '.' + (String(k.className || '').split(/\s+/)[0] || '');
      const first = sig(kids[0]);
      let same = 0;
      let texty = 0;
      for (let k = 0; k < kids.length; k++) {
        if (sig(kids[k]) === first) same++;
        if ((kids[k].textContent || '').trim().length > 15) texty++;
      }
      if (same / kids.length >= 0.8 && texty / kids.length >= 0.8) {
        if (!bestSiblings || kids.length > bestSiblings.length) {
          bestSiblings = Array.prototype.slice.call(kids);
        }
      }
    }
    if (bestSiblings) add(bestSiblings, 'siblings');

    return { rows: rows.slice(0, MAX_ROWS), kind: kinds.join(' ') || 'none' };
  }

  // --------------------------------------------------------------- matching

  // Layer 2: score the row against captured records on shared rare tokens.
  function matchRow(rowText) {
    if (!records.size) return null;
    const seen = new Set();
    const scores = new Map();
    const bump = (uids, weight) => {
      for (const uid of uids) scores.set(uid, (scores.get(uid) || 0) + weight);
    };
    for (const token of tokenize(rowText)) {
      if (seen.has(token)) continue;
      seen.add(token);
      const uids = tokenIndex.get(token);
      if (uids) {
        const df = uids.size;
        if (df <= COMMON_TOKEN_DF) bump(uids, df === 1 ? 2 : 1);
        continue;
      }
      // No exact hit. A truncated cell ("hiredgunsre" for "hiredgunsrestoration")
      // still carries its opening characters, so fall back to the prefix index at
      // a lower weight — enough to corroborate, not enough to decide alone.
      if (token.length >= PREFIX_LEN) {
        const ps = prefixIndex.get(token.slice(0, PREFIX_LEN));
        if (ps && ps.size <= COMMON_TOKEN_DF) bump(ps, 1);
      }
    }
    if (!scores.size) return null;

    let bestUid = null;
    let best = 0;
    let second = 0;
    for (const [uid, score] of scores) {
      if (score > best) { second = best; best = score; bestUid = uid; }
      else if (score > second) { second = score; }
    }
    // Require both an absolute floor and a clear gap to the runner-up, so two
    // similar customers never get each other's UID.
    if (best < MIN_SCORE || best - second < MIN_MARGIN) return null;
    return bestUid;
  }

  // ------------------------------------------------------------------- chip

  // Is the surface behind this element dark? Walks up until it finds an opaque
  // background, because table rows are usually transparent over a themed page.
  // Duplicated in content.js rather than shared, so the badges keep working when
  // the floating launcher is switched off.
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
    return false;   // nothing opaque found — assume a light page
  }

  function makeChip(uid, keyName, how, onDark) {
    const chip = document.createElement('span');
    chip.className = CHIP_CLASS + (onDark ? ' ' + CHIP_CLASS + '--on-dark' : '');
    chip.setAttribute('data-uid', uid);
    chip.textContent = uid.slice(0, 8);
    chip.title =
      (keyName ? keyName + '\n' : '') + uid +
      '\n\nClick to copy' + (how === 'match' ? ' (matched from API data)' : '');
    if (how === 'match') chip.setAttribute('data-inferred', '1');

    // Listing rows are usually clickable, so every pointer event has to be
    // contained or copying a UID would navigate away from the page.
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    chip.addEventListener('mousedown', swallow, true);
    chip.addEventListener('mouseup', swallow, true);
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      const full = chip.getAttribute('data-uid');
      navigator.clipboard.writeText(full).then(
        () => flash(chip, 'copied'),
        () => flash(chip, 'failed')
      );
    }, true);
    return chip;
  }

  function flash(chip, state) {
    const original = chip.textContent;
    chip.textContent = state === 'copied' ? '✓ copied' : '✗ failed';
    chip.setAttribute('data-state', state);
    setTimeout(() => {
      chip.textContent = original;
      chip.removeAttribute('data-state');
    }, 1100);
  }

  // ------------------------------------------------------------------- scan

  function scan() {
    if (!enabled || !document.body) return;
    annotating = true;
    try {
      const found = findRows();
      let exact = 0;
      let matched = 0;
      // Sampled once per scan off the first row: cheaper than per row, and it
      // keeps every chip in a list looking the same.
      const onDark = found.rows.length ? isDarkBackdrop(found.rows[0]) : false;

      for (const row of found.rows) {
        if (!row || isOurs(row)) continue;

        // A framework re-render can drop our chip while leaving the attribute,
        // so trust the chip's presence rather than the marker alone.
        const already = row.getAttribute(DONE_ATTR);
        if (already && row.querySelector('.' + CHIP_CLASS)) continue;

        let uid = uuidFromRow(row);
        let how = 'exact';
        // Gate on having records, not on deepMode. Each source is already gated
        // where it ingests — the hook by deepMode, the API lookup by apiPref — so
        // gating here too meant switching off the observer option silently
        // disabled matching of API-fetched records as well, and the badges
        // vanished while the API option was still on.
        if (!uid && records.size) {
          uid = matchRow(rowText(row));
          how = 'match';
        }
        if (!uid) continue;

        const rec = records.get(uid);
        const target = row.querySelector('td, th, [role="cell"], [role="gridcell"]') || row;
        const stale = row.querySelector('.' + CHIP_CLASS);
        if (stale) stale.remove();
        target.appendChild(makeChip(uid, rec ? rec.key : '', how, onDark));
        row.setAttribute(DONE_ATTR, uid);
        if (how === 'exact') exact++; else matched++;
      }

      // `total` is every chip currently on the page; exact/matched count only what
      // this pass added. A re-scan skips rows that are already badged, so reporting
      // exact+matched as the page total made the count collapse to zero on the
      // first DOM mutation after the initial scan.
      const total = document.querySelectorAll('.' + CHIP_CLASS).length;
      report = {
        url: location.href,
        rows: found.rows.length,
        kind: found.kind,
        exact: exact,
        matched: matched,
        total: total,
        records: records.size,
        module: apiModule || detectModule() || '(not detected)',
        apiState: apiState,
        apiCount: apiCount,
        apiMessage: apiMessage,
        at: new Date().toISOString(),
      };
      if (exact || matched) {
        console.info(
          '[Zuper Tools] UID badges: ' + total + ' on page, +' + (exact + matched) +
          ' this pass (' + exact + ' from the page, ' + matched + ' matched from API) ' +
          'across ' + found.rows.length + ' rows, ' + records.size +
          ' records captured, list type: ' + found.kind
        );
      }
      // Storage feeds the options page's diagnostics card (global, last-write
      // wins). The window event feeds this tab's Show/Hide UID pill, which needs
      // a per-tab count another tab's scan cannot clobber.
      try { chrome.storage.local.set({ uidReport: report }); } catch (e) {}
      try {
        window.dispatchEvent(new CustomEvent('zuper-uid-report', { detail: report }));
      } catch (e) {}
      emitSelection();
    } catch (e) {
      console.warn('[Zuper Tools] UID badge scan failed:', e);
    } finally {
      annotating = false;
    }
  }

  function queueScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, DEBOUNCE_MS);
  }

  // Route changes have to be noticed, or the module stays whatever it was when the
  // tab loaded. A single-page app navigates with pushState, which fires no event at
  // all, so popstate/hashchange are not enough on their own and the observer
  // callback re-checks the URL as well (a string compare, so it is free).
  let lastHref = location.href;

  function checkRoute() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    pageModuleCache = { href: '', mod: null };
    if (enabled) {
      loadApiRecords(false);   // wipes and refetches if the module changed
      queueScan();
    }
  }

  window.addEventListener('popstate', checkRoute);
  window.addEventListener('hashchange', checkRoute);

  // ------------------------------------------------- UID collection for copying
  //
  // Zuper's own row checkboxes decide the selection — the point is to pick records
  // in Zuper and paste their UIDs into Data Manager or a mapper, so the selection
  // that matters is the one already on screen.
  function rowIsChecked(row) {
    const boxes = row.querySelectorAll('input[type="checkbox"]');
    for (let i = 0; i < boxes.length; i++) if (boxes[i].checked) return true;
    // Some grids fake the control, so honour the ARIA state too.
    const aria = row.querySelector('[role="checkbox"][aria-checked="true"], [aria-selected="true"]');
    return !!aria;
  }

  // Returns { uids, selected } — selected is true when it reflects a real
  // checkbox selection rather than the whole page.
  function collectUids() {
    const picked = [];
    const all = [];
    const chips = document.querySelectorAll('.' + CHIP_CLASS);
    for (const chip of chips) {
      const uid = chip.getAttribute('data-uid');
      if (!uid) continue;
      const row = chip.closest('[' + DONE_ATTR + ']');
      if (all.indexOf(uid) < 0) all.push(uid);
      if (row && rowIsChecked(row) && picked.indexOf(uid) < 0) picked.push(uid);
    }
    return picked.length
      ? { uids: picked, selected: true }
      : { uids: all, selected: false };
  }

  function emitSelection() {
    const { uids, selected } = collectUids();
    try {
      window.dispatchEvent(new CustomEvent('zuper-uid-selection', {
        detail: { count: uids.length, selected: selected },
      }));
    } catch (e) {}
  }

  // The launcher asks for the list at click time so it is never stale.
  window.addEventListener('zuper-uid-collect', (e) => {
    const { uids, selected } = collectUids();
    const detail = e.detail;
    if (detail && typeof detail.resolve === 'function') detail.resolve({ uids, selected });
  });

  // Checking a box changes no markup, so a change/click listener is the only way
  // to know the selection moved.
  document.addEventListener('change', (e) => {
    if (!enabled) return;
    const t = e.target;
    if (t && (t.type === 'checkbox' || t.getAttribute('role') === 'checkbox')) emitSelection();
  }, true);
  document.addEventListener('click', (e) => {
    if (!enabled) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('input[type="checkbox"], [role="checkbox"], th, [role="columnheader"]')) {
      setTimeout(emitSelection, 60);
    }
  }, true);

  function removeAll() {
    document.querySelectorAll('.' + CHIP_CLASS).forEach((c) => c.remove());
    document.querySelectorAll('[' + DONE_ATTR + ']').forEach((r) => r.removeAttribute(DONE_ATTR));
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      checkRoute();
      if (annotating) return;
      // Ignore the mutations we caused ourselves, or the observer would loop.
      for (const m of mutations) {
        for (const n of m.addedNodes) if (isOurs(n)) return;
      }
      queueScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  // ---------------------------------------------------------------- wiring

  // Mirrors uid-hook.js: source identity is the real check, and the origin match
  // is only enforced when the document has a real http(s) origin.
  function realOrigin() {
    const o = location.origin;
    return o && /^https?:/i.test(o) ? o : null;
  }

  function targetOrigin() {
    return realOrigin() || '*';
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const o = realOrigin();
    if (o && event.origin !== o) return;
    const d = event.data;
    if (!d || !d.__zuperUidRecords || !Array.isArray(d.records)) return;
    if (!enabled || !deepMode) return;
    let added = 0;
    for (const rec of d.records) {
      if (rec && typeof rec.uid === 'string' && Array.isArray(rec.fields)) {
        if (!records.has(rec.uid)) added++;
        indexRecord(rec);
      }
    }
    if (added) queueScan();
  });

  // ------------------------------------------------------- Zuper API records
  //
  // The primary source. Rather than hoping a UID is somewhere in the markup or
  // that the app happened to fetch it while we were listening, this pulls the
  // module's records straight from the Zuper API with a saved key — the same
  // thing Data Manager does — and matches them to the rows on screen.
  // The fetch runs in the service worker because a content-script fetch is
  // subject to the page's CORS rules.

  let apiState = 'idle';   // idle | loading | ok | error | no-module | no-key
  let apiMessage = '';
  let apiCount = 0;
  let apiModule = null;
  let apiInFlight = false;
  let apiCached = false;
  let apiFetchedAt = 0;
  let apiAccount = '';
  let apiTruncated = false;

  function emitStatus() {
    try {
      window.dispatchEvent(new CustomEvent('zuper-uid-status', {
        detail: {
          state: apiState,
          message: apiMessage,
          module: apiModule,
          apiCount: apiCount,
        },
      }));
    } catch (e) {}
  }

  async function loadApiRecords(force) {
    if (!enabled || !apiPref) return;
    if (apiInFlight) return;

    const mod = detectModule();

    // Never match rows against another module's records. A jobs row shows its
    // customer's name, so a customer index left over from the previous route
    // matches it and badges the row with a customer_uid — a wrong UID, presented
    // with the same confidence as a right one, on its way into a bulk delete.
    if (mod && apiModule && mod !== apiModule) {
      records.clear();
      tokenIndex.clear();
      prefixIndex.clear();
      removeAll();
      apiState = 'idle';
      apiCount = 0;
      apiCached = false;
      apiFetchedAt = 0;
      force = true;
    }

    if (apiState === 'ok' && !force) return;

    apiModule = mod;
    if (!apiModule) {
      apiState = 'no-module';
      apiMessage = 'Could not tell which module this page lists, so there is nothing to fetch.';
      emitStatus();
      return;
    }

    apiInFlight = true;
    apiState = 'loading';
    apiMessage = '';
    emitStatus();

    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'uid-fetch', module: apiModule });
    } catch (e) {
      apiInFlight = false;
      apiState = 'error';
      apiMessage = 'Lost contact with the extension. Reload this page (Ctrl+Shift+R).';
      emitStatus();
      return;
    }
    apiInFlight = false;

    if (!res || !res.ok) {
      apiState = /API key/i.test((res && res.error) || '') ? 'no-key' : 'error';
      apiMessage = (res && res.error) || 'The record fetch failed.';
      emitStatus();
      return;
    }

    for (const rec of res.records) {
      indexRecord({ uid: rec.uid, key: apiModule, fields: rec.fields });
    }
    apiCount = res.records.length;
    apiState = 'ok';
    apiCached = !!res.cached;
    apiFetchedAt = res.fetchedAt || Date.now();
    apiAccount = res.account || '';
    apiTruncated = !!res.truncated;
    apiMessage = apiCount + ' ' + apiModule + ' records from ' +
      (res.account || 'the account') + (res.region ? ' (' + res.region + ')' : '') +
      (res.cached ? ', cached' : '') +
      (apiTruncated
        ? '. CAPPED at ' + (res.maxRecords || apiCount) + ' — this module has more, so rows ' +
          'beyond that will stay unbadged.'
        : '');
    emitStatus();
    queueScan();
  }

  // deepPref is the user's setting; deepMode is whether observation is actually
  // running right now. They differ because switching the badges off has to stop
  // observation too — collapsing the two lost the preference, so switching the
  // badges back on left layer 2 dead until the page was reloaded.
  function syncHook() {
    const want = enabled && deepPref;
    deepMode = want;
    try {
      window.postMessage({ __zuperUidControl: want ? 'on' : 'off' }, targetOrigin());
    } catch (e) {}
  }

  function setEnabled(on) {
    enabled = !!on;
    syncHook();
    if (enabled) {
      startObserver();
      queueScan();
      loadApiRecords(false);
    } else {
      stopObserver();
      removeAll();
    }
  }

  async function start() {
    let s;
    try {
      s = await chrome.storage.local.get(['showUidBadges', 'uidDeepMode', 'uidApiMode']);
    } catch (e) {
      s = {};
    }
    deepPref = s.uidDeepMode !== false;
    apiPref = s.uidApiMode !== false;
    setEnabled(s.showUidBadges !== false);
  }

  // Direct in-page channel from the Show/Hide UID pill. Same isolated world, so
  // this lands immediately and keeps working even when the storage listener below
  // has been orphaned by an extension reload.
  window.addEventListener('zuper-uid-set', (e) => {
    setEnabled(!!(e.detail && e.detail.on));
  });

  // Lets the side panel ask "are you actually running on this tab?". A missing
  // reply is itself the answer — it means this script was never injected here,
  // which no amount of in-page UI could report on its own.
  //
  // Wrapped because this sits at module scope: if chrome.runtime.onMessage is
  // ever missing (an orphaned context, a partially torn-down extension) an
  // exception here would abort the rest of the file — including start() — and the
  // badges would fail completely with nothing to show why.
  // Drops everything learned so far and looks the records up again. Used by the
  // panel's Refresh, for when a record was created after the 10-minute cache was
  // filled and its row would otherwise stay bare until the cache expired.
  function refreshRecords() {
    records.clear();
    tokenIndex.clear();
    prefixIndex.clear();
    pageModuleCache = { href: '', mod: null };
    apiState = 'idle';
    apiCount = 0;
    apiCached = false;
    apiFetchedAt = 0;
    removeAll();
    emitStatus();
    loadApiRecords(true);
    queueScan();
  }

  try {
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg && msg.type === 'uid-refresh') {
      refreshRecords();
      respond({ ok: true });
      return false;
    }
    if (!msg || msg.type !== 'uid-ping') return false;
    let rows = 0;
    let kind = '';
    try {
      const found = findRows();
      rows = found.rows.length;
      kind = found.kind;
    } catch (e) {}
    respond({
      ok: true,
      chips: document.querySelectorAll('.' + CHIP_CLASS).length,
      rows: rows,
      kind: kind,
      enabled: enabled,
      module: apiModule || detectModule(),
      apiState: apiState,
      apiMessage: apiMessage,
      apiCount: apiCount,
      apiCached: apiCached,
      apiAgeSec: apiFetchedAt ? Math.round((Date.now() - apiFetchedAt) / 1000) : null,
      apiAccount: apiAccount,
      indexed: records.size,
      href: location.href,
    });
    return false;
  });
  } catch (e) {
    console.warn('[Zuper Tools] could not register the status responder:', e);
  }

  // Same reasoning as above: never let a listener registration take start() down.
  try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.showUidBadges) setEnabled(changes.showUidBadges.newValue !== false);
    if (changes.uidDeepMode) {
      deepPref = changes.uidDeepMode.newValue !== false;
      syncHook();
      if (enabled && deepPref) queueScan();
    }
    if (changes.uidApiMode) {
      apiPref = changes.uidApiMode.newValue !== false;
      if (enabled && apiPref) loadApiRecords(false);
    }
    // A newly saved key should take effect without a reload.
    if (changes.apiKey && enabled && apiPref) {
      apiState = 'idle';
      loadApiRecords(true);
    }
  });
  } catch (e) {
    console.warn('[Zuper Tools] could not watch settings:', e);
  }

  start();
})();
