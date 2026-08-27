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
    "name": "Background Studio",
    "description": "Overlay an auto-adapting Zuper logo on images and download",
    "file": "tools/background-studio.html",
    "icon": "🖼️",
    "updated": "2026-07-24",
    "help": "Runs entirely in your browser. Drop one or more images (PNG/JPG) and it overlays the Zuper logo, automatically choosing the most legible treatment for each scene — Auto (reads the area under the logo), White, Dark, Zuper orange, or Tint-to-scene. Pick the logo position from a 9-point grid or drag it on the preview to fine-tune, then download the current image or all of them as a .zip. No upload, no API key."
  },
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
    "name": "Product Catalog",
    "description": "Search the live SRS, ABC & QXO roofing catalogs",
    "file": "tools/product-catalog.html",
    "icon": "📚",
    "updated": "2026-07-21",
    "help": "Browse and search the shared roofing product catalog across all three sources — SRS (19.8k products), ABC Supply (34.9k), and QXO/Beacon (76.8k). Pick a source, then search by name/brand/category or filter by category, brand, tier (Good/Better/Best/Add-on), universal, priced, or has-image. Results show image, id, category, brand, tier and suggested price; click a row to see full details plus its colors/sizes (variants). Export the current result set to CSV. Runs entirely client-side against the catalog's read-only (RLS SELECT-only) Supabase API — no Zuper account or login needed."
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
    "updated": "2026-08-21",
    "help": "Bulk fetch, delete, dedupe, migrate, and import Zuper records across many modules — jobs, recurring jobs, products, CPQ, workflows and more. Service Tasks: fetch the task instances that sit on jobs (showing the job, work order number, status, due date, priority, assignee and inspection form) and delete them in bulk; tasks that belong to no job are listed as Standalone rather than hidden, and the status filter matches the Zuper web app, so completed and cancelled tasks are not listed. Custom Fields: pick the module (Job, Customer, Asset, Contact, Property, Purchase Order, Invoice, Quote) and delete field definitions in bulk — with a warning naming the fields first, because deleting a field also deletes the value stored in it on every record of that module and that data cannot be restored. Jobs → 🎯 Delete by UID List: paste or upload a spreadsheet of job UIDs and only those jobs are looked up, shown in the grid with their number/title/customer/status, and deleted — UIDs that don't exist are reported, never queued. Recurring Jobs: delete recurrence definitions with a delete-scope choice — keep the jobs they generated, delete only future ones, or delete every generated job including completed history. Dry Run is on by default for destructive actions. CPQ → 🏠 Roofing CPQ Import: upload one workbook (Measurement Tokens, Formulas, Packages, Bundles sheets) to bulk-create CPQ measurement categories/tokens, formulas (with a confirm-before-apply variable→token mapping grid), service packages, and product bundles — dry-run, dedupe, and rate-limited."
  },
  {
    "name": "Workflow Composer",
    "description": "Describe a workflow in plain English, get Workflow Builder JSON",
    "file": "tools/workflow-composer.html",
    "icon": "🧩",
    "updated": "2026-08-13",
    "help": "Type what the automation should do (\"when a customer is created, create a Qualification job due next day at 6pm\") and the When / If / Then stages build themselves as you write — parsed locally in your browser, no AI service and no API key needed for that part. Connect with a Zuper API key (region auto-detected) to pull the account's real job categories and statuses into the pickers. Fix anything mis-read by hand, then View / Export the Workflow Builder JSON and import it via Workflow Builder → Import. Best fidelity is on the New Customer → Create Job shape, which is built from a captured working workflow; other triggers and actions export with notes telling you exactly what to repoint after importing. One-click Push is present but the create endpoint is unconfirmed — Export + Import is the reliable path today."
  },
  {
    "name": "Zuper Process Doc Generator",
    "description": "Generate a process doc, or a support-handover deck, from a Zuper account",
    "file": "tools/process-doc-generator.html",
    "icon": "📝",
    "updated": "2026-07-27",
    "help": "Connect with a Zuper API key (region auto-detected), then choose what to build. Process Doc: a polished, editable document built from the account's job categories, statuses, checklists and CPQ — with a lifecycle flow diagram and a required-items checkpoint table; export to Word, PDF, HTML or JSON. Handover Document: a Support Handover Checklist (Questionnaire) that starts as a blank template pre-filled with the account name/region, with sections for overview, environment, integrations, automations, config, promises, risks, an acceptance checklist and Fathom meeting findings — edit each section inline, add meeting blocks, or import a prepared JSON (round-trips with JSON export), then export a branded PowerPoint (.pptx). The API key is never written into any export."
  },
  {
    "name": "Go-Live Dashboard",
    "description": "Roofing implementation pipeline and go-lives vs the 10/month goal",
    "file": "tools/go-live-dashboard.html",
    "icon": "🚀",
    "updated": "2026-08-19",
    "help": "Open it and you see the current roofing pipeline — no API key, no login to Zoho. Projects are flagged Gone Live / Due This Month / Missed / Upcoming against a fixed goal of 10 go-lives a month, with go-lives vs goal by month, pipeline by status, cumulative run-rate and BA workload. A panel at the top lists what moved since the previous export — went live, ETAs slipped or pulled in, status changes, new projects — and every chip, KPI, bar and slice is clickable, opening a drawer that drills down to the project, its comments and its HubSpot deal. Filter by month, status, owner or BA, search, and sort any column. The data comes from a Zoho Projects export refreshed weekly; the header states how old it is and warns when it is over a week old. Go-Live ETA comes from the Current ETA column and Deal Value from Deal Amount, so wrong numbers get fixed in Zoho and re-exported rather than edited here."
  },
  {
    "name": "CompanyCam → Zuper Sync",
    "description": "Map CompanyCam projects to Zuper properties and sync their documents",
    "file": "tools/companycam-sync.html",
    "icon": "📷",
    "updated": "2026-08-27",
    "help": "Paste a CompanyCam access token (from app.companycam.com/access_tokens — needs a Pro/Premium/Elite plan) and it lists every project with its documents, relayed through this site's own /api/companycam function because CompanyCam sends no CORS headers. Then connect a Zuper account with an API key (region auto-detected) and fetch its properties and customers. Each CompanyCam project is auto-matched to a Zuper property on project name, project address and property address — noise words like LLC/Roofing/Construction are stripped and an exact street + zip match scores 100% — with a threshold slider and a per-row override dropdown. Documents are then attached to the customer linked to the matched property via POST customers/{customer_uid}/attachments; Zuper has no property-level attachment endpoint, so that is the real target, and a property with no linked customer is reported and skipped. Zuper stores the CompanyCam document URL rather than a copy of the file, so nothing is downloaded or re-uploaded — the tool flags any document URL carrying a signature or expiry, because those attachments would stop resolving later. Dry run is on by default; results export to CSV. Re-runs are deduped only against a record kept in the local browser, since Zuper exposes no way to list a customer's existing attachments."
  }
];
