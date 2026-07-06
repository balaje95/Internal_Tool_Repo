// Shared "Connect to Zuper" helper — API-key auth + region auto-detect.
// Depends on zuper-regions.js (window.ZUPER_DCS). Exposes window.ZuperConnect.
// Ported from Data Manager's resolveByApiKey/deriveWorkflowUrl and CPQ Importer's
// apiReq so every tool detects all known regions the same way.
(function (global) {
  var CLIENT_HDRS = { 'x-zuper-client': 'WEB_APP', 'x-zuper-client-version': '3.0' };

  function dcs() { return global.ZUPER_DCS || []; }

  function headers(apiKey, includeContentType) {
    var h = Object.assign({}, CLIENT_HDRS, { 'x-api-key': apiKey });
    if (includeContentType) h['Content-Type'] = 'application/json';
    return h;
  }

  // Resolve which data center an API key belongs to.
  // Returns { dcUrl, baseUrl, accountName } or throws.
  async function resolve(apiKey) {
    var resolved = null;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 12000);
    var eps = ['user/company', 'company', 'users/me', 'user/me'];
    try {
      await Promise.any(dcs().map(function (dc) {
        return (async function () {
          for (var i = 0; i < eps.length; i++) {
            if (controller.signal.aborted) throw new Error('aborted');
            var res = await fetch(dc + '/api/' + eps[i], {
              headers: headers(apiKey, false),
              signal: controller.signal
            }).catch(function () { return null; });
            if (res && res.ok) {
              var data = await res.json().catch(function () { return {}; });
              var name = (data && (data.company_name
                || (data.data && data.data.company_name)
                || data.name
                || (data.data && data.data.name)
                || (data.company && data.company.company_name))) || '';
              if (!resolved) resolved = { dcUrl: dc, baseUrl: dc + '/api/', accountName: name };
              controller.abort();
              return resolved;
            }
          }
          throw new Error('no match');
        })();
      })).catch(function () {});
    } finally {
      clearTimeout(timer);
    }
    if (!resolved) throw new Error('API key not recognised on any known Zuper server. Please check the key and try again.');
    return resolved;
  }

  // Derive the workflow-service base URL from a DC URL.
  // e.g. https://us-east-1c.zuperpro.com -> https://us-east-1-workflow.zuperpro.com/api/
  function workflowUrl(dcUrl) {
    var m = dcUrl.match(/https?:\/\/([\w-]+)\.zuperpro\.com/);
    if (!m) return '';
    var regionBase = m[1].replace(/[a-z]$/, '');
    return 'https://' + regionBase + '-workflow.zuperpro.com/api/';
  }

  // Convenience request helper. Returns { ok, status, json }.
  async function apiReq(baseUrl, apiKey, path, opts) {
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    var res = await fetch(baseUrl + path, Object.assign({}, opts, {
      headers: Object.assign(headers(apiKey, method !== 'GET'), opts.headers || {})
    }));
    var json = null;
    try { json = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, json: json };
  }

  global.ZuperConnect = {
    resolve: resolve,
    workflowUrl: workflowUrl,
    apiReq: apiReq,
    headers: headers,
    CLIENT_HDRS: CLIENT_HDRS
  };
})(window);
