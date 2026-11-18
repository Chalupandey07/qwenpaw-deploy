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

// Fake a SIGNED-IN browser. /computer/* gained a hard auth gate on 2026-11-16
// (an anonymous curl used to read a desktop screenshot and mint a root shell);
// a harness is a fake browser, and a signed-in browser sends a session cookie.
import { sessionCookie, requestWith } from "./_session.mjs";

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

// The /computer surface needs a session from 2026-11-16. Mint one against the
// harness's own secret so the fake browser is genuinely signed in.
const SESSION_SECRET = "harness-session-secret-0123456789";
const COOKIE = await sessionCookie({ COMPUTER_SESSION_SECRET: SESSION_SECRET });

/** A Request for `path`, carrying the harness's session cookie. */
const asUser = (path, init = {}) => requestWith(path, init, COOKIE);

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
    res.headers.get("Referrer-Policy") === "no-referrer",
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
  const res = await mod.default.fetch(asUser("/computer"), { ASSETS: assets, COMPUTER_SESSION_SECRET: SESSION_SECRET }, {});
  check("/computer serves HTML", res.status === 200 && (res.headers.get("Content-Type") || "").includes("text/html"),
    `${res.status} ${res.headers.get("Content-Type")}`);
  const html = await res.text();
  check("it is the real UI, not the placeholder",
    html.includes("<!doctype html>") && !html.includes("asset missing"), html.slice(0, 80));
  check("the UI is not frameable cross-origin",
    (res.headers.get("Content-Security-Policy") || "").includes("frame-ancestors 'self'"));

  // A missing asset binding must be a loud 500 with an actionable message,
  // never a silent empty page.
  const noAssets = await mod.default.fetch(asUser("/computer"), { COMPUTER_SESSION_SECRET: SESSION_SECRET }, {});
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
    const res = await mod.default.fetch(asUser(path), { COMPUTER_SESSION_SECRET: SESSION_SECRET }, {});
    check(`${path} with no COMPUTER_DB -> 503`, res.status === 503, String(res.status));
    const body = await res.json().catch(() => ({}));
    check(`${path} names the failure`, body.error === "store", JSON.stringify(body));
  }
  const post = await mod.default.fetch(asUser("/computer/takeover", {
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
    asUser("/computer/preview?computer=default"), { COMPUTER_SESSION_SECRET: SESSION_SECRET }, {});
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
    asUser("/computer/state?computer=default"),
    { COMPUTER_DB: okDb, COMPUTER_SESSION_SECRET: SESSION_SECRET }, {});
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
  const res = await mod.default.fetch(asUser("/computer/nope"), { COMPUTER_SESSION_SECRET: SESSION_SECRET }, {});
  check("unknown subpath -> 404", res.status === 404, String(res.status));
}

// ---------------------------------------------------------------------------
// THE REGRESSION TEST FOR THE 2026-11-16 P0.
//
// `/computer/*` shipped with NO authentication at all. Verified live against
// the deployed Worker before this fix:
//
//   GET  /computer/preview?computer=default -> 200 image/png, 381,490 bytes
//        (a real 1920x1080 screenshot of the user's desktop)
//   POST /computer/takeover {computer:"qa"} -> 200 + a live leaseId
//   GET  /computer/session?computer=qa      -> {"ok":true,"policy":"control"}
//   POST /computer/terminal/session         -> 200 + a terminal capability URL
//
// The last one is a pre-authentication ROOT SHELL: minting needs only a live
// lease, and a lease needed only an unauthenticated POST.
//
// These checks fail on the pre-fix tree. They are the reason the gate cannot
// be quietly removed again: every user-facing path is asserted REFUSED without
// a cookie, and the three capability/token surfaces are asserted to still work
// (they carry their own, stronger authorization).
// ---------------------------------------------------------------------------
console.log("worker: /computer refuses an ANONYMOUS caller (P0 regression)");
{
  const env = { COMPUTER_SESSION_SECRET: SESSION_SECRET, ASSETS: assets };
  const anonPaths = [
    ["GET", "/computer/state?computer=default"],
    ["GET", "/computer/state?computer=qa"],
    ["GET", "/computer/computers"],
    ["GET", "/computer/preview?computer=default"],
    ["GET", "/computer/session?computer=default"],
    ["POST", "/computer/takeover"],
    ["POST", "/computer/heartbeat"],
    ["POST", "/computer/release"],
    ["POST", "/computer/mode"],
    ["POST", "/computer/wake"],
    ["POST", "/computer/teach"],
    ["POST", "/computer/needs-you/resolve"],
  ];
  for (const [method, path] of anonPaths) {
    const res = await mod.default.fetch(new Request("https://qwenpawx.pages.dev" + path, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : {},
      body: method === "POST" ? "{}" : undefined,
    }), env, {});
    check(`ANON ${method} ${path} -> 401`, res.status === 401, String(res.status));
    const body = await res.json().catch(() => ({}));
    check(`…${path} does not leak state`, body.error === "auth_required", JSON.stringify(body).slice(0, 80));
  }

  // A FORGED cookie must be refused exactly like an absent one. If these two
  // answers ever differ, an attacker learns which guesses were close.
  for (const bad of ["v1.9999999999999.deadbeef", "garbage", "v1.x.y"]) {
    const res = await mod.default.fetch(requestWith("/computer/state?computer=default", {}, bad), env, {});
    check(`forged cookie "${bad.slice(0, 12)}…" -> 401`, res.status === 401, String(res.status));
  }

  // The gate must run BEFORE the store: an anonymous caller must never cost a
  // lease, a generation, a preview read, or an HMAC mint. Proven by using an
  // env with NO COMPUTER_DB — a store-first implementation would answer 503.
  const noStore = await mod.default.fetch(
    new Request("https://qwenpawx.pages.dev/computer/takeover", { method: "POST", body: "{}" }),
    { COMPUTER_SESSION_SECRET: SESSION_SECRET }, {});
  check("the gate runs BEFORE the store (401, not 503)", noStore.status === 401, String(noStore.status));

  // ---------------------------------------------------------------------
  // B-39: the page itself must be REACHABLE, and this is the assertion that
  // would have caught the lockout.
  //
  // The previous version of this check accepted `200 || 401`, which is why it
  // stayed green while every logged-in user was locked out: a gate on
  // `/computer` returns 401 BEFORE `serveUi` runs, so the page's own
  // `ensureSession()` — the only caller of `/api/session/mint` in the tree —
  // never executes and the cookie is never minted. A test that accepts the
  // broken answer is not a test.
  //
  // So: an ANONYMOUS visitor with no cookie at all must receive the UI,
  // because the page is the only way to ask for a session.
  const ui = await mod.default.fetch(
    new Request("https://qwenpawx.pages.dev/computer"),
    { ASSETS: assets, COMPUTER_SESSION_SECRET: SESSION_SECRET }, {});
  check("ANON GET /computer -> 200 (the page is the way in)", ui.status === 200,
    `${ui.status} — a 401 here is the chicken-and-egg lockout`);
  check("…and it is the HTML UI, not a JSON error",
    (ui.headers.get("Content-Type") || "").includes("text/html"),
    String(ui.headers.get("Content-Type")));
  const uiBody = await ui.text();
  check("…carrying the sign-in affordance and the mint call",
    uiBody.includes("<!doctype html>") && uiBody.includes("/api/session/mint"),
    uiBody.slice(0, 80));
  check("…and it still refuses to be framed cross-origin",
    (ui.headers.get("Content-Security-Policy") || "").includes("frame-ancestors 'self'"),
    String(ui.headers.get("Content-Security-Policy")));

  // `/computer/` (trailing slash) must behave identically — a lockout that
  // only affects one spelling is a bug that reappears in someone's bookmark.
  const uiSlash = await mod.default.fetch(
    new Request("https://qwenpawx.pages.dev/computer/"),
    { ASSETS: assets, COMPUTER_SESSION_SECRET: SESSION_SECRET }, {});
  check("ANON GET /computer/ -> 200 too", uiSlash.status === 200, String(uiSlash.status));

  // THE OTHER HALF OF B-39: the page must be able to FIND the console's token.
  //
  // `qwenpaw_auth_token` is the key the deployed console bundle actually uses
  // (it declares `Id = "qwenpaw_auth_token"`, reads it in `It()`, writes it in
  // `Z$()`). `ui.html` used to look only for [token, qwenpaw_token,
  // qwenpaw-token, access_token] — none of which is real — so even a reachable
  // page could not mint, and a signed-in user was told to sign in. Both halves
  // were the same bug and both are asserted here.
  const uiSrc = readFileSync(resolve(PUBLIC, "computer/ui.html"), "utf8");
  check("ui.html reads the console's REAL localStorage key",
    /qwenpaw_auth_token/.test(uiSrc),
    "without it, ensureSession() finds no token and the user is told to sign in");
  check("…and the real key is tried FIRST",
    /\["qwenpaw_auth_token",/.test(uiSrc),
    "a fallback list that reaches it later still works, but first is honest");
  // The two checks above can both be satisfied by a DECORATIVE mention (a
  // comment, a string in an unused branch) because they only test for presence.
  // A mutation test showed exactly that: deleting the key from the lookup array
  // still left "…tried FIRST" failing but let "reads the real key" pass, because
  // the comment above the array names it. This one reads the array itself, so
  // only a real lookup entry satisfies it.
  const keyList = /var keys = \[([^\]]*)\];/.exec(uiSrc);
  check("…in the ACTUAL lookup array, not just a comment",
    Boolean(keyList) && /"qwenpaw_auth_token"/.test(keyList[1]),
    keyList ? keyList[1].slice(0, 90) : "no `var keys = [...]` found");

  // Serving the page must not touch the store: a page load that costs a lease
  // read on every visit is a different bug.
  const uiNoStore = await mod.default.fetch(
    new Request("https://qwenpawx.pages.dev/computer"),
    { ASSETS: assets, COMPUTER_SESSION_SECRET: SESSION_SECRET }, {});
  check("…and serving it needs no COMPUTER_DB at all", uiNoStore.status === 200,
    String(uiNoStore.status));

  // B-39 must not have opened a door: the DATA endpoints are still gated.
  // Asserted again here for the two closest neighbours of the page itself, so
  // a future "exempt /computer" edit that accidentally exempts children fails.
  for (const p of ["/computer/state?computer=default", "/computer/computers"]) {
    const res = await mod.default.fetch(
      new Request("https://qwenpawx.pages.dev" + p),
      { ASSETS: assets, COMPUTER_SESSION_SECRET: SESSION_SECRET }, {});
    check(`ANON ${p} is STILL 401 after the page was exempted`, res.status === 401,
      String(res.status));
  }

  // ---------------------------------------------------------------------
  // B-39, the whole journey a real user takes — in order, because the ORDER is
  // the bug. A signed-in user with no cookie yet must be able to:
  //
  //   1. load /computer            (anonymous; exempt)
  //   2. POST /api/session/mint    (their console bearer, verified)
  //   3. load /computer with the cookie, and reach the DATA
  //
  // Step 2 in the harness stubs the console's auth probe, so what is under
  // test is OUR mint -> verify -> gate chain, not QwenPaw's login.
  //
  // Before B-39 this journey could not start: step 1 answered 401, so the page
  // never ran `ensureSession()` and step 2 was never attempted.
  // A minimal healthy store, local to this block (the one above is scoped to
  // its own test). `stateFor()` needs generations + modes + leases + needs_you.
  const journeyStmt = {
    async run() { return { success: true, meta: { changes: 1 } }; },
    async first() { return null; },
    async all() { return { results: [] }; },
  };
  const journeyDb = {
    prepare: () => ({ ...journeyStmt, bind: () => journeyStmt }),
    batch: async (stmts) => stmts.map(() => ({ success: true })),
  };
  const journeyEnv = { ASSETS: assets, COMPUTER_SESSION_SECRET: SESSION_SECRET,
                       COMPUTER_DB: journeyDb };

  const step1 = await mod.default.fetch(
    new Request("https://qwenpawx.pages.dev/computer"), journeyEnv, {});
  check("journey 1/4: anonymous /computer loads the page", step1.status === 200,
    String(step1.status));

  // Mint. The console probe is stubbed to accept exactly one token, so a fake
  // success would be caught by the negative case below.
  const CONSOLE_TOKEN = "console-session-token-for-the-journey";
  const realFetch = globalThis.fetch;
  // NOTE the second argument: `authenticate()` calls `fetch(url, {headers})`,
  // so the headers live in `init`, not on the first argument. A stub that only
  // reads `input.headers` sees null and rejects every token — which is how the
  // first version of this block reported a mint failure that did not exist.
  globalThis.fetch = async (input, init) => {
    const u = String(input && input.url ? input.url : input);
    const hdrs = new Headers((init && init.headers) || (input && input.headers) || {});
    if (u.includes("/api/cron/jobs")) {
      return hdrs.get("Authorization") === "Bearer " + CONSOLE_TOKEN
        ? new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } })
        : new Response("no", { status: 401 });
    }
    return new Response("stub", { status: 200 });
  };
  let minted;
  try {
    const mintRes = await mod.default.fetch(new Request(
      "https://qwenpawx.pages.dev/api/session/mint", {
        method: "POST",
        headers: { Authorization: "Bearer " + CONSOLE_TOKEN },
      }), journeyEnv, {});
    check("journey 2/4: the console session mints a cookie", mintRes.status === 200,
      String(mintRes.status));
    const setCookie = mintRes.headers.get("Set-Cookie") || "";
    check("…the cookie is HttpOnly, Secure and SameSite=Lax",
      /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Lax/i.test(setCookie),
      setCookie.slice(0, 90));
    minted = /DESKTOP_SESSION=([^;]+)/.exec(setCookie);
    check("…and it is a DESKTOP_SESSION value", Boolean(minted), setCookie.slice(0, 60));
  } finally {
    globalThis.fetch = realFetch;
  }

  // A BOGUS console token must not mint. Without this, the journey above would
  // "pass" against a mint that accepts anyone.
  globalThis.fetch = async () => new Response("no", { status: 401 });
  try {
    const bad = await mod.default.fetch(new Request(
      "https://qwenpawx.pages.dev/api/session/mint", {
        method: "POST",
        headers: { Authorization: "Bearer not-a-real-console-token" },
      }), journeyEnv, {});
    check("journey 2b: a rejected console token mints NOTHING", bad.status === 401,
      String(bad.status));
    check("…and sets no cookie",
      !/DESKTOP_SESSION=/.test(bad.headers.get("Set-Cookie") || ""),
      String(bad.headers.get("Set-Cookie")));
  } finally {
    globalThis.fetch = realFetch;
  }

  if (minted) {
    const cookie = "DESKTOP_SESSION=" + minted[1];
    const step3 = await mod.default.fetch(
      requestWith("/computer", { headers: { Cookie: cookie } }, minted[1]), journeyEnv, {});
    check("journey 3/4: the page loads for the holder", step3.status === 200,
      String(step3.status));

    const step4 = await mod.default.fetch(
      requestWith("/computer/state?computer=default", {}, minted[1]), journeyEnv, {});
    check("journey 4/4: the DATA is reachable with that cookie", step4.status === 200,
      String(step4.status) + " " + JSON.stringify(await step4.json().catch(() => ({}))).slice(0, 80));
  } else {
    check("journey 3/4: the page loads for the holder", false, "no cookie was minted");
    check("journey 4/4: the DATA is reachable with that cookie", false, "no cookie was minted");
  }

  // A missing secret is a DEPLOY error, and must say so instead of looping the
  // user through a sign-in that cannot succeed.
  const unconfigured = await mod.default.fetch(
    new Request("https://qwenpawx.pages.dev/computer/state?computer=default"), {}, {});
  check("no secret -> 503 session_unconfigured, never a fake 401 loop",
    unconfigured.status === 503, String(unconfigured.status));
}

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
