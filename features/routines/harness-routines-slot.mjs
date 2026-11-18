#!/usr/bin/env node
/**
 * Harness for the daily-summary slot exception (2026-11-18).
 *
 * The bug, verified live 2026-11-18 07:00 IST: the routines Worker's
 * 07:00:12 wake-tick AND 07:00:27 daily-summary-slot both recorded
 * "skipped" — "No routine due within 15 min (next 2026-11-19T01:30:00Z)".
 * The keep-alive had woken the machine at 06:50:58, so the next-run
 * pointer had already rolled to tomorrow and the sleep-aware 15-min
 * rule skipped the slot. Harmless that day (the wake worked), but a
 * failed keep-alive wake would have been a silent miss for the summary.
 *
 * The fix: the daily-summary slot ("30 1 * * *") always probes; the
 * 30-min wake-ticks keep the 15-min skip rule, so sleep is unaffected.
 *
 * What this proves, against the REAL worker module with a stubbed
 * fetch (200 = console answering) and an in-memory KV store:
 *   1. At 07:00:27 IST the daily-summary slot PROBES (qwenpaw "up").
 *   2. At the same instant a 30-min wake-tick still SKIPS.
 *   3. A wake-tick 15 min before the routine still PROBES (old rule kept).
 *   4. With no active routines the slot still SKIPS (nothing to wake for).
 *
 * Run: node features/routines/harness-routines-slot.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORKER = resolve(REPO, "features/routines/worker/src/index.js");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

// Stub fetch: the console answers 200. probeQwenPaw only needs
// res.status and res.body.cancel().
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  return { status: 200, body: { cancel: async () => {} } };
};

// In-memory KV namespace (the shape createStore's kvStore wraps).
function fakeKv() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, String(v)); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "" } = {}) => ({
      keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
    }),
  };
}

const DEFS = JSON.stringify([{
  id: "daily-summary",
  name: "Daily summary (07:00 IST)",
  cron: "0 7 * * *",
  timezone: "Asia/Kolkata",
  active: true,
}]);

function makeEnv(defsJson) {
  const kv = fakeKv();
  kv.put("routines:definitions", defsJson);
  return { QWENPAW_URL: "https://example.invalid/", STATUS: kv };
}

const ctx = { waitUntil(p) { p.catch(() => {}); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const worker = (await import(pathToFileURL(WORKER).href)).default;

// Date.now drives scheduledTick's decision (rtNextRoutine uses it).
// 2026-11-18T01:30:27Z = 07:00:27 IST, the exact live failing instant.
const realNow = Date.now;
async function runTick(env, cron, atMs) {
  Date.now = () => atMs;
  fetchCalls = 0;
  try {
    // The Worker's scheduled() handler awaits the tick but returns
    // undefined, so read the recorded entry back from history (the
    // audit trail is what the live /api/history endpoint serves).
    await worker.scheduled({ cron }, env, ctx);
    await sleep(100);
    const raw = await env.STATUS.get("routines:history");
    const hist = raw ? JSON.parse(raw) : [];
    return { entry: hist[0] || null, fetchCalls };
  } finally {
    Date.now = realNow;
  }
}

const T_SLOT = Date.parse("2026-11-18T01:30:27.000Z");
const T_BEFORE = Date.parse("2026-11-18T01:15:00.000Z");

// 1. Daily-summary slot at the live failing instant must probe.
{
  const r = await runTick(makeEnv(DEFS), "30 1 * * *", T_SLOT);
  check("slot at 07:00:27 probes (qwenpaw up)", r.entry?.qwenpaw === "up", JSON.stringify(r.entry));
  check("slot at 07:00:27 got HTTP 200", r.entry?.httpStatus === 200, JSON.stringify(r.entry));
  check("slot at 07:00:27 actually fetched", r.fetchCalls === 1, `fetchCalls=${r.fetchCalls}`);
  check("slot kind is daily-summary-slot", r.entry?.kind === "daily-summary-slot", JSON.stringify(r.entry));
}

// 2. Same instant, 30-min wake-tick must still skip (sleep preserved).
{
  const r = await runTick(makeEnv(DEFS), "*/30 * * * *", T_SLOT);
  check("wake-tick at 07:00:27 still skips", r.entry?.qwenpaw === "skipped", JSON.stringify(r.entry));
  check("wake-tick at 07:00:27 fetched nothing", r.fetchCalls === 0, `fetchCalls=${r.fetchCalls}`);
}

// 3. Wake-tick 15 min before the routine must probe (old rule kept).
{
  const r = await runTick(makeEnv(DEFS), "*/30 * * * *", T_BEFORE);
  check("wake-tick 15 min before routine probes", r.entry?.qwenpaw === "up", JSON.stringify(r.entry));
}

// 4. No active routines: the slot still skips (nothing to wake for).
{
  const r = await runTick(makeEnv("[]"), "30 1 * * *", T_SLOT);
  check("slot with no routines still skips", r.entry?.qwenpaw === "skipped", JSON.stringify(r.entry));
  check("slot with no routines fetched nothing", r.fetchCalls === 0, `fetchCalls=${r.fetchCalls}`);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
