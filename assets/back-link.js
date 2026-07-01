// Drop this one line into any tool's HTML (anywhere in <body>) to get a
// fixed "Back to Dashboard" link without touching the tool's own markup/logic:
//   <script src="../assets/back-link.js"></script>
(function () {
  var link = document.createElement("a");
  link.href = "../index.html";
  link.className = "back-link";
  link.textContent = "← Back to Dashboard";

  // Scoped, inline styles only — never loads the dashboard's styles.css here,
  // so a tool's own CSS is never touched.
  var style = document.createElement("style");
  style.textContent =
    ".back-link{position:fixed;top:0.75rem;left:0.75rem;z-index:2147483647;" +
    "background:#1a1a2e;color:#f4f4f8;text-decoration:none;font-size:0.85rem;" +
    "font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
    "padding:0.5rem 0.9rem;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,0.25);" +
    "opacity:0.85;transition:opacity .15s ease,background .15s ease;}" +
    ".back-link:hover{opacity:1;background:#E8500A;}";

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
