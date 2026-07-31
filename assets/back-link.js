// Drop this one line into any tool's HTML (anywhere in <body>) to get a
// fixed "Back to Dashboard" link without touching the tool's own markup/logic:
//   <script src="../assets/back-link.js"></script>
(function () {
  var link = document.createElement("a");
  link.href = "../index.html";
  link.className = "back-link";
  link.textContent = "← Back to Dashboard";

  // Scoped, inline styles only — never loads the dashboard's styles.css here,
  // so a tool's own CSS is never touched. Colours are the Zuper DLS values,
  // hardcoded rather than var(--zb-*) so the link still renders correctly in a
  // tool that hasn't linked assets/zuper-brand.css.
  var style = document.createElement("style");
  style.textContent =
    ".back-link{position:fixed;top:0.75rem;left:0.75rem;z-index:2147483647;" +
    "background:#282828;color:#FFFFFF;text-decoration:none;font-size:0.85rem;" +
    "font-weight:600;font-family:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
    "padding:0.5rem 0.9rem;border-radius:999px;box-shadow:0 1px 2px rgba(25,25,25,0.06),0 8px 24px rgba(25,25,25,0.06);" +
    "opacity:0.85;transition:opacity .15s ease,background .15s ease;}" +
    ".back-link:hover{opacity:1;background:#FD5000;}";

  function inject() {
    document.head.appendChild(style);
    document.body.appendChild(link);
  }

  if (document.body) {
    inject();
  } else {
    document.addEventListener("DOMContentLoaded", inject);
  }
})();
