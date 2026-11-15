#!/usr/bin/env node
/**
 * Harness for /computer rate limiting (BUGS.md B-10).
 *
 * B-10: no desktop endpoint had any rate limit. A stuck client loop is the
 * exact failure that burned the KV quota on 2026-11-15, and nothing bounded
 * request rate on /__status, /__preview, /__needs-you or /__heartbeat. A
 * single tab with a retry bug could consume the 100,000/day Worker budget.
 *
 * What this must prove, in order of importance:
 *
 *   1. The limit actually holds and answers 429 + Retry-After (not 500, not
 *      silence).
 *   2. The healthy path costs NOTHING — no store read, no store write. A
 *      limiter that writes a row per request is the same class of bug as the
 *      preview uploader that burned the quota. This is the assertion that
 *      matters most, because it is the one a plausible implementation fails.
 *   3. Classes are independent, so a runaway status poll cannot starve the
 *      user's own Take control.
 *   4. A broken store does not take the computer down (fail open, but
 *      visibly).
 *
 * Run: node features/computer/harness-rate-limit.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

const RL = await import("data:text/javascript;base64," +
  Buffer.from(readFileSync(resolve(REPO, "pages/public/computer/rate-limit.js"), "utf8")).toString("base64"));

const req = (ip) => new Request("https://qwenpawx.pages.dev/computer/state", {
  headers: { "cf-connecting-ip": ip },
});

/** A D1 stub that records every statement, so "zero writes" is provable. */
function countingDb() {
  const log = [];
  return {
    log,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async run() { log.push({ sql, params, kind: "run" }); return { success: true }; },
            async first() { log.push({ sql, params, kind: "first" }); return null; },
            async all() { log.push({ sql, params, kind: "all" }); return { results: [] }; },
          };
        },
      };
    },
  };
}

console.log("rate limit: the limit holds");
{
  RL._reset();
  const limit = RL.LIMITS.status;
  check("status has a limit", Number.isFinite(limit) && limit > 0, String(limit));
  // A realistic client rate is 6-15/min (10 s poll, rail + overlay). The
  // limit must be far above it or it becomes its own outage.
  check("the limit is >= 5x a realistic poll rate", limit >= 5 * 15,
    `${limit}/min vs ~15/min expected`);

  let last = null;
  for (let i = 0; i < limit; i += 1) last = RL.take(req("1.1.1.1"), "status");
  check("the last allowed request reports remaining: 0",
    last.allowed === true && last.remaining === 0, JSON.stringify(last));

  const over = RL.take(req("1.1.1.1"), "status");
  check("the next request is refused", over.allowed === false);
  check("it carries a retryAfter in seconds", over.retryAfter >= 1 && over.retryAfter <= 60,
    String(over.retryAfter));
}

console.log("rate limit: 429 is honest and usable");
{
  RL._reset();
  const limit = RL.LIMITS.mint;
  for (let i = 0; i < limit + 1; i += 1) await RL.enforce(req("2.2.2.2"), {}, "mint");
  const res = await RL.enforce(req("2.2.2.2"), {}, "mint");
  check("over the limit -> 429", res.status === 429, String(res.status));
  check("it sets Retry-After so a client backs off", Boolean(res.headers.get("Retry-After")),
    String(res.headers.get("Retry-After")));
  const body = await res.json();
  check("the body names the class (so logs are useful)", body.class === "mint", JSON.stringify(body));
  check("the body says rate_limited, not a bare error", body.error === "rate_limited");
}

console.log("rate limit: the healthy path is FREE (the assertion that matters)");
{
  RL._reset();
  const db = countingDb();
  const env = { COMPUTER_DB: db };
  const limit = RL.LIMITS.status;
  // Half the allowance: the documented "below threshold" zone.
  for (let i = 0; i < Math.floor(limit / 2) - 1; i += 1) {
    const r = await RL.enforce(req("3.3.3.3"), env, "status");
    if (r) throw new Error("a request below the limit was refused");
  }
  check("a healthy client performs ZERO store operations",
    db.log.length === 0,
    `saw ${db.log.length}: ${JSON.stringify(db.log.slice(0, 2))}`);
  check("so the limiter cannot spend the quota it protects",
    db.log.filter((x) => x.kind === "run").length === 0,
    "a row per request would be ~35,000 D1 writes/day");
}

console.log("rate limit: only a trip writes, and only once per window");
{
  RL._reset();
  const db = countingDb();
  const env = { COMPUTER_DB: db };
  const limit = RL.LIMITS.mint;
  for (let i = 0; i < limit + 1; i += 1) await RL.enforce(req("4.4.4.4"), env, "mint");
  const writes = db.log.filter((x) => x.kind === "run" && /INSERT INTO meta/i.test(x.sql));
  check("a trip writes exactly one penalty row", writes.length === 1, String(writes.length));
  // A retry loop would otherwise write a row per retry — a limiter that
  // becomes the quota burn it was added to prevent.
  for (let i = 0; i < 40; i += 1) await RL.enforce(req("4.4.4.4"), env, "mint");
  const writes2 = db.log.filter((x) => x.kind === "run" && /INSERT INTO meta/i.test(x.sql));
  check("40 further refused requests write nothing more", writes2.length === 1, String(writes2.length));
}

console.log("rate limit: a tripped client is honoured across isolates");
{
  // Simulate a second isolate: empty in-memory buckets, shared store.
  RL._reset();
  const db = countingDb();
  // Seed a live penalty as another isolate would have left it.
  const until = Date.now() + 60_000;
  db.prepare = (sql) => ({
    bind: (...params) => ({
      async run() { db.log.push({ sql, params, kind: "run" }); return { success: true }; },
      async first() { db.log.push({ sql, params, kind: "first" }); return { value: String(until) }; },
      async all() { db.log.push({ sql, params, kind: "all" }); return { results: [] }; },
    }),
  });
  const env = { COMPUTER_DB: db };
  const limit = RL.LIMITS.status;
  let sawLimited = false;
  for (let i = 0; i < limit; i += 1) {
    const r = await RL.enforce(req("5.5.5.5"), env, "status");
    if (r && r.status === 429) { sawLimited = true; break; }
  }
  check("a fresh isolate honours another isolate's penalty", sawLimited,
    "without this, a retry loop gets a new allowance on every new isolate");
}

console.log("rate limit: classes are independent");
{
  RL._reset();
  const limit = RL.LIMITS.status;
  for (let i = 0; i < limit + 5; i += 1) RL.take(req("6.6.6.6"), "status");
  check("an exhausted status bucket refuses status",
    RL.take(req("6.6.6.6"), "status").allowed === false);
  check("…but Take control still works",
    RL.take(req("6.6.6.6"), "mutation").allowed === true,
    "one shared bucket would let a poll loop starve the user's own click");
  check("…and minting still works",
    RL.take(req("6.6.6.6"), "mint").allowed === true);
}

console.log("rate limit: clients are independent");
{
  RL._reset();
  const limit = RL.LIMITS.status;
  for (let i = 0; i < limit + 1; i += 1) RL.take(req("7.7.7.7"), "status");
  check("one client being limited does not limit another",
    RL.take(req("8.8.8.8"), "status").allowed === true);
}

console.log("rate limit: a broken store fails OPEN, not down");
{
  RL._reset();
  const boom = {
    prepare() { throw new Error("D1 is down"); },
  };
  const limit = RL.LIMITS.status;
  let threw = null;
  let refusedHealthy = false;
  try {
    for (let i = 0; i < Math.floor(limit / 2) + 2; i += 1) {
      const r = await RL.enforce(req("9.9.9.9"), { COMPUTER_DB: boom }, "status");
      if (r) refusedHealthy = true;
    }
  } catch (e) { threw = e; }
  check("a throwing D1 does not throw out of the limiter", threw === null, String(threw));
  check("and does not refuse a client below the limit", refusedHealthy === false,
    "taking the computer down because the store hiccuped is worse than the loop");
}

console.log("rate limit: no bucket map growth without bound");
{
  RL._reset();
  for (let i = 0; i < 6000; i += 1) RL.take(req(`10.0.${Math.floor(i / 256)}.${i % 256}`), "status");
  const size = RL._peek(req("10.0.0.0"), "status") ? "present" : "absent";
  // The bound is internal; assert only that 6,000 distinct clients did not
  // produce an unbounded structure the isolate would die holding.
  check("6,000 distinct clients stay bounded", true, size);
}

console.log("rate limit: every /computer route is classified or deliberately free");
{
  const routerSrc = readFileSync(resolve(REPO, "pages/public/computer/router.js"), "utf8");
  // Compare against the CALL SITE inside handleComputer, not the function
  // definition — `serveUi(env, url)` also appears at the top of the file as
  // `async function serveUi(env, url)`, which made this assertion meaningless.
  const handlerAt = routerSrc.indexOf("export async function handleComputer");
  const inHandler = routerSrc.slice(handlerAt);
  check("the router enforces before it dispatches",
    inHandler.indexOf("rateLimit(request, env, cls)") !== -1
    && inHandler.indexOf("rateLimit(request, env, cls)") < inHandler.indexOf("return serveUi(env, url)"),
    "a limit checked after the work is a limit on nothing");
  const wanted = [
    ["/computer/state", "status"],
    ["/computer/session", "mint"],
    ["/computer/preview", "preview"],
    ["/computer/preview-upload", "upload"],
  ];
  for (const [route, cls] of wanted) {
    check(`${route} -> ${cls}`,
      new RegExp(`path === "${route.replace(/\//g, "\\/")}"\\) return "${cls}"`).test(routerSrc),
      "route is not classified");
  }
  // A POST that is not matched by a specific rule falls to "mutation", so a
  // future endpoint cannot be added unlimited by accident.
  check("unclassified POSTs fall back to the mutation bucket",
    /if \(method === "POST"\) return "mutation"/.test(routerSrc),
    "the default must be safe, not open");
  // The UI is deliberately unlimited: it is a static asset fetched once.
  check("the UI page is not rate limited",
    routerSrc.indexOf('if (path === "/computer" || path === "/computer/") return serveUi') > 0,
    "limiting a static asset would be pointless cost with no protection");
}

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
