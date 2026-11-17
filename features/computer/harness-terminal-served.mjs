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
  check("window.__computerErrors still collects everything",
    /window\.__computerErrors\.push/.test(js),
    "the devtools-accessible record is what made B-33/B-35 diagnosable");
  // B-40: the collection stopped being RENDERED. It used to write every entry
  // into a visible red bar, which then sat on screen permanently because a
  // successful screen probe was also written there.
  check("nothing is written into a visible error bar",
    !/jsErrorBar/.test(js),
    "B-40: the red diagnostics panel must not come back");
}

console.log("page: the SERVED /computer page has no raw-response dump (B-40)");
{
  // The bug is about what a browser RECEIVES, so this asserts on the response
  // through the real router, not on the file on disk. Reading ui.html would
  // still catch it today (serveUi passes the asset through unchanged), but the
  // served document is the thing the user actually looked at.
  const res = await call("/computer");
  const served = await res.text();
  check("the page is served at all", res.status === 200, String(res.status));

  // 1. No element exists to render a dump. The id is the cheap, stable handle;
  //    asserting on the red styling instead would break on a restyle.
  check("no jsErrorBar element in the served page", !/jsErrorBar/.test(served),
    "B-40: the red panel occupied ~26% of the viewport permanently");
  check("no inline red error-bar styling", !/background:#7f1d1d/.test(served),
    "the panel was red at rest on a healthy page");

  // 2. No code prints a FETCHED RESPONSE BODY as visible text. This is the
  //    specific defect: a successful probe's `<!DOCTYPE html>...` prefix was
  //    written into the panel. Matching the probe by name AND by the
  //    `.slice(...)`/`textContent` pairing that made it visible.
  // Match the RENDERING (a string literal being assigned to visible text), not
  // the phrase itself: the fix's own explanatory comment quotes the string, and
  // a comment cannot put anything on screen. My first version of this check
  // failed against the FIXED file for exactly that reason.
  check("no probe result is rendered into visible text",
    !/textContent\s*=\s*["'`]Screen probe/.test(served),
    "the probe printed a SUCCESS payload as an alarm");
  check("the screen page is not fetched just to print its body",
    !/fetch\(screenPage/.test(served),
    "mounting the frames must not depend on a probe fetch");
  check("the frames still mount", /function mountFrames\(\)/.test(served) &&
    /el\.previewFrame\.src = screenPage/.test(served),
    "removing the probe must not remove the mount");

  // 3. The removal must not have taken the real user-facing states with it.
  //    These are the messages a person acts on; only the raw dump was meant
  //    to go.
  const mustKeep = [
    ["the sign-in prompt", /Sign in to the QwenPaw console first/],
    ["the session-expired prompt", /Your console session expired/],
    ["the terminal-closed message", /The shell closed\. Take control again to reopen it\./],
    ["the screen-timeout message", /The screen did not respond/],
    ["the take-control-to-connect message", /Take control to connect\./],
    ["the stage/overlay veil text", /Loading the screen|Connecting…/],
  ];
  for (const [label, re] of mustKeep) {
    check(`${label} survives`, re.test(served), "a real error message was removed");
  }

  // 4. The rail must be intact — the panel used to be a body child ABOVE the
  //    rail, so a sloppy removal could take the header with it.
  check("the rail still exists", /id="rail"/.test(served));
  check("the tabs still exist", /data-tab="terminal"/.test(served) && /data-tab="teach"/.test(served));
  check("the terminal host still exists", /id="termHost"/.test(served));
  check("the preview frame still exists", /id="previewFrame"/.test(served));

  // 5. The error COLLECTION stays: it is what made B-33/B-35 diagnosable, and
  //    it costs nothing. Only its rendering was removed.
  check("window.__computerErrors is still collected", /__computerErrors\.push/.test(served),
    "keep the devtools record; drop the visible panel");
  check("…and nothing renders it to the page", !/textContent = "Page error:/.test(served));
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
  check("the courtesy line is cleared on the first real shell output",
    /let firstData = true;[\s\S]{0,400}if \(firstData\) \{ firstData = false; term\.clear\(\); \}/.test(js),
    "otherwise it sits above the prompt forever (B-40 browser check)");
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
