// Local harness for routines Worker RT-001 fix (fake KV + fake fetch).
import worker from "/home/hatch/workspace/qwenpaw-deploy/features/routines/worker/src/index.js";
const SECRET_PROMPT = "SECRET-PROMPT-7f3a9-do-not-leak daily summary text";
const store = new Map();
store.set("routines:definitions", JSON.stringify([
  { id: "daily-summary", name: "Daily summary", prompt: SECRET_PROMPT, scheduleNote: "Daily 07:00", active: true },
  { id: "inbox-check-30m", name: "Inbox check", prompt: "SECRET-PROMPT-2 inbox text", scheduleNote: "Every 30 min", active: false },
]));
store.set("routines:history", JSON.stringify([{ at: "2026-11-14T21:00:00Z", kind: "wake-tick", qwenpaw: "up", httpStatus: 200, note: "ok", activeRoutines: ["daily-summary"] }]));
store.set("routines:pending:trig-1", JSON.stringify({ id: "trig-1", at: "2026-11-14T21:00:00Z", routineId: null, prompt: "SECRET-PENDING-PROMPT", status: "pending", qwenpaw: "up", httpStatus: 200 }));
const env = {
  QWENPAW_URL: "https://example.invalid/",
  ROUTINE_WEBHOOK_TOKEN: "test-token-123",
  STATUS: {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
    list: async ({ prefix }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  },
};
globalThis.fetch = async () => new Response("ok", { status: 200 });
let pass = 0, fail = 0;
const check = (name, cond) => { console.log((cond ? "PASS " : "FAIL ") + name); cond ? pass++ : fail++; };
const get = async (path, headers = {}) => {
  const res = await worker.fetch(new Request("https://worker.test" + path, { headers }), env, { waitUntil: () => {} });
  return { status: res.status, text: await res.text() };
};
let r = await get("/api/routines");
check("GET /api/routines 200", r.status === 200);
check("GET /api/routines has no secret prompt", !r.text.includes("SECRET-PROMPT"));
check("GET /api/routines keeps id+name", r.text.includes("daily-summary") && r.text.includes("Daily summary"));
r = await get("/api/status");
check("GET /api/status 200", r.status === 200);
check("GET /api/status has no secret prompt", !r.text.includes("SECRET-PROMPT"));
check("GET /api/status still reports qwenpaw up", r.text.includes('"status": "up"') || r.text.includes('"up"'));
r = await get("/");
check("GET / 200", r.status === 200);
check("GET / HTML has no secret prompt or pending prompt", !r.text.includes("SECRET-PROMPT") && !r.text.includes("SECRET-PENDING-PROMPT"));
check("GET / HTML still lists routines", r.text.includes("daily-summary"));
r = await get("/api/history");
check("GET /api/history 200, no prompt text", r.status === 200 && !r.text.includes("SECRET-PROMPT"));
r = await get("/trigger", {});
// POST without token
const post = await worker.fetch(new Request("https://worker.test/trigger", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env, { waitUntil: () => {} });
check("POST /trigger no token -> 401", post.status === 401);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
