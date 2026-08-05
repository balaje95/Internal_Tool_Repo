// Fills a tool's Zuper API key field when the tool is opened inside the Zuper
// Internal Tools browser extension's side panel, so the key does not have to be
// pasted into all eleven tools separately.
//
// Deliberate constraints, because this handles a credential:
//   * WRITE ONLY — it never reads a key out of the page and never posts anything
//     containing one. The only outbound message is a contentless "ready" ping.
//   * Only messages from a chrome-extension:// parent frame are honoured, so an
//     ordinary web page cannot drive it by framing a tool.
//   * It never overwrites a value already in the field, so anything typed or
//     restored by the tool itself wins.
//   * It fills the field and stops. Connecting stays a deliberate click, so the
//     tool never fires API calls the user did not ask for.
//
// Loading this outside the panel is a no-op: unframed pages return immediately.
(function () {
  'use strict';

  // Only ever relevant inside a frame; a tool opened in a normal tab does nothing.
  if (window.top === window.self) return;

  var filled = false;

  function looksLikeKeyField(el) {
    if (!el || el.disabled || el.readOnly || el.type === 'hidden') return false;
    var hay = [
      el.id || '',
      el.name || '',
      el.placeholder || '',
      el.getAttribute('aria-label') || '',
    ].join(' ').toLowerCase();
    if (/api[\s_-]*key/.test(hay)) return true;
    return el.type === 'password' && /key|token|secret/.test(hay);
  }

  // Tools name this field inconsistently (apikey, api-key, mig-apikey, …), so it
  // is identified by shape rather than by a per-tool id list.
  function findKeyField() {
    var inputs = document.querySelectorAll('input');
    var lonePassword = null;
    var passwordCount = 0;
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (looksLikeKeyField(el)) return el;
      if (el.type === 'password' && !el.disabled && !el.readOnly) {
        passwordCount++;
        lonePassword = el;
      }
    }
    // A single password box on a Zuper tool page is the API key. More than one is
    // ambiguous, so leave it alone rather than filling the wrong box.
    return passwordCount === 1 ? lonePassword : null;
  }

  function fill(key) {
    var el = findKeyField();
    if (!el) return false;
    if (el.value && el.value.trim()) return true;   // already populated — done, quietly
    el.value = key;
    // Frameworks and inline handlers listen for these; a bare value assignment
    // would leave the tool's own state unaware of the change.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function notify() {
    try {
      var note = document.createElement('div');
      note.textContent = 'API key filled from the Zuper Tools extension';
      note.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:16px', 'transform:translateX(-50%)',
        'z-index:2147483000', 'padding:8px 13px', 'border-radius:999px',
        'font:500 12px/1.4 Inter, system-ui, sans-serif',
        'color:#fff', 'background:#191919', 'box-shadow:0 8px 24px rgba(0,0,0,.28)',
        'pointer-events:none', 'opacity:0', 'transition:opacity 200ms ease',
      ].join(';');
      document.body.appendChild(note);
      requestAnimationFrame(function () { note.style.opacity = '1'; });
      setTimeout(function () {
        note.style.opacity = '0';
        setTimeout(function () { if (note.parentNode) note.parentNode.removeChild(note); }, 300);
      }, 2200);
    } catch (e) {}
  }

  window.addEventListener('message', function (event) {
    if (!/^chrome-extension:\/\//.test(String(event.origin))) return;
    var d = event.data;
    if (!d || d.type !== 'zuper-tools-apikey' || typeof d.apiKey !== 'string') return;
    if (filled || !d.apiKey) return;

    // The field may not be in the DOM yet on a heavy tool, so retry briefly.
    var tries = 0;
    (function attempt() {
      if (fill(d.apiKey)) {
        filled = true;
        notify();
        return;
      }
      if (++tries < 20) setTimeout(attempt, 300);
    })();
  });

  // Announce readiness so the panel can send without racing this script's load.
  // Carries no data; '*' is safe because there is nothing here to leak.
  function announce() {
    try {
      window.parent.postMessage({ type: 'zuper-tools-ready' }, '*');
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announce);
  } else {
    announce();
  }
})();
