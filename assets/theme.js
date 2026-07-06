// Shared light/dark theme for the board and all tools.
// Persists to localStorage and toggles the [data-theme] attribute on <html>.
// Any element with a `data-theme-toggle` attribute becomes a toggle button and
// gets its label kept in sync. Exposes window.ZuperTheme.
//
// To prevent a flash of the wrong theme, also add this tiny snippet in each
// page's <head> (before stylesheets):
//   <script>try{if(localStorage.getItem('zuper_tools_theme')==='dark')document.documentElement.setAttribute('data-theme','dark');}catch(e){}</script>
//
// Each page's CSS must define its dark palette under a [data-theme="dark"] block
// (see tools/cpq-importer.html for the reference pattern).
(function (global) {
  var KEY = 'zuper_tools_theme';

  function current() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }
  function apply(theme) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }
  function updateButtons() {
    var isDark = current() === 'dark';
    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      // Only set a default label if the button hasn't opted out with data-theme-toggle="icon".
      if (btns[i].getAttribute('data-theme-toggle') !== 'silent') {
        btns[i].textContent = isDark ? '☀️ Light' : '🌙 Dark';
      }
    }
  }
  function set(theme) {
    try { localStorage.setItem(KEY, theme); } catch (e) {}
    apply(theme);
    updateButtons();
  }
  function toggle() { set(current() === 'dark' ? 'light' : 'dark'); }

  // Apply saved theme immediately (in case the head snippet was omitted).
  try { apply(localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'); } catch (e) {}

  function init() {
    updateButtons();
    var btns = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i]._zthWired) continue;
      btns[i]._zthWired = true;
      btns[i].addEventListener('click', toggle);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.ZuperTheme = { set: set, toggle: toggle, current: current, init: init };
})(window);
