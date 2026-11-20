#!/usr/bin/env node
/**
 * Harness for smart sleep/wake part 1 (worker/src/index.js):
 * keep-alive ON/OFF toggle + max-run guard.
 *
 * Runs the real Worker module with a mock D1 + a mock fetch that counts
 * every call. No deploy, no account, no network.
 *
 * Covers:
 *   - readKeepAliveEnabled distinguishes absent / '0' / '1' / invalid /
 *     thrown error (never swallows a read error into "absent").
 *   - The cron tick gate: OFF -> skip with ZERO fetches and ZERO D1
 *     mutations; unreadable/invalid -> HOLD (fail closed); absent -> ON.
 *   - POST /keepalive: Bearer WAKE_TOKEN only, exactly 2 D1 writes on
 *     success, 401/400/503/405 behaviour.
 *   - GET /status and GET /sleepwake/state expose the toggle state.
 *   - Max-run guard in decideSleepWake: 7h uptime sleeps even with
 *     recent visit/agent activity; WAKE and manual rest still win;
 *     419 min does not fire; unknown uptime does not fire.
 *
 * Fail-first: run against the pre-change module with
 *   SMART_SLEEP_SRC=/tmp/worker-index-before-smart-sleep.js node features/smart-sleep/harness-smart-sleep.mjs
 * and the new checks must FAIL (404 on /keepalive, no guard, no gate).
 *
 * Run: node features/smart-sleep/harness-smart-sleep.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.SMART_SLEEP_SRC || resolve(HERE, "..", "..", "worker", "src", "index.js");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

// --- mock D1 (in-memory; only the queries the sleep/wake path issues) ---
class MockD1 {
  constructor() {
    this.meta = new Map();
    this.status = new Map();
    this.routines = new Map(); // id -> payload JSON string
    this.metaWrites = 0;       // D1 mutations to the meta table
    this.throwKeys = new Set(); // meta keys whose read throws (simulates a D1 read failure)
  }
  prepare(sql) {
    const self = this;
    const makeStmt = (params) => ({
      async first() {
        if (/FROM meta WHERE key/.test(sql)) {
          if (self.throwKeys.has(params[0])) throw new Error("mock D1 read failure");
          const v = self.meta.get(params[0]);
          return v === undefined ? null : { value: v };
        }
        if (/FROM status WHERE key/.test(sql)) {
          const v = self.status.get(params[0]);
          return v === undefined ? null : { value: v };
        }
        if (/FROM write_budget WHERE day/.test(sql)) return null; // no budget row -> 0
        if (/MAX\(at\) AS m FROM routines_history/.test(sql)) return { m: null };
        return null;
      },
      async all() {
        if (/FROM routines_definitions/.test(sql)) {
          return { results: [...self.routines.entries()].map(([id, payload]) => ({ id, payload })) };
        }
        if (/FROM routines_history/.test(sql)) return { results: [] };
        if (/FROM meta WHERE key LIKE/.test(sql)) return { results: [] };
        return { results: [] };
      },
      async run() {
        if (/INTO meta \(key, value\)/.test(sql)) { self.metaWrites++; self.meta.set(params[0], String(params[1])); return { success: true }; }
        if (/INTO status \(key, value\)/.test(sql)) { self.status.set(params[0], String(params[1])); return { success: true }; }
        if (/INTO routines_definitions/.test(sql)) { self.routines.set(params[0], String(params[1])); return { success: true }; }
        if (/DELETE FROM routines_definitions/.test(sql)) { self.routines.clear(); return { success: true }; }
        if (/DELETE FROM routines_history/.test(sql)) return { success: true };
        if (/INTO routines_history/.test(sql)) return { success: true };
        if (/INTO write_budget/.test(sql)) return { success: true };
        return { success: true };
      },
    });
    const stmt = makeStmt([]);
    return { ...stmt, bind: (...params) => makeStmt(params) };
  }
}

class MockKV {
  constructor() { this.map = new Map(); this.puts = 0; }
  async get(k) { return this.map.get(k) ?? null; }
  async put(k, v) { this.puts++; this.map.set(k, v); }
}

const src = readFileSync(SRC, "utf8");
const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
const worker = mod.default;
const { decideSleepWake, readKeepAliveEnabled } = mod;
const hasToggleFn = typeof readKeepAliveEnabled === "function";

// Safe wrapper: on the pre-change module the export is missing, so the
// read checks fail instead of crashing the harness (fail-first).
async function kaRead(db) {
  if (!hasToggleFn) return { missing: true };
  try { return { value: await readKeepAliveEnabled(db) }; }
  catch (e) { return { threw: true, error: e }; }
}

// Mock fetch: records every call. The console probe, the Pages sleep call,
// and the InstaBox API are distinguished by URL.
function makeFetch(calls) {
  return async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || "GET" });
    if (u.includes("qwenpawx.pages.dev/api/machine/sleep")) {
      return new Response(JSON.stringify({ ok: true, sleeping: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("api.instabox.sh")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    // Console probe.
    return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
  };
}

function makeEnv(d1, opts = {}) {
  const env = {
    STATUS: new MockKV(),
    QWENPAW_DB: d1,
    USE_D1: "1",
    QWENPAW_URL: "https://8088-test.instabox.tech/",
    INSTABOX_MACHINE_ID: "m_test",
    PAGES_URL: "https://qwenpawx.pages.dev",
    SLEEP_TOKEN: "sleep-token-test",
    REPORTER_TOKEN: "reporter-token-test",
    WAKE_TOKEN: "wake-token-test",
  };
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

const req = (p, init = {}) => new Request("https://ka.test" + p, init);

async function tick(env, cron = "*/5 * * * *") {
  let pending;
  let result;
  await worker.scheduled({ cron }, env, { waitUntil: (p) => { pending = p; } });
  if (pending) result = await pending;
  return result;
}

// Run one tick with mock fetch installed; returns {result, calls}.
async function runTick(env) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetch(calls);
  try {
    const result = await tick(env);
    return { result, calls };
  } finally { globalThis.fetch = realFetch; }
}

const NOW = Date.parse("2026-11-17T16:00:00Z"); // 21:30 IST
const MIN = 60_000;

// Idle decision inputs for decideSleepWake (direct): no routines, no
// visit, no agent work, fresh reporter, up 60 min, last wake 60 min ago.
function idleInputs(over = {}) {
  return {
    nextRoutineAt: Infinity, lastVisitAt: null, lastAgentActivityAt: null,
    lastWakeAt: NOW - 60 * MIN, reporterStale: false, restActive: false,
    machineUp: true, uptimeMin: 60, sleepState: "running", ...over,
  };
}

// Idle tick setup (relative to REAL Date.now(), which the tick uses):
// no routines, fresh reporter, machine up, no visit, no agent work,
// up 60 min, last wake 60 min ago -> the tick sleeps via Pages.
function idleTickSetup(d1, over = {}) {
  const RT = Date.now();
  const report = {
    nextNativeRun: null, agentActive: false,
    agentLastActiveAt: RT - 20 * MIN, uptimeSec: 3600, reportedAt: RT - 60_000,
  };
  d1.status.set("qwenpaw:status", JSON.stringify({ status: "up", httpStatus: 200, lastUpAt: new Date(RT - 60 * MIN).toISOString(), checkedAt: new Date(RT - 5 * MIN).toISOString() }));
  d1.meta.set("sleepwake:report", JSON.stringify({ ...report, ...(over.report || {}) }));
  d1.meta.set("sleepwake:state", JSON.stringify({ mode: "running", since: RT - 60 * MIN, lastWakeAt: RT - 60 * MIN, ...(over.state || {}) }));
  if (over.lastVisitAt !== undefined && over.lastVisitAt !== null) {
    d1.meta.set("sleepwake:last-visit", String(over.lastVisitAt));
  }
  if (over.toggle !== undefined) d1.meta.set("keepalive:enabled", over.toggle);
  return RT;
}

console.log("readKeepAliveEnabled — absent / '0' / '1' / invalid / error");
{
  const d1 = new MockD1();
  check("readKeepAliveEnabled is exported", hasToggleFn);
  check("absent -> null (means ON)", (await kaRead(d1)).value === null);
  d1.meta.set("keepalive:enabled", "1");
  check("'1' -> '1'", (await kaRead(d1)).value === "1");
  d1.meta.set("keepalive:enabled", "0");
  check("'0' -> '0'", (await kaRead(d1)).value === "0");
  d1.meta.set("keepalive:enabled", "yes");
  const invalid = await kaRead(d1);
  check("invalid 'yes' is returned as-is (caller holds, never coerced)", invalid.value === "yes", JSON.stringify(invalid));
  const d1b = new MockD1();
  d1b.throwKeys.add("keepalive:enabled");
  const thrown = await kaRead(d1b);
  check("read error THROWS (never swallowed into null/absent)", thrown.threw === true, JSON.stringify(thrown));
}

console.log("decideSleepWake — max-run guard (direct)");
{
  check("uptime 420 + recent visit + recent agent -> sleep max_run_guard",
    (() => { const d = decideSleepWake(idleInputs({ uptimeMin: 420, lastVisitAt: NOW - 5 * MIN, lastAgentActivityAt: NOW - 5 * MIN }), NOW); return d.action === "sleep" && d.reason === "max_run_guard"; })());
  check("uptime 419 + recent activity -> hold (NOT max_run_guard)",
    (() => { const d = decideSleepWake(idleInputs({ uptimeMin: 419, lastVisitAt: NOW - 5 * MIN, lastAgentActivityAt: NOW - 5 * MIN }), NOW); return d.action === "hold" && d.reason !== "max_run_guard"; })());
  check("uptime 420 + routine due in 5 min + up -> hold (WAKE wins, no sleep)",
    (() => { const d = decideSleepWake(idleInputs({ uptimeMin: 420, nextRoutineAt: NOW + 5 * MIN }), NOW); return d.action === "hold" && d.reason !== "max_run_guard"; })());
  check("uptime 420 + routine due in 5 min + down -> wake (WAKE wins)",
    (() => { const d = decideSleepWake(idleInputs({ uptimeMin: 420, nextRoutineAt: NOW + 5 * MIN, machineUp: false, sleepState: "suspended" }), NOW); return d.action === "wake"; })());
  check("uptime 420 + routine due in 6 min + up -> sleep max_run_guard (outside the 5-min lookahead, WAKE does not win)",
    (() => { const d = decideSleepWake(idleInputs({ uptimeMin: 420, nextRoutineAt: NOW + 6 * MIN }), NOW); return d.action === "sleep" && d.reason === "max_run_guard"; })());
  check("uptime 420 + routine due in 6 min + down -> hold (outside the 5-min lookahead, guard needs the machine up)",
    (() => { const d = decideSleepWake(idleInputs({ uptimeMin: 420, nextRoutineAt: NOW + 6 * MIN, machineUp: false, sleepState: "suspended" }), NOW); return d.action === "hold" && d.reason !== "max_run_guard"; })());
  check("uptime unknown (0) + otherwise idle -> hold (fail closed)",
    (() => { const d = decideSleepWake(idleInputs({ uptimeMin: 0 }), NOW); return d.action === "hold" && d.reason !== "max_run_guard"; })());
  check("uptime 420 + manual rest -> hold (rest wins)",
    (() => { const d = decideSleepWake(idleInputs({ uptimeMin: 420, restActive: true }), NOW); return d.action === "hold" && d.reason !== "max_run_guard"; })());
  check("uptime 420 + machine down, no routine due -> hold (not up)",
    (() => { const d = decideSleepWake(idleInputs({ uptimeMin: 420, machineUp: false }), NOW); return d.action === "hold" && d.reason !== "max_run_guard"; })());
  check("uptime 420 + suspended state -> hold (not running)",
    (() => { const d = decideSleepWake(idleInputs({ uptimeMin: 420, sleepState: "suspended" }), NOW); return d.action === "hold" && d.reason !== "max_run_guard"; })());
  check("uptime 420 + unknown next routine -> hold (fail-awake still first)",
    (() => { const d = decideSleepWake(idleInputs({ uptimeMin: 420, nextRoutineAt: null }), NOW); return d.action === "hold" && d.reason !== "max_run_guard"; })());
}

console.log("cron tick gate — toggle OFF / ON / absent / unreadable / invalid");
{
  // Toggle '0' -> skip, ZERO fetches, ZERO D1 meta mutations.
  {
    const d1 = new MockD1();
    idleTickSetup(d1, { toggle: "0" });
    const before = d1.metaWrites;
    const { result, calls } = await runTick(makeEnv(d1));
    check("toggle '0' -> skip", result && result.action === "skip" && result.reason === "keepalive-off", JSON.stringify(result));
    check("toggle '0' -> ZERO fetch calls", calls.length === 0, `calls=${calls.length}`);
    check("toggle '0' -> ZERO D1 meta writes", d1.metaWrites === before, `writes=${d1.metaWrites - before}`);
  }
  // Toggle '1' -> decision identical to today (idle -> sleep via Pages, no probe).
  {
    const d1 = new MockD1();
    idleTickSetup(d1, { toggle: "1" });
    const { result, calls } = await runTick(makeEnv(d1));
    const sleepCalls = calls.filter((c) => c.url.includes("/api/machine/sleep"));
    const probeCalls = calls.filter((c) => c.url.includes("8088-test.instabox.tech"));
    check("toggle '1' idle -> Pages sleep exactly once (golden: same as today)", sleepCalls.length === 1, `sleepCalls=${sleepCalls.length}`);
    check("toggle '1' idle -> NO console probe", probeCalls.length === 0, `probeCalls=${probeCalls.length}`);
    const state = JSON.parse(d1.meta.get("sleepwake:state") || "{}");
    check("toggle '1' idle -> state sleeping", state.mode === "sleeping", `mode=${state.mode}`);
    void result;
  }
  // Toggle absent -> ON (falls through to decideSleepWake).
  {
    const d1 = new MockD1();
    idleTickSetup(d1, {});
    const { calls } = await runTick(makeEnv(d1));
    check("toggle absent idle -> Pages sleep exactly once (absent = ON)", calls.filter((c) => c.url.includes("/api/machine/sleep")).length === 1);
  }
  // Toggle read throws -> HOLD, zero fetches, zero writes.
  {
    const d1 = new MockD1();
    idleTickSetup(d1, { toggle: "1" });
    d1.throwKeys.add("keepalive:enabled");
    const before = d1.metaWrites;
    const { result, calls } = await runTick(makeEnv(d1));
    check("toggle read throws -> hold keepalive-read-error", result && result.action === "hold" && result.reason === "keepalive-read-error", JSON.stringify(result));
    check("toggle read throws -> ZERO fetch calls", calls.length === 0, `calls=${calls.length}`);
    check("toggle read throws -> ZERO D1 meta writes", d1.metaWrites === before, `writes=${d1.metaWrites - before}`);
  }
  // Toggle invalid value -> HOLD, zero fetches.
  {
    const d1 = new MockD1();
    idleTickSetup(d1, { toggle: "yes" });
    const { result, calls } = await runTick(makeEnv(d1));
    check("toggle 'yes' -> hold keepalive-read-error", result && result.action === "hold" && result.reason === "keepalive-read-error", JSON.stringify(result));
    check("toggle 'yes' -> ZERO fetch calls", calls.length === 0, `calls=${calls.length}`);
  }
  // Toggle OFF + due routine -> skip with no probe. (The routines
  // Worker's own scheduled wake is a separate worker and is unaffected.)
  {
    const d1 = new MockD1();
    const RT = idleTickSetup(d1, { toggle: "0", report: { nextNativeRun: Date.now() + 5 * MIN } });
    d1.meta.set("sleepwake:state", JSON.stringify({ mode: "sleeping", since: RT - 30 * MIN, lastWakeAt: RT - 60 * MIN }));
    d1.status.set("qwenpaw:status", JSON.stringify({ status: "sleeping", httpStatus: 0, lastUpAt: new Date(RT - 60 * MIN).toISOString() }));
    const { result, calls } = await runTick(makeEnv(d1));
    check("toggle OFF + due routine -> skip (no probe)", result && result.action === "skip" && result.reason === "keepalive-off", JSON.stringify(result));
    check("toggle OFF + due routine -> ZERO fetch calls", calls.length === 0, `calls=${calls.length}`);
  }
  // Toggle OFF + uptime 420 min -> skip, no sleep, zero fetches.
  {
    const d1 = new MockD1();
    idleTickSetup(d1, { toggle: "0", report: { uptimeSec: 420 * 60 }, lastVisitAt: Date.now() - 5 * MIN });
    const { result, calls } = await runTick(makeEnv(d1));
    check("toggle OFF + uptime 420 -> skip (guard never runs)", result && result.action === "skip" && result.reason === "keepalive-off", JSON.stringify(result));
    check("toggle OFF + uptime 420 -> ZERO fetch calls", calls.length === 0, `calls=${calls.length}`);
    check("toggle OFF + uptime 420 -> NO Pages sleep call", calls.filter((c) => c.url.includes("/api/machine/sleep")).length === 0);
  }
  // Toggle ON + uptime 420 + recent visit/agent -> sleep via the
  // max-run guard (via the tick, not just the pure function).
  {
    const d1 = new MockD1();
    idleTickSetup(d1, {
      toggle: "1",
      report: { uptimeSec: 420 * 60, agentLastActiveAt: Date.now() - 5 * MIN },
      lastVisitAt: Date.now() - 5 * MIN,
    });
    const { calls } = await runTick(makeEnv(d1));
    check("toggle ON + uptime 420 + recent activity -> Pages sleep once (guard via tick)",
      calls.filter((c) => c.url.includes("/api/machine/sleep")).length === 1, `calls=${JSON.stringify(calls.map((c) => c.url))}`);
    check("toggle ON + uptime 420 + recent activity -> NO console probe",
      calls.filter((c) => c.url.includes("8088-test.instabox.tech")).length === 0);
  }
}

console.log("POST /keepalive — auth, body, writes, errors");
{
  const kaReq = (body, headers = {}) => req("/keepalive", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const bearer = { Authorization: "Bearer wake-token-test" };

  // No bearer -> 401, enabled unchanged, zero writes.
  {
    const d1 = new MockD1();
    d1.meta.set("keepalive:enabled", "1");
    const before = d1.metaWrites;
    const r = await worker.fetch(kaReq({ enabled: false }), makeEnv(d1));
    check("POST /keepalive without bearer -> 401", r.status === 401, `status=${r.status}`);
    check("no bearer -> keepalive:enabled unchanged", d1.meta.get("keepalive:enabled") === "1");
    check("no bearer -> ZERO D1 meta writes", d1.metaWrites === before);
  }
  // Wrong bearer -> 401, no writes.
  {
    const d1 = new MockD1();
    const before = d1.metaWrites;
    const r = await worker.fetch(kaReq({ enabled: false }, { Authorization: "Bearer wrong" }), makeEnv(d1));
    check("POST /keepalive with wrong bearer -> 401", r.status === 401, `status=${r.status}`);
    check("wrong bearer -> ZERO D1 meta writes", d1.metaWrites === before);
  }
  // Correct bearer, enabled:false -> 200, exactly 2 writes, stored '0'.
  {
    const d1 = new MockD1();
    const before = d1.metaWrites;
    const r = await worker.fetch(kaReq({ enabled: false }, bearer), makeEnv(d1));
    const j = await r.json().catch(() => null);
    check("POST /keepalive correct bearer -> 200", r.status === 200, `status=${r.status}`);
    check("POST /keepalive -> enabled false in body", j && j.ok === true && j.enabled === false, JSON.stringify(j));
    check("POST /keepalive -> updatedAt is ISO", j && typeof j.updatedAt === "string" && Number.isFinite(Date.parse(j.updatedAt)), JSON.stringify(j));
    check("POST /keepalive -> exactly 2 D1 meta writes", d1.metaWrites - before === 2, `writes=${d1.metaWrites - before}`);
    check("POST /keepalive -> stored keepalive:enabled '0'", d1.meta.get("keepalive:enabled") === "0");
    check("POST /keepalive -> stored keepalive:updated matches response", d1.meta.get("keepalive:updated") === (j && j.updatedAt));
  }
  // Correct bearer, enabled:true -> 200, stored '1'.
  {
    const d1 = new MockD1();
    const r = await worker.fetch(kaReq({ enabled: true }, bearer), makeEnv(d1));
    const j = await r.json().catch(() => null);
    check("POST /keepalive enabled:true -> 200 + stored '1'", r.status === 200 && j && j.enabled === true && d1.meta.get("keepalive:enabled") === "1", `status=${r.status} stored=${d1.meta.get("keepalive:enabled")}`);
  }
  // Bad bodies -> 400, no writes.
  for (const [label, body] of [
    ["enabled as string", { enabled: "yes" }],
    ["missing enabled", {}],
    ["not JSON", "not json"],
    ["JSON array", [true]],
  ]) {
    const d1 = new MockD1();
    const before = d1.metaWrites;
    const r = await worker.fetch(kaReq(body, bearer), makeEnv(d1));
    check(`POST /keepalive bad body (${label}) -> 400`, r.status === 400, `status=${r.status}`);
    check(`POST /keepalive bad body (${label}) -> ZERO writes`, d1.metaWrites === before);
  }
  // WAKE_TOKEN unset -> 503.
  {
    const d1 = new MockD1();
    const before = d1.metaWrites;
    const r = await worker.fetch(kaReq({ enabled: false }, bearer), makeEnv(d1, { WAKE_TOKEN: undefined }));
    check("POST /keepalive WAKE_TOKEN unset -> 503", r.status === 503, `status=${r.status}`);
    check("WAKE_TOKEN unset -> ZERO writes", d1.metaWrites === before);
  }
  // ?token= in the query must NOT authenticate.
  {
    const d1 = new MockD1();
    const r = await worker.fetch(req("/keepalive?token=wake-token-test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) }), makeEnv(d1));
    check("POST /keepalive ?token= query -> 401 (header only)", r.status === 401, `status=${r.status}`);
  }
  // GET -> 405 with Allow: POST.
  {
    const d1 = new MockD1();
    const r = await worker.fetch(req("/keepalive"), makeEnv(d1));
    check("GET /keepalive -> 405", r.status === 405, `status=${r.status}`);
    check("GET /keepalive -> Allow: POST", r.headers.get("Allow") === "POST", `Allow=${r.headers.get("Allow")}`);
  }
}

console.log("GET /status + GET /sleepwake/state — toggle fields");
{
  // /status with toggle '0' -> keepAlive "off", updatedAt echoed.
  {
    const d1 = new MockD1();
    d1.meta.set("keepalive:enabled", "0");
    d1.meta.set("keepalive:updated", "2026-11-19T01:00:00.000Z");
    d1.status.set("qwenpaw:status", JSON.stringify({ status: "up", httpStatus: 200, checkedAt: new Date().toISOString() }));
    const r = await worker.fetch(req("/status"), makeEnv(d1));
    const j = await r.json();
    check("GET /status toggle '0' -> keepAlive off", j.keepAlive === "off", JSON.stringify(j.keepAlive));
    check("GET /status -> keepAliveUpdatedAt echoed", j.keepAliveUpdatedAt === "2026-11-19T01:00:00.000Z", JSON.stringify(j.keepAliveUpdatedAt));
  }
  // /status with toggle absent -> "on", updatedAt null.
  {
    const d1 = new MockD1();
    d1.status.set("qwenpaw:status", JSON.stringify({ status: "up", httpStatus: 200, checkedAt: new Date().toISOString() }));
    const r = await worker.fetch(req("/status"), makeEnv(d1));
    const j = await r.json();
    check("GET /status toggle absent -> keepAlive on", j.keepAlive === "on", JSON.stringify(j.keepAlive));
    check("GET /status toggle absent -> keepAliveUpdatedAt null", j.keepAliveUpdatedAt === null, JSON.stringify(j.keepAliveUpdatedAt));
  }
  // /status with toggle invalid -> "unknown".
  {
    const d1 = new MockD1();
    d1.meta.set("keepalive:enabled", "yes");
    d1.status.set("qwenpaw:status", JSON.stringify({ status: "up", httpStatus: 200, checkedAt: new Date().toISOString() }));
    const r = await worker.fetch(req("/status"), makeEnv(d1));
    const j = await r.json();
    check("GET /status toggle invalid -> keepAlive unknown", j.keepAlive === "unknown", JSON.stringify(j.keepAlive));
  }
  // /status with no D1 -> fields omitted.
  {
    const env = makeEnv(new MockD1(), { QWENPAW_DB: undefined, USE_D1: undefined });
    const r = await worker.fetch(req("/status"), env);
    const j = await r.json();
    check("GET /status no D1 -> keepAlive field omitted", !("keepAlive" in j) && !("keepAliveUpdatedAt" in j), JSON.stringify(Object.keys(j)));
  }
  // /status exposes the next scheduled run (the status page reads
  // d.sleepwake.nextRoutineAt). 2026-11-19 fix: the stored status never
  // carried a sleepwake field — the tick's hold-sleeping branch returns
  // it without saving — so the page always showed "Not scheduled".
  {
    const d1 = new MockD1();
    d1.status.set("qwenpaw:status", JSON.stringify({ status: "up", httpStatus: 200, checkedAt: new Date().toISOString() }));
    d1.routines.set("daily-summary", JSON.stringify({ id: "daily-summary", active: true, cron: "0 7 * * *", timezone: "Asia/Kolkata" }));
    const r = await worker.fetch(req("/status"), makeEnv(d1));
    const j = await r.json();
    check("GET /status -> sleepwake.nextRoutineAt is a finite ms epoch", j.sleepwake && Number.isFinite(j.sleepwake.nextRoutineAt), JSON.stringify(j.sleepwake));
    check("GET /status -> sleepwake.nextRoutineSource names the routine", j.sleepwake && j.sleepwake.nextRoutineSource === "d1:daily-summary", JSON.stringify(j.sleepwake));
  }
  // No routines + a report -> nextRoutineAt null (Infinity serializes as null).
  {
    const d1 = new MockD1();
    d1.status.set("qwenpaw:status", JSON.stringify({ status: "up", httpStatus: 200, checkedAt: new Date().toISOString() }));
    d1.meta.set("sleepwake:report", JSON.stringify({ nextNativeRun: null, agentActive: false, agentLastActiveAt: Date.now() - 20 * MIN, uptimeSec: 7200, reportedAt: Date.now() - 60_000 }));
    const r = await worker.fetch(req("/status"), makeEnv(d1));
    const j = await r.json();
    check("GET /status no routines -> sleepwake.nextRoutineAt null", j.sleepwake && j.sleepwake.nextRoutineAt === null, JSON.stringify(j.sleepwake));
  }
  // /status with no D1 -> sleepwake field omitted too.
  {
    const env = makeEnv(new MockD1(), { QWENPAW_DB: undefined, USE_D1: undefined });
    const r = await worker.fetch(req("/status"), env);
    const j = await r.json();
    check("GET /status no D1 -> sleepwake field omitted", !("sleepwake" in j), JSON.stringify(Object.keys(j)));
  }
  // /sleepwake/state gains keepAlive.
  {
    const d1 = new MockD1();
    d1.meta.set("keepalive:enabled", "0");
    d1.meta.set("sleepwake:report", JSON.stringify({ nextNativeRun: null, agentActive: false, agentLastActiveAt: Date.now() - 20 * MIN, uptimeSec: 7200, reportedAt: Date.now() - 60_000 }));
    const r = await worker.fetch(req("/sleepwake/state"), makeEnv(d1));
    const j = await r.json();
    check("GET /sleepwake/state toggle '0' -> keepAlive off", j.keepAlive === "off", JSON.stringify(j.keepAlive));
  }
  {
    const d1 = new MockD1();
    d1.meta.set("sleepwake:report", JSON.stringify({ nextNativeRun: null, agentActive: false, agentLastActiveAt: Date.now() - 20 * MIN, uptimeSec: 7200, reportedAt: Date.now() - 60_000 }));
    const r = await worker.fetch(req("/sleepwake/state"), makeEnv(d1));
    const j = await r.json();
    check("GET /sleepwake/state toggle absent -> keepAlive on", j.keepAlive === "on", JSON.stringify(j.keepAlive));
  }
  {
    const d1 = new MockD1();
    d1.meta.set("keepalive:enabled", "yes");
    d1.meta.set("sleepwake:report", JSON.stringify({ nextNativeRun: null, agentActive: false, agentLastActiveAt: Date.now() - 20 * MIN, uptimeSec: 7200, reportedAt: Date.now() - 60_000 }));
    const r = await worker.fetch(req("/sleepwake/state"), makeEnv(d1));
    const j = await r.json();
    check("GET /sleepwake/state toggle invalid -> keepAlive unknown", j.keepAlive === "unknown", JSON.stringify(j.keepAlive));
  }
}

console.log("stuck-state recovery — reporter_up (2026-11-19)");
{
  // Stuck setup: state says "sleeping" (reason probe_cooldown, as live
  // 2026-11-19) while the machine is up. The report is the machine-side
  // reporter (every 2 min). reportAgeMin overrides the report's age;
  // lastUpMin overrides the cached lastUpAt (the uptime lower bound).
  // The live reporter posts uptimeSec null (it cannot know run start),
  // so the default report below carries uptimeSec 3600 only when the
  // case says so — see the null-uptime case.
  function stuckSetup(d1, over = {}) {
    const RT = Date.now();
    const report = {
      nextNativeRun: null, agentActive: false,
      agentLastActiveAt: RT - 20 * MIN, uptimeSec: 3600, reportedAt: RT - 60_000,
      ...(over.report || {}),
    };
    if (over.reportAgeMin !== undefined) report.reportedAt = RT - over.reportAgeMin * MIN;
    d1.status.set("qwenpaw:status", JSON.stringify({ status: "up", httpStatus: 200, lastUpAt: new Date(RT - (over.lastUpMin ?? 60) * MIN).toISOString(), checkedAt: new Date(RT - 5 * MIN).toISOString() }));
    if (!over.noReport) d1.meta.set("sleepwake:report", JSON.stringify(report));
    d1.meta.set("sleepwake:state", JSON.stringify({ mode: "sleeping", since: RT - 30 * MIN, reason: "probe_cooldown", lastWakeAt: RT - 60 * MIN, ...(over.state || {}) }));
    if (over.lastVisitAt !== undefined && over.lastVisitAt !== null) d1.meta.set("sleepwake:last-visit", String(over.lastVisitAt));
    if (over.toggle !== undefined) d1.meta.set("keepalive:enabled", over.toggle);
    return RT;
  }
  const probeCalls = (calls) => calls.filter((c) => c.url.includes("8088-test.instabox.tech"));
  const sleepCalls = (calls) => calls.filter((c) => c.url.includes("/api/machine/sleep"));
  const readState = (d1) => JSON.parse(d1.meta.get("sleepwake:state") || "{}");

  // A. Fresh reporter (1 min) + recent visit -> recovery flips to
  // running, the decision holds (recent visit blocks idle sleep), the
  // tick probes once (normal running-state path), no Pages sleep.
  {
    const d1 = new MockD1();
    stuckSetup(d1, { reportAgeMin: 1, lastVisitAt: Date.now() - 5 * MIN });
    const { calls } = await runTick(makeEnv(d1));
    const s = readState(d1);
    check("stuck + fresh reporter (1 min) + recent visit -> state running (recovered)", s.mode === "running", `mode=${s.mode}`);
    check("stuck + fresh reporter -> reason reporter_up", s.reason === "reporter_up", `reason=${s.reason}`);
    check("stuck + fresh reporter -> state carries reporter uptimeSec 3600", s.uptimeSec === 3600, `uptimeSec=${s.uptimeSec}`);
    check("stuck + fresh reporter -> exactly 1 console probe (post-recovery hold path)", probeCalls(calls).length === 1, `probes=${probeCalls(calls).length}`);
    check("stuck + fresh reporter -> ZERO Pages sleep calls", sleepCalls(calls).length === 0, `sleep=${sleepCalls(calls).length}`);
  }
  // B. Reporter 6 min old: past the 5-min recovery window but inside
  // the 10-min staleness window — the tighter recovery bar must hold.
  {
    const d1 = new MockD1();
    stuckSetup(d1, { reportAgeMin: 6, lastVisitAt: Date.now() - 5 * MIN });
    const { calls } = await runTick(makeEnv(d1));
    const s = readState(d1);
    check("reporter 6 min old (past 5-min recovery, inside 10-min stale) -> state stays sleeping", s.mode === "sleeping", `mode=${s.mode}`);
    check("reporter 6 min old -> reason stays probe_cooldown", s.reason === "probe_cooldown", `reason=${s.reason}`);
    check("reporter 6 min old -> ZERO fetch calls", calls.length === 0, `calls=${calls.length}`);
  }
  // C. Reporter 11 min old: stale by the 10-min rule too.
  {
    const d1 = new MockD1();
    stuckSetup(d1, { reportAgeMin: 11, lastVisitAt: Date.now() - 5 * MIN });
    const { calls } = await runTick(makeEnv(d1));
    const s = readState(d1);
    check("reporter 11 min old (stale) -> state stays sleeping", s.mode === "sleeping", `mode=${s.mode}`);
    check("reporter 11 min old -> ZERO fetch calls", calls.length === 0, `calls=${calls.length}`);
  }
  // D. No report at all: nothing proves the machine is up.
  {
    const d1 = new MockD1();
    stuckSetup(d1, { noReport: true, lastVisitAt: Date.now() - 5 * MIN });
    const { calls } = await runTick(makeEnv(d1));
    const s = readState(d1);
    check("no report at all -> state stays sleeping", s.mode === "sleeping", `mode=${s.mode}`);
    check("no report at all -> ZERO fetch calls", calls.length === 0, `calls=${calls.length}`);
  }
  // E. The live 2026-11-19 case: stuck + fresh reporter + 7h uptime +
  // recent visit/agent (which block idle sleep but NOT the guard) ->
  // the guard fires in the SAME tick, with NO console probe at all:
  // the flip and the guard both run on reporter evidence alone.
  {
    const d1 = new MockD1();
    stuckSetup(d1, {
      reportAgeMin: 1, report: { uptimeSec: 420 * 60, agentLastActiveAt: Date.now() - 5 * MIN },
      lastVisitAt: Date.now() - 5 * MIN,
    });
    const { calls } = await runTick(makeEnv(d1));
    const s = readState(d1);
    check("stuck + fresh reporter + uptime 420 + recent activity -> Pages sleep exactly once (guard fires same tick)",
      sleepCalls(calls).length === 1, `sleep=${sleepCalls(calls).length}`);
    check("stuck + fresh reporter + uptime 420 -> ZERO console probes (flip + guard need no probe)", probeCalls(calls).length === 0, `probes=${probeCalls(calls).length}`);
    check("stuck + fresh reporter + uptime 420 -> final state sleeping", s.mode === "sleeping", `mode=${s.mode}`);
    check("stuck + fresh reporter + uptime 420 -> final reason max_run_guard", s.reason === "max_run_guard", `reason=${s.reason}`);
  }
  // F. Stale reporter claiming 7h uptime: the guard must NOT fire on
  // stale data — uptime falls back to lastUpAt (60 min) and the state
  // stays sleeping, so the guard never sees "running".
  {
    const d1 = new MockD1();
    stuckSetup(d1, {
      reportAgeMin: 11, report: { uptimeSec: 420 * 60 },
      lastVisitAt: Date.now() - 5 * MIN,
    });
    const { calls } = await runTick(makeEnv(d1));
    const s = readState(d1);
    check("stuck + stale reporter (11 min) claiming uptime 420 -> NO Pages sleep (guard inert on stale data)", sleepCalls(calls).length === 0, `sleep=${sleepCalls(calls).length}`);
    check("stuck + stale reporter claiming uptime 420 -> ZERO fetch calls", calls.length === 0, `calls=${calls.length}`);
    check("stuck + stale reporter claiming uptime 420 -> state stays sleeping", s.mode === "sleeping", `mode=${s.mode}`);
  }
  // G. 419 min boundary: recovery flips, guard does not fire.
  {
    const d1 = new MockD1();
    stuckSetup(d1, { reportAgeMin: 1, report: { uptimeSec: 419 * 60 }, lastVisitAt: Date.now() - 5 * MIN });
    const { calls } = await runTick(makeEnv(d1));
    const s = readState(d1);
    check("stuck + fresh reporter + uptime 419 -> state running (recovered)", s.mode === "running", `mode=${s.mode}`);
    check("stuck + fresh reporter + uptime 419 -> reason reporter_up", s.reason === "reporter_up", `reason=${s.reason}`);
    check("stuck + fresh reporter + uptime 419 -> ZERO Pages sleep calls (419 < 420)", sleepCalls(calls).length === 0, `sleep=${sleepCalls(calls).length}`);
  }
  // H. The LIVE reporter shape: it posts uptimeSec null (it cannot know
  // run start) — the recovery must still flip on reporter freshness
  // alone. 2026-11-19 STALE-BASELINE FIX: the flip used to record the
  // stored lastUpAt lower bound as the uptime (3600 here) — but lastUpAt
  // can predate the run by hours (live: frozen 2026-11-18T14:30:29Z,
  // true run ~07:45Z next day), so the guard fired every tick on 17.4h.
  // The flip now RESETS the run-start baseline first and records the
  // uptime from it (~0: the machine just came back), and the baseline
  // is what the guard reads afterwards.
  {
    const d1 = new MockD1();
    stuckSetup(d1, { reportAgeMin: 1, report: { uptimeSec: null }, lastVisitAt: Date.now() - 5 * MIN });
    const before = Date.now();
    const { calls } = await runTick(makeEnv(d1));
    const s = readState(d1);
    check("stuck + fresh reporter with uptimeSec null (live reporter shape) -> state running", s.mode === "running", `mode=${s.mode}`);
    check("stuck + fresh reporter with uptimeSec null -> reason reporter_up", s.reason === "reporter_up", `reason=${s.reason}`);
    check("stuck + fresh reporter with uptimeSec null -> state uptimeSec ~0 (baseline just reset, NOT the stale lastUpAt 3600)", s.uptimeSec !== null && s.uptimeSec < 60, `uptimeSec=${s.uptimeSec}`);
    const runStart = Number(d1.meta.get("sleepwake:run-start"));
    check("stuck + fresh reporter with uptimeSec null -> run-start baseline set to ~now", Number.isFinite(runStart) && Math.abs(runStart - before) < 60_000, `runStart=${runStart}`);
    check("stuck + fresh reporter with uptimeSec null -> ZERO Pages sleep calls (guard sees ~0, not 3600)", calls.filter((c) => c.url.includes("/api/machine/sleep")).length === 0);
    void calls;
  }
  // I. A finite reporter uptimeSec wins over lastUpAt.
  {
    const d1 = new MockD1();
    stuckSetup(d1, { reportAgeMin: 1, report: { uptimeSec: 5400 }, lastUpMin: 60, lastVisitAt: Date.now() - 5 * MIN });
    await runTick(makeEnv(d1));
    const s = readState(d1);
    check("stuck + fresh reporter uptimeSec 5400, lastUpAt 60 min -> state running", s.mode === "running", `mode=${s.mode}`);
    check("stuck + fresh reporter uptimeSec 5400 -> state uptimeSec 5400 (reporter wins over lastUpAt)", s.uptimeSec === 5400, `uptimeSec=${s.uptimeSec}`);
  }
  // J. Already running + fresh reporter: no recovery write to the
  // STATE at all — but 2026-11-19 STALE-BASELINE FIX: the tick now
  // initializes the run-start baseline when it is missing (exactly ONE
  // D1 meta write), from the reporter's uptimeSec when present. The
  // state itself is never overwritten and the baseline is set once,
  // never refreshed while up.
  {
    const d1 = new MockD1();
    stuckSetup(d1, { reportAgeMin: 1, state: { mode: "running", reason: "probe_up" }, lastVisitAt: Date.now() - 5 * MIN });
    const before = d1.metaWrites;
    const beforeMs = Date.now();
    await runTick(makeEnv(d1));
    const s = readState(d1);
    check("already running + fresh reporter -> reason stays probe_up (no recovery overwrite)", s.reason === "probe_up", `reason=${s.reason}`);
    check("already running + fresh reporter -> state has no uptimeSec (recovery did not touch it)", !("uptimeSec" in s), `uptimeSec=${s.uptimeSec}`);
    check("already running + fresh reporter -> exactly 1 D1 meta write (run-start baseline init)", d1.metaWrites === before + 1, `writes=${d1.metaWrites - before}`);
    const runStart = Number(d1.meta.get("sleepwake:run-start"));
    check("already running + fresh reporter -> baseline = now - reporter uptimeSec 3600 (exact, not now)", Number.isFinite(runStart) && Math.abs(runStart - (beforeMs - 3600 * 1000)) < 60_000, `runStart=${runStart}`);
  }
  // K. GET /sleepwake/state exposes the LIVE uptime (2026-11-19
  // stale-baseline fix: the field is the uptime the guard would use
  // right now — reporter uptimeSec (fresh) > run-start baseline >
  // unknown — not the value a past reporter_up flip recorded, which
  // sat stale at 62729 for hours after the flip).
  {
    const d1 = new MockD1();
    stuckSetup(d1, { reportAgeMin: 1, lastVisitAt: Date.now() - 5 * MIN });
    const beforeMs = Date.now();
    await runTick(makeEnv(d1));
    const r = await worker.fetch(req("/sleepwake/state"), makeEnv(d1));
    const j = await r.json();
    check("GET /sleepwake/state after recovery -> uptimeSec 3600 (live reporter value)", j.uptimeSec === 3600, `uptimeSec=${j.uptimeSec}`);
    check("GET /sleepwake/state after recovery -> mode running + reason reporter_up", j.mode === "running" && j.reason === "reporter_up", `mode=${j.mode} reason=${j.reason}`);
    const runStartAt = j.runStartAt ? Date.parse(j.runStartAt) : NaN;
    check("GET /sleepwake/state after recovery -> runStartAt = now - reporter uptimeSec 3600", Number.isFinite(runStartAt) && Math.abs(runStartAt - (beforeMs - 3600 * 1000)) < 60_000, `runStartAt=${j.runStartAt}`);
  }
  {
    const d1 = new MockD1();
    idleTickSetup(d1, {});
    const r = await worker.fetch(req("/sleepwake/state"), makeEnv(d1));
    const j = await r.json();
    check("GET /sleepwake/state with no recovery -> uptimeSec 3600 (live reporter value, NOT null)", j.uptimeSec === 3600, `uptimeSec=${j.uptimeSec}`);
    check("GET /sleepwake/state with no recovery -> runStartAt null (no tick has set a baseline)", j.runStartAt === null, `runStartAt=${j.runStartAt}`);
  }
}

console.log("run-start baseline — stale-baseline incident (2026-11-19)");
{
  // The 2026-11-19 live defect: the guard fired every 5-min tick on a
  // recorded uptime of 62729s (17.4h) while the true run was ~10 min
  // old. Root cause: the guard's uptime came from KV lastUpAt — the
  // last up-transition / last meaningful status change — which
  // write-on-change froze at 2026-11-18T14:30:29Z through the cooldown.
  // The fix: a D1 run-start baseline, set ONCE per run at the observed
  // down→up transition and never refreshed while up. These checks pin
  // that contract. Setup helper: like stuckSetup but the state starts
  // "running" (the live case) and the baseline is settable.
  function baselineSetup(d1, over = {}) {
    const RT = Date.now();
    const report = {
      nextNativeRun: null, agentActive: false,
      agentLastActiveAt: RT - 20 * MIN, uptimeSec: null, reportedAt: RT - 60_000,
      ...(over.report || {}),
    };
    if (over.reportAgeMin !== undefined) report.reportedAt = RT - over.reportAgeMin * MIN;
    d1.status.set("qwenpaw:status", JSON.stringify({ status: over.cachedStatus || "up", httpStatus: 200, lastUpAt: new Date(RT - (over.lastUpMin ?? 60) * MIN).toISOString(), checkedAt: new Date(RT - 5 * MIN).toISOString() }));
    if (!over.noReport) d1.meta.set("sleepwake:report", JSON.stringify(report));
    d1.meta.set("sleepwake:state", JSON.stringify({ mode: over.stateMode || "running", since: RT - 60 * MIN, reason: over.stateReason || "probe_up", lastWakeAt: RT - 60 * MIN, ...(over.state || {}) }));
    if (over.runStartMinAgo !== undefined) d1.meta.set("sleepwake:run-start", String(RT - over.runStartMinAgo * MIN));
    if (over.lastVisitAt !== undefined && over.lastVisitAt !== null) d1.meta.set("sleepwake:last-visit", String(over.lastVisitAt));
    return RT;
  }
  const probeCalls = (calls) => calls.filter((c) => c.url.includes("8088-test.instabox.tech"));
  const sleepCalls = (calls) => calls.filter((c) => c.url.includes("/api/machine/sleep"));
  const readState = (d1) => JSON.parse(d1.meta.get("sleepwake:state") || "{}");
  const readBaseline = (d1) => { const v = d1.meta.get("sleepwake:run-start"); return v === undefined ? null : Number(v); };

  // L1. THE LIVE CASE: already running, lastUpAt 17h stale, fresh
  // reporter with uptimeSec null, no baseline. Pre-fix the guard fired
  // on 1020 min; post-fix the tick reconciles the baseline to now and
  // the guard sees ~0.
  {
    const d1 = new MockD1();
    baselineSetup(d1, { reportAgeMin: 1, lastUpMin: 17 * 60, lastVisitAt: Date.now() - 5 * MIN });
    const before = Date.now();
    const { calls } = await runTick(makeEnv(d1));
    const s = readState(d1);
    const b = readBaseline(d1);
    check("LIVE already-running + stale lastUpAt 17h + fresh reporter -> ZERO Pages sleep calls (guard sees ~0, not 1020 min)", sleepCalls(calls).length === 0, `sleep=${sleepCalls(calls).length}`);
    check("LIVE already-running + stale lastUpAt 17h -> run-start baseline set to ~now", Number.isFinite(b) && Math.abs(b - before) < 60_000, `baseline=${b}`);
    check("LIVE already-running + stale lastUpAt 17h -> exactly 1 console probe (hold path)", probeCalls(calls).length === 1, `probes=${probeCalls(calls).length}`);
    check("LIVE already-running + stale lastUpAt 17h -> state stays running", s.mode === "running", `mode=${s.mode}`);
  }
  // L2. A genuinely 7h-old run still fires the guard — via the
  // BASELINE, not lastUpAt (lastUpAt here is a fresh 60 min, so the
  // pre-fix code would NOT fire: this is fail-first for the baseline
  // as the uptime source).
  {
    const d1 = new MockD1();
    baselineSetup(d1, { reportAgeMin: 1, runStartMinAgo: 425, lastUpMin: 60, lastVisitAt: Date.now() - 5 * MIN, report: { agentLastActiveAt: Date.now() - 5 * MIN } });
    const { calls } = await runTick(makeEnv(d1));
    const s = readState(d1);
    check("baseline 425 min + recent activity -> Pages sleep exactly once (guard fires on the baseline)", sleepCalls(calls).length === 1, `sleep=${sleepCalls(calls).length}`);
    check("baseline 425 min -> ZERO console probes (guard needs no probe)", probeCalls(calls).length === 0, `probes=${probeCalls(calls).length}`);
    check("baseline 425 min -> final reason max_run_guard", s.reason === "max_run_guard", `reason=${s.reason}`);
  }
  // L3. 419-min baseline: the guard does not fire.
  {
    const d1 = new MockD1();
    baselineSetup(d1, { reportAgeMin: 1, runStartMinAgo: 419, lastUpMin: 60, lastVisitAt: Date.now() - 5 * MIN });
    const { calls } = await runTick(makeEnv(d1));
    const s = readState(d1);
    check("baseline 419 min -> ZERO Pages sleep calls (419 < 420)", sleepCalls(calls).length === 0, `sleep=${sleepCalls(calls).length}`);
    check("baseline 419 min -> state stays running", s.mode === "running", `mode=${s.mode}`);
  }
  // L4. A STALE reporter must not reset the baseline and must not let
  // the guard fire on stale data: baseline 60 min old, reporter 30 min
  // old claiming 420 min, lastUpAt 17h stale. Pre-fix the guard fired
  // on lastUpAt (1020 min); post-fix the uptime comes from the
  // baseline (60 min) and the stale 420 claim is ignored.
  {
    const d1 = new MockD1();
    const RT = baselineSetup(d1, { reportAgeMin: 30, report: { uptimeSec: 420 * 60 }, runStartMinAgo: 60, lastUpMin: 17 * 60, lastVisitAt: Date.now() - 5 * MIN });
    const { calls } = await runTick(makeEnv(d1));
    const s = readState(d1);
    const b = readBaseline(d1);
    check("stale reporter (30 min) claiming 420 + baseline 60 min -> ZERO Pages sleep calls", sleepCalls(calls).length === 0, `sleep=${sleepCalls(calls).length}`);
    check("stale reporter -> baseline UNCHANGED (still ~60 min old)", Number.isFinite(b) && Math.abs(b - (RT - 60 * MIN)) < 60_000, `baseline=${b}`);
    check("stale reporter -> state stays running", s.mode === "running", `mode=${s.mode}`);
  }
  // L5. Probe transition: cached status "offline" + a probe that
  // answers up, reporter stale (so no reporter reconcile), no baseline
  // -> the probe itself is the down→up evidence and sets the baseline.
  {
    const d1 = new MockD1();
    baselineSetup(d1, { reportAgeMin: 30, cachedStatus: "offline", lastVisitAt: Date.now() - 5 * MIN });
    const before = Date.now();
    const { calls } = await runTick(makeEnv(d1));
    const b = readBaseline(d1);
    check("probe finds machine up after recorded offline -> baseline set to ~now", Number.isFinite(b) && Math.abs(b - before) < 60_000, `baseline=${b}`);
    check("probe transition -> ZERO Pages sleep calls", sleepCalls(calls).length === 0, `sleep=${sleepCalls(calls).length}`);
    check("probe transition -> exactly 1 console probe", probeCalls(calls).length === 1, `probes=${probeCalls(calls).length}`);
  }
  // L6. Steady state: the baseline is set ONCE per run and never
  // refreshed while up — a tick with a 60-min-old baseline leaves it
  // exactly where it was.
  {
    const d1 = new MockD1();
    const RT = baselineSetup(d1, { reportAgeMin: 1, runStartMinAgo: 60, lastVisitAt: Date.now() - 5 * MIN });
    const { calls } = await runTick(makeEnv(d1));
    const b = readBaseline(d1);
    check("steady state -> baseline UNCHANGED (still ~60 min old, never refreshed while up)", Number.isFinite(b) && Math.abs(b - (RT - 60 * MIN)) < 60_000, `baseline=${b}`);
    check("steady state -> ZERO Pages sleep calls", sleepCalls(calls).length === 0, `sleep=${sleepCalls(calls).length}`);
  }
  // L7. The endpoint after the live-case tick: runStartAt is the reset
  // baseline and uptimeSec is minutes, not hours.
  {
    const d1 = new MockD1();
    baselineSetup(d1, { reportAgeMin: 1, lastUpMin: 17 * 60, lastVisitAt: Date.now() - 5 * MIN });
    const before = Date.now();
    await runTick(makeEnv(d1));
    const r = await worker.fetch(req("/sleepwake/state"), makeEnv(d1));
    const j = await r.json();
    const runStartAt = j.runStartAt ? Date.parse(j.runStartAt) : NaN;
    check("endpoint after live-case tick -> runStartAt ~now", Number.isFinite(runStartAt) && Math.abs(runStartAt - before) < 60_000, `runStartAt=${j.runStartAt}`);
    check("endpoint after live-case tick -> uptimeSec < 300 (minutes, not 62729)", j.uptimeSec !== null && j.uptimeSec < 300, `uptimeSec=${j.uptimeSec}`);
  }
  // L8. The endpoint with nothing known: no baseline, no report, no
  // status -> uptimeSec null (unknown), runStartAt null.
  {
    const d1 = new MockD1();
    const r = await worker.fetch(req("/sleepwake/state"), makeEnv(d1));
    const j = await r.json();
    check("endpoint with nothing known -> uptimeSec null (unknown, never a stale number)", j.uptimeSec === null, `uptimeSec=${j.uptimeSec}`);
    check("endpoint with nothing known -> runStartAt null", j.runStartAt === null, `runStartAt=${j.runStartAt}`);
  }
}

console.log(`\nsmart-sleep harness: ${passed} passed, ${failed.length} failed`);
if (failed.length) { for (const f of failed) console.log("  FAILED:", f); process.exitCode = 1; }
