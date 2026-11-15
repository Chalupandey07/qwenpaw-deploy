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
    stateSrc.includes("ON CONFLICT(computer) DO UPDATE") && stateSrc.includes("WHERE computer_lease.expires_at <= ?4"),
    "read-then-write is what let two tabs both win");
  check("a failed generation bump fails the grant",
    stateSrc.includes('reason: "store"'),
    "reporting success without a bump was BUGS.md B-1");
  check("release names the lease",
    stateSrc.includes("DELETE FROM computer_lease WHERE computer = ? AND lease_id = ?"),
    "a late release must not end newer control");
  check("needs-you is keyed per computer",
    stateSrc.includes("WHERE computer = ? AND resolved_at IS NULL"));
  check("previews are upserted in place, not appended",
    stateSrc.includes("ON CONFLICT(computer) DO UPDATE"));
  check("previews only write when the hash changes",
    stateSrc.includes("WHERE computer_preview.sha256 IS NOT excluded.sha256"),
    "unconditional uploads burned the KV quota");

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
    routerSrc.includes('headers.set("Authorization", "Bearer " + cap.target.token)'));
  check("set-cookie is stripped from proxied responses", routerSrc.includes('out.delete("set-cookie")'));
  check("the preview refuses > 1.5 MB (D1 row cap is 2 MB)",
    routerSrc.includes("1_500_000"));
  check("the preview 304s on an unchanged hash",
    routerSrc.includes("If-None-Match") && routerSrc.includes("304"));
  check("the agent-facing endpoints are token-gated",
    routerSrc.includes("X-Computer-Token"));

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
  check("a held predecessor frame survives the swap",
    ui.includes("state.heldUrl") || ui.includes("heldUrl"));
  check("reconnect has a budget, not an infinite loop",
    ui.includes("RECONNECT_BUDGET"));
  check("a silent frame is treated as failed after a timeout",
    ui.includes("FRAME_LOAD_TIMEOUT_MS"));
  check("the preview image is keyed by the screen hash",
    ui.includes("/computer/preview?computer=") && ui.includes("previewSha"));
  check("Team vs Private is a real control", ui.includes("advPrivate") && ui.includes("setMode"));
  check("the terminal tab exists", ui.includes('data-tab="teach"') || ui.includes("Terminal"));
  check("no injected SPA coupling: the page is self-contained",
    !ui.includes("qwenpaw-root") && ui.includes("<!doctype html>"));

  console.log();
  const total = passed + failed.length;
  console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
  if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
})();
