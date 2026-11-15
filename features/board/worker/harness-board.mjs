// Harness for features/board/worker/src/index.js — the D1 ticket board.
// Mock D1 binding backed by REAL SQLite (node:sqlite), so the SQL is
// genuinely exercised (per-ticket rows, conditional mark-sent, rate
// limits with RETURNING). The KV fallback path is tested with an
// in-memory Map-backed mock KV. Run: node features/board/worker/harness-board.mjs
import { DatabaseSync } from "node:sqlite";
import worker, { BoardRateLimiter } from "./src/index.js";

const DDL = [
  "CREATE TABLE tickets (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', column TEXT NOT NULL DEFAULT 'todo', agent TEXT NOT NULL DEFAULT 'default', priority TEXT NOT NULL DEFAULT 'normal', follow_up INTEGER NOT NULL DEFAULT 0, comments TEXT NOT NULL DEFAULT '[]', qwenpaw_session TEXT, sent_to_qwenpaw_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX idx_tickets_column ON tickets(column)",
];

// Mock of the Workers D1 binding API over node:sqlite (same shape as
// features/storage/harness-store.mjs).
function mockD1() {
  const db = new DatabaseSync(":memory:");
  for (const sql of DDL) db.exec(sql);
  return {
    _raw: db,
    prepare(sql) {
      return {
        bind(...params) {
          const stmt = db.prepare(sql);
          return {
            run() { const r = stmt.run(...params); return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; },
            first() { const row = stmt.get(...params); return row === undefined ? null : row; },
            all() { return { success: true, results: stmt.all(...params) }; },
          };
        },
      };
    },
    batch(stmts) { return stmts.map((s) => s.run()); },
  };
}

function mockKV() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    _map: m,
  };
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const KEY = "test-key-123";
const db = mockD1();
const kv = mockKV();
// The real BoardRateLimiter class, with a mock ctx whose storage is a
// Map — this exercises the DO code itself, not a re-implementation.
const doStore = new Map();
const limiter = new BoardRateLimiter({ storage: {
  get: async (k) => (doStore.has(k) ? doStore.get(k) : null),
  put: async (k, v) => { doStore.set(k, v); },
} });
const mockDO = {
  idFromName: (name) => name,
  get: () => ({ fetch: (req) => limiter.fetch(req) }),
};
const envD1 = { USE_D1: "1", QWENPAW_DB: db, BOARD_TOKEN: KEY, TICKETS: kv, RATE_LIMITER: mockDO };
const kv2 = mockKV();
const envKV = { USE_D1: "0", BOARD_TOKEN: KEY, TICKETS: kv2 };

async function call(env, method, path, { key = KEY, ip = "10.0.0.1", body = undefined } = {}) {
  const headers = { "cf-connecting-ip": ip };
  if (key !== null) headers["x-board-key"] = key;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await worker.fetch(
    new Request("https://board" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
  );
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, data, text, retryAfter: res.headers.get("retry-after") };
}

// --- D1 path: health + page ---
let r = await call(envD1, "GET", "/health", { key: null });
check("health 200 + store d1", r.status === 200 && r.data.ok === true && r.data.worker === "qwenpaw-board" && r.data.store === "d1", JSON.stringify(r.data));
r = await call(envD1, "GET", "/", { key: null });
check("root HTML mentions D1", r.status === 200 && r.text.includes("QwenPaw Ticket Board") && r.text.includes("Cloudflare D1"));

// --- D1 path: auth ---
r = await call(envD1, "GET", "/api/tickets", { key: null });
check("unauth list -> 401", r.status === 401 && String(r.data.error).includes("unauthorized"));
r = await call(envD1, "POST", "/api/tickets", { key: null, body: { title: "x" } });
check("unauth create -> 401", r.status === 401);
r = await call(envD1, "GET", "/api/tickets", { key: "wrong-key" });
check("wrong key -> 401", r.status === 401);

// --- D1 path: CRUD round trip ---
r = await call(envD1, "POST", "/api/tickets", { body: { title: "Harness ticket", description: "d1 round trip", priority: "high", follow_up: true } });
check("create -> 201 + shape", r.status === 201 && r.data.title === "Harness ticket" && r.data.column === "todo" && r.data.agent === "default" && r.data.priority === "high" && r.data.follow_up === true && eq(r.data.comments, []) && r.data.created_at && r.data.updated_at, JSON.stringify(r.data));
const id = r.data.id;
r = await call(envD1, "GET", "/api/tickets");
check("list has the ticket", r.status === 200 && Array.isArray(r.data) && r.data.length === 1 && r.data[0].id === id);
r = await call(envD1, "GET", `/api/tickets/${id}`);
check("get -> 200", r.status === 200 && r.data.id === id);
r = await call(envD1, "GET", "/api/tickets/does-not-exist");
check("get missing -> 404", r.status === 404);
r = await call(envD1, "POST", "/api/tickets", { body: { description: "no title" } });
check("create without title -> 400", r.status === 400);

// --- D1 path: PATCH + audit fixes ---
r = await call(envD1, "PATCH", `/api/tickets/${id}`, { body: { column: "in-progress" } });
check("patch column -> 200", r.status === 200 && r.data.column === "in-progress");
r = await call(envD1, "PATCH", `/api/tickets/${id}`, { body: { follow_up: "false" } });
check("strict boolean: string follow_up -> 400", r.status === 400);
r = await call(envD1, "PATCH", `/api/tickets/${id}`, { body: { follow_up: false } });
check("patch follow_up false -> 200", r.status === 200 && r.data.follow_up === false);
r = await call(envD1, "PATCH", `/api/tickets/${id}`, { body: {} });
check("empty PATCH -> 400", r.status === 400);
r = await call(envD1, "PATCH", `/api/tickets/${id}`, { body: { column: "nope" } });
check("invalid column -> 400", r.status === 400);
r = await call(envD1, "GET", "/api/tickets/%FF");
check("%FF id -> 400", r.status === 400, `status=${r.status}`);

// --- D1 path: comments ---
r = await call(envD1, "POST", `/api/tickets/${id}/comments`, { body: { text: "first comment" } });
check("comment -> 200 + stored", r.status === 200 && r.data.comments.length === 1 && r.data.comments[0].text === "first comment" && r.data.comments[0].at, JSON.stringify(r.data.comments));
r = await call(envD1, "POST", `/api/tickets/${id}/comments`, { body: { text: "   " } });
check("empty comment -> 400", r.status === 400);
// Seed 49 more comments directly in D1, then the 51st via the API must 400.
{
  const row = db._raw.prepare("SELECT comments FROM tickets WHERE id = ?").get(id);
  const comments = JSON.parse(row.comments);
  while (comments.length < 50) comments.push({ at: "2026-11-15T00:00:00.000Z", text: "seed" });
  db._raw.prepare("UPDATE tickets SET comments = ? WHERE id = ?").run(JSON.stringify(comments), id);
}
r = await call(envD1, "POST", `/api/tickets/${id}/comments`, { body: { text: "one too many" } });
check("51st comment -> 400", r.status === 400);

// --- D1 path: mark-sent (fresh todo ticket) + qwenpaw-task ---
r = await call(envD1, "POST", "/api/tickets", { body: { title: "To post" } });
const id2 = r.data.id;
check("second ticket created todo", r.status === 201 && r.data.column === "todo");
r = await call(envD1, "POST", `/api/tickets/${id2}/mark-sent`, { body: {} });
check("mark-sent -> 200 + in-progress + session", r.status === 200 && r.data.column === "in-progress" && r.data.qwenpaw_session === `board-${id2.slice(0, 8)}` && !!r.data.sent_to_qwenpaw_at, JSON.stringify(r.data));
const sentAt = r.data.sent_to_qwenpaw_at;
r = await call(envD1, "POST", `/api/tickets/${id2}/mark-sent`, { body: {} });
check("mark-sent again idempotent", r.status === 200 && r.data.sent_to_qwenpaw_at === sentAt && r.data.column === "in-progress");
r = await call(envD1, "GET", `/api/tickets/${id2}/qwenpaw-task`);
check("qwenpaw-task sent:true", r.status === 200 && r.data.sent === true && r.data.session_id === `board-${id2.slice(0, 8)}` && r.data.task_text.includes("To post"));

// --- D1 path: delete ---
r = await call(envD1, "DELETE", `/api/tickets/${id}`);
check("delete -> 200", r.status === 200 && r.data.deleted === true && r.data.id === id);
r = await call(envD1, "GET", `/api/tickets/${id}`);
check("get after delete -> 404", r.status === 404);
r = await call(envD1, "GET", "/api/tickets");
check("list after delete has 1 left", r.status === 200 && r.data.length === 1 && r.data[0].id === id2);

// --- Rate limit: failed-auth throttle (in-memory, before auth) ---
{
  let last = 0, saw429 = false;
  for (let i = 0; i < 31; i++) {
    const x = await call(envD1, "POST", "/api/tickets", { key: null, ip: "10.0.0.9", body: { title: "flood" } });
    last = x.status;
    if (i < 30) check(`failed-auth burst ${i + 1} -> 401`, x.status === 401, `status=${x.status}`);
    // The DO returns the honest seconds-until-window-reset (1-60),
    // not a fixed 60 — the groupchat limiter does the same.
    if (i === 30) saw429 = x.status === 429 && x.retryAfter !== null && parseInt(x.retryAfter, 10) >= 1 && parseInt(x.retryAfter, 10) <= 60;
  }
  check("failed-auth 31st -> 429 + retry-after", saw429, `last=${last}`);
}

// --- Rate limit: authenticated mutation cap (D1-backed) ---
{
  let ok = 0, over = 0;
  for (let i = 0; i < 31; i++) {
    const x = await call(envD1, "POST", "/api/tickets", { ip: "10.0.0.2", body: { title: `cap ${i}` } });
    if (x.status === 201) ok++;
    else if (x.status === 429) over++;
  }
  check("mutation cap: 30 allowed then 429", ok === 30 && over === 1, `ok=${ok} over=${over}`);
  const buckets = doStore.get("buckets") || {};
  const mutCount = (buckets["mut:10.0.0.2"] || {}).count;
  check("DO buckets counted the 31 mutation hits", mutCount === 31, `mut count=${mutCount}`);
  const failCount = (buckets["fail:10.0.0.9"] || {}).count;
  check("DO buckets counted the 31 failed-auth hits", failCount === 31, `fail count=${failCount}`);
}

// --- D1 down -> honest 503 ---
{
  const badDb = { prepare() { throw new Error("boom"); } };
  const envBad = { USE_D1: "1", QWENPAW_DB: badDb, BOARD_TOKEN: KEY, TICKETS: kv };
  const x = await call(envBad, "GET", "/api/tickets", { ip: "10.0.0.5" });
  check("D1 down -> 503 store unavailable", x.status === 503 && String(x.data.error).includes("store unavailable"), `status=${x.status} ${JSON.stringify(x.data)}`);
}

// --- KV fallback path ---
{
  const seed = [{ id: "kv-1", title: "KV ticket", description: "", column: "todo", agent: "default", priority: "normal", follow_up: false, comments: [], qwenpaw_session: null, sent_to_qwenpaw_at: null, created_at: "2026-11-15T00:00:00.000Z", updated_at: "2026-11-15T00:00:00.000Z" }];
  await kv2.put("tickets", JSON.stringify({ tickets: seed, updated_at: "2026-11-15T00:00:00.000Z" }));
  let x = await call(envKV, "GET", "/health", { key: null, ip: "10.0.0.7" });
  check("KV fallback health store kv", x.status === 200 && x.data.store === "kv", JSON.stringify(x.data));
  x = await call(envKV, "GET", "/api/tickets", { ip: "10.0.0.7" });
  check("KV fallback list reads seed", x.status === 200 && x.data.length === 1 && x.data[0].id === "kv-1");
  x = await call(envKV, "POST", "/api/tickets", { ip: "10.0.0.7", body: { title: "KV created" } });
  check("KV fallback create -> 201", x.status === 201 && x.data.title === "KV created");
  const kvid = x.data.id;
  x = await call(envKV, "PATCH", `/api/tickets/${kvid}`, { ip: "10.0.0.7", body: { column: "done" } });
  check("KV fallback patch -> 200", x.status === 200 && x.data.column === "done");
  x = await call(envKV, "DELETE", `/api/tickets/${kvid}`, { ip: "10.0.0.7" });
  check("KV fallback delete -> 200", x.status === 200 && x.data.deleted === true);
  // In-memory mutation cap on the KV path (fresh IP).
  let ok = 0, over = 0;
  for (let i = 0; i < 31; i++) {
    const y = await call(envKV, "POST", "/api/tickets", { ip: "10.0.0.8", body: { title: `kv cap ${i}` } });
    if (y.status === 201) ok++;
    else if (y.status === 429) over++;
  }
  check("KV fallback mutation cap: 30 then 429", ok === 30 && over === 1, `ok=${ok} over=${over}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
