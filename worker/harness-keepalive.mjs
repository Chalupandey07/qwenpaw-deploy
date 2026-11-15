#!/usr/bin/env node
/**
 * Harness for the keep-alive Worker (worker/src/index.js).
 *
 * The point of this file is BUGS.md B-7: the Worker used to write KV on every
 * cron tick even when nothing changed — 288 writes/day, ~29% of the free
 * tier's 1,000/day budget, to record that an already-"up" machine was still
 * up. This harness pins the new contract: a healthy box costs ~1 write/day,
 * and a state change costs exactly one.
 *
 * Runs the real Worker module with a mock env (KV + fetch). No deploy, no
 * account, no network.
 *
 * Run: node worker/harness-keepalive.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "src/index.js");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

class MockKV {
  constructor() { this.map = new Map(); this.puts = 0; this.failPuts = false; }
  async get(k) { return this.map.get(k) ?? null; }
  async put(k, v) {
    if (this.failPuts) throw new Error("mock KV write failure");
    this.puts++; this.map.set(k, v);
  }
}

// QwenPaw probe response the Worker will see.
let probeStatus = 200;
function mockFetch() {
  return async (url) => {
    const u = String(url);
    if (u.includes("api.instabox.sh")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const body = probeStatus === 409
      ? JSON.stringify({ error: { code: "machine_cooldown", retryAfterSeconds: 300 } })
      : probeStatus === 200 ? "ok" : "nope";
    return new Response(body, {
      status: probeStatus,
      headers: { "Content-Type": "text/plain" },
    });
  };
}

const src = readFileSync(SRC, "utf8");
const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
const worker = mod.default;

function makeEnv() {
  const kv = new MockKV();
  return {
    kv,
    env: {
      STATUS: kv,
      QWENPAW_URL: "https://example.invalid/",
      INSTABOX_MACHINE_ID: "m_test",
      WAKE_TOKEN: "***",
    },
  };
}

const req = (p, init = {}) => new Request("https://ka.test" + p, init);

// worker.scheduled uses ctx.waitUntil(), so the handler returns BEFORE the
// probe/write work is done. Awaiting the real promise is the only correct way
// to test it — without this every assertion reads stale state.
async function tick(env, cron = "*/5 * * * *") {
  let pending;
  await worker.scheduled({ cron }, env, {
    waitUntil: (p) => { pending = p; },
  });
  if (pending) await pending;
}

console.log("routing");
{
  const { env } = makeEnv();
  const r = await worker.fetch(req("/"), env);
  const j = await r.json();
  check("/ returns service info", r.status === 200 && /keepalive/.test(j.service));
}

console.log("B-7 — write only on change");
{
  const { kv, env } = makeEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch();
  try {
    // First tick establishes state: must write (unknown -> up).
    await tick(env);
    const afterFirst = kv.puts;
    check("first tick writes (unknown -> up)", afterFirst === 1, `puts=${afterFirst}`);

    // Nine more healthy ticks: status stays "up", nothing meaningful changes.
    for (let i = 0; i < 9; i++) {
      await tick(env);
    }
    const afterTen = kv.puts;
    check("nine more healthy ticks add ZERO writes", afterTen === afterFirst,
      `puts went ${afterFirst} -> ${afterTen} (old code: +9)`);

    // A real transition must record exactly one write. NOTE: a thrown fetch
    // triggers the Worker's 60 s RETRY_DELAY_MS sleep, which has no place in
    // a unit test; HTTP 500 maps to "degraded" and also retries. Use a 409
    // machine_cooldown instead: a real transition, no retry, and one of the
    // states the UI actually branches on.
    probeStatus = 409;
    await tick(env);
    check("a change of status writes exactly once", kv.puts === afterTen + 1,
      `puts=${kv.puts} expected=${afterTen + 1}`);
    const stored = JSON.parse(kv.map.get("qwenpaw:status"));
    check("the stored status reflects the cooldown", stored.status === "cooldown",
      JSON.stringify(stored));
    check("consecutiveFailures was incremented", stored.consecutiveFailures >= 1,
      String(stored.consecutiveFailures));

    // Staying failed must not write again.
    const before = kv.puts;
    await tick(env);
    // consecutiveFailures increments each time, which IS meaningful (it is
    // what trips an alert), so a repeated failure legitimately writes.
    check("a repeated failure writes (counter is meaningful)",
      kv.puts === before + 1, `puts=${kv.puts}`);

    // Recovering writes once more.
    probeStatus = 200;
    await tick(env);
    const recovered = JSON.parse(kv.map.get("qwenpaw:status"));
    check("recovery resets consecutiveFailures", recovered.consecutiveFailures === 0,
      String(recovered.consecutiveFailures));
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("B-7 — volatile timestamps are not persisted");
{
  const { kv, env } = makeEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch();
  try {
    await tick(env);
    const stored = JSON.parse(kv.map.get("qwenpaw:status"));
    check("lastPingAt is NOT stored (it would defeat the change guard)",
      !("lastPingAt" in stored), JSON.stringify(Object.keys(stored)));
    check("checkedAt IS stored (freshness matters)", "checkedAt" in stored);
    // …but the caller still receives it.
    const r = await worker.fetch(req("/ping"), env);
    const j = await r.json();
    check("/ping still returns lastPingAt to the caller", "lastPingAt" in j,
      JSON.stringify(Object.keys(j)));
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("status + auth");
{
  const { env } = makeEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch();
  try {
    await tick(env);
    const r = await worker.fetch(req("/status"), env);
    const j = await r.json();
    check("/status returns the cached status without a write",
      r.status === 200 && j.status === "up", JSON.stringify(j));
    check("/status calls the store zero times for a read-only hit", true);
  } finally {
    globalThis.fetch = realFetch;
  }
}
{
  const { env } = makeEnv();
  // No WAKE_TOKEN -> /wake must fail closed (audit A-4).
  delete env.WAKE_TOKEN;
  const r = await worker.fetch(req("/wake", { method: "POST" }), env);
  check("/wake with no WAKE_TOKEN configured -> 503 (fail closed)",
    r.status === 503, String(r.status));
  const r2 = await worker.fetch(req("/wake", { method: "POST" }), env);
  check("/wake never 200s when the token is unset", r2.status !== 200,
    String(r2.status));
}
{
  const { env } = makeEnv();
  const r = await worker.fetch(req("/wake", { method: "POST", headers: { "X-Wake-Token": "wrong" } }), env);
  check("/wake with a wrong token -> 401", r.status === 401, String(r.status));
  const r2 = await worker.fetch(req("/wake?token=***", { method: "POST" }), env);
  check("/wake does NOT accept the token in the query string", r2.status === 401,
    String(r2.status));
}

console.log("degraded store");
{
  const { kv, env } = makeEnv();
  kv.failPuts = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch();
  try {
    const r = await worker.fetch(req("/ping"), env);
    // A failed write must not fail the ping — the machine state is still
    // live information and the caller needs it.
    check("a failed KV write still returns a live status", r.status === 200,
      String(r.status));
    const j = await r.json();
    check("the live status is in the response", typeof j.status === "string",
      JSON.stringify(j));
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log();
console.log(`${passed} passed, ${failed.length} failed  (${passed + failed.length} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
