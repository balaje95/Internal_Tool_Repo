// pcc-api — backend for tools/project-command-center.html (Project Command Center).
//
// Deployed as a Supabase Edge Function on project sdbnmkbivozqdbtjahzd. It is the only
// reader/writer of the pcc_* tables (RLS on, no policies → service role only).
//
// Auth:
//   - Team password: Edge secret PCC_PASSWORD, or the salted hash in pcc_settings.auth
//     (changed from Settings). `login` returns a signed token `<exp>.<hmac>`; every other
//     action needs it in the x-pcc-token header.
//   - The scheduled sync (pg_cron + pg_net) sends x-pcc-cron = pcc_settings.cron_secret.
//   - Signing + API-key encryption keys are derived from SUPABASE_SERVICE_ROLE_KEY,
//     so there is no extra secret to manage.
//
// Zoho Projects:
//   - Self Client id/secret come from Edge secrets ZOHO_CLIENT_ID/SECRET or are entered once in
//     Settings → Connect Zoho (stored server-side in pcc_settings.zoho_client).
//   - The refresh token is never pasted: Connect Zoho sends a fresh grant *code*, exchanged
//     here and stored in pcc_settings.zoho_refresh. (The old Go-Live proxy failed because a
//     code was pasted where the refresh token belonged — both look like 1000.<hex>.<hex>.)
//   - Only one industry is synced (pcc_settings.general.industry, default "Roofing").
//   - Sync is time- and request-budgeted (Zoho throttles ~100 req / 2 min), so each call
//     does what fits and reports `pending`; cron and the Sync button just call again.
//
// Adoption:
//   - Customer Zuper API keys are AES-GCM encrypted at rest and never returned.
//   - `adoption_pull` stores one metrics row per account per day.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const PORTAL_ID = Deno.env.get("ZOHO_PORTAL_ID") || "756086486";
const ZOHO_ACCOUNTS = Deno.env.get("ZOHO_ACCOUNTS_HOST") || "accounts.zoho.com";
const ZOHO_API = Deno.env.get("ZOHO_API_HOST") || "projectsapi.zoho.com";
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

const ZUPER_DCS = [
  "us-east-1", "us-east-1a", "us-east-1b", "us-east-1c",
  "us-west-1", "us-west-1a", "us-west-1b", "us-west-1c", "us-west-2",
  "eu-west-1", "eu-west-2", "eu-central-1",
  "ap-south-1", "ap-south-2", "ap-southeast-1", "ap-southeast-2",
  "ca-central-1", "sa-east-1",
].map((r) => `https://${r}.zuperpro.com`);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-pcc-token, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ─── crypto helpers ──────────────────────────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u: ArrayBuffer) => Array.from(new Uint8Array(u)).map((b) => b.toString(16).padStart(2, "0")).join("");

async function derived(label: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(label + ":" + SB_KEY)));
}
async function hmac(msg: string) {
  const key = await crypto.subtle.importKey("raw", await derived("pcc-sign"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function issueToken() {
  const exp = String(Date.now() + TOKEN_TTL_MS);
  return exp + "." + (await hmac(exp));
}
async function verifyToken(tok: string | null) {
  if (!tok) return false;
  const i = tok.lastIndexOf(".");
  if (i < 0) return false;
  const exp = tok.slice(0, i), sig = tok.slice(i + 1);
  if (!/^\d+$/.test(exp) || Date.now() > Number(exp)) return false;
  const want = await hmac(exp);
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let k = 0; k < want.length; k++) diff |= want.charCodeAt(k) ^ sig.charCodeAt(k);
  return diff === 0;
}
async function aesKey() {
  return crypto.subtle.importKey("raw", await derived("pcc-enc"), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), enc.encode(plain)));
  return b64(iv) + "." + b64(ct);
}
async function decrypt(s: string) {
  const [iv, ct] = s.split(".");
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(), unb64(ct)));
}

// ─── settings ────────────────────────────────────────────────────────────────
async function getSetting(key: string) {
  const { data } = await db.from("pcc_settings").select("value").eq("key", key).maybeSingle();
  return data ? data.value : null;
}
async function setSetting(key: string, value: unknown) {
  const { error } = await db.from("pcc_settings").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}
// Keys the browser may read/write. zoho_* / sync_state / cron_secret / auth are server-only.
const PUBLIC_SETTINGS = new Set(["phase_map", "rag", "targets", "general", "exclude"]);

// Zoho Self Client credentials: Edge secrets win; otherwise the pair saved from Settings →
// Connect Zoho (server-only row, never returned to the browser).
async function zohoClient() {
  const envId = Deno.env.get("ZOHO_CLIENT_ID"), envSecret = Deno.env.get("ZOHO_CLIENT_SECRET");
  if (envId && envSecret) return { id: envId, secret: envSecret };
  const c = await getSetting("zoho_client");
  return c && c.id && c.secret ? { id: c.id as string, secret: c.secret as string } : null;
}

// Only this industry is synced (Settings → general.industry, default Roofing; "all" disables).
async function industryFilter(): Promise<string | null> {
  const g = (await getSetting("general")) || {};
  const v = g.industry === undefined ? "Roofing" : String(g.industry || "");
  return !v || v.toLowerCase() === "all" ? null : v;
}

// Team password: Edge secret PCC_PASSWORD, or a salted SHA-256 stored in pcc_settings.auth.
async function sha256hex(s: string) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
async function checkPassword(pw: string) {
  const envPw = Deno.env.get("PCC_PASSWORD");
  if (envPw && pw === envPw) return true;
  const a = await getSetting("auth");
  if (!a || !a.salt || !a.hash) return false;
  return (await sha256hex(a.salt + ":" + pw)) === a.hash;
}

// ─── Zoho ────────────────────────────────────────────────────────────────────
let tokenCache = { token: "", exp: 0 };
let zohoCalls = 0;

async function zohoToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const refresh = await getSetting("zoho_refresh");
  const cl = await zohoClient();
  if (!cl) throw new Error("Zoho client id/secret are not set — use Settings → Connect Zoho.");
  if (!refresh || !refresh.token) throw new Error("Zoho is not connected yet — use Settings → Connect Zoho.");
  const p = new URLSearchParams({ refresh_token: refresh.token, client_id: cl.id, client_secret: cl.secret, grant_type: "refresh_token" });
  const r = await fetch(`https://${ZOHO_ACCOUNTS}/oauth/v2/token?${p}`, { method: "POST" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || !j.access_token) throw new Error("Zoho token refresh failed: " + (j.error || r.status));
  tokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000 };
  return tokenCache.token;
}

class Throttled extends Error {}

async function zget(path: string) {
  const tok = await zohoToken();
  zohoCalls++;
  const r = await fetch(`https://${ZOHO_API}${path}`, {
    headers: { Authorization: "Zoho-oauthtoken " + tok, Accept: "application/json" },
  });
  if (r.status === 429) throw new Throttled("Zoho rate limit");
  if (r.status === 204) return {};
  const text = await r.text();
  if (/THROTTL/i.test(text)) throw new Throttled("Zoho rate limit");
  if (!r.ok) throw new Error(`Zoho ${path} → ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

function rowsOf(j: any, ...keys: string[]): any[] {
  if (!j) return [];
  if (Array.isArray(j)) return j;
  for (const k of keys) {
    if (Array.isArray(j[k])) return j[k];
    if (j.data && Array.isArray(j.data[k])) return j.data[k];
  }
  if (Array.isArray(j.result)) return j.result;
  if (j.data && Array.isArray(j.data.result)) return j.data.result;
  if (Array.isArray(j.data)) return j.data;
  return [];
}
function hasNext(j: any, n: number, per: number) {
  const pi = j && (j.page_info || (j.data && j.data.page_info));
  const p = Array.isArray(pi) ? pi[0] : pi;
  if (p && typeof p.has_next_page === "boolean") return p.has_next_page;
  return n === per;
}

const d10 = (s: any) => (s ? String(s).slice(0, 10) : null);
const num = (v: any) => {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const nm = (u: any) => (u ? String(u.full_name || u.name || "").trim() : null);
const pipelineOf = (name: string) => {
  const m = String(name || "").match(/P\s*([1-9])/i);
  return m ? "P" + m[1] : null;
};

function normProject(p: any) {
  const ownerEmail = p.owner?.email || null;
  return {
    id: String(p.id),
    key: p.key || null,
    name: String(p.name || "").trim(),
    status: String(p.status?.name || "").trim(),
    status_closed: !!p.status?.is_closed_type,
    owner_name: nm(p.owner), owner_email: ownerEmail,
    secondary_name: nm(p.secondary_owner), secondary_email: p.secondary_owner?.email || null,
    team: p.team || null,
    partner: p.partner_driven || null,
    industry: p.industry || null,
    arr: num(p.arr_in_usd), potential_arr: num(p.potential_arr_in_usd),
    confidence: p.go_live_confidence_out_of_5 ?? null,
    start_date: d10(p.start_date),
    current_eta: d10(p.current_eta),
    actual_go_live: d10(p.actual_go_live),
    zuper_company_id: p.zuper_company_id ? String(p.zuper_company_id) : null,
    company_login_name: p.company_login_name || null,
    deal_url: p.deal_url || null,
    comments: p.project_comments || null,
    tech_stack: Array.isArray(p.tech_stack) ? p.tech_stack : [],
    business_tag: Array.isArray(p.business_tag) ? p.business_tag : [],
    percent_complete: num(p.percent_complete),
    tasks_open: p.tasks?.open_count ?? null, tasks_closed: p.tasks?.closed_count ?? null,
    milestones_open: p.milestones?.open_count ?? null, milestones_closed: p.milestones?.closed_count ?? null,
    created_time: p.created_time || null, modified_time: p.modified_time || null,
    synced_at: new Date().toISOString(),
    raw: p,
  };
}

function normTask(t: any, projectId: string) {
  const owners = (t.owners_and_work?.owners || [])
    .filter((o: any) => o && o.name && !/unassigned/i.test(o.name))
    .map((o: any) => ({ name: [o.first_name, o.last_name].filter(Boolean).join(" ") || o.name, email: o.email || null }));
  const stage = String(t.tasklist?.name || "").match(/stage\s*(\d+)/i);
  return {
    id: String(t.id),
    project_id: projectId,
    milestone_id: t.milestone?.id ? String(t.milestone.id) : null,
    milestone_name: t.milestone?.name || null,
    pipeline: pipelineOf(t.milestone?.name || ""),
    tasklist_name: t.tasklist?.name || null,
    stage: stage ? Number(stage[1]) : null,
    name: String(t.name || "").replace(/&amp;/g, "&").trim(),
    status: t.status?.name || null,
    is_completed: !!(t.is_completed || t.status?.is_closed_type),
    owners,
    start_date: t.start_date || null,
    end_date: t.end_date || null,
    completion: num(t.completion_percentage),
    created_time: t.created_time || null,
    modified_time: t.last_modified_time || null,
  };
}

async function syncProjects() {
  const per = 200;
  const all: any[] = [];
  const industry = await industryFilter();
  const filter = industry
    ? "&filter=" + encodeURIComponent(JSON.stringify({ criteria: [{ field_name: "industry", criteria_condition: "is", value: [industry] }] }))
    : "";
  for (let page = 1; page <= 30; page++) {
    const j = await zget(`/api/v3/portal/${PORTAL_ID}/projects?page=${page}&per_page=${per}${filter}`);
    const rows = rowsOf(j, "projects");
    all.push(...rows);
    if (!rows.length || !hasNext(j, rows.length, per)) break;
  }
  const seen = new Set<string>();
  const rows = all
    .filter((p) => p && p.id && !seen.has(String(p.id)) && seen.add(String(p.id)))
    .filter((p) => !industry || String(p.industry || "").trim().toLowerCase() === industry.toLowerCase())
    .map(normProject);
  // Drop anything outside the industry (e.g. synced before the filter changed); tasks cascade.
  if (industry) {
    const { data: off } = await db.from("pcc_projects").select("id,industry");
    const drop = (off || []).filter((r: any) => String(r.industry || "").toLowerCase() !== industry.toLowerCase()).map((r: any) => r.id);
    for (let i = 0; i < drop.length; i += 200) {
      await db.from("pcc_snapshots").delete().in("project_id", drop.slice(i, i + 200));
      await db.from("pcc_projects").delete().in("id", drop.slice(i, i + 200));
    }
  }

  // Preserve the first ETA we ever saw as the baseline, so slips are measurable.
  const existing = new Map<string, any>();
  for (let i = 0; i < rows.length; i += 500) {
    const ids = rows.slice(i, i + 500).map((r) => r.id);
    const { data } = await db.from("pcc_projects").select("id,baseline_eta").in("id", ids);
    (data || []).forEach((r: any) => existing.set(r.id, r));
  }
  rows.forEach((r: any) => {
    const ex = existing.get(r.id);
    r.baseline_eta = (ex && ex.baseline_eta) || r.current_eta || null;
  });
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from("pcc_projects").upsert(rows.slice(i, i + 200));
    if (error) throw new Error("upsert projects: " + error.message);
  }
  const today = new Date().toISOString().slice(0, 10);
  const snaps = rows.map((r: any) => ({
    snap_date: today, project_id: r.id, status: r.status, current_eta: r.current_eta,
    tasks_open: r.tasks_open, tasks_closed: r.tasks_closed, percent_complete: r.percent_complete,
  }));
  for (let i = 0; i < snaps.length; i += 500) {
    await db.from("pcc_snapshots").upsert(snaps.slice(i, i + 500));
  }
  return rows.length;
}

async function syncProjectTasks(projectId: string) {
  const per = 200;
  const tasks: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const j = await zget(`/api/v3/portal/${PORTAL_ID}/projects/${projectId}/tasks?page=${page}&per_page=${per}`);
    const rows = rowsOf(j, "tasks");
    tasks.push(...rows);
    if (!rows.length || !hasNext(j, rows.length, per)) break;
  }
  let phases: any[] = [];
  try {
    const j = await zget(`/api/v3/portal/${PORTAL_ID}/projects/${projectId}/phases?page=1&per_page=50`);
    phases = rowsOf(j, "milestones", "phases");
  } catch (e) {
    if (e instanceof Throttled) throw e;
  }
  const tRows = tasks.map((t) => normTask(t, projectId));
  const mRows = phases.map((m: any) => ({
    id: String(m.id), project_id: projectId, name: m.name || null,
    pipeline: pipelineOf(m.name || "") || null,
    start_date: d10(m.start_date), end_date: d10(m.end_date),
    status: m.status?.name || null, is_closed: !!(m.status?.is_closed || m.status_type === "closed"),
    owner_name: m.owner ? [m.owner.first_name, m.owner.last_name].filter(Boolean).join(" ") : null,
  }));
  await db.from("pcc_tasks").delete().eq("project_id", projectId);
  for (let i = 0; i < tRows.length; i += 300) {
    const { error } = await db.from("pcc_tasks").upsert(tRows.slice(i, i + 300));
    if (error) throw new Error("upsert tasks: " + error.message);
  }
  if (mRows.length) {
    await db.from("pcc_milestones").delete().eq("project_id", projectId);
    await db.from("pcc_milestones").upsert(mRows);
  }
  await db.from("pcc_projects").update({ tasks_synced_at: new Date().toISOString() }).eq("id", projectId);
  return tRows.length;
}

// Projects whose task list is stale: never synced, changed in Zoho since, or >24h old
// and still open. Closed projects are refreshed only when Zoho says they changed.
async function staleProjects(limit: number) {
  const data = await readAll("pcc_projects", "id,modified_time,tasks_synced_at,status_closed",
    (q) => q.order("modified_time", { ascending: false }));
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const stale = data.filter((p: any) => {
    if (!p.tasks_synced_at) return true;
    const ts = Date.parse(p.tasks_synced_at);
    if (p.modified_time && Date.parse(p.modified_time) > ts) return true;
    return !p.status_closed && ts < dayAgo;
  });
  return { ids: stale.slice(0, limit).map((p: any) => p.id), pending: stale.length };
}

async function runSync(force: boolean) {
  const started = Date.now();
  const BUDGET_MS = 110_000, MAX_CALLS = 85;
  zohoCalls = 0;
  const out: any = { projects: null, tasks_synced: 0, task_rows: 0, pending: 0, throttled: false, errors: [] };
  const state = (await getSetting("sync_state")) || {};
  try {
    const stale = !state.projects_at || Date.now() - Date.parse(state.projects_at) > 20 * 60 * 1000;
    if (force || stale) {
      out.projects = await syncProjects();
      state.projects_at = new Date().toISOString();
      await setSetting("sync_state", state);
    }
    const { ids } = await staleProjects(200);
    for (const id of ids) {
      if (Date.now() - started > BUDGET_MS || zohoCalls > MAX_CALLS) break;
      try {
        out.task_rows += await syncProjectTasks(id);
        out.tasks_synced++;
      } catch (e) {
        if (e instanceof Throttled) { out.throttled = true; break; }
        out.errors.push(String((e as Error).message || e).slice(0, 200));
        if (out.errors.length > 5) break;
      }
    }
    state.tasks_at = new Date().toISOString();
    await setSetting("sync_state", state);
  } catch (e) {
    if (e instanceof Throttled) out.throttled = true;
    else out.errors.push(String((e as Error).message || e).slice(0, 300));
  }
  out.pending = (await staleProjects(1)).pending;
  out.zoho_calls = zohoCalls;
  out.ms = Date.now() - started;
  await db.from("pcc_sync_log").insert({ kind: "sync", ok: !out.errors.length, detail: out });
  return out;
}

// ─── Zuper adoption ──────────────────────────────────────────────────────────
const ZHDR = (k: string) => ({ "x-api-key": k, "x-zuper-client": "WEB_APP", "x-zuper-client-version": "3.0", Accept: "application/json" });

async function zuperResolve(apiKey: string) {
  const eps = ["user/company", "company"];
  const tries = ZUPER_DCS.map(async (dc) => {
    for (const ep of eps) {
      const r = await fetch(`${dc}/api/${ep}`, { headers: ZHDR(apiKey), signal: AbortSignal.timeout(12000) }).catch(() => null);
      if (r && r.ok) {
        const j = await r.json().catch(() => ({}));
        const d = j?.data || j;
        return {
          base: dc + "/api/",
          name: d?.company_name || d?.name || j?.company_name || "",
          companyId: companyIdOf(j),
          loginName: String(d?.company_login_name || ""),
        };
      }
    }
    throw new Error("no");
  });
  try { return await Promise.any(tries); } catch { throw new Error("API key not recognised on any Zuper data centre."); }
}

async function zuperGet(base: string, key: string, path: string) {
  const r = await fetch(base + path, { headers: ZHDR(key), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(path + " → " + r.status);
  return r.json();
}
// The records array wherever this endpoint puts it: bare array, .data, or the first array
// inside .data / the root (the user endpoint does not use .data as an array).
function listOf(j: any): any[] {
  if (Array.isArray(j)) return j;
  if (Array.isArray(j?.data)) return j.data;
  for (const o of [j?.data, j]) {
    if (o && typeof o === "object") for (const v of Object.values(o)) if (Array.isArray(v) && v.length && typeof v[0] === "object") return v as any[];
  }
  return [];
}
const totalOf = (j: any) => {
  const t = Number(j?.total_records ?? j?.data?.total_records);
  if (Number.isFinite(t) && t >= 0) return t;
  return listOf(j).length;
};
// Numeric Zuper company id from the company response, wherever it is nested.
function companyIdOf(j: any): string {
  let found = "";
  const walk = (o: any, depth: number) => {
    if (found || !o || typeof o !== "object" || depth > 3) return;
    for (const [k, v] of Object.entries(o)) {
      if (/^company_?id$/i.test(k) && (typeof v === "number" || /^\d+$/.test(String(v)))) { found = String(v); return; }
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(j, 0);
  return found;
}
const createdOf = (x: any) => Date.parse(x?.created_at || x?.createdAt || x?.created_on || x?.created_time || "");

// Newest ~100 jobs. Tries the request shapes the other tools use; if the list comes back
// oldest-first, reads the last page(s) instead so "recent" really is recent.
async function recentJobs(base: string, key: string) {
  const prefixes = ["jobs?sort=DESC&sort_by=none&", "jobs?"];
  let j: any = null, prefix = "", lastErr = "";
  for (const pre of prefixes) {
    try { j = await zuperGet(base, key, pre + "page=1&count=100"); prefix = pre; break; } catch (e) { lastErr = (e as Error).message; }
  }
  if (!j) throw new Error(lastErr || "jobs unavailable");
  const total = totalOf(j);
  let list = listOf(j);
  const ts = list.map(createdOf).filter((n) => Number.isFinite(n));
  const ascending = ts.length > 1 && ts[0] < ts[ts.length - 1];
  if (ascending && total > list.length) {
    const lastPage = Math.ceil(total / 100);
    const more: any[] = [];
    for (const p of [lastPage, lastPage - 1].filter((n) => n > 1)) {
      try { more.push(...listOf(await zuperGet(base, key, `${prefix}page=${p}&count=100`))); } catch (_) { /* keep page 1 */ }
    }
    if (more.length) list = more;
  }
  list.sort((a, b) => (createdOf(b) || 0) - (createdOf(a) || 0));
  return { total, list };
}

async function pullAdoption(acc: any) {
  const key = await decrypt(acc.api_key_enc);
  const base = acc.base_url;
  const m: any = {};
  const safe = async (label: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { (m._errors ||= []).push(label + ": " + (e as Error).message); }
  };
  await Promise.all([
    safe("jobs", async () => {
      const { total, list } = await recentJobs(base, key);
      m.jobs_total = total;
      const now = Date.now();
      const age = (x: any) => (now - createdOf(x)) / 86400000;
      m.jobs_7d = list.filter((x) => age(x) <= 7).length;
      m.jobs_30d = list.filter((x) => age(x) <= 30).length;
      m.jobs_30d_capped = list.length >= 100 && list.every((x) => age(x) <= 30);
      const newest = list.find((x) => Number.isFinite(createdOf(x)));
      m.last_job_at = newest ? new Date(createdOf(newest)).toISOString() : null;
      const users = new Set<string>();
      list.filter((x) => age(x) <= 30).forEach((x) => (x.assigned_to || []).forEach((a: any) => {
        const u = a?.user?.user_uid || a?.user_uid || a?.user?.uid; if (u) users.add(String(u));
      }));
      m.field_users_30d = users.size;
      const done = list.filter((x) => age(x) <= 30 && /complet/i.test(x.current_job_status?.status_name || x.status || ""));
      m.jobs_completed_30d = done.length;
    }),
    // Zuper's company response has company_login_name (also on the Zoho project), not the
    // numeric id Zoho stores — that's what links an account to its project.
    safe("company", async () => {
      if (acc.company_login_name && acc.zuper_company_id) return;
      const j = await zuperGet(base, key, "user/company");
      const d = j?.data || j;
      const patch: any = {};
      if (!acc.company_login_name && d?.company_login_name) patch.company_login_name = String(d.company_login_name);
      const id = companyIdOf(j);
      if (!acc.zuper_company_id && id) patch.zuper_company_id = id;
      if (Object.keys(patch).length) await db.from("pcc_accounts").update(patch).eq("id", acc.id);
    }),
    safe("customers", async () => { m.customers_total = totalOf(await zuperGet(base, key, "customers?page=1&count=1")); }),
    safe("invoices", async () => {
      const j = await zuperGet(base, key, "invoice?page=1&count=100");
      m.invoices_total = totalOf(j);
      const now = Date.now();
      m.invoices_30d = listOf(j).filter((x) => (now - (createdOf(x) || Date.parse(x.invoice_date || ""))) / 86400000 <= 30).length;
    }),
    safe("quotes", async () => {
      const j = await zuperGet(base, key, "estimate?page=1&count=100");
      m.quotes_total = totalOf(j);
      const now = Date.now();
      m.quotes_30d = listOf(j).filter((x) => (now - createdOf(x)) / 86400000 <= 30).length;
    }),
    // `user` is the calling user only; the team list is `user/all` (paged, 10 by default).
    safe("users", async () => {
      const first = await zuperGet(base, key, "user/all?page=1&count=100");
      const list: any[] = [...listOf(first)];
      const pages = Math.min(Number(first?.total_pages) || 1, 20);
      for (let p = 2; p <= pages; p++) {
        try { list.push(...listOf(await zuperGet(base, key, `user/all?page=${p}&count=100`))); } catch (_) { break; }
      }
      const live = list.filter((u) => u.is_deleted !== true);
      const now = Date.now();
      const loginAge = (u: any) => (now - Date.parse(u.last_login_at || "")) / 86400000;
      m.users_total = live.length;
      m.users_active = live.filter((u) => u.is_active !== false).length;
      m.users_login_7d = live.filter((u) => loginAge(u) <= 7).length;
      m.users_login_30d = live.filter((u) => loginAge(u) <= 30).length;
      m.users_never_logged_in = live.filter((u) => u.is_active !== false && !u.last_login_at).length;
    }),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  await db.from("pcc_adoption").upsert({ account_id: acc.id, snap_date: today, metrics: m });
  await db.from("pcc_accounts").update({
    last_pulled: new Date().toISOString(),
    last_error: m._errors ? m._errors.join("; ").slice(0, 400) : null,
  }).eq("id", acc.id);
  return m;
}

// ─── data read ───────────────────────────────────────────────────────────────
async function readAll(table: string, cols: string, filter?: (q: any) => any) {
  const out: any[] = [];
  for (let from = 0; from < 200000; from += 1000) {
    let q = db.from(table).select(cols).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(table + ": " + error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function readData() {
  const since = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const [projects, tasks, milestones, snapshots, people, settingsRows, accounts, adoption] = await Promise.all([
    readAll("pcc_projects", "id,key,name,status,status_closed,owner_name,owner_email,secondary_name,secondary_email,team,partner,industry,arr,potential_arr,confidence,start_date,current_eta,baseline_eta,actual_go_live,zuper_company_id,company_login_name,deal_url,comments,tech_stack,business_tag,percent_complete,tasks_open,tasks_closed,milestones_open,milestones_closed,created_time,modified_time,first_seen,tasks_synced_at"),
    readAll("pcc_tasks", "id,project_id,pipeline,stage,tasklist_name,name,status,is_completed,owners,start_date,end_date,modified_time,created_time"),
    readAll("pcc_milestones", "id,project_id,name,pipeline,start_date,end_date,status,is_closed"),
    readAll("pcc_snapshots", "snap_date,project_id,status,current_eta,tasks_open,tasks_closed", (q) => q.gte("snap_date", since)),
    readAll("pcc_people", "*"),
    readAll("pcc_settings", "key,value,updated_at"),
    readAll("pcc_accounts", "id,company_name,zuper_company_id,company_login_name,base_url,key_hint,created_at,last_pulled,last_error"),
    readAll("pcc_adoption", "account_id,snap_date,metrics", (q) => q.gte("snap_date", since)),
  ]);
  const settings: any = {};
  let syncState: any = {}, zohoConnected = false;
  settingsRows.forEach((r: any) => {
    if (PUBLIC_SETTINGS.has(r.key)) settings[r.key] = r.value;
    if (r.key === "sync_state") syncState = r.value || {};
    if (r.key === "zoho_refresh") zohoConnected = !!(r.value && r.value.token);
  });
  const { data: lastLog } = await db.from("pcc_sync_log").select("at,ok,detail").order("id", { ascending: false }).limit(1);
  return {
    projects, tasks, milestones, snapshots, people, settings, accounts, adoption,
    sync: {
      ...syncState,
      zoho_connected: zohoConnected,
      zoho_client_set: !!(await zohoClient()),
      industry: await industryFilter(),
      last: lastLog && lastLog[0] || null,
    },
    server_time: new Date().toISOString(),
  };
}

// ─── router ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = String(body.action || "");

  try {
    if (action === "login") {
      if (typeof body.password !== "string" || !(await checkPassword(body.password))) {
        await new Promise((r) => setTimeout(r, 600));
        return json({ error: "Wrong password." }, 401);
      }
      return json({ token: await issueToken() });
    }

    // Scheduled sync (pg_cron + pg_net) authenticates with the service role key or with
    // the random `cron_secret` row the cron SQL reads from pcc_settings — and may only
    // run the `cron` action.
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const cronHdr = req.headers.get("x-pcc-cron") || "";
    let isCron = !!bearer && bearer === SB_KEY;
    if (!isCron && cronHdr.length >= 32) {
      const cs = await getSetting("cron_secret");
      isCron = !!(cs && cs.s && cs.s === cronHdr);
    }
    // The cron credential may also run server maintenance (adoption probe/pull), nothing else.
    if (isCron && !["cron", "adoption_probe", "adoption_pull"].includes(action)) return json({ error: "cron credential is limited to maintenance actions" }, 403);
    if (!isCron && !(await verifyToken(req.headers.get("x-pcc-token")))) {
      return json({ error: "unauthorized" }, 401);
    }

    switch (action) {
      case "data":
        return json(await readData());

      case "sync":
        return json(await runSync(!!body.force));

      case "cron": {
        const connected = await getSetting("zoho_refresh");
        const out: any = { sync: connected && connected.token ? await runSync(false) : "zoho not connected" };
        await db.from("pcc_sync_log").delete().lt("at", new Date(Date.now() - 14 * 86400000).toISOString());
        // Adoption once a day per account.
        const today = new Date().toISOString().slice(0, 10);
        const { data: accs } = await db.from("pcc_accounts").select("*");
        out.adoption = 0;
        for (const a of accs || []) {
          if (a.last_pulled && String(a.last_pulled).slice(0, 10) === today) continue;
          try { await pullAdoption(a); out.adoption++; } catch (_) { /* recorded on row */ }
        }
        return json(out);
      }

      case "zoho_connect": {
        const code = String(body.code || "").trim();
        if (!/^1000\.[0-9a-f]+\.[0-9a-f]+$/i.test(code)) return json({ error: "That doesn't look like a Zoho grant code (1000.xxxx.xxxx)." }, 400);
        // Client id/secret may come with the code (saved server-side only once the exchange works).
        const bodyId = String(body.client_id || "").trim(), bodySecret = String(body.client_secret || "").trim();
        const cl = bodyId && bodySecret ? { id: bodyId, secret: bodySecret } : await zohoClient();
        if (!cl) return json({ error: "Enter the Zoho Client ID and Client Secret from your Self Client." }, 400);
        const p = new URLSearchParams({ code, client_id: cl.id, client_secret: cl.secret, grant_type: "authorization_code" });
        const r = await fetch(`https://${ZOHO_ACCOUNTS}/oauth/v2/token?${p}`, { method: "POST" });
        const j = await r.json().catch(() => ({}));
        if (j.error || !j.refresh_token) {
          return json({ error: "Zoho rejected the code: " + (j.error || r.status) + ". Codes are single-use and expire in minutes — generate a fresh one (and check the Client ID/Secret belong to the same Self Client)." }, 400);
        }
        if (bodyId && bodySecret) await setSetting("zoho_client", { id: bodyId, secret: bodySecret });
        await setSetting("zoho_refresh", { token: j.refresh_token, scope: j.scope || null, at: new Date().toISOString() });
        tokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000 };
        const portals = await zget("/api/v3/portals").catch((e) => ({ error: String(e.message || e) }));
        return json({ ok: true, portals: rowsOf(portals, "portals").map((x: any) => ({ id: x.id, name: x.portal_name || x.name })) });
      }

      case "password_change": {
        const np = String(body.new_password || "");
        if (np.length < 8) return json({ error: "Use at least 8 characters." }, 400);
        if (!(await checkPassword(String(body.current_password || "")))) return json({ error: "Current password is wrong." }, 400);
        const salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
        await setSetting("auth", { salt, hash: await sha256hex(salt + ":" + np), at: new Date().toISOString() });
        return json({ ok: true });
      }

      case "settings_save": {
        if (!PUBLIC_SETTINGS.has(body.key)) return json({ error: "unknown setting" }, 400);
        await setSetting(body.key, body.value);
        return json({ ok: true });
      }

      case "people_save": {
        const rows = (Array.isArray(body.rows) ? body.rows : []).filter((r: any) => r && r.email).map((r: any) => ({
          email: String(r.email).toLowerCase(), name: r.name || null, role: r.role || "Onboarding",
          org: r.org || "Zuper", capacity: Number(r.capacity) || 8, active: r.active !== false,
        }));
        if (rows.length) {
          const { error } = await db.from("pcc_people").upsert(rows);
          if (error) throw new Error(error.message);
        }
        if (Array.isArray(body.remove) && body.remove.length) await db.from("pcc_people").delete().in("email", body.remove);
        return json({ ok: true, saved: rows.length });
      }

      case "account_add": {
        const key = String(body.api_key || "").trim();
        if (key.length < 20) return json({ error: "That API key looks too short." }, 400);
        const info = await zuperResolve(key);
        const { data: existing } = await db.from("pcc_accounts").select("id,api_key_enc,company_name");
        for (const a of existing || []) {
          if ((await decrypt(a.api_key_enc).catch(() => "")) === key) return json({ error: `Already added as “${a.company_name}”.` }, 409);
        }
        const { data, error } = await db.from("pcc_accounts").insert({
          company_name: body.company_name || info.name || "Unnamed account",
          zuper_company_id: info.companyId || null,
          company_login_name: info.loginName || null,
          base_url: info.base,
          api_key_enc: await encrypt(key),
          key_hint: "…" + key.slice(-4),
        }).select("id,company_name,zuper_company_id,company_login_name,base_url,key_hint,created_at").single();
        if (error) throw new Error(error.message);
        let metrics = null;
        try { metrics = await pullAdoption({ ...data, api_key_enc: await encrypt(key) }); } catch (_) { /* shown later */ }
        return json({ ok: true, account: data, metrics });
      }

      case "account_delete": {
        await db.from("pcc_accounts").delete().eq("id", String(body.id || ""));
        return json({ ok: true });
      }

      case "account_update": {
        const patch: any = {};
        if (typeof body.company_name === "string") patch.company_name = body.company_name.slice(0, 120);
        if (typeof body.zuper_company_id === "string") patch.zuper_company_id = body.zuper_company_id.slice(0, 40);
        await db.from("pcc_accounts").update(patch).eq("id", String(body.id || ""));
        return json({ ok: true });
      }

      case "adoption_probe": {
        // Diagnostic: status + response shape (keys only, no values) of candidate endpoints.
        const { data: acc } = await db.from("pcc_accounts").select("*").eq("id", String(body.id || "")).single();
        if (!acc) return json({ error: "no such account" }, 404);
        const key = await decrypt(acc.api_key_enc);
        const paths: string[] = Array.isArray(body.paths) ? body.paths.slice(0, 15) : [];
        const out: any[] = [];
        for (const p of paths) {
          try {
            const r = await fetch(acc.base_url + p, { headers: ZHDR(key), signal: AbortSignal.timeout(20000) });
            const t = await r.text();
            let j: any = null; try { j = JSON.parse(t); } catch { /* text */ }
            const d = j && (Array.isArray(j) ? j : j.data);
            const first = Array.isArray(d) ? d[0] : (d && typeof d === "object" ? d : null);
            out.push({
              path: p, status: r.status,
              top: j && typeof j === "object" && !Array.isArray(j) ? Object.keys(j) : null,
              total_records: j?.total_records ?? null,
              data_type: Array.isArray(d) ? "array[" + d.length + "]" : typeof d,
              first_keys: first ? Object.keys(first).slice(0, 60) : null,
              first_dates: first ? Object.fromEntries(Object.entries(first).filter(([k]) => /(_at|date|_time)$/i.test(k)).slice(0, 8)) : null,
              err: r.ok ? null : t.slice(0, 200),
            });
          } catch (e) { out.push({ path: p, error: (e as Error).message }); }
        }
        return json({ base: acc.base_url, out });
      }

      case "adoption_pull": {
        let q = db.from("pcc_accounts").select("*");
        if (body.id) q = q.eq("id", String(body.id));
        const { data: accs } = await q;
        const results: any[] = [];
        for (const a of accs || []) {
          try { results.push({ id: a.id, metrics: await pullAdoption(a) }); }
          catch (e) { results.push({ id: a.id, error: (e as Error).message }); }
        }
        return json({ ok: true, results });
      }

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
