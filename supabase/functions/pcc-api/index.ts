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
const PUBLIC_SETTINGS = new Set(["phase_map", "rag", "targets", "general", "exclude", "billing_import", "capacity", "timeoff"]);

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
    ba_name: nm(p.ba_sa) || null,
    pm_name: nm(p.project_manager) || null,
    csm_name: nm(p.customer_success_manager) || null,
    // Zoho fields the UI shows but we don't model as columns (billing flags, per-pipeline status/ETA).
    extra: Object.fromEntries(Object.entries({
      payment_collected: p.payment_collected, ready_to_invoice: p.ready_to_invoice, bill_from: p.bill_from,
      deal_closed_by: p.deal_closed_by, targeted_go_live_date: p.targeted_go_live_date,
      implementation_manager: nm(p.implementation_manager), no_of_users_on_live: p.no_of_users_on_live,
      health_of_customer: p.health_of_customer,
      lead_intake_status: p.lead_intake_status, lead_intake_eta: p.lead_intake_eta,
      inspection_status: p.inspection_status, inspection_eta: p.inspection_eta, production_eta: p.production_eta,
      reason_for_go_live_delay: p.reason_for_go_live_delay, reason_for_churn: p.reason_for_churn,
    }).filter(([, v]) => v !== undefined && v !== null && v !== "")),
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

// Zoho statuses named like these are finished work even when the status isn't a "closed type".
const DONE_STATUS = /^(done|completed?|closed|resolved)$/i;
// Top-level task keys already modelled; anything else scalar (custom fields such as the Linear link,
// type, business criticality) is kept in `extra` for the task detail view.
const TASK_KNOWN = new Set(["project", "milestone", "tasklist", "id", "prefix", "name", "description", "status", "priority", "owners_and_work",
  "duration", "completion_percentage", "sequence", "depth", "created_time", "last_modified_time", "is_completed", "created_via", "created_by",
  "updated_by", "billing_type", "log_hours", "association_info", "start_date", "end_date", "completed_on", "tags", "dependency_info", "parental_info"]);
function taskExtra(t: any) {
  const out: any = {};
  for (const [k, v] of Object.entries(t || {})) {
    if (TASK_KNOWN.has(k) || v === null || v === undefined || v === "") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = typeof v === "string" ? v.slice(0, 1000) : v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v.slice(0, 20);
    else if (v && typeof v === "object" && (v as any).name) out[k] = String((v as any).name).slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

// Edits to a Zoho task made in the Command Center: only these fields, sanitised; empty → null (no edits).
function cleanEdits(e: any) {
  if (!e || typeof e !== "object") return null;
  const s = (v: any, max: number) => (v === null || v === undefined ? null : String(v).trim().slice(0, max));
  const d = (v: any) => (v === null || v === "" ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : undefined);
  const out: any = {};
  if ("name" in e && s(e.name, 300)) out.name = s(e.name, 300);
  if ("owner_name" in e) { out.owner_name = s(e.owner_name, 120) || null; out.owner_email = s(e.owner_email, 200) || null; }
  if ("status" in e && s(e.status, 40)) out.status = s(e.status, 40);
  if ("priority" in e) out.priority = s(e.priority, 20) || null;
  if ("pipeline" in e) out.pipeline = /^P[1-9]$/.test(String(e.pipeline || "")) ? String(e.pipeline) : null;
  if ("stage" in e) out.stage = Number(e.stage) >= 1 && Number(e.stage) <= 9 ? Math.round(Number(e.stage)) : null;
  for (const k of ["start_date", "end_date"]) if (k in e && d(e[k]) !== undefined) out[k] = d(e[k]);
  if ("notes" in e) out.notes = s(e.notes, 4000) || null;
  return Object.keys(out).length ? out : null;
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
    is_completed: !!(t.is_completed || t.status?.is_closed_type || DONE_STATUS.test(String(t.status?.name || "").trim())),
    owners,
    start_date: t.start_date || null,
    end_date: t.end_date || null,
    completion: num(t.completion_percentage),
    created_time: t.created_time || null,
    modified_time: t.last_modified_time || null,
    description: t.description ? String(t.description).slice(0, 20000) : null,
    prefix: t.prefix || null,
    priority: t.priority && t.priority !== "none" ? String(t.priority) : null,
    sequence: Number.isFinite(Number(t.sequence?.sequence)) ? Number(t.sequence.sequence) : null,
    created_by_name: nm(t.created_by) || null,
    updated_by_name: nm(t.updated_by) || null,
    log_hours: t.log_hours?.total_hours && t.log_hours.total_hours !== "00:00" ? String(t.log_hours.total_hours) : null,
    extra: taskExtra(t),
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
  // Guard: a mistyped industry returns nothing from Zoho, which would otherwise wipe every project
  // and its snapshot history — so never drop when nothing matched, or when most rows would go.
  if (industry) {
    const { data: off } = await db.from("pcc_projects").select("id,industry");
    let drop = (off || []).filter((r: any) => String(r.industry || "").toLowerCase() !== industry.toLowerCase()).map((r: any) => r.id);
    if (!rows.length || drop.length > Math.max(5, (off || []).length * 0.2)) drop = [];
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
  // Write the new rows first, then remove tasks Zoho no longer has — a failed write leaves the old list intact.
  for (let i = 0; i < tRows.length; i += 300) {
    const { error } = await db.from("pcc_tasks").upsert(tRows.slice(i, i + 300));
    if (error) throw new Error("upsert tasks: " + error.message);
  }
  const keep = new Set(tRows.map((r) => r.id));
  const { data: had } = await db.from("pcc_tasks").select("id").eq("project_id", projectId);
  const gone = (had || []).map((r: any) => r.id).filter((id: string) => !keep.has(id));
  for (let i = 0; i < gone.length; i += 200) await db.from("pcc_tasks").delete().in("id", gone.slice(i, i + 200));
  if (mRows.length) {
    await db.from("pcc_milestones").delete().eq("project_id", projectId);
    await db.from("pcc_milestones").upsert(mRows);
  }
  await db.from("pcc_projects").update({ tasks_synced_at: new Date().toISOString() }).eq("id", projectId);
  return tRows.length;
}

// ─── Time logs (capacity) ────────────────────────────────────────────────────
// Portal-wide V2 endpoint: every user's logs across ALL projects (roofing, other industries and
// the internal "CX - Onboarding - Activities" project). V3 bulk time logs is known to return
// partial lists, so V2 is used deliberately. Needs scope ZohoProjects.timesheets.READ.
class ScopeMissing extends Error {}
const isoFromLong = (n: any) => {
  const v = Number(n);
  // +12h then take the UTC date: lands on the right calendar day for any portal timezone.
  return Number.isFinite(v) && v > 0 ? new Date(v + 12 * 3600 * 1000).toISOString().slice(0, 10) : null;
};
const isoFromMDY = (s: any) => {
  const m = String(s || "").match(/^(\d{2})-(\d{2})-(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};
function normLog(l: any, component: string, day: any) {
  const mins = Number(l.total_minutes ?? ((Number(l.hours) || 0) * 60 + (Number(l.minutes) || 0))) || 0;
  return {
    id: String(l.id_string || l.id),
    log_date: isoFromLong(l.log_date_long) || isoFromLong(day?.date_long) || isoFromMDY(l.log_date) || isoFromMDY(day?.date),
    owner_id: l.owner_id ? String(l.owner_id) : null,
    owner_name: l.owner_name || null,
    project_id: l.project ? String(l.project.id_string || l.project.id) : null,
    project_name: l.project?.name || null,
    task_id: l.task ? String(l.task.id_string || l.task.id) : null,
    task_name: String(l.task?.name || l.name || l.bug?.title || "").replace(/&amp;/g, "&") || null,
    tasklist_name: l.task_list?.name || null,
    component, minutes: mins,
    bill_status: l.bill_status || null, approval_status: l.approval_status || null,
    synced_at: new Date().toISOString(),
  };
}
async function syncTimelogs(months: number) {
  const out = { months: 0, entries: 0 };
  const now = new Date();
  for (let i = 0; i < months; i++) {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
    const mmdd = `${String(first.getUTCMonth() + 1).padStart(2, "0")}-01-${first.getUTCFullYear()}`;
    const byId = new Map<string, any>();
    for (const comp of ["task", "general"]) {
      for (let index = 1; index < 50000; index += 200) {
        let j: any;
        try {
          j = await zget(`/restapi/portal/${PORTAL_ID}/logs?users_list=all&view_type=month&date=${mmdd}&bill_status=All&component_type=${comp}&index=${index}&range=200`);
        } catch (e) {
          const msg = String((e as Error).message || e);
          if (/scope|6401|INVALID_OAUTH|permission|401/i.test(msg)) throw new ScopeMissing(msg.slice(0, 200));
          throw e;
        }
        const days: any[] = j?.timelogs?.date || [];
        let fresh = 0, seen = 0;
        for (const day of days) {
          for (const l of [...(day.tasklogs || []), ...(day.generallogs || []), ...(day.buglogs || [])]) {
            seen++;
            const r = normLog(l, comp, day);
            if (r.id && r.log_date && !byId.has(r.id)) { byId.set(r.id, r); fresh++; }
          }
        }
        // Stop on a short page, or if the server ignored paging and repeated itself.
        if (seen < 200 || fresh === 0) break;
      }
    }
    const rows = [...byId.values()];
    await db.from("pcc_timelogs").delete().gte("log_date", first.toISOString().slice(0, 10)).lt("log_date", next.toISOString().slice(0, 10));
    for (let k = 0; k < rows.length; k += 500) {
      const { error } = await db.from("pcc_timelogs").upsert(rows.slice(k, k + 500));
      if (error) throw new Error("upsert timelogs: " + error.message);
    }
    out.months++; out.entries += rows.length;
  }
  return out;
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
    // Time logs every 2h: current + previous month; first run backfills 6 months.
    const tlStale = !state.timelogs_at || Date.now() - Date.parse(state.timelogs_at) > 2 * 3600 * 1000;
    if (force || tlStale) {
      try {
        out.timelogs = await syncTimelogs(state.timelogs_backfilled ? 2 : 6);
        state.timelogs_at = new Date().toISOString(); state.timelogs_backfilled = true; state.timelogs_error = null;
      } catch (e) {
        if (e instanceof Throttled) throw e;
        state.timelogs_error = e instanceof ScopeMissing ? "scope" : String((e as Error).message || e).slice(0, 200);
        state.timelogs_at = new Date().toISOString();
        out.errors.push("timelogs: " + state.timelogs_error);
      }
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
  const tlSince = new Date(Date.now() - 98 * 86400000).toISOString().slice(0, 10); // 14 weeks
  const [projects, tasks, milestones, snapshots, people, settingsRows, accounts, adoption, overrides, billing, billing_sheet, timelogs, native_tasks, task_meta] = await Promise.all([
    readAll("pcc_projects", "id,key,name,status,status_closed,owner_name,owner_email,secondary_name,secondary_email,ba_name,pm_name,csm_name,extra,team,partner,industry,arr,potential_arr,confidence,start_date,current_eta,baseline_eta,actual_go_live,zuper_company_id,company_login_name,deal_url,comments,tech_stack,business_tag,percent_complete,tasks_open,tasks_closed,milestones_open,milestones_closed,created_time,modified_time,first_seen,tasks_synced_at"),
    readAll("pcc_tasks", "id,project_id,pipeline,stage,tasklist_name,name,status,is_completed,owners,start_date,end_date,modified_time,created_time,prefix,priority,sequence"),
    readAll("pcc_milestones", "id,project_id,name,pipeline,start_date,end_date,status,is_closed"),
    readAll("pcc_snapshots", "snap_date,project_id,status,current_eta,tasks_open,tasks_closed", (q) => q.gte("snap_date", since)),
    readAll("pcc_people", "*"),
    readAll("pcc_settings", "key,value,updated_at"),
    readAll("pcc_accounts", "id,company_name,zuper_company_id,company_login_name,base_url,key_hint,created_at,last_pulled,last_error"),
    readAll("pcc_adoption", "account_id,snap_date,metrics", (q) => q.gte("snap_date", since)),
    readAll("pcc_pipeline_overrides", "*"),
    readAll("pcc_billing", "*"),
    readAll("pcc_billing_sheet", "*"),
    readAll("pcc_timelogs", "log_date,owner_name,owner_id,project_id,project_name,task_name,minutes,bill_status", (q) => q.gte("log_date", tlSince)),
    readAll("pcc_native_tasks", "*"),
    readAll("pcc_task_meta", "*"),
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
    projects, tasks, milestones, snapshots, people, settings, accounts, adoption, overrides, billing, billing_sheet, timelogs, native_tasks, task_meta,
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
    if (isCron && !["cron", "adoption_probe", "adoption_pull", "zoho_probe"].includes(action)) return json({ error: "cron credential is limited to maintenance actions" }, 403);
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

      case "override_save": {
        const pid = String(body.project_id || ""), pipe = String(body.pipeline || "");
        if (!pid || !/^P[1-9]$/.test(pipe)) return json({ error: "project_id and pipeline (P1..P4) required" }, 400);
        const pct = body.manual_pct === null || body.manual_pct === undefined || body.manual_pct === "" ? null
          : Math.max(0, Math.min(100, Math.round(Number(body.manual_pct))));
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100).map((it: any) => ({
          id: String(it.id || crypto.randomUUID()).slice(0, 40), text: String(it.text || "").slice(0, 300), done: !!it.done,
        })).filter((it: any) => it.text);
        const row = { project_id: pid, pipeline: pipe, manual_pct: Number.isFinite(pct as number) ? pct : null,
          status: body.status ? String(body.status).slice(0, 40) : null, note: body.note ? String(body.note).slice(0, 2000) : null,
          items, updated_at: new Date().toISOString() };
        const { error } = await db.from("pcc_pipeline_overrides").upsert(row);
        if (error) throw new Error(error.message);
        return json({ ok: true, row });
      }

      case "billing_save": {
        const pid = String(body.project_id || "");
        if (!pid) return json({ error: "project_id required" }, 400);
        const d = (v: any) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
        const n = (v: any) => (v === "" || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
        const row = {
          project_id: pid, billing_start: d(body.billing_start), frequency: body.frequency ? String(body.frequency).slice(0, 20) : null,
          term_months: n(body.term_months), renewal_date: d(body.renewal_date), next_invoice_date: d(body.next_invoice_date),
          amount_due: n(body.amount_due), payment_status: body.payment_status ? String(body.payment_status).slice(0, 30) : null,
          last_payment_date: d(body.last_payment_date), notes: body.notes ? String(body.notes).slice(0, 2000) : null,
          updated_at: new Date().toISOString(),
        };
        const { error } = await db.from("pcc_billing").upsert(row);
        if (error) throw new Error(error.message);
        return json({ ok: true, row });
      }

      // Replace the RevOps payments sheet snapshot. Rows are parsed in the browser (CSV/XLSX)
      // and sent already normalised; this only validates and stores them.
      case "billing_import": {
        const rows = Array.isArray(body.rows) ? body.rows : [];
        const d = (v: any) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
        const n = (v: any) => (v === "" || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
        const s = (v: any, max = 300) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim().slice(0, max));
        const clean = rows.filter((r: any) => r && /^\d+$/.test(String(r.deal_id || "").trim())).slice(0, 5000).map((r: any) => ({
          deal_id: String(r.deal_id).trim(), deal_name: s(r.deal_name), deal_type: s(r.deal_type, 60), zoho_status: s(r.zoho_status, 80),
          payment_status: s(r.payment_status, 60), amount: n(r.amount), amount_due: n(r.amount_due), amount_paid: n(r.amount_paid),
          first_unpaid_due: d(r.first_unpaid_due), days_due: n(r.days_due), partner: s(r.partner), solution_partner: s(r.solution_partner),
          deal_owner: s(r.deal_owner), close_year: n(r.close_year), partner_driven: s(r.partner_driven),
          oldest_invoice: d(r.oldest_invoice), latest_invoice: d(r.latest_invoice), zoho_account_link: s(r.zoho_account_link, 500),
          hs_link: s(r.hs_link, 500), connect_plan: s(r.connect_plan, 120), csr_agent: s(r.csr_agent, 120),
          report_date: d(r.report_date) || d(body.report_date), imported_at: new Date().toISOString(),
        }));
        const seen = new Set<string>();
        const uniq = clean.filter((r: any) => !seen.has(r.deal_id) && seen.add(r.deal_id));
        if (!uniq.length) return json({ error: "No rows with a numeric Deal ID were found in the file." }, 400);
        await db.from("pcc_billing_sheet").delete().neq("deal_id", "");
        for (let i = 0; i < uniq.length; i += 500) {
          const { error } = await db.from("pcc_billing_sheet").insert(uniq.slice(i, i + 500));
          if (error) throw new Error(error.message);
        }
        await setSetting("billing_import", { file: s(body.file, 200), rows: uniq.length, report_date: uniq[0].report_date, at: new Date().toISOString() });
        return json({ ok: true, rows: uniq.length, skipped: rows.length - uniq.length });
      }

      case "settings_save": {
        if (!PUBLIC_SETTINGS.has(body.key) || body.key === "billing_import") return json({ error: "unknown setting" }, 400);
        // Shape checks: a wrong shape here would break loading for everyone.
        const v = body.value, isObj = v && typeof v === "object" && !Array.isArray(v);
        const okShape = body.key === "exclude" ? Array.isArray(v) && v.every((x: any) => typeof x === "string")
          : body.key === "capacity" ? isObj && (v.public_holidays === undefined || Array.isArray(v.public_holidays))
          : isObj;
        if (!okShape) return json({ error: `Invalid value for ${body.key}.` }, 400);
        await setSetting(body.key, v);
        return json({ ok: true });
      }

      case "people_save": {
        const rows = (Array.isArray(body.rows) ? body.rows : []).filter((r: any) => r && r.email).map((r: any) => ({
          email: String(r.email).toLowerCase(), name: r.name || null, role: r.role || "Onboarding",
          org: r.org || "Zuper", capacity: Number(r.capacity) || 8, active: r.active !== false,
          weekly_hours: Number(r.weekly_hours) > 0 ? Number(r.weekly_hours) : null, // null = team default (Settings → Utilisation rules)
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
          company_name: (String(body.company_name || "").trim() || info.name || "Unnamed account").slice(0, 120),
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
        const { error } = await db.from("pcc_accounts").delete().eq("id", String(body.id || ""));
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }

      case "account_update": {
        const patch: any = {};
        if (typeof body.company_name === "string" && body.company_name.trim()) patch.company_name = body.company_name.trim().slice(0, 120);
        if (typeof body.zuper_company_id === "string") patch.zuper_company_id = body.zuper_company_id.trim().slice(0, 40);
        if (!Object.keys(patch).length) return json({ error: "Nothing to update." }, 400);
        const { error } = await db.from("pcc_accounts").update(patch).eq("id", String(body.id || ""));
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }

      // Tasks created in the Command Center (Zoho stays read-only). Upsert by id; Done ⇔ completed.
      case "task_save": {
        const pid = String(body.project_id || "").trim();
        const name = String(body.name || "").trim().slice(0, 300);
        if (!pid || !name) return json({ error: "Project and task name are required." }, 400);
        const { data: proj } = await db.from("pcc_projects").select("id").eq("id", pid).maybeSingle();
        if (!proj) return json({ error: "Unknown project." }, 400);
        const d = (v: any) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
        const s = (v: any, max = 120) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim().slice(0, max));
        const status = s(body.status, 40) || "Open";
        const done = /^(done|completed|closed)$/i.test(status);
        const id = body.id && /^[0-9a-f-]{36}$/i.test(String(body.id)) ? String(body.id) : null;
        let prevDone = false;
        if (id) {
          const { data: prev } = await db.from("pcc_native_tasks").select("is_completed").eq("id", id).maybeSingle();
          if (!prev) return json({ error: "That task no longer exists." }, 404);
          prevDone = !!prev.is_completed;
        }
        const pipe = /^P[1-9]$/.test(String(body.pipeline || "")) ? String(body.pipeline) : null;
        const stage = Number(body.stage) >= 1 && Number(body.stage) <= 9 ? Math.round(Number(body.stage)) : null;
        const row: any = {
          // tasklist_name only changes when sent (an edit without it keeps the task in its stage group)
          project_id: pid, name, pipeline: pipe, stage, tasklist_name: "tasklist_name" in body ? s(body.tasklist_name, 200) : undefined,
          status, is_completed: done, owner_name: s(body.owner_name), owner_email: s(body.owner_email, 200),
          start_date: d(body.start_date), end_date: d(body.end_date), priority: s(body.priority, 20),
          notes: s(body.notes, 4000), updated_by: s(body.by, 80), updated_at: new Date().toISOString(),
        };
        if (done && !prevDone) row.completed_at = new Date().toISOString();
        if (!done) row.completed_at = null;
        const q = id
          ? db.from("pcc_native_tasks").update(row).eq("id", id)
          : db.from("pcc_native_tasks").insert({ ...row, created_by: row.updated_by });
        const { data, error } = await q.select("*").single();
        if (error) throw new Error(error.message);
        return json({ ok: true, task: data });
      }

      case "task_delete": {
        const id = String(body.id || "");
        if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "id required" }, 400);
        const { error } = await db.from("pcc_native_tasks").delete().eq("id", id);
        if (error) throw new Error(error.message);
        return json({ ok: true });
      }

      // Full detail for one task (description is kept out of `data` to keep it light). Zoho tasks
      // synced before details were stored are fetched live once and saved.
      case "task_detail": {
        const id = String(body.id || "");
        if (!/^\d+$/.test(id)) return json({ error: "id required" }, 400);
        const { data: row } = await db.from("pcc_tasks").select("*").eq("id", id).maybeSingle();
        if (!row) return json({ error: "Task not found — it may have been removed in Zoho." }, 404);
        if (row.description === null && row.created_by_name === null) {
          try {
            const j = await zget(`/api/v3/portal/${PORTAL_ID}/projects/${row.project_id}/tasks/${id}`);
            const t = rowsOf(j, "tasks")[0] || j?.task || j?.data || j;
            if (t && t.id) {
              const n = normTask(t, row.project_id);
              const patch = { description: n.description, prefix: n.prefix, priority: n.priority, sequence: n.sequence,
                created_by_name: n.created_by_name, updated_by_name: n.updated_by_name, log_hours: n.log_hours, extra: n.extra };
              await db.from("pcc_tasks").update(patch).eq("id", id);
              Object.assign(row, patch);
            }
          } catch (_) { /* show what we have */ }
        }
        return json({ ok: true, task: row });
      }

      // Order / hide / "done here" for any task (Zoho or tool). Batch so a drag re-orders a whole group at once.
      case "task_meta_save": {
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, 500);
        const by = body.by ? String(body.by).slice(0, 80) : null;
        const ids = items.map((x: any) => String(x.task_id || "")).filter((x: string) => /^(\d+|pcc:[0-9a-f-]{36})$/i.test(x));
        if (!ids.length) return json({ error: "task_id required" }, 400);
        const { data: prev } = await db.from("pcc_task_meta").select("*").in("task_id", ids);
        const pm = new Map((prev || []).map((r: any) => [r.task_id, r]));
        const now = new Date().toISOString();
        const rows = items.filter((x: any) => ids.includes(String(x.task_id))).map((x: any) => {
          const p: any = pm.get(String(x.task_id)) || {};
          const r: any = { task_id: String(x.task_id), project_id: String(x.project_id || p.project_id || "").slice(0, 40),
            sort_order: p.sort_order ?? null, hidden: !!p.hidden, done: p.done ?? null, done_at: p.done_at ?? null, updated_by: by ?? p.updated_by ?? null, updated_at: now };
          if ("sort_order" in x) r.sort_order = Number.isFinite(Number(x.sort_order)) ? Number(x.sort_order) : null;
          if ("hidden" in x) r.hidden = !!x.hidden;
          if ("done" in x) { r.done = x.done === null ? null : !!x.done; r.done_at = x.done ? (p.done ? p.done_at : now) : null; }
          r.edits = p.edits ?? null;
          if ("edits" in x) r.edits = cleanEdits(x.edits);
          r.checks = p.checks ?? null;
          if ("checks" in x) r.checks = Array.isArray(x.checks) && x.checks.length ? x.checks.slice(0, 60).map((c: any) => String(c).slice(0, 300)) : null;
          return r;
        }).filter((r: any) => r.project_id);
        const { error } = await db.from("pcc_task_meta").upsert(rows);
        if (error) throw new Error(error.message);
        return json({ ok: true, saved: rows.length });
      }

      // Diagnostic (maintenance credential only): GET a Zoho Projects path and report its shape.
      case "zoho_probe": {
        const path = String(body.path || "");
        if (!/^\/(restapi|api\/v3)\/portal\//.test(path)) return json({ error: "path must start with /restapi/portal/ or /api/v3/portal/" }, 400);
        try {
          const j = await zget(path);
          const tl = j?.timelogs;
          const days: any[] = tl?.date || [];
          const logs = days.flatMap((d: any) => [...(d.tasklogs || []), ...(d.generallogs || [])]);
          return json({ ok: true, top: j && typeof j === "object" ? Object.keys(j) : null, tl_keys: tl ? Object.keys(tl) : null, days: days.length,
            logs: logs.length, owners: [...new Set(logs.map((l: any) => l.owner_name))].slice(0, 40),
            projects: [...new Set(logs.map((l: any) => l.project?.name))].slice(0, 20), sample_keys: logs[0] ? Object.keys(logs[0]) : null,
            sample: logs[0] ? { log_date: logs[0].log_date, log_date_long: logs[0].log_date_long, total_minutes: logs[0].total_minutes, owner_id: logs[0].owner_id, task: logs[0].task?.name } : null,
            grandtotal: tl?.grandtotal ?? null });
        } catch (e) { return json({ ok: false, error: String((e as Error).message || e).slice(0, 400) }); }
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
