#!/usr/bin/env node
/**
 * Harness for intelligent sleep/wake (worker/src/index.js + the reporter).
 *
 * The point of this file is the decision the keep-alive cron makes BEFORE it
 * probes: probing wakes the machine, so a probe-first tick can never sleep.
 * These checks pin the contract:
 *   - nextRun computes the next routine time (daily 07:00 IST, weekly, steps).
 *   - decideSleepWake is pure and fails CLOSED (unknown routine / stale
 *     reporter / recent visit / recent agent work / short uptime -> hold).
 *   - the cron tick sleeps only when every guard passes (marker first, then
 *     suspend via Pages), wakes only when a routine is due, and never
 *     probes a machine it intentionally put to sleep.
 *   - POST /report authenticates the reporter and stores its facts.
 *
 * Runs the real Worker module with a mock D1 + mock fetch. No deploy, no
 * account, no network. The reporter's Python selftest is the companion
 * (features/sleepwake/reporter.py --selftest, T109).
 *
 * Run: node features/sleepwake/harness-sleepwake.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "..", "worker", "src", "index.js");

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
  }
  prepare(sql) {
    const self = this;
    const makeStmt = (params) => ({
      async first() {
        if (/FROM meta WHERE key/.test(sql)) {
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
        if (/INTO meta \(key, value\)/.test(sql)) { self.meta.set(params[0], String(params[1])); return { success: true }; }
        if (/INTO status \(key, value\)/.test(sql)) { self.status.set(params[0], String(params[1])); return { success: true }; }
        if (/INTO routines_definitions/.test(sql)) { self.routines.set(params[0], String(params[1])); return { success: true }; }
        if (/DELETE FROM routines_definitions/.test(sql)) { self.routines.clear(); return { success: true }; }
        if (/DELETE FROM routines_history/.test(sql)) return { success: true };
        if (/INTO routines_history/.test(sql)) return { success: true };
        if (/INTO write_budget/.test(sql)) return { success: true };
        return { success: true };
      },
    });
    // D1PreparedStatement has first/all/run directly (no bind needed when
    // there are no parameters) as well as bind(). The Worker calls both
    // shapes, so the mock must too.
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
const { decideSleepWake, nextRun } = mod;

// Mock fetch: records every call. The console probe, the Pages sleep call,
// and the InstaBox API are distinguished by URL.
function makeFetch(calls) {
  return async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || "GET" });
    // v3 (2026-11-23, corrected 2026-11-28): the tick suspends through
    // InstaBox DIRECTLY, not through Pages. A POST to .../machines/{id}/suspend
    // is the suspend; a POST to /wake is the wake fallback. (The original
    // PATCH with {desiredState:"suspended"} returns 400 unknown_field.)
    if (u.includes("/suspend") && (init.method || "GET") === "POST") {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("api.instabox.sh")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    // Console probe.
    return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
  };
}

/**
 * Is this call a SUSPEND? v3 (2026-11-23, corrected 2026-11-28) suspends
 * through InstaBox directly (POST .../machines/{id}/suspend), not through
 * Pages. The predicate keeps the old Pages URL too, so a regression back to
 * that path is still counted — and still visible.
 */
function isSuspendCall(c) {
  const m = (c.method || "GET").toUpperCase();
  return (
    (c.url.includes("/suspend") && m === "POST") ||
    c.url.includes("/api/machine/sleep")
  );
}

function makeEnv(d1, calls) {
  return {
    STATUS: new MockKV(),
    QWENPAW_DB: d1,
    USE_D1: "1",
    QWENPAW_URL: "https://8088-test.instabox.tech/",
    INSTABOX_MACHINE_ID: "m_test",
    PAGES_URL: "https://qwenpawx.pages.dev",
    SLEEP_TOKEN: "sleep-token-test",
    // v3 (2026-11-23): the Worker suspends the machine itself, so it needs the
    // InstaBox key. In production this is the same secret the API-wake
    // fallback has always read — a deploy PREREQUISITE, asserted below.
    INSTABOX_API_KEY: "instabox-key-test",
    REPORTER_TOKEN: "reporter-token-test",
    WAKE_TOKEN: "wake-token-test",
  };
}

const req = (p, init = {}) => new Request("https://ka.test" + p, init);

async function tick(env, cron = "*/5 * * * *") {
  let pending;
  await worker.scheduled({ cron }, env, { waitUntil: (p) => { pending = p; } });
  if (pending) await pending;
}

const NOW = Date.parse("2026-11-17T16:00:00Z"); // 21:30 IST
const MIN = 60_000;

console.log("nextRun — cron to next routine");
{
  const at = nextRun("0 7 * * *", "Asia/Kolkata", NOW);
  check("daily 07:00 IST -> next day 01:30 UTC", at === Date.parse("2026-11-18T01:30:00Z"), new Date(at).toISOString());
  const at2 = nextRun("0 7 * * *", "Asia/Kolkata", Date.parse("2026-11-17T00:30:00Z"));
  check("same-day 07:00 IST", at2 === Date.parse("2026-11-17T01:30:00Z"), new Date(at2).toISOString());
  const at3 = nextRun("0 9 * * mon", "Asia/Kolkata", NOW);
  check("weekly Monday 09:00 IST", at3 === Date.parse("2026-11-23T03:30:00Z"), new Date(at3).toISOString());
  const at4 = nextRun("*/30 * * * *", "Asia/Kolkata", NOW);
  check("every 30 min", at4 === Date.parse("2026-11-17T16:30:00Z"), new Date(at4).toISOString());
  let threw = false;
  try { nextRun("0 7 * *", "Asia/Kolkata", NOW); } catch { threw = true; }
  check("bad cron (4 fields) throws", threw);
  threw = false;
  try { nextRun("0 25 * * *", "Asia/Kolkata", NOW); } catch { threw = true; }
  check("bad cron (hour 25) throws", threw);
  threw = false;
  try { nextRun("0 7 * * *", "No/Such_Zone", NOW); } catch { threw = true; }
  check("bad timezone throws (never a silent wrong time)", threw);
}

console.log("decideSleepWake — pure decision, fail closed");
{
  const idle = {
    nextRoutineAt: Infinity, lastVisitAt: null, lastAgentActivityAt: null,
    lastWakeAt: NOW - 60 * MIN, reporterStale: false, restActive: false,
    machineUp: true, uptimeMin: 60, sleepState: "running",
  };
  check("idle (no routines, no visit, no agent, fresh reporter) -> sleep",
    decideSleepWake(idle, NOW).action === "sleep");
  check("unknown nextRoutineAt -> hold (fail-awake)",
    decideSleepWake({ ...idle, nextRoutineAt: null }, NOW).action === "hold");
  check("stale reporter -> hold",
    decideSleepWake({ ...idle, reporterStale: true }, NOW).action === "hold");
  check("recent visit (5 min ago) -> hold",
    decideSleepWake({ ...idle, lastVisitAt: NOW - 5 * MIN }, NOW).action === "hold");
  check("recent agent activity (5 min ago) -> hold",
    decideSleepWake({ ...idle, lastAgentActivityAt: NOW - 5 * MIN }, NOW).action === "hold");
  check("old visit (21 min ago) + old agent (11 min ago) -> sleep",
    decideSleepWake({ ...idle, lastVisitAt: NOW - 21 * MIN, lastAgentActivityAt: NOW - 11 * MIN }, NOW).action === "sleep");
  check("visit 19 min ago -> hold (inside the 20-min visit idle)",
    decideSleepWake({ ...idle, lastVisitAt: NOW - 19 * MIN, lastAgentActivityAt: NOW - 11 * MIN }, NOW).action === "hold");
  check("short uptime (10 min) -> hold",
    decideSleepWake({ ...idle, uptimeMin: 10 }, NOW).action === "hold");
  check("manual rest -> hold",
    decideSleepWake({ ...idle, restActive: true }, NOW).action === "hold");
  check("machine down -> hold (never sleep a machine that is not up)",
    decideSleepWake({ ...idle, machineUp: false }, NOW).action === "hold");
  check("transition (waking) -> hold",
    decideSleepWake({ ...idle, sleepState: "waking" }, NOW).action === "hold");
  check("transition (suspending) -> hold",
    decideSleepWake({ ...idle, sleepState: "suspending" }, NOW).action === "hold");
  check("woke 5 min ago -> hold (deadband: 20 min after a wake)",
    decideSleepWake({ ...idle, lastWakeAt: NOW - 5 * MIN }, NOW).action === "hold");
  check("woke 25 min ago -> sleep (deadband passed)",
    decideSleepWake({ ...idle, lastWakeAt: NOW - 25 * MIN }, NOW).action === "sleep");
  const dueSoon = { ...idle, nextRoutineAt: NOW + 4 * MIN, machineUp: false, sleepState: "suspended" };
  check("routine due in 4 min + machine down -> wake",
    decideSleepWake(dueSoon, NOW).action === "wake");
  check("routine due in 4 min + machine up -> hold (already up)",
    decideSleepWake({ ...dueSoon, machineUp: true, sleepState: "running" }, NOW).action === "hold");
  check("routine due in 6 min + machine down -> hold (outside the 5-min lookahead)",
    decideSleepWake({ ...idle, nextRoutineAt: NOW + 6 * MIN, machineUp: false, sleepState: "suspended" }, NOW).action === "hold");
  check("routine due in 6 min + machine up -> sleep (outside the 5-min lookahead; it will wake in time)",
    decideSleepWake({ ...idle, nextRoutineAt: NOW + 6 * MIN }, NOW).action === "sleep");
  check("routine due in 30 min -> sleep (outside the 5-min lookahead; it will wake in time)",
    decideSleepWake({ ...idle, nextRoutineAt: NOW + 30 * MIN }, NOW).action === "sleep");
  check("overdue routine (5 min ago) + machine down -> wake (never sleep past a routine)",
    decideSleepWake({ ...idle, nextRoutineAt: NOW - 5 * MIN, machineUp: false, sleepState: "suspended" }, NOW).action === "wake");
  check("overdue routine + machine up -> hold",
    decideSleepWake({ ...idle, nextRoutineAt: NOW - 5 * MIN }, NOW).action === "hold");
}

console.log("POST /report — reporter auth + storage");
{
  const d1 = new MockD1();
  const env = makeEnv(d1, []);
  const body = { nextNativeRun: null, agentActive: false, agentLastActiveAt: NOW - 20 * MIN, uptimeSec: 7200 };
  let r = await worker.fetch(req("/report", { method: "POST", headers: { "Content-Type": "application/json", "X-Reporter-Token": "reporter-token-test" }, body: JSON.stringify(body) }), env);
  check("report with valid token -> 200", r.status === 200, `status=${r.status}`);
  const stored = JSON.parse(d1.meta.get("sleepwake:report") || "null");
  check("report stored in D1 meta", stored && stored.agentLastActiveAt === NOW - 20 * MIN);
  r = await worker.fetch(req("/report", { method: "POST", headers: { "Content-Type": "application/json", "X-Reporter-Token": "wrong" }, body: JSON.stringify(body) }), env);
  check("report with wrong token -> 401", r.status === 401);
  r = await worker.fetch(req("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
  check("report with no token -> 401", r.status === 401);
  r = await worker.fetch(req("/report", { method: "POST", headers: { "Content-Type": "application/json", "X-Reporter-Token": "reporter-token-test" }, body: "not json" }), env);
  check("report with bad JSON -> 400", r.status === 400);
  const envNoToken = makeEnv(d1, []);
  delete envNoToken.REPORTER_TOKEN;
  r = await worker.fetch(req("/report", { method: "POST", headers: { "Content-Type": "application/json", "X-Reporter-Token": "reporter-token-test" }, body: JSON.stringify(body) }), envNoToken);
  check("report when REPORTER_TOKEN unset -> 503 (fail closed)", r.status === 503);
}

console.log("GET /sleepwake/state — decision inputs, no secrets");
{
  const d1 = new MockD1();
  const env = makeEnv(d1, []);
  d1.routines.set("daily-summary", JSON.stringify({ id: "daily-summary", active: true, cron: "0 7 * * *", timezone: "Asia/Kolkata", name: "Daily summary" }));
  // reportedAt is relative to REAL now (the endpoint uses Date.now(), not
  // the test's frozen NOW), so the reporter is fresh.
  d1.meta.set("sleepwake:report", JSON.stringify({ nextNativeRun: null, agentActive: false, agentLastActiveAt: Date.now() - 20 * MIN, uptimeSec: 7200, reportedAt: Date.now() - 60_000 }));
  const r = await worker.fetch(req("/sleepwake/state"), env);
  const j = await r.json();
  check("/sleepwake/state -> 200", r.status === 200, `status=${r.status}`);
  // Next 07:00 IST from real now (01:30 UTC today if before then, else tomorrow).
  const nowMs = Date.now();
  const today0130 = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate(), 1, 30);
  const expectedNext = nowMs < today0130 ? today0130 : today0130 + 24 * 60 * 60 * 1000;
  check("next routine is the 07:00 daily summary", j.nextRoutineAt === expectedNext, `got ${j.nextRoutineAt}, expected ${expectedNext}`);
  check("next routine source is d1", j.nextRoutineSource === "d1:daily-summary", `got ${j.nextRoutineSource}`);
  check("reporter is fresh", j.reporterFresh === true);
  check("no secret leaks in the state", !JSON.stringify(j).includes("reporter-token-test") && !JSON.stringify(j).includes("sleep-token-test"));
  // No routines at all and no reporter report -> nextRoutineAt is null
  // (unknown, fail-awake), NOT Infinity. Native jobs are unreadable from
  // the Worker, so "no report" cannot prove "no routines".
  const d1b = new MockD1();
  const envb = makeEnv(d1b, []);
  const rb = await worker.fetch(req("/sleepwake/state"), envb);
  const jb = await rb.json();
  check("no routines + no report -> nextRoutineAt is null (unknown)",
    jb.nextRoutineAt === null, `got ${jb.nextRoutineAt}`);
}

console.log("cron tick — sleep, wake, hold (the decision before the probe)");
{
  // The tick uses REAL Date.now(), so all time-sensitive values here are
  // relative to Date.now(), not the frozen NOW above.
  const RT = Date.now();
  // IDLE: no routines, fresh reporter, machine up, no visit, no agent work,
  // up 60 min, last wake 60 min ago -> SLEEP (marker first, then Pages).
  const d1 = new MockD1();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetch(calls);
  try {
    d1.status.set("qwenpaw:status", JSON.stringify({ status: "up", httpStatus: 200, lastUpAt: new Date(RT - 60 * MIN).toISOString(), checkedAt: new Date(RT - 5 * MIN).toISOString() }));
    d1.meta.set("sleepwake:report", JSON.stringify({ nextNativeRun: null, agentActive: false, agentLastActiveAt: RT - 20 * MIN, uptimeSec: 3600, reportedAt: RT - 60_000 }));
    d1.meta.set("sleepwake:state", JSON.stringify({ mode: "running", since: RT - 60 * MIN, lastWakeAt: RT - 60 * MIN }));
    const env = makeEnv(d1, calls);
    await tick(env);
    const sleepCalls = calls.filter((c) => isSuspendCall(c));
    const probeCalls = calls.filter((c) => c.url.includes("8088-test.instabox.tech"));
    check("idle tick calls Pages /api/machine/sleep exactly once", sleepCalls.length === 1, `sleepCalls=${sleepCalls.length}`);
    check("idle tick does NOT probe the console (a probe would wake it)", probeCalls.length === 0, `probeCalls=${probeCalls.length}`);
    const state = JSON.parse(d1.meta.get("sleepwake:state") || "{}");
    check("sleep state is 'sleeping' after a successful suspend", state.mode === "sleeping", `mode=${state.mode}`);
  } finally { globalThis.fetch = realFetch; }

  // ROUTINE DUE: daily summary in 4 min, machine sleeping -> WAKE (probe).
  const d1b = new MockD1();
  const callsB = [];
  globalThis.fetch = makeFetch(callsB);
  try {
    d1b.routines.set("daily-summary", JSON.stringify({ id: "daily-summary", active: true, cron: "0 7 * * *", timezone: "Asia/Kolkata" }));
    // The D1 daily summary is 07:00 IST (hours away), so the native run is
    // the one that is due (4 min from now, inside the 5-min lookahead).
    d1b.meta.set("sleepwake:report", JSON.stringify({ nextNativeRun: RT + 4 * MIN, agentActive: false, agentLastActiveAt: RT - 20 * MIN, uptimeSec: 3600, reportedAt: RT - 60_000 }));
    d1b.meta.set("sleepwake:state", JSON.stringify({ mode: "sleeping", since: RT - 30 * MIN, lastWakeAt: RT - 60 * MIN }));
    d1b.status.set("qwenpaw:status", JSON.stringify({ status: "sleeping", httpStatus: 0, lastUpAt: new Date(RT - 60 * MIN).toISOString() }));
    const envB = makeEnv(d1b, callsB);
    await tick(envB);
    const probeB = callsB.filter((c) => c.url.includes("8088-test.instabox.tech"));
    const sleepB = callsB.filter((c) => isSuspendCall(c));
    check("routine-due tick probes the console (wake)", probeB.length >= 1, `probeCalls=${probeB.length}`);
    check("routine-due tick does NOT suspend", sleepB.length === 0);
    const stateB = JSON.parse(d1b.meta.get("sleepwake:state") || "{}");
    check("wake state is 'running' after the probe says up", stateB.mode === "running", `mode=${stateB.mode}`);
  } finally { globalThis.fetch = realFetch; }

  // HOLD WHILE ASLEEP: machine sleeping, no routine due, no visit -> stay
  // quiet (no probe, no suspend). The report here is STALE (30 min):
  // a truly sleeping machine's reporter is asleep too, so its report
  // cannot be fresh. A FRESH report + "sleeping" state is the stuck
  // state (2026-11-19), which the reporter_up recovery now flips —
  // see the companion block below. Before the recovery this case used
  // a 1-min-old report and still expected no probe; that expectation
  // encoded the stuck-state bug, so it was wrong and is fixed here.
  const d1c = new MockD1();
  const callsC = [];
  globalThis.fetch = makeFetch(callsC);
  try {
    d1c.meta.set("sleepwake:report", JSON.stringify({ nextNativeRun: null, agentActive: false, agentLastActiveAt: RT - 20 * MIN, uptimeSec: 3600, reportedAt: RT - 30 * MIN }));
    d1c.meta.set("sleepwake:state", JSON.stringify({ mode: "sleeping", since: RT - 30 * MIN, lastWakeAt: RT - 60 * MIN }));
    d1c.status.set("qwenpaw:status", JSON.stringify({ status: "sleeping", httpStatus: 0, lastUpAt: new Date(RT - 60 * MIN).toISOString() }));
    const envC = makeEnv(d1c, callsC);
    await tick(envC);
    check("sleeping + nothing due -> no probe", callsC.filter((c) => c.url.includes("8088-test.instabox.tech")).length === 0, `calls=${callsC.length}`);
    check("sleeping + nothing due -> no suspend", callsC.filter((c) => isSuspendCall(c)).length === 0);
  } finally { globalThis.fetch = realFetch; }

  // STUCK-STATE RECOVERY (2026-11-19): state "sleeping" but the
  // reporter reported 1 min ago — the machine is up, the state is
  // stranded. The tick flips it to "running" (reporter_up) and probes
  // (normal running-state path); it does NOT suspend (recent visit
  // blocks idle sleep and uptime is 60 min, far below the guard).
  const d1c2 = new MockD1();
  const callsC2 = [];
  globalThis.fetch = makeFetch(callsC2);
  try {
    d1c2.meta.set("sleepwake:report", JSON.stringify({ nextNativeRun: null, agentActive: false, agentLastActiveAt: RT - 20 * MIN, uptimeSec: 3600, reportedAt: RT - 60_000 }));
    d1c2.meta.set("sleepwake:state", JSON.stringify({ mode: "sleeping", since: RT - 30 * MIN, reason: "probe_cooldown", lastWakeAt: RT - 60 * MIN }));
    d1c2.status.set("qwenpaw:status", JSON.stringify({ status: "sleeping", httpStatus: 0, lastUpAt: new Date(RT - 60 * MIN).toISOString() }));
    d1c2.meta.set("sleepwake:last-visit", String(RT - 5 * MIN));
    const envC2 = makeEnv(d1c2, callsC2);
    await tick(envC2);
    const stateC2 = JSON.parse(d1c2.meta.get("sleepwake:state") || "{}");
    check("sleeping + fresh reporter (stuck) -> probe (recovery, not a wake)", callsC2.filter((c) => c.url.includes("8088-test.instabox.tech")).length >= 1, `calls=${callsC2.length}`);
    check("sleeping + fresh reporter (stuck) -> no suspend", callsC2.filter((c) => isSuspendCall(c)).length === 0);
    check("sleeping + fresh reporter (stuck) -> state running / reporter_up", stateC2.mode === "running" && stateC2.reason === "reporter_up", `mode=${stateC2.mode} reason=${stateC2.reason}`);
  } finally { globalThis.fetch = realFetch; }

  // STALE REPORTER: machine up, idle, but the reporter has not reported in
  // 30 min -> HOLD (fail closed), probe to keep it awake.
  const d1d = new MockD1();
  const callsD = [];
  globalThis.fetch = makeFetch(callsD);
  try {
    d1d.status.set("qwenpaw:status", JSON.stringify({ status: "up", httpStatus: 200, lastUpAt: new Date(RT - 60 * MIN).toISOString() }));
    d1d.meta.set("sleepwake:report", JSON.stringify({ nextNativeRun: null, agentActive: false, agentLastActiveAt: RT - 20 * MIN, uptimeSec: 3600, reportedAt: RT - 30 * MIN }));
    d1d.meta.set("sleepwake:state", JSON.stringify({ mode: "running", since: RT - 60 * MIN, lastWakeAt: RT - 60 * MIN }));
    const envD = makeEnv(d1d, callsD);
    await tick(envD);
    check("stale reporter -> no suspend", callsD.filter((c) => isSuspendCall(c)).length === 0);
    check("stale reporter -> probe (stay awake)", callsD.filter((c) => c.url.includes("8088-test.instabox.tech")).length >= 1);
  } finally { globalThis.fetch = realFetch; }

  // STALE-BASELINE LIVE CASE (2026-11-19): already "running" with a
  // lastUpAt 17h stale, a FRESH reporter posting uptimeSec null, and no
  // run-start baseline. Pre-fix the guard fired on 1020 min and the
  // tick suspended a 10-minute-old run every 5 min; post-fix the tick
  // reconciles the baseline to now, the guard sees ~0, and the machine
  // stays up.
  const d1e = new MockD1();
  const callsE = [];
  globalThis.fetch = makeFetch(callsE);
  try {
    d1e.status.set("qwenpaw:status", JSON.stringify({ status: "up", httpStatus: 200, lastUpAt: new Date(RT - 17 * 60 * MIN).toISOString() }));
    d1e.meta.set("sleepwake:report", JSON.stringify({ nextNativeRun: null, agentActive: false, agentLastActiveAt: RT - 20 * MIN, uptimeSec: null, reportedAt: RT - 60_000 }));
    d1e.meta.set("sleepwake:state", JSON.stringify({ mode: "running", since: RT - 60 * MIN, lastWakeAt: RT - 60 * MIN }));
    d1e.meta.set("sleepwake:last-visit", String(RT - 5 * MIN));
    const envE = makeEnv(d1e, callsE);
    const beforeE = Date.now();
    await tick(envE);
    check("live already-running + stale lastUpAt 17h + fresh reporter -> no suspend (guard sees ~0)", callsE.filter((c) => isSuspendCall(c)).length === 0, `sleep=${callsE.filter((c) => isSuspendCall(c)).length}`);
    const baselineE = Number(d1e.meta.get("sleepwake:run-start"));
    check("live already-running + stale lastUpAt 17h -> run-start baseline set to ~now", Number.isFinite(baselineE) && Math.abs(baselineE - beforeE) < 60_000, `baseline=${baselineE}`);
    check("live already-running + stale lastUpAt 17h -> probe (stay awake)", callsE.filter((c) => c.url.includes("8088-test.instabox.tech")).length >= 1);
  } finally { globalThis.fetch = realFetch; }
}

console.log(`\nsleepwake harness: ${passed} passed, ${failed.length} failed`);
if (failed.length) { for (const f of failed) console.log("  FAILED:", f); process.exitCode = 1; }
