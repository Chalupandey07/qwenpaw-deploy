#!/usr/bin/env node
/**
 * Harness for B-5 — the preview must not be re-fetched or re-hashed every poll.
 *
 * B-5 as recorded: `nyPreview.src` was reassigned on every 10 s poll while a
 * needs-you record existed — 360 requests/hour, 88-254 MB/hour of egress for a
 * screen that had not changed.
 *
 * The UI half is fixed in `ui.html` (src carries the sha, so it only changes
 * when the screen does). This harness covers the half that was still broken:
 * the SERVER. `openNeedsYou()` loaded the whole 243-707 KB PNG and hashed it,
 * and `stateFor()` loaded and hashed it again for its own `preview` field — so
 * every 10 s poll read ~1.4 MB from D1 and ran two SHA-256 passes, whether or
 * not anything changed. The bytes never reached the browser, but the cost was
 * identical to the bug being fixed.
 *
 * The assertions are therefore about COST, measured against a real SQLite
 * database: how many rows are read, and how many bytes cross the D1 boundary,
 * for a poll that should cost almost nothing.
 *
 * Run: node features/computer/harness-preview-refetch.mjs
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

const S = await import("data:text/javascript;base64," +
  Buffer.from(readFileSync(resolve(REPO, "pages/public/computer/state.js"), "utf8")).toString("base64"));

// ---------------------------------------------------------------- fixtures
// The LIVE schema, verbatim from features/storage/migrate-kv-to-d1.py. Using
// the real DDL is the point: a harness against an invented schema is the B-23
// failure mode (a parallel schema passes every test written against itself).
const db = new DatabaseSync(":memory:");
for (const sql of [
  "CREATE TABLE leases (computer TEXT PRIMARY KEY, lease_id TEXT NOT NULL, holder TEXT NOT NULL, granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, fence INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE generations (computer TEXT PRIMARY KEY, gen INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE needs_you (computer TEXT PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL, run_id TEXT)",
  "CREATE TABLE modes (agent TEXT PRIMARY KEY, mode TEXT NOT NULL)",
  "CREATE TABLE previews (computer TEXT PRIMARY KEY, png BLOB NOT NULL, updated_at TEXT NOT NULL)",
]) db.exec(sql);

/**
 * D1 stub over real SQLite that MEASURES what the code reads.
 * `bytes` counts BLOB bytes returned to the caller — the quantity that
 * actually costs money on D1 and the one this fix is about.
 */
const stats = { queries: 0, blobBytes: 0, writes: 0, statements: [] };
function measure(sql, params, fn) {
  stats.queries += 1;
  stats.statements.push(sql.replace(/\s+/g, " ").trim().slice(0, 70));
  return fn();
}
function wrap(sql, params) {
  const st = db.prepare(sql);
  return {
    run() { stats.writes += 1; return measure(sql, params, () => { const r = st.run(...params); return { success: true, meta: { changes: r.changes } }; }); },
    first() {
      return measure(sql, params, () => {
        const row = st.get(...params);
        if (row === undefined) return null;
        for (const v of Object.values(row)) if (v instanceof Uint8Array) stats.blobBytes += v.byteLength;
        return row;
      });
    },
    all() {
      return measure(sql, params, () => {
        const rows = st.all(...params);
        for (const row of rows) for (const v of Object.values(row)) if (v instanceof Uint8Array) stats.blobBytes += v.byteLength;
        return { results: rows };
      });
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
const env = { COMPUTER_DB: d1 };
const reset = () => { stats.queries = 0; stats.blobBytes = 0; stats.writes = 0; stats.statements = []; };

// A realistic preview: measured live at 500,476 B (:1) and 707,262 B (:2).
const PNG = new Uint8Array(707_262);
for (let i = 0; i < PNG.length; i += 1) PNG[i] = i % 251;
const SHA = "9f2c" + "ab".repeat(30);

console.log("preview: the write path is change-only");
{
  reset();
  const first = await S.putPreview(env, "default", PNG, SHA);
  check("the first upload writes", first.ok === true && first.unchanged === false,
    JSON.stringify(first));
  const bytesWritten = stats.blobBytes;
  reset();
  const second = await S.putPreview(env, "default", PNG, SHA);
  check("an identical upload writes nothing", second.ok === true && second.unchanged === true,
    JSON.stringify(second));
  check("and reads no blob bytes to decide",
    stats.blobBytes === 0, `${stats.blobBytes} B read (was ${bytesWritten} B written)`);
  check("it performs no write at all", stats.writes === 0, String(stats.writes));

  // Use a SEPARATE computer: writing a different hash to `default` here would
  // change the fixture the later cost assertions read, which is exactly the
  // kind of self-inflicted ordering bug this suite is meant to avoid.
  reset();
  const third = await S.putPreview(env, "qa", PNG, "different-hash");
  check("a changed screen does write", third.unchanged === false, JSON.stringify(third));
  check("…and the untouched computer still holds its own hash",
    (await S.previewMeta(env, "default")).sha256 === SHA);
}

console.log("preview: a state poll costs almost nothing (this is the B-5 fix)");
{
  reset();
  const meta = await S.previewMeta(env, "default");
  check("metadata reports the hash", meta && meta.sha256 === SHA, JSON.stringify(meta));
  check("metadata reports the size", meta && meta.bytes === PNG.byteLength, String(meta && meta.bytes));
  check("reading it touches ZERO blob bytes", stats.blobBytes === 0,
    `${stats.blobBytes} B — the old code read the whole PNG here`);

  // Ten polls is 100 s of an open tab, i.e. exactly what B-5 measured.
  reset();
  for (let i = 0; i < 10; i += 1) await S.previewMeta(env, "default");
  check("10 polls read 0 blob bytes", stats.blobBytes === 0, `${stats.blobBytes} B`);
  check("10 polls cost 10 small queries", stats.queries === 10, String(stats.queries));
  check("10 polls write nothing", stats.writes === 0, String(stats.writes));
}

console.log("preview: openNeedsYou no longer loads the blob");
{
  await d1.prepare("INSERT INTO needs_you (computer, text, at, run_id) VALUES (?,?,?,?)")
    .bind("default", "Please sign in to Gmail", new Date().toISOString(), "run-1").run();
  reset();
  const rec = await S.openNeedsYou(env, "default");
  check("the record carries the preview hash", rec && rec.previewSha === SHA, JSON.stringify(rec));
  check("the record carries the agent's text", rec && /sign in/i.test(rec.text), rec && rec.text);
  check("reading it touches ZERO blob bytes", stats.blobBytes === 0,
    `${stats.blobBytes} B — this is the 10 s poll path`);
}

console.log("preview: the image itself is only sent when the hash changed");
{
  reset();
  const prev = await S.getPreview(env, "default");
  check("getPreview returns the bytes", prev && prev.png.byteLength === PNG.byteLength,
    String(prev && prev.png.byteLength));
  check("it returns the stored hash", prev.sha256 === SHA, prev.sha256);
  check("it does NOT re-hash the blob (hash comes from metadata)",
    stats.queries <= 2, `${stats.queries} queries: ${stats.statements.join(" | ")}`);
}

console.log("preview: an unchanged screen never rewrites (the quota rule)");
{
  reset();
  // Simulate a machine-side uploader that polls every 120 s for an hour on a
  // screen that never changes: 30 captures, all identical.
  for (let i = 0; i < 30; i += 1) await S.putPreview(env, "default", PNG, SHA);
  check("30 identical captures produce ZERO writes", stats.writes === 0, String(stats.writes));
  check("…and zero blob bytes read", stats.blobBytes === 0, `${stats.blobBytes} B`);
  // The recorded numbers: the old unconditional uploader was 5,760-11,500/day.
  check("the old uploader's 30 captures would have been 30 writes",
    30 > stats.writes, `old=30, new=${stats.writes}`);
}

console.log("preview: a missing metadata row falls back, never breaks");
{
  // A preview written before preview_meta existed must still serve.
  await d1.prepare("INSERT INTO previews (computer, png, updated_at) VALUES (?,?,?)")
    .bind("legacy", PNG.slice(0, 1024), new Date().toISOString()).run();
  const legacy = await S.getPreview(env, "legacy");
  check("a legacy row still returns bytes", legacy && legacy.png.byteLength === 1024,
    String(legacy && legacy.png.byteLength));
  check("and still gets a hash (derived as a fallback)",
    legacy && /^[0-9a-f]{64}$/.test(legacy.sha256), legacy && legacy.sha256);
}

console.log("preview: the UI only re-points the image when the hash changes");
{
  const ui = readFileSync(resolve(REPO, "pages/public/computer/ui.html"), "utf8");
  check("the img src carries the sha",
    ui.includes('/computer/preview?computer="') && ui.includes("&v=") && ui.includes("record.previewSha"),
    "without the sha in the URL the browser cannot cache it");
  check("it is guarded by a hash comparison",
    ui.includes("record.previewSha !== state.lastPreviewSha"),
    "the guard is the actual fix — a new src on every poll is 360 req/hour");
  check("no timer reassigns the image src",
    !/setInterval\([^)]*preview[^)]*\)/i.test(ui),
    "the poll must refresh state, never the image element");
}

console.log("preview: the route answers 304 on a matching ETag");
{
  const router = readFileSync(resolve(REPO, "pages/public/computer/router.js"), "utf8");
  check("the preview sets an ETag from the sha",
    router.includes('etag = `"${row.sha256}"`'), "no ETag means no conditional request");
  check("a matching If-None-Match returns 304 without the body",
    router.includes("If-None-Match") && router.includes("status: 304"),
    "304 is what makes a poll cost nothing on the wire");
  check("the state route uses metadata, not the blob",
    (() => {
      // Scope the assertion to stateFor(): the /computer/preview IMAGE route
      // must of course still call getPreview, because that route's job is to
      // return bytes. The bug was stateFor doing it too.
      const start = router.indexOf("async function stateFor");
      const end = router.indexOf("/** Mint a screen URL", start);
      const body = router.slice(start, end);
      return body.includes("S.previewMeta(env, computer)") && !body.includes("S.getPreview");
    })(),
    "stateFor used to load the full preview a second time per poll");
}

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
