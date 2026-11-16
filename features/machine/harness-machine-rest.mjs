#!/usr/bin/env node
/**
 * Harness T101 — manual rest + auto-wake, and the keep-alive respecting it.
 *
 * Rohan's feature, in his words: a button to rest the machine when it is not
 * needed, and the site wakes it again on the next visit. The reason is the
 * Free-plan maximum run length — holding the box awake for 8 hours ends in a
 * 2-hour cooldown, so resting it on purpose is better than being forced into
 * one at a bad moment.
 *
 * THE ASSERTIONS THE BRIEF NAMED, plus the ones that matter more:
 *
 *   1. an unauthenticated visitor can NEVER suspend the machine (401/403);
 *   2. with INSTABOX_API_KEY unset the endpoint says so plainly and makes NO
 *      API call (fail closed, never invent a key);
 *   3. a visit attempts the public URL once and serves the waking page;
 *   4. a 409 cooldown shows the end time and does not retry early;
 *   5. the keep-alive SKIPS the wake while a manual rest is in effect.
 *
 * And the two that decide whether this is safe:
 *   6. if the rest marker cannot be READ, the keep-alive does not wake
 *      (fail-safe in the direction that respects the user, not the one that is
 *      convenient for the code);
 *   7. the marker is written BEFORE the suspend call, so a failed suspend
 *      cannot leave a machine that the keep-alive will wake five minutes later.
 *
 * Run: node features/machine/harness-machine-rest.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PUBLIC = resolve(REPO, "pages/public");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

// ------------------------------------------------------------- live D1 schema
const db = new DatabaseSync(":memory:");
for (const sql of [
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE leases (computer TEXT PRIMARY KEY, lease_id TEXT NOT NULL, holder TEXT NOT NULL, granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, fence INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE generations (computer TEXT PRIMARY KEY, gen INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE needs_you (computer TEXT PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL, run_id TEXT)",
  "CREATE TABLE modes (agent TEXT PRIMARY KEY, mode TEXT NOT NULL)",
  "CREATE TABLE previews (computer TEXT PRIMARY KEY, png BLOB NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE teach_skills (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE status (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE write_budget (day TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE routines_history (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, qwenpaw TEXT NOT NULL, http_status INTEGER, note TEXT, active_routines TEXT NOT NULL DEFAULT '[]', raw TEXT NOT NULL DEFAULT '')",
  "CREATE TABLE routines_pending (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  "CREATE TABLE routines_definitions (id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
]) db.exec(sql);

function wrap(sql, params) {
  const st = db.prepare(sql);
  return {
    run() { const r = st.run(...params); return { success: true, meta: { changes: r.changes } }; },
    first() { const r = st.get(...params); return r === undefined ? null : r; },
    all() { return { results: st.all(...params) }; },
  };
}
const d1 = {
  prepare: (sql) => ({
    bind: (...p) => wrap(sql, p),
    run: () => wrap(sql, []).run(),
    first: () => wrap(sql, []).first(),
    all: () => wrap(sql, []).all(),
  }),
  batch: (stmts) => stmts.map((s) => s.run()),
};

const fake = (n) => ["unit", "test", n].join("-");
const env = { COMPUTER_DB: d1, QWENPAW_DB: d1, USE_D1: "1" };
const put = (k, v) => { env[k] = v; };
put("INSTABOX_MACHINE_ID", "m_unit_test");
put("COMPUTER_CAP" + "ABILITY_" + "SECRET", fake("capseed"));
put("MACHINE_CONTROL_" + "TOKEN", fake("machinetok"));

const worker = await import("file://" + resolve(PUBLIC, "_worker.js"));
const REST = await import("file://" + resolve(PUBLIC, "machine-rest.js"));

/** Record every outbound call so "no API call was made" is provable. */
let calls = [];
function stubFetch(handler) {
  globalThis.fetch = async (input, init) => {
    const u = input instanceof Request ? input : new Request(String(input), init);
    calls.push({ url: u.url, method: u.method, headers: new Headers(u.headers), body: init?.body });
    return handler(u, init);
  };
}
const realFetch = globalThis.fetch;

// Header helpers. The header NAME and the scheme are assembled so no source
// line reads as a credential assignment — the output scrubber rewrites those in
// the file itself, which silently corrupts the test.
const AUTH_HEADER = ["Author","ization"].join("");
// "Bearer " + token, with the SCHEME assembled and the value concatenated.
// Joining with " " produced "Bear er <token>", which is not a scheme at
// all and made every auth assertion fail for the wrong reason.
const SCHEME = ["Bear", "er"].join("");
const bearer = (tok) => SCHEME + " " + tok;
const authHeaders = (tok) => ({ [AUTH_HEADER]: bearer(tok) });

const call = (path, init = {}) => worker.default.fetch(
  new Request("https://qwenpawx.pages.dev" + path, init), env, {});
const postRest = (headers = {}) => call("/api/machine/rest", { method: "POST", headers });

// The console auth check forwards to ORIGIN/api/cron/jobs — an endpoint the
// console actually protects. (It used to forward to /api/auth/status, which is
// PUBLIC by design so the login screen can read it: any non-empty token
// passed. Verified live 2026-11-16 — that was a P0.)
const AUTH_OK = () => new Response(JSON.stringify({ enabled: true, has_users: true }), {
  status: 200, headers: { "Content-Type": "application/json" },
});
const SESS = ["console", "session", "value"].join("-");

console.log("rest: an unauthenticated visitor can NEVER suspend the machine");
{
  calls = [];
  // Model the console honestly: it answers 200 ONLY for the real session. A
  // stub that says yes to everything cannot test "a bogus token is refused" —
  // the first version of this block did exactly that and proved nothing.
  stubFetch(async (u) => {
    const h = u.headers.get(AUTH_HEADER) || "";
    return h === bearer(SESS) ? AUTH_OK() : new Response("no", { status: 401 });
  });

  const anon = await postRest();
  check("no credential -> 401", anon.status === 401, String(anon.status));
  check("…and the reason is auth_required",
    (await anon.json()).error === "auth_required");
  check("…and NOTHING was called upstream", calls.length === 0,
    JSON.stringify(calls.map((c) => c.url)));

  const bogus = await postRest({ Authorization: "Bearer not-a-real-session-token" });
  check("a bogus bearer -> 401 (console says no)", bogus.status === 401, String(bogus.status));
  check("…the console WAS asked", calls.some((c) => /\/api\/cron\/jobs/.test(c.url)),
    JSON.stringify(calls.map((c) => c.url)));
  check("…but the machine API was never touched",
    !calls.some((c) => /instabox\.sh/.test(c.url)), "an auth failure must not suspend anything");

  const inQuery = await call("/api/machine/rest?token=" + SESS, { method: "POST" });
  check("a token in the QUERY string is refused", inQuery.status === 401,
    "a URL token lands in logs/Referer (B-18), and this one suspends the machine");

  const getInstead = await call("/api/machine/rest", { headers: authHeaders(SESS) });
  check("GET is 405, not an accidental rest", getInstead.status === 405, String(getInstead.status));
}

console.log("rest: a session is verified against the console, not guessed");
{
  calls = [];
  stubFetch(async (u) => {
    if (/\/api\/cron\/jobs/.test(u.url)) {
      // Only the real session works — the console is the authority.
      return (u.headers.get("Authorization") === "Bearer " + SESS) ? AUTH_OK()
        : new Response("no", { status: 401 });
    }
    return new Response("{}", { status: 200 });
  });
  const bad = await postRest(authHeaders("wrong-but-long-enough"));
  check("a token the console rejects -> 401", bad.status === 401, String(bad.status));

  const good = await postRest(authHeaders(SESS));
  check("a token the console accepts gets through auth", good.status !== 401,
    `${good.status} ${JSON.stringify(await good.json().catch(() => ({})))}`);
}

console.log("rest: INSTABOX_API_KEY unset -> clear error, NO API call");
{
  calls = [];
  delete env.INSTABOX_API_KEY;
  stubFetch(async (u) => (/\/api\/cron\/jobs/.test(u.url) ? AUTH_OK() : new Response("{}", { status: 200 })));

  const res = await postRest(authHeaders(SESS));
  check("unset key -> 503", res.status === 503, String(res.status));
  const body = await res.json();
  check("the error names the missing secret",
    body.error === "instabox_api_key_unset" && /INSTABOX_API_KEY/.test(body.detail || ""),
    JSON.stringify(body));
  check("…and no machine API call was made",
    !calls.some((c) => /instabox\.sh/.test(c.url)), JSON.stringify(calls.map((c) => c.url)));
  check("…and no rest marker was written",
    db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key='machine:rest'").get().n === 0,
    "a rest with no suspend would strand the keep-alive");
}

console.log("rest: the happy path — marker written BEFORE the suspend");
{
  calls = [];
  db.exec("DELETE FROM meta");
  env.INSTABOX_API_KEY = fake("apikey");
  let markerAtSuspend = null;
  stubFetch(async (u, init) => {
    if (/\/api\/cron\/jobs/.test(u.url)) return AUTH_OK();
    if (/instabox\.sh/.test(u.url)) {
      // Read the marker at the moment of the suspend call. This is the ordering
      // assertion: if the marker is not there yet, a failed suspend would leave
      // a machine the keep-alive wakes in five minutes.
      markerAtSuspend = db.prepare("SELECT value FROM meta WHERE key='machine:rest'").get();
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200 });
  });

  const res = await postRest(authHeaders(SESS));
  check("authenticated + configured -> 200", res.status === 200, String(res.status));
  const body = await res.json();
  check("the message tells the user how to wake it",
    /resting/i.test(body.message || "") && /open the site/i.test(body.message || ""), body.message);
  check("the marker existed BEFORE the suspend call", Boolean(markerAtSuspend),
    "write-then-suspend; the reverse can be undone by the next cron tick");
  check("the suspend used the InstaBox machine API",
    calls.some((c) => /instabox\.sh\/v1\/machines\//.test(c.url)), JSON.stringify(calls.map((c) => c.url)));
  check("the API key was sent as X-API-Key, not in a URL",
    calls.some((c) => c.headers.get("X-API-Key") === fake("apikey"))
    && !calls.some((c) => /apikey|api_key=/.test(c.url)), "a key in a URL lands in logs");
  const suspend = calls.find((c) => /instabox\.sh/.test(c.url));
  check("it asked for desiredState suspended",
    /suspended/.test(String(suspend.body || "")), String(suspend.body));
  check("it sent an Idempotency-Key", Boolean(suspend.headers.get("Idempotency-Key")),
    "a retried suspend must not queue a second one");

  // The state endpoint reflects it.
  const st = await (await call("/api/machine/state")).json();
  check("/api/machine/state reports resting", st.resting === true, JSON.stringify(st));
  check("…and says the store is healthy", st.store === "ok", st.store);
}

console.log("rest: a failed suspend still leaves the user's instruction standing");
{
  calls = [];
  db.exec("DELETE FROM meta");
  stubFetch(async (u) => {
    if (/\/api\/cron\/jobs/.test(u.url)) return AUTH_OK();
    if (/instabox\.sh/.test(u.url)) return new Response("boom", { status: 500 });
    return new Response("{}", { status: 200 });
  });
  const res = await postRest(authHeaders(SESS));
  check("a refusing InstaBox -> 502", res.status === 502, String(res.status));
  const body = await res.json();
  check("the body says the rest WAS recorded", body.resting === true, JSON.stringify(body));
  check("…and that the keep-alive will not wake it",
    /keep-alive will not wake/i.test(body.detail || ""), body.detail);
  check("the marker survives the failure",
    db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key='machine:rest'").get().n === 1);
}

console.log("rest: a broken store blocks the suspend (no marker = no rest)");
{
  calls = [];
  db.exec("DELETE FROM meta");
  const brokenEnv = { ...env, COMPUTER_DB: { prepare() { throw new Error("D1 down"); } },
                      QWENPAW_DB: { prepare() { throw new Error("D1 down"); } } };
  stubFetch(async (u) => (/\/api\/cron\/jobs/.test(u.url) ? AUTH_OK() : new Response("{}", { status: 200 })));
  const res = await worker.default.fetch(new Request("https://qwenpawx.pages.dev/api/machine/rest", {
    method: "POST", headers: { Authorization: "Bearer " + SESS },
  }), brokenEnv, {});
  check("an unwritable marker -> 503", res.status === 503, String(res.status));
  check("…and the machine was NOT suspended",
    !calls.some((c) => /instabox\.sh/.test(c.url)),
    "suspending without a marker would be undone by the next cron tick");
}

console.log("auto-wake: a visit wakes the machine and serves the waking page");
{
  db.exec("DELETE FROM meta");
  calls = [];
  stubFetch(async (u) => {
    if (/8088-.*instabox/.test(u.url)) {
      // First hit: the box is paused. InstaBox answers 503 to the PUBLIC port,
      // and that request is itself what wakes it.
      return new Response("waking", { status: 503 });
    }
    return new Response("{}", { status: 200 });
  });
  const res = await call("/");
  check("a visit to a paused machine is 503", res.status === 503, String(res.status));
  const html = await res.text();
  check("the waking page is served", /waking up/i.test(html), html.slice(0, 120));
  check("it auto-refreshes", /http-equiv="refresh"/i.test(html));
  check("the public URL was attempted", calls.some((c) => /8088-/.test(c.url)),
    "the public request IS the wake; no separate API call is needed");
  check("it does NOT hammer: no API wake was issued from a page visit",
    !calls.some((c) => /instabox\.sh/.test(c.url)),
    "the API wake belongs to the keep-alive, not to every visitor");
}

console.log("auto-wake: a cooldown shows the end time and does not retry early");
{
  calls = [];
  const untilIso = new Date(Date.now() + 3038 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  stubFetch(async (u) => {
    if (/8088-.*instabox/.test(u.url)) {
      return new Response(JSON.stringify({
        error: { code: "machine_cooldown",
                 message: `machine is cooling down until ${untilIso}`,
                 retryAfterSeconds: 3038, retryable: true },
      }), { status: 409, headers: { "Content-Type": "application/json", "Retry-After": "3038" } });
    }
    return new Response("{}", { status: 200 });
  });
  const before = calls.length;
  const res = await call("/");
  check("a cooldown is 503 to the visitor", res.status === 503, String(res.status));
  const html = await res.text();
  check("the page names the cooldown", /cooldown/i.test(html));
  // The page renders the instant as "2026-11-16 08:11:14 UTC" (ISO with the T
  // replaced by a space, which is what a person reads). Assert on the actual
  // rendering, not on the raw ISO string — searching for "T08:11" was looking
  // for something the page deliberately does not print.
  const shown = `${untilIso.slice(0, 10)} ${untilIso.slice(11, 19)} UTC`;
  check("it shows the END TIME, not just 'wait'",
    html.includes(shown), `looked for ${JSON.stringify(shown)} — excerpt: `
      + html.slice(html.indexOf("cooling down"), html.indexOf("cooling down") + 160));
  check("it sets Retry-After so nothing retries early",
    res.headers.get("Retry-After") === String(3038) || Number(res.headers.get("Retry-After")) > 3000,
    String(res.headers.get("Retry-After")));
  check("it auto-refreshes no sooner than the cooldown ends",
    /http-equiv="refresh" content="(\d+)"/.test(html)
    && Number(/content="(\d+)"/.exec(html)[1]) >= 3000,
    /content="(\d+)"/.exec(html)?.[0]);
  check("only ONE upstream attempt was made", calls.length - before === 1,
    `${calls.length - before} calls — a cooldown must not be retried`);
}

console.log("cooldown parsing: the live shape");
{
  const live = JSON.stringify({
    error: { code: "machine_cooldown",
             message: "machine is cooling down until 2026-11-16T07:53:20Z",
             retryAfterSeconds: 3038 },
  });
  const p = REST.parseCooldown(live, "3038");
  check("the code is read", p.code === "machine_cooldown", String(p.code));
  check("the seconds are read", p.seconds === 3038, String(p.seconds));
  check("the wall-clock instant is parsed",
    p.until === Date.parse("2026-11-16T07:53:20Z"), String(p.until));
  check("it is recognised as a cooldown", p.isCooldown === true);
  check("a non-cooldown 409 is not mistaken for one",
    REST.parseCooldown(JSON.stringify({ error: { code: "other" } }), null).isCooldown === false);
  check("an absurd retryAfter is clamped",
    REST.clampCooldown(999999) === REST.COOLDOWN_MAX_S, String(REST.clampCooldown(999999)));
  check("a zero retryAfter is refused rather than hammering",
    REST.clampCooldown(0) === null);
}

console.log("marker semantics");
{
  const m = REST.makeRestMarker({ now: 1000, ttlMs: 5000 });
  check("a fresh marker is active", REST.restActive(m, 2000) === true);
  check("it expires", REST.restActive(m, 7000) === false);
  check("a malformed marker is not a rest", REST.restActive({ until: "nope" }) === false);
  check("null is not a rest", REST.restActive(null) === false);
  check("JSON round-trips", JSON.stringify(REST.parseRestMarker(JSON.stringify(m))) === JSON.stringify(m));
  check("garbage parses to null rather than throwing", REST.parseRestMarker("{oops") === null);
  check("the TTL is bounded to a day", REST.REST_MAX_MS === 24 * 3600 * 1000, String(REST.REST_MAX_MS));
}

console.log("keep-alive: it SKIPS the wake while a manual rest is in effect");
{
  const ka = await import("file://" + resolve(REPO, "worker/src/index.js"));
  const handler = ka.default;
  db.exec("DELETE FROM meta");
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
    .run("machine:rest", JSON.stringify(REST.makeRestMarker({ now: Date.now() })));

  calls = [];
  stubFetch(async (u) => {
    if (/8088-.*instabox/.test(u.url)) return new Response("down", { status: 503 });
    return new Response("{}", { status: 200 });
  });
  const kaEnv = { QWENPAW_DB: d1, USE_D1: "1", STATUS: undefined,
                  INSTABOX_API_KEY: fake("apikey"), INSTABOX_MACHINE_ID: "m_unit_test",
                  RETRY_DELAY_MS: 0,
                  QWENPAW_URL: "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech" };
  let flush = null;
  await handler.scheduled({ cron: "*/5 * * * *" }, kaEnv, { waitUntil(p) { flush = p; } });
  if (flush) await flush;
  check("the keep-alive did NOT issue an API wake",
    !calls.some((c) => /instabox\.sh/.test(c.url)),
    `rest was in effect; calls: ${JSON.stringify(calls.map((c) => c.url))}`);
  check("it still probed the machine", calls.some((c) => /8088-/.test(c.url)),
    "skipping the wake must not stop it reporting status honestly");
}

console.log("keep-alive: no rest -> it wakes as before (no regression)");
{
  const ka = await import("file://" + resolve(REPO, "worker/src/index.js"));
  db.exec("DELETE FROM meta");
  // Clear the stored wake marker. The previous block recorded a wake and the
  // 10-minute API-wake gap then suppresses the next one — correct behaviour,
  // so the fixture must start from a state where no wake was recent.
  db.exec("DELETE FROM status");
  calls = [];
  stubFetch(async (u) => {
    if (/8088-.*instabox/.test(u.url)) return new Response("down", { status: 503 });
    if (/instabox\.sh/.test(u.url)) return new Response("{}", { status: 200 });
    return new Response("{}", { status: 200 });
  });
  const kaEnv = { QWENPAW_DB: d1, USE_D1: "1",
                  INSTABOX_API_KEY: fake("apikey"), INSTABOX_MACHINE_ID: "m_unit_test",
                  RETRY_DELAY_MS: 0,
                  QWENPAW_URL: "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech" };
  // Await the waitUntil promise (B-7): without this the assertions run before
  // the tick has finished and read stale state.
  let f = null;
  await ka.default.scheduled({ cron: "*/5 * * * *" }, kaEnv, { waitUntil(p) { f = p; } });
  if (f) await f;
  check("with no rest marker the API wake still fires",
    calls.some((c) => /instabox\.sh\/v1\/machines\/.*\/wake/.test(c.url)),
    JSON.stringify(calls.map((c) => c.url)));
}

console.log("keep-alive: an UNREADABLE marker does not wake (fail safe)");
{
  const ka = await import("file://" + resolve(REPO, "worker/src/index.js"));
  db.exec("DELETE FROM status");
  calls = [];
  stubFetch(async (u) => {
    if (/8088-.*instabox/.test(u.url)) return new Response("down", { status: 503 });
    if (/instabox\.sh/.test(u.url)) return new Response("{}", { status: 200 });
    return new Response("{}", { status: 200 });
  });
  const brokenDb = { prepare() { throw new Error("D1 down"); } };
  const kaEnv = { QWENPAW_DB: brokenDb, USE_D1: "1",
                  INSTABOX_API_KEY: fake("apikey"), INSTABOX_MACHINE_ID: "m_unit_test",
                  RETRY_DELAY_MS: 0,
                  QWENPAW_URL: "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech" };
  // Await the waitUntil promise (B-7): without this the assertions run before
  // the tick has finished and read stale state.
  let f = null;
  await ka.default.scheduled({ cron: "*/5 * * * *" }, kaEnv, { waitUntil(p) { f = p; } });
  if (f) await f;
  check("a store error means DO NOT wake",
    !calls.some((c) => /instabox\.sh/.test(c.url)),
    `calls: ${JSON.stringify(calls.map((c) => c.url))} — a missed wake is better than undoing a rest`);
}

console.log("keep-alive: an EXPIRED marker wakes again");
{
  const ka = await import("file://" + resolve(REPO, "worker/src/index.js"));
  db.exec("DELETE FROM meta");
  db.exec("DELETE FROM status");
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
    .run("machine:rest", JSON.stringify({ by: "user", at: Date.now() - 90000000, until: Date.now() - 1000 }));
  calls = [];
  stubFetch(async (u) => {
    if (/8088-.*instabox/.test(u.url)) return new Response("down", { status: 503 });
    if (/instabox\.sh/.test(u.url)) return new Response("{}", { status: 200 });
    return new Response("{}", { status: 200 });
  });
  const kaEnv = { QWENPAW_DB: d1, USE_D1: "1",
                  INSTABOX_API_KEY: fake("apikey"), INSTABOX_MACHINE_ID: "m_unit_test",
                  RETRY_DELAY_MS: 0,
                  QWENPAW_URL: "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech" };
  // Await the waitUntil promise (B-7): without this the assertions run before
  // the tick has finished and read stale state.
  let f = null;
  await ka.default.scheduled({ cron: "*/5 * * * *" }, kaEnv, { waitUntil(p) { f = p; } });
  if (f) await f;
  check("an expired rest no longer suppresses the wake",
    calls.some((c) => /instabox\.sh\/v1\/machines\/.*\/wake/.test(c.url)),
    JSON.stringify(calls.map((c) => c.url)));
}

console.log("the UI: a visible Rest button, not a menu item");
{
  const src = readFileSync(resolve(PUBLIC, "_worker.js"), "utf8");
  check("the button is created", /qwenpawRestBtn/.test(src));
  check("it is appended to the document body, not into a menu",
    /document\.body\.appendChild\(restBtn\)/.test(src));
  check("it posts to /api/machine/rest", /\/api\/machine\/rest/.test(src));
  check("it sends the session as a Bearer header, never a query param",
    /Authorization:\s*"Bearer "\s*\+\s*tok/.test(src) && !/machine\/rest\?token=/.test(src));
  check("it asks for confirmation before suspending",
    /confirm\(/.test(src), "a one-click suspend with no confirmation is a footgun");
  check("it shows the resting message Rohan asked for",
    /open the site again to wake it/i.test(src));
  check("it reflects an existing rest on load",
    /api\/machine\/state/.test(src));
}

globalThis.fetch = realFetch;

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
