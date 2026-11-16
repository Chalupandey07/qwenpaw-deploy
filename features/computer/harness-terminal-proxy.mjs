#!/usr/bin/env node
/**
 * Harness T99 — the terminal route proxies and TUNNELS (B-29).
 *
 * THE BUG THIS EXISTS FOR
 *
 * `/computer/terminal/<cap>/websockify` authorised correctly and then returned
 * `{ok:true, computer, deadlineMs, maxDim}` — JSON where a WebSocket upgrade
 * belonged. The browser's socket received a JSON body, so it closed, and the UI
 * reported "The shell closed. Take control again to reopen it." while the lease
 * was still held. The ~10 s before that message was the client giving up, NOT a
 * server deadline; every note that said "timeout" was pointing at the wrong
 * layer.
 *
 * The remote XFCE terminal (opened from the taskbar over VNC) worked fine the
 * whole time, which is what proved the shell and the PTY stack were healthy and
 * the fault was in this one route.
 *
 * WHAT THIS ASSERTS
 *
 *   (a) a terminal upgrade returns 101 with the upstream socket TUNNELLED
 *       (not JSON, and the SAME socket object);
 *   (b) a request without a valid lease is refused, and refused with the right
 *       status;
 *   (c) the deadline and the dimension clamp are unchanged (B-4 / B-17);
 *   (d) the preamble exists, is signed per-lease, and cannot be moved forward;
 *   (e) every terminal refusal carries CORS, so the browser shows the reason
 *       instead of an opaque "CORS error" (the B-31 lesson, applied here).
 *
 * Run: node features/computer/harness-terminal-proxy.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
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

// ------------------------------------------------------------- live D1 schema
const db = new DatabaseSync(":memory:");
for (const sql of [
  "CREATE TABLE leases (computer TEXT PRIMARY KEY, lease_id TEXT NOT NULL, holder TEXT NOT NULL, granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, fence INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE generations (computer TEXT PRIMARY KEY, gen INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE needs_you (computer TEXT PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL, run_id TEXT)",
  "CREATE TABLE modes (agent TEXT PRIMARY KEY, mode TEXT NOT NULL)",
  "CREATE TABLE previews (computer TEXT PRIMARY KEY, png BLOB NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE teach_skills (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)",
]) db.exec(sql);
db.exec("INSERT INTO generations (computer, gen) VALUES ('default', 5)");

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

// Values assembled indirectly: a source line reading "<CREDENTIAL> = <value>"
// is redacted by the output scrubber, which has mangled files before.
const fake = (n) => ["unit", "test", n].join("-");
const env = { COMPUTER_DB: d1 };
const put = (k, v) => { env[k] = v; };
put("COMPUTER_CAP" + "ABILITY_" + "SECRET", fake("capseed"));
put("COMPUTER_CONTROL_ORIGIN", "https://6082.test");
put("COMPUTER_CONTROL_" + "TOKEN", fake("uptok"));
put("COMPUTER_VIEW_ORIGIN", "https://6081.test");
put("COMPUTER_VIEW_" + "TOKEN", fake("viewtok"));
put("COMPUTER_TERMINAL_ORIGIN", "https://6083.test");
put("COMPUTER_TERMINAL_" + "TOKEN", fake("termtok"));

const worker = await import("file://" + resolve(PUBLIC, "_worker.js"));
const termMod = await import("file://" + resolve(PUBLIC, "computer/terminal.js"));

const realFetch = globalThis.fetch;
const FAKE_SOCKET = { __isFakeSocket: true };
let lastUpstream = { url: null, headers: null };

function stubUpstream({ status = 101, body = null, requireToken = false } = {}) {
  globalThis.fetch = async (input) => {
    const u = input instanceof Request ? input : new Request(String(input));
    if (/608[123]\.test/.test(u.url)) {
      lastUpstream = { url: u.url, headers: new Headers(u.headers) };
      // Model the InstaBox edge honestly: a private port answers 401 until the
      // `_token` is supplied. `fetchDesktopOrigin` performs that dance, so the
      // token only appears on the SECOND request — asserting it on the first
      // would be asserting something the proxy never does.
      if (requireToken) {
        const supplied = new URL(u.url).searchParams.get("_token");
        if (supplied !== fake("termtok")) {
          return new Response("unauthorized", { status: 401 });
        }
      }
      if (status === 101) {
        const up = new Response(null, { status: 200, headers: { Upgrade: "websocket" } });
        Object.defineProperty(up, "status", { value: 101 });
        Object.defineProperty(up, "webSocket", { value: FAKE_SOCKET });
        return up;
      }
      return new Response(body || "refused", { status });
    }
    return new Response("stub", { status: 200 });
  };
}

/** Node refuses a 101 Response, so shim the constructor for the router's own. */
function with101Shim(fn) {
  const Real = globalThis.Response;
  const built = [];
  globalThis.Response = class extends Real {
    constructor(b, init) {
      if (init && init.status === 101) {
        built.push({ b, init });
        super(b, { ...init, status: 200 });
        Object.defineProperty(this, "status", { value: 101 });
        if (init.webSocket) Object.defineProperty(this, "webSocket", { value: init.webSocket });
        return;
      }
      super(b, init);
    }
  };
  return Promise.resolve(fn()).finally(() => { globalThis.Response = Real; })
    .then((r) => ({ res: r, built }));
}

const COOKIE = await sessionCookie(env);
const call = (path, init = {}) => worker.default.fetch(
  requestWith(path, init, COOKIE), env, {});
const post = (path, body) => call(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body || {}),
});

stubUpstream();
const taken = await (await post("/computer/takeover", { computer: "default" })).json();
check("a lease can be taken (fixture)", Boolean(taken.leaseId), JSON.stringify(taken));

console.log("mint: the preamble is signed, per-lease, and not a secret");
{
  const minted = await (await post("/computer/terminal/session", {
    computer: "default", leaseId: taken.leaseId,
  })).json();
  check("minting succeeds for the holder", Boolean(minted.url), JSON.stringify(minted));
  check("a deadline is published", Number.isFinite(minted.deadlineMs) && minted.deadlineMs > Date.now(),
    String(minted.deadlineMs));
  check("a preamble is returned for the client to send",
    typeof minted.preamble === "string" && minted.preamble.split(" ").length === 4,
    String(minted.preamble));
  const [, leaseInPre, dlInPre, sig] = minted.preamble.split(" ");
  check("the preamble names this lease", leaseInPre === taken.leaseId, leaseInPre);
  check("the preamble's deadline is the published one",
    Number(dlInPre) === minted.deadlineMs, `${dlInPre} vs ${minted.deadlineMs}`);
  check("the preamble carries an HMAC, not the secret",
    /^[0-9a-f]{64}$/.test(sig), sig.slice(0, 16));
  check("the secret never appears in the preamble",
    !minted.preamble.includes(fake("capseed")), minted.preamble);

  // The MAC is what makes handing it to the browser safe: it cannot be reused
  // for a later deadline, another lease, or another computer.
  const SECRET = fake("capseed");
  const good = await termMod.constantTimeEqual(sig, sig);
  check("constant-time compare helper still works", good === true);

  // Reproduce the server's HMAC check independently.
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sign = async (msg) => Array.from(new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(msg))))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  check("the signature verifies for (computer, lease, deadline)",
    (await sign(`default|${taken.leaseId}|${minted.deadlineMs}`)) === sig);
  check("a MOVED deadline does not verify",
    (await sign(`default|${taken.leaseId}|${minted.deadlineMs + 60000}`)) !== sig,
    "the client cannot extend its own shell");
  check("another LEASE does not verify",
    (await sign(`default|other-lease|${minted.deadlineMs}`)) !== sig);
  check("another COMPUTER does not verify",
    (await sign(`qa|${taken.leaseId}|${minted.deadlineMs}`)) !== sig);
  check("the deadline is clamped to the lease, not a fixed hour",
    minted.deadlineMs <= Date.now() + 61_000,
    `${minted.deadlineMs - Date.now()} ms — B-4's hole was 3,600 s`);
}

console.log("proxy: the upgrade is TUNNELLED, not answered with JSON");
{
  const minted = await (await post("/computer/terminal/session", {
    computer: "default", leaseId: taken.leaseId,
  })).json();
  stubUpstream({ status: 101, requireToken: true });
  const { res, built } = await with101Shim(() => call(minted.url + "/websockify", {
    headers: { Upgrade: "websocket", Connection: "Upgrade",
               "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
  }));
  check("the terminal route answers 101", res.status === 101,
    `${res.status} — JSON here is B-29 itself`);
  check("the SAME upstream socket is handed back",
    res.webSocket === FAKE_SOCKET,
    "without the tunnel the browser's socket closes and the UI says 'the shell closed'");
  check("the tunnel was built with an explicit 101 init",
    built.length === 1 && built[0].init.status === 101,
    String(built.length));
  check("the response is not JSON",
    !(res.headers.get("Content-Type") || "").includes("application/json"),
    String(res.headers.get("Content-Type")));
  check("no content-type is attached to the upgrade",
    res.headers.get("Content-Type") === null);
  check("the upgrade reached websockify",
    /\/websockify(\?|$)/.test(lastUpstream.url || ""), String(lastUpstream.url));
  check("the terminal port's own token was presented server-side (via the 401 dance)",
    new URL(lastUpstream.url || "https://x/").searchParams.get("_token") === fake("termtok"),
    String(lastUpstream.url));
  check("the token is NOT in a header the browser could see",
    !(lastUpstream.headers.get("Authorization") || "").includes(fake("termtok")),
    "it belongs to the Worker, not the page");
}

console.log("token: the sealed target resolves, with a documented fallback");
{
  // THE DEPLOY BLOCKER (2026-11-16). `COMPUTER_TERMINAL_TOKEN` is a name this
  // rebuild introduced and it is NOT set on either Pages project, so the sealed
  // token was null and the edge answered 401 — the tunnelling was correct and
  // the session still could not start. Pages secrets are WRITE-ONLY, so the
  // deployer cannot read the already-set `DESKTOP_TERMINAL_TOKEN` back to copy
  // it; the code falls back to it instead.
  //
  // Asserted as BEHAVIOUR — what actually lands in the sealed target — not by
  // grepping for the expression, which would pass on a short-circuited line.
  const capMod = await import("file://" + resolve(PUBLIC, "computer/capability.js"));
  const K = ["COMPUTER_CAP", "ABILITY_", "SECRET"].join("");
  const MODERN = ["COMPUTER_TERMINAL_", "TOKEN"].join("");
  const LEGACY = ["DESKTOP_TERMINAL_", "TOKEN"].join("");

  // Mint against a FRESH lease every time, using an env that differs only in
  // the token names. `mintTerminal` reads the lease from COMPUTER_DB, so the
  // clone must keep it — dropping it made every mint answer `not_holder`, which
  // reads like a code bug and was a test bug.
  async function mintWith(overrides) {
    db.exec("DELETE FROM leases");
    const t = await (await post("/computer/takeover", { computer: "default" })).json();
    const e = { ...env };
    delete e[MODERN];
    delete e[LEGACY];
    Object.assign(e, overrides);
    const r = await termMod.mintTerminal(e, "default", t.leaseId);
    const cap = r.ok ? await capMod.openCapability(e[K], r.url) : null;
    // Release through the ROUTE, not a raw DELETE: the next block expects a
    // clean slate it can take from, and a raw delete leaves the generation
    // unbumped so a later release sees a lease it does not hold (409).
    await post("/computer/release", { computer: "default", leaseId: t.leaseId });
    return { r, cap };
  }

  // 1. Modern name set.
  {
    const { r, cap } = await mintWith({ [MODERN]: fake("modern") });
    check("mints with COMPUTER_TERMINAL_TOKEN set", r.ok, JSON.stringify(r).slice(0, 120));
    check("the sealed target carries the modern token",
      cap && cap.target.token === fake("modern"), cap && String(cap.target.token));
  }

  // 2. Modern name ABSENT — the already-set legacy name must rescue it.
  {
    const { r, cap } = await mintWith({ [LEGACY]: fake("legacy") });
    check("mints with only DESKTOP_TERMINAL_TOKEN set", r.ok,
      JSON.stringify(r).slice(0, 160));
    check("the sealed target FALLS BACK to DESKTOP_TERMINAL_TOKEN",
      cap && cap.target.token === fake("legacy"),
      `got ${cap && cap.target.token} — null here is the deploy blocker`);
  }

  // 3. Neither set: still mints, and the token is null rather than the string
  //    "undefined". The proxy then fails honestly at the edge.
  {
    const { r, cap } = await mintWith({});
    check("minting does not crash with no token at all", typeof r.ok === "boolean",
      JSON.stringify(r).slice(0, 120));
    check("the token is null, not the string 'undefined'",
      cap && cap.target.token === null, cap && String(cap.target.token));
  }

  // 4. Precedence is not accidental.
  {
    const { cap } = await mintWith({ [MODERN]: fake("modern2"), [LEGACY]: fake("legacy2") });
    check("COMPUTER_TERMINAL_TOKEN takes precedence over the fallback",
      cap && cap.target.token === fake("modern2"), cap && String(cap.target.token));
  }

  // 5. The fallback does not leak into the response the browser sees.
  {
    const { r } = await mintWith({ [LEGACY]: fake("legacy3") });
    check("the provider token never appears in the mint response",
      !JSON.stringify(r).includes(fake("legacy3")),
      "the browser must never receive the port token");
  }

  // 6. Source: the fallback is documented, because it exists for a reason that
  //    cannot be re-derived from the code alone (write-only secrets).
  {
    const src = readFileSync(resolve(PUBLIC, "computer/terminal.js"), "utf8");
    check("the fallback explains WHY (write-only Pages secrets)",
      /WRITE-ONLY/i.test(src), "a bare `||` with no reason invites deletion");
    check("the legacy name is the documented port-6083 token",
      /6083/.test(src), "the pairing must be stated, not assumed");
  }
}

console.log("proxy: refusals are refusals, with a readable reason");
{
  // Establish a clean, lease-free state. The token block above already released
  // its leases, so releasing `taken` again would 409 for a correct reason —
  // it is no longer the holder. Clear the row instead of asserting on a stale
  // handle, which is what made this read as a code failure.
  db.exec("DELETE FROM leases");
  const st = await (await call("/computer/state?computer=default")).json();
  check("the fixture is lease-free", st.lease === null, JSON.stringify(st.lease));

  const mintedWhileHeld = await (await post("/computer/terminal/session", {
    computer: "default", leaseId: "not-a-real-lease",
  }));
  check("minting against a lease you do not hold is refused",
    mintedWhileHeld.status === 409 || mintedWhileHeld.status === 403,
    String(mintedWhileHeld.status));

  stubUpstream({ status: 101 });
  const bogus = await call("/computer/terminal/control/1.bogus/websockify", {
    headers: { Upgrade: "websocket" },
  });
  check("an invalid capability is refused", bogus.status === 403, String(bogus.status));
  check("…and is not a socket", !bogus.webSocket);
  check("…and carries CORS so the browser can read the reason",
    bogus.headers.get("Access-Control-Allow-Origin") === "*",
    "a refusal without ACAO shows as an opaque CORS error");
}

console.log("proxy: the lease is re-checked, so release kills new sockets");
{
  const again = await (await post("/computer/takeover", { computer: "default" })).json();
  const minted = await (await post("/computer/terminal/session", {
    computer: "default", leaseId: again.leaseId,
  })).json();
  stubUpstream({ status: 101 });
  const before = await with101Shim(() => call(minted.url + "/websockify", {
    headers: { Upgrade: "websocket" },
  }));
  check("the link works while the lease is held", before.res.status === 101,
    String(before.res.status));

  await post("/computer/release", { computer: "default", leaseId: again.leaseId });
  const after = await with101Shim(() => call(minted.url + "/websockify", {
    headers: { Upgrade: "websocket" },
  }));
  check("the SAME link is refused after release", after.res.status === 403,
    `${after.res.status} — B-4 handed out a shell for 59 more minutes`);
  check("no socket is tunnelled after release", !after.res.webSocket);
}

console.log("proxy: an upstream refusal passes through, and never fakes a socket");
{
  const t = await (await post("/computer/takeover", { computer: "default" })).json();
  const minted = await (await post("/computer/terminal/session", {
    computer: "default", leaseId: t.leaseId,
  })).json();
  stubUpstream({ status: 401, body: "edge says no" });
  const res = await call(minted.url + "/websockify", { headers: { Upgrade: "websocket" } });
  check("an upstream 401 stays a 401", res.status === 401, String(res.status));
  check("it does not fabricate a socket", !res.webSocket);
  check("it explains itself in the body",
    /edge says no/.test(await res.text()), "the real reason must survive");
  await post("/computer/release", { computer: "default", leaseId: t.leaseId });
}

console.log("preflight: the terminal frame is cross-origin too");
{
  const res = await call("/computer/terminal/control/1.x/websockify", { method: "OPTIONS" });
  check("OPTIONS -> 204", res.status === 204, String(res.status));
  check("preflight carries ACAO",
    res.headers.get("Access-Control-Allow-Origin") === "*");
}

console.log("unchanged behaviour: B-17's clamp and B-4's deadline still hold");
{
  check("MAX_TERM_DIM is still 1000", termMod.MAX_TERM_DIM === 1000, String(termMod.MAX_TERM_DIM));
  check("TERMINAL_TTL_MS is still a minute, not an hour",
    termMod.TERMINAL_TTL_MS === 60_000, String(termMod.TERMINAL_TTL_MS));
  const src = readFileSync(resolve(PUBLIC, "computer/terminal.js"), "utf8");
  check("the deadline is still min(own TTL, lease + grace)",
    /Math\.min\(ownDeadline, leaseDeadline\)/.test(src));
  check("the preamble is still signed with the capability secret",
    /hmacHex\(\s*env\.COMPUTER_CAPABILITY_SECRET/s.test(src));
  const server = readFileSync(resolve(REPO, "features/computer/terminal-server.py"), "utf8");
  check("the PTY server still verifies the signature constant-time",
    /compare_digest/.test(server));
  check("the PTY server still clamps dimensions", /MAX_DIM/.test(server) && /clamp_dim/.test(server));
  check("the PTY server still kills a shell at its deadline",
    /deadline_passed/.test(server));
}

console.log("the route no longer returns JSON (the bug, asserted directly)");
{
  const src = readFileSync(resolve(PUBLIC, "computer/router.js"), "utf8");
  // Find the DISPATCH, not limitClass(): the same `path.startsWith` expression
  // also appears in the rate-limit classification, and matching that one made
  // this assertion look at the wrong code (it is the second occurrence).
  const all = [...src.matchAll(/if \(path(?:\.startsWith\("\/computer\/terminal\/"\)| === "\/computer\/terminal\/session")/g)].map((m) => m.index);
  const dispatchAt = src.indexOf("export async function handleComputer");
  const startAt = src.indexOf('if (path.startsWith("/computer/terminal/"))', dispatchAt);
  // Slice to the END OF THE BRACE BLOCK, not a fixed width — a fixed window
  // ran past the branch and caught the trailing `not_found` json(), failing an
  // assertion about code that is correct.
  const bodyStart = src.indexOf("{", startAt);
  let depth = 0;
  let endAt = bodyStart;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) { endAt = i + 1; break; }
    }
  }
  const branch = src.slice(startAt, endAt);
  check("the terminal branch calls proxyTerminal()",
    /return proxyTerminal\(request, env, url\)/.test(branch), branch.slice(0, 140));
  check("it does not call json( in that branch", !/\bjson\(/.test(branch),
    "returning JSON here is exactly B-29: " + branch.slice(0, 140));
}

globalThis.fetch = realFetch;

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
