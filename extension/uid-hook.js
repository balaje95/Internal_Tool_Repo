// MAIN-world observer for the Zuper app's own API traffic.
//
// Why this file exists: content scripts run in an isolated world and cannot see
// the page's `fetch` / `XMLHttpRequest`, so they cannot learn what the app just
// loaded. This is injected with world:"MAIN" at document_start — before the app
// issues its first request — purely to read responses that have already been
// fetched for the page you are looking at.
//
// Hard rules, because this runs inside a live app the whole business uses:
//   * requests are never altered and responses are never consumed (we read a
//     clone, so the app still gets its untouched body),
//   * every hook body is wrapped in try/catch and always falls through to the
//     original function, so a bug here cannot break Zuper,
//   * nothing is sent anywhere. Records are posted to this extension's own
//     content script via window.postMessage and never leave the browser.

(function () {
  if (window.__zuperUidHookInstalled) return;
  window.__zuperUidHookInstalled = true;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_NODES = 20000;   // guard against walking a pathological payload
  const MAX_DEPTH = 8;
  const MAX_RECORDS_PER_RESPONSE = 500;
  const MAX_FIELDS = 10;

  // Keys most likely to be shown in a listing row, checked first so the
  // fingerprint we build is the text a user actually sees on screen.
  const PRIORITY_KEY = /(number|name|title|code|email|phone|mobile|sku|address|street|city|zip|status|category)/i;

  const originals = {
    fetch: window.fetch,
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
  };
  // Must start armed. The whole reason this runs at document_start is to be in
  // place before the app's first request, and the listing fetch normally lands
  // well before uid-badges.js loads at document_idle and can say 'on'. If the
  // user has the feature off, uid-badges.js sends 'off' a moment later and
  // whatever was captured in between is dropped without ever being displayed.
  let enabled = true;

  // postMessage is not buffered, so records published before uid-badges.js exists
  // would simply vanish — which is most of them on a normal page load. They are
  // kept here and re-sent when the badge script announces itself.
  const buffer = [];
  const MAX_BUFFER = 20;

  // postMessage plumbing. `event.source !== window` is the real guarantee that a
  // message came from this page and not an embedded frame; the origin comparison
  // is belt-and-braces and is only applied when the document has a real http(s)
  // origin, because an opaque origin ("null") can never compare equal and would
  // silently drop every message.
  function realOrigin() {
    const o = location.origin;
    return o && /^https?:/i.test(o) ? o : null;
  }

  function targetOrigin() {
    return realOrigin() || '*';
  }

  function fromThisWindow(event) {
    if (event.source !== window) return false;
    const o = realOrigin();
    return !o || event.origin === o;
  }

  function isApiUrl(url) {
    const s = String(url || '');
    return s.indexOf('/api/') >= 0 || /zuperpro\.com/i.test(s);
  }

  // Guess the module from the endpoint so we can pick a record's OWN uid. A job
  // payload carries job_uid alongside customer_uid and assigned_to_uid; without
  // this we would happily label a row with the wrong entity's id.
  function moduleHint(url) {
    let path = '';
    try {
      path = new URL(String(url), location.href).pathname;
    } catch (e) {
      path = String(url || '');
    }
    const words = path.split(/[^a-z_]+/i).filter((w) => w.length > 2);
    if (!words.length) return '';
    const last = words[words.length - 1].toLowerCase();
    // jobs -> job, properties -> property, addresses -> address
    if (/ies$/.test(last)) return last.replace(/ies$/, 'y');
    if (/sses$/.test(last)) return last.replace(/es$/, '');
    if (/s$/.test(last) && !/ss$/.test(last)) return last.replace(/s$/, '');
    return last;
  }

  function ownUid(obj, hint) {
    const uidKeys = [];
    for (const k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const v = obj[k];
      if (typeof v === 'string' && UUID_RE.test(v)) {
        if (/(^|_)uid$/i.test(k) || /^id$/i.test(k)) uidKeys.push(k);
      }
    }
    if (!uidKeys.length) return null;

    // Exact module match wins: job_uid on a /jobs response.
    if (hint) {
      const exact = uidKeys.find((k) => k.toLowerCase() === hint + '_uid');
      if (exact) return { uid: obj[exact], key: exact };
    }
    // A lone *_uid is unambiguous.
    if (uidKeys.length === 1) return { uid: obj[uidKeys[0]], key: uidKeys[0] };
    // Otherwise a bare `uid` is the record's own by convention.
    const bare = uidKeys.find((k) => k.toLowerCase() === 'uid');
    if (bare) return { uid: obj[bare], key: bare };

    // Several candidate ids and no way to tell which is the row's -> refuse to
    // guess. A missing badge is fine; a wrong one is not.
    return null;
  }

  function fingerprints(obj) {
    const priority = [];
    const rest = [];
    for (const k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const v = obj[k];
      if (v === null || v === undefined) continue;
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      const s = String(v).trim();
      if (s.length < 3 || s.length > 60) continue;
      if (UUID_RE.test(s)) continue;
      if (/^\d{4}-\d{2}-\d{2}T/.test(s)) continue;   // ISO timestamps
      if (/^(true|false|null)$/i.test(s)) continue;
      (PRIORITY_KEY.test(k) ? priority : rest).push(s);
    }
    const out = [];
    for (const s of priority.concat(rest)) {
      if (out.indexOf(s) < 0) out.push(s);
      if (out.length >= MAX_FIELDS) break;
    }
    return out;
  }

  // Walk the payload collecting anything that looks like a record.
  function collect(data, hint) {
    const records = [];
    const seen = new Set();
    let nodes = 0;

    (function walk(node, depth) {
      if (!node || depth > MAX_DEPTH || nodes > MAX_NODES) return;
      if (records.length >= MAX_RECORDS_PER_RESPONSE) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      if (typeof node !== 'object') return;
      nodes++;

      const found = ownUid(node, hint);
      if (found && !seen.has(found.uid)) {
        const fp = fingerprints(node);
        if (fp.length) {
          seen.add(found.uid);
          records.push({ uid: found.uid, key: found.key, fields: fp });
        }
      }
      for (const k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        const v = node[k];
        if (v && typeof v === 'object') walk(v, depth + 1);
      }
    })(data, 0);

    return records;
  }

  function send(msg) {
    try {
      window.postMessage(msg, targetOrigin());
    } catch (e) {
      /* structured-clone failure — drop it */
    }
  }

  function publish(data, url) {
    if (!enabled) return;
    let records;
    try {
      records = collect(data, moduleHint(url));
    } catch (e) {
      return;
    }
    if (!records.length) return;
    const msg = { __zuperUidRecords: true, url: String(url || ''), records: records };
    buffer.push(msg);
    if (buffer.length > MAX_BUFFER) buffer.shift();
    send(msg);
  }

  // ------------------------------------------------------------------ fetch

  window.fetch = function () {
    const promise = originals.fetch.apply(this, arguments);
    if (!enabled) return promise;
    try {
      const args = arguments;
      // Attach a passive observer. The app still receives `promise` untouched;
      // the second handler swallows rejections so we never create an unhandled
      // rejection that the app did not ask for.
      promise.then(
        function (res) {
          try {
            if (!res) return;
            const url = res.url || String((args[0] && args[0].url) || args[0] || '');
            if (!isApiUrl(url)) return;
            const ct = (res.headers && res.headers.get('content-type')) || '';
            if (!/json/i.test(ct)) return;
            res.clone().json().then(function (data) { publish(data, url); }, function () {});
          } catch (e) {}
        },
        function () {}
      );
    } catch (e) {}
    return promise;
  };

  // ------------------------------------------------------------------- XHR
  // Angular's HttpClient uses XHR, so this is the path that actually fires in
  // the Zuper app; fetch is hooked as well in case that changes.

  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__zuperUrl = url; } catch (e) {}
    return originals.xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (enabled) {
      try {
        const xhr = this;
        xhr.addEventListener('load', function () {
          try {
            const url = xhr.__zuperUrl || xhr.responseURL || '';
            if (!isApiUrl(url)) return;
            const type = xhr.responseType;
            if (type === 'json') {
              publish(xhr.response, url);
            } else if (!type || type === 'text') {
              const text = xhr.responseText;
              if (!text || text.length > 8000000) return;
              const first = text.charAt(0);
              if (first !== '{' && first !== '[') return;
              publish(JSON.parse(text), url);
            }
          } catch (e) {}
        });
      } catch (e) {}
    }
    return originals.xhrSend.apply(this, arguments);
  };

  // The isolated content script tells us to stand down when the user turns the
  // feature off, so nothing is observed unless the badges are actually wanted.
  window.addEventListener('message', function (event) {
    if (!fromThisWindow(event)) return;
    const d = event.data;
    if (!d || d.__zuperUidControl === undefined) return;
    // The wrappers stay installed and go inert instead of being torn out. They
    // used to restore the originals here, which made "off" a one-way door: the
    // 'on' message could set the flag back but nothing re-wrapped, so re-enabling
    // the badges within a page could never resume observation.
    //
    // Inert is not a compromise on privacy: with `enabled` false every wrapper
    // returns before touching the response — nothing is read, cloned or parsed.
    if (d.__zuperUidControl === 'off') {
      enabled = false;
    } else if (d.__zuperUidControl === 'on') {
      enabled = true;
      // Replay whatever was captured before the badge script was listening.
      // Re-sending is harmless: records are de-duplicated by uid on arrival.
      for (const msg of buffer) send(msg);
    }
  });
})();
