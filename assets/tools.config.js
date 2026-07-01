// Single source of truth for the dashboard.
// Add a new tool manually by adding an object here and dropping its HTML file in /tools/,
// or use the "+ Add Tool" button in the dashboard (requires the /api/add-tool serverless
// function to be deployed with GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO/ADMIN_PASSWORD set).
//
// Keys/strings must stay double-quoted — the Add Tool endpoint parses this array as JSON
// when it rewrites this file, so unquoted keys or trailing commas will break it.
const TOOLS = [
  {
    "name": "Zuper CPQ Importer",
    "description": "Push Acculynx CPQ templates/products into Zuper via API",
    "file": "tools/cpq-importer.html",
    "icon": "📋"
  },
  {
    "name": "Training Deck Generator",
    "description": "Auto-generate branded training decks by team type",
    "file": "tools/training-deck-generator.html",
    "icon": "🖥️"
  },
  {
    "name": "JN to Zuper Workflow Migration",
    "description": "Migrate JobNimbus workflows into Zuper",
    "file": "tools/jn-workflow-migration.html",
    "icon": "🔀"
  },
  {
    "name": "Zuper Dashboard Builder",
    "description": "Build and configure custom Zuper dashboards",
    "file": "tools/dashboard-builder.html",
    "icon": "📊"
  },
  {
    "name": "Zuper Data Manager",
    "description": "Bulk data operations and cleanup for Zuper FSM",
    "file": "tools/data-manager.html",
    "icon": "🗂️"
  }
];
