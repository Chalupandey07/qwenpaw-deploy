#!/usr/bin/env node
/**
 * Harness T103 — the BROWSER's terminal path, end to end.
 *
 * WHAT THE REAL BROWSER SHOWED (13:41-13:53 IST, twice)
 *
 *   click "Open terminal" -> "connected" / "starting…"
 *   terminal area stays COMPLETELY BLACK — no prompt ever renders
 *   attempt 1: "connected" ~25 s, then "closed" / "Session ended."
 *   attempt 2: closed on its own within ~10 s
 *
 * Meanwhile the Node protocol test PASSED: 101 open, prompt "# " received,
 * `echo hello-terminal` printed. The difference is that the Node test sends RAW
 * text and the browser sends FRAMED input, so this is the browser path.
 *
 * THE TWO BUGS, both in ui.html, both sufficient on their own
 *
 * 1. ORDERING — THE PREAMBLE WAS NEVER SENT.
 *    `openTerminal()` did:
 *        socket = new WebSocket(...);
 *        await <load xterm.js>;              <-- a yield point
 *        socket.addEventListener("open", ...)  <-- sends the preamble
 *    A WebSocket can reach OPEN while that await is pending, and `open` does
 *    not wait for a listener. So `open` fired with nobody listening, the
 *    preamble was never sent, and the PTY server timed out after 5 s waiting
 *    for its first line and closed the connection — the "connected then closed"
 *    symptom, and the reason no prompt ever arrived (the shell never started).
 *
 * 2. XTERM.CSS WAS NEVER LINKED.
 *    xterm renders into absolutely positioned canvases whose geometry comes
 *    from its stylesheet. Without it the pane has no layout and stays black
 *    EVEN WHEN BYTES ARRIVE. A rendering bug, distinct from the ordering bug.
 *
 * WHAT THIS HARNESS DOES
 *
 * It cannot run a real browser, so it does the next most honest thing: it
 * replays the browser's EXACT wire behaviour against the REAL terminal-server.py
 * — same minted preamble, same subprotocol, same framed input — and asserts the
 * shell answers. It also statically asserts the two ordering/CSS properties in
 * ui.html, because those are what a future edit would break silently.
 *
 * Run: node features/computer/harness-terminal-browser.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PUBLIC = resolve(REPO, "pages/public");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

const ui = readFileSync(resolve(PUBLIC, "computer/ui.html"), "utf8");
const js = ui.slice(ui.indexOf("<script>") + 8, ui.lastIndexOf("</script>"));

console.log("ordering: the socket is created AFTER xterm loads, listeners in the same turn");
{
  // The bug in one assertion: find `new WebSocket`, the `await ensureXterm`,
  // and the `open` listener, and require the await to come FIRST.
  const awaitAt = js.indexOf("await ensureXterm()");
  const socketAt = js.indexOf("new WebSocket(socketUrl");
  const openAt = js.indexOf('socket.addEventListener("open"');
  check("xterm is ensured before the socket is constructed",
    awaitAt !== -1 && socketAt !== -1 && awaitAt < socketAt,
    `ensureXterm@${awaitAt} must precede new WebSocket@${socketAt}`);
  check("the open listener is attached immediately after construction",
    socketAt !== -1 && openAt !== -1 && openAt > socketAt,
    `open listener@${openAt}, socket@${socketAt}`);
  // No `await` BETWEEN the constructor and the listener: that gap is exactly
  // where the open event fell into the void.
  const between = js.slice(socketAt, openAt);
  check("no await between new WebSocket and the open listener",
    !/\bawait\b/.test(between),
    "an await here lets `open` fire before anything is listening: " + between.slice(0, 120));
  check("the preamble is sent inside the open handler",
    /socket\.send\(new TextEncoder\(\)\.encode\(preamble \+ "\\n"\)\)/.test(js),
    "without it the PTY server times out after 5 s and closes");
}

console.log("rendering: xterm's stylesheet is actually loaded");
{
  check("ensureXterm links /vendor/xterm.css",
    /href\s*=\s*"\/vendor\/xterm\.css"/.test(js),
    "xterm renders into absolutely positioned canvases; without the CSS the pane is black");
  check("the link is tagged so it is only added once",
    /data-xterm-css/.test(js));
  check("the library is loaded from the vendored path, never a CDN",
    /s\.src\s*=\s*"\/vendor\/xterm\.js"/.test(js) && !/cdn\.|unpkg|jsdelivr/.test(js));
  check("the CSS file exists in the repo",
    (() => { try { readFileSync(resolve(PUBLIC, "vendor/xterm.css")); return true; } catch { return false; } })());
  check("the CSS defines the canvas positioning xterm needs",
    (() => {
      const css = readFileSync(resolve(PUBLIC, "vendor/xterm.css"), "utf8");
      return /\.xterm\s*\{[^}]*position:\s*relative/.test(css)
        && /\.xterm-screen canvas\s*\{[^}]*position:\s*absolute/.test(css);
    })(), "if this changes, the missing-CSS symptom returns");
}

console.log("wire: the browser's exact flow against the REAL PTY server");
{
  // The Python side replays: mint-style preamble -> framed stdin -> expect
  // prompt and output. It imports the real terminal-server.py, so this is the
  // same code the machine runs.
  const script = resolve(HERE, "probe_browser_terminal.py");
  let out = "";
  let ok = false;
  try {
    out = execFileSync("python3", [script], { encoding: "utf8", timeout: 90_000 });
    ok = /ALL_OK/.test(out);
  } catch (e) {
    out = String(e.stdout || "") + String(e.stderr || e.message);
  }
  check("the browser flow reaches a prompt and gets output", ok,
    out.trim().split("\n").slice(-6).join(" | "));
  check("the preamble was accepted (the shell started)",
    /PREAMBLE_OK/.test(out), "a rejected preamble means the 5 s timeout returns");
  check("framed input produced the command's output",
    /OUTPUT_OK/.test(out), "this is what the black pane never showed");
  check("the session stayed open until closed deliberately",
    /ALIVE_OK/.test(out));
}

console.log("the UI no longer has a path that skips the preamble");
{
  // A reopen must still send it. `openTerminal` mints a fresh capability each
  // time, so a stale preamble cannot be reused — assert the mint is inside it.
  const fnStart = js.indexOf("async function openTerminal");
  const fnEnd = js.indexOf("function sendResize", fnStart);
  const fn = js.slice(fnStart, fnEnd);
  check("openTerminal mints a fresh session each call",
    /\/computer\/terminal\/session/.test(fn));
  check("it reads the preamble from the mint response", /r\.data\.preamble/.test(fn));
  check("it guards against a second concurrent session",
    /if \(state\.terminal\) return/.test(fn), "two sockets would fight for one lease");
  check("closing releases the session state so a reopen works",
    /state\.terminal = null/.test(js));
}

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
