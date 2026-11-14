// qwenpaw-routines — Cloudflare Worker (Free tier) for QwenPaw Routines.
//
// WHAT THIS WORKER DOES (and does NOT do):
//  - Cron every 30 min + daily 01:30 UTC (07:00 Asia/Kolkata): wakes the
//    InstaBox Free machine by probing the public QwenPaw URL, so QwenPaw's
//    NATIVE scheduler (APScheduler cron jobs in jobs.json + heartbeat) can
//    actually fire despite the 30-min idle pause. Records each wake in KV.
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

async function readJson(env, key, fallback) {
  try {
    const raw = await env.STATUS.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

async function pushHistory(env, entry) {
  const hist = await readJson(env, HISTORY_KEY, []);
  hist.unshift(entry);
  await env.STATUS.put(HISTORY_KEY, JSON.stringify(hist.slice(0, MAX_HISTORY)));
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

// One scheduled tick: wake + log. `cron` is the trigger expression, so the
// daily 01:30 UTC slot is distinguishable from the 30-min ticks.
async function scheduledTick(env, ctx, cron) {
  const probe = await probeQwenPaw(env);
  const defs = await readJson(env, DEFINITIONS_KEY, []);
  const active = defs.filter((r) => r && r.active);
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
  const defRows = defs.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.name)}</td><td>${esc(r.scheduleNote || "")}</td><td>${esc(r.active ? "active" : "paused")}</td><td>${esc(r.prompt || "")}</td></tr>`).join("");
  const pendRows = pending.map((p) => `<tr><td>${esc(p.at)}</td><td>${esc(p.routineId || "-")}</td><td>${esc(p.prompt || "")}</td><td>${esc(p.status)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QwenPaw Routines</title><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2em auto;padding:0 1em}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 8px;text-align:left;font-size:14px}code{background:#f2f2f2;padding:1px 4px}</style></head><body>
<h1>QwenPaw Routines</h1>
<p>Wake + history layer for QwenPaw on InstaBox Free. The scheduler of record is QwenPaw's <b>native cron system</b> (<code>POST /api/cron/jobs</code>, stored in <code>jobs.json</code> v2). This Worker wakes the machine every 30 min and at 07:00 IST daily so native jobs can fire despite the 30-min idle pause.</p>
<p>Console: <a href="${esc(qwenpawUrl)}">${esc(qwenpawUrl)}</a> &middot; <a href="/api/status">JSON status</a> &middot; <a href="/api/history">JSON history</a></p>
<h2>Routines (registry in KV, key <code>routines:definitions</code>)</h2>
<table><tr><th>ID</th><th>Name</th><th>Schedule</th><th>State</th><th>Prompt</th></tr>${defRows || "<tr><td colspan=5>No routines defined yet.</td></tr>"}</table>
<h2>Pending manual triggers</h2>
<table><tr><th>At</th><th>Routine</th><th>Prompt</th><th>Status</th></tr>${pendRows || "<tr><td colspan=4>None pending.</td></tr>"}</table>
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
  for (const e of entries.slice(MAX_PENDING)) await env.STATUS.delete(e.key);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({ ok: true }, 204);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const defs = await readJson(env, DEFINITIONS_KEY, []);
      const hist = await readJson(env, HISTORY_KEY, []);
      const pending = await listPending(env);
      return new Response(statusPage(defs, hist, pending, env.QWENPAW_URL || ""), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      const probe = await probeQwenPaw(env);
      const defs = await readJson(env, DEFINITIONS_KEY, []);
      return json({
        worker: "qwenpaw-routines", qwenpaw: probe,
        routines: defs, schedulerOfRecord: "qwenpaw native cron (POST /api/cron/jobs, jobs.json v2)",
        note: "This Worker wakes QwenPaw and records history. It does not deliver prompts (no QwenPaw login stored).",
      });
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      return json({ history: await readJson(env, HISTORY_KEY, []) });
    }

    if (url.pathname === "/api/routines" && request.method === "GET") {
      return json({ routines: await readJson(env, DEFINITIONS_KEY, []) });
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
      next.push({ id: body.id, name: body.name || body.id, prompt: body.prompt.slice(0, MAX_PROMPT_CHARS), scheduleNote: body.scheduleNote || "", active: body.active !== false, updatedAt: new Date().toISOString() });
      await env.STATUS.put(DEFINITIONS_KEY, JSON.stringify(next));
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
      const probe = await probeQwenPaw(env);
      const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, MAX_PROMPT_CHARS) : "";
      const id = `trig-${now}`;
      const entry = {
        id, at: new Date().toISOString(), routineId: body.routine_id || null,
        prompt, status: "pending", qwenpaw: probe.status, httpStatus: probe.httpStatus,
        note: "Recorded only. Run this prompt in the QwenPaw console, or create a native cron job for it. This Worker holds no QwenPaw login and cannot deliver prompts.",
      };
      await env.STATUS.put(PENDING_PREFIX + id, JSON.stringify(entry), { expirationTtl: PENDING_TTL_SECONDS });
      await env.STATUS.put("routines:last-trigger-at", String(now));
      await prunePending(env);
      await pushHistory(env, { at: entry.at, kind: "manual-trigger", cron: null, qwenpaw: probe.status, httpStatus: probe.httpStatus, note: `manual trigger ${id} recorded as pending`, activeRoutines: [], deliveredBy: "none — pending, needs console / native cron job" });
      return json({ ok: true, pending: entry }, 202);
    }

    return json({ error: "not found", routes: ["GET /", "GET /api/status", "GET /api/history", "GET /api/routines", "POST /api/routines (token-gated)", "POST /trigger"] }, 404);
  },

  async scheduled(event, env, ctx) {
    await scheduledTick(env, ctx, event.cron);
  },
};
