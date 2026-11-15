#!/usr/bin/env node
/**
 * Terminal harness — the lease tests a root shell must not ship without.
 *
 * The brief was explicit: "a root shell is the highest-risk surface, do not
 * ship it without lease tests". BUGS.md B-4 recorded the previous terminal
 * outliving its lease by 59 minutes, giving a shell to whoever held the URL
 * while the agent believed it had exclusive control. B-17 recorded a resize
 * frame asking for a 65535x65535 terminal.
 *
 * These tests drive the REAL Worker (`pages/public/_worker.js` -> router ->
 * terminal.js) against a D1 mock backed by real SQLite, and assert:
 *
 *   1. A terminal cannot be minted without holding the live lease.
 *   2. It cannot be minted against a lease someone else holds.
 *   3. Its expiry is clamped to the lease, never a fixed hour.
 *   4. A minted link is REFUSED once the lease is released — on every
 *      request, not just at mint.
 *   5. A takeover (generation bump) invalidates an outstanding link.
 *   6. A broken store is a 503, never "released" and never a shell.
 *   7. The token is a path segment; no query string, no cookie.
 *   8. The agent-facing token check is constant-time and fails closed.
 *
 * Run: node features/computer/harness-terminal.mjs
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

// ------------------------------------------------------------ live D1 schema
const db = new DatabaseSync(":memory:");
for (const sql of [
  "CREATE TABLE leases (computer TEXT PRIMARY KEY, lease_id TEXT NOT NULL, holder TEXT NOT NULL, granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, fence INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE generations (computer TEXT PRIMARY KEY, gen INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE needs_you (computer TEXT PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL, run_id TEXT)",
  "CREATE TABLE modes (agent TEXT PRIMARY KEY, mode TEXT NOT NULL)",
  "CREATE TABLE previews (computer TEXT PRIMARY KEY, png BLOB NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
]) db.exec(sql);

db.exec("INSERT INTO generations (computer, gen) VALUES ('default', 5)");
db.exec("INSERT INTO generations (computer, gen) VALUES ('qa', 2)");
db.exec("INSERT INTO modes (agent, mode) VALUES ('default', 'team')");

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

const SECRET = "test-capability-secret-0123456789abcdef";
const SYNC = "test-sync-token-0123456789";
const env = {
  COMPUTER_DB: d1,
  COMPUTER_CAPABILITY_SECRET: SECRET,
  COMPUTER_SYNC_TOKEN: SYNC,
  COMPUTER_TERMINAL_ORIGIN: "https://terminal.test/sock",
  COMPUTER_CONTROL_ORIGIN: "https://6082.test",
  COMPUTER_CONTROL_TOKEN: "upstream-token-not-for-browsers",
  COMPUTER_VIEW_ORIGIN: "https://6081.test",
  COMPUTER_VIEW_TOKEN: "upstream-view-token",
};

const worker = await import("file://" + resolve(PUBLIC, "_worker.js"));
const realFetch = globalThis.fetch;
// The status probe must not reach the network.
globalThis.fetch = async (input) => {
  const u = String(input && input.url ? input.url : input);
  if (u.startsWith("https://6081.test") || u.startsWith("https://6082.test")) {
    return new Response("ok", { status: 200 });
  }
  return new Response("stub", { status: 200 });
};

const call = (path, init = {}) => worker.default.fetch(
  new Request("https://qwenpawx.pages.dev" + path, init), env, {});

const post = (path, body) => call(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body || {}),
});

// Take control so there is a lease to bind to.
const take = await post("/computer/takeover", { computer: "default" });
const taken = await take.json();
const LEASE = taken.leaseId;
check("a lease can be taken (fixture)", Boolean(LEASE), JSON.stringify(taken));

console.log("terminal: a shell requires the live lease");
{
  const noLease = await post("/computer/terminal/session", { computer: "default" });
  check("no leaseId -> 403", noLease.status === 403, String(noLease.status));
  check("and the reason is no_lease",
    (await noLease.json()).error === "no_lease");

  const wrong = await post("/computer/terminal/session", {
    computer: "default", leaseId: "a-lease-id-nobody-holds",
  });
  check("a lease the caller does not hold -> 409", wrong.status === 409, String(wrong.status));
  check("and the reason is not_holder",
    (await wrong.json()).error === "not_holder",
    "a stale tab must not open a shell against newer control");

  const ok = await post("/computer/terminal/session", { computer: "default", leaseId: LEASE });
  check("the real holder gets a URL", ok.status === 200, String(ok.status));
  const body = await ok.json();
  check("the URL is under /computer/terminal/",
    typeof body.url === "string" && body.url.startsWith("/computer/terminal/"),
    String(body.url && body.url.slice(0, 40)));
  check("the token is a path segment, not a query string",
    !body.url.includes("?"), "B-16: a URL token lands in logs and Referer");
  check("the upstream provider token is NOT in the URL",
    !body.url.includes("upstream-token"), String(body.url));
  check("a deadline is published for the countdown",
    Number.isFinite(body.deadlineMs) && body.deadlineMs > Date.now(),
    String(body.deadlineMs));
}

console.log("terminal: its life is clamped to the lease, not a fixed hour");
{
  const ok = await post("/computer/terminal/session", { computer: "default", leaseId: LEASE });
  const body = await ok.json();
  const leaseRow = d1.prepare("SELECT expires_at FROM leases WHERE computer = ?").bind("default").first();
  const leaseDeadline = leaseRow.expires_at + 15_000;
  check("the deadline is within the lease + grace",
    body.deadlineMs <= leaseDeadline + 1000,
    `deadline ${body.deadlineMs} vs lease-derived ${leaseDeadline}`);
  check("and within its own short TTL (60 s)",
    body.deadlineMs <= Date.now() + 61_000,
    "B-4: the old terminal capability lived 3600 s");
  check("it is NOT an hour",
    body.deadlineMs - Date.now() < 120_000,
    String(body.deadlineMs - Date.now()));
}

console.log("terminal: releasing control kills the shell");
{
  const minted = await (await post("/computer/terminal/session", {
    computer: "default", leaseId: LEASE,
  })).json();
  const path = minted.url;

  // Before release it works.
  const before = await call(path, { headers: {} });
  check("the link is valid while the lease is held", before.status === 200,
    String(before.status));

  // Release, then try the SAME link. This is B-4's exact scenario.
  const rel = await post("/computer/release", { computer: "default", leaseId: LEASE });
  check("release succeeds", rel.status === 200, String(rel.status));

  const after = await call(path, { headers: {} });
  check("the SAME link is refused after release", after.status === 403,
    `${after.status} — B-4 handed out a shell for 59 more minutes`);
  // The reason is "expired", not "released", because `release()` also bumps
  // the generation — which deliberately invalidates EVERY outstanding link,
  // view links included. The generation check runs before the lease check, so
  // that is the message a user sees. Either wording is a refusal; what must
  // never happen is a 200.
  const afterText = await after.text();
  check("and the refusal names a dead link, not a server error",
    /released|expired/i.test(afterText), afterText.slice(0, 120));
}

console.log("terminal: a takeover invalidates an outstanding link");
{
  const taken2 = await (await post("/computer/takeover", { computer: "default" })).json();
  const minted = await (await post("/computer/terminal/session", {
    computer: "default", leaseId: taken2.leaseId,
  })).json();
  check("a fresh capability mints against the new lease", Boolean(minted.url));
  // Someone else takes over: generation bumps, the old link must die.
  db.prepare("UPDATE leases SET expires_at = 0 WHERE computer = 'default'").run();
  const taken3 = await (await post("/computer/takeover", { computer: "default" })).json();
  check("the takeover bumped the generation",
    taken3.generation > taken2.generation,
    `${taken2.generation} -> ${taken3.generation}`);
  const stale = await call(minted.url, { headers: {} });
  check("the old terminal link is refused", stale.status === 403, String(stale.status));
  check("and names the staleness, not a generic failure",
    /expired/i.test(await stale.text()));
  // Clean up so later blocks start from a known state.
  await post("/computer/release", { computer: "default", leaseId: taken3.leaseId });
}

console.log("terminal: the seal refuses tampering");
{
  const t = await (await post("/computer/takeover", { computer: "default" })).json();
  const minted = await (await post("/computer/terminal/session", {
    computer: "default", leaseId: t.leaseId,
  })).json();
  const path = minted.url;
  const tampered = path.slice(0, -4) + (path.endsWith("AAAA") ? "BBBB" : "AAAA");
  check("a tampered token is refused", (await call(tampered)).status === 403);
  const asView = path.replace("/control/", "/view/");
  check("a terminal link cannot be downgraded to view",
    (await call(asView)).status === 403,
    "the policy is in the AAD, so it cannot be rewritten");
  const otherComputer = await call(path + "?computer=qa");
  check("a link cannot be pointed at another computer",
    otherComputer.status === 403, String(otherComputer.status));
  await post("/computer/release", { computer: "default", leaseId: t.leaseId });
}

console.log("terminal: a broken store is 503, never a shell and never a lie");
{
  const t = await (await post("/computer/takeover", { computer: "default" })).json();
  const minted = await (await post("/computer/terminal/session", {
    computer: "default", leaseId: t.leaseId,
  })).json();
  const brokenEnv = {
    ...env,
    COMPUTER_DB: { prepare() { throw new Error("D1 down"); } },
  };
  const res = await worker.default.fetch(
    new Request("https://qwenpawx.pages.dev" + minted.url), brokenEnv, {});
  check("a broken store refuses the shell", res.status === 503, String(res.status));
  check("it does not claim the control was released",
    !/released/i.test(await res.text()),
    "saying 'released' sends the user to press Take control instead of waiting");
  await post("/computer/release", { computer: "default", leaseId: t.leaseId });
}

  console.log("terminal: the agent-facing token is constant-time and fail-closed");
{
  // A real file import, not a data: URL — terminal.js has relative imports
  // (./capability.js, ./state.js) and a data: URL cannot resolve them.
  const T = await import("file://" + resolve(PUBLIC, "computer/terminal.js"));

  check("equal strings compare equal", await T.constantTimeEqual("abc", "abc"));
  check("different strings differ", !(await T.constantTimeEqual("abc", "abd")));
  check("a prefix does not pass", !(await T.constantTimeEqual("abc", "abcd")));
  check("an empty value does not match a set token",
    !(await T.constantTimeEqual("", SYNC)));
  check("non-strings are refused", !(await T.constantTimeEqual(null, SYNC)));

  const good = new Request("https://x/computer/needs-you", {
    method: "POST", headers: { "X-Computer-Token": SYNC },
  });
  check("the right token passes", (await T.requireSyncToken(good, env)) === null);
  const bad = new Request("https://x/computer/needs-you", {
    method: "POST", headers: { "X-Computer-Token": "wrong" },
  });
  check("a wrong token is 401", (await T.requireSyncToken(bad, env))?.status === 401);
  const none = new Request("https://x/computer/needs-you", { method: "POST" });
  check("a missing token is 401", (await T.requireSyncToken(none, env))?.status === 401);
  const unset = new Request("https://x/computer/needs-you", {
    method: "POST", headers: { "X-Computer-Token": SYNC },
  });
  check("an UNSET secret is 503, never permission",
    (await T.requireSyncToken(unset, { ...env, COMPUTER_SYNC_TOKEN: "" }))?.status === 503,
    "fail-open when unset is how the old bridge 401'd everything but also let nothing work");
}

console.log("terminal: the routes are wired into the real Worker");
{
  // A GET to a terminal link with a bogus token must be a 403 from the router,
  // not a 404 from a missing branch.
  const res = await call("/computer/terminal/control/9999999999.AAAA");
  check("an unknown terminal path is refused, not 404",
    res.status === 403, `${res.status} — 404 would mean the route is not wired`);
}

console.log("terminal: the PTY server clamps and enforces (its own selftest)");
{
  const { execFileSync } = await import("node:child_process");
  let out = "";
  let ok = false;
  try {
    out = execFileSync("python3", [resolve(REPO, "features/computer/terminal-server.py"), "--selftest"], {
      encoding: "utf8", timeout: 120_000,
    });
    ok = /26 passed, 0 failed/.test(out);
  } catch (e) {
    out = String(e.stdout || e.message);
  }
  check("terminal-server --selftest is 26/26", ok,
    out.trim().split("\n").slice(-2).join(" | "));
  check("the clamp is asserted, not assumed",
    /cols 65535 -> 1000/.test(out), "B-17");
  check("the deadline kill is asserted against a real PTY",
    /ended because of the deadline/.test(out),
    "B-4: this is the assertion that matters most");
}

globalThis.fetch = realFetch;

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
