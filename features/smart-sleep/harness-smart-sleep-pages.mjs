#!/usr/bin/env node
/**
 * Harness — Smart Sleep/Wake Part 2: waking, cooldown and status pages.
 *
 * WHAT THIS ASSERTS (features/smart-sleep, 2026-11-19)
 *
 * The waking page, the cooldown page (both built by pages/public/_worker.js)
 * and the status page (pages/public/status-page.html) are one centred card
 * with the AgentX wordmark, a live status line and plain-language copy.
 * The keep-alive Worker is the expensive shared resource (the account
 * burned 121,900 Worker requests in one day, 2026-11-18): the status page
 * does ONE GET /status on load and never polls, so cost stays proportional
 * to user action.
 *
 *   Static, on the real pages/public/_worker.js and status-page.html:
 *     - no backticks and no ${} sequences in any rendered page (the pages
 *       are built with string concatenation only — a backtick or an
 *       interpolation inside the _worker.js page strings breaks the
 *       deploy the way the rebrand template literal once did);
 *     - no external anything: no http(s) URL outside WORKER_URL, no
 *       <link, no src= attribute, no @import, no <img>;
 *     - the waking page polls every 5 s and reloads only when the fetched
 *       HTML carries id="root"; the meta-refresh stays as a no-JS fallback;
 *     - the cooldown page auto-refreshes at cooldown end with a
 *       reload-storm guard (max 1 auto-reload per 30 s per tab, via
 *       sessionStorage) and a determinate bar from data-start/data-end,
 *       hidden when data-start is absent;
 *     - the status page has NO setInterval polling and schedules at most
 *       ONE setTimeout refresh (60 s) when the state is waking;
 *     - the status page carries a real keep-alive switch
 *       (button role="switch"), a type=password admin token field kept
 *       in sessionStorage only, and the consequence line;
 *     - the Rest button POSTs /api/machine/rest with the console bearer
 *       token, confirms first, and says "Sign in to the console first"
 *       on an auth refusal;
 *     - size budgets: waking <= 9 KB, cooldown <= 8 KB, status <= 12 KB;
 *     - Hallmark floor (static half): the first CSS line is the Hallmark
 *       stamp, no transition: all, no width/height animation.
 *   Dynamic, in a VM with a Response mock:
 *     - the real wakingPage/cooldownPage run and render;
 *     - fmtCooldownRemaining is table-driven (3600 -> "about 60 minutes",
 *       90 -> "about 2 minutes", null -> no time text).
 *
 * The live half (a real browser on the deployed Pages: waking page reloads
 * into the console, cooldown bar tracks the real end, status switch flips
 * the Worker) is verified by Muse after deploy — blocked 2026-11-19 by the
 * Cloudflare 1027 quota outage and the machine cooldown until 05:30 IST.
 *
 * Known sloplint findings (2026-11-19, not harness failures):
 *   - Gate 19: FIXED in integration — the waking/cooldown titles were
 *     "AgentX — Waking up" / "AgentX — Cooldown" (one em dash each);
 *     the titles and both harnesses now use "AgentX: Waking up" /
 *     "AgentX: Cooldown" (same colon separator as "AgentX: Status").
 *     sloplint is 0 FAIL across all three pages.
 *   - F16 WARN on the status page only: ::selection, scrollbar-color and
 *     caret-color keep the browser default. The status page is at its
 *     12 KB budget (12,249 B); theming them costs ~155 B with no behaviour
 *     left to cut. The waking and cooldown pages theme them.
 *
 * Run: node features/smart-sleep/harness-smart-sleep-pages.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PUBLIC = resolve(REPO, "pages/public");
const WORKER_URL = "https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev";

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log("  ok   " + name); }
  else { failed.push(name); console.log("  FAIL " + name + "  " + detail); }
}

const worker = readFileSync(resolve(PUBLIC, "_worker.js"), "utf8");
const statusHtml = readFileSync(resolve(PUBLIC, "status-page.html"), "utf8");

// ---------- extractor (same brace-matching pattern as harness-rebrand) ----------
function extractFunction(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) return "";
  const brace = src.indexOf("{", start);
  if (brace === -1) return "";
  let depth = 0;
  let i = brace;
  let mode = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1] || "";
    if (mode === "//") {
      if (c === "\n") mode = null;
    } else if (mode === "/*") {
      if (c === "*" && next === "/") { mode = null; i += 1; }
    } else if (mode === "'" || mode === '"' || mode === "`") {
      if (c === "\\") { i += 1; }
      else if (c === mode) mode = null;
    } else if (c === "'" || c === '"' || c === "`") {
      mode = c;
    } else if (c === "/" && next === "/") {
      mode = "//";
    } else if (c === "/" && next === "*") {
      mode = "/*";
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
    i += 1;
  }
  return "";
}

const wakingSrc = extractFunction(worker, "wakingPage");
const cooldownSrc = extractFunction(worker, "cooldownPage");
const fmtSrc = extractFunction(worker, "fmtCooldownRemaining");

// ---------- run the real page functions in a VM ----------
const sandbox = { Response, Date, Math, Number, console, JSON };
vm.createContext(sandbox);
let wakingHtml = "";
let wakingNullHtml = "";
let cooldownHtml = "";
let cooldown90Html = "";
let cooldownNullHtml = "";
let fmt = null;
if (wakingSrc && cooldownSrc) {
  try {
    vm.runInContext(wakingSrc, sandbox);
    vm.runInContext(cooldownSrc, sandbox);
    if (fmtSrc) {
      vm.runInContext(fmtSrc, sandbox);
      fmt = vm.runInContext("fmtCooldownRemaining", sandbox);
    }
    wakingHtml = await vm.runInContext("wakingPage(60)", sandbox).text();
    wakingNullHtml = await vm.runInContext("wakingPage(null)", sandbox).text();
    cooldownHtml = await vm.runInContext(
      "cooldownPage(3600, \"2026-11-19 05:30 UTC\")", sandbox).text();
    cooldown90Html = await vm.runInContext("cooldownPage(90, \"\")", sandbox).text();
    cooldownNullHtml = await vm.runInContext("cooldownPage(null, null)", sandbox).text();
  } catch (e) {
    console.log("  FAIL page functions did not run in the VM: " + e.message);
    failed.push("page functions run in the VM");
  }
} else {
  console.log("  FAIL wakingPage/cooldownPage not found in _worker.js");
  failed.push("wakingPage/cooldownPage found in _worker.js");
}

const pages = [
  ["waking", wakingHtml],
  ["cooldown", cooldownHtml],
  ["status", statusHtml],
];

function styleOf(html) {
  const m = /<style>([\s\S]*?)<\/style>/.exec(html);
  return m ? m[1] : "";
}
function scriptOf(html) {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  return m ? m[1] : "";
}

console.log("render: the real page functions run");
{
  check("wakingPage renders HTML", wakingHtml.indexOf("<!doctype html>") === 0);
  check("wakingPage(null) renders HTML", wakingNullHtml.indexOf("<!doctype html>") === 0);
  check("cooldownPage renders HTML", cooldownHtml.indexOf("<!doctype html>") === 0);
  check("cooldownPage(null, null) renders HTML", cooldownNullHtml.indexOf("<!doctype html>") === 0);
  check("waking title is AgentX",
    wakingHtml.indexOf("<title>AgentX: Waking up</title>") !== -1);
  check("waking heading is AgentX",
    wakingHtml.indexOf("<h1>AgentX is waking up</h1>") !== -1);
  check("cooldown title is AgentX",
    cooldownHtml.indexOf("<title>AgentX: Cooldown</title>") !== -1);
  check("cooldown heading is AgentX",
    cooldownHtml.indexOf("<h1>AgentX is in max-run cooldown</h1>") !== -1);
  check("status title is AgentX",
    statusHtml.indexOf("<title>AgentX: Status</title>") !== -1);
}

console.log("no-backtick / no-interpolation in any rendered page");
for (const [name, html] of pages) {
  check("no backtick in the " + name + " page", html.indexOf("`") === -1);
  check("no ${} in the " + name + " page", html.indexOf("${") === -1);
}

console.log("no-external in any rendered page");
for (const [name, html] of pages) {
  const withoutWorker = html.split(WORKER_URL).join("");
  check("no http(s) URL outside WORKER_URL in the " + name + " page",
    withoutWorker.indexOf("http://") === -1 && withoutWorker.indexOf("https://") === -1,
    "an http(s) URL other than the keep-alive Worker URL is present");
  check("no <link in the " + name + " page", html.indexOf("<link") === -1);
  check("no src= attribute in the " + name + " page", html.indexOf("src=") === -1);
  check("no @import in the " + name + " page", html.indexOf("@import") === -1);
  check("no <img in the " + name + " page", html.indexOf("<img") === -1);
}

console.log("cooldown fmtRemaining is table-driven");
{
  check("fmtCooldownRemaining exists", typeof fmt === "function");
  if (typeof fmt === "function") {
    check("3600s -> about 60 minutes", fmt(3600) === "about 60 minutes", "got " + fmt(3600));
    check("90s -> about 2 minutes", fmt(90) === "about 2 minutes", "got " + fmt(90));
    check("60s -> about 1 minute", fmt(60) === "about 1 minute", "got " + fmt(60));
    check("30s -> about 1 minute", fmt(30) === "about 1 minute", "got " + fmt(30));
    check("null -> no time text", fmt(null) === "", "got " + JSON.stringify(fmt(null)));
    check("0 -> no time text", fmt(0) === "", "got " + JSON.stringify(fmt(0)));
    check("undefined -> no time text", fmt(undefined) === "", "got " + JSON.stringify(fmt(undefined)));
  } else {
    for (const n of ["3600s", "90s", "60s", "30s", "null", "0", "undefined"]) {
      check(n + " case", false, "fmtCooldownRemaining not found in _worker.js");
    }
  }
  check("rendered cooldown (3600) says about 60 minutes",
    cooldownHtml.indexOf("about 60 minutes") !== -1);
  check("rendered cooldown (90) says about 2 minutes",
    cooldown90Html.indexOf("about 2 minutes") !== -1);
  check("rendered cooldown (null) has no time text",
    cooldownNullHtml.replace(/<script>[\s\S]*?<\/script>/, "").indexOf("about ") === -1,
    "a time phrase leaked into the null-cooldown markup (the script may still hold its formatter strings)");
}

console.log("waking page polls every 5s and reloads on id=root");
{
  const js = scriptOf(wakingHtml);
  check("waking inline script exists", js.length > 0);
  check("waking polls on a 5000ms timer",
    js.indexOf("5000") !== -1, "no 5000ms timer in the waking script");
  check("waking checks for id=root before reloading",
    js.indexOf('id="root"') !== -1 && js.indexOf("location.reload()") !== -1,
    "the poll must look for the console root before reloading");
  check("waking keeps the meta-refresh as a no-JS fallback",
    wakingHtml.indexOf('http-equiv="refresh"') !== -1);
  check("waking bar is determinate via transform scaleX, not width",
    js.indexOf("scaleX(") !== -1 && js.indexOf("style.width") === -1,
    "the bar must move with transform, never with width");
  check("waking shows elapsed time", wakingHtml.indexOf('id="elapsed"') !== -1);
  check("waking links to the status page",
    wakingHtml.indexOf('href="/status"') !== -1);
}

console.log("cooldown page auto-refreshes once, at the end, with a storm guard");
{
  const js = scriptOf(cooldownHtml);
  check("cooldown inline script exists", js.length > 0);
  check("cooldown guard is sessionStorage-based",
    js.indexOf("sessionStorage") !== -1, "no sessionStorage in the cooldown script");
  check("cooldown guard allows at most 1 auto-reload per 30s",
    js.indexOf("30000") !== -1, "no 30000ms guard window in the cooldown script");
  check("cooldown bar reads data-start and data-end",
    cooldownHtml.indexOf("data-start=") !== -1 && cooldownHtml.indexOf("data-end=") !== -1 &&
    js.indexOf("dataset.start") !== -1 && js.indexOf("dataset.end") !== -1);
  check("cooldown bar is hidden when data-start is absent",
    js.indexOf("dataset.start") !== -1 && js.indexOf("hidden") !== -1,
    "with no data-start the bar must be hidden, not shown at 0%");
  check("cooldown keeps the meta-refresh as a no-JS fallback",
    cooldownHtml.indexOf('http-equiv="refresh"') !== -1);
  check("cooldown bar is determinate via transform scaleX, not width",
    js.indexOf("scaleX(") !== -1 && js.indexOf("style.width") === -1);
  check("cooldown shows the wall-clock end time when given",
    cooldownHtml.indexOf("2026-11-19 05:30 UTC") !== -1);
}

console.log("status page never polls");
{
  check("status page has NO setInterval polling",
    statusHtml.indexOf("setInterval") === -1,
    "a setInterval here burns Worker requests on wall-clock time");
  const sixtyCount = (statusHtml.match(/60000/g) || []).length;
  check("status page schedules at most ONE 60s refresh",
    sixtyCount === 1, "found " + sixtyCount + " occurrences of 60000");
  check("the one 60s refresh is a setTimeout for the waking state",
    /setTimeout\([\s\S]*?60000\)/.test(statusHtml),
    "the waking-state refresh must be a single setTimeout, not a loop");
  check("status page does one GET /status on load",
    statusHtml.indexOf("/status") !== -1 &&
    statusHtml.indexOf("loadStatus(false)") !== -1);
  check("status page has a Refresh button for one more request",
    statusHtml.indexOf('id="refreshBtn"') !== -1);
}

console.log("status page keep-alive switch");
{
  check("status page has a keep-alive switch (role=switch)",
    statusHtml.indexOf('role="switch"') !== -1);
  check("status page has an admin token field (type=password)",
    statusHtml.indexOf('type="password"') !== -1);
  check("status page shows the consequence text",
    statusHtml.indexOf("Scheduled runs still wake the machine.") !== -1);
  check("switch POSTs /keepalive on flip",
    statusHtml.indexOf("/keepalive") !== -1 &&
    statusHtml.indexOf("POST") !== -1);
  check("switch sends Authorization: Bearer with the token",
    statusHtml.indexOf("Authorization") !== -1 &&
    statusHtml.indexOf("Bearer ") !== -1);
  check("wake token is kept in sessionStorage only",
    statusHtml.indexOf("sessionStorage") !== -1 &&
    statusHtml.indexOf("agentxWakeToken") !== -1);
  check("wake token is never written to localStorage",
    statusHtml.indexOf('localStorage.getItem("agentxWakeToken")') === -1 &&
    statusHtml.indexOf('localStorage.setItem("agentxWakeToken")') === -1 &&
    statusHtml.indexOf('localStorage.removeItem("agentxWakeToken")') === -1);
  check("wake token is never put in a URL",
    statusHtml.indexOf("?token") === -1);
  check("switch reverts on 401/503 and clears the token on 401",
    statusHtml.indexOf("401") !== -1 && statusHtml.indexOf("503") !== -1 &&
    statusHtml.indexOf('sessionStorage.removeItem("agentxWakeToken")') !== -1);
  check("switch is Unavailable when /status omits keepAlive",
    statusHtml.indexOf("Unavailable") !== -1);
}

console.log("status page actions: open, wake, rest");
{
  check("status page has an Open console action",
    statusHtml.indexOf("Open console") !== -1);
  check("status page has a Wake action",
    statusHtml.indexOf('id="wakeBtn"') !== -1);
  check("status page has a Rest button",
    statusHtml.indexOf('id="restBtn"') !== -1);
  check("rest POSTs /api/machine/rest",
    statusHtml.indexOf("/api/machine/rest") !== -1);
  check("rest confirms first",
    statusHtml.indexOf("confirm(") !== -1);
  check("rest sends the console bearer token from localStorage",
    statusHtml.indexOf('localStorage.getItem("qwenpaw_auth_token")') !== -1);
  check("rest says Sign in to the console first on auth refusal",
    statusHtml.indexOf("Sign in to the console first") !== -1);
  check("status page shows last seen up",
    statusHtml.indexOf('id="lastUpAt"') !== -1);
  check("status page shows the next scheduled run",
    statusHtml.indexOf('id="nextRunAt"') !== -1);
  check("status page shows a state pill",
    statusHtml.indexOf('id="pill"') !== -1);
}

console.log("size budgets (rendered HTML, bytes)");
{
  const wb = Buffer.byteLength(wakingHtml, "utf8");
  const cb = Buffer.byteLength(cooldownHtml, "utf8");
  const sb = Buffer.byteLength(statusHtml, "utf8");
  console.log("  sizes: waking " + wb + "B, cooldown " + cb + "B, status " + sb + "B");
  check("waking <= 9 KB", wb <= 9 * 1024, "got " + wb + "B");
  check("cooldown <= 8 KB", cb <= 8 * 1024, "got " + cb + "B");
  check("status <= 12 KB", sb <= 12 * 1024, "got " + sb + "B");
}

console.log("Hallmark floor, static half");
for (const [name, html] of pages) {
  const css = styleOf(html);
  const firstLine = css.split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
  check("first CSS line of the " + name + " page is the Hallmark stamp",
    firstLine.indexOf("/* Hallmark") === 0, "got: " + firstLine.slice(0, 60));
  check("no transition: all in the " + name + " page",
    css.indexOf("transition: all") === -1 && css.indexOf("transition:all") === -1);
  check("no width/height animation in the " + name + " page",
    !/animation[^;}]*(width|height)/.test(css) &&
    !/transition[^;}]*(width|height)/.test(css));
  check("focus-visible on interactive elements in the " + name + " page",
    css.indexOf(":focus-visible") !== -1);
  check("prefers-reduced-motion fallback in the " + name + " page",
    css.indexOf("prefers-reduced-motion") !== -1);
  check("no purple-blue gradient in the " + name + " page",
    css.indexOf("linear-gradient") === -1);
  check("no emoji icon in the " + name + " page",
    !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html));
}

console.log("\n" + passed + " passed, " + failed.length + " failed");
if (failed.length) { console.log("failed:", failed.join(", ")); process.exit(1); }
