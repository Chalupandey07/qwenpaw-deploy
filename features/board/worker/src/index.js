// qwenpaw-board — tiny ticket board for QwenPaw (Cloudflare Worker + D1).
// Free-tier safe: one D1 row per ticket in qwenpaw-state (no more
// single-KV-value board — KV's 1,000 writes/day account cap was burned
// twice in 2026-11-15 and every board write 500'd). KV stays as the
// fallback when USE_D1 is not "1" or the QWENPAW_DB binding is absent.
// No external resources, no build step, English only.
//
// Auth: every /api/* call needs the shared board key, either as
// ?key=... or header X-Board-Key. The key lives in the Worker secret
// BOARD_TOKEN (set with the Cloudflare API, never in git). The HTML page
// itself is public; it asks for the key once and keeps it in localStorage.
//
// Rate limiting (fix 2026-11-15, audit bug board-no-rate-limit-auth):
// failed-auth attempts are throttled at 30/min/IP before auth
// (key-guessing floods cost zero D1 rows); authenticated mutations are
// capped at 30/min/IP + 1,000/day/IP. Both are counted by ONE Durable
// Object (BoardRateLimiter) — a singleton, so counts are exact. The
// first version used in-memory per-isolate counters, but live testing
// proved they never fire (a low-traffic Worker rotates isolates per
// request: 90 unauthenticated POSTs -> 0x429), so the DO is the real
// limiter; the in-memory bucket is only the fallback when the DO is
// unbound. Over-cap answers are 429 with Retry-After.
//
// Columns (Rakazo parity): todo / in-progress / in-review / blocked /
// done / wont-do ("Won't do").
//
// API:
//   GET    /api/tickets            list all tickets
//   POST   /api/tickets            {title, description?, agent?, priority?, follow_up?}
//   GET    /api/tickets/:id
//   PATCH  /api/tickets/:id        {title?, description?, column?, agent?, priority?, follow_up?}
//   DELETE /api/tickets/:id
//   POST   /api/tickets/:id/comments   {text} — append a comment (Rakazo parity)
//   POST   /api/tickets/:id/mark-sent — record that the ticket was posted
//          to QwenPaw: sets qwenpaw_session + sent_to_qwenpaw_at, and moves
//          a To-do ticket to In progress.
//   GET    /api/tickets/:id/qwenpaw-task   {task_text, curl, api_url, note, sent}
//   GET    /health
//
// D1 note: D1 is strongly consistent (read replication disabled), so a
// mutation response is authoritative immediately — no stale-read lag
// like the old KV board (worst observed ~60 s). The UI still updates
// optimistically from the mutation response and re-fetches in the
// background a few seconds later, so other tabs converge too.

export const COLUMNS = [
  { id: "todo", label: "To do" },
  { id: "in-progress", label: "In progress" },
  { id: "in-review", label: "In review" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
  { id: "wont-do", label: "Won't do" },
];

const AGENTS = ["default", "QwenPaw_QA_Agent_0.2"];
const PRIORITIES = ["low", "normal", "high"];
const KV_KEY = "tickets";
const MAX_COMMENTS = 50;
const MAX_COMMENT_LEN = 1000;

// Public console URL (Cloudflare Pages proxy in front of QwenPaw).
const CONSOLE_URL = "https://qwenpawx.pages.dev";
const CONSOLE_CHAT_API = CONSOLE_URL + "/api/console/chat";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

// Constant-time comparison that never early-returns on length (fix
// 2026-11-15, audit hardening for board-timing-length-leak): the old
// code returned false immediately when lengths differed, leaking the key
// length through timing. Now the loop always runs over the longer string
// and the length difference is folded into the diff.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

function authed(request, env) {
  if (!env.BOARD_TOKEN) return false;
  const url = new URL(request.url);
  const key = request.headers.get("x-board-key") || url.searchParams.get("key") || "";
  return safeEqual(key, env.BOARD_TOKEN);
}

// --- Storage: D1 first (one row per ticket), KV fallback ---------------
// USE_D1="1" + a QWENPAW_DB binding = D1 (qwenpaw-state). Otherwise the
// old single KV key ("tickets") is used. D1 is single-threaded per
// database, so read-modify-write on one ticket row cannot lose a
// concurrent update the way the whole-list KV rewrite could.
// Rollback: set USE_D1=0 and redeploy; KV data was never deleted.
function useD1(env) {
  return env && env.USE_D1 === "1" && env.QWENPAW_DB;
}

function d1q(db, sql, ...params) {
  return db.prepare(sql).bind(...params);
}

function rowToTicket(row) {
  let comments = [];
  try { comments = JSON.parse(row.comments || "[]"); } catch { comments = []; }
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    column: row.column,
    agent: row.agent,
    priority: row.priority,
    follow_up: row.follow_up === 1,
    comments: Array.isArray(comments) ? comments : [],
    qwenpaw_session: row.qwenpaw_session || null,
    sent_to_qwenpaw_at: row.sent_to_qwenpaw_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function d1List(env) {
  const res = await d1q(env.QWENPAW_DB, "SELECT * FROM tickets ORDER BY created_at ASC").all();
  return (res.results || []).map(rowToTicket);
}
async function d1Get(env, id) {
  const row = await d1q(env.QWENPAW_DB, "SELECT * FROM tickets WHERE id = ?", id).first();
  return row ? rowToTicket(row) : null;
}
async function d1Insert(env, t) {
  await d1q(env.QWENPAW_DB,
    "INSERT INTO tickets (id, title, description, column, agent, priority, follow_up, comments, qwenpaw_session, sent_to_qwenpaw_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    t.id, t.title, t.description || "", t.column, t.agent, t.priority, t.follow_up ? 1 : 0,
    JSON.stringify(t.comments || []), t.qwenpaw_session || null, t.sent_to_qwenpaw_at || null,
    t.created_at, t.updated_at).run();
}
async function d1Update(env, id, changes) {
  // changes: validated fields only, from a fixed allow-list — never
  // raw request keys (column names are not user input).
  const sets = [];
  const params = [];
  const COLS = { title: "title", description: "description", column: "column", agent: "agent", priority: "priority" };
  for (const [k, col] of Object.entries(COLS)) {
    if (changes[k] !== undefined) { sets.push(`${col} = ?`); params.push(changes[k]); }
  }
  if (changes.follow_up !== undefined) { sets.push("follow_up = ?"); params.push(changes.follow_up ? 1 : 0); }
  if (changes.comments !== undefined) { sets.push("comments = ?"); params.push(JSON.stringify(changes.comments)); }
  if (changes.qwenpaw_session !== undefined) { sets.push("qwenpaw_session = ?"); params.push(changes.qwenpaw_session); }
  if (changes.sent_to_qwenpaw_at !== undefined) { sets.push("sent_to_qwenpaw_at = ?"); params.push(changes.sent_to_qwenpaw_at); }
  sets.push("updated_at = ?");
  params.push(changes.updated_at || new Date().toISOString());
  params.push(id);
  const r = await d1q(env.QWENPAW_DB, `UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`, ...params).run();
  return r.meta.changes > 0;
}
async function d1Delete(env, id) {
  const r = await d1q(env.QWENPAW_DB, "DELETE FROM tickets WHERE id = ?", id).run();
  return r.meta.changes > 0;
}

async function kvList(env) {
  const raw = await env.TICKETS.get(KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.tickets || [];
  } catch {
    return [];
  }
}
async function kvSave(env, tickets) {
  await env.TICKETS.put(KV_KEY, JSON.stringify({ tickets, updated_at: new Date().toISOString() }));
}

// One interface, two backends. Handlers use only these.
async function listTickets(env) {
  if (useD1(env)) return d1List(env);
  return kvList(env);
}
async function getTicket(env, id) {
  if (useD1(env)) return d1Get(env, id);
  return (await kvList(env)).find((t) => t.id === id) || null;
}
async function createTicket(env, ticket) {
  if (useD1(env)) { await d1Insert(env, ticket); return ticket; }
  const tickets = await kvList(env);
  tickets.push(ticket);
  await kvSave(env, tickets);
  return ticket;
}
async function updateTicket(env, id, changes) {
  // Returns the updated ticket, or null when the id does not exist.
  if (useD1(env)) {
    const ok = await d1Update(env, id, changes);
    return ok ? d1Get(env, id) : null;
  }
  const tickets = await kvList(env);
  const idx = tickets.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  Object.assign(tickets[idx], changes, { updated_at: changes.updated_at || new Date().toISOString() });
  await kvSave(env, tickets);
  return tickets[idx];
}
async function deleteTicket(env, id) {
  if (useD1(env)) return d1Delete(env, id);
  const tickets = await kvList(env);
  const idx = tickets.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  tickets.splice(idx, 1);
  await kvSave(env, tickets);
  return true;
}
async function addComment(env, id, text) {
  // Returns {ticket} or {error, status}.
  const ticket = await getTicket(env, id);
  if (!ticket) return { error: "ticket not found", status: 404 };
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  if (comments.length >= MAX_COMMENTS) return { error: "too many comments (max 50)", status: 400 };
  comments.push({ at: new Date().toISOString(), text });
  const updated = await updateTicket(env, id, { comments, updated_at: new Date().toISOString() });
  return { ticket: updated };
}
async function markSent(env, id) {
  // Idempotent: a ticket already marked sent is returned unchanged
  // (no re-stamp, no column move). D1 does it as one conditional
  // UPDATE; KV does the same check in code.
  const ticket = await getTicket(env, id);
  if (!ticket) return { error: "ticket not found", status: 404 };
  if (ticket.sent_to_qwenpaw_at) return { ticket };
  const now = new Date().toISOString();
  const changes = { qwenpaw_session: `board-${ticket.id.slice(0, 8)}`, sent_to_qwenpaw_at: now, updated_at: now };
  if (ticket.column === "todo") changes.column = "in-progress";
  const updated = await updateTicket(env, id, changes);
  return { ticket: updated };
}

// --- Rate limiting (fix 2026-11-15, audit bug board-no-rate-limit-auth)
// Two layers, both counted by ONE Durable Object (BoardRateLimiter
// below) — a singleton, so counts are exact. The first version used
// in-memory per-isolate counters, but live testing proved they never
// fire: a low-traffic Worker rotates isolates per request, so no
// isolate ever sees 30 attempts (90 unauthenticated POSTs -> 0x429).
// (1) Failed-auth throttle: 30 failed auth attempts/min/IP, checked
// BEFORE auth, so key-guessing floods cost zero D1 rows and are
// stopped at the edge. (2) Authenticated mutation caps: 30
// mutations/min/IP and 1,000 mutations/day/IP. Worst case per IP per
// day: 1,000 ticket ops — the rate checks are DO subrequests, not D1
// rows, so they cost nothing against the D1 budget. When the DO is
// not bound (KV fallback / local harness without it), the same caps
// run on the in-memory bucket (per-isolate, best-effort).
const RATE_FAILED_AUTH_PER_MIN = 30;
const RATE_MUT_PER_MIN = 30;
const RATE_MUT_PER_DAY = 1000;

const _memBuckets = new Map(); // key -> {count, windowStart}; per-isolate fallback only
function memHit(key, cap, windowStart) {
  const now = Date.now();
  let b = _memBuckets.get(key);
  if (!b || b.windowStart !== windowStart) {
    b = { count: 0, windowStart };
    _memBuckets.set(key, b);
    if (_memBuckets.size > 5000) {
      for (const [k, v] of _memBuckets) if (now - v.windowStart > 120000) _memBuckets.delete(k);
    }
  }
  b.count += 1;
  return b.count > cap;
}
function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

// Durable Object: exact per-IP rate limiting. All board requests go
// through ONE object ("board"), serialized, with buckets in DO storage
// (survives hibernation) — the same pattern as the groupchat's
// 30/min/IP write brake. POST /hit {kind, ip} -> {limited, retryAfter}.
// kind "fail" = failed-auth attempts (30/min/IP); kind "mut" =
// authenticated mutations (30/min/IP + 1,000/day/IP).
export class BoardRateLimiter {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    const body = await request.json().catch(() => ({}));
    const kind = body.kind;
    const ip = typeof body.ip === "string" && body.ip ? body.ip : "unknown";
    if (kind !== "fail" && kind !== "mut") {
      return json({ error: "bad kind" }, 400);
    }
    const now = Date.now();
    const buckets = (await this.ctx.storage.get("buckets")) || {};
    // Prune stale windows (minute buckets live 60 s, day buckets 24 h).
    for (const [key, v] of Object.entries(buckets)) {
      if (!v || now - v.windowStart >= (key.startsWith("day:") ? 86400000 : 60000)) delete buckets[key];
    }
    if (Object.keys(buckets).length > 1000) {
      const sorted = Object.entries(buckets).sort((a, b) => a[1].windowStart - b[1].windowStart);
      for (const [key] of sorted.slice(0, Object.keys(buckets).length - 1000)) delete buckets[key];
    }
    let limited = false;
    let retryAfter = 0;
    const hit = (key, cap, resetAt) => {
      let b = buckets[key];
      if (!b) { b = { count: 0, windowStart: now }; buckets[key] = b; }
      b.count += 1;
      if (b.count > cap) {
        limited = true;
        retryAfter = Math.max(retryAfter, Math.max(1, Math.ceil((resetAt - now) / 1000)));
      }
    };
    if (kind === "fail") {
      const minute = Math.floor(now / 60000);
      hit(`fail:${ip}`, RATE_FAILED_AUTH_PER_MIN, (minute + 1) * 60000);
    } else {
      const minute = Math.floor(now / 60000);
      const day = new Date(now).toISOString().slice(0, 10);
      hit(`mut:${ip}`, RATE_MUT_PER_MIN, (minute + 1) * 60000);
      hit(`day:${ip}:${day}`, RATE_MUT_PER_DAY, Date.parse(day + "T00:00:00Z") + 86400000);
    }
    await this.ctx.storage.put("buckets", buckets);
    return json({ limited, retryAfter });
  }
}

async function rateHit(env, kind, ip) {
  // Returns {limited, retryAfter} from the DO, or null when the DO is
  // not bound / errors (caller falls back to the in-memory bucket).
  if (!env.RATE_LIMITER) return null;
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("board"));
    const res = await stub.fetch(new Request("https://rate-limit/hit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, ip }),
    }));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
async function failedAuthLimited(env, request) {
  // Returns {limited, retryAfter}.
  const ip = clientIp(request);
  const hit = await rateHit(env, "fail", ip);
  if (hit) return hit;
  const minute = Math.floor(Date.now() / 60000);
  return { limited: memHit(`fail:${ip}:${minute}`, RATE_FAILED_AUTH_PER_MIN, minute * 60000), retryAfter: 60 };
}
async function mutationLimited(env, request) {
  // Returns {limited, retryAfter}.
  const ip = clientIp(request);
  const hit = await rateHit(env, "mut", ip);
  if (hit) return hit;
  const minute = Math.floor(Date.now() / 60000);
  const day = new Date().toISOString().slice(0, 10);
  const over = memHit(`mut:${ip}:${minute}`, RATE_MUT_PER_MIN, minute * 60000)
    || memHit(`mutday:${ip}:${day}`, RATE_MUT_PER_DAY, Date.parse(day + "T00:00:00Z"));
  return { limited: over, retryAfter: 60 };
}

function cleanTicket(t) {
  return {
    id: t.id,
    title: t.title,
    description: t.description || "",
    column: t.column,
    agent: t.agent,
    priority: t.priority,
    follow_up: !!t.follow_up,
    comments: Array.isArray(t.comments) ? t.comments : [],
    qwenpaw_session: t.qwenpaw_session || null,
    sent_to_qwenpaw_at: t.sent_to_qwenpaw_at || null,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function validatePatch(body) {
  const out = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200)
      return { error: "title must be a non-empty string up to 200 chars" };
    out.title = body.title.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.length > 5000)
      return { error: "description must be a string up to 5000 chars" };
    out.description = body.description;
  }
  if (body.column !== undefined) {
    if (!COLUMNS.some((c) => c.id === body.column)) return { error: "unknown column" };
    out.column = body.column;
  }
  if (body.agent !== undefined) {
    if (!AGENTS.includes(body.agent)) return { error: "unknown agent" };
    out.agent = body.agent;
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) return { error: "unknown priority" };
    out.priority = body.priority;
  }
  // Strict boolean (fix 2026-11-15, audit bug board-business-logic-quirks):
  // the old code did !!body.follow_up, so the STRING "false" coerced to
  // true. A non-boolean follow_up is now a 400.
  if (body.follow_up !== undefined) {
    if (typeof body.follow_up !== "boolean") return { error: "follow_up must be a boolean" };
    out.follow_up = body.follow_up;
  }
  return { value: out };
}

function taskText(t) {
  const lines = [
    `[Ticket ${t.id.slice(0, 8)}] ${t.title}`,
    `Agent: ${t.agent}`,
    `Priority: ${t.priority}`,
    `Board column: ${COLUMNS.find((c) => c.id === t.column)?.label || t.column}`,
  ];
  if (t.description) lines.push("", t.description);
  if (Array.isArray(t.comments) && t.comments.length) {
    lines.push("", "Comments:");
    for (const c of t.comments) lines.push(`- ${c.text}`);
  }
  lines.push("", "Source: AgentX ticket board (qwenpaw-board)");
  return lines.join("\n");
}

function qwenpawTask(t) {
  const text = taskText(t);
  const sessionId = `board-${t.id.slice(0, 8)}`;
  const body = {
    channel: "console",
    user_id: "default",
    session_id: sessionId,
    input: [{ content: [{ type: "text", text }] }],
  };
  return {
    ticket_id: t.id,
    session_id: sessionId,
    sent: !!t.sent_to_qwenpaw_at,
    sent_to_qwenpaw_at: t.sent_to_qwenpaw_at || null,
    task_text: text,
    api_url: CONSOLE_CHAT_API,
    method: "POST",
    body,
    curl:
      `curl -X POST ${CONSOLE_CHAT_API} \\\n` +
      `  -H 'Content-Type: application/json' \\\n` +
      `  -b '<your logged-in console session cookie>' \\\n` +
      `  -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`,
    note:
      "Posting a ticket to AgentX uses POST /api/console/chat (Agent API Request Format). " +
      "It requires a logged-in console session, so the board cannot post it server-side: " +
      "copy the task text and paste it into the AgentX console chat, or run the curl above " +
      "from a browser session that is already logged in. The run continues in the background " +
      "after disconnect; stop it with POST /api/console/chat/stop?chat_id=<chat id>. " +
      "The ticket's session_id is board-<first 8 chars of ticket id>, so the work lands in " +
      "one traceable console session per ticket. After posting, use POST " +
      "/api/tickets/:id/mark-sent (or the 'Mark as sent' button) so the board records it.",
  };
}

const BOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentX Ticket Board</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}
header{padding:14px 18px;background:#1e293b;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header h1{font-size:18px;margin:0}
header p{margin:0;color:#94a3b8;font-size:13px}
#keybar{margin-left:auto;display:flex;gap:6px}
input,select,textarea,button{font:inherit;color:#0f172a;border-radius:6px;border:1px solid #475569;padding:6px 8px}
button{background:#38bdf8;border-color:#38bdf8;cursor:pointer}
button.ghost{background:transparent;color:#e2e8f0;border-color:#475569}
main{padding:14px 18px}
#newticket{background:#1e293b;padding:12px;border-radius:8px;margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#newticket input[type=text]{flex:2;min-width:220px}
#newticket textarea{flex:3;min-width:220px}
#board{display:grid;grid-template-columns:repeat(6,minmax(200px,1fr));gap:10px;overflow-x:auto}
.col{background:#1e293b;border-radius:8px;padding:8px;min-height:200px}
.col h2{font-size:14px;margin:4px 2px 10px;color:#f8fafc}
.card{background:#334155;border-radius:6px;padding:8px;margin-bottom:8px}
.card h3{font-size:14px;margin:0 0 4px}
.card p{font-size:13px;margin:0 0 6px;color:#cbd5e1;white-space:pre-wrap;word-break:break-word}
.meta{font-size:11px;color:#94a3b8;margin-bottom:6px}
.sent{font-size:11px;color:#4ade80;margin-bottom:6px}
.card .row{display:flex;gap:4px;flex-wrap:wrap}
.card .row button{font-size:12px;padding:3px 6px}
.card .row select{font-size:12px;padding:3px}
.follow{color:#fbbf24}
#error{color:#f87171;margin:8px 0}
.comments{font-size:12px;color:#cbd5e1;margin:6px 0}
.comments li{margin-bottom:3px}
.comments input{font-size:12px;width:70%}
footer{padding:10px 18px;color:#64748b;font-size:12px}
a{color:#38bdf8}
code{background:#0f172a;padding:1px 4px;border-radius:4px}
#taskbox{background:#1e293b;border-radius:8px;padding:12px;margin-top:14px;display:none}
#taskbox pre{white-space:pre-wrap;word-break:break-word;background:#0f172a;padding:10px;border-radius:6px;font-size:12px}
</style>
</head>
<body>
<header>
  <h1>AgentX Ticket Board</h1>
  <p>Columns: To do / In progress / In review / Blocked / Done / Won't do &middot; stored in Cloudflare D1 (one row per ticket)</p>
  <span id="keybar">
    <input type="password" id="key" placeholder="Board key" size="18">
    <button id="savekey">Use key</button>
  </span>
</header>
<main>
  <div id="error"></div>
  <form id="newticket">
    <input type="text" id="title" placeholder="Ticket title" maxlength="200" required>
    <textarea id="desc" placeholder="Description (optional)" rows="1"></textarea>
    <select id="agent"><option value="default">default agent</option><option value="QwenPaw_QA_Agent_0.2">QA Agent</option></select>
    <select id="prio"><option value="normal">normal</option><option value="low">low</option><option value="high">high</option></select>
    <label><input type="checkbox" id="followup"> follow-up</label>
    <button type="submit">Create ticket</button>
  </form>
  <div id="board"></div>
  <div id="taskbox">
    <h2 style="font-size:15px;margin:0 0 6px">Post to AgentX</h2>
    <p style="font-size:13px;color:#94a3b8">The board cannot post this itself (AgentX needs your logged-in console session). Copy the text below into the console chat at <a href="https://qwenpawx.pages.dev" target="_blank" rel="noopener">qwenpawx.pages.dev</a>, or run the curl from a logged-in browser session. One ticket = one console session (<code>board-&lt;ticket id&gt;</code>). After posting, press "Mark as sent" on the ticket so the board records it.</p>
    <pre id="tasktext"></pre>
    <pre id="taskcurl"></pre>
    <button id="copytask">Copy task text</button>
    <button id="copycurl">Copy curl</button>
  </div>
</main>
<footer>Worker: qwenpaw-board &middot; Console: <a href="https://qwenpawx.pages.dev">qwenpawx.pages.dev</a> &middot; Open work &amp; cost pages live in the qwenpaw-deploy repo under features/board/.</footer>
<script>
const COLUMNS = ${JSON.stringify(COLUMNS)};
let KEY = localStorage.getItem("qwenpaw-board-key") || "";
let TICKETS = [];
const $ = (id) => document.getElementById(id);
const err = (m) => { $("error").textContent = m || ""; };
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function api(path, opts={}){
  opts.headers = Object.assign({}, opts.headers||{}, {"x-board-key": KEY, "content-type":"application/json"});
  return fetch(path, opts).then(async r=>{ const t = await r.text(); let d; try{ d=JSON.parse(t);}catch{ d={error:t}; } if(!r.ok) throw new Error(d.error||("HTTP "+r.status)); return d; });
}
// D1 is strongly consistent: trust the mutation response immediately and
// only re-fetch in the background a few seconds later to converge other tabs.
function refreshSoon(){ setTimeout(()=>load(true), 4000); }
async function load(quiet){
  if(!quiet) err("");
  try{
    TICKETS = await api("/api/tickets");
    render();
  }catch(e){ if(!quiet) err("Could not load tickets: "+e.message+" — enter the board key above."); render(); }
}
function render(){
  const board = $("board"); board.innerHTML = "";
  for(const col of COLUMNS){
    const div = document.createElement("div"); div.className="col";
    div.innerHTML = "<h2>"+esc(col.label)+" ("+TICKETS.filter(t=>t.column===col.id).length+")</h2>";
    for(const t of TICKETS.filter(t=>t.column===col.id)){
      const card = document.createElement("div"); card.className="card";
      card.innerHTML = "<h3>"+esc(t.title)+(t.follow_up?' <span class="follow" title="follow-up">★ follow-up</span>':'')+"</h3>"
        + (t.description ? "<p>"+esc(t.description)+"</p>" : "")
        + '<div class="meta">'+esc(t.agent)+' · '+esc(t.priority)+' · '+esc(t.id.slice(0,8))+' · '+esc((t.created_at||"").slice(0,10))+'</div>'
        + (t.sent_to_qwenpaw_at ? '<div class="sent">Sent to AgentX ' + esc(t.sent_to_qwenpaw_at.slice(0,16).replace("T"," ")) + ' · session <code>'+esc(t.qwenpaw_session||"")+'</code></div>' : "");
      const comments = t.comments || [];
      if(comments.length){
        const ul = document.createElement("ul"); ul.className="comments";
        for(const c of comments){ const li=document.createElement("li"); li.textContent=(c.at||"").slice(0,16).replace("T"," ")+" — "+c.text; ul.appendChild(li); }
        card.appendChild(ul);
      }
      const crow = document.createElement("div"); crow.className="row";
      const cinput = document.createElement("input"); cinput.type="text"; cinput.placeholder="Add a comment"; cinput.maxLength=1000;
      const cbtn = document.createElement("button"); cbtn.textContent="Comment"; cbtn.className="ghost";
      cbtn.onclick = async ()=>{ const text=cinput.value.trim(); if(!text) return; try{ const upd = await api("/api/tickets/"+t.id+"/comments",{method:"POST",body:JSON.stringify({text})}); TICKETS = TICKETS.map(x=>x.id===t.id?upd:x); render(); refreshSoon(); }catch(e){ err(e.message); } };
      crow.appendChild(cinput); crow.appendChild(cbtn);
      card.appendChild(crow);
      const row = document.createElement("div"); row.className="row";
      const sel = document.createElement("select");
      for(const c of COLUMNS){ const o=document.createElement("option"); o.value=c.id; o.textContent="→ "+c.label; if(c.id===t.column) o.selected=true; sel.appendChild(o); }
      sel.onchange = async ()=>{ try{ const upd = await api("/api/tickets/"+t.id,{method:"PATCH",body:JSON.stringify({column:sel.value})}); TICKETS = TICKETS.map(x=>x.id===t.id?upd:x); render(); refreshSoon(); }catch(e){ err(e.message); } };
      row.appendChild(sel);
      const toQ = document.createElement("button"); toQ.textContent="Post to AgentX"; toQ.className="ghost";
      toQ.onclick = async ()=>{ try{ const d = await api("/api/tickets/"+t.id+"/qwenpaw-task"); $("tasktext").textContent=d.task_text; $("taskcurl").textContent=d.curl; $("taskbox").style.display="block"; $("taskbox").scrollIntoView(); }catch(e){ err(e.message); } };
      row.appendChild(toQ);
      if(!t.sent_to_qwenpaw_at){
        const sent = document.createElement("button"); sent.textContent="Mark as sent"; sent.className="ghost";
        sent.onclick = async ()=>{ try{ const upd = await api("/api/tickets/"+t.id+"/mark-sent",{method:"POST"}); TICKETS = TICKETS.map(x=>x.id===t.id?upd:x); render(); refreshSoon(); }catch(e){ err(e.message); } };
        row.appendChild(sent);
      }
      const del = document.createElement("button"); del.textContent="Delete"; del.className="ghost";
      del.onclick = async ()=>{ if(!confirm("Delete ticket '"+t.title+"'?")) return; try{ await api("/api/tickets/"+t.id,{method:"DELETE"}); TICKETS = TICKETS.filter(x=>x.id!==t.id); render(); refreshSoon(); }catch(e){ err(e.message); } };
      row.appendChild(del);
      card.appendChild(row);
      div.appendChild(card);
    }
    board.appendChild(div);
  }
}
$("savekey").onclick = ()=>{ KEY = $("key").value.trim(); localStorage.setItem("qwenpaw-board-key", KEY); load(); };
if(KEY) $("key").value = KEY;
$("newticket").onsubmit = async (e)=>{
  e.preventDefault(); err("");
  const body = { title: $("title").value.trim(), description: $("desc").value, agent: $("agent").value, priority: $("prio").value, follow_up: $("followup").checked };
  try{ const created = await api("/api/tickets",{method:"POST",body:JSON.stringify(body)}); TICKETS.push(created); render(); $("title").value=""; $("desc").value=""; $("followup").checked=false; refreshSoon(); }
  catch(ex){ err("Create failed: "+ex.message); }
};
$("copytask").onclick = ()=>{ navigator.clipboard.writeText($("tasktext").textContent).then(()=>{ $("copytask").textContent="Copied!"; setTimeout(()=>$("copytask").textContent="Copy task text",1500); }); };
$("copycurl").onclick = ()=>{ navigator.clipboard.writeText($("taskcurl").textContent).then(()=>{ $("copycurl").textContent="Copied!"; setTimeout(()=>$("copycurl").textContent="Copy curl",1500); }); };
load();
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      return json({ ok: true, worker: "qwenpaw-board", store: useD1(env) ? "d1" : "kv" });
    }
    if (path === "/" || path === "/index.html") {
      return new Response(BOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "x-frame-options": "SAMEORIGIN", "content-security-policy": "frame-ancestors 'self'" } });
    }

    if (!path.startsWith("/api/")) return json({ error: "not found" }, 404);
    const isMut = request.method === "POST" || request.method === "PATCH" || request.method === "DELETE";
    if (!authed(request, env)) {
      // Failed-auth throttle runs before the 401: key-guessing floods
      // are stopped at the edge and cost zero D1 rows.
      const lim = await failedAuthLimited(env, request);
      if (lim.limited) {
        return json({ error: "too many failed attempts — try again in a minute" }, 429, { "retry-after": String(lim.retryAfter || 60) });
      }
      return json(
        { error: "unauthorized — send the board key as ?key= or X-Board-Key header" },
        401,
      );
    }
    if (isMut) {
      try {
        const lim = await mutationLimited(env, request);
        if (lim.limited) {
          return json({ error: "rate limit exceeded — slow down" }, 429, { "retry-after": String(lim.retryAfter || 60) });
        }
      } catch (e) {
        // The limiter must never block a legit mutation: on a store
        // error it fails open (the ticket op itself still validates
        // and writes through the same store).
        console.log("board rate-limit error:", e?.message || e);
      }
    }

    const parts = path.split("/").filter(Boolean); // ["api","tickets", id?, action?]

    try {
      if (parts[1] === "tickets" && parts.length === 2) {
        if (request.method === "GET") {
          const tickets = await listTickets(env);
          return json(tickets.map(cleanTicket));
        }
        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const v = validatePatch(body);
          if (v.error) return json({ error: v.error }, 400);
          if (!v.value.title) return json({ error: "title is required" }, 400);
          const now = new Date().toISOString();
          const ticket = {
            id: crypto.randomUUID(),
            title: v.value.title,
            description: v.value.description || "",
            column: v.value.column || "todo",
            agent: v.value.agent || "default",
            priority: v.value.priority || "normal",
            follow_up: v.value.follow_up === true,
            comments: [],
            qwenpaw_session: null,
            sent_to_qwenpaw_at: null,
            created_at: now,
            updated_at: now,
          };
          await createTicket(env, ticket);
          return json(cleanTicket(ticket), 201);
        }
        return json({ error: "method not allowed" }, 405);
      }

      if (parts[1] === "tickets" && parts.length >= 3) {
        // Malformed percent-encoding (fix 2026-11-15, audit bug
        // board-decode-uri-500): %FF-style invalid-UTF-8 ids made
        // decodeURIComponent throw, and the outer catch returned a 500
        // that leaked the error text. Bad ids are now a clean 400.
        let id;
        try {
          id = decodeURIComponent(parts[2]);
        } catch {
          return json({ error: "invalid ticket id" }, 400);
        }

        if (parts.length === 4 && parts[3] === "qwenpaw-task") {
          if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
          const ticket = await getTicket(env, id);
          if (!ticket) return json({ error: "ticket not found" }, 404);
          return json(qwenpawTask(ticket));
        }
        if (parts.length === 4 && parts[3] === "comments") {
          if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
          const body = await request.json().catch(() => ({}));
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text || text.length > MAX_COMMENT_LEN)
            return json({ error: "comment text must be 1-1000 chars" }, 400);
          const res = await addComment(env, id, text);
          if (res.error) return json({ error: res.error }, res.status);
          return json(cleanTicket(res.ticket));
        }
        if (parts.length === 4 && parts[3] === "mark-sent") {
          if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
          // Idempotent (fix 2026-11-15, audit bug
          // board-business-logic-quirks): re-marking must not re-stamp
          // the timestamp or move the column again.
          const res = await markSent(env, id);
          if (res.error) return json({ error: res.error }, res.status);
          return json(cleanTicket(res.ticket));
        }
        if (parts.length !== 3) return json({ error: "not found" }, 404);

        // Plain /:id — existence is checked before body validation,
        // exactly as the old whole-list code did.
        const ticket = await getTicket(env, id);
        if (!ticket) return json({ error: "ticket not found" }, 404);
        if (request.method === "GET") return json(cleanTicket(ticket));
        if (request.method === "PATCH") {
          const body = await request.json().catch(() => ({}));
          const v = validatePatch(body);
          if (v.error) return json({ error: v.error }, 400);
          // Empty patch (fix 2026-11-15, audit bug
          // board-business-logic-quirks): the old code returned 200 for
          // a no-op PATCH. A patch that changes nothing is now a 400.
          if (Object.keys(v.value).length === 0) {
            return json({ error: "empty patch: nothing to update" }, 400);
          }
          const updated = await updateTicket(env, id, { ...v.value, updated_at: new Date().toISOString() });
          if (!updated) return json({ error: "ticket not found" }, 404);
          return json(cleanTicket(updated));
        }
        if (request.method === "DELETE") {
          const ok = await deleteTicket(env, id);
          if (!ok) return json({ error: "ticket not found" }, 404);
          return json({ deleted: true, id });
        }
        return json({ error: "method not allowed" }, 405);
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      // Generic on purpose: the old message echoed e.message, which can
      // leak internals (fix 2026-11-15, audit bug board-decode-uri-500).
      console.log("board error:", e?.message || e);
      // A store failure on the D1 path is an honest 503 (same shape as
      // the other Workers' store_unavailable); the KV fallback keeps
      // the old 500.
      if (useD1(env)) return json({ error: "store unavailable — try again shortly" }, 503);
      return json({ error: "server error" }, 500);
    }
  },
};
