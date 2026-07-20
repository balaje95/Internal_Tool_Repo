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
    "name": "Lat & Long Capture",
    "description": "Bulk-geocode an address spreadsheet to latitude/longitude",
    "file": "tools/latlong-capture.html",
    "icon": "📍",
    "updated": "2026-07-16",
    "help": "Runs entirely in your browser. Enter a Google Maps Geocoding API key (never stored or exported), upload an address spreadsheet (.xlsx/.xls/.csv), and it auto-detects Street/City/State/Zipcode/Country columns plus their Billing variants. Each row geocodes when it has Street + City or Street + Zipcode; billing coordinates copy the service address when identical or absent, otherwise geocode separately. Live progress with Stop, then download full / geocoded-only / failed-with-reason Excel files."
  },
  {
    "name": "Product Mapper",
    "description": "Bulk-map formulas, vendors, colors, or update product IDs & custom fields",
    "file": "tools/product-formula-mapper.html",
    "icon": "🧮",
    "updated": "2026-07-17",
    "help": "Connect with a Zuper API key (region auto-detected), then pick a mode. Formula: assign a CPQ formula per product. Vendor: add one or more vendors per product with SKU & cost. Color: merge color options into products. Product ID: fetch products (and their custom fields) and bulk-update the Product ID and any custom-field values — edit inline in the grid or import a Product UID / Product ID sheet with a column per custom field. Every mode reads each product fresh and sends PUT product/{uid} with the full flattened payload (like the update_product_ids.py script). Run a Dry Run, then Apply, then export a results CSV."
  },
  {
    "name": "Customer ↔ Property Mapper",
    "description": "Bulk-map customers to a property in a Zuper account",
    "file": "tools/customer-property-mapper.html",
    "icon": "🏠",
    "updated": "2026-07-20",
    "help": "Connect with a Zuper API key (region auto-detected), then fetch every property and customer in the account. Each row is a property showing its already-linked customers. Add one or more customers to a property inline, bulk-add one customer to many selected properties, auto-match by address, or import a sheet with Property UID + Customer UID(s) columns (put several comma-separated customer UIDs in one cell to add them all to that property). On apply, each property is read fresh and the staged customers are merged into its customer list (existing customers preserved) via PUT property/{uid}. Run a Dry Run first and validate on a test account."
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
