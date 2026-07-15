// Single source of truth for the dashboard.
// Add a new tool manually by adding an object here and dropping its HTML file in /tools/,
// or use the "+ Add Tool" button in the dashboard (requires the /api/add-tool serverless
// function to be deployed with GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO/ADMIN_PASSWORD set).
//
// Keys/strings must stay double-quoted — the Add/Update/Delete/Reorder endpoints parse this
// array as JSON when they rewrite this file, so unquoted keys or trailing commas will break it.
//
// Recognized fields per tool: name, description, file, icon, updated (ISO date — drives the
// "New/Updated" badge), help (optional longer text shown in the info popover).
const TOOLS = [
  {
    "name": "Product Mapper",
    "description": "Bulk-map CPQ formulas or vendors to Parts & Services",
    "file": "tools/product-formula-mapper.html",
    "icon": "🧮",
    "updated": "2026-07-15",
    "help": "Connect with a Zuper API key (region auto-detected), then pick a mode. Formula mode: fetch Parts & Services + CPQ Formulas and assign a formula per product. Vendor mode: fetch Parts & Services + Vendors and add one or more vendors per product with SKU & cost — bulk-assign a vendor, add ALL vendors, or import a Product UID / Vendor UID sheet (CSV/Excel); vendors already linked to a part are skipped. Both modes send PUT product/{uid} (formula, or a vendor array like the migration scripts). Run a Dry Run, then Apply, then export a results CSV."
  },
  {
    "name": "Zuper CPQ Importer",
    "description": "Push Acculynx CPQ templates/products into Zuper via API",
    "file": "tools/cpq-importer.html",
    "icon": "📋",
    "updated": "2026-07-06",
    "help": "Upload a CPQ spreadsheet (.xlsx or .csv), connect with your Zuper API key, and it creates the products, categories, and a proposal template in the account. Run a Dry Run first to preview what will be created vs reused."
  },
  {
    "name": "Training Deck Generator",
    "description": "Auto-generate branded training decks by team type",
    "file": "tools/training-deck-generator.html",
    "icon": "🖥️",
    "updated": "2026-07-01",
    "help": "Pick a team, optionally fetch customer info via an API key, choose chapters and screenshots, then generate a branded PowerPoint training deck client-side."
  },
  {
    "name": "JN to Zuper Workflow Migration",
    "description": "Migrate JobNimbus workflows into Zuper",
    "file": "tools/jn-workflow-migration.html",
    "icon": "🔀",
    "updated": "2026-07-01",
    "help": "Drop a JobNimbus automations JSON export and it converts each automation into Zuper Workflow Builder JSON, flagging anything that needs manual mapping."
  },
  {
    "name": "Zuper Dashboard Builder",
    "description": "Build and configure custom Zuper dashboards",
    "file": "tools/dashboard-builder.html",
    "icon": "📊",
    "updated": "2026-07-01",
    "help": "Connect with your Zuper API key to view live analytics across modules, build custom widget layouts, filter by date, and export CSV/PDF."
  },
  {
    "name": "Zuper Data Manager",
    "description": "Bulk data operations and cleanup for Zuper FSM",
    "file": "tools/data-manager.html",
    "icon": "🗂️",
    "updated": "2026-07-02",
    "help": "Bulk fetch, delete, dedupe, migrate, and import Zuper records across many modules — jobs, products, CPQ, workflows and more. Dry Run is on by default for destructive actions."
  },
  {
    "name": "Zuper Process Doc Generator",
    "description": "Generate an editable, branded process document from a Zuper account",
    "file": "tools/process-doc-generator.html",
    "icon": "📝",
    "updated": "2026-07-07",
    "help": "Connect with a Zuper API key (region auto-detected) and it builds a polished process document from the account's job categories, statuses, and checklists — with a generated lifecycle flow diagram and a required-items checkpoint table. Edit any text inline, then export to Word, PDF, HTML, or raw JSON. The API key is never written into any export."
  }
];
