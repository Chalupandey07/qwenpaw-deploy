#!/usr/bin/env node
/**
 * Harness T114 — AgentX rebrand, NO-INJECTION state (2026-11-21).
 *
 * THE CHANGE (2026-11-20/21, Rohan's direction): NO more injection. The
 * Worker used to carry the whole AgentX look as DOM injection —
 * headShim() (fetch/window.open patches), computerPanelScript() (the
 * ~4,700-line client script: BEAUTY_CSS, the AGENTX_RULES MutationObserver
 * table, the thinking selector, the Computer/Vault/Rest pills), the proxy
 * title rewrite, the alreadyBaked skip, the ?rebrand=0 / AGENTX_REBRAND
 * kill switches, and the search-settings-ui.js ("Your Keys") module.
 * All of that now lives in the QwenPaw source itself (image
 * qwenpaw-agentx:2.3.0-source1), and the Worker only forwards the page.
 * The injection was stripped out of pages/public/_worker.js in one pass
 * (5,504 lines -> ~650): every function, variable, CSS block and call
 * that modified the HTML response body, injected a script/style, or
 * rewrote the page is gone — deleted, not just uncalled.
 *
 * WHAT THIS ASSERTS
 *
 *   Static, on the real pages/public/_worker.js:
 *     - NO injection remains: no headShim, no computerPanelScript, no
 *       BEAUTY_CSS, no AGENTX_RULES, no agentxRun*, no injectBeautyStyle,
 *       no alreadyBaked, no AGENTX_REBRAND, no ?rebrand=0, no
 *       search-settings-ui, no agentx-rebrand-baked, no data-agentx-
 *       attributes, none of the four rebrand constants, no
 *       .replace("</body>") body injection, no <title> rewrite.
 *     - The functional services are intact: the proxy, rewriteHeaders,
 *       the ?token= lift, the /status / /computer / /vault / /reset
 *       routes, the /api/session/* mint/state/clear endpoints, the
 *       /api/machine/* rest/sleep/state endpoints, the wake/cooldown
 *       pages, recordLastVisit (and its call site), hashed-asset
 *       immutable caching, the renamed-chunk (-tk) fallback, the 503
 *       wake retry, the 409 cooldown path, the WebSocket passthrough.
 *   Dynamic, in a VM with mocks (the real proxy() extracted from the
 *   file, run against a mock origin):
 *     - console HTML passes through BYTE-IDENTICAL — the origin
 *       <title> is not rewritten, no script/style is injected;
 *     - an HTML page load still records the sleep/wake visit
 *       (ctx.waitUntil + a D1 meta write to sleepwake:last-visit);
 *     - API JSON passes through unchanged and does NOT record a visit;
 *     - ?token= is lifted to an Authorization header and removed
 *       from the forwarded URL;
 *     - a hashed asset gets the immutable 1-year cache header;
 *     - a 409 machine_cooldown returns the cooldown page;
 *     - a 503 wake retries once and returns the 200.
 *
 * The live half (a real browser on the deployed console: title is
 * "AgentX Console", no update badge, no upstream menu items, no
 * upstream navigation, China cards hidden) is verified by Muse after
 * deploy — the console source itself now carries the look.
 *
 * Run: node features/rebrand/harness-rebrand.mjs
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

const worker = readFileSync(resolve(PUBLIC, "_worker.js"), "utf8");

// ---------- extractors (same brace-matching extractor the old harness used) ----------
// Extract a top-level `function name(...) { ... }` by brace matching,
// treating strings / template literals / comments as opaque.
function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start === -1) return "";
  // async functions are declared `async function name(` — the match above
  // starts after "async ", which would drop the keyword and make the
  // extracted function a sync function containing await (SyntaxError).
  // Backtrack over a preceding "async " when one is there.
  if (src.slice(start - 6, start) === "async ") start -= 6;
  const brace = src.indexOf("{", start);
  if (brace === -1) return "";
  let depth = 0;
  let i = brace;
  let mode = null; // null | "'" | '"' | "`" | "//" | "/*"
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

// ---------- static: no injection remains ----------
console.log("static: no HTML injection remains in _worker.js");
{
  const absent = (name, needle) => check(
    `no ${name}`,
    !worker.includes(needle),
    `found ${JSON.stringify(needle)}`,
  );
  absent("headShim()", "function headShim(");
  absent("computerPanelScript()", "function computerPanelScript(");
  absent("BEAUTY_CSS", "BEAUTY_CSS");
  absent("AGENTX_RULES", "AGENTX_RULES");
  absent("agentxRun*", "agentxRun");
  absent("injectBeautyStyle()", "injectBeautyStyle");
  absent("alreadyBaked", "alreadyBaked");
  absent("AGENTX_REBRAND", "AGENTX_REBRAND");
  absent("?rebrand=0", "rebrand=0");
  absent("search-settings-ui", "search-settings-ui");
  absent("agentx-rebrand-baked", "agentx-rebrand-baked");
  absent("data-agentx- attributes", "data-agentx-");
  absent("PINNED_QWENPAW_VERSION", "PINNED_QWENPAW_VERSION");
  absent("PYPI_QWENPAW_URL", "PYPI_QWENPAW_URL");
  absent("UPSTREAM_DOC_ORIGIN", "UPSTREAM_DOC_ORIGIN");
  absent("UPSTREAM_GITHUB_URL", "UPSTREAM_GITHUB_URL");
  absent('body injection (.replace("</body>"))', 'replace("</body>"');
  absent("title rewrite", 'replace("<title>QwenPaw Console</title>"');
}

// ---------- static: the functional services are intact ----------
console.log("static: the proxy and the functional services are intact");
{
  check("proxy() exists",
    worker.includes("async function proxy(request, url, env, ctx)"));
  check("rewriteHeaders() exists",
    worker.includes("function rewriteHeaders(res, pagesOrigin)"));
  check("?token= is lifted to an Authorization header and removed from the URL",
    worker.includes('searchParams.get("token")')
    && worker.includes('"Bearer " + queryToken')
    && worker.includes("fwdUrl.searchParams.delete(\"token\")"));
  check("/status route exists",
    worker.includes('if (path === "/status" || path === "/status.html")'));
  check("/computer route exists",
    worker.includes('if (path === "/computer" || path.startsWith("/computer/")'));
  check("/vault route exists",
    worker.includes('if (path === "/vault" || path.startsWith("/vault/")'));
  check("/reset route exists",
    worker.includes('if (path === "/reset" || path.startsWith("/reset/")'));
  check("/api/session/mint route exists",
    worker.includes('if (path === "/api/session/mint")'));
  check("/api/session/state route exists",
    worker.includes('if (path === "/api/session/state")'));
  check("/api/session/clear route exists",
    worker.includes('if (path === "/api/session/clear")'));
  check("/api/machine/rest route exists",
    worker.includes('if (path === "/api/machine/rest")'));
  check("/api/machine/sleep route exists",
    worker.includes('if (path === "/api/machine/sleep")'));
  check("/api/machine/state route exists",
    worker.includes('if (path === "/api/machine/state")'));
  check("computer/vault/reset/machine handlers are imported",
    ["handleComputer", "handleVault", "handleReset", "restMachine",
     "sleepMachine", "machineState", "authenticate", "mintSession"]
      .every((n) => worker.includes(n)));
  check("wake/cooldown helpers exist",
    ["function wakingPage(", "function cooldownPage(",
     "function fmtCooldownRemaining(", "function parseRetryAfter("]
      .every((n) => worker.includes(n)));
  check("recordLastVisit() exists",
    worker.includes("async function recordLastVisit(env)"));
  check("recordLastVisit() is called from proxy() for HTML page loads",
    worker.includes("ctx.waitUntil(recordLastVisit(env))"));
  check("hashed-asset immutable caching is intact",
    worker.includes("public, max-age=31536000, immutable"));
  check("renamed-chunk (-tk) fallback is intact",
    worker.includes("-tk[0-9]+"));
  check("503 wake retry is intact",
    worker.includes("WAKE_WAIT_MS") && worker.includes("wakingPage(retryAfter)"));
  check("409 cooldown path is intact",
    worker.includes("machine_cooldown") && worker.includes("cooldownPage(retryAfter, untilText)"));
  check("WebSocket upgrade passthrough is intact",
    worker.includes("res.status === 101 && res.webSocket"));
}

// ---------- dynamic: the real proxy() in a VM against a mock origin ----------
console.log("dynamic: the real proxy() forwards without modifying the page");
{
  // Load the real proxy() and its dependencies out of _worker.js into a
  // sandbox. sleep is stubbed to resolve immediately so the 503 wake
  // retry (WAKE_WAIT_MS = 45 s live) costs nothing here.
  let fetchImpl = null;
  const sandbox = {
    ORIGIN: "https://origin.test",
    WAKE_WAIT_MS: 0,
    sleep: () => Promise.resolve(),
    fetch: (...args) => fetchImpl(...args),
    Response, Headers, Request, URL,
    console,
  };
  vm.createContext(sandbox);
  for (const name of ["rewriteHeaders", "fmtCooldownRemaining", "wakingPage",
    "cooldownPage", "parseRetryAfter", "recordLastVisit", "proxy"]) {
    const fnSrc = extractFunction(worker, name);
    check(`dynamic setup: ${name}() extracts from _worker.js`, fnSrc.length > 0);
    if (fnSrc) vm.runInContext(fnSrc, sandbox);
  }

  async function callProxy({ url, method = "GET", headers = {}, env = {}, behavior }) {
    fetchImpl = behavior;
    const waitUntilCalls = [];
    const ctx = { waitUntil: (p) => { waitUntilCalls.push(p); } };
    sandbox.req = new Request(url, { method, headers });
    sandbox.url = new URL(url);
    sandbox.env = env;
    sandbox.ctx = ctx;
    const resp = await vm.runInContext("proxy(req, url, env, ctx)", sandbox);
    return { resp, waitUntilCalls };
  }

  function mockDb(calls) {
    return {
      prepare: (sql) => ({
        bind: (...args) => ({
          first: async () => { calls.push(["first", sql, args]); return null; },
          run: async () => { calls.push(["run", sql, args]); return {}; },
        }),
      }),
    };
  }

  { // D1: console HTML passes through byte-identical; the visit is recorded.
    const originHtml = "<!doctype html><html><head><title>QwenPaw Console</title></head>"
      + "<body><div id=\"root\"></div></body></html>";
    const dbCalls = [];
    const { resp, waitUntilCalls } = await callProxy({
      url: "https://qwenpawx.pages.dev/chat",
      env: { COMPUTER_DB: mockDb(dbCalls) },
      behavior: async () => new Response(originHtml,
        { status: 200, headers: { "Content-Type": "text/html" } }),
    });
    const body = await resp.text();
    check("dynamic: console HTML passes through byte-identical (no injection)",
      body === originHtml, `got ${body.slice(0, 100)}`);
    check("dynamic: the origin <title> is NOT rewritten",
      body.includes("<title>QwenPaw Console</title>"));
    check("dynamic: no script/style is injected into console HTML",
      !body.includes("<script") && !body.includes("<style"));
    check("dynamic: an HTML page load records a visit (waitUntil fires)",
      waitUntilCalls.length === 1, `waitUntil calls=${waitUntilCalls.length}`);
    await Promise.all(waitUntilCalls);
    check("dynamic: the visit write goes to D1 meta sleepwake:last-visit",
      dbCalls.some(([op, , args]) => op === "run" && args[0] === "sleepwake:last-visit"),
      `dbCalls=${JSON.stringify(dbCalls)}`);
  }

  { // D2: API JSON passes through unchanged and records no visit.
    const { resp, waitUntilCalls } = await callProxy({
      url: "https://qwenpawx.pages.dev/api/chats",
      behavior: async () => new Response('{"ok":true}',
        { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    check("dynamic: API JSON passes through unchanged",
      (await resp.text()) === '{"ok":true}');
    check("dynamic: API polling does NOT record a visit",
      waitUntilCalls.length === 0, `waitUntil calls=${waitUntilCalls.length}`);
  }

  { // D3: ?token= is lifted to a header and removed from the forwarded URL.
    let captured = null;
    await callProxy({
      url: "https://qwenpawx.pages.dev/api/chats?token=abc123",
      behavior: async (req) => {
        captured = req;
        return new Response("{}",
          { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const fwdUrl = new URL(captured.url);
    check("dynamic: ?token= is lifted to an Authorization header",
      captured.headers.get("Authorization") === "Bearer abc123",
      `got ${captured.headers.get("Authorization")}`);
    check("dynamic: ?token= is removed from the forwarded URL",
      !fwdUrl.searchParams.has("token"), `forwarded ${fwdUrl.search}`);
  }

  { // D4: a hashed asset gets the immutable 1-year cache header.
    const { resp } = await callProxy({
      url: "https://qwenpawx.pages.dev/assets/index-ABCDEF123.js",
      behavior: async () => new Response("console.log(1)",
        { status: 200, headers: { "Content-Type": "text/javascript" } }),
    });
    check("dynamic: hashed asset gets immutable 1y cache",
      resp.headers.get("Cache-Control") === "public, max-age=31536000, immutable",
      `got ${resp.headers.get("Cache-Control")}`);
  }

  { // D5: a 409 machine_cooldown returns the cooldown page.
    const { resp } = await callProxy({
      url: "https://qwenpawx.pages.dev/chat",
      behavior: async () => new Response(
        JSON.stringify({ error: { code: "machine_cooldown", message: "machine is cooling down until 2026-11-21T05:00:00Z" } }),
        { status: 409, headers: { "Content-Type": "application/json" } }),
    });
    const body = await resp.text();
    check("dynamic: 409 machine_cooldown returns the cooldown page",
      resp.status === 503 && body.includes("AgentX is in max-run cooldown"),
      `status=${resp.status} body=${body.slice(0, 80)}`);
  }

  { // D6: a 503 wake retries once and returns the 200.
    let calls = 0;
    const { resp } = await callProxy({
      url: "https://qwenpawx.pages.dev/chat",
      behavior: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("waking",
            { status: 503, headers: { "Content-Type": "text/plain" } });
        }
        return new Response("<html><div id=\"root\"></div></html>",
          { status: 200, headers: { "Content-Type": "text/html" } });
      },
    });
    check("dynamic: 503 wake retries once and returns the 200",
      resp.status === 200 && calls === 2, `status=${resp.status} calls=${calls}`);
  }
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { console.log("failed:", failed.join(", ")); process.exit(1); }
