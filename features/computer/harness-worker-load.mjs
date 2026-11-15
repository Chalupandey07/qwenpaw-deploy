#!/usr/bin/env node
/**
 * Harness: does `pages/public/_worker.js` actually LOAD and RUN?
 *
 * Why this file exists. On 2026-11-15 the computer was removed with an
 * 8,399-line cut. The cut deleted three top-level functions —
 * `sleep`, `rewriteHeaders` and `consolePanelScript` — but left their call
 * sites inside `proxy()`. Separately, `computer/router.js` imported
 * `LEASE_CAP_GRACE_MS` from `capability.js`, which does not export it.
 *
 * Both are fatal, and both were invisible to every existing check:
 *
 *   - The harnesses in this directory import `capability.js`, `policy.js`
 *     and read `state.js` and `router.js` as TEXT. Reading a file proves it
 *     contains a string. It does not prove it parses, links, or runs.
 *   - `run-tests.py` exercised the machine and the live URLs. The live URLs
 *     were still on the previous deployment, so they answered.
 *   - `node --check` would have caught the missing exports but nobody ran it
 *     against an ES module graph.
 *
 * The result: a repo whose entire Pages Worker threw `ReferenceError` on
 * every proxied request and `SyntaxError` at import time — the console, not
 * just the computer — while the suite stayed green.
 *
 * That is the recorded lesson ("a suite that stays green because nothing
 * runs is worse than a red suite") in its purest form, so this harness
 * asserts the boring, decisive things: it imports, it exports a fetch
 * handler, a normal console request returns HTML with the panel injected,
 * `/computer` serves the UI asset, and a missing store answers 503 rather
 * than 500. No network, no account, no machine.
 *
 * Run: node features/computer/harness-worker-load.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PUBLIC = resolve(REPO, "pages/public");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

/** A fetch stub, installed for the duration of one call and always restored. */
const realFetch = globalThis.fetch;
function withFetch(impl, fn) {
  globalThis.fetch = impl;
  try { return fn(); } finally { globalThis.fetch = realFetch; }
}

const SPA = `<!doctype html><html><head><title>QwenPaw Console</title></head>` +
  `<body><div id="root"></div><script src="/assets/index.js"></script></body></html>`;

const assets = {
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/computer/ui.html") {
      const disk = resolve(PUBLIC, "computer/ui.html");
      const body = existsSync(disk) ? readFileSync(disk) : "missing";
      return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },
};

console.log("worker: it loads at all");

let mod = null;
let loadError = null;
try {
  mod = await import("file://" + resolve(PUBLIC, "_worker.js"));
} catch (e) {
  loadError = e;
}
check("_worker.js imports without throwing", mod !== null,
  loadError ? `${loadError.constructor.name}: ${loadError.message}` : "");
check("it exports a fetch handler", typeof mod?.default?.fetch === "function",
  typeof mod?.default?.fetch);

if (!mod) {
  console.log("\nThe Worker does not load. Nothing else in this file can be checked.");
  console.log(`${passed} passed, ${failed.length + 1} failed`);
  process.exit(1);
}

console.log("worker: the console proxy still works");
{
  // A healthy origin, so the happy path is exercised rather than an error path.
  const res = await withFetch(
    async () => new Response(SPA, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }),
    () => mod.default.fetch(new Request("https://qwenpawx.pages.dev/chat"), { ASSETS: assets }, {}),
  );
  check("a console request is 200", res.status === 200, String(res.status));
  const html = await res.text();
  check("the console HTML is passed through", html.includes('<div id="root">'));
  check("the Computer launcher is injected",
    html.includes("qwenpawComputerBtn") && html.includes("qwenpawComputerPanel"),
    "the launcher is the only thing this file adds to the SPA");
  check("the launcher does not call the deleted /desktop endpoints",
    !html.includes("/desktop/__") && !html.includes("/desktop/__screen"),
    "those routes went away with the computer rebuild");
  check("Referrer-Policy is set (query-token leak mitigation)",
    res.headers.get("Referrer-Policy") === "same-origin",
    String(res.headers.get("Referrer-Policy")));
  check("HTML is not frameable cross-origin",
    res.headers.get("X-Frame-Options") === "SAMEORIGIN",
    String(res.headers.get("X-Frame-Options")));
}

console.log("worker: every function it calls exists");
{
  // The three ReferenceErrors, asserted by name. A missing identifier is a
  // load-time error only if it sits in a top-level statement; inside a
  // function body it waits until that path runs. So the call sites are
  // exercised, not merely grepped.
  const src = readFileSync(resolve(PUBLIC, "_worker.js"), "utf8");
  const declared = new Set(
    [...src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^const\s+([A-Za-z_$][\w$]*)\s*=/gm)]
      .map((m) => m[1] || m[2]),
  );
  for (const name of ["sleep", "rewriteHeaders", "computerPanelScript", "proxy"]) {
    check(`_worker.js declares ${name}()`, declared.has(name),
      "declared at top level: " + [...declared].join(", "));
  }
}

console.log("worker: redirect and cookie hygiene (audit A-6, restored with rewriteHeaders)");
{
  // [Location, expected after rewrite, label]
  const cases = [
    ["https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech/home",
      "https://qwenpawx.pages.dev/home", "own origin -> rewritten to Pages"],
    ["//evil.example/x", null, "protocol-relative foreign -> dropped"],
    ["https://evil.example/x", null, "absolute foreign -> dropped"],
    ["/relative/path", "/relative/path", "relative -> passes through"],
  ];
  for (const [loc, want, label] of cases) {
    const res = await withFetch(
      async () => new Response(SPA, {
        status: 302,
        headers: { "Content-Type": "text/html", Location: loc },
      }),
      () => mod.default.fetch(new Request("https://qwenpawx.pages.dev/chat"), { ASSETS: assets }, {}),
    );
    const got = res.headers.get("Location");
    check(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  // A cookie with a Domain attribute must become host-only for Pages.
  const cookieRes = await withFetch(
    async () => new Response(SPA, {
      status: 200,
      headers: { "Content-Type": "text/html", "Set-Cookie": "s=1; Domain=.instabox.tech; Path=/" },
    }),
    () => mod.default.fetch(new Request("https://qwenpawx.pages.dev/chat"), { ASSETS: assets }, {}),
  );
  const setCookie = cookieRes.headers.get("Set-Cookie") || "";
  check("a Set-Cookie Domain is stripped",
    !/domain=/i.test(setCookie) && setCookie.includes("s=1"), setCookie);
}

console.log("worker: /computer is wired, not a 404");
{
  const res = await mod.default.fetch(new Request("https://qwenpawx.pages.dev/computer"), { ASSETS: assets }, {});
  check("/computer serves HTML", res.status === 200 && (res.headers.get("Content-Type") || "").includes("text/html"),
    `${res.status} ${res.headers.get("Content-Type")}`);
  const html = await res.text();
  check("it is the real UI, not the placeholder",
    html.includes("<!doctype html>") && !html.includes("asset missing"), html.slice(0, 80));
  check("the UI is not frameable cross-origin",
    (res.headers.get("Content-Security-Policy") || "").includes("frame-ancestors 'self'"));

  // A missing asset binding must be a loud 500 with an actionable message,
  // never a silent empty page.
  const noAssets = await mod.default.fetch(new Request("https://qwenpawx.pages.dev/computer"), {}, {});
  check("a missing ASSETS binding is an honest 500", noAssets.status === 500, String(noAssets.status));
  check("and it names the missing file",
    (await noAssets.text()).includes("computer/ui.html"));
}

console.log("worker: a broken store is a 503, never a 500 or a lie");
{
  // The router must translate a missing/therefore broken D1 binding into
  // `503 {error:"store"}`, which is B-25's fix. A 500 here was T52's recorded
  // symptom ("Take control 500 on five attempts").
  for (const path of [
    "/computer/state?computer=default",
    "/computer/session?computer=default",
  ]) {
    const res = await mod.default.fetch(new Request("https://qwenpawx.pages.dev" + path), {}, {});
    check(`${path} with no COMPUTER_DB -> 503`, res.status === 503, String(res.status));
    const body = await res.json().catch(() => ({}));
    check(`${path} names the failure`, body.error === "store", JSON.stringify(body));
  }
  const post = await mod.default.fetch(new Request("https://qwenpawx.pages.dev/computer/takeover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ computer: "default" }),
  }), {}, {});
  check("takeover with no store -> 503 (not 500)", post.status === 503, String(post.status));
}

console.log("worker: broken-store reporting is never ambiguous (B-14 / B-15)");
{
  // B-15: `generation: 0` is a legitimate value (never taken over), so a read
  // error must not produce it. B-14: a discarded result hides store health.
  // Both are the same defect — an error that looks like data — so both are
  // asserted where a browser would see them.
  const prevRes = await mod.default.fetch(
    new Request("https://qwenpawx.pages.dev/computer/preview?computer=default"), {}, {});
  check("a broken store on /preview is 503, not 404",
    prevRes.status === 503,
    `${prevRes.status} — 404 must keep meaning "never captured"`);
  check("and it names the store",
    (await prevRes.json().catch(() => ({}))).error === "store");

  // With a WORKING store, `store: "ok"` must be present and explicit: health
  // is reported, never inferred from which fields happen to be null.
  const { default: makeDb } = { default: null };
  const okDb = {
    prepare(sql) {
      // Real D1 supports BOTH `prepare(sql).bind(...)` and bare
      // `prepare(sql).run()`; ensureSchema uses the bare form for its DDL.
      const stmt = {
        async run() { return { success: true, meta: { changes: 1 } }; },
        async first() {
          if (/FROM generations/.test(sql)) return { gen: 7 };
          if (/FROM modes/.test(sql)) return { mode: "private" };
          if (/FROM leases/.test(sql)) return null;
          if (/FROM needs_you/.test(sql)) return null;
          // preview_meta: an existing table with no row = "no preview yet",
          // which is a healthy empty value, not a degraded store.
          return null;
        },
        async all() { return { results: [] }; },
      };
      return { ...stmt, bind: () => stmt };
    },
  };
  const good = await mod.default.fetch(
    new Request("https://qwenpawx.pages.dev/computer/state?computer=default"),
    { COMPUTER_DB: okDb }, {});
  check("a healthy store answers 200", good.status === 200, String(good.status));
  const goodBody = await good.json().catch(() => ({}));
  check("it reports store: \"ok\" explicitly", goodBody.store === "ok", JSON.stringify(goodBody.store));
  check("and the real generation (7), not a default 0",
    goodBody.generation === 7, String(goodBody.generation));
  check("and the real mode", goodBody.mode === "private", String(goodBody.mode));
}

console.log("worker: no latency padding on the screen path (B-13)");
{
  // B-13 recorded two `sleep(200)` / `sleep(250)` retries inside the capability
  // path — pure added latency on the most latency-sensitive request in the
  // system, papering over KV replication lag that D1 does not have.
  for (const f of ["capability.js", "state.js", "router.js"]) {
    const src = readFileSync(resolve(PUBLIC, "computer", f), "utf8");
    const code = src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    check(`${f} contains no sleep()`, !/\bsleep\s*\(/.test(code),
      "a fixed sleep is not a retry strategy");
    check(`${f} contains no sleep-like timeout on a request path`,
      !/await new Promise\([^)]*setTimeout/.test(code),
      "latency padding belongs nowhere near a per-request path");
  }
}

console.log("worker: unknown /computer paths are 404, not a crash");
{
  const res = await mod.default.fetch(new Request("https://qwenpawx.pages.dev/computer/nope"), {}, {});
  check("unknown subpath -> 404", res.status === 404, String(res.status));
}

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
