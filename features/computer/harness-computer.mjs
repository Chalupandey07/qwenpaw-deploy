#!/usr/bin/env node
/**
 * Harness for the rebuilt computer (pages/public/computer/).
 *
 * What it proves, without a machine or a Cloudflare account:
 *   - the capability seals and opens, and REFUSES the wrong policy, an
 *     expired link, and a tampered token;
 *   - a control capability requires the live lease on every request;
 *   - a generation bump invalidates outstanding links;
 *   - the lease is atomic (one conditional write) and a release names it;
 *   - needs-you is per computer, with the preview hash in the record;
 *   - the preview path 304s on an unchanged hash;
 *   - the shim is injected into noVNC pages only, and hidden storage is
 *     replaced so the page can boot inside a cross-origin sandbox.
 *
 * These are the assertions that would have caught the previous
 * implementation's failures — a root shell outliving its lease, a takeover
 * reporting success without a generation bump, a global needs-you banner.
 *
 * Run: node features/computer/harness-computer.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const CAP = resolve(REPO, "pages/public/computer/capability.js");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

const cap = await import("data:text/javascript;base64," +
  Buffer.from(readFileSync(CAP, "utf8")).toString("base64"));

const SECRET = "***";
const target = { url: "https://6082.test/vnc.html", token: "***" };
const scope = { computer: "default", generation: 3, leaseId: "lease-a" };

await (async () => {
  console.log("capability: seal / open");
  const exp = Math.floor(Date.now() / 1000) + 600;
  const path = await cap.sealCapability(SECRET, { policy: "view", expiresAt: exp, target, scope });
  check("seal returns a path", path.startsWith("/computer/session/view/"), path);
  check("the token is in the path, not a query string", !path.includes("?"), path);
  check("the provider token does NOT appear in the URL",
    !decodeURIComponent(path).includes("***"), path);

  const opened = await cap.openCapability(SECRET, path);
  check("it opens", Boolean(opened), String(opened));
  check("the policy comes from the seal", opened?.policy === "view", String(opened?.policy));
  check("the target round-trips", opened?.target?.url === target.url, String(opened?.target?.url));
  check("the provider token is sealed, not in the clear",
    opened?.target?.token === "***", String(opened?.target?.token));
  check("the scope round-trips", opened?.scope?.generation === 3, JSON.stringify(opened?.scope));

  console.log("capability: refusals");
  const wrong = path.replace("/computer/session/view/", "/computer/session/control/");
  check("a view link cannot be replayed as control",
    (await cap.openCapability(SECRET, wrong)) === null, "policy is in the AAD");

  const other = await cap.openCapability("different-secret", path);
  check("a different secret cannot open it", other === null);

  const tampered = path.slice(0, -4) + (path.endsWith("AAAA") ? "BBBB" : "AAAA");
  check("a tampered token fails", (await cap.openCapability(SECRET, tampered)) === null);

  const oldExp = Math.floor(Date.now() / 1000) - 10;
  const oldPath = await cap.sealCapability(SECRET, { policy: "view", expiresAt: oldExp, target, scope });
  check("an expired link fails", (await cap.openCapability(SECRET, oldPath)) === null);

  const junk = await cap.openCapability(SECRET, "/computer/session/view/notanumber.x");
  check("a malformed path fails without throwing", junk === null);

  console.log("capability: determinism");
  const a = await cap.sealCapability(SECRET, { policy: "view", expiresAt: exp, target, scope });
  const b = await cap.sealCapability(SECRET, { policy: "view", expiresAt: exp, target, scope });
  check("two mints for the same scope produce the same link", a === b,
    "so two tabs do not invalidate each other");

  console.log("capability: control is shorter-lived");
  // A control capability outside a lease must be refused at MINT time by the
  // router; the seal itself only carries the expiry. The router clamps exp to
  // lease + grace. Assert the constant exists and is < the view TTL.
  check("the view TTL is minutes, not hours",
    cap.SCREEN_PROXY_TTL_MS <= 15 * 60_000, String(cap.SCREEN_PROXY_TTL_MS));

  console.log("shim");
  const html = "<!doctype html><html><head><title>noVNC</title></head><body></body></html>";
  const viewShim = cap.injectShim(html, true);
  check("the shim is injected into <head>", viewShim.includes("<head><style>"), viewShim.slice(0, 80));
  check("it hides the status bar (it names the upstream host)", viewShim.includes("#noVNC_status{display:none"));
  check("in view-only it ALSO hides the control bar",
    viewShim.includes("#noVNC_control_bar_anchor{display:none"));
  const ctlShim = cap.injectShim(html, false);
  check("in control mode the control bar is kept",
    !ctlShim.includes("#noVNC_control_bar_anchor{display:none"));
  check("storage is replaced in memory (sandboxed iframes throw on real storage)",
    viewShim.includes("localStorage") && viewShim.includes("sessionStorage")
    && viewShim.includes("memoryStorage") === false && viewShim.includes("items = new Map()"));
  check("VideoDecoder is deleted (Android H.264 probe hangs)",
    viewShim.includes("delete window.VideoDecoder"));
  check("it reports state to the parent",
    viewShim.includes("window.parent.postMessage"));
  check("it accepts exactly one parent message (focus)",
    viewShim.includes("screenFocus"));
  check("extension script errors are swallowed",
    viewShim.includes("-extension:"));

  console.log("page detection");
  check("vnc.html is a noVNC page", cap.isNovncPage("/vnc.html"));
  check("embed.html is a noVNC page", cap.isNovncPage("/x/embed.html"));
  check("app.js is not", !cap.isNovncPage("/app.js"));
  check("the page request asks for uncompressed bytes",
    cap.novncPageRequestHeaders(new Headers({ "accept-encoding": "gzip" })).get("accept-encoding") === "identity");
  check("validators are stripped so a 304 cannot serve a pre-shim page",
    !cap.novncPageRequestHeaders(new Headers({ etag: "x" })).has("if-none-match"));
  check("a rewritten page is never cached",
    (cap.rewrittenNovnc(new Headers({ etag: "x" })).get("cache-control") || "").includes("no-store"));
  check("and never transformed",
    (cap.rewrittenNovnc(new Headers()).get("cache-control") || "").includes("no-transform"));

  console.log("state module: contract");
  const stateSrc = readFileSync(resolve(REPO, "pages/public/computer/state.js"), "utf8");
  check("the lease lives 90 s", stateSrc.includes("LEASE_TTL_MS = 90_000"));
  check("the heartbeat is 15 s", stateSrc.includes("LEASE_HEARTBEAT_MS = 15_000"));
  check("the grant is ONE conditional statement",
    stateSrc.includes("ON CONFLICT(computer) DO UPDATE") && stateSrc.includes("WHERE leases.expires_at <= ?4"),
    "read-then-write is what let two tabs both win");
  check("a failed generation bump fails the grant",
    stateSrc.includes('reason: "store"'),
    "reporting success without a bump was BUGS.md B-1");
  check("release names the lease",
    stateSrc.includes("DELETE FROM leases WHERE computer = ? AND lease_id = ?"),
    "a late release must not end newer control");
  check("needs-you is keyed per computer",
    /FROM needs_you WHERE computer = \?/.test(stateSrc));
  check("previews are upserted in place, not appended",
    /ON CONFLICT\(computer\) DO UPDATE SET png/.test(stateSrc));
  check("previews only write when the hash changes",
    // The comparison moved from the blob to the metadata row (a 700 KB read
    // plus SHA-256 became a ~40-byte read) but the RULE is unchanged, so the
    // assertion is written against the rule, not the old expression.
    /if \(meta && meta\.sha256 === sha256\) return \{ ok: true, unchanged: true/.test(stateSrc),
    "unconditional uploads burned the KV quota");
  // The whole point of matching live tables: a second schema beside the real
  // one would look like it worked and lose every existing lease and preview.
  // Strip comments first: the file explains the defect it is avoiding, and a
  // naive substring check would flag its own explanation.
  // Strip block comments too: the module now documents the preview_meta DDL it
  // legitimately owns, and a naive `CREATE TABLE` check would flag that
  // explanation. What must never appear is a DDL for a LIVE table.
  const stateCode = stateSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  check("state.js uses the LIVE table names, not its own parallel schema",
    ["FROM leases", "FROM generations", "FROM needs_you", "FROM previews", "FROM modes"]
      .every((t) => stateCode.includes(t))
    && !stateCode.includes("computer_lease") && !stateCode.includes("computer_preview")
    // The one table it may create is its own additive metadata table.
    && [...stateCode.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)]
      .every((m) => m[1] === "preview_meta"),
    "a parallel schema is a silent data fork");

  console.log("router: enforcement order");
  const routerSrc = readFileSync(resolve(REPO, "pages/public/computer/router.js"), "utf8");
  check("the capability is opened before anything else in proxyScreen",
    routerSrc.indexOf("openCapability") < routerSrc.indexOf("leaseValid"),
    "generation and lease checks are meaningless on an unopened token");
  check("the generation is checked against live state",
    routerSrc.includes("computer.generation !== cap.scope.generation"));
  check("a control request re-checks the LIVE lease every time",
    routerSrc.includes("leaseValid(env, cap.scope.computer, cap.scope.leaseId)"));
  check("control expiry is clamped to the lease + grace",
    routerSrc.includes("LEASE_CAP_GRACE_MS") && routerSrc.includes("Math.min(exp"));
  check("the browser's Cookie header is dropped upstream",
    routerSrc.includes('headers.delete("cookie")'),
    "a stale per-port cookie 401'd every other port");
  check("redirects are manual",
    routerSrc.includes('redirect: "manual"'),
    "auto-follow without a cookie jar reports a healthy desktop as down");
  check("the provider token is attached server-side only",
    // Fix 2026-11-16: the token is attached server-side via the `_token`
    // query param inside fetchDesktopOrigin, NOT as a Bearer header. A
    // Bearer header is answered 401 by the InstaBox private-port edge, which
    // made the desktop report "stopped" forever. The token still never
    // reaches the browser: it is only in the server-side upstream fetch.
    routerSrc.includes('target.searchParams.set("_token", token)')
    && routerSrc.includes('fetchDesktopOrigin(')
    && !routerSrc.includes('headers.set("Authorization", "Bearer " + cap.target.token)'),
    "the token must ride the server-side upstream fetch only, never a browser URL or a Bearer header the edge rejects");
  check("set-cookie is stripped from proxied responses", routerSrc.includes('out.delete("set-cookie")'));
  check("the preview refuses > 1.5 MB (D1 row cap is 2 MB)",
    routerSrc.includes("1_500_000"));
  check("the preview 304s on an unchanged hash",
    routerSrc.includes("If-None-Match") && routerSrc.includes("304"));
  check("the agent-facing endpoints are token-gated",
    // Still token-gated, now through one constant-time helper instead of two
    // inline `!==` comparisons (B-16). Assert the helper is used AND that no
    // raw comparison crept back in.
    /requireSyncToken\(request, env\)/.test(routerSrc)
    && !/headers\.get\("X-Computer-Token"\)\s*!==/.test(routerSrc),
    "an inline token compare leaks by timing and can fail open when unset");

  console.log("ui: the behaviours that were broken before");
  const ui = readFileSync(resolve(REPO, "pages/public/computer/ui.html"), "utf8");
  check("the overlay is a full-viewport layer, not a new tab", ui.includes("position:fixed;inset:0"));
  check("closing the overlay does NOT stop the machine",
    /function closeOverlay\(\)/.test(ui) && !/closeOverlay[\s\S]{0,200}\/computer\/stop/.test(ui));
  check("the pointer gate opens only while control is held",
    ui.includes('pointerEvents = held ? "auto" : "none"'));
  check("there is a 'You have control' pill that clears on release",
    ui.includes("You have control") && ui.includes("el.ovYou.hidden = !held"));
  check("only a VISIBLE page heartbeats",
    ui.includes('document.visibilityState !== "visible"'));
  check("a release on pagehide uses keepalive",
    ui.includes("keepalive: true"));
  check("a held predecessor frame is a REAL element, not just tracked state",
    ui.includes('id="ovHeld"') && ui.includes("el.ovHeld.src = state.heldUrl"),
    "tracking heldUrl without rendering it leaves the screen black during a swap");
  check("the held frame is dropped once the new screen connects",
    ui.includes("el.ovHeld.hidden = true") && ui.includes('el.ovHeld.removeAttribute("src")'),
    "a held frame that is never dropped is a leak");
  check("the held frame cannot receive pointer events",
    ui.includes('class="screen held"'), "it is a picture of the previous screen");
  check("reconnect has a budget, not an infinite loop",
    ui.includes("RECONNECT_BUDGET"));
  check("a silent frame is treated as failed after a timeout",
    ui.includes("FRAME_LOAD_TIMEOUT_MS"));
  check("the preview image is keyed by the screen hash",
    ui.includes("/computer/preview?computer=") && ui.includes("previewSha"));
  check("Team vs Private is a real control", ui.includes("advPrivate") && ui.includes("setMode"));
  check("the terminal tab exists",
    ui.includes('data-tab="terminal"') && ui.includes('id="termHost"'),
    "a tab without a host is the old half-built terminal");
  check("the terminal is gated on control",
    /el\.termOpen\.disabled = !held/.test(ui),
    "a shell must not open without the lease");
  check("the terminal closes when control is released",
    /closeTerminal\("Control released/.test(ui),
    "B-4: the shell must die with the lease");
  check("the frame protocol is length-prefixed",
    ui.includes("encodeFrame(0") && ui.includes("setUint32(1"),
    "raw bytes cannot carry a resize on the same channel");
  check("the client clamps resize dimensions before sending",
    /Math\.min\(1000/.test(ui), "B-17");
  check("no injected SPA coupling: the page is self-contained",
    !ui.includes("qwenpaw-root") && ui.includes("<!doctype html>"));

  console.log("needs-you policy (the T56 fix)");
  const pol = await import("data:text/javascript;base64," +
    Buffer.from(readFileSync(resolve(REPO, "pages/public/computer/policy.js"), "utf8")).toString("base64"));
  const blockerCases = [
    ["Sign in to continue", true, "login"],
    ["Gmail - Enter your password", true, "login"],
    ["I'm not a robot", true, "captcha"],
    ["Enter the 6-digit verification code", true, "twoFactor"],
    ["Touch your security key", true, "passkey"],
    ["Enter your card number and CVV to continue", true, "payment"],
    ["Account settings - change your password", false, null],
    ["Inbox - 12 unread messages", false, null],
    ["", false, null],
  ];
  for (const [text, wantBlocked, wantKind] of blockerCases) {
    const r = pol.classifyBlocked(text);
    check(`classify ${JSON.stringify(text).slice(0, 36)} -> ${wantBlocked ? wantKind : "proceed"}`,
      r.blocked === wantBlocked && (wantBlocked ? r.kind === wantKind : true),
      `got blocked=${r.blocked} kind=${r.kind || "-"}`);
  }
  // The two recorded failures this catches: an entry field with no "required"
  // wording, and a settings page that must NOT be treated as a wall.
  check("an entry field is decisive even without the word 'required'",
    pol.classifyBlocked("Enter your password").blocked === true,
    "the first implementation returned false here — the T56 path");
  check("a settings page is not a wall",
    pol.classifyBlocked("Manage your password and security settings").blocked === false);

  const raise = pol.nextAction("Sign in to continue", { computer: "qa" });
  check("the action is raise", raise.action === "raise", raise.action);
  check("it targets the right computer", raise.request?.body?.computer === "qa",
    JSON.stringify(raise.request?.body));
  check("it says STOP", raise.then === "stop", raise.then);
  check("the text names the blocker", /login/.test(raise.text || ""), raise.text);

  check("working around the wall is a named violation",
    pol.violation("alternate_browser", true) === true);
  check("a normal action while not blocked is not a violation",
    pol.violation("alternate_browser", false) === false);
  check("the forbidden list covers the recorded T56 behaviour",
    ["alternate_browser", "retry_same_step", "continue_after_handback"]
      .every((x) => pol.FORBIDDEN_WHILE_BLOCKED.includes(x)),
    JSON.stringify(pol.FORBIDDEN_WHILE_BLOCKED));

  console.log();
  const total = passed + failed.length;
  console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
  if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
})();
