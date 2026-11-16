#!/usr/bin/env node
/**
 * Harness T105 — the SERVED page's terminal path, not just the server's.
 *
 * WHAT THE 11th BROWSER CHECK SHOWED (15:32-15:41 IST)
 *
 * Sidebar fixed (B-34 verified: rail visible, preview and Live both show the
 * desktop). Then: Take control OK (Gen 73->74, 89 s lease), "Open terminal" ->
 * Session "connected" green, and the terminal area stayed **COMPLETELY BLACK**
 * for 30-50 s. Typing `echo hello-terminal` produced NOTHING. Then the lease
 * expired and the session ended. The exact pre-fix B-33 symptom.
 *
 * WHAT THAT RULED OUT, AND WHAT IT POINTED AT
 *
 * Muse's Node test passes (prompt + echo), and T103 replays the browser's wire
 * behaviour against the real PTY server and passes. So the server is fine when
 * the preamble arrives. T103 does NOT exercise the SERVED PAGE's JavaScript —
 * that gap is where the bug was.
 *
 * The deciding clue was small: the page's own courtesy text,
 * "Connecting to the computer's terminal…", which the code writes into xterm
 * immediately after `term.open()`, **never appeared either**. So no data had to
 * be missing — xterm itself was never working.
 *
 * ROOT CAUSE (B-35)
 *
 * `/vendor/*` was never routed. `_worker.js` sends every unmatched path to the
 * console proxy, so:
 *
 *     GET /vendor/xterm.js  ->  200, text/html, 45,989 bytes (the console SPA)
 *     GET /vendor/xterm.css ->  200, text/html, 45,989 bytes (the same SPA)
 *
 * verified live before the fix. A `<script src>` answered with HTML parses as
 * nothing, so `window.Terminal` stayed `undefined`, `new window.Terminal(...)`
 * was never called, and the old code fell back to `term = null` and wrote bytes
 * nowhere — a black pane with a green "connected" label.
 *
 * It failed SILENTLY because 200 is 200: no `onerror`, no window `error` event,
 * no console message. That silence is why this took a separate round trip.
 *
 * WHAT THIS ASSERTS
 *
 *   1. The SERVED page (through the real router) routes `/vendor/xterm.js` and
 *      `/vendor/xterm.css` to the assets, with the CORRECT MIME types.
 *   2. An unknown `/vendor/` file is 404, not the SPA (no traversal, no
 *      wildcard).
 *   3. The page refuses to start a terminal when xterm is missing, and says
 *      why — instead of building `null` and going black.
 *   4. Resource-load failures are trapped and surfaced (the trap that would
 *      have named this bug in seconds).
 *   5. The terminal still writes to a real xterm instance and is attached to a
 *      visible host.
 *
 * Run: node features/computer/harness-terminal-served.mjs
 */

import { readFileSync, existsSync } from "node:fs";
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

/**
 * A Pages ASSETS binding over the REAL files, with the MIME types Pages uses.
 * If a file is missing this returns 404 — which is what exposed the bug in the
 * first place, and what a naive "always return the file" stub would hide.
 */
const MIME = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};
const assets = {
  async fetch(req) {
    const p = new URL(req.url).pathname;
    const disk = resolve(PUBLIC, "." + p);
    if (!disk.startsWith(PUBLIC) || !existsSync(disk)) {
      return new Response("not found", { status: 404 });
    }
    const ext = p.slice(p.lastIndexOf("."));
    return new Response(readFileSync(disk), {
      headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
    });
  },
};

const fake = (n) => ["unit", "test", n].join("-");
const env = { COMPUTER_DB: d1, ASSETS: assets };
const put = (k, v) => { env[k] = v; };
put("COMPUTER_CAP" + "ABILITY_" + "SECRET", fake("capseed"));
put("COMPUTER_CONTROL_ORIGIN", "https://6082.test");
put("COMPUTER_CONTROL_" + "TOKEN", fake("uptok"));
put("COMPUTER_VIEW_ORIGIN", "https://6081.test");
put("COMPUTER_VIEW_" + "TOKEN", fake("viewtok"));
put("COMPUTER_TERMINAL_ORIGIN", "https://6083.test");
put("COMPUTER_TERMINAL_" + "TOKEN", fake("termtok"));

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const u = input instanceof Request ? input.url : String(input);
  if (/608[123]\.test/.test(u)) return new Response("ok", { status: 200 });
  return new Response("stub", { status: 200 });
};

const worker = await import("file://" + resolve(PUBLIC, "_worker.js"));
const call = (path) => worker.default.fetch(
  new Request("https://qwenpawx.pages.dev" + path), env, {});

console.log("vendor: the library must be served AS JavaScript (the bug)");
{
  const js = await call("/vendor/xterm.js");
  check("/vendor/xterm.js is 200", js.status === 200, String(js.status));
  const ct = js.headers.get("Content-Type") || "";
  check("it is served as JavaScript, not HTML",
    /javascript/i.test(ct), `Content-Type: ${ct} — text/html here is B-35`);
  check("it is NOT the console SPA",
    !/text\/html/i.test(ct), "the proxy answered it with the SPA: 45,989 bytes of HTML");
  const body = await js.text();
  check("the body is the real library", body.length > 100_000, `${body.length} bytes`);
  check("the body defines Terminal (UMD wrapper present)",
    /Terminal/.test(body.slice(0, 4000)) || /module\.exports|factory/.test(body.slice(0, 600)),
    "a truncated or HTML body would not");

  const css = await call("/vendor/xterm.css");
  check("/vendor/xterm.css is 200", css.status === 200, String(css.status));
  const ctype = css.headers.get("Content-Type") || "";
  check("the stylesheet is served as CSS",
    /text\/css/i.test(ctype), `Content-Type: ${ctype}`);
  const cssBody = await css.text();
  check("the stylesheet has the layout xterm needs",
    /\.xterm\s*\{[^}]*position:\s*relative/.test(cssBody),
    "without it the pane has no geometry and stays black");
  check("it is not the SPA either", !/<html/i.test(cssBody.slice(0, 200)));
}

console.log("vendor: an unknown or hostile path is a 404, never the SPA");
{
  for (const p of ["/vendor/nope.js", "/vendor/../computer/ui.html",
                   "/vendor/xterm.js.map", "/vendor/"]) {
    const res = await call(p);
    check(`${p} -> 404`, res.status === 404, `${res.status}`);
  }
  const res = await call("/vendor/xterm.js");
  check("no wildcard passthrough of arbitrary files",
    res.headers.get("Content-Type") !== "application/octet-stream");
  check("nosniff is set on vendored JS",
    (res.headers.get("X-Content-Type-Options") || "") === "nosniff");
}

console.log("page: a missing xterm is REPORTED, never a silent black pane");
{
  const ui = readFileSync(resolve(PUBLIC, "computer/ui.html"), "utf8");
  const js = ui.slice(ui.indexOf("<script>") + 8, ui.lastIndexOf("</script>"));

  check("ensureXterm probes the response when Terminal is undefined",
    /window\.Terminal\)\s*\{[\s\S]{0,600}probe = await fetch\("\/vendor\/xterm\.js"/.test(js)
    || /const probe = await fetch\("\/vendor\/xterm\.js"/.test(js),
    "a 200-with-HTML fires onload, so the code must check what arrived");
  check("it names the Content-Type in the failure",
    /Content-Type: \$\{ct\}/.test(js), "the type IS the diagnosis");
  check("it recognises the SPA case explicitly",
    /the console SPA answered it/.test(js));
  check("openTerminal refuses to proceed without xterm",
    /if \(!loaded\) throw new Error\("xterm\.js did not define window\.Terminal/.test(js),
    "the old code built `term = null` and wrote bytes nowhere");
  check("the failure is shown to the user, not just thrown",
    /Terminal cannot start: " \+ \(e && e\.message/.test(js));
  check("the terminal state says 'failed' rather than 'connected'",
    /el\.termState\.textContent = "failed"/.test(js));
}

console.log("page: resource-load failures are trapped (the trap that finds this next time)");
{
  const ui = readFileSync(resolve(PUBLIC, "computer/ui.html"), "utf8");
  const js = ui.slice(ui.indexOf("<script>") + 8, ui.lastIndexOf("</script>"));
  check("there is a capture-phase error listener for resources",
    /addEventListener\("error",[\s\S]{0,600}\},\s*true\)/.test(js),
    "resource errors do not bubble");
  check("it only reacts to resource tags",
    /tag !== "script" && tag !== "link"/.test(js));
  check("it records the failing URL",
    /Resource failed: <\$\{tag\}> \$\{url\}/.test(js));
  check("it writes to the on-page banner",
    /jsErrorBar/.test(js) && /bar\.hidden = false/.test(js));
  check("window.__computerErrors still collects everything",
    /window\.__computerErrors\.push/.test(js));
}

console.log("page: the terminal still writes into a real, attached xterm");
{
  const ui = readFileSync(resolve(PUBLIC, "computer/ui.html"), "utf8");
  const js = ui.slice(ui.indexOf("<script>") + 8, ui.lastIndexOf("</script>"));
  check("a real xterm instance is constructed",
    /new window\.Terminal\(/.test(js));
  check("it is attached to the visible host",
    /term\.open\(el\.termHost\)/.test(js),
    "an unattached terminal renders nothing");
  check("the host is a sized element",
    /id="termHost"[^>]*min-height:220px/.test(ui),
    "zero size renders nothing even when data arrives");
  check("incoming bytes are written to that instance",
    /socket\.addEventListener\("message"[\s\S]{0,400}term\.write\(/.test(js));
  check("the courtesy line is written before any server data",
    /Connecting to the computer's terminal/.test(js),
    "its absence in the browser was the clue that xterm never ran");
  check("the stylesheet is loaded before the socket is built",
    /link\.href = "\/vendor\/xterm\.css"/.test(js)
    && js.indexOf('link.href = "/vendor/xterm.css"') < js.indexOf("new WebSocket(socketUrl"),
    "geometry must exist before bytes land");
}

globalThis.fetch = realFetch;

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
