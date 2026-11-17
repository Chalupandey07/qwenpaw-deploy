#!/usr/bin/env node
/**
 * Harness T112 — screen retry on failure (B-47).
 *
 * THE BUG THIS EXISTS FOR (B-47)
 *
 * The screen capability URL is minted once via /computer/session and lives
 * 10 minutes. The three iframes load noVNC from it with reconnect=true.
 * After 10 minutes a WebSocket drop makes noVNC reconnect with the expired
 * URL, the Worker answers 403 "Screen link expired or invalid", and the
 * shim posts screen=failed. The parent only showed the error — it never
 * re-minted — so the preview sat on the 403 text until a manual reload.
 *
 * THE FIX
 *
 * The message handler's `failed` branch now calls scheduleReconnect(), the
 * same bounded retry the `disconnected` branch already used. loadScreen()
 * re-mints the capability, so the retry gets a fresh URL. Two guards:
 *
 *   1. Single-flight. The three iframes share one capability URL and the
 *      handler never checks event.source, so one failure is posted by all
 *      three at once. Without a guard one failure burst would schedule
 *      three concurrent mints and burn three budget units. `reconnectTimer`
 *      makes only one retry pending at a time.
 *   2. The budget still bounds everything. reconnectAttempts only resets
 *      on `connected`, and the exhausted branch returns without scheduling,
 *      so failed -> retry -> failed cannot loop forever.
 *
 * WHAT THIS ASSERTS
 *
 *   (a) the `failed` branch calls scheduleReconnect() (static, on the real
 *       ui.html — a missing call is the bug itself);
 *   (b) scheduleReconnect() is single-flight (dynamic: extract the real
 *       function, run it in a VM with mocks, call it 3x, exactly one timer
 *       is created and exactly one retry is scheduled);
 *   (c) the budget bounds retries (dynamic: after RECONNECT_BUDGET
 *       attempts no further retry is scheduled and the specific error text
 *       is preserved, not overwritten by the generic "closed repeatedly"
 *       wording);
 *   (d) the `connected` branch clears the pending timer, so a later failure
 *       can schedule a fresh retry.
 *
 * Run: node features/computer/harness-screen-retry.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PUBLIC = resolve(REPO, "pages/public");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

const ui = readFileSync(resolve(PUBLIC, "computer/ui.html"), "utf8");
const js = ui.slice(ui.indexOf("<script>") + 8, ui.lastIndexOf("</script>"));

console.log("static: the failed branch retries through the bounded path");
{
  const failedAt = js.indexOf('} else if (phase === "failed") {');
  const discAt = js.indexOf('} else if (phase === "disconnected") {', failedAt);
  const failedBranch = failedAt !== -1 && discAt !== -1 ? js.slice(failedAt, discAt) : "";
  check("the failed branch calls scheduleReconnect()",
    /scheduleReconnect\(\)/.test(failedBranch),
    "without it an expired capability shows the error and never recovers");
  check("the failed branch still records the specific error first",
    /state\.errors = \[d\.detail/.test(failedBranch),
    "the retry must not hide what actually failed");
  check("the failed branch still clears the frame-load timer",
    /clearTimeout\(loadTimer\)/.test(failedBranch));
}

console.log("static: the retry is single-flight and budget-bounded");
{
  const fnStart = js.indexOf("function scheduleReconnect()");
  const fnEnd = js.indexOf("\n  }", fnStart) + 4;
  const fn = fnStart !== -1 ? js.slice(fnStart, fnEnd) : "";
  check("scheduleReconnect exists", fnStart !== -1);
  check("it returns early when a retry is already pending (single-flight)",
    /if \(reconnectTimer\) return;/.test(fn),
    "three iframes post one failure; without this the budget burns 3x");
  check("it records the pending timer",
    /reconnectTimer = setTimeout/.test(fn));
  check("it enforces the retry budget",
    /state\.reconnectAttempts >= RECONNECT_BUDGET/.test(fn));
  check("the exhausted branch preserves a specific error instead of overwriting it",
    /if \(!state\.errors\.length\)/.test(fn),
    "the generic 'closed repeatedly' wording is wrong for the failed path");
  const connAt = js.indexOf('if (phase === "connected") {');
  const connEnd = js.indexOf('} else if (phase === "failed") {', connAt);
  const connBranch = connAt !== -1 && connEnd !== -1 ? js.slice(connAt, connEnd) : "";
  check("the connected branch clears the pending retry timer",
    /reconnectTimer = null;/.test(connBranch),
    "otherwise a later failure could never schedule a fresh retry");
  check("the timer is declared as a module-level let",
    /let reconnectTimer = null;/.test(js));
}

console.log("dynamic: run the real scheduleReconnect in a VM with mocks");
{
  // Extract the real function + the timer declaration, and run them with
  // mocked state/setPhase/loadScreen/setTimeout. This proves the behaviour,
  // not just the text: a text assertion cannot catch a guard that exists
  // but is never reached.
  const fnStart = js.indexOf("function scheduleReconnect()");
  const fnEnd = js.indexOf("\n  }", fnStart) + 4;
  const fnSrc = js.slice(fnStart, fnEnd);
  const timers = [];
  let loadScreenCalls = 0;
  let lastPhase = null;
  let lastPhaseMsg = "";
  const ctx = {
    state: { reconnectAttempts: 0, errors: [] },
    RECONNECT_BUDGET: 4,
    reconnectTimer: null,
    setPhase: (p, m) => { lastPhase = p; lastPhaseMsg = m || ""; },
    loadScreen: () => { loadScreenCalls += 1; },
    setTimeout: (f, ms) => { const id = timers.length + 1; timers.push({ f, ms, id }); return id; },
    clearTimeout: () => {},
    Math,
  };
  vm.createContext(ctx);
  vm.runInContext("let reconnectTimer = null;\n" + fnSrc, ctx);

  // Three simultaneous failures (three iframes, one failure) schedule one retry.
  vm.runInContext("scheduleReconnect(); scheduleReconnect(); scheduleReconnect();", ctx);
  check("three simultaneous calls schedule exactly one retry",
    timers.length === 1 && ctx.state.reconnectAttempts === 1,
    `timers=${timers.length} attempts=${ctx.state.reconnectAttempts}`);
  check("the retry delay is bounded (<= 8000 ms)",
    timers[0] && timers[0].ms <= 8000, `delay=${timers[0] && timers[0].ms}`);

  // Firing the timer runs loadScreen and frees the single-flight slot.
  timers[0].f();
  check("firing the timer calls loadScreen once", loadScreenCalls === 1);
  check("firing the timer frees the single-flight slot",
    ctx.reconnectTimer === null);

  // A second failure after the first retry can schedule again.
  vm.runInContext("scheduleReconnect();", ctx);
  check("a later failure schedules a fresh retry",
    timers.length === 2 && ctx.state.reconnectAttempts === 2,
    `timers=${timers.length} attempts=${ctx.state.reconnectAttempts}`);

  // Exhaust the budget: no further retry is scheduled.
  ctx.state.reconnectAttempts = 4;
  ctx.state.errors = ["Failed to connect to server"];
  const timersBefore = timers.length;
  vm.runInContext("scheduleReconnect();", ctx);
  check("at the budget no further retry is scheduled",
    timers.length === timersBefore,
    `timers grew ${timersBefore} -> ${timers.length}`);
  check("the exhausted branch keeps the specific error text",
    lastPhaseMsg === "" || !/closed repeatedly/.test(lastPhaseMsg),
    `phase message was overwritten: ${lastPhaseMsg}`);
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log("failed:", failed.join(", ")); process.exit(1); }
