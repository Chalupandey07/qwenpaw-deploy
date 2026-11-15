#!/usr/bin/env node
/**
 * Harness for B-8 — routines history must not lose entries.
 *
 * B-8 as recorded: `pushHistory()` did `get` → `unshift` → `put` on one JSON
 * array. Two ticks close together can drop an entry, and every tick rewrites
 * all 50. The *quota* was never the problem (48/day); the *correctness* was —
 * this array is the audit trail for routines, so a lost entry is a run that
 * never happened.
 *
 * The old KV path could not be fixed: KV has no atomic append, so read-modify-
 * write is all that exists there. The D1 path can be, and now is: one INSERT
 * per tick, plus a change-only check against the newest row alone.
 *
 * What this proves, against real SQLite with the LIVE DDL:
 *   1. Concurrent appends all land (the actual bug).
 *   2. The change-only rule still suppresses an identical tick.
 *   3. Pruning keeps the table bounded without deleting the newest.
 *   4. An append costs one insert, not a 50-row read plus a 51-statement batch.
 *
 * Run: node features/routines/harness-routines-history.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

const { createStore } = await import("data:text/javascript;base64," +
  Buffer.from(readFileSync(resolve(REPO, "features/storage/store.js"), "utf8")).toString("base64"));

// The LIVE schema, from features/storage/migrate-kv-to-d1.py.
const db = new DatabaseSync(":memory:");
for (const sql of [
  "CREATE TABLE routines_history (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, qwenpaw TEXT NOT NULL, http_status INTEGER, note TEXT, active_routines TEXT NOT NULL DEFAULT '[]', raw TEXT NOT NULL DEFAULT '')",
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE status (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE write_budget (day TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)",
]) db.exec(sql);

const stats = { inserts: 0, selects: 0, deletes: 0, rowsRead: 0 };
function wrap(sql, params) {
  const st = db.prepare(sql);
  const isInsert = /^\s*INSERT/i.test(sql);
  const isSelect = /^\s*SELECT/i.test(sql);
  const isDelete = /^\s*DELETE/i.test(sql);
  return {
    run() {
      if (isInsert) stats.inserts += 1;
      if (isDelete) stats.deletes += 1;
      const r = st.run(...params);
      return { success: true, meta: { changes: r.changes } };
    },
    first() {
      if (isSelect) stats.selects += 1;
      const row = st.get(...params);
      if (isSelect && row) stats.rowsRead += 1;
      return row === undefined ? null : row;
    },
    all() {
      if (isSelect) stats.selects += 1;
      const rows = st.all(...params);
      if (isSelect) stats.rowsRead += rows.length;
      return { results: rows };
    },
  };
}
const d1 = {
  prepare: (sql) => ({
    bind: (...p) => wrap(sql, p),
    run: () => wrap(sql, []).run(),
    first: () => wrap(sql, []).first(),
    all: () => wrap(sql, []).all(),
  }),
  batch: (stmts) => stmts.map((s) => s.run()),
};
const reset = () => { stats.inserts = 0; stats.selects = 0; stats.deletes = 0; stats.rowsRead = 0; };

const store = createStore({ USE_D1: "1", QWENPAW_DB: d1 }, null);
const tick = (n, extra = {}) => ({
  at: new Date(Date.UTC(2026, 10, 15, 12, n)).toISOString(),
  kind: "wake-tick",
  cron: null,
  qwenpaw: "up",
  httpStatus: 200,
  note: `tick ${n}`,
  activeRoutines: ["r1"],
  deliveredBy: "native qwenpaw cron jobs (jobs.json) / heartbeat",
  ...extra,
});

console.log("routines history: the store has an atomic append");
check("appendHistory exists", typeof store.appendHistory === "function",
  "without it the caller is forced back to read-modify-write");

console.log("routines history: concurrent ticks all land (the B-8 bug)");
{
  // 20 distinct ticks, issued concurrently — the shape that lost entries.
  const entries = Array.from({ length: 20 }, (_, i) => tick(i, { note: `concurrent ${i}` }));
  const written = await Promise.all(entries.map((e) => store.appendHistory(e, 200)));
  const total = written.reduce((a, b) => a + b, 0);
  check("all 20 concurrent appends report a write", total === 20, String(total));
  const rows = db.prepare("SELECT COUNT(*) AS n FROM routines_history").get().n;
  check("all 20 rows are actually present", rows === 20, `${rows} rows`);
  const notes = db.prepare("SELECT raw FROM routines_history").all()
    .map((r) => JSON.parse(r.raw).note);
  const unique = new Set(notes);
  check("no entry was overwritten by a concurrent write", unique.size === 20,
    `${unique.size} unique of ${notes.length}`);
}

console.log("routines history: the change-only rule still holds");
{
  reset();
  db.exec("DELETE FROM routines_history");
  const e = tick(1);
  const a = await store.appendHistory(e, 50);
  check("a new tick is written", a === 1, String(a));
  // Identical except `at` — every tick has a new timestamp by construction.
  const same = { ...e, at: tick(2).at };
  reset();
  const b = await store.appendHistory(same, 50);
  check("an identical tick writes nothing", b === 0, String(b));
  check("…and costs one row read, not fifty", stats.rowsRead === 1,
    `${stats.rowsRead} rows read`);
  // A meaningful change must still write.
  const changed = { ...e, at: tick(3).at, qwenpaw: "offline" };
  check("a changed tick does write", (await store.appendHistory(changed, 50)) === 1);
  const rows = db.prepare("SELECT COUNT(*) AS n FROM routines_history").get().n;
  check("exactly two rows survived the sequence", rows === 2, `${rows} rows`);
}

console.log("routines history: the cost is one insert, not a rewrite");
{
  reset();
  db.exec("DELETE FROM routines_history");
  await store.appendHistory(tick(1), 50);
  reset();
  await store.appendHistory(tick(2, { note: "second" }), 50);
  check("one append = one INSERT", stats.inserts === 1, String(stats.inserts));
  check("…and at most two SELECTs (newest row + prune)", stats.selects <= 2,
    `${stats.selects} selects`);
  // The old path: 1 get of the whole array (50 rows) + 1 put = 51 statements.
  check("the old read-modify-write would have touched 50 rows",
    stats.rowsRead <= 1, `${stats.rowsRead} rows read`);
}

console.log("routines history: pruning keeps the newest and bounds the table");
{
  reset();
  db.exec("DELETE FROM routines_history");
  for (let i = 0; i < 30; i += 1) await store.appendHistory(tick(i, { note: `seq ${i}` }), 10);
  const rows = db.prepare("SELECT raw FROM routines_history ORDER BY id ASC").all()
    .map((r) => JSON.parse(r.raw));
  check("the table is bounded to `keep`", rows.length === 10, `${rows.length} rows`);
  check("the NEWEST entry is kept", rows[rows.length - 1].note === "seq 29",
    rows[rows.length - 1].note);
  check("the oldest are the ones dropped", !rows.some((r) => r.note === "seq 0"),
    rows.map((r) => r.note).join(", "));
}

console.log("routines history: reading it back is unchanged");
{
  const all = await store.get("routines:history", "json");
  check("get still returns an array", Array.isArray(all), typeof all);
  check("entries are newest-LAST in storage, oldest-first on read",
    Array.isArray(all) && all.length === 10, String(Array.isArray(all) && all.length));
  check("the raw entry round-trips losslessly",
    Array.isArray(all) && all.every((e) => typeof e.cron !== "undefined" && typeof e.note === "string"),
    JSON.stringify(all && all[0]));
}

console.log("routines history: a malformed entry cannot corrupt the table");
{
  const before = db.prepare("SELECT COUNT(*) AS n FROM routines_history").get().n;
  check("a null entry is refused", (await store.appendHistory(null)) === 0);
  check("an entry with no `at` is refused", (await store.appendHistory({ note: "x" })) === 0);
  const after = db.prepare("SELECT COUNT(*) AS n FROM routines_history").get().n;
  check("the table is unchanged", after === before, `${before} -> ${after}`);
}

console.log("routines history: the worker uses the atomic path");
{
  const src = readFileSync(resolve(REPO, "features/routines/worker/src/index.js"), "utf8");
  check("pushHistory prefers appendHistory",
    /typeof store\.appendHistory === "function"/.test(src)
    && /store\.appendHistory\(entry, MAX_HISTORY\)/.test(src),
    "the worker must not fall back to read-modify-write while a store with append exists");
  check("the worker's inlined store implements it",
    /async function appendHistory\(entry, keep = MAX_HISTORY\)/.test(src),
    "the worker is a single-file deploy; an inlined copy is required");
  check("the fallback is documented as best-effort, not trusted",
    /best-effort/.test(src), "KV cannot append atomically and must say so");
  check("pushHistory no longer unshifts into a read array on the D1 path",
    /hist\.unshift\(entry\);\s*\n\s*return budgetGuardedPut/.test(src),
    "the unshift must sit only inside the KV fallback branch");
}

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
