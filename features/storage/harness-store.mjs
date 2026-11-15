// Harness for features/storage/store.js — the D1-backed KV-shaped store.
// Mock D1 binding backed by REAL SQLite (node:sqlite), so the SQL in
// store.js is genuinely exercised (upserts, WHERE clauses, BLOBs,
// batching, expiry). The KV fallback path is tested with an in-memory
// Map-backed mock KV. Run: node features/storage/harness-store.mjs
import { DatabaseSync } from "node:sqlite";
import { createStore } from "./store.js";

const DDL = [
  "CREATE TABLE leases (computer TEXT PRIMARY KEY, lease_id TEXT NOT NULL, holder TEXT NOT NULL, granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, fence INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE generations (computer TEXT PRIMARY KEY, gen INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE needs_you (computer TEXT PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL, run_id TEXT)",
  "CREATE TABLE teach_skills (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE modes (agent TEXT PRIMARY KEY, mode TEXT NOT NULL)",
  "CREATE TABLE previews (computer TEXT PRIMARY KEY, png BLOB NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE routines_history (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, qwenpaw TEXT NOT NULL, http_status INTEGER, note TEXT, active_routines TEXT NOT NULL DEFAULT '[]', raw TEXT NOT NULL DEFAULT '')",
  "CREATE TABLE routines_pending (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  "CREATE TABLE routines_definitions (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
  "CREATE TABLE status (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE write_budget (day TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)",
];

// Mock of the Workers D1 binding API over node:sqlite.
function mockD1() {
  const db = new DatabaseSync(":memory:");
  for (const sql of DDL) db.exec(sql);
  const api = {
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
  return api;
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

const db = mockD1();
const kv = mockKV();
const envD1 = { USE_D1: "1", QWENPAW_DB: db };
const envKV = { USE_D1: "0" };
const store = createStore(envD1, kv);

// --- leases ---
await store.put("lease:default", JSON.stringify({ leaseId: "L1", holder: "user", grantedAt: 1000, expiresAt: 90000, fence: 1 }));
let lease = JSON.parse(await store.get("lease:default"));
check("lease put/get round-trip", eq(lease, { leaseId: "L1", holder: "user", grantedAt: 1000, expiresAt: 90000, fence: 1 }));
await store.put("lease:default", JSON.stringify({ leaseId: "L2", holder: "user", grantedAt: 2000, expiresAt: 92000, fence: 2 }));
check("lease upsert replaces", (JSON.parse(await store.get("lease:default"))).leaseId === "L2");
await store.delete("lease:default");
check("lease delete", (await store.get("lease:default")) === null);
check("lease missing -> null", (await store.get("lease:qa")) === null);

// --- generations ---
await store.put("generation:default", "19");
check("generation put/get", (await store.get("generation:default")) === "19");
await store.put("generation:default", "20");
check("generation upsert", (await store.get("generation:default")) === "20");

// --- needs-you (per-computer + legacy fallback) ---
await store.put("needsyou:default", JSON.stringify({ text: "sign in", at: "2026-11-15T00:00:00Z", runId: "r1" }));
await store.put("needsyou:qa", JSON.stringify({ text: "captcha", at: "2026-11-15T00:01:00Z", runId: "r2" }));
check("needs-you default", JSON.parse(await store.get("needsyou:default")).text === "sign in");
check("needs-you qa isolated", JSON.parse(await store.get("needsyou:qa")).text === "captcha");
check("needs-you legacy key reads default", JSON.parse(await store.get("needsyou")).text === "sign in");
await store.delete("needsyou:qa");
check("needs-you resolve clears only qa", (await store.get("needsyou:qa")) === null && JSON.parse(await store.get("needsyou:default")).text === "sign in");

// --- previews (base64 string at the interface, raw BLOB in D1) ---
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 5000 }, (_, i) => i % 251)]);
let b64 = Buffer.from(png).toString("base64");
await store.put("preview:default", b64);
const back = await store.get("preview:default");
check("preview base64 round-trip", back === b64, `len ${back && back.length} vs ${b64.length}`);
const stored = db._raw.prepare("SELECT length(png) AS n, typeof(png) AS t FROM previews WHERE computer='default'").get();
check("preview stored as BLOB, not base64 text", stored.t === "blob" && stored.n === png.length, JSON.stringify(stored));
check("preview missing -> null", (await store.get("preview:qa")) === null);

// --- teach skills (list = one SELECT, no N+1) ---
await store.put("teach-skill:taught-aaaa1111", JSON.stringify({ id: "taught-aaaa1111", name: "demo", at: "2026-11-15T00:00:00Z" }));
await store.put("teach-skill:taught-bbbb2222", JSON.stringify({ id: "taught-bbbb2222", name: "demo2", at: "2026-11-15T00:01:00Z" }));
const listed = await store.list({ prefix: "teach-skill:" });
check("teach list returns both ids", eq(listed.keys.map((k) => k.name).sort(), ["teach-skill:taught-aaaa1111", "teach-skill:taught-bbbb2222"]));
check("teach get", JSON.parse(await store.get("teach-skill:taught-aaaa1111")).name === "demo");
await store.delete("teach-skill:taught-bbbb2222");
check("teach delete", (await store.get("teach-skill:taught-bbbb2222")) === null);

// --- modes / budget / meta / status ---
await store.put("computerMode:default", "private");
check("mode put/get", (await store.get("computerMode:default")) === "private");
await store.put("budget:2026-11-15", "449");
check("budget put/get", (await store.get("budget:2026-11-15")) === "449");
await store.put("lastWake", "1794703931242");
check("lastWake put/get", (await store.get("lastWake")) === "1794703931242");
await store.put("qwenpaw:status", JSON.stringify({ status: "up", httpStatus: 200 }));
check("status put/get", JSON.parse(await store.get("qwenpaw:status")).status === "up");

// --- routines history (diff put, chronological get, 50-cap) ---
const h1 = [{ at: "2026-11-15T07:00:00.000Z", kind: "wake-tick", cron: "*/30 * * * *", qwenpaw: "up", httpStatus: 200, note: "n1", activeRoutines: ["daily-summary"] }];
await store.put("routines:history", JSON.stringify(h1));
let got = JSON.parse(await store.get("routines:history"));
check("history first put (cron field preserved via raw)", got.length === 1 && got[0].cron === "*/30 * * * *" && got[0].activeRoutines[0] === "daily-summary");
const h2 = [...h1, { at: "2026-11-15T07:30:00.000Z", kind: "wake-tick", cron: "*/30 * * * *", qwenpaw: "up", httpStatus: 200, note: "n2", activeRoutines: [] }];
await store.put("routines:history", JSON.stringify(h2));
got = JSON.parse(await store.get("routines:history"));
check("history append-only put keeps order + count", got.length === 2 && got[1].note === "n2");
const many = Array.from({ length: 60 }, (_, i) => ({ at: `2026-11-15T${String(8 + Math.floor(i / 2)).padStart(2, "0")}:${String((i % 2) * 30).padStart(2, "0")}:00.000Z`, kind: "wake-tick", qwenpaw: "up", httpStatus: 200, note: `n${i}` }));
await store.put("routines:history", JSON.stringify(many));
got = JSON.parse(await store.get("routines:history"));
check("history pruned to 50", got.length === 50, `got ${got.length}`);
check("history prune keeps newest", got[49].note === "n59" && got[0].note === "n10");

// --- routines definitions (full replace, few rows) ---
await store.put("routines:definitions", JSON.stringify([{ id: "daily-summary", name: "Daily" }, { id: "wake", name: "Wake" }]));
got = JSON.parse(await store.get("routines:definitions"));
check("definitions put/get", got.length === 2 && got[0].id === "daily-summary");
await store.put("routines:definitions", JSON.stringify([{ id: "daily-summary", name: "Daily v2" }]));
got = JSON.parse(await store.get("routines:definitions"));
check("definitions replace", got.length === 1 && got[0].name === "Daily v2");

// --- routines pending (expiry enforced on read) ---
await store.put("routines:pending:trig-1", JSON.stringify({ id: "trig-1" }), { expirationTtl: 3600 });
check("pending put/get", JSON.parse(await store.get("routines:pending:trig-1")).id === "trig-1");
await store.put("routines:pending:trig-old", JSON.stringify({ id: "trig-old" }), { expirationTtl: -10 });
check("pending expired -> null", (await store.get("routines:pending:trig-old")) === null);
const plist = await store.list({ prefix: "routines:pending:" });
check("pending list excludes expired", eq(plist.keys.map((k) => k.name), ["routines:pending:trig-1"]));
await store.delete("routines:pending:trig-1");
check("pending delete", (await store.get("routines:pending:trig-1")) === null);

// --- unknown key fallback (meta) ---
await store.put("some-future-key", "hello");
check("unknown key via meta", (await store.get("some-future-key")) === "hello");

// --- "json" get parity (the Pages worker calls get(key, "json")) ---
await store.put("lease:default", JSON.stringify({ leaseId: "J1", holder: "user", grantedAt: 1, expiresAt: 2, fence: 0 }));
check("D1 get(key, json) parses", eq(await store.get("lease:default", "json"), { leaseId: "J1", holder: "user", grantedAt: 1, expiresAt: 2, fence: 0 }));
check("D1 get(missing, json) -> null", (await store.get("lease:qa", "json")) === null);

// --- KV fallback (USE_D1 unset / DB unbound) ---
const kvStore = createStore(envKV, kv);
await kvStore.put("lease:default", JSON.stringify({ leaseId: "K1" }));
check("KV fallback put/get", (await kvStore.get("lease:default")) === JSON.stringify({ leaseId: "K1" }));
check("KV fallback get(key, json)", eq(await kvStore.get("lease:default", "json"), { leaseId: "K1" }));
check("no store at all -> null", createStore({ USE_D1: "0" }, null) === null);
check("USE_D1 set but no binding + no KV -> null", createStore({ USE_D1: "1" }, null) === null);
const noDb = createStore({ USE_D1: "1" }, kv); // flag on, no binding
await noDb.put("generation:qa", "7");
check("USE_D1 without binding falls back to KV", (await kv.get("generation:qa")) === "7");

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
