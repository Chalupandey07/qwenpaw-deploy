// Re-test harness for board Worker FIX-5 checks (fake KV, test token).
import worker from "/home/hatch/workspace/qwenpaw-deploy/features/board/worker/src/index.js";
const store = new Map();
const env = {
  BOARD_TOKEN: "test-board-key-1234567890",
  TICKETS: {
    get: async () => store.get("tickets") ?? null,
    put: async (k, v) => { store.set(k, v); },
  },
};
let pass = 0, fail = 0;
const check = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? pass++ : fail++; };
const call = async (method, path, { key, body } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["X-Board-Key"] = key;
  const res = await worker.fetch(new Request("https://board.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, {});
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: res.status, text, json: j, headers: res.headers };
};
const K = "test-board-key-1234567890";
// auth matrix
let r = await call("GET", "/api/tickets");
check("GET /api/tickets no key -> 401", r.status === 401);
r = await call("GET", "/api/tickets", { key: "wrong" });
check("GET /api/tickets wrong key -> 401", r.status === 401);
r = await call("GET", "/api/tickets", { key: K });
check("GET /api/tickets good key -> 200", r.status === 200);
check("401 has nosniff+no-store", (await call("GET", "/api/tickets")).headers.get("x-content-type-options") === "nosniff");
// create + follow_up strict boolean
r = await call("POST", "/api/tickets", { key: K, body: { title: "T1", follow_up: "false" } });
check('create follow_up "false" -> 400', r.status === 400);
r = await call("POST", "/api/tickets", { key: K, body: { title: "T1", column: "in-progress", follow_up: true } });
check("create valid incl column honored -> 201", r.status === 201 && r.json?.column === "in-progress");
const id = r.json?.id;
check("ticket id returned", !!id);
// empty / unknown-only PATCH -> 400
r = await call("PATCH", `/api/tickets/${id}`, { key: K, body: {} });
check("empty PATCH -> 400", r.status === 400);
r = await call("PATCH", `/api/tickets/${id}`, { key: K, body: { not_a_field: 1 } });
check("unknown-only PATCH -> 400", r.status === 400);
r = await call("PATCH", `/api/tickets/${id}`, { key: K, body: { follow_up: "false" } });
check('PATCH follow_up "false" -> 400', r.status === 400);
r = await call("PATCH", `/api/tickets/${id}`, { key: K, body: { title: "T1b" } });
check("PATCH valid title -> 200", r.status === 200 && r.json?.title === "T1b");
// mark-sent idempotent
r = await call("POST", `/api/tickets/${id}/mark-sent`, { key: K });
check("mark-sent 1st -> 200 with timestamp", r.status === 200 && !!r.json?.sent_to_qwenpaw_at);
const ts1 = r.json?.sent_to_qwenpaw_at;
await new Promise((res) => setTimeout(res, 1100));
r = await call("POST", `/api/tickets/${id}/mark-sent`, { key: K });
check("mark-sent 2nd -> same timestamp (idempotent)", r.status === 200 && r.json?.sent_to_qwenpaw_at === ts1);
// %FF id -> 400 (not 500)
r = await call("GET", "/api/tickets/%FF", { key: K });
check("%FF id -> 400", r.status === 400);
check("%FF body is generic (no 'URI malformed')", !r.text.includes("URI malformed"));
// health method guard
r = await call("GET", "/health");
check("GET /health -> 200", r.status === 200);
r = await call("POST", "/health", { key: K });
check("POST /health -> 405", r.status === 405);
// delete cleanup
r = await call("DELETE", `/api/tickets/${id}`, { key: K });
check("DELETE ticket -> 200", r.status === 200);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
