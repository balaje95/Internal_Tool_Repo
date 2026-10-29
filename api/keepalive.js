// Daily keep-alive for the "SRS catalogue" Supabase project (oneubjctfcrdhebqmzhc).
//
// Why this exists: free-tier Supabase projects pause after a week without traffic. That
// project backs the Product Catalog and Self-Onboarding tools AND the Data Manager's
// shared storage (team recycle bin, template versions, library, blocks — edge function
// zdm-store), and it was found paused on 2026-10-29. Vercel cron (vercel.json) calls this
// once a day; it reads one row from a public catalog table with the publishable key that
// already ships in tools/product-catalog.html, so nothing secret is involved.
//
// Excluded from the login gate in middleware.js so the cron can reach it.

const REST = 'https://oneubjctfcrdhebqmzhc.supabase.co/rest/v1/srs_products?select=product_id&limit=1';
const KEY = 'sb_publishable_sKeyak9fcUi7FLNCicqY0w_5RMdzEWF';

export default async function handler(req, res) {
  try {
    const r = await fetch(REST, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok, status: r.status, at: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e && e.message || e) });
  }
}
