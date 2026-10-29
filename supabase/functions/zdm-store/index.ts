// zdm-store — shared storage for the Zuper Data Manager (tools/data-manager.html).
//
// Deployed to the "SRS catalogue" Supabase project (oneubjctfcrdhebqmzhc) with
// verify_jwt=false: it does its own auth. Every call carries the caller's Zuper API key
// and regional base URL (x-zuper-key / x-zuper-base). We check that key against Zuper's
// own `user/company` endpoint and scope rows to the company it belongs to — so the
// recycle bin (which holds customer records) and template versions are readable only by
// someone holding an API key for that same Zuper account. The template library and
// reusable blocks are team-wide: any caller with a valid Zuper key can read and write them.
//
// Tables (public schema, RLS on with NO policies → only this function's service role can
// touch them): zdm_template_versions, zdm_recycle_bin, zdm_library, zdm_blocks.
//
// Body: POST {op, ...args}. Ops are listed in OPS below.

import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-zuper-key, x-zuper-base, authorization, apikey, x-client-info",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const BASE_RE = /^https:\/\/[a-z0-9-]+\.zuperpro\.com\/api\/$/;
const MAX_RECORD_BYTES = 1_000_000;
const BIN_KEEP_DAYS = 90;
const VERSIONS_KEEP = 50;

type Account = { key: string; name: string; uid: string; host: string };
const cache = new Map<string, { acct: Account; exp: number }>();

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Who is calling? Resolved from Zuper itself, cached for 10 minutes per key.
async function account(req: Request): Promise<Account> {
  const key = (req.headers.get("x-zuper-key") || "").trim();
  const base = (req.headers.get("x-zuper-base") || "").trim();
  if (!key || !BASE_RE.test(base)) throw new HttpError(401, "Missing or invalid Zuper credentials.");
  const ck = await sha(base + "\n" + key);
  const hit = cache.get(ck);
  if (hit && hit.exp > Date.now()) return hit.acct;
  const r = await fetch(base + "user/company", {
    headers: { "x-api-key": key, "x-zuper-client": "WEB_APP", "x-zuper-client-version": "3.0" },
  });
  if (!r.ok) throw new HttpError(401, "Zuper did not accept this API key (HTTP " + r.status + ").");
  const j = await r.json().catch(() => ({}));
  const d = j?.data ?? j ?? {};
  const c = d.company ?? d;
  const uid = String(c.company_uid ?? d.company_uid ?? c.uid ?? c._id ?? "");
  const name = String(c.company_name ?? d.company_name ?? c.name ?? "");
  const host = new URL(base).host;
  if (!uid && !name) throw new HttpError(401, "Could not identify the Zuper account for this key.");
  const acct = { key: uid ? "uid:" + uid : "name:" + host + "|" + name.toLowerCase(), name, uid, host };
  cache.set(ck, { acct, exp: Date.now() + 600_000 });
  return acct;
}

class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}
const must = <T>(r: { data: T; error: { message: string } | null }) => {
  if (r.error) throw new HttpError(500, r.error.message);
  return r.data;
};
const str = (v: unknown, max = 500) => (v == null ? null : String(v).slice(0, max));

const OPS: Record<string, (a: Account, b: Record<string, any>) => Promise<unknown>> = {
  whoami: async (a) => ({ account_key: a.key, account_name: a.name, host: a.host }),

  // ── Template versions (per account) ──
  "versions.list": async (a, b) =>
    must(await db.from("zdm_template_versions")
      .select("id,kind,template_uid,template_name,template,template_options,saved_by,note,created_at")
      .eq("account_key", a.key).eq("template_uid", str(b.template_uid))
      .order("created_at", { ascending: false }).limit(Math.min(Number(b.limit) || 30, 100))),
  "versions.add": async (a, b) => {
    const tpl = String(b.template ?? "");
    if (!b.template_uid || !tpl) throw new HttpError(400, "template_uid and template are required.");
    if (tpl.length > MAX_RECORD_BYTES) throw new HttpError(413, "Template too large to keep a version of.");
    // Skip a duplicate of the latest version.
    const last = must(await db.from("zdm_template_versions").select("template")
      .eq("account_key", a.key).eq("template_uid", b.template_uid).order("created_at", { ascending: false }).limit(1));
    if (last?.[0]?.template === tpl) return { skipped: true };
    const row = must(await db.from("zdm_template_versions").insert({
      account_key: a.key, account_name: a.name, kind: str(b.kind, 40), template_uid: str(b.template_uid, 80),
      template_name: str(b.template_name), template: tpl, template_options: b.template_options ?? null,
      saved_by: str(b.saved_by, 120), note: str(b.note),
    }).select("id,created_at").single());
    // keep the newest VERSIONS_KEEP per template
    const old = must(await db.from("zdm_template_versions").select("id").eq("account_key", a.key)
      .eq("template_uid", b.template_uid).order("created_at", { ascending: false }).range(VERSIONS_KEEP, VERSIONS_KEEP + 200));
    if (old?.length) must(await db.from("zdm_template_versions").delete().in("id", old.map((x: any) => x.id)));
    return row;
  },

  // ── Recycle bin (per account) ──
  "bin.add": async (a, b) => {
    const items = Array.isArray(b.items) ? b.items.slice(0, 500) : [];
    if (!items.length) return { added: 0 };
    const rows = items.map((it: any) => {
      const rec = it.record ?? {};
      if (JSON.stringify(rec).length > MAX_RECORD_BYTES) throw new HttpError(413, "A record is too large for the recycle bin.");
      return { account_key: a.key, account_name: a.name, module: str(it.module, 60), record_uid: str(it.record_uid, 120),
        label: str(it.label), record: rec, deleted_by: str(b.deleted_by, 120) };
    });
    must(await db.from("zdm_recycle_bin").insert(rows));
    must(await db.from("zdm_recycle_bin").delete().eq("account_key", a.key)
      .lt("deleted_at", new Date(Date.now() - BIN_KEEP_DAYS * 864e5).toISOString()));
    return { added: rows.length };
  },
  "bin.list": async (a, b) => {
    let q = db.from("zdm_recycle_bin").select("id,module,record_uid,label,deleted_by,deleted_at,restored_at,restored_uid")
      .eq("account_key", a.key).order("deleted_at", { ascending: false }).limit(Math.min(Number(b.limit) || 500, 2000));
    if (b.module) q = q.eq("module", b.module);
    return must(await q);
  },
  "bin.get": async (a, b) =>
    must(await db.from("zdm_recycle_bin").select("*").eq("account_key", a.key).in("id", (b.ids ?? [b.id]).slice(0, 500))),
  "bin.restored": async (a, b) =>
    must(await db.from("zdm_recycle_bin").update({ restored_at: new Date().toISOString(), restored_uid: str(b.restored_uid, 120) })
      .eq("account_key", a.key).eq("id", b.id).select("id")),
  "bin.purge": async (a, b) =>
    must(await db.from("zdm_recycle_bin").delete().eq("account_key", a.key).in("id", (b.ids ?? [b.id]).slice(0, 2000)).select("id")),

  // ── Template library (team-wide) ──
  "lib.list": async (_a, b) => {
    let q = db.from("zdm_library").select("id,name,kind,description,tags,created_by,source_account,updated_at").order("name");
    if (b.kind) q = q.eq("kind", b.kind);
    return must(await q);
  },
  "lib.get": async (_a, b) => must(await db.from("zdm_library").select("*").eq("id", b.id).single()),
  "lib.save": async (a, b) => {
    if (!b.name || !b.template) throw new HttpError(400, "name and template are required.");
    const row = { name: str(b.name, 200), kind: str(b.kind, 40), description: str(b.description, 2000), template: String(b.template),
      template_options: b.template_options ?? null, tags: Array.isArray(b.tags) ? b.tags.slice(0, 20).map((t: unknown) => String(t).slice(0, 40)) : [],
      created_by: str(b.created_by, 120), source_account: a.name, updated_at: new Date().toISOString() };
    if (b.id) return must(await db.from("zdm_library").update(row).eq("id", b.id).select("id").single());
    return must(await db.from("zdm_library").insert(row).select("id").single());
  },
  "lib.delete": async (_a, b) => must(await db.from("zdm_library").delete().eq("id", b.id).select("id")),

  // ── Reusable blocks (team-wide) ──
  "blocks.list": async () => must(await db.from("zdm_blocks").select("*").order("name")),
  "blocks.save": async (_a, b) => {
    const name = String(b.name ?? "").trim();
    if (!/^[\w .-]{1,60}$/.test(name)) throw new HttpError(400, "Block names: letters, numbers, spaces, . _ - (max 60).");
    return must(await db.from("zdm_blocks").upsert({ name, html: String(b.html ?? ""), description: str(b.description, 500),
      updated_by: str(b.updated_by, 120), updated_at: new Date().toISOString() }, { onConflict: "name" }).select("name").single());
  },
  "blocks.delete": async (_a, b) => must(await db.from("zdm_blocks").delete().eq("name", b.name).select("name")),
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const fn = OPS[body?.op];
    if (!fn) return json({ error: "Unknown op " + String(body?.op) }, 400);
    const acct = await account(req);
    return json({ data: await fn(acct, body) });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: (e as Error).message || "error" }, status);
  }
});
