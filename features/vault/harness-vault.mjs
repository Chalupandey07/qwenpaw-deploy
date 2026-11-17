#!/usr/bin/env node
/**
 * Vault harness — the three properties a key vault must not ship without.
 *
 *   (a) The model cannot read a key value. A canary (random 32-hex, never
 *       reused) appears NOWHERE the model can see: not in /vault/list, not
 *       in any encoded form (base64, percent-encoded, `Bearer <canary>`),
 *       not in a /vault/request response even when the upstream echoes the
 *       request headers, not in a /vault/reveal without a valid session AND
 *       a console bearer token, and not in a /vault/export without the
 *       broker token. A request to a different origin than the item's is
 *       refused AND writes no vault_use row.
 *   (b) A tool call using the key still works. The upstream receives the
 *       Authorization header intact (the echo endpoint proves it), and the
 *       response comes back 200 with the key redacted from the body.
 *   (c) Keys survive restart. D1 is the durability; the master secret is a
 *       Pages secret + .env value. (The redeploy/restart half is a live
 *       test, run by Muse at deploy time — see features/vault/README.md.)
 *
 * Fail-first: each test must fail against a vault that returns values, and
 * pass against the real one. The canary is generated fresh per run, so a
 * test that passes by matching a stale value is impossible.
 *
 * These tests drive the REAL Worker (`pages/public/_worker.js` -> vault
 * router) against a D1 mock backed by real SQLite (the real schema.sql),
 * and stub the upstream fetch. No network, no machine.
 *
 * Run: node features/vault/harness-vault.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { sessionCookie, requestWith, anon } from "../computer/_session.mjs";

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
const schema = readFileSync(resolve(REPO, "features/storage/schema.sql"), "utf8");
db.exec(schema);

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

// A fresh master secret per run (64 hex chars = 32 random bytes). Never a
// committed value, never reused — a test that passes by matching a stale
// secret is impossible.
const masterBytes = new Uint8Array(32);
crypto.getRandomValues(masterBytes);
const MASTER = [...masterBytes].map((x) => x.toString(16).padStart(2, "0")).join("");
const BROKER_TOKEN = "test-broker-token-0123456789abcdef";
const SESSION_SECRET = "test-session-secret-0123456789abcdef";
const CONSOLE_TOKEN = "valid-console-token-0123456789";

const env = {
  VAULT_DB: d1,
  COMPUTER_DB: d1,
  VAULT_MASTER_SECRET: MASTER,
  VAULT_BROKER_TOKEN: BROKER_TOKEN,
  COMPUTER_SESSION_SECRET: SESSION_SECRET,
};

const ORIGIN = "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const worker = await import("file://" + resolve(PUBLIC, "_worker.js"));

// The upstream stub. Two behaviours:
//   * /api/cron/jobs (the console probe for reveal): 200 + a JSON array
//     only for the valid console bearer token, 401 otherwise.
//   * https://api.github.com/* : echoes the Authorization header back in
//     the body (so the test can prove the key arrived AND was redacted),
//     and also returns a body containing the canary in plain form (so the
//     test can prove the redactor strips it).
//   * anything else: 200 with a plain body.
const upstreamSeen = [];
globalThis.fetch = async (input, init = {}) => {
  const u = String(input && input.url ? input.url : input);
  const headers = new Headers((init && init.headers) || (input && input.headers) || {});
  if (u === ORIGIN + "/api/cron/jobs") {
    const auth = headers.get("Authorization") || "";
    if (auth === "Bearer " + CONSOLE_TOKEN) {
      return new Response(JSON.stringify([{ id: "job-1" }]), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "auth_required" }), { status: 401 });
  }
  upstreamSeen.push({ url: u, auth: headers.get("Authorization") || "" });
  if (u.startsWith("https://api.github.com/")) {
    // The upstream echoes the Authorization header AND leaks the token in
    // plain text in the body. Both must be redacted by the Worker before
    // the response reaches the model.
    const auth = headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    return new Response(JSON.stringify({
      echoed_auth: auth,
      leaked_plain: token,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response("ok", { status: 200 });
};

const COOKIE = await sessionCookie(env);
const call = (path, init = {}) => worker.default.fetch(
  requestWith(path, init, COOKIE), env, {});
const anonCall = (path, init = {}) => worker.default.fetch(anon(path, init), env, {});
const post = (path, body, extraHeaders = {}) => call(path, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...extraHeaders },
  body: JSON.stringify(body || {}),
});

// The canary: a random 32-hex value, never reused, never committed.
const canaryBytes = new Uint8Array(16);
crypto.getRandomValues(canaryBytes);
const CANARY = [...canaryBytes].map((x) => x.toString(16).padStart(2, "0")).join("");
const CANARY_B64 = Buffer.from(CANARY).toString("base64");
const CANARY_PCT = encodeURIComponent(CANARY);

console.log("vault (a): the model cannot read a key value");
{
  // The gate: anonymous callers get nothing.
  const anonList = await anonCall("/vault/list");
  check("anon list -> 401", anonList.status === 401, String(anonList.status));
  const anonPut = await anonCall("/vault/put", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x", kind: "bearer", origin: "https://api.github.com", value: "v" }),
  });
  check("anon put -> 401", anonPut.status === 401, String(anonPut.status));
  const anonReq = await anonCall("/vault/request", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "github-api", url: "https://api.github.com/user" }),
  });
  check("anon request -> 401", anonReq.status === 401, String(anonReq.status));
  const anonExp = await anonCall("/vault/export", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ names: ["github-api"] }),
  });
  check("anon export -> 401", anonExp.status === 401, String(anonExp.status));

  // Store the canary as a bearer item pinned to api.github.com.
  const put = await post("/vault/put", {
    name: "github-api", kind: "bearer", origin: "https://api.github.com",
    value: CANARY, title: "GitHub canary",
  });
  check("put the canary -> 200", put.status === 200, String(put.status) + " " + (await put.text()).slice(0, 200));

  // List returns metadata only.
  const list = await call("/vault/list");
  const listText = await list.text();
  check("list -> 200", list.status === 200, String(list.status));
  check("list has the name", listText.includes("github-api"));
  check("list has NO canary", !listText.includes(CANARY), "the value leaked into list");
  check("list has NO base64 canary", !listText.includes(CANARY_B64));
  check("list has NO percent-encoded canary", !listText.includes(CANARY_PCT));
  check("list has NO ciphertext", !listText.includes("v1:"));
  check("list has NO row id", !listText.includes('"id"'));

  // The upstream echoes the Authorization header; the Worker must redact it.
  const req = await post("/vault/request", {
    name: "github-api", url: "https://api.github.com/user", method: "GET",
  });
  const reqText = await req.text();
  check("request -> 200", req.status === 200, String(req.status) + " " + reqText.slice(0, 200));
  check("request body has NO canary", !reqText.includes(CANARY), "the value leaked in the response body");
  check("request body has NO Bearer canary", !reqText.includes("Bearer " + CANARY));
  check("request body has NO base64 canary", !reqText.includes(CANARY_B64));
  check("request body IS redacted", reqText.includes("[redacted]"), reqText.slice(0, 300));
  // And the upstream really did receive the header (property (b) half).
  const seen = upstreamSeen.find((s) => s.url === "https://api.github.com/user");
  check("upstream received the Bearer header", seen && seen.auth === "Bearer " + CANARY,
    seen ? `got: ${String(seen.auth).slice(0, 40)}` : "no upstream call recorded");

  // A request to a different origin is refused AND writes no use row.
  const usesBefore = db.prepare("SELECT COUNT(*) AS n FROM vault_use").get().n;
  const wrong = await post("/vault/request", {
    name: "github-api", url: "https://evil.example.com/steal", method: "GET",
  });
  check("wrong-origin request -> 403", wrong.status === 403, String(wrong.status));
  const usesAfter = db.prepare("SELECT COUNT(*) AS n FROM vault_use").get().n;
  check("wrong-origin request writes NO use row", usesAfter === usesBefore,
    `uses ${usesBefore} -> ${usesAfter}`);
  check("evil upstream was never called",
    !upstreamSeen.some((s) => s.url.startsWith("https://evil.example.com")));

  // Reveal: session alone is NOT enough (needs the console bearer too).
  const revealNoBearer = await post("/vault/reveal", { name: "github-api" });
  check("reveal with session but no console bearer -> 401",
    revealNoBearer.status === 401, String(revealNoBearer.status));
  const revealAnon = await anonCall("/vault/reveal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "github-api" }),
  });
  check("reveal anonymous -> 401", revealAnon.status === 401, String(revealAnon.status));
  // With the console bearer it works (owner only) — and records the use.
  const reveal = await post("/vault/reveal", { name: "github-api" },
    { Authorization: "Bearer " + CONSOLE_TOKEN });
  const revealBody = await reveal.json().catch(() => ({}));
  check("reveal with console bearer -> 200", reveal.status === 200, String(reveal.status));
  check("reveal returns the value", revealBody.value === CANARY);
  const revealUses = db.prepare(
    "SELECT COUNT(*) AS n FROM vault_use WHERE tool = 'reveal'").get().n;
  check("reveal writes a use row", revealUses === 1, String(revealUses));

  // Export: broker token only.
  const expNoToken = await post("/vault/export", { names: ["github-api"] });
  check("export without broker token -> 401", expNoToken.status === 401, String(expNoToken.status));
  const expWrong = await post("/vault/export", { names: ["github-api"] },
    { "X-Vault-Broker-Token": "wrong-token" });
  check("export with wrong broker token -> 401", expWrong.status === 401, String(expWrong.status));
  const exp = await post("/vault/export", { names: ["github-api"] },
    { "X-Vault-Broker-Token": BROKER_TOKEN });
  const expBody = await exp.json().catch(() => ({}));
  check("export with broker token -> 200", exp.status === 200, String(exp.status));
  check("export returns the value (broker channel only)",
    expBody.items && expBody.items[0] && expBody.items[0].value === CANARY);
  check("export returns the var name",
    expBody.items && expBody.items[0] && expBody.items[0].varName === "GITHUB_API");
  check("export returns the origin pin",
    expBody.items && expBody.items[0] && expBody.items[0].origin === "https://api.github.com");

  // List-broker: the agent's way to discover key names (broker token only).
  // The agent inside the container has no session cookie, so it cannot
  // call the session-gated /vault/list — this is its list path.
  const lbNoToken = await post("/vault/list-broker", {});
  check("list-broker without broker token -> 401", lbNoToken.status === 401, String(lbNoToken.status));
  const lbWrong = await post("/vault/list-broker", {},
    { "X-Vault-Broker-Token": "wrong-token" });
  check("list-broker with wrong broker token -> 401", lbWrong.status === 401, String(lbWrong.status));
  const usesBeforeLb = db.prepare("SELECT COUNT(*) AS n FROM vault_use").get().n;
  const lb = await post("/vault/list-broker", {},
    { "X-Vault-Broker-Token": BROKER_TOKEN });
  const lbText = await lb.text();
  check("list-broker with broker token -> 200", lb.status === 200, String(lb.status));
  check("list-broker has the name", lbText.includes("github-api"));
  check("list-broker has NO canary", !lbText.includes(CANARY), "the value leaked into list-broker");
  check("list-broker has NO ciphertext", !lbText.includes("v1:"));
  check("list-broker has NO row id", !lbText.includes('"id"'));
  const usesAfterLb = db.prepare("SELECT COUNT(*) AS n FROM vault_use").get().n;
  check("list-broker writes NO use row", usesAfterLb === usesBeforeLb,
    `${usesBeforeLb} -> ${usesAfterLb}`);
}

console.log("vault (a): validation");
{
  const badName = await post("/vault/put", {
    name: "Bad Name", kind: "bearer", origin: "https://api.github.com", value: "v12345678",
  });
  check("bad name -> 400", badName.status === 400, String(badName.status));
  const badOrigin = await post("/vault/put", {
    name: "x1", kind: "bearer", origin: "https://api.github.com/v1/repos?x=1", value: "v12345678",
  });
  check("origin with a path -> 400", badOrigin.status === 400, String(badOrigin.status));
  const httpOrigin = await post("/vault/put", {
    name: "x2", kind: "bearer", origin: "http://api.github.com", value: "v12345678",
  });
  check("http origin -> 400", httpOrigin.status === 400, String(httpOrigin.status));
  const badHeader = await post("/vault/put", {
    name: "x3", kind: "header", origin: "https://api.example.com",
    headerName: "Authorization", value: "v12345678",
  });
  check("header name Authorization -> 400", badHeader.status === 400, String(badHeader.status));
  const reservedVar = await post("/vault/put", {
    name: "path", kind: "command", value: "v12345678",
  });
  check("command item named like PATH -> 409", reservedVar.status === 409, String(reservedVar.status));
  const proxyVar = await post("/vault/put", {
    name: "my-proxy", kind: "command", value: "v12345678",
  });
  check("command item mapping to *_PROXY -> 409", proxyVar.status === 409, String(proxyVar.status));
  const cmdOk = await post("/vault/put", {
    name: "my-cli-key", kind: "command", value: "v12345678",
  });
  check("valid command item -> 200", cmdOk.status === 200, String(cmdOk.status));
  const cmdReq = await post("/vault/request", {
    name: "my-cli-key", url: "https://api.github.com/user", method: "GET",
  });
  check("command item via /request -> 400", cmdReq.status === 400, String(cmdReq.status));
}

console.log("vault (a): crypto unit checks (via the real crypto.js)");
{
  const cryptoMod = await import("file://" + resolve(PUBLIC, "vault/crypto.js"));
  const key = await cryptoMod.loadMasterKey(env);
  const sealed = await cryptoMod.sealValue(key,
    { itemId: "aabbccddeeff001122334455", kind: "bearer", host: "api.github.com", keyVersion: "1" },
    CANARY);
  check("seal produces v1: format", sealed.startsWith("v1:"));
  const opened = await cryptoMod.openValue(key,
    { itemId: "aabbccddeeff001122334455", kind: "bearer", host: "api.github.com", keyVersion: "1" },
    sealed);
  check("open returns the value", opened === CANARY);
  const wrongHost = await cryptoMod.openValue(key,
    { itemId: "aabbccddeeff001122334455", kind: "bearer", host: "evil.example.com", keyVersion: "1" },
    sealed);
  check("wrong host in AAD -> null (no transplant)", wrongHost === null);
  const wrongKind = await cryptoMod.openValue(key,
    { itemId: "aabbccddeeff001122334455", kind: "header", host: "api.github.com", keyVersion: "1" },
    sealed);
  check("wrong kind in AAD -> null (no cross-type)", wrongKind === null);
  const wrongId = await cryptoMod.openValue(key,
    { itemId: "000000000000000000000000", kind: "bearer", host: "api.github.com", keyVersion: "1" },
    sealed);
  check("wrong item id in AAD -> null", wrongId === null);
  // Name is NOT in the AAD: opening with a different name still works
  // (rename is metadata-only, no re-seal). The AAD has no name field, so
  // this is proven by the seal/open above using no name at all.
  const tampered = sealed.slice(0, -4) + "AAAA";
  const tamperedOpen = await cryptoMod.openValue(key,
    { itemId: "aabbccddeeff001122334455", kind: "bearer", host: "api.github.com", keyVersion: "1" },
    tampered);
  check("tampered ciphertext -> null", tamperedOpen === null);
  // Redaction: overlapping forms merge into one marker.
  const forms = cryptoMod.redactionForms("bearer", { value: CANARY });
  const redacted = cryptoMod.redactText(
    `Authorization: Bearer ${CANARY} and ${CANARY}`, forms);
  check("redact hides all forms", !redacted.includes(CANARY) && redacted.includes("[redacted]"));
  check("redact merges touching forms (one marker, not two)",
    redacted === "Authorization: [redacted] and [redacted]", redacted);
  // A short raw value is never itself a form (minimum length 8) — otherwise
  // every 3-letter substring in any text would be destroyed. The
  // scheme-prefixed forms ("Bearer abc") are long enough and are present.
  const shortForms = cryptoMod.redactionForms("bearer", { value: "abc" });
  check("short raw value is NOT a redaction form", !shortForms.includes("abc"));
  check("short value still gets scheme forms", shortForms.includes("Bearer abc"));
}

console.log("vault (c): the store is the durability (rows exist, activity capped)");
{
  const act = await call("/vault/activity?name=github-api");
  const actBody = await act.json().catch(() => ({}));
  check("activity -> 200", act.status === 200, String(act.status));
  check("activity lists the request + reveal uses",
    (actBody.uses || []).length >= 2, JSON.stringify(actBody.uses || []).slice(0, 200));
  check("activity has NO value", !JSON.stringify(actBody).includes(CANARY));
  // Remove deletes the item and its uses.
  const rem = await post("/vault/remove", { name: "my-cli-key" });
  check("remove -> 200", rem.status === 200, String(rem.status));
  const gone = await call("/vault/activity?name=my-cli-key");
  check("removed item -> 404", gone.status === 404, String(gone.status));
}

console.log(`vault: ${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log("  - " + f);
  process.exit(1);
}
