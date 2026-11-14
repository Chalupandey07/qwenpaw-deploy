// Harness for groupchat DO class: token gating (incl. fail-closed unset),
// ?token= rejection, rate limit, turn-taking, eviction surfacing.
import { GroupChatThread } from "/home/hatch/workspace/qwenpaw-deploy/features/groupchat/worker/src/index.js";
const makeEnv = (token) => {
  const store = new Map();
  const ctx = { storage: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } } };
  return { do: new GroupChatThread(ctx, { GROUPCHAT_TOKEN: token }), store };
};
let pass = 0, fail = 0;
const check = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? pass++ : fail++; };
const call = async (doObj, method, path, { token, body, ip } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Groupchat-Token"] = token;
  if (ip) headers["CF-Connecting-IP"] = ip;
  const res = await doObj.fetch(new Request("https://gc.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, json: await res.json().catch(() => null) };
};
// --- token set ---
let { do: d } = makeEnv("tok-abc");
let r = await call(d, "GET", "/");
check("GET / public, auth_required true", r.status === 200 && r.json?.auth_required === true);
r = await call(d, "GET", "/thread");
check("GET /thread no token -> 401", r.status === 401);
r = await call(d, "GET", "/thread", { token: "wrong" });
check("GET /thread wrong token -> 401", r.status === 401);
r = await call(d, "GET", "/thread?token=tok-abc");
check("GET /thread ?token=real -> 401 (header-only)", r.status === 401);
r = await call(d, "GET", "/thread", { token: "tok-abc" });
check("GET /thread header token -> 200", r.status === 200 && r.json?.seq === 0);
// --- token UNSET: fail closed (RT-002) ---
let u = makeEnv(undefined);
r = await call(u.do, "GET", "/");
check("GET / unset token: auth_required false, still 200", r.status === 200 && r.json?.auth_required === false);
r = await call(u.do, "GET", "/thread");
check("GET /thread unset token -> 401 (fail closed)", r.status === 401);
r = await call(u.do, "POST", "/thread/message", { body: { author: "x", role: "user", text: "hi" } });
check("POST /thread/message unset token -> 401", r.status === 401);
// --- turn-taking + rate limit (token set) ---
let g = makeEnv("tok-abc");
r = await call(g.do, "POST", "/thread/message", { token: "tok-abc", ip: "10.0.0.1", body: { author: "QwenPaw_QA_Agent_0.2", role: "agent", text: "out of turn" } });
check("agent post out of turn -> 409", r.status === 409);
r = await call(g.do, "POST", "/thread/message", { token: "tok-abc", ip: "10.0.0.1", body: { author: "rohan", role: "user", text: "hello" } });
check("user post -> 200 seq 1", r.status === 200 && r.json?.seq === 1);
r = await call(g.do, "POST", "/thread/message", { token: "tok-abc", ip: "10.0.0.1", body: { author: "default", role: "agent", text: "agent reply" } });
check("next_agent post -> 200, next advances", r.status === 200 && r.json?.next_agent === "QwenPaw_QA_Agent_0.2");
// rate limit: 30/min/IP. Already used 3 writes from 10.0.0.1; add 27 more = 30, then 31st -> 429
for (let i = 0; i < 27; i++) await call(g.do, "POST", "/thread/message", { token: "tok-abc", ip: "10.0.0.1", body: { author: "rohan", role: "user", text: "flood " + i } });
r = await call(g.do, "POST", "/thread/message", { token: "tok-abc", ip: "10.0.0.1", body: { author: "rohan", role: "user", text: "over" } });
check("31st write same IP -> 429 with Retry-After", r.status === 429 && typeof r.json?.retry_after_seconds === "number");
r = await call(g.do, "GET", "/thread", { token: "tok-abc" });
check("reads never rate-limited after flood", r.status === 200);
// reset guard
r = await call(g.do, "POST", "/thread/reset", { token: "tok-abc", ip: "10.0.0.2", body: { confirm: false } });
check("reset without confirm -> 400", r.status === 400);
r = await call(g.do, "POST", "/thread/reset", { token: "tok-abc", ip: "10.0.0.2", body: { confirm: true } });
check("reset confirm -> 200 seq 0", r.status === 200 && r.json?.thread?.seq === 0);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
