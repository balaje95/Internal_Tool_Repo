// Canonical Zuper data-center list — single source of truth for every tool.
// Ported from the most complete list (Data Manager's ZUPER_DCS). Adding a new
// region here upgrades region coverage across all tools that use zuper-connect.js.
window.ZUPER_DCS = [
  'us-east-1', 'us-east-1a', 'us-east-1b', 'us-east-1c',
  'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-central-1',
  'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2',
  'ca-central-1', 'sa-east-1'
].map(function (r) { return 'https://' + r + '.zuperpro.com'; });
