// Single source of truth for the dashboard.
// Add a new tool by adding an object here and dropping its HTML file in /tools/.
const TOOLS = [
  {
    name: "Zuper CPQ Importer",
    description: "Push Acculynx CPQ templates/products into Zuper via API",
    file: "tools/cpq-importer.html",
    icon: "📋"
  },
  {
    name: "Training Deck Generator",
    description: "Auto-generate branded training decks by team type",
    file: "tools/training-deck-generator.html",
    icon: "🖥️"
  },
  {
    name: "JN to Zuper Workflow Migration",
    description: "Migrate JobNimbus workflows into Zuper",
    file: "tools/jn-workflow-migration.html",
    icon: "🔀"
  },
  {
    name: "Zuper Dashboard Builder",
    description: "Build and configure custom Zuper dashboards",
    file: "tools/dashboard-builder.html",
    icon: "📊"
  },
  {
    name: "Zuper Data Manager",
    description: "Bulk data operations and cleanup for Zuper FSM",
    file: "tools/data-manager.html",
    icon: "🗂️"
  }
];
