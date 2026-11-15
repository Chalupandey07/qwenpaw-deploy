// qwenpaw-keepalive — Cloudflare Worker (Free): cron keep-alive + status API
// for QwenPaw on InstaBox Free. No secrets in this file.
// Env vars: QWENPAW_URL, INSTABOX_MACHINE_ID
// Secrets (optional): PORT_TOKEN (private port only), INSTABOX_API_KEY (API-wake fallback)
// Secret (required for /wake): WAKE_TOKEN — POST /wake requires header
// X-Wake-Token to match; when unset, /wake returns 503 (fail closed).
// GET /ping stays the public wake path: it probes the public console URL,
// which wakes a paused box on request by InstaBox design — the Pages
// status page and the activity-feed Wake button use /ping, never /wake.
// KV binding: STATUS

const PING_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 60_000;
const WAKE_MIN_GAP_MS = 10 * 60_000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Wake-Token",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function pingHeaders(env) {
  const h = { "User-Agent": "qwenpaw-keepalive/1.0 (+cloudflare-worker-cron)" };
  if (env.PORT_TOKEN) h["Authorization"] = `Bearer ${env.PORT_TOKEN}`;
  return h;
}

async function readSmallText(res, max = 2048) {
  try {
    const t = await res.text();
    return t.slice(0, max);
  } catch {
    return "";
  }
}

function parseRetryAfter(res, bodyText) {
  const header = res.headers.get("Retry-After");
  if (header && /^\d+$/.test(header.trim())) return Number(header.trim());
  try {
    const j = JSON.parse(bodyText || "{}");
    const s = j?.error?.retryAfterSeconds ?? j?.retryAfterSeconds;
    if (typeof s === "number") return s;
  } catch { /* not JSON */ }
  return null;
}

function parseErrorCode(bodyText) {
  try {
    return JSON.parse(bodyText || "{}")?.error?.code ?? null;
  } catch {
    return null;
  }
}

async function probeQwenPaw(env, { allowRetry = true } = {}) {
  const url = env.QWENPAW_URL;
  if (!url) return { status: "misconfigured", httpStatus: 0, note: "QWENPAW_URL is not set" };

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: pingHeaders(env),
        redirect: "manual",
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
    } catch (err) {
      // Transient network error (DNS/TLS/reset on the way to InstaBox):
      // retry once like the 503 path does, so a single blip does not
      // flip the status to offline and does not trigger a needless
      // API wake. Live /status?live=1 passes allowRetry=false, so it
      // still answers fast without retrying.
      if (allowRetry && attempt === 1) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return { status: "offline", httpStatus: 0, note: `fetch failed (attempt ${attempt}): ${err?.name || "error"}` };
    }

    const httpStatus = res.status;
    if ((httpStatus >= 200 && httpStatus < 400) || httpStatus === 401) {
      await res.body?.cancel().catch(() => {});
      return { status: "up", httpStatus, note: "QwenPaw console answered" };
    }
    if (httpStatus === 503) {
      const body = await readSmallText(res);
      const retryAfter = parseRetryAfter(res, body);
      if (allowRetry && attempt === 1) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return { status: "waking", httpStatus, retryAfterSeconds: retryAfter, note: "InstaBox is waking the machine (503 Sandbox is waking up)" };
    }
    if (httpStatus === 409) {
      const body = await readSmallText(res);
      const code = parseErrorCode(body);
      const retryAfter = parseRetryAfter(res, body);
      return {
        status: code === "machine_cooldown" ? "cooldown" : "conflict",
        httpStatus, errorCode: code, retryAfterSeconds: retryAfter,
        note: code === "machine_cooldown"
          ? "Max-run cooldown — every wake is refused until it ends. Wait."
          : "Another operation is running (409 operation_conflict). Retry later.",
      };
    }
    const body = await readSmallText(res);
    return { status: "degraded", httpStatus, note: body || `Unexpected HTTP ${httpStatus}` };
  }
  return { status: "unknown", httpStatus: 0, note: "probe exhausted" };
}

async function loadStatus(env) {
  if (!env.STATUS) return null;
  try {
    const raw = await env.STATUS.get("qwenpaw:status");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// --- Daily write-budget guard (KV phase, 2026-11-15) --------------------
// STATUS cap 250/day, shared with qwenpaw-routines through the same
// counter key `budget:<YYYY-MM-DD>` (DESKTOP_KV gets 450; 250 + 450 =
// 700 of the 1,000/day account cap, leaving 300 headroom). Counting is
// approximate by design (per-isolate in-memory count, flushed to KV only
// on every 25th local write — never per write, never on a timer; KV has
// no CAS). See features/storage/QUOTA-BUDGET.md for the full audit.
const BUDGET_CAP = 250;
const BUDGET_FLUSH_EVERY = 25;

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
function getBudgetCounter(env) {
  if (!budgetCounter) budgetCounter = makeDailyCounter(env.STATUS, "budget:", BUDGET_FLUSH_EVERY);
  return budgetCounter;
}

// A KV put through the budget guard. Non-essential writes are refused
// (false) once the soft cap is hit; essential writes always try.
// Returns true when the write landed.
async function budgetGuardedPut(env, key, value, essential = false) {
  if (!env.STATUS) return false;
  if (!essential && (await getBudgetCounter(env).count()) >= BUDGET_CAP) return false;
  try {
    await env.STATUS.put(key, value);
  } catch (e) {
    console.log("KV put failed:", e?.message);
    return false;
  }
  getBudgetCounter(env).note();
  return true;
}

async function saveStatus(env, patch, essential = false) {
  if (!env.STATUS) return null;
  const prev = (await loadStatus(env)) || {};
  const now = new Date().toISOString();
  // patch.status === undefined means "no status change" (e.g. the
  // wake-marker save): keep the stored status and failure count instead
  // of incrementing consecutiveFailures — the old code bumped failures
  // on every wake-marker save, which was wrong.
  const next = {
    ...prev,
    ...patch,
    checkedAt: now,
    lastPingAt: patch.status !== undefined ? now : prev.lastPingAt || now,
    lastUpAt: patch.status === "up" ? now : prev.lastUpAt || null,
    consecutiveFailures: patch.status === undefined
      ? (prev.consecutiveFailures || 0)
      : patch.status === "up" ? 0 : (prev.consecutiveFailures || 0) + 1,
  };
  // Clear error fields the latest probe did not set (probe saves only —
  // a wake-marker save has no status and must not touch them): without
  // this, a cooldown's errorCode / retryAfterSeconds stayed in the stored
  // record forever (spread keeps prev's values), so /status kept reporting
  // "machine_cooldown" long after the machine was up again.
  if (patch.status !== undefined) {
    if (patch.errorCode === undefined) next.errorCode = null;
    if (patch.retryAfterSeconds === undefined) next.retryAfterSeconds = null;
  }
  // Write only when something a reader cares about changed. checkedAt /
  // lastPingAt are fresh in every RESPONSE but are not stored unless the
  // meaningful state changed — a steady "up" day writes once, not 288
  // times (the old code wrote on every 5-min cron tick). lastUpAt is
  // deliberately NOT in the list: it advances on every successful probe
  // by construction, so including it would write on every tick and
  // defeat the whole optimization. The stored lastUpAt is therefore the
  // last up-TRANSITION (or last write while up); the response always
  // carries a fresh checkedAt / lastPingAt for "seen just now".
  const meaningful = ["status", "consecutiveFailures", "lastWakeAt", "httpStatus", "note", "errorCode", "retryAfterSeconds", "lastWakeResult"];
  const changed = !prev.status || meaningful.some((k) => JSON.stringify(next[k]) !== JSON.stringify(prev[k]));
  if (changed) {
    const ok = await budgetGuardedPut(env, "qwenpaw:status", JSON.stringify(next), essential);
    if (!ok) console.log("status write dropped (KV failed or daily write-budget guard tripped; response still fresh)");
  }
  return next;
}

async function callInstaBoxWake(env) {
  const id = env.INSTABOX_MACHINE_ID;
  try {
    const res = await fetch(`https://api.instabox.sh/v1/machines/${encodeURIComponent(id)}/wake`, {
      method: "POST",
      headers: { "X-API-Key": env.INSTABOX_API_KEY, "Idempotency-Key": crypto.randomUUID() },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await readSmallText(res);
    return { httpStatus: res.status, body: body || null };
  } catch (err) {
    return { httpStatus: 0, error: err?.name || "fetch failed" };
  }
}

async function keepAliveTick(env, source) {
  const result = await probeQwenPaw(env, { allowRetry: true });
  const saved = await saveStatus(env, { ...result, source });
  console.log(`[keepalive:${source}]`, result.status, result.httpStatus, result.note || "");
  if ((result.status === "offline" || result.status === "waking") && env.INSTABOX_API_KEY && env.INSTABOX_MACHINE_ID) {
    const lastWake = saved?.lastWakeAt ? Date.parse(saved.lastWakeAt) : 0;
    if (Date.now() - lastWake >= WAKE_MIN_GAP_MS) {
      const wake = await callInstaBoxWake(env);
      console.log("[keepalive:wake-fallback]", wake);
      // Essential: the marker is what enforces the 10-min API-wake gap.
      // If its write were dropped, the next offline tick could re-fire
      // the API wake immediately.
      await saveStatus(env, { lastWakeAt: new Date().toISOString(), lastWakeResult: wake }, true);
    }
  }
  return saved || result;
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

  return { get, put, delete: del, list };
}

export default {
  async fetch(request, env, ctx) {
    env = { ...env, STATUS: createStore(env, env.STATUS) };
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/") {
      return json({ service: "qwenpaw-keepalive", endpoints: ["/status", "/ping", "/wake"], qwenpawUrl: env.QWENPAW_URL || null });
    }

    if (path === "/status" && request.method === "GET") {
      if (url.searchParams.get("live") === "1") {
        const live = await probeQwenPaw(env, { allowRetry: false });
        const saved = await saveStatus(env, { ...live, source: "status-live" });
        return json({ ...saved, consoleUrl: env.QWENPAW_URL || null });
      }
      const cached = await loadStatus(env);
      if (!cached) return json({ status: "unknown", note: "No ping has run yet — wait for the next cron tick, or call /ping.", consoleUrl: env.QWENPAW_URL || null });
      return json({ ...cached, consoleUrl: env.QWENPAW_URL || null });
    }

    if (path === "/ping") {
      const result = await probeQwenPaw(env, { allowRetry: true });
      const saved = await saveStatus(env, { ...result, source: "manual-ping" });
      return json(saved || result);
    }

    if (path === "/wake" && request.method === "POST") {
      // Gated (fix 2026-11-15, audit finding workers-keepalive-unauth-wake):
      // unauthenticated POST /wake forced probes and, if INSTABOX_API_KEY
      // were ever set without a token, would trigger InstaBox API wakes.
      // Fail closed when WAKE_TOKEN is unset; header X-Wake-Token only
      // (never a ?token= query — tokens in URLs leak in logs/Referer).
      if (!env.WAKE_TOKEN) {
        return json({ error: "manual wake disabled: WAKE_TOKEN secret is not set. Use GET /ping (public wake path) instead." }, 503);
      }
      const token = request.headers.get("X-Wake-Token") || "";
      if (token !== env.WAKE_TOKEN) return json({ error: "unauthorized" }, 401);
      const result = await probeQwenPaw(env, { allowRetry: true });
      let wake = null;
      if ((result.status === "offline" || result.status === "waking") && env.INSTABOX_API_KEY && env.INSTABOX_MACHINE_ID) {
        const cached = await loadStatus(env);
        const lastWake = cached?.lastWakeAt ? Date.parse(cached.lastWakeAt) : 0;
        if (Date.now() - lastWake >= WAKE_MIN_GAP_MS) {
          wake = await callInstaBoxWake(env);
        } else {
          wake = { skipped: "rate-limited — last API wake was <10 min ago" };
        }
      }
      // Only include the wake marker when a wake actually fired: spreading
      // `lastWakeAt: undefined` would WIPE the stored marker (spread
      // copies undefined), losing the 10-min API-wake gap protection.
      const wakePatch = (wake && !wake.skipped)
        ? { lastWakeAt: new Date().toISOString(), lastWakeResult: wake }
        : {};
      const saved = await saveStatus(env, { ...result, source: "manual-wake", ...wakePatch }, !!(wake && !wake.skipped));
      return json({ ...(saved || result), wake });
    }

    return json({ error: "not found", endpoints: ["/status", "/ping", "/wake"] }, 404);
  },

  async scheduled(event, env, ctx) {
    env = { ...env, STATUS: createStore(env, env.STATUS) };
    ctx.waitUntil(keepAliveTick(env, `cron:${event.cron}`));
  },
};
