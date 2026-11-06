// Proxy for the US Census batch geocoder, used by tools/latlong-capture.html.
//
// Why a proxy: the Census batch endpoint (POST addressbatch, up to 10,000 rows per
// file) geocodes hundreds of addresses in one request, but it sends no CORS headers,
// so a browser page cannot call it directly. This function forwards the rows and
// returns parsed results. No key or secret is involved — the Census service is free
// and public. Sits behind the site's login gate like the tools themselves.
//
// POST { rows: [[id, street, city, state, zip], ...] }  (max 1000 per call)
// → { results: { [id]: { lat, lng, match } } }   (only matched ids are present)

export const config = { maxDuration: 60 };

const URL_BATCH = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';
const MAX_ROWS = 1000;

function csvCell(v) {
  const s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Minimal CSV line parser (handles quoted fields with commas / doubled quotes).
function parseLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const rows = body && Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length) return res.status(400).json({ error: 'rows[] required' });
  if (rows.length > MAX_ROWS) return res.status(400).json({ error: 'max ' + MAX_ROWS + ' rows per call' });

  const csv = rows.map(r => [r[0], r[1], r[2], r[3], r[4]].map(csvCell).join(',')).join('\n') + '\n';
  const form = new FormData();
  form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv');
  form.append('benchmark', 'Public_AR_Current');

  try {
    const r = await fetch(URL_BATCH, { method: 'POST', body: form });
    const text = await r.text();
    if (!r.ok) return res.status(502).json({ error: 'Census HTTP ' + r.status, detail: text.slice(0, 200) });
    const results = {};
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const f = parseLine(line);
      // id, input, Match|No_Match|Tie, Exact|Non_Exact, matched address, "lng,lat", tigerId, side
      if (f[2] !== 'Match' || !f[5]) continue;
      const [lng, lat] = f[5].split(',').map(Number);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      results[f[0]] = { lat, lng, match: f[3] || '' };
    }
    return res.status(200).json({ results, sent: rows.length });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}
