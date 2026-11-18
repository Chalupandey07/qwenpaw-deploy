// qwenpaw-routines — Cloudflare Worker (Free tier) for QwenPaw Routines.
//
// WHAT THIS WORKER DOES (and does NOT do):
//  - Cron every 30 min + daily 01:30 UTC (07:00 Asia/Kolkata): wakes the
//    InstaBox Free machine by probing the public QwenPaw URL, so QwenPaw's
//    NATIVE scheduler (APScheduler cron jobs in jobs.json + heartbeat) can
//    actually fire despite the 30-min idle pause. Records each wake in KV.
//    SLEEP-AWARE (2026-11-17): the tick now checks the next routine BEFORE
//    probing, and only probes when a routine is due within 15 minutes (a
//    backup wake for the keep-alive Worker, which owns waking). A blind
//    probe every 30 minutes would wake the machine around the clock and
//    defeat intelligent sleep. When no routine is due, the tick records a
//    "skipped" history entry and does NOT probe.
//  - GET / : status + run-history HTML page (routines registry, recent
//    wake/run log, pending manual triggers).
//  - POST /trigger : manual trigger. It ONLY wakes QwenPaw and records the
//    requested prompt as a PENDING entry in KV. It deliberately does NOT
//    call QwenPaw's /console/chat API and does NOT store the QwenPaw
//    password: delivering a prompt needs a logged-in user token
//    (POST /api/auth/login), and a long-lived user password in a Worker
//    secret would be a standing credential with full console access.
//    Run a pending prompt from the console, or make it a native cron job.
//  - The scheduler of record is QwenPaw's native cron system:
//    POST /api/cron/jobs (see ../native-cron-jobs.example.json). This
//    Worker is the wake + history layer around it, not a second scheduler.
//    Routine definitions carry a structured `cron` + `timezone` (5-field
//    cron, IANA zone) so the next run is computable; a definition without
//    a parseable cron is treated as "due any time" (fail-awake: probe).
//
// Env vars: QWENPAW_URL (public console URL, no trailing path needed)
// KV binding: STATUS (shared with qwenpaw-keepalive; all keys here are
// prefixed "routines:" so they can never collide with keepalive keys).
// Optional secret: ROUTINE_WEBHOOK_TOKEN — when set, POST /api/routines
// (add a routine definition) and POST /trigger (manual trigger) require
// header X-Routine-Token to match. When unset, both return 503 (fail
// closed for writes). No secrets are in this file. Free-tier use: ~49 scheduled invocations
// per day + manual triggers; each does 1 probe fetch. Far under 100k/day.

const PING_TIMEOUT_MS = 20_000;
const HISTORY_KEY = "routines:history"; // JSON array, newest first, max 50
const DEFINITIONS_KEY = "routines:definitions"; // JSON array of routines
const PENDING_PREFIX = "routines:pending:";
const MAX_HISTORY = 50;
const TRIGGER_MIN_GAP_MS = 60_000;
const MAX_PROMPT_CHARS = 2000;
// Pending manual triggers expire after 7 days and are capped at 20
// (fix 2026-11-15, audit finding workers-routines-unauth-trigger: pending
// KV keys never expired and grew without bound).
const PENDING_TTL_SECONDS = 7 * 24 * 3600;
const MAX_PENDING = 20;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Routine-Token",
    },
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Public view of a routine definition. The full definition (including the
// `prompt` text — the user's own automation instructions) is NEVER returned
// on an unauthenticated GET: GET /, GET /api/status and GET /api/routines
// are public by design (status page), so they expose only id/name/schedule/
// state. The token-gated POST /api/routines response still returns the full
// definition to the token holder who just wrote it. (Re-test 2026-11-15,
// RT-001: unauthenticated GETs previously returned full prompt text.)
function publicRoutine(r) {
  if (!r || typeof r !== "object") return r;
  return {
    id: r.id ?? null,
    name: r.name ?? r.id ?? null,
    scheduleNote: r.scheduleNote || "",
    active: r.active !== false,
  };
}

// Public view of a pending manual trigger: id/at/routine/status only —
// never the submitted prompt text (same RT-001 reason as publicRoutine).
function publicPending(p) {
  if (!p || typeof p !== "object") return p;
  return {
    id: p.id ?? null,
    at: p.at ?? "",
    routineId: p.routineId || null,
    status: p.status || "",
    qwenpaw: p.qwenpaw || "",
    httpStatus: p.httpStatus ?? null,
  };
}

async function readJson(env, key, fallback) {
  try {
    const raw = await env.STATUS.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// --- Daily write-budget guard (KV phase, 2026-11-15) --------------------
// Same design as qwenpaw-keepalive (see features/storage/QUOTA-BUDGET.md):
// STATUS cap 250/day, shared with keep-alive through the counter key
// `budget:<YYYY-MM-DD>` (DESKTOP_KV gets 450; 250 + 450 = 700 of the
// 1,000/day account cap). Counting is approximate by design (per-isolate
// in-memory count, flushed only on every 25th local write; KV has no
// CAS). Non-essential writes are dropped once the cap is hit; essential
// writes (user actions) always try.
const BUDGET_CAP = 250;
const BUDGET_FLUSH_EVERY = 25;
const TRIGGER_DAY_CAP = 100;

function makeDailyCounter(kv, prefix, flushEvery) {
  let local = 0, seeded = 0, seededDay = "";
  const today = () => new Date().toISOString().slice(0, 10);
  return {
    async count() {
      const day = today();
      if (seededDay !== day) {
        local = 0; seeded = 0; seededDay = day;
        try {
          const v = await kv.get(prefix + day);
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) seeded = n;
        } catch { /* ignore — guard degrades to the local count only */ }
      }
      return seeded + local;
    },
    note() {
      local++;
      if (local % flushEvery !== 0) return;
      const key = prefix + today();
      kv.get(key).then((cur) => {
        const n = Number(cur);
        const base = Number.isFinite(n) ? n : 0;
        return kv.put(key, String(base + flushEvery));
      }).catch(() => {});
    },
  };
}

let budgetCounter = null;
let triggerCounter = null;
function getBudgetCounter(env) {
  if (!budgetCounter) budgetCounter = makeDailyCounter(env.STATUS, "budget:", BUDGET_FLUSH_EVERY);
  return budgetCounter;
}
function getTriggerCounter(env) {
  if (!triggerCounter) triggerCounter = makeDailyCounter(env.STATUS, "routines:trigger-count:", BUDGET_FLUSH_EVERY);
  return triggerCounter;
}

// A KV put through the budget guard. Returns true when the write landed.
async function budgetGuardedPut(env, key, value, essential = false, options) {
  if (!env.STATUS) return false;
  if (!essential && (await getBudgetCounter(env).count()) >= BUDGET_CAP) return false;
  try {
    await env.STATUS.put(key, value, options);
  } catch {
    return false;
  }
  getBudgetCounter(env).note();
  return true;
}

// A KV delete through the budget guard (deletes count as writes).
async function budgetGuardedDelete(env, key, essential = false) {
  if (!env.STATUS) return false;
  if (!essential && (await getBudgetCounter(env).count()) >= BUDGET_CAP) return false;
  try {
    await env.STATUS.delete(key);
  } catch {
    return false;
  }
  getBudgetCounter(env).note();
  return true;
}

function historySame(a, b) {
  if (!a || !b) return false;
  const keys = ["kind", "cron", "qwenpaw", "httpStatus", "note", "deliveredBy"];
  if (JSON.stringify(a.activeRoutines || []) !== JSON.stringify(b.activeRoutines || [])) return false;
  return keys.every((k) => a[k] === b[k]);
}

async function pushHistory(env, entry) {
  // BUGS.md B-8: this used to GET the 50-entry array, unshift, and PUT the
  // whole thing back. Two ticks close together could drop an entry (the later
  // write clobbers the earlier one) — and this array is the audit trail for
  // routines, so a dropped entry is a runtime that never happened.
  //
  // The fix is append-only: one INSERT per tick, no read of the array. On D1
  // the store exposes `appendHistory` for exactly this. The change-only rule
  // survives, because it only ever needed the NEWEST entry, not the array —
  // one indexed read of one row.
  const store = env.STATUS;
  if (store && typeof store.appendHistory === "function") {
    return store.appendHistory(entry, MAX_HISTORY);
  }
  // KV fallback: no atomic append exists, so read-modify-write is all that is
  // possible. Documented as best-effort rather than silently trusted.
  const hist = await readJson(env, HISTORY_KEY, []);
  if (historySame(hist[0], entry)) return false;
  hist.unshift(entry);
  return budgetGuardedPut(env, HISTORY_KEY, JSON.stringify(hist.slice(0, MAX_HISTORY)));
}

// Probe the public QwenPaw URL. 200/401 = console answering (401 is the
// auth gate, i.e. the app is up). 503 = InstaBox waking/paused. Anything
// else / fetch failure = offline. Never follows redirects.
async function probeQwenPaw(env) {
  const url = env.QWENPAW_URL;
  if (!url) return { status: "misconfigured", httpStatus: 0, note: "QWENPAW_URL is not set" };
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      headers: { "User-Agent": "qwenpaw-routines/1.0 (+cloudflare-worker-cron)" },
    });
  } catch (err) {
    return { status: "offline", httpStatus: 0, note: `fetch failed: ${err?.name || "error"}` };
  }
  const httpStatus = res.status;
  await res.body?.cancel().catch(() => {});
  if ((httpStatus >= 200 && httpStatus < 400) || httpStatus === 401) {
    return { status: "up", httpStatus, note: "QwenPaw console answered" };
  }
  if (httpStatus === 503) {
    return { status: "waking", httpStatus, note: "InstaBox waking/paused (503); keepalive retries every 5 min; native cron jobs have a 600s misfire grace" };
  }
  return { status: "unexpected", httpStatus, note: `unexpected HTTP ${httpStatus}` };
}

// --- cron next-run (sleep/wake, 2026-11-17) ------------------------------
// Inlined copy of the keep-alive Worker's nextRun (worker/src/index.js is
// the canonical copy; this Worker is also a single-file API upload with no
// bundler, so the logic is duplicated, not imported). Same contract:
// 5-field cron, IANA timezone, next run strictly after fromMs. Never
// assumes a constant offset — it asks Intl for local fields at each
// candidate minute, so it stays correct on DST zones too.
const RT_MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RT_DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function rtCronToken(s, names, base) {
  s = String(s).toLowerCase();
  const i = names ? names.indexOf(s) : -1;
  return i >= 0 ? i + base : Number(s);
}

function rtParseCronField(expr, min, max, names, base) {
  const set = new Set();
  for (const part of String(expr).trim().split(",")) {
    const [spec, stepStr] = part.split("/");
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!(step >= 1)) throw new Error("bad step: " + part);
    let lo, hi;
    if (spec === "*") { lo = min; hi = max; }
    else if (spec.includes("-")) {
      const [a, b] = spec.split("-");
      lo = rtCronToken(a, names, base); hi = rtCronToken(b, names, base);
    } else {
      lo = rtCronToken(spec, names, base);
      hi = stepStr === undefined ? lo : max;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
      throw new Error("bad cron field: " + part);
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

function rtNextRun(cronExpr, timezone, fromMs) {
  const f = String(cronExpr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error("5-field cron required");
  const [minF, hourF, domF, monF, dowF] = f;
  const minutes = rtParseCronField(minF, 0, 59, null, 0);
  const hours = rtParseCronField(hourF, 0, 23, null, 0);
  const doms = rtParseCronField(domF, 1, 31, null, 0);
  const dows = rtParseCronField(dowF, 0, 6, RT_DOW_NAMES, 0);
  const months = rtParseCronField(monF, 1, 12, RT_MONTH_NAMES, 1);
  if (dows.has(7)) { dows.add(0); dows.delete(7); }
  const domStar = domF.trim().startsWith("*");
  const dowStar = dowF.trim().startsWith("*");
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false,
    month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", weekday: "short",
  });
  const partsOf = (ms) => {
    const o = {};
    for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
    return o;
  };
  let t = Math.floor(fromMs / 60000) * 60000 + 60000;
  const limit = t + 366 * 24 * 60 * 60000;
  while (t <= limit) {
    const p = partsOf(t);
    const minute = Number(p.minute);
    const hour = Number(p.hour) % 24;
    const dom = Number(p.day);
    const mon = Number(p.month);
    const dow = RT_DOW_NAMES.indexOf(String(p.weekday).toLowerCase());
    const domOk = doms.has(dom);
    const dowOk = dows.has(dow);
    const dayOk = (domStar || dowStar) ? (domOk && dowOk) : (domOk || dowOk);
    if (months.has(mon) && dayOk && hours.has(hour) && minutes.has(minute)) return t;
    t += 60000;
  }
  throw new Error("no match within 1 year");
}

// Earliest next run across active definitions, or null when it cannot be
// determined (a definition without a parseable cron). Infinity when there
// are definitively no active routines.
function rtNextRoutine(defs, now = Date.now()) {
  let best = Infinity;
  for (const def of (defs || [])) {
    if (!def || def.active === false) continue;
    if (!def.cron || typeof def.cron !== "string") return null; // unknown -> fail-awake
    try {
      const at = rtNextRun(def.cron, def.timezone || "Asia/Kolkata", now);
      if (at < best) best = at;
    } catch { return null; }
  }
  return best;
}

// One scheduled tick: wake + log. `cron` is the trigger expression, so the
// daily 01:30 UTC slot is distinguishable from the 30-min ticks.
async function scheduledTick(env, ctx, cron) {
  const defs = await readJson(env, DEFINITIONS_KEY, []);
  const active = defs.filter((r) => r && r.active);
  const now = Date.now();
  // SLEEP-AWARE (2026-11-17): do NOT probe blindly. The keep-alive Worker
  // owns waking (it wakes 5 min before a routine); this tick is only a
  // backup wake. Probe only when a routine is due within 15 minutes, or
  // when the next run is UNKNOWN (a definition without a parseable cron —
  // fail-awake, the old behaviour). Otherwise record a skip and stay quiet
  // so the machine can sleep. EXCEPTION (2026-11-18): the daily-summary
  // slot ("30 1 * * *") always probes — at slot time the next-run pointer
  // has already rolled to tomorrow, so the 15-min rule would skip the one
  // backup wake that matters (verified live 2026-11-18 07:00 IST).
  const next = rtNextRoutine(active, now);
  const WAKE_WINDOW_MS = 15 * 60_000;
  // DAILY-SUMMARY SLOT EXCEPTION (2026-11-18): the "30 1 * * *" slot fires
  // AT the routine time, but by then rtNextRoutine has already rolled to
  // tomorrow, so the pointer says "nothing due for ~24h" and this branch
  // would skip the probe — a silent miss if the keep-alive wake failed
  // (verified live 2026-11-18 07:00 IST: both the 07:00:12 wake-tick and
  // the 07:00:27 daily-summary-slot recorded "skipped"). The slot is the
  // backup wake for the one routine that matters today, so it always
  // probes. Cost: one probe/day. The 30-min wake-ticks keep skipping, so
  // sleep is unaffected. The no-active-routines skip below still applies.
  const isDailySummarySlot = cron === "30 1 * * *";
  if (!isDailySummarySlot && next !== null && next !== Infinity && next - now > WAKE_WINDOW_MS) {
    const entry = {
      at: new Date().toISOString(),
      kind: cron === "30 1 * * *" ? "daily-summary-slot" : "wake-tick",
      cron: cron || null,
      qwenpaw: "skipped",
      httpStatus: 0,
      note: `No routine due within 15 min (next ${new Date(next).toISOString()}); skipped the probe so the machine can sleep.`,
      activeRoutines: active.map((r) => r.id),
      deliveredBy: "none — skipped (sleep-aware)",
    };
    ctx.waitUntil(pushHistory(env, entry));
    return entry;
  }
  if (next === Infinity) {
    const entry = {
      at: new Date().toISOString(),
      kind: cron === "30 1 * * *" ? "daily-summary-slot" : "wake-tick",
      cron: cron || null,
      qwenpaw: "skipped",
      httpStatus: 0,
      note: "No active routines; skipped the probe so the machine can sleep.",
      activeRoutines: [],
      deliveredBy: "none — skipped (sleep-aware)",
    };
    ctx.waitUntil(pushHistory(env, entry));
    return entry;
  }
  const probe = await probeQwenPaw(env);
  const entry = {
    at: new Date().toISOString(),
    kind: cron === "30 1 * * *" ? "daily-summary-slot" : "wake-tick",
    cron: cron || null,
    qwenpaw: probe.status,
    httpStatus: probe.httpStatus,
    note: probe.note,
    activeRoutines: active.map((r) => r.id),
    // The Worker wakes; the native cron jobs do the work. If QwenPaw is
    // up, any due native job runs in-process on the machine.
    deliveredBy: "native qwenpaw cron jobs (jobs.json) / heartbeat",
  };
  ctx.waitUntil(pushHistory(env, entry));
  return entry;
}

function statusPage(defs, hist, pending, qwenpawUrl) {
  const rows = hist.map((h) => `<tr><td>${esc(h.at)}</td><td>${esc(h.kind)}</td><td>${esc(h.qwenpaw)} (${esc(h.httpStatus)})</td><td>${esc(h.note || "")}</td><td>${esc((h.activeRoutines || []).join(", "))}</td></tr>`).join("");
  // RT-001: prompt text is never rendered on this public page. The Prompt
  // column was removed (was: esc(r.prompt)); the owner reads prompts from
  // KV (routines:definitions), never from the public status page.
  const defRows = defs.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.name)}</td><td>${esc(r.scheduleNote || "")}</td><td>${esc(r.active ? "active" : "paused")}</td></tr>`).join("");
  const pendRows = pending.map((p) => `<tr><td>${esc(p.at)}</td><td>${esc(p.routineId || "-")}</td><td>${esc(p.status)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QwenPaw Routines</title><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2em auto;padding:0 1em}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 8px;text-align:left;font-size:14px}code{background:#f2f2f2;padding:1px 4px}</style></head><body>
<h1>QwenPaw Routines</h1>
<p>Wake + history layer for QwenPaw on InstaBox Free. The scheduler of record is QwenPaw's <b>native cron system</b> (<code>POST /api/cron/jobs</code>, stored in <code>jobs.json</code> v2). This Worker wakes the machine every 30 min and at 07:00 IST daily so native jobs can fire despite the 30-min idle pause.</p>
<p>Console: <a href="${esc(qwenpawUrl)}">${esc(qwenpawUrl)}</a> &middot; <a href="/api/status">JSON status</a> &middot; <a href="/api/history">JSON history</a></p>
<h2>Routines (registry in KV, key <code>routines:definitions</code>)</h2>
<table><tr><th>ID</th><th>Name</th><th>Schedule</th><th>State</th></tr>${defRows || "<tr><td colspan=4>No routines defined yet.</td></tr>"}</table>
<h2>Pending manual triggers</h2>
<table><tr><th>At</th><th>Routine</th><th>Status</th></tr>${pendRows || "<tr><td colspan=3>None pending.</td></tr>"}</table>
<p>Pending prompts are <b>not</b> delivered automatically: this Worker holds no QwenPaw login. Paste the prompt in the console, or turn it into a native cron job (see the repo README).</p>
<h2>Recent wake ticks (newest first)</h2>
<table><tr><th>At (UTC)</th><th>Kind</th><th>QwenPaw</th><th>Note</th><th>Active routines</th></tr>${rows || "<tr><td colspan=5>No ticks recorded yet.</td></tr>"}</table>
</body></html>`;
}

async function listPending(env) {
  const list = await env.STATUS.list({ prefix: PENDING_PREFIX });
  const out = [];
  for (const k of list.keys) {
    const v = await readJson(env, k.name, null);
    if (v) out.push(v);
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20);
}

// Drop all but the newest MAX_PENDING pending entries, so unauthenticated
// (or buggy) triggers can never grow the pending set without bound.
async function prunePending(env) {
  const list = await env.STATUS.list({ prefix: PENDING_PREFIX });
  if (list.keys.length <= MAX_PENDING) return;
  const entries = [];
  for (const k of list.keys) {
    const v = await readJson(env, k.name, null);
    if (v) entries.push({ key: k.name, at: v.at || "" });
  }
  entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  for (const e of entries.slice(MAX_PENDING)) await budgetGuardedDelete(env, e.key);
}

// --- D1 store (inlined from features/storage/store.js) ----------------
// Canonical copy: features/storage/store.js (harness-tested there).
// Pages _worker.js and the API-uploaded standalone Workers are single
// files with no bundler, so the store is inlined here; keep the two in
// sync. D1 when env.USE_D1 === "1" and env.QWENPAW_DB is bound,
// otherwise the KV binding — same get/put/delete/list interface.
// D1-backed store with a KV-shaped interface.
//
// createStore(env, kv) returns { get, put, delete, list } with the same
// shapes the Workers already use against a KVNamespace, so call sites
// change only the binding source (env.DESKTOP_KV / env.STATUS ->
// store(env)) and no handler logic changes.
//
// Backend selection: D1 when env.USE_D1 === "1" AND env.QWENPAW_DB is
// bound; otherwise the KV namespace passed in (the fallback). The
// routing table is features/storage/SCHEMA.md.
//
// Notes:
// - Previews are base64 strings at this interface (call sites
//   unchanged); the store decodes to raw bytes for the D1 BLOB column
//   and encodes back on read.
// - routines:history put is a DIFF, not a full replace: the caller
//   only ever appends one tick, so the store inserts the entries
//   newer than the stored max `at` and prunes to 50 rows. A full
//   replace would be 51 statements for a 50-entry history and would
//   exceed D1's 50-queries-per-invocation free limit.
// - routines:pending reads enforce expiry (D1 has no TTL): rows with
//   expires_at <= now are treated as missing and deleted lazily.
// - Unknown keys fall through to the `meta` table (plain text), so a
//   future key works without a schema change.
// - The budget counter is a plain upsert of the value the guard
//   computed (the guard already bounds flushes); an atomic SQL
//   increment is a follow-up (see SCHEMA.md).

function createStore(env, kv) {
  const useD1 = env && env.USE_D1 === "1" && env.QWENPAW_DB;
  if (!useD1) {
    // No store at all (KV unbound and no D1): return null so callers
    // that check for a bound store keep their 503 path.
    if (!kv) return null;
    return kvStore(kv);
  }
  return d1Store(env.QWENPAW_DB);
}

function kvStore(kv) {
  return {
    get: async (key, type) => {
      const v = await kv.get(key);
      if (type === "json") {
        if (v === null || v === undefined) return null;
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    put: (key, value, opts) => kv.put(key, value, opts),
    delete: (key) => kv.delete(key),
    list: (opts) => kv.list(opts),
  };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function splitKey(key) {
  const i = key.indexOf(":");
  return i === -1 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
}

function d1Store(db) {
  const q = (sql, ...params) => db.prepare(sql).bind(...params);
  async function get(key, type) {
    const v = await getText(key);
    if (type === "json") {
      if (v === null || v === undefined) return null;
      try { return JSON.parse(v); } catch { return null; }
    }
    return v;
  }

  async function getText(key) {
    const [head, rest] = splitKey(key);
    if (head === "lease") {
      const row = await q("SELECT lease_id, holder, granted_at, expires_at, fence FROM leases WHERE computer = ?", rest).first();
      return row ? JSON.stringify({ leaseId: row.lease_id, holder: row.holder, grantedAt: row.granted_at, expiresAt: row.expires_at, fence: row.fence }) : null;
    }
    if (head === "generation") {
      const row = await q("SELECT gen FROM generations WHERE computer = ?", rest).first();
      return row ? String(row.gen) : null;
    }
    if (head === "needsyou") {
      const computer = rest || "default";
      const row = await q("SELECT text, at, run_id FROM needs_you WHERE computer = ?", computer).first();
      return row ? JSON.stringify({ text: row.text, at: row.at, runId: row.run_id }) : null;
    }
    if (head === "preview") {
      const row = await q("SELECT png FROM previews WHERE computer = ?", rest).first();
      return row && row.png ? bytesToB64(row.png) : null;
    }
    if (head === "teach-skill") {
      const row = await q("SELECT payload FROM teach_skills WHERE id = ?", rest).first();
      return row ? row.payload : null;
    }
    if (head === "computerMode") {
      const row = await q("SELECT mode FROM modes WHERE agent = ?", rest).first();
      return row ? row.mode : null;
    }
    if (head === "budget") {
      const row = await q("SELECT count FROM write_budget WHERE day = ?", rest).first();
      return row ? String(row.count) : null;
    }
    if (key === "lastWake" || key === "routines:last-trigger-at") {
      const row = await q("SELECT value FROM meta WHERE key = ?", key).first();
      return row ? row.value : null;
    }
    if (key === "qwenpaw:status") {
      const row = await q("SELECT value FROM status WHERE key = ?", key).first();
      return row ? row.value : null;
    }
    if (key === "routines:history") {
      const res = await q("SELECT raw FROM routines_history ORDER BY id ASC").all();
      const entries = (res.results || []).map((r) => {
        try { return JSON.parse(r.raw); } catch { return null; }
      }).filter(Boolean);
      return JSON.stringify(entries);
    }
    if (key === "routines:definitions") {
      const res = await q("SELECT payload FROM routines_definitions").all();
      const defs = (res.results || []).map((r) => {
        try { return JSON.parse(r.payload); } catch { return null; }
      }).filter(Boolean);
      return JSON.stringify(defs);
    }
    if (head === "routines" && rest.startsWith("pending:")) {
      const id = rest.slice("pending:".length);
      const now = Math.floor(Date.now() / 1000);
      const row = await q("SELECT payload FROM routines_pending WHERE id = ? AND expires_at > ?", id, now).first();
      if (!row) {
        // Lazily drop the expired row (D1 has no TTL).
        await q("DELETE FROM routines_pending WHERE id = ? AND expires_at <= ?", id, now).run();
        return null;
      }
      return row.payload;
    }
    // Unknown key: generic text fallback in meta.
    const row = await q("SELECT value FROM meta WHERE key = ?", key).first();
    return row ? row.value : null;
  }

  async function put(key, value, opts) {
    const [head, rest] = splitKey(key);
    if (head === "lease") {
      const v = typeof value === "string" ? JSON.parse(value) : value;
      await q("INSERT INTO leases (computer, lease_id, holder, granted_at, expires_at, fence) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(computer) DO UPDATE SET lease_id=excluded.lease_id, holder=excluded.holder, granted_at=excluded.granted_at, expires_at=excluded.expires_at, fence=excluded.fence",
        rest, v.leaseId, v.holder, v.grantedAt, v.expiresAt, v.fence || 0).run();
      return;
    }
    if (head === "generation") {
      await q("INSERT INTO generations (computer, gen) VALUES (?, ?) ON CONFLICT(computer) DO UPDATE SET gen=excluded.gen", rest, parseInt(value, 10) || 0).run();
      return;
    }
    if (head === "needsyou") {
      const computer = rest || "default";
      const v = typeof value === "string" ? JSON.parse(value) : value;
      await q("INSERT INTO needs_you (computer, text, at, run_id) VALUES (?, ?, ?, ?) ON CONFLICT(computer) DO UPDATE SET text=excluded.text, at=excluded.at, run_id=excluded.run_id",
        computer, v.text, v.at, v.runId || null).run();
      return;
    }
    if (head === "preview") {
      // value is a base64 string at this interface; store raw bytes.
      const bytes = b64ToBytes(value);
      await q("INSERT INTO previews (computer, png, updated_at) VALUES (?, ?, ?) ON CONFLICT(computer) DO UPDATE SET png=excluded.png, updated_at=excluded.updated_at",
        rest, bytes, new Date().toISOString()).run();
      return;
    }
    if (head === "teach-skill") {
      const v = typeof value === "string" ? JSON.parse(value) : value;
      await q("INSERT INTO teach_skills (id, payload, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at",
        rest, typeof value === "string" ? value : JSON.stringify(value), v.at || new Date().toISOString()).run();
      return;
    }
    if (head === "computerMode") {
      await q("INSERT INTO modes (agent, mode) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET mode=excluded.mode", rest, String(value)).run();
      return;
    }
    if (head === "budget") {
      await q("INSERT INTO write_budget (day, count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET count=excluded.count", rest, parseInt(value, 10) || 0).run();
      return;
    }
    if (key === "lastWake" || key === "routines:last-trigger-at") {
      await q("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(value)).run();
      return;
    }
    if (key === "qwenpaw:status") {
      await q("INSERT INTO status (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, typeof value === "string" ? value : JSON.stringify(value)).run();
      return;
    }
    if (key === "routines:history") {
      const entries = typeof value === "string" ? JSON.parse(value) : value;
      // Diff, not full replace (see the header note): insert only the
      // entries newer than the stored max `at`, then prune to 50.
      const latest = await q("SELECT MAX(at) AS m FROM routines_history").first();
      const maxAt = latest && latest.m ? latest.m : "";
      const fresh = entries.filter((e) => e && e.at && e.at > maxAt);
      if (fresh.length) {
        const stmts = fresh.map((e) => q(
          "INSERT INTO routines_history (at, kind, qwenpaw, http_status, note, active_routines, raw) VALUES (?, ?, ?, ?, ?, ?, ?)",
          e.at, e.kind, e.qwenpaw, e.httpStatus ?? null, e.note ?? null, JSON.stringify(e.activeRoutines || []), JSON.stringify(e)));
        await db.batch(stmts);
      }
      await q("DELETE FROM routines_history WHERE id NOT IN (SELECT id FROM routines_history ORDER BY id DESC LIMIT 50)").run();
      return;
    }
    if (key === "routines:definitions") {
      const defs = typeof value === "string" ? JSON.parse(value) : value;
      const stmts = [q("DELETE FROM routines_definitions")];
      for (const r of defs) stmts.push(q("INSERT INTO routines_definitions (id, payload) VALUES (?, ?)", r.id, JSON.stringify(r)));
      await db.batch(stmts);
      return;
    }
    if (head === "routines" && rest.startsWith("pending:")) {
      const id = rest.slice("pending:".length);
      const ttl = (opts && opts.expirationTtl) || 7 * 86400;
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      await q("INSERT INTO routines_pending (id, payload, expires_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at",
        id, typeof value === "string" ? value : JSON.stringify(value), expiresAt).run();
      return;
    }
    // Unknown key: generic text fallback in meta.
    await q("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(value)).run();
  }

  async function del(key) {
    const [head, rest] = splitKey(key);
    if (head === "lease") { await q("DELETE FROM leases WHERE computer = ?", rest).run(); return; }
    if (head === "generation") { await q("DELETE FROM generations WHERE computer = ?", rest).run(); return; }
    if (head === "needsyou") { await q("DELETE FROM needs_you WHERE computer = ?", rest || "default").run(); return; }
    if (head === "preview") { await q("DELETE FROM previews WHERE computer = ?", rest).run(); return; }
    if (head === "teach-skill") { await q("DELETE FROM teach_skills WHERE id = ?", rest).run(); return; }
    if (head === "computerMode") { await q("DELETE FROM modes WHERE agent = ?", rest).run(); return; }
    if (head === "budget") { await q("DELETE FROM write_budget WHERE day = ?", rest).run(); return; }
    if (key === "lastWake" || key === "routines:last-trigger-at") { await q("DELETE FROM meta WHERE key = ?", key).run(); return; }
    if (key === "qwenpaw:status") { await q("DELETE FROM status WHERE key = ?", key).run(); return; }
    if (key === "routines:history") { await q("DELETE FROM routines_history").run(); return; }
    if (key === "routines:definitions") { await q("DELETE FROM routines_definitions").run(); return; }
    if (head === "routines" && rest.startsWith("pending:")) { await q("DELETE FROM routines_pending WHERE id = ?", rest.slice("pending:".length)).run(); return; }
    await q("DELETE FROM meta WHERE key = ?", key).run();
  }

  async function list(opts) {
    const prefix = (opts && opts.prefix) || "";
    if (prefix === "teach-skill:") {
      const res = await q("SELECT id FROM teach_skills").all();
      return { keys: (res.results || []).map((r) => ({ name: "teach-skill:" + r.id })) };
    }
    if (prefix === "routines:pending:") {
      const now = Math.floor(Date.now() / 1000);
      const res = await q("SELECT id FROM routines_pending WHERE expires_at > ?", now).all();
      return { keys: (res.results || []).map((r) => ({ name: "routines:pending:" + r.id })) };
    }
    const res = await q("SELECT key FROM meta WHERE key LIKE ? || '%'", prefix).all();
    return { keys: (res.results || []).map((r) => ({ name: r.key })) };
  }

  // Append-only history (BUGS.md B-8). Canonical copy with the same method in
  // features/storage/store.js — this file is a single-file Worker with no
  // bundler, so the store is inlined; keep the two in sync.
  //
  // One INSERT per tick instead of "read 50 rows, unshift, write 50 rows".
  // The old shape lost an entry whenever two ticks landed close together,
  // which for a routines AUDIT TRAIL means a run that never happened.
  async function appendHistory(entry, keep = MAX_HISTORY) {
    if (!entry || typeof entry.at !== "string") return 0;
    // Change-only, preserved exactly: compare the newest row only, which is
    // all `historySame(hist[0], entry)` ever looked at. One row read rather
    // than fifty.
    const newest = await q("SELECT raw FROM routines_history ORDER BY id DESC LIMIT 1").first();
    if (newest && newest.raw) {
      let prev = null;
      try { prev = JSON.parse(newest.raw); } catch { prev = null; }
      if (prev && historySame(prev, entry)) return 0;
    }
    await q(
      "INSERT INTO routines_history (at, kind, qwenpaw, http_status, note, active_routines, raw) VALUES (?, ?, ?, ?, ?, ?, ?)",
      entry.at, entry.kind ?? "wake-tick", entry.qwenpaw ?? "unknown",
      entry.httpStatus ?? null, entry.note ?? null,
      JSON.stringify(entry.activeRoutines || []), JSON.stringify(entry),
    ).run();
    await q(
      `DELETE FROM routines_history WHERE id <= (
         SELECT id FROM routines_history ORDER BY id DESC LIMIT 1 OFFSET ?
       )`,
      keep,
    ).run();
    return 1;
  }

  return { get, put, delete: del, list, appendHistory };
}

export default {
  async fetch(request, env, ctx) {
    env = { ...env, STATUS: createStore(env, env.STATUS) };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({ ok: true }, 204);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const defs = await readJson(env, DEFINITIONS_KEY, []);
      const hist = await readJson(env, HISTORY_KEY, []);
      const pending = (await listPending(env)).map(publicPending);
      return new Response(statusPage(defs, hist, pending, env.QWENPAW_URL || ""), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      const probe = await probeQwenPaw(env);
      const defs = await readJson(env, DEFINITIONS_KEY, []);
      return json({
        worker: "qwenpaw-routines", qwenpaw: probe,
        routines: defs.map(publicRoutine), schedulerOfRecord: "qwenpaw native cron (POST /api/cron/jobs, jobs.json v2)",
        note: "This Worker wakes QwenPaw and records history. It does not deliver prompts (no QwenPaw login stored).",
      });
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      return json({ history: await readJson(env, HISTORY_KEY, []) });
    }

    if (url.pathname === "/api/routines" && request.method === "GET") {
      return json({ routines: (await readJson(env, DEFINITIONS_KEY, [])).map(publicRoutine) });
    }

    // Add/replace one routine definition. Fail closed: if no webhook token
    // secret is configured, writes are refused (use the Cloudflare API /
    // wrangler kv:key put with the account credential instead).
    if (url.pathname === "/api/routines" && request.method === "POST") {
      if (!env.ROUTINE_WEBHOOK_TOKEN) {
        return json({ error: "routine writes disabled: ROUTINE_WEBHOOK_TOKEN secret is not set. Add routines via KV key routines:definitions using the Cloudflare account credential (see repo README)." }, 503);
      }
      if (request.headers.get("X-Routine-Token") !== env.ROUTINE_WEBHOOK_TOKEN) {
        return json({ error: "unauthorized" }, 401);
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      if (!body || typeof body.id !== "string" || typeof body.prompt !== "string" || !body.id.trim() || !body.prompt.trim()) {
        return json({ error: "routine needs string id and prompt" }, 400);
      }
      const defs = await readJson(env, DEFINITIONS_KEY, []);
      const next = defs.filter((r) => r.id !== body.id);
      // Structured schedule (sleep/wake, 2026-11-17): a routine carries a
      // 5-field cron + IANA timezone so the next run is computable by the
      // keep-alive Worker (wake 5 min before) and by this Worker's tick
      // (backup wake). Both are validated here — an unparseable cron is a
      // 400, not a silent "unknown" that would force fail-awake probing.
      let cron = null;
      let timezone = "Asia/Kolkata";
      if (body.cron !== undefined && body.cron !== null && String(body.cron).trim() !== "") {
        cron = String(body.cron).trim();
        try { rtNextRun(cron, typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : timezone, Date.now()); }
        catch (e) { return json({ error: "invalid cron", detail: String(e).slice(0, 200) }, 400); }
      }
      if (typeof body.timezone === "string" && body.timezone.trim()) {
        timezone = body.timezone.trim();
        try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); }
        catch { return json({ error: "invalid timezone", detail: timezone.slice(0, 100) }, 400); }
      }
      next.push({ id: body.id, name: body.name || body.id, prompt: body.prompt.slice(0, MAX_PROMPT_CHARS), scheduleNote: body.scheduleNote || "", cron, timezone, active: body.active !== false, updatedAt: new Date().toISOString() });
      // Essential (token-gated user action, rare) but counted; a refused
      // write is reported, not silently swallowed.
      if (!(await budgetGuardedPut(env, DEFINITIONS_KEY, JSON.stringify(next), true))) {
        return json({ error: "store_unavailable", note: "The store refused the write — the free tier's daily write budget is likely spent (it resets daily)." }, 503);
      }
      return json({ ok: true, routines: next });
    }

    // Manual trigger: wake QwenPaw + record a PENDING prompt. Rate-limited
    // to one per minute (KV timestamp). Never executes anything in QwenPaw.
    // Gated (fix 2026-11-15, audit finding workers-routines-unauth-trigger):
    // unauthenticated POST /trigger queued stored prompts, forced wake
    // probes, and wrote never-expiring KV keys. Fail closed when the
    // ROUTINE_WEBHOOK_TOKEN secret is unset; header X-Routine-Token only
    // (never a ?token= query — tokens in URLs leak in logs/Referer).
    if (url.pathname === "/trigger" && request.method === "POST") {
      if (!env.ROUTINE_WEBHOOK_TOKEN) {
        return json({ error: "manual triggers disabled: ROUTINE_WEBHOOK_TOKEN secret is not set" }, 503);
      }
      if (request.headers.get("X-Routine-Token") !== env.ROUTINE_WEBHOOK_TOKEN) {
        return json({ error: "unauthorized" }, 401);
      }
      let body = {};
      try { body = await request.json(); } catch { /* empty body is fine */ }
      const last = await env.STATUS.get("routines:last-trigger-at");
      const now = Date.now();
      if (last && now - Number(last) < TRIGGER_MIN_GAP_MS) {
        return json({ error: "rate limited: one manual trigger per minute" }, 429);
      }
      // Daily trigger cap (soft, approximate — same per-isolate counter
      // design as the budget guard): 100 triggers/day = 300 writes max.
      if ((await getTriggerCounter(env).count()) >= TRIGGER_DAY_CAP) {
        return json({ error: "rate limited: daily manual-trigger cap reached (100/day)" }, 429);
      }
      const probe = await probeQwenPaw(env);
      const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, MAX_PROMPT_CHARS) : "";
      const id = `trig-${now}`;
      const entry = {
        id, at: new Date().toISOString(), routineId: body.routine_id || null,
        prompt, status: "pending", qwenpaw: probe.status, httpStatus: probe.httpStatus,
        note: "Recorded only. Run this prompt in the QwenPaw console, or create a native cron job for it. This Worker holds no QwenPaw login and cannot deliver prompts.",
      };
      // Essential (token-gated user action) — but if the write is refused
      // the trigger is NOT recorded, so answer 503 instead of claiming 202.
      const recorded = await budgetGuardedPut(env, PENDING_PREFIX + id, JSON.stringify(entry), true, { expirationTtl: PENDING_TTL_SECONDS });
      if (!recorded) return json({ error: "store_unavailable", note: "The store refused the write — the free tier's daily write budget is likely spent (it resets daily)." }, 503);
      getTriggerCounter(env).note();
      await budgetGuardedPut(env, "routines:last-trigger-at", String(now), true);
      await prunePending(env);
      await pushHistory(env, { at: entry.at, kind: "manual-trigger", cron: null, qwenpaw: probe.status, httpStatus: probe.httpStatus, note: `manual trigger ${id} recorded as pending`, activeRoutines: [], deliveredBy: "none — pending, needs console / native cron job" });
      return json({ ok: true, pending: entry }, 202);
    }

    return json({ error: "not found", routes: ["GET /", "GET /api/status", "GET /api/history", "GET /api/routines", "POST /api/routines (token-gated)", "POST /trigger"] }, 404);
  },

  async scheduled(event, env, ctx) {
    env = { ...env, STATUS: createStore(env, env.STATUS) };
    await scheduledTick(env, ctx, event.cron);
  },
};
