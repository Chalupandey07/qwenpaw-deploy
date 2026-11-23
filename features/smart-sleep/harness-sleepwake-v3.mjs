#!/usr/bin/env node
/**
 * T146 — harness for sleep/wake v3: the Worker suspends the machine DIRECTLY
 * through InstaBox (worker/src/index.js).
 *
 * WHY THIS EXISTS
 * ---------------
 * v2 suspended by asking Pages: Worker -> POST /api/machine/sleep ->
 * sleepMachine() in pages/public/machine-control.js -> PATCH InstaBox. That
 * chain failed SEVEN times live, always as `pages_sleep_failed`, and the root
 * cause was never established. Every step of the indirection is invisible from
 * the Worker, so the failure could only be diagnosed by inference.
 *
 * v3 removes the indirection: the Worker PATCHes InstaBox itself, using the
 * INSTABOX_API_KEY secret it already holds for the API-wake fallback. The
 * endpoint, the header and the idempotency key mirror that wake path, which is
 * proven live.
 *
 * WHAT IS ASSERTED HERE
 * ---------------------
 *   1. Success: exactly ONE PATCH to the right machine URL, the right body
 *      (`desiredState: suspended`), the right header, and a state that ends
 *      `sleeping` with the decision's reason.
 *   2. NO Pages call is made at all — the whole point of v3.
 *   3. Failure modes, each with the behaviour that must follow:
 *        - 401 / 403 (bad or expired key)  -> permanent: record the block,
 *          machine stays up, and the NEXT tick does NOT call InstaBox again.
 *        - 404 (machine id gone)           -> permanent, same backoff.
 *        - 500 / 503 / 429 / network error -> transient: state reverts to
 *          running and the next tick DOES retry.
 *        - missing INSTABOX_API_KEY        -> permanent, no call attempted,
 *          and the reason names the unset secret.
 *        - missing INSTABOX_MACHINE_ID     -> permanent, no call attempted.
 *   4. THE LOOP GUARD: a failed suspend must never become a wake loop. Seven
 *      consecutive failing ticks must produce exactly ONE suspend attempt (the
 *      backoff), NOT seven, and the machine must be up at the end.
 *   5. The backoff releases: after SW_SLEEP_BLOCK_RETRY_MS the call is retried;
 *      and a config error that is since fixed is retried immediately.
 *   6. /sleepwake/state keeps its shape (v2 compatibility) and explains the
 *      block in `reason` when one is in effect.
 *
 * Fail-first: run against the v2 module and the v3 checks fail —
 *   V3_SRC=/tmp/worker-index-before-v3.js node features/smart-sleep/harness-sleepwake-v3.mjs
 * (v2 has no InstaBox suspend: it calls Pages, so check 2 fails, and every
 * failure-mode check fails because the failure text is `pages_sleep_failed`.)
 *
 * Run: node features/smart-sleep/harness-sleepwake-v3.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.V3_SRC || resolve(HERE, "..", "..", "worker", "src", "index.js");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

const MIN = 60_000;

// --- mock D1 (in-memory; the same query surface the tick uses) ----------
class MockD1 {
  constructor() {
    this.meta = new Map();
    this.status = new Map();
    this.routines = new Map();
    this.metaWrites = 0;
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
        if (/FROM write_budget WHERE day/.test(sql)) return null;
        if (/MAX\(at\) AS m FROM routines_history/.test(sql)) return { m: null };
        return null;
      },
      async all() {
        if (/FROM routines_definitions/.test(sql)) {
          return { results: [...self.routines.entries()].map(([id, payload]) => ({ id, payload })) };
        }
        return { results: [] };
      },
      async run() {
        if (/INTO meta \(key, value\)/.test(sql)) { self.metaWrites++; self.meta.set(params[0], String(params[1])); return { success: true }; }
        if (/INTO status \(key, value\)/.test(sql)) { self.status.set(params[0], String(params[1])); return { success: true }; }
        return { success: true };
      },
    });
    const stmt = makeStmt([]);
    return { ...stmt, bind: (...p) => makeStmt(p) };
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

/**
 * A fetch mock whose InstaBox SUSPEND answer is configurable, so each failure
 * mode is driven by its real HTTP status rather than by a mocked helper.
 * `suspendReply` is either an HTTP status number or the string "throw".
 */
function makeFetch(calls, { suspendReply = 200 } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    calls.push({ url: u, method, body: init.body, headers: init.headers || {} });
    if (u.includes("api.instabox.sh/v1/machines/") && method === "PATCH") {
      if (suspendReply === "throw") throw Object.assign(new Error("network down"), { name: "TypeError" });
      if (suspendReply >= 200 && suspendReply < 300) {
        return new Response(JSON.stringify({ ok: true, desiredState: "suspended" }), { status: suspendReply, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { code: "nope", message: "refused" } }), { status: suspendReply, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("api.instabox.sh")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    // Nothing else should be called on the sleep path; count it if it is.
    return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } });
  };
}

function makeEnv(d1, opts = {}) {
  const env = {
    STATUS: new MockKV(),
    QWENPAW_DB: d1,
    USE_D1: "1",
    QWENPAW_URL: "https://8088-test.instabox.tech/",
    INSTABOX_MACHINE_ID: "m_agq5wqqo2fvypym7rjlpvngc2m",
    INSTABOX_API_KEY: "instabox-key-test",
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

async function tick(env) {
  let pending;
  await worker.scheduled({ cron: "*/5 * * * *" }, env, { waitUntil: (p) => { pending = p; } });
  return pending ? await pending : undefined;
}

const isSuspend = (c) =>
  c.url.includes("api.instabox.sh/v1/machines/") && (c.method || "").toUpperCase() === "PATCH";
const isPagesSleep = (c) => c.url.includes("/api/machine/sleep");

/** An idle machine whose every sleep guard passes, ready to be suspended. */
function idleD1(over = {}) {
  const d1 = new MockD1();
  const RT = Date.now();
  d1.status.set("qwenpaw:status", JSON.stringify({
    status: "up", httpStatus: 200,
    lastUpAt: new Date(RT - 60 * MIN).toISOString(),
    checkedAt: new Date(RT - 5 * MIN).toISOString(),
  }));
  d1.meta.set("sleepwake:report", JSON.stringify({
    nextNativeRun: null, agentActive: false,
    agentLastActiveAt: RT - 40 * MIN, uptimeSec: 3600,
    reportedAt: RT - 60_000,
  }));
  d1.meta.set("sleepwake:state", JSON.stringify({
    mode: "running", since: RT - 60 * MIN, lastWakeAt: RT - 60 * MIN,
  }));
  d1.meta.set("sleepwake:run-start", String(RT - 3600_000));
  for (const [k, v] of Object.entries(over)) d1.meta.set(k, v);
  return d1;
}

async function runTick(env, fetchOpts) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetch(calls, fetchOpts);
  try {
    const result = await tick(env);
    return { result, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

function sleepState(d1) {
  const raw = d1.meta.get("sleepwake:state");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// =======================================================================
console.log("sleep/wake v3 — direct InstaBox suspend\n");

// --- 1. The success path ------------------------------------------------
{
  console.log("success path");
  const d1 = idleD1();
  const { calls } = await runTick(makeEnv(d1));
  const suspends = calls.filter(isSuspend);
  check("exactly one suspend call", suspends.length === 1, `calls=${JSON.stringify(calls.map((c) => `${c.method} ${c.url}`))}`);
  const s = suspends[0] || {};
  check("suspend goes to the InstaBox machine endpoint",
    String(s.url || "") === "https://api.instabox.sh/v1/machines/m_agq5wqqo2fvypym7rjlpvngc2m",
    `url=${s.url}`);
  check("suspend is a PATCH", String(s.method || "").toUpperCase() === "PATCH", `method=${s.method}`);
  check("suspend body is {desiredState:'suspended'}",
    s.body === JSON.stringify({ desiredState: "suspended" }), `body=${s.body}`);
  const h = s.headers || {};
  check("suspend authenticates with X-API-Key (the same header the wake path uses)",
    h["X-API-Key"] === "instabox-key-test", `headers=${JSON.stringify(Object.keys(h))}`);
  check("suspend sends an Idempotency-Key", typeof h["Idempotency-Key"] === "string" && h["Idempotency-Key"].length > 8);
  check("suspend never touches Pages", calls.filter(isPagesSleep).length === 0,
    `pagesCalls=${calls.filter(isPagesSleep).length}`);
  const st = sleepState(d1);
  check("state ends 'sleeping'", st?.mode === "sleeping", `mode=${st?.mode}`);
  check("state carries the decision reason", st?.reason === "idle; all guards pass", `reason=${st?.reason}`);
  check("state has lastSleepAt", typeof st?.lastSleepAt === "number");
  check("no block is recorded on success", st?.suspendBlockedAt == null, `suspendBlockedAt=${st?.suspendBlockedAt}`);
}

// --- 2. Permanent failures: 401 / 403 / 404 -----------------------------
for (const status of [401, 403, 404]) {
  console.log(`permanent failure ${status}`);
  const d1 = idleD1();
  const env = makeEnv(d1);
  const first = await runTick(env, { suspendReply: status });
  check(`${status} -> one attempt`, first.calls.filter(isSuspend).length === 1);
  const st = sleepState(d1);
  check(`${status} -> state does NOT say sleeping`, st?.mode !== "sleeping", `mode=${st?.mode}`);
  check(`${status} -> reason names the block`, String(st?.reason || "").startsWith("sleep_blocked:"), `reason=${st?.reason}`);
  check(`${status} -> suspendBlockedAt recorded`, typeof st?.suspendBlockedAt === "number");
  // The next tick must NOT repeat the doomed call.
  const second = await runTick(env, { suspendReply: status });
  check(`${status} -> next tick makes ZERO suspend attempts (backoff)`,
    second.calls.filter(isSuspend).length === 0,
    `attempts=${second.calls.filter(isSuspend).length}`);
  check(`${status} -> next tick makes ZERO Pages calls`, second.calls.filter(isPagesSleep).length === 0);
}

// --- 3. Transient failures: 5xx / 429 / network -------------------------
for (const reply of [500, 503, 429, "throw"]) {
  const label = reply === "throw" ? "network error" : String(reply);
  console.log(`transient failure ${label}`);
  const d1 = idleD1();
  const env = makeEnv(d1);
  const first = await runTick(env, { suspendReply: reply });
  check(`${label} -> one attempt`, first.calls.filter(isSuspend).length === 1);
  const st = sleepState(d1);
  check(`${label} -> state reverts to running`, st?.mode === "running", `mode=${st?.mode}`);
  check(`${label} -> reason is sleep_failed`, String(st?.reason || "").startsWith("sleep_failed:"), `reason=${st?.reason}`);
  check(`${label} -> NO block recorded (a retry may succeed)`, st?.suspendBlockedAt == null, `suspendBlockedAt=${st?.suspendBlockedAt}`);
  // The next tick DOES retry: a transient failure is not a give-up.
  const second = await runTick(env, { suspendReply: 200 });
  check(`${label} -> next tick retries and succeeds`,
    second.calls.filter(isSuspend).length === 1 && sleepState(d1)?.mode === "sleeping",
    `attempts=${second.calls.filter(isSuspend).length} mode=${sleepState(d1)?.mode}`);
}

// --- 4. THE LOOP GUARD: seven failing ticks, one attempt ----------------
{
  console.log("loop guard — a failing suspend must not become a wake loop");
  const d1 = idleD1();
  const env = makeEnv(d1);
  let attempts = 0;
  let probes = 0;
  for (let i = 0; i < 7; i++) {
    const { calls } = await runTick(env, { suspendReply: 401 });
    attempts += calls.filter(isSuspend).length;
    probes += calls.filter((c) => c.url.includes("8088-test.instabox.tech")).length;
  }
  // Seven v2 ticks would have been seven Pages calls. v3: one, then backoff.
  check("seven failing ticks -> exactly ONE suspend attempt", attempts === 1, `attempts=${attempts}`);
  check("seven failing ticks -> the machine is still up (probes kept it awake)", probes >= 1, `probes=${probes}`);
  check("seven failing ticks -> state never claims sleeping", sleepState(d1)?.mode !== "sleeping", `mode=${sleepState(d1)?.mode}`);
}

// --- 5. Missing configuration ------------------------------------------
{
  console.log("missing INSTABOX_API_KEY");
  const d1 = idleD1();
  const { calls } = await runTick(makeEnv(d1, { INSTABOX_API_KEY: undefined }));
  check("no key -> no suspend attempted", calls.filter(isSuspend).length === 0);
  check("no key -> no Pages call either", calls.filter(isPagesSleep).length === 0);
  const st = sleepState(d1);
  check("no key -> reason names the unset secret",
    String(st?.reason || "").includes("instabox_api_key_unset"), `reason=${st?.reason}`);
  check("no key -> block recorded", typeof st?.suspendBlockedAt === "number");
}
{
  console.log("missing INSTABOX_MACHINE_ID");
  const d1 = idleD1();
  const { calls } = await runTick(makeEnv(d1, { INSTABOX_MACHINE_ID: undefined }));
  check("no machine id -> no suspend attempted", calls.filter(isSuspend).length === 0);
  check("no machine id -> reason names the unset var",
    String(sleepState(d1)?.reason || "").includes("instabox_machine_unset"), `reason=${sleepState(d1)?.reason}`);
}

// --- 6. The backoff releases -------------------------------------------
{
  console.log("backoff release");
  // (a) time passing: a block older than the retry window is retried.
  const d1 = idleD1();
  const RT = Date.now();
  d1.meta.set("sleepwake:state", JSON.stringify({
    mode: "running", since: RT - 3600_000, lastWakeAt: RT - 3600_000,
    reason: "sleep_blocked:suspend_failed:401",
    suspendBlockedAt: RT - 61 * MIN,
  }));
  const { calls } = await runTick(makeEnv(d1), { suspendReply: 200 });
  check("an hour after the block -> the suspend is retried",
    calls.filter(isSuspend).length === 1, `attempts=${calls.filter(isSuspend).length}`);
  check("...and the machine sleeps", sleepState(d1)?.mode === "sleeping", `mode=${sleepState(d1)?.mode}`);
}
{
  // (b) the config error is fixed: retried immediately, no hour-long wait.
  const d1 = idleD1();
  const RT = Date.now();
  d1.meta.set("sleepwake:state", JSON.stringify({
    mode: "running", since: RT - 3600_000, lastWakeAt: RT - 3600_000,
    reason: "sleep_blocked:instabox_api_key_unset",
    suspendBlockedAt: RT - 60_000,
  }));
  const { calls } = await runTick(makeEnv(d1), { suspendReply: 200 });
  check("config unset then present -> retried immediately (no hour wait)",
    calls.filter(isSuspend).length === 1, `attempts=${calls.filter(isSuspend).length}`);
}

// --- 7. The endpoint keeps its v2 shape and explains a block ------------
{
  console.log("/sleepwake/state");
  const d1 = idleD1();
  await runTick(makeEnv(d1), { suspendReply: 401 });
  const r = await worker.fetch(req("/sleepwake/state"), makeEnv(d1));
  const j = await r.json();
  const v2Keys = ["mode", "since", "reason", "lastWakeAt", "lastSleepAt", "uptimeSec",
    "runStartAt", "keepAlive", "nextRoutineAt", "nextRoutineSource", "lastVisitAt",
    "lastAgentActivityAt", "reporterFresh", "reporterLastAt", "restActive",
    "restReason", "machineStatus", "checkedAt"];
  const missing = v2Keys.filter((k) => !(k in j));
  check("endpoint keeps every v2 field", missing.length === 0, `missing=${missing.join(",")}`);
  check("endpoint explains the block in reason", String(j.reason || "").includes("sleep_blocked"), `reason=${j.reason}`);
  check("endpoint reports the machine as up (it never slept)", j.machineStatus !== "sleeping", `machineStatus=${j.machineStatus}`);
  check("endpoint leaks no secret",
    !JSON.stringify(j).includes("instabox-key-test") && !JSON.stringify(j).includes("sleep-token-test"));
}

// --- 8. v2 behaviour is intact -----------------------------------------
{
  console.log("v2 behaviour preserved");
  const d1 = idleD1();
  // Keep-alive OFF must still skip everything, including the new suspend.
  d1.meta.set("keepalive:enabled", "0");
  const { calls } = await runTick(makeEnv(d1));
  check("keep-alive OFF -> zero fetch calls (no probe, no suspend)",
    calls.length === 0, `calls=${JSON.stringify(calls.map((c) => c.url))}`);
  check("keep-alive OFF -> state untouched", sleepState(d1)?.mode === "running", `mode=${sleepState(d1)?.mode}`);
}
{
  // A routine within the lookahead must still WAKE, never sleep.
  const d1 = idleD1();
  const RT = Date.now();
  d1.meta.set("sleepwake:report", JSON.stringify({
    nextNativeRun: RT + 2 * MIN, agentActive: false,
    agentLastActiveAt: RT - 40 * MIN, uptimeSec: 3600,
    reportedAt: RT - 60_000,
  }));
  const { calls } = await runTick(makeEnv(d1), { suspendReply: 200 });
  check("routine in 2 min -> NO suspend (wake wins)", calls.filter(isSuspend).length === 0,
    `suspends=${calls.filter(isSuspend).length}`);
}
{
  // The max-run guard still sleeps at 7h — through the new path.
  const d1 = idleD1();
  const RT = Date.now();
  d1.meta.set("sleepwake:run-start", String(RT - 425 * MIN));
  d1.meta.set("sleepwake:report", JSON.stringify({
    nextNativeRun: null, agentActive: true,
    agentLastActiveAt: RT - 60_000, uptimeSec: null,
    reportedAt: RT - 60_000,
  }));
  const { calls } = await runTick(makeEnv(d1), { suspendReply: 200 });
  const st = sleepState(d1);
  check("max-run guard (7h) still fires", st?.reason === "max_run_guard", `reason=${st?.reason}`);
  check("max-run guard sleeps through the InstaBox path",
    calls.filter(isSuspend).length === 1 && st?.mode === "sleeping",
    `suspends=${calls.filter(isSuspend).length} mode=${st?.mode}`);
}

console.log(`\nsleepwake-v3 harness: ${passed} passed, ${failed.length} failed`);
if (failed.length) { for (const f of failed) console.log("  FAILED:", f); process.exitCode = 1; }
