// QwenPaw reverse proxy — Cloudflare Pages Advanced Mode (_worker.js).
// Root / and everything else is proxied to the QwenPaw console on InstaBox.
// /status (and /status.html) serves the status / wake page from static assets.
// Every proxied visit hits the InstaBox public URL, which counts as activity
// and wakes an auto-paused box; the 5-minute Worker cron is the other keeper.
//
// COMPUTER REMOVED 2026-11-15. This Worker used to carry the whole /desktop
// surface (gate page, noVNC proxy, lease, capabilities, previews, needs-you,
// teach, modes). It was removed deliberately so the computer could be rebuilt
// from Rakazo's design rather than patched further; see features/computer/.
// What remains is exactly the console proxy plus the wake/cooldown handling,
// and that is the entire responsibility of this file.
// oxlint-disable prefer-template, no-nested-ternary
// The waking/cooldown pages below build their HTML with string
// concatenation ON PURPOSE — wakingPage() documents the constraint as
// "string concatenation only, no backticks, no interpolation, no external
// assets" (Smart Sleep/Wake card rebuild, 2026-11-19). prefer-template
// would push every one of those toward template literals, directly
// contradicting that decision, so it is suppressed file-wide here rather
// than rewriting a dozen deliberate concatenations. The one nested
// ternary is in the cookie-header normalisation, kept for the same
// reason: it is a flat, readable guard, not a style problem worth a
// helper.
import { handleComputer } from "./computer/router.js";
import { handleVault } from "./vault/router.js";
import { handleReset } from "./reset/router.js";
import { restMachine, sleepMachine, machineState, authenticate } from "./machine-control.js";
import {
  mintSession, sessionFromRequest, sessionSetCookie, sessionClearCookie, SESSION_TTL_MS,
} from "./session.js";

const ORIGIN = "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const WAKE_WAIT_MS = 45_000;
// KEEPALIVE_URL and MACHINE_ID were declared here and never referenced: the
// rebrand's Vault/Rest/Computer pills reach the keep-alive Worker through
// paths built in the injected client script, not from this module. Removed
// rather than underscore-prefixed — an unused constant that looks like a
// wiring point is worse than no constant, because the next reader assumes
// the proxy calls the keep-alive Worker somewhere it does not.

// AgentX rebrand (2026-11-18, features/rebrand/README.md). The product is
// AgentX now; the upstream console still calls itself QwenPaw, so the
// visible rename is done by DOM injection (headShim + the rebrand rules
// inside computerPanelScript) — never by rewriting the bundle. These are
// the single source of truth for the pinned upstream version and the
// upstream hosts the shim swallows. The image is pinned by digest in the
// machine's docker-compose.yml (agentscope/qwenpaw:v2.3.0@sha256:46a782…),
// so the version the PyPI stub returns can never drift from what runs.
const PINNED_QWENPAW_VERSION = "2.3.0";
const PYPI_QWENPAW_URL = "https://pypi.org/pypi/qwenpaw/json";
const UPSTREAM_DOC_ORIGIN = "https://qwenpaw.agentscope.io";
const UPSTREAM_GITHUB_URL = "https://github.com/agentscope-ai/QwenPaw";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rewrite response headers for the Pages origin.
 *
 * This function was written on 2026-11-15 to close audit finding
 * `proxy-open-redirect-rewrite-gap` (A-6) and to carry the Referrer-Policy
 * half of the `qwenpaw-query-token-leak` fix. The 8,399-line computer
 * removal deleted it as collateral while leaving its call site in `proxy()`,
 * which made this Worker throw a ReferenceError on *every* proxied request —
 * the whole console, not just the computer. Restored here verbatim; the
 * reasoning below is the original.
 */
function rewriteHeaders(res, pagesOrigin) {
  const headers = new Headers(res.headers);
  // Rewrite redirects that point at the origin so the browser stays on Pages.
  // Hardened: the old code only rewrote absolute ORIGIN URLs. A
  // protocol-relative Location (//evil.example/x) or a foreign absolute URL
  // (https://evil.example/x) passed through unrewritten, so our Pages
  // domain could redirect visitors elsewhere. QwenPaw emits no Location
  // headers at all today (verified in source), so any Location is
  // hypothetical — but a foreign redirect must never leave here intact.
  const loc = headers.get("Location");
  if (loc) {
    if (loc.startsWith(ORIGIN)) {
      headers.set("Location", pagesOrigin + loc.slice(ORIGIN.length));
    } else if (loc.startsWith("//")) {
      try {
        const u = new URL("https:" + loc);
        if (u.origin === ORIGIN) {
          headers.set("Location", pagesOrigin + u.pathname + u.search + u.hash);
        } else {
          headers.delete("Location");
        }
      } catch {
        headers.delete("Location");
      }
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(loc)) {
      headers.delete("Location"); // absolute URL to a foreign host
    }
    // A relative Location ("/path") passes through — it stays on Pages.
  }
  // Framing guard on proxied HTML: the console must not be embeddable in
  // another site's iframe (clickjacking). SAMEORIGIN is safe here — nothing
  // in our setup embeds the console cross-origin.
  //
  // Referrer-Policy is part of the qwenpaw-query-token-leak fix: a user can
  // land on a `?token=...` URL (old bookmark, pasted link) and any outbound
  // link click would otherwise send it in the Referer header to a third
  // party. `same-origin` keeps same-origin navigation working and sends
  // nothing cross-origin.
  headers.set("Referrer-Policy", "same-origin");
  const contentType = headers.get("Content-Type") || "";
  if (contentType.includes("text/html")) {
    headers.set("X-Frame-Options", "SAMEORIGIN");
    headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  }
  // If the origin ever sets a Domain on a cookie, strip it so the cookie
  // becomes host-only for the Pages domain instead of the InstaBox host.
  const setCookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (headers.get("Set-Cookie") ? [headers.get("Set-Cookie")] : []);
  if (setCookies.length) {
    headers.delete("Set-Cookie");
    for (const c of setCookies) {
      headers.append("Set-Cookie", c.replace(/;\s*domain=[^;]+/gi, ""));
    }
  }
  return headers;
}

/**
 * The AgentX early shim (rebrand, 2026-11-18).
 *
 * A classic inline <script> injected before </body> (see proxy()). The
 * console bundle is a deferred <script type="module">, so this classic
 * script runs FIRST — that is what makes the two patches win the race:
 *
 *   (a) window.fetch: the console polls https://pypi.org/pypi/qwenpaw/json
 *       hourly and shows "Update Available" / "Update QwenPaw?" when the
 *       version differs. Only that ONE exact URL is answered, with the
 *       pinned version (2.3.0, the digest-pinned image that actually runs),
 *       so the checker always sees "up to date" and never nags. Every
 *       other fetch falls through to the native fetch untouched.
 *   (b) window.open: swallows the two upstream hosts (the docs site and
 *       the upstream GitHub repo) by returning null without opening. Every
 *       other URL falls through to the native window.open untouched.
 *
 * Both patches are wrapped in try/catch and fall through to native on any
 * unmatched or unexpected input — a patch bug must never break a real
 * request. Kill switch: ?rebrand=0 in the page URL skips the whole shim,
 * and the worker env var AGENTX_REBRAND=0 skips emitting it (see proxy()).
 */
function headShim() {
  return `<script>
(function () {
  try {
    var off = false;
    try { off = new URLSearchParams(location.search).get("rebrand") === "0"; } catch (e) {}
    if (off) return;
    var PYPI_URL = ${JSON.stringify(PYPI_QWENPAW_URL)};
    var PINNED_VERSION = ${JSON.stringify(PINNED_QWENPAW_VERSION)};
    var DOC_ORIGIN = ${JSON.stringify(UPSTREAM_DOC_ORIGIN)};
    var GITHUB_URL = ${JSON.stringify(UPSTREAM_GITHUB_URL)};
    try {
      var nativeFetch = window.fetch;
      if (typeof nativeFetch === "function") {
        window.fetch = function (input, init) {
          try {
            var u = typeof input === "string" ? input : (input && input.url) || "";
            if (u === PYPI_URL) {
              return Promise.resolve(new Response(JSON.stringify({ info: { version: PINNED_VERSION } }), { status: 200, headers: { "Content-Type": "application/json" } }));
            }
          } catch (e) {}
          return nativeFetch.apply(this, arguments);
        };
      }
    } catch (e) {}
    try {
      var nativeOpen = window.open;
      if (typeof nativeOpen === "function") {
        window.open = function (url) {
          try {
            var u = String(url || "");
            if (u.indexOf(DOC_ORIGIN) === 0 || u.indexOf(GITHUB_URL) === 0) return null;
          } catch (e) {}
          return nativeOpen.apply(this, arguments);
        };
      }
    } catch (e) {}
  } catch (e) { /* never break the console */ }
})();
</script>`;
}

/**
 * The floating "Computer" launcher injected into the console SPA.
 *
 * History, because it explains the shape: the previous version of this script
 * mounted a preview iframe and called `/desktop/__mode`, `/desktop/__status`
 * and `/desktop/__screen` — endpoints that went away with the computer
 * rebuild. It was deleted along with them, leaving `proxy()` calling a
 * function that no longer existed. That is the second ReferenceError this
 * file had, and neither was caught because nothing ever *loaded* the Worker.
 *
 * This version does one small thing: a button that opens the rebuilt
 * `/computer` surface in a 316 px rail beside the chat, which is what the
 * new UI is designed for (`?embed=1` hides its own stage and overlay).
 * Nothing here reaches into the SPA beyond appending a sibling of #root, so
 * React re-renders cannot remove it. Every failure is swallowed: an
 * injection bug must never break the console.
 */
function computerPanelScript(rebrandEnabled) {
  return `<script>
(function () {
  var AGENTX_REBRAND_ENABLED = ${rebrandEnabled ? "true" : "false"};
  var AGENTX_UPSTREAM_DOC = ${JSON.stringify(UPSTREAM_DOC_ORIGIN)};
  var AGENTX_UPSTREAM_GITHUB = ${JSON.stringify(UPSTREAM_GITHUB_URL)};
  try {
    if (!document.getElementById("root")) return;
    if (document.getElementById("qwenpawComputerBtn")) return;
    // ---- AgentX design tokens + ONE injected stylesheet ----
    // Every element this script adds (sidebar actions menu, account-row
    // rescue, toasts, panel chrome) reads the same --ax-* tokens, so
    // spacing, radius, colour and focus rings stay consistent instead of
    // drifting per element. Prefixed --ax-* so it cannot collide with the
    // console's own custom properties. Injected once, idempotent.
    var BEAUTY_CSS =
      "/* Hallmark · v2.0.0 · theme: AgentX console (custom) · genre modern-minimal · shape: design tokens + sidebar actions menu */" +
      ":root{--ax-bg:#0f1115;--ax-surface:#171a21;--ax-surface-2:#1f2430;--ax-line:#262a33;--ax-line-2:#343945;--ax-ink:#e8eaf0;--ax-muted:#c8d1dc;--ax-faint:#9aa4b2;--ax-accent:#86efac;--ax-danger:#ffb4b4;--ax-radius:12px;--ax-radius-sm:8px;--ax-gap:8px;--ax-font:system-ui,-apple-system,'Segoe UI',sans-serif;scrollbar-color:#3a4150 transparent;}" +
      "html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;}" +
      "button,input,select,textarea{font-family:var(--ax-font);}" +
      ":focus-visible{outline:2px solid var(--ax-accent);outline-offset:2px;}" +
      "::selection{background:var(--ax-accent);color:var(--ax-bg);}" +
      "@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important;}}" +
      // Account-popup machine rows (Computer / Rest machine). They are clones
      // of the Settings row, so they already match the menu's own padding,
      // hover and icon sizing; only STATE styling is added here — a
      // three-channel disabled state (fill, ink, cursor), never opacity alone.
      "[data-qwenpaw-computer-menu][data-active='1']{background:var(--ax-surface-2);color:var(--ax-accent);}" +
      "[data-qwenpaw-rest-menu][disabled],[data-qwenpaw-rest-menu][data-resting='1']{background:var(--ax-bg);color:var(--ax-faint);cursor:default;}" +
      "[data-qwenpaw-rest-menu][disabled]:hover,[data-qwenpaw-rest-menu][data-resting='1']:hover{background:var(--ax-bg);color:var(--ax-faint);}" +
      "[data-qwenpaw-computer-menu] .agentx-menu-label,[data-qwenpaw-rest-menu] .agentx-menu-label{flex:1 1 auto;min-width:0;}" +
      "button[class*='identity']{display:flex;align-items:center;flex-wrap:nowrap;gap:10px;width:100%;box-sizing:border-box;overflow:visible;flex:none;}" +
      "button[class*='identity'] span[class*='identityText']{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;overflow:visible;text-align:left;}" +
      "button[class*='identity'] span[class*='identityText'] > strong{font-size:13px;line-height:1.3;font-weight:600;white-space:nowrap;overflow:visible;text-overflow:clip;max-width:none;}" +
      "button[class*='identity'] span[class*='identityText'] > small{font-size:11px;line-height:1.3;white-space:nowrap;overflow:visible;text-overflow:clip;max-width:none;opacity:.75;}" +
      "[data-agentx-account-row]{display:flex!important;align-items:center;min-height:48px!important;overflow:visible!important;flex:none!important;width:100%;box-sizing:border-box;}" +
      "[data-agentx-identity-text]{display:flex!important;flex-direction:column!important;align-items:flex-start;justify-content:center;gap:2px;overflow:visible!important;min-width:0;flex:1 1 auto;text-align:left;}" +
      "[data-agentx-identity-text] strong,[data-agentx-identity-text] small{overflow:visible!important;text-overflow:clip!important;max-width:none!important;white-space:nowrap;}" +
      "[data-agentx-composer] button,[data-agentx-composer] select{min-height:32px;height:32px;box-sizing:border-box;}" +
      // v7 composer: reinforce the compact one-row layout from CSS (inline
      // styles are dropped on React re-renders; the observer re-applies, and
      // this stylesheet holds the line in between). Icons shrink too — a fat
      // icon inside a pill is a big share of the wide pills' width.
      "[data-agentx-composer-toolbar]{display:flex!important;flex-wrap:wrap!important;gap:8px!important;align-items:center!important;justify-content:flex-start!important;}" +
      "[data-agentx-composer-toolbar] button,[data-agentx-composer-toolbar] select{min-height:32px!important;height:32px!important;padding:2px 6px!important;font-size:11px!important;min-width:0!important;white-space:nowrap!important;flex:0 0 auto!important;margin:0!important;box-sizing:border-box!important;}" +
      "[data-agentx-composer-toolbar] button svg{width:13px!important;height:13px!important;flex:none!important;}" +
      // v9: the textbox takes its OWN full-width line and the structural row
      // wrappers are dissolved. Both are backed from CSS here (not only
      // inline) because React drops inline styles during the cold-load render
      // storm — which is exactly why the one-row layout appeared on reloads
      // but not on the first post-login load. The data attributes persist
      // across re-renders, so the stylesheet holds the layout from the first
      // application onwards.
      "[data-agentx-composer-line]{flex:0 0 100%!important;max-width:100%!important;box-sizing:border-box!important;}" +
      "[data-agentx-composer-flat]{display:contents!important;}" +
      // v9: visible Detection-Rules count badge injected into each card — the
      // counts exist only in the buttons' accessible names, so no CSS unhide
      // can reveal them. Pushed to the card's right, before the chevron.
      "[data-agentx-rule-count]{display:inline-flex!important;align-items:center!important;flex:none!important;margin-left:auto!important;font-size:11px!important;line-height:1.4!important;font-weight:500!important;color:var(--ax-faint)!important;white-space:nowrap!important;font-variant-numeric:tabular-nums;}" +
      // v9: the sidebar is a flex column whose conversation list scrolls
      // within itself, so the identity row stays pinned and visible at the
      // bottom instead of being pushed below the viewport.
      "[data-agentx-sidebar]{display:flex!important;flex-direction:column!important;overflow:hidden!important;min-height:0!important;}" +
      "[data-agentx-sidebar-list]{flex:1 1 auto!important;min-height:0!important;overflow-y:auto!important;}" +
      "[data-agentx-sidebar-foot]{flex:none!important;}" +
      // v37: the settings sidebar's pull-up margin lives in the STYLESHEET
      // (driven by --ax-sidebar-shift, set by JS on <html>), NOT as an
      // inline style on the aside. React re-renders wipe inline styles
      // on elements it manages (L70) - that is why v36's inline margin
      // never stuck on a cold load. A stylesheet rule survives React;
      // <html> is outside React's root so the variable is never wiped.
      "aside.index-module__sidebar__MIhyN{margin-top:var(--ax-sidebar-shift,0px)!important;}" +
      // v10: the small grid-icon button beside the account row rendered
      // cramped (icon crowding its own edges) with a hit area so small it was
      // barely clickable. Give it a real 38px square target with a centred
      // icon, hover state and focus ring so it reads as clickable at 1920x999
      // and at narrow widths.
      // v10/v11: the grid button must read as a REAL button at a glance, not a
      // faint dot cluster. Rohan's screenshot verdict: the glyph was ~15px,
      // faint grey, no surface. Now: a visible pill surface (surface-2 fill +
      // hairline border), a 22px SOLID ink glyph, hover that lifts both, and a
      // focus ring. The account row beside it stays the same size, so the two
      // read as one deliberate control group.
      // v12: the sliders icon lives INSIDE the account pill at its right end
      // (browser-measured x200-210), NOT as a separate button beside it. Style
      // THAT glyph into a visible chip: 20px solid-ink glyph on a 30px
      // surface-2 chip with a hairline border, so it reads as a real control
      // instead of a faint ~10px dot cluster.
      "[data-agentx-grid-icon]{width:20px!important;height:20px!important;padding:5px!important;box-sizing:content-box!important;border-radius:8px!important;background:var(--ax-surface-2)!important;border:1px solid var(--ax-line)!important;color:var(--ax-ink)!important;flex:none!important;transition:background-color .15s ease,border-color .15s ease;}" +
      "[data-agentx-grid-icon],[data-agentx-grid-icon] *{stroke:var(--ax-ink)!important;fill:var(--ax-ink)!important;}" +
      // v13: a VISIBLE border, and a hover that changes the chip when the
      // whole Settings pill is hovered (the chip is only ~30px, so hovering
      // the pill is what a user actually does).
      "[data-agentx-grid-icon]{border:1px solid var(--ax-line-2)!important;box-shadow:0 1px 2px rgba(0,0,0,.25)!important;}" +
      "[data-agentx-account-row]:hover [data-agentx-grid-icon],[data-agentx-grid-icon]:hover{background:var(--ax-line)!important;border-color:var(--ax-accent)!important;}" +
      // v15: keep the pill itself light on hover so only the chip changes -
      // the console's own hover painted the whole (previously full-width) bar
      // black, which read as a broken strip.
      "[data-agentx-account-row]:hover{background:var(--ax-surface-2)!important;color:var(--ax-ink)!important;}" +
      // v13: the ':has()' composer flatten never matched the live DOM. The
      // merge is now done by DOM manipulation (mergeComposerRows) - the row
      // containers are found from the visible control labels and their
      // children are physically moved into one container.
      // Same for the sidebar icon lift - now tagged from JS.
      // Same cramped-icon problem on the sidebar's small action icons (the
      // 'Last 7 days' collapse / open-in-new pair rendered ~12-15px). Lift
      // every sidebar icon button's glyph to a legible size and a readable
      // colour. Additive only - larger icons are untouched.
      // v13: sidebar icon glyphs are lifted via the data-agentx-icon-btn tag
      // (see above); no ':has()' selector here.
      "[data-agentx-icon-btn] svg{min-width:18px!important;min-height:18px!important;color:var(--ax-muted)!important;}" +
      // v10 looks pass - SIDEBAR. Consistent motion + a clear hover/focus
      // affordance on every interactive element in the sidebar (nav items,
      // conversation rows, identity row, grid button). PURELY VISUAL: no
      // control, option, menu entry or setting is removed, hidden, merged or
      // renamed (v1 lesson: beautiful, not removed). Deliberately no
      // !important here so the console's own active/selected states win.
      "[data-agentx-sidebar] button,[data-agentx-sidebar] a{transition:background-color .15s ease,color .15s ease;}" +
      "[data-agentx-sidebar] button:hover,[data-agentx-sidebar] a:hover{background:var(--ax-surface-2);}" +
      "[data-agentx-sidebar] button:focus-visible,[data-agentx-sidebar] a:focus-visible{outline:2px solid var(--ax-accent);outline-offset:2px;}" +
      // v11 BUG-HUNT [L]: tiny hit targets. Icon-only buttons (? help, eye /
      // shield / trash / pencil actions, card '...' menus, scanner actions)
      // rendered ~14px - far below a comfortable target. Give every button
      // that contains an icon a 30px floor. Purely additive: buttons that are
      // already larger (composer 32px, grid button 38px) are unaffected.
      // v13: icon-button hit-target floor. NOTE: this is applied by TAGGING
      // from JS (data-agentx-icon-btn), not by ':has()', because the target
      // browser does not reliably support ':has()' - the v11 ':has()' rules
      // silently never matched the live DOM.
      "[data-agentx-icon-btn]{min-width:30px!important;min-height:30px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;box-sizing:border-box!important;}" +
      // v17: the cold-open Thinking option list stays hidden until the user
      // engages the Thinking control.
      "[data-agentx-thinking-closed]{display:none!important;}" +
      // v19 (reverse-engineered 2026-11-20 from the LIVE console bundles -
      // GeneralSettings-1TjWEnww.js, index.module-CQaYZsT2.js,
      // thinking.module-DvpiN7Dn.js - not from screenshots): the Settings
      // rows are flex rows in the DOM already; they only LOOK stacked
      // because the row wraps. The theme bars are a ROW of three buttons,
      // each a COLUMN (preview on top, label below); v17/v18 set the
      // container to a column, which stacked the bars vertically. Never
      // restructure, never hide - stop the wrap, use the real classes.
      ".GeneralSettings-module__settingRow__omDrI,.index-module__settingRow__tmx4d{display:flex!important;flex-wrap:nowrap!important;align-items:center!important;gap:12px!important;}" +
      ".index-module__settingIcon__jpeXm{flex:none!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;width:36px!important;height:36px!important;color:#1a1d21!important;}" +
      ".index-module__settingIcon__jpeXm svg{width:18px!important;height:18px!important;min-width:18px!important;min-height:18px!important;color:#1a1d21!important;opacity:1!important;}" +
      ".index-module__settingIcon__jpeXm svg *{fill:currentColor!important;stroke:currentColor!important;}" +
      ".index-module__settingCopy__cosTh{min-width:0!important;flex:1 1 auto!important;}" +
      ".index-module__settingControl__BqRNs{flex:none!important;margin-left:auto!important;}" +
      ".NotificationSettings-module__row__fViqL{display:flex!important;flex-wrap:nowrap!important;align-items:center!important;gap:12px!important;}" +
      ".NotificationSettings-module__copy__--Hih{min-width:0!important;flex:1 1 auto!important;}" +
      ".NotificationSettings-module__control__E3-4e{flex:none!important;margin-left:auto!important;}" +
      ".NotificationSettings-module__icon__cgf0w{flex:none!important;}" +
      ".GeneralSettings-module__appearanceChoices__mYTAt{display:flex!important;flex-direction:row!important;gap:12px!important;align-items:stretch!important;}" +
      ".GeneralSettings-module__appearanceChoice__Qcw7e{display:flex!important;flex-direction:column!important;gap:8px!important;min-height:110px!important;padding:10px!important;align-items:stretch!important;}" +
      ".GeneralSettings-module__miniWindow__n7mMQ{height:52px!important;min-height:52px!important;flex:none!important;}" +
      ".GeneralSettings-module__modeLabel__f4mmp{display:flex!important;align-items:center!important;gap:6px!important;font-size:13px!important;line-height:18px!important;white-space:nowrap!important;color:#1a1d21!important;}" +
      // v18 [9]: the composer placeholder must stay on ONE left-aligned line,
      // including right after navigation (it wrapped to three centred lines).
      "textarea::placeholder,[contenteditable='true']::placeholder{text-align:left!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;opacity:1!important;}" +
      ".agentx-unclip{white-space:normal!important;text-overflow:clip!important;overflow-wrap:break-word!important;word-break:break-word!important;-webkit-line-clamp:none!important;}" +
      // System theme preview (v6): the slanted light/dark boundary is drawn by
      // a gradient/clip on the card or one of its (pseudo-)children. Inline
      // styles cannot reach ::before/::after, so the card is tagged with
      // data-agentx-system-card and the split is enforced here. Only
      // background-IMAGES and clips are stripped — the grey preview lines and
      // the orange bar are background-COLOURS and survive, so the bar reads as
      // one solid orange bar across both halves instead of being bisected.
      "[data-agentx-system-card]{background-image:none!important;clip-path:none!important;}" +
      "[data-agentx-system-card]::before,[data-agentx-system-card]::after{background-image:none!important;clip-path:none!important;}" +
      // v30: DETECTION RULES counts - CSS, not DOM injection. The card is a
      // React/Framer-Motion button whose count is an ANIMATED number: React
      // re-renders the button on every animation frame and its
      // reconciliation REMOVES any injected child (my badge) and RESETS the
      // button's inline style to the JSX prop ({borderRadius:18}), wiping
      // my position:relative/overflow:visible (v26-v29: badgeEx:0, card
      // still static/hidden at every probe). A stylesheet rule cannot be
      // wiped by React, so force the card and its own count/meter/caption
      // open with !important CSS. The console's own count IS a proper
      // block (span.count, 32px) - it only needs the 32px/overflow:hidden
      // clamp lifted.
      // v33 (2026-11-20): ALL RuleTable rules REMOVED. The ?rebrand=0
      // control test proved the console renders these cards CORRECTLY on
      // its own (~177px tall, big count + "/ n" + Enabled + orange meter
      // all inside, no overlap) and OUR injection was collapsing them to
      // ~73px with the counts spilling onto the next row. The v30 CSS
      // (height:auto + min-height:170px + overflow:visible + the
      // position:static child rules) and the addRuleCountBadges JS were
      // the breakage, not the fix. Do NOT re-add RuleTable overrides:
      // the native render is the correct one. (L73.)
      "[data-agentx-system-preview]{background-image:linear-gradient(90deg,#f5f5f4 0%,#f5f5f4 50%,#111 50%,#111 100%)!important;background-color:transparent!important;clip-path:none!important;overflow:hidden!important;}" +
      "[data-agentx-system-preview]::before,[data-agentx-system-preview]::after,[data-agentx-system-preview] *::before,[data-agentx-system-preview] *::after{background-image:none!important;clip-path:none!important;}";
    var ICON_COMPUTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="19" height="13" rx="2"></rect><path d="M8.5 20.5h7M12 17v3.5"></path></svg>';
    var ICON_REST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.8 6.8 0 0 0 9.7 9.7z"></path></svg>';
    var ICON_VAULT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="11" width="17" height="10" rx="2"></rect><path d="M7.5 11V7.5a4.5 4.5 0 0 1 9 0V11"></path></svg>';
    var ICON_DOTS = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5.5" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><circle cx="12" cy="18.5" r="1.5"></circle></svg>';
    var ICON_CARET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 9.5l5.5 5.5 5.5-5.5"></path></svg>';
    function injectBeautyStyle() {
      if (document.getElementById("agentxBeautyStyle")) return;
      var s = document.createElement("style");
      s.id = "agentxBeautyStyle";
      s.textContent = BEAUTY_CSS;
      (document.head || document.documentElement).appendChild(s);
    }
    function setActionLabel(b, text) {
      var l = b.querySelector ? b.querySelector(".agentx-action-label") : null;
      if (l) l.textContent = text; else b.textContent = text;
    }
    injectBeautyStyle();

    // ---- The machine actions live in the console's OWN account popup ----
    // Rohan, 2026-11-20: the Computer / Rest machine buttons belong in the
    // account menu that opens from the sidebar's account row (the menu with
    // Avatar manager, Appearance, Message display, Settings, Vault, About,
    // Account, Logout) — NOT in a separate sidebar pill and NOT as floating
    // bottom-right pills (both were tried and rejected). Vault is already
    // that menu's own entry, so ONLY Computer and Rest machine are added,
    // cloned from the Settings row by addAccountMenuActions() so they
    // inherit its exact padding, hover and icon sizing. There are no
    // persistent button elements here any more: React rebuilds that menu on
    // every open, so the entries are re-created then, carrying the ids
    // qwenpawComputerBtn / qwenpawRestBtn so the handlers below keep working.

    // NO in-chat Computer drawer (Rohan v5): the old right-hand panel
    // (qwenpawComputerPanel + its iframe + close button) is gone entirely —
    // it was the SECOND side screen he flagged (left sidebar + right drawer).
    // The Computer row in the account popup now NAVIGATES to /computer.

    // ---- Vault add-key popup (in-chat) ----
    // The Vault button and the Vault menu item open a secure box right in
    // the chat — the connector-popup pattern — instead of navigating away
    // to /vault. The form posts to the same /vault/put endpoint the /vault
    // page uses, with the same session handling (ensureSession + 401
    // retry). The value lives only in the password input and is wiped on
    // close and after a save. The full /vault page stays one click away
    // (the "Open the full Vault page" link) for managing existing keys.
    var vaultPopupEl = null;
    function vaultPopupToken() {
      try {
        var v = localStorage.getItem("qwenpaw_auth_token");
        if (v && v.length > 8) return v;
      } catch (e) {}
      return consoleToken();
    }
    async function vaultPopupEnsureSession() {
      try {
        var already = await fetch("/api/session/state", { cache: "no-store", credentials: "same-origin" });
        var st = await already.json().catch(function () { return {}; });
        if (st && st.ok) return true;
      } catch (e) {}
      var token = vaultPopupToken();
      if (!token) return false;
      try {
        var res = await fetch("/api/session/mint", {
          method: "POST",
          headers: { Authorization: "Bearer " + token },
          credentials: "same-origin",
          cache: "no-store",
        });
        return res.ok;
      } catch (e) { return false; }
    }
    async function vaultPopupApi(body) {
      var doFetch = function () {
        return fetch("/vault/put", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: "same-origin",
          cache: "no-store",
        });
      };
      var res = await doFetch();
      if (res.status === 401) {
        var ok = await vaultPopupEnsureSession();
        if (ok) res = await doFetch();
      }
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { ok: res.ok, status: res.status, data: data };
    }
    function vaultPopupSyncKind() {
      var kind = document.getElementById("qwenpawVaultPopupKind").value;
      document.getElementById("qwenpawVaultPopupOriginRow").style.display = kind === "command" ? "none" : "";
      document.getElementById("qwenpawVaultPopupHeaderRow").style.display = kind === "header" ? "" : "none";
      document.getElementById("qwenpawVaultPopupUserRow").style.display = kind === "basic" ? "" : "none";
      document.getElementById("qwenpawVaultPopupOrigin").required = kind !== "command";
    }
    // ---- Vault provider presets ----
    // Picking a provider fills in the kind, the origin and the header name
    // (and suggests a name and a title when those are still empty), so
    // adding a key is just: pick a provider, type a name, paste the key.
    // "Custom" is the default and leaves every field alone, for a
    // provider that is not listed. Pasting an origin that matches a
    // preset picks that provider by itself. The same list lives in
    // pages/public/vault/vault.js for the /vault page — keep them in
    // sync. Origins are bare origins (no path): the router pins the key
    // to exactly this origin. Providers that need an extra header the
    // request endpoint cannot send yet (Anthropic needs anthropic-version,
    // Notion needs Notion-Version, Linear uses a bare key, not Bearer)
    // are deliberately NOT listed — use Custom for those for now.
    var VAULT_PROVIDER_PRESETS = [
      { key: "custom", label: "Custom — enter the details yourself", kind: "", origin: "", headerName: "", name: "", title: "" },
      { key: "cloudflare", label: "Cloudflare", kind: "bearer", origin: "https://api.cloudflare.com", headerName: "", name: "cloudflare", title: "Cloudflare API token" },
      { key: "deepseek", label: "DeepSeek", kind: "bearer", origin: "https://api.deepseek.com", headerName: "", name: "deepseek", title: "DeepSeek API key" },
      { key: "github", label: "GitHub", kind: "bearer", origin: "https://api.github.com", headerName: "", name: "github", title: "GitHub personal access token" },
      { key: "gemini", label: "Google Gemini", kind: "header", origin: "https://generativelanguage.googleapis.com", headerName: "x-goog-api-key", name: "gemini", title: "Google Gemini API key" },
      { key: "groq", label: "Groq", kind: "bearer", origin: "https://api.groq.com", headerName: "", name: "groq", title: "Groq API key" },
      { key: "huggingface", label: "Hugging Face", kind: "bearer", origin: "https://huggingface.co", headerName: "", name: "huggingface", title: "Hugging Face token" },
      { key: "mistral", label: "Mistral", kind: "bearer", origin: "https://api.mistral.ai", headerName: "", name: "mistral", title: "Mistral API key" },
      { key: "openai", label: "OpenAI", kind: "bearer", origin: "https://api.openai.com", headerName: "", name: "openai", title: "OpenAI API key" },
      { key: "openrouter", label: "OpenRouter", kind: "bearer", origin: "https://openrouter.ai", headerName: "", name: "openrouter", title: "OpenRouter API key" },
      { key: "slack", label: "Slack", kind: "bearer", origin: "https://slack.com", headerName: "", name: "slack", title: "Slack bot token" },
      { key: "xai", label: "xAI", kind: "bearer", origin: "https://api.x.ai", headerName: "", name: "xai", title: "xAI API key" },
    ];
    function vaultPopupFindPreset(key) {
      for (var i = 0; i < VAULT_PROVIDER_PRESETS.length; i++) {
        if (VAULT_PROVIDER_PRESETS[i].key === key) return VAULT_PROVIDER_PRESETS[i];
      }
      return null;
    }
    function vaultPopupFindPresetByOrigin(origin) {
      var o = (origin || "").trim().toLowerCase();
      if (!o) return null;
      for (var i = 0; i < VAULT_PROVIDER_PRESETS.length; i++) {
        var p = VAULT_PROVIDER_PRESETS[i];
        if (p.origin && p.origin.toLowerCase() === o) return p;
      }
      return null;
    }
    function vaultPopupApplyProvider() {
      var sel = document.getElementById("qwenpawVaultPopupProvider");
      var p = vaultPopupFindPreset(sel.value);
      if (!p || p.key === "custom") return;
      document.getElementById("qwenpawVaultPopupKind").value = p.kind;
      document.getElementById("qwenpawVaultPopupOrigin").value = p.origin;
      if (p.kind === "header") document.getElementById("qwenpawVaultPopupHeader").value = p.headerName;
      var nameEl = document.getElementById("qwenpawVaultPopupName");
      if (!nameEl.value.trim() && p.name) nameEl.value = p.name;
      var titleEl = document.getElementById("qwenpawVaultPopupTitle");
      if (!titleEl.value.trim() && p.title) titleEl.value = p.title;
      vaultPopupSyncKind();
    }
    function vaultPopupDetectProvider() {
      var origin = document.getElementById("qwenpawVaultPopupOrigin").value;
      var p = vaultPopupFindPresetByOrigin(origin);
      var sel = document.getElementById("qwenpawVaultPopupProvider");
      if (p && sel.value !== p.key) {
        sel.value = p.key;
        vaultPopupApplyProvider();
      } else if (!p && sel.value !== "custom") {
        sel.value = "custom";
      }
    }
    function closeVaultPopup() {
      if (!vaultPopupEl) return;
      try {
        var v = document.getElementById("qwenpawVaultPopupValue");
        if (v) v.value = "";
      } catch (e) {}
      vaultPopupEl.style.display = "none";
    }
    async function vaultPopupSave() {
      var msg = document.getElementById("qwenpawVaultPopupMsg");
      var name = document.getElementById("qwenpawVaultPopupName").value.trim();
      var kind = document.getElementById("qwenpawVaultPopupKind").value;
      var value = document.getElementById("qwenpawVaultPopupValue").value;
      msg.style.color = "#b91c1c";
      msg.textContent = "";
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
        msg.textContent = "Name must start with a lowercase letter and use only a-z, 0-9, - and _ (up to 64 chars).";
        return;
      }
      if (!value) { msg.textContent = "Paste the key value."; return; }
      var body = {
        name: name, kind: kind,
        origin: kind === "command" ? undefined : document.getElementById("qwenpawVaultPopupOrigin").value.trim(),
        headerName: kind === "header" ? document.getElementById("qwenpawVaultPopupHeader").value.trim() : undefined,
        username: kind === "basic" ? document.getElementById("qwenpawVaultPopupUser").value.trim() : undefined,
        value: value,
        title: document.getElementById("qwenpawVaultPopupTitle").value.trim(),
        note: document.getElementById("qwenpawVaultPopupNote").value.trim(),
      };
      var saveBtn = document.getElementById("qwenpawVaultPopupSave");
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        var r = await vaultPopupApi(body);
        if (!r.ok) {
          var detail = r.data && r.data.error ? r.data.error : "";
          if (r.data && r.data.detail) detail += " — " + r.data.detail;
          msg.textContent = "Could not save (" + r.status + (detail ? ": " + detail : "") + ").";
          return;
        }
        msg.style.color = "#15803d";
        msg.textContent = "Saved " + name + ". The agent can use it now.";
        document.getElementById("qwenpawVaultPopupValue").value = "";
        setTimeout(function () { closeVaultPopup(); }, 1200);
      } catch (e) {
        msg.textContent = "Could not reach the server — check your connection and retry.";
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save key";
      }
    }
    function openVaultPopup() {
      try {
        if (!vaultPopupEl) {
          var back = document.createElement("div");
          back.id = "qwenpawVaultPopup";
          back.setAttribute("data-qwenpaw-vault-popup", "1");
          back.style.cssText = "position:fixed;inset:0;background:rgba(15,17,21,0.55);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;";
          back.innerHTML =
            '<div style="background:#fff;border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,0.35);width:min(480px,92vw);max-height:90vh;overflow:auto;padding:24px;font-family:system-ui,sans-serif;color:#1a1d24;">' +
            '<h2 style="margin:0 0 4px;font-size:18px;">Add a key to the Vault</h2>' +
            '<p style="margin:0 0 16px;font-size:13px;color:#5b6470;">Keys the agent can use but never see. The value is sealed on the server and never shown again.</p>' +
            '<label style="display:block;font-size:13px;margin-bottom:10px;">Provider<br><select id="qwenpawVaultPopupProvider" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></select></label>' +
            '<label style="display:block;font-size:13px;margin-bottom:10px;">Name<br><input id="qwenpawVaultPopupName" type="text" placeholder="e.g. github-main" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<label style="display:block;font-size:13px;margin-bottom:10px;">Kind<br><select id="qwenpawVaultPopupKind" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"><option value="bearer">API key (Authorization: Bearer)</option><option value="header">Custom header</option><option value="basic">Username + password</option><option value="command">Command / CLI env var</option></select></label>' +
            '<label id="qwenpawVaultPopupOriginRow" style="display:block;font-size:13px;margin-bottom:10px;">Origin<br><input id="qwenpawVaultPopupOrigin" type="text" placeholder="https://api.github.com" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<label id="qwenpawVaultPopupHeaderRow" style="display:none;font-size:13px;margin-bottom:10px;">Header name<br><input id="qwenpawVaultPopupHeader" type="text" placeholder="X-Api-Key" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<label id="qwenpawVaultPopupUserRow" style="display:none;font-size:13px;margin-bottom:10px;">Username<br><input id="qwenpawVaultPopupUser" type="text" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<label style="display:block;font-size:13px;margin-bottom:10px;">Value<br><input id="qwenpawVaultPopupValue" type="password" autocomplete="off" placeholder="Paste the key here" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<label style="display:block;font-size:13px;margin-bottom:10px;">Title (optional)<br><input id="qwenpawVaultPopupTitle" type="text" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<label style="display:block;font-size:13px;margin-bottom:14px;">Note (optional)<br><input id="qwenpawVaultPopupNote" type="text" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d9e0;border-radius:8px;font-size:14px;margin-top:4px;"></label>' +
            '<div id="qwenpawVaultPopupMsg" style="font-size:13px;min-height:18px;margin-bottom:10px;"></div>' +
            '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
            '<button id="qwenpawVaultPopupSave" type="button" style="background:#f97316;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;">Save key</button>' +
            '<button id="qwenpawVaultPopupCancel" type="button" style="background:#f1f2f4;color:#1a1d24;border:none;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer;">Cancel</button>' +
            '<a id="qwenpawVaultPopupOpen" href="#" style="font-size:13px;color:#2563eb;">Open the full Vault page</a>' +
            '</div></div>';
          document.body.appendChild(back);
          vaultPopupEl = back;
          back.addEventListener("click", function (e) { if (e.target === back) closeVaultPopup(); });
          document.getElementById("qwenpawVaultPopupKind").addEventListener("change", vaultPopupSyncKind);
          // Populate the provider select from the preset list (kept in
          // sync with the /vault page) and wire autofill + auto-detect.
          var provSel = document.getElementById("qwenpawVaultPopupProvider");
          for (var pi = 0; pi < VAULT_PROVIDER_PRESETS.length; pi++) {
            var opt = document.createElement("option");
            opt.value = VAULT_PROVIDER_PRESETS[pi].key;
            opt.textContent = VAULT_PROVIDER_PRESETS[pi].label;
            provSel.appendChild(opt);
          }
          provSel.value = "custom";
          provSel.addEventListener("change", vaultPopupApplyProvider);
          document.getElementById("qwenpawVaultPopupOrigin").addEventListener("input", vaultPopupDetectProvider);
          document.getElementById("qwenpawVaultPopupSave").addEventListener("click", vaultPopupSave);
          document.getElementById("qwenpawVaultPopupCancel").addEventListener("click", closeVaultPopup);
          document.getElementById("qwenpawVaultPopupOpen").addEventListener("click", function (e) {
            e.preventDefault();
            window.open("/vault", "_blank", "noopener");
          });
          document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && vaultPopupEl && vaultPopupEl.style.display !== "none") closeVaultPopup();
          });
        }
        document.getElementById("qwenpawVaultPopupMsg").textContent = "";
        document.getElementById("qwenpawVaultPopupMsg").style.color = "#b91c1c";
        vaultPopupEl.style.display = "flex";
        vaultPopupSyncKind();
        document.getElementById("qwenpawVaultPopupName").focus();
      } catch (e) { /* never break the console */ }
    }

    // ---- rest button behaviour ----
    // The console keeps its session token in localStorage; read it directly
    // rather than scraping a header, so this works on any console page.
    function consoleToken() {
      try {
        var keys = ["token", "qwenpaw_token", "qwenpaw-token", "access_token"];
        for (var i = 0; i < keys.length; i++) {
          var v = localStorage.getItem(keys[i]);
          if (v && v.length > 8) return v;
        }
        // Some builds store a JSON blob.
        for (var j = 0; j < localStorage.length; j++) {
          var k = localStorage.key(j);
          var raw = localStorage.getItem(k);
          if (!raw || raw.length < 8) continue;
          try {
            var o = JSON.parse(raw);
            if (o && typeof o === "object") {
              var t = o.token || o.access_token || o.accessToken;
              if (typeof t === "string" && t.length > 8) return t;
            }
          } catch (e) { /* not JSON */ }
        }
      } catch (e) { /* storage blocked */ }
      return "";
    }

    var resting = false;
    function restEntry() {
      try { return document.querySelector("[data-qwenpaw-rest-menu]"); } catch (e) { return null; }
    }
    function computerEntry() {
      try { return document.querySelector("[data-qwenpaw-computer-menu]"); } catch (e) { return null; }
    }
    function setMenuLabel(entry, text) {
      if (!entry) return;
      var l = entry.querySelector(".agentx-menu-label");
      if (l) { l.textContent = text; return; }
      setActionLabel(entry, text);
    }
    function paintRest() {
      // The Rest entry lives in the account popup; React rebuilds that menu
      // on every open, so query it fresh instead of holding an element.
      var e = restEntry();
      if (!e) return;
      setMenuLabel(e, resting ? "Resting" : "Rest machine");
      // Disabled state is carried by the [disabled] attribute + the CSS
      // three-channel rule (fill, ink, cursor) — never opacity alone.
      e.disabled = resting;
      if (resting) e.setAttribute("data-resting", "1"); else e.removeAttribute("data-resting");
    }
    function toastRest(text, bad) {
      var t = document.createElement("div");
      t.textContent = text;
      t.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;"
        + "background:" + (bad ? "#3a1d22" : "#1b2130") + ";border:1px solid " + (bad ? "#5a2a31" : "#2a3346")
        + ";color:" + (bad ? "#ffb4b4" : "#e8eaf0") + ";border-radius:10px;padding:10px 16px;"
        + "font:600 13px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:80vw;";
      document.body.appendChild(t);
      setTimeout(function () { try { t.remove(); } catch (e) {} }, 6000);
    }
    async function doRest() {
      if (resting) return;
      if (!window.confirm("Send the machine to rest? Open the site again to wake it.")) return;
      var entry = restEntry();
      setMenuLabel(entry, "Resting…");
      if (entry) entry.disabled = true;
      try {
        var tok = consoleToken();
        var r = await fetch("/api/machine/rest", {
          method: "POST",
          headers: tok ? { Authorization: "Bearer " + tok } : {},
        });
        var j = null;
        try { j = await r.json(); } catch (e) { j = null; }
        if (r.ok && j && j.ok) {
          resting = true;
          paintRest();
          toastRest(j.message || "Machine resting — open the site again to wake it.");
          return;
        }
        // Every refusal has a reason worth showing; guess nothing.
        var why = (j && (j.error || j.detail)) || ("HTTP " + r.status);
        if (j && j.error === "auth_required") why = "Sign in to the console first, then rest the machine.";
        if (j && j.error === "instabox_api_key_unset") why = "Rest is not configured yet (INSTABOX_API_KEY missing).";
        if (j && j.error === "machine_not_running") why = "The machine is already paused.";
        toastRest(String(why), true);
        paintRest();
      } catch (e) {
        toastRest("Could not reach the machine: " + (e && e.message ? e.message : "network"), true);
        paintRest();
      }
    }
    // Reflect an existing rest on load, so a page reload does not offer to rest
    // a machine that is already resting.
    (async function initRest() {
      try {
        var r = await fetch("/api/machine/state");
        var j = await r.json();
        resting = !!(j && j.resting);
        paintRest();
      } catch (e) { /* leave the default label */ }
    })();

    // NO drawer state any more: there is no panel to open/close, so the old
    // open/setOpen/sessionStorage machinery and the panel close button are
    // removed with it.

    // ---- Sidebar mounting + account-row rescue ----
    // Both are idempotent and re-run from the observer, because React
    // re-renders can drop injected nodes at any time.

    // The sidebar is the NAV/ASIDE column (~280px wide). Prefer the semantic
    // tag with a width gate; fall back to the element holding the
    // conversation-history heading (the same walk the sidebar-ellipsis rule
    // uses).
    function findSidebarEl() {
      try {
        var cands = document.querySelectorAll("nav, aside");
        for (var i = 0; i < cands.length; i++) {
          var r = cands[i].getBoundingClientRect();
          if (r.width > 150 && r.width < 420 && r.height > 300) return cands[i];
        }
      } catch (e) {}
      try {
        var all = document.querySelectorAll("*");
        for (var j = 0; j < all.length; j++) {
          if ((all[j].textContent || "").indexOf("Conversation History") !== -1) {
            var n = all[j];
            for (var d = 0; d < 6 && n; d++) {
              var tag = (n.tagName || "").toUpperCase();
              if (tag === "NAV" || tag === "ASIDE" || tag === "SECTION") return n;
              n = n.parentElement;
            }
            return all[j].parentElement;
          }
        }
      } catch (e) {}
      return null;
    }

    // (paintComputerRow was removed in v5: it only marked the Computer row
    // active while the in-chat drawer was open, and there is no drawer now.)

    // Icon INNER shapes for the account-menu rows (the svg element is cloned
    // from the Settings row, so only the shapes are swapped in).
    var ICON_COMPUTER_PATHS = '<rect x="2.5" y="4" width="19" height="13" rx="2"></rect><path d="M8.5 20.5h7M12 17v3.5"></path>';
    var ICON_REST_PATHS = '<path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.8 6.8 0 0 0 9.7 9.7z"></path>';

    // ---- Computer / Rest machine entries in the console's account popup ----
    // Rohan, 2026-11-20: these belong in the account menu that opens from the
    // sidebar's account row — the SAME menu that already holds Avatar
    // manager, Appearance, Message display, Settings, Vault, About AgentX,
    // Account and Logout. Vault is already that menu's own row (added by
    // addVaultMenuItem), so ONLY Computer and Rest machine are added here,
    // cloned from the Settings row so they inherit its exact padding, hover
    // and icon sizing. React rebuilds the popup on every open, so this runs
    // again each time it appears (idempotent per marker attribute).
    function addAccountMenuActions() {
      try {
        var dialog = findSettingsDialog();
        if (!dialog) return;
        var buttons = dialog.querySelectorAll("button");
        var settingsBtn = null;
        for (var i = 0; i < buttons.length; i++) {
          if ((buttons[i].textContent || "").trim() === "Settings") { settingsBtn = buttons[i]; break; }
        }
        if (!settingsBtn) return;
        // Insert AFTER the menu's own Vault row so the order reads
        // Settings, Vault, Computer, Rest machine, About, Account, Logout.
        // ORDER FIX (v5): both rows used to be inserted after the SAME Vault
        // row, so the second insert (Rest machine) landed BEFORE the first
        // (Computer) and the live order read Vault, Rest machine, Computer.
        // Insert Computer after Vault, then Rest machine after Computer, so
        // the popup reads Settings, Vault, Computer, Rest machine, About.
        var vaultRow = dialog.querySelector("[data-qwenpaw-vault-menu]") || settingsBtn;
        var computerRow = addMenuEntry(dialog, settingsBtn, vaultRow, "qwenpawComputerBtn", "data-qwenpaw-computer-menu",
          "Computer", ICON_COMPUTER_PATHS, function () {
            // Close the popup first, exactly like a native menu choice would.
            try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch (e) {}
            // Rohan v5: Computer must NAVIGATE to the /computer page, not
            // open the in-chat drawer (that drawer was the second side screen).
            window.location.assign("/computer");
          });
        addMenuEntry(dialog, settingsBtn, computerRow || vaultRow, "qwenpawRestBtn", "data-qwenpaw-rest-menu",
          "Rest machine", ICON_REST_PATHS, function () {
            try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch (e) {}
            doRest();
          });
        paintRest();
      } catch (e) { /* never break the console */ }
    }

    // One account-menu row, cloned from the Settings row so it matches the
    // menu's own padding, hover and icon sizing exactly. Idempotent per
    // marker attribute; carries the requested id so the existing handlers
    // keep working. The label is normalised into a <span class="agentx-menu-label">
    // so the resting-state repaint can retext it without re-cloning.
    function addMenuEntry(dialog, templateBtn, insertAfter, id, marker, label, iconPaths, onClick) {
      try {
        var existing = dialog.querySelector("[" + marker + "]");
        if (existing) return existing;
        var item = templateBtn.cloneNode(true);
        item.setAttribute(marker, "1");
        item.id = id;
        item.type = "button";
        // Drop any id carried over from the cloned row's children — a
        // duplicate id inside the popup would make getElementById ambiguous.
        var withIds = item.querySelectorAll("[id]");
        for (var i = 0; i < withIds.length; i++) withIds[i].removeAttribute("id");
        var svg = item.querySelector("svg");
        if (svg) {
          svg.setAttribute("viewBox", "0 0 24 24");
          svg.setAttribute("fill", "none");
          svg.setAttribute("stroke", "currentColor");
          svg.innerHTML = iconPaths;
        }
        // Relabel: find where the template's own label text lives (a bare
        // text node or a child element) and normalise it into a span.
        var templateLabel = (templateBtn.textContent || "").trim();
        var labelEl = null;
        for (var j = 0; j < item.childNodes.length && !labelEl; j++) {
          var nd = item.childNodes[j];
          if (nd.nodeType === 3 && (nd.textContent || "").trim() === templateLabel) {
            labelEl = document.createElement("span");
            labelEl.className = "agentx-menu-label";
            nd.parentNode.replaceChild(labelEl, nd);
          }
        }
        if (!labelEl) {
          var kids = item.querySelectorAll("*");
          for (var k = 0; k < kids.length && !labelEl; k++) {
            if ((kids[k].textContent || "").trim() === templateLabel && !(kids[k].querySelector && kids[k].querySelector("svg"))) {
              labelEl = kids[k];
              if (labelEl.classList) labelEl.classList.add("agentx-menu-label");
            }
          }
        }
        if (!labelEl) return;
        labelEl.textContent = label;
        item.addEventListener("click", onClick);
        if (insertAfter && insertAfter.parentNode) {
          insertAfter.parentNode.insertBefore(item, insertAfter.nextSibling);
        } else {
          dialog.appendChild(item);
        }
        return item;
      } catch (e) { /* never break the console */ }
    }

    // (The old addSidebarActions() — the left-sidebar "More actions" pill —
    // was removed by Rohan's 2026-11-20 direction: the machine actions now
    // live in the console's own account popup instead.)

    // The sidebar footer is a <button> holding the avatar, the "satwik"
    // name, the "Console account" subtitle and a settings icon. When the
    // sidebar runs out of vertical room the text block renders BELOW the
    // viewport (the avatar is visible, the name is not), and because the
    // footer is pinned, scrolling never reveals it. Fix: make the sidebar a
    // flex column that reserves room for the footer, and make the row a
    // compact single line that cannot overflow or clip.
    // v9: the identity row lives at the BOTTOM of the sidebar. The
    // conversation list above it must scroll within its own area, or its
    // min-height:auto content height pushes the row below the viewport (live
    // v8 check: the sidebar ended at 'Last 7 days' and the row sat below the
    // fold). Classic flexbox fix: the sidebar becomes a flex column, the list
    // is the scrolling child (flex:1 + min-height:0 + overflow-y:auto), and
    // the footer stays flex:none so the row is always visible at the bottom.
    // The earlier walk only constrained ancestors that ALREADY had
    // overflowY:auto — the list had none, so it never shrank. Identifying the
    // list explicitly (tallest non-footer child) is what was missing.
    function fixSidebarScroll(row) {
      try {
        var side = row.parentElement, hops = 0;
        while (side && side !== document.body && hops < 8) {
          var rc = null; try { rc = side.getBoundingClientRect(); } catch (e1) {}
          if (rc && rc.height > 700 && rc.width > 150 && rc.width < 460) break;
          side = side.parentElement; hops++;
        }
        if (!side || side === document.body) return;
        side.setAttribute("data-agentx-sidebar", "1");
        // v11: the sidebar itself must FIT the viewport. Pin it to the top and
        // make it exactly viewport-height so its content cannot push the
        // identity row below the fold; only the conversation list scrolls
        // (below), and the flex:none footer stays visible at the bottom.
        side.style.setProperty("position", "sticky", "important");
        side.style.setProperty("top", "0", "important");
        side.style.setProperty("height", "100vh", "important");
        side.style.setProperty("max-height", "100vh", "important");
        side.style.setProperty("align-self", "flex-start", "important");
        // v12: the sidebar must SCROLL (not clip). overflow:hidden clipped the
        // footer to a sliver; overflow-y:auto plus the sticky footer below
        // keeps the identity row visible at the bottom while the history
        // scrolls above it.
        side.style.setProperty("overflow-y", "auto", "important");
        side.style.setProperty("overflow-x", "hidden", "important");
        side.style.setProperty("display", "flex", "important");
        side.style.setProperty("flex-direction", "column", "important");
        side.style.setProperty("min-height", "0", "important");
        var foot = row;
        while (foot && foot.parentElement && foot.parentElement !== side) {
          foot = foot.parentElement;
        }
        if (!foot || foot === side || foot.parentElement !== side) return;
        foot.setAttribute("data-agentx-sidebar-foot", "1");
        // Keep the identity row and the grid-icon button on ONE aligned line
        // (the grid button used to sit cramped beside the row).
        foot.style.setProperty("display", "flex", "important");
        foot.style.setProperty("align-items", "center", "important");
        foot.style.setProperty("gap", "10px", "important");
        foot.style.setProperty("width", "100%", "important");
        foot.style.setProperty("box-sizing", "border-box", "important");
        // v12: pin the footer to the bottom of the (now scrollable) sidebar so
        // the identity row is visible without collapsing history or scrolling.
        foot.style.setProperty("position", "sticky", "important");
        foot.style.setProperty("bottom", "0", "important");
        foot.style.setProperty("z-index", "2", "important");
        var kids = side.children, list = null, best = -1;
        for (var i = 0; i < kids.length; i++) {
          if (kids[i] === foot) continue;
          var sh = 0; try { sh = kids[i].scrollHeight; } catch (e2) {}
          if (sh > best) { best = sh; list = kids[i]; }
        }
        for (var j = 0; j < kids.length; j++) {
          if (kids[j] === foot) continue;
          if (kids[j] === list) kids[j].setAttribute("data-agentx-sidebar-list", "1");
          else kids[j].style.setProperty("flex", "none", "important");
        }
      } catch (e) { /* never break the console */ }
    }

    // v9: Detection-Rules counts live ONLY in the buttons' accessible names
    // ("Command Injection 4 / 4 Enabled") — there is no visible text node, so
    // no CSS unhide can reveal them. Inject a visible count badge into each
    // card instead. Idempotent via the data marker.
    function addRuleCountBadges() {
      // v33 (2026-11-20): DISABLED - do not re-enable. The ?rebrand=0
      // control test proved the console renders the Detection Rules
      // counts correctly on its own (~177px cards, count + "/ n" +
      // Enabled + meter all inside). This function (badge injection +
      // the v29 reveal pass, plus the v30/v32 stylesheet rules it
      // worked with) was collapsing the cards to ~73px with the counts
      // spilling onto the next row. The native render is correct; our
      // interference was the bug. (L73.) The body below is kept so the
      // call sites need no change, but it never runs.
      return;
      var RULES = ["Command Injection", "Resource Abuse", "Code Execution",
                   "Network Abuse", "Sensitive File Access", "Privilege Escalation"];
      function isDg(ch) { return ch >= "0" && ch <= "9"; }
      function ruleHit(txt) {
        if (!txt) return false;
        var low = txt.toLowerCase();
        for (var r = 0; r < RULES.length; r++) {
          if (low.indexOf(RULES[r].toLowerCase()) !== -1) return true;
          var pre = RULES[r].slice(0, 10).toLowerCase();
          if (pre.length >= 6 && low.indexOf(pre) !== -1) return true;
        }
        return false;
      }
      try {
        // v27: scan BUTTONS' textContent, NOT aria-labels. The probe proved
        // NO aria-label in the document contains " / " + "Enabled"
        // (countCard:none, v26) - the count lives in the button's own text
        // ("Command Injection 4 / 4 Enabled"), so the aria-label scan never
        // matched and no badge was ever created (badgeEx:0, v26).
        var btns = document.querySelectorAll("button");
        for (var i = 0; i < btns.length; i++) {
          var lbl = btns[i].textContent || "";
          // NOTE: this script is injected inside a template literal, so regex
          // backslashes would be consumed there (\d would reach the page as
          // d). Parse the "N / N" count by hand instead of with a regex.
          var m = null, si = lbl.indexOf("/");
          if (si > 0) {
            var e1 = si - 1;
            while (e1 >= 0 && (isDg(lbl.charAt(e1)) || lbl.charAt(e1) === " ")) e1--;
            var s2 = si + 1;
            while (s2 < lbl.length && (isDg(lbl.charAt(s2)) || lbl.charAt(s2) === " ")) s2++;
            var a = lbl.slice(e1 + 1, si).trim(), b = lbl.slice(si + 1, s2).trim();
            if (a && b && isDg(a.charAt(0)) && isDg(b.charAt(0))) m = [a, b];
          }
          if (!m || !ruleHit(lbl) || lbl.toLowerCase().indexOf("enabled") === -1) continue;
          // v27: the card IS the button (its textContent holds the whole
          // "Rule N / N Enabled" string). No ancestor climb: the climb could
          // land on a wrapper, and a badge on a wrapper paints in the wrong
          // place (the v25 two-line span's likely fate).
          var card = btns[i];
          // v11: the console renders these counts as IMAGES that load late
          // (browser check: hidden on the first Security visit, visible once
          // settled). Make those images load eagerly so the console's own
          // rendering - count + 'Enabled' under an orange divider - appears on
          // first paint, and only fall back to a plain-text badge when the
          // card has no count image at all (avoids showing the count twice).
          var cimgs = card.querySelectorAll("img");
          for (var q = 0; q < cimgs.length; q++) {
            cimgs[q].setAttribute("loading", "eager");
            cimgs[q].setAttribute("decoding", "sync");
            // v22: the count image exists (alt "4 / 4") but does not paint
            // (v20/v21). Force it to a real size - a 0x0 image paints
            // nothing, and a lazy image below the fold never loads.
            cimgs[q].style.setProperty("width", "auto", "important");
            cimgs[q].style.setProperty("height", "auto", "important");
            cimgs[q].style.setProperty("min-width", "16px", "important");
            cimgs[q].style.setProperty("min-height", "16px", "important");
            cimgs[q].style.setProperty("display", "inline-block", "important");
            cimgs[q].style.setProperty("opacity", "1", "important");
          }
          // v29: REVEAL the console's own count text instead of only
          // injecting a badge. The count ("4 / 4 Enabled") EXISTS as text
          // inside the card (the probe finds it in textContent) but does
          // not paint - it sits in a descendant that the console hides
          // (sr-only / clipped / 0-size). Find the innermost descendant
          // whose own text holds " / " and force it visible; that is the
          // console's own rendering, in the right place, with the right
          // text. The injected badge below stays as a fallback if no such
          // text node exists.
          try {
            var countEl = null;
            var allDesc = card.querySelectorAll ? card.querySelectorAll("*") : [];
            for (var d = 0; d < allDesc.length; d++) {
              var dt = allDesc[d].textContent || "";
              if (dt.indexOf(" / ") === -1) continue;
              // innermost: prefer the element whose DIRECT text holds it
              var hasDirect = false;
              var chs = allDesc[d].childNodes || [];
              for (var cn2 = 0; cn2 < chs.length; cn2++) {
                if (chs[cn2].nodeType === 3 && (chs[cn2].nodeValue || "").indexOf(" / ") !== -1) { hasDirect = true; break; }
              }
              if (hasDirect) { countEl = allDesc[d]; break; }
              if (!countEl) countEl = allDesc[d];
            }
            if (countEl) {
              countEl.style.setProperty("display", "inline-block", "important");
              countEl.style.setProperty("visibility", "visible", "important");
              countEl.style.setProperty("opacity", "1", "important");
              countEl.style.setProperty("width", "auto", "important");
              countEl.style.setProperty("height", "auto", "important");
              countEl.style.setProperty("max-width", "none", "important");
              countEl.style.setProperty("position", "static", "important");
              countEl.style.setProperty("clip", "auto", "important");
              countEl.style.setProperty("overflow", "visible", "important");
              countEl.style.setProperty("font-size", "12px", "important");
              countEl.style.setProperty("font-weight", "600", "important");
              countEl.style.setProperty("color", "#1a1d21", "important");
              countEl.style.setProperty("white-space", "nowrap", "important");
              countEl.style.setProperty("flex-shrink", "0", "important");
              card.style.setProperty("overflow", "visible", "important");
            }
          } catch (e5) {}
          // v26: the count hangs BELOW the pill as an overlaid badge. The
          // v24/v25 spans never painted because the pill is a single-line
          // flex row in a fixed-height grid track - anything inside it is
          // squeezed or clipped, and opening the card up (v25) did not move
          // it either (the card found may be a wrapper, not the pill). A
          // badge positioned below the pill does not fight the pill's own
          // layout at all. Card is made position:relative so the badge
          // anchors to it.
          try {
            // v29: only inject the badge when the reveal found NO count
            // element to unhide (otherwise the count would show twice).
            if (card && !countEl && !card.querySelector("[data-agentx-count-badge]")) {
              card.style.setProperty("position", "relative", "important");
              // v28: overflow:visible - the card is display:block, 32px
              // high, overflow:hidden (probe, v27). The badge hangs BELOW
              // the card, so overflow:hidden clips it to nothing even
              // though it exists in the DOM. Visible lets it hang out; the
              // title's own ellipsis lives on the title span, not the card,
              // so the title does not spill.
              card.style.setProperty("overflow", "visible", "important");
              var badge = document.createElement("span");
              badge.setAttribute("data-agentx-count-badge", "1");
              badge.textContent = m[1] + " / " + m[2] + " Enabled";
              badge.style.cssText = "position:absolute;top:calc(100% + 2px);left:0;z-index:5;display:inline-block;font-size:10px;font-weight:700;line-height:1.3;color:#fff;background:#1a1d21;border-radius:999px;padding:2px 7px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.3);";
              card.appendChild(badge);
            }
          } catch (e4) {}
        }
      } catch (e) { /* never break the console */ }
    }

    // v11 [L]: the Settings LEFT NAV is taller than the viewport on every
    // settings page, so its bottom items are cut off and its scroll position
    // drifts between pages. Any tall, narrow nav/aside becomes sticky at the
    // top, capped to the viewport height, and scrolls internally - the same
    // treatment the chat sidebar gets.
    // v11 [F]: a clock value must never break across lines ('13 : 22' rendered
    // on three lines in Configuration > User Timezone because its flex box was
    // shrunk to about one character wide).
    function agentxIsClockText(s) {
      if (!s || s.length > 12) return false;
      var ci = s.indexOf(":");
      if (ci < 1) return false;
      var a = s.slice(0, ci).trim(), b = s.slice(ci + 1).trim();
      if (a.length < 1 || a.length > 2 || b.length !== 2) return false;
      for (var i = 0; i < a.length; i++) { var c = a.charAt(i); if (c < "0" || c > "9") return false; }
      for (var j = 0; j < b.length; j++) { var d = b.charAt(j); if (d < "0" || d > "9") return false; }
      return true;
    }
    // v13 [10]: the Settings LEFT NAV is still cut off at the viewport bottom.
    // The v11e pass queried nav/aside by tag, which does not match the live
    // markup. Anchor on the nav's OWN visible labels instead ('Voice
    // Transcription' / 'Global settings' exist only there), then walk up to the
    // narrow, taller-than-viewport column and make IT fit + scroll internally.
    function fixTallNavs() {
      try {
        if (!document.createTreeWalker) return;
        var anchor = null;
        var walker = document.createTreeWalker(document.body, 4, null, false);
        var n;
        while ((n = walker.nextNode())) {
          var tv = (n.nodeValue || "").trim();
          if (tv !== "Voice Transcription" && tv !== "Global settings" && tv !== "Tool Offload") continue;
          var el = n.parentElement;
          for (var q = 0; el && el !== document.body && q < 6; q++) {
            var tg = (el.tagName || "").toUpperCase();
            if (tg === "A" || tg === "BUTTON" || el.getAttribute("href")) break;
            el = el.parentElement;
          }
          if (el && el !== document.body) { anchor = el; break; }
        }
        if (!anchor) return;
        // The nav column = the OUTERMOST narrow ancestor that is taller than
        // the viewport. Taking the outermost one matters: pinning an inner
        // wrapper (v11e) left the real column overflowing.
        var best = null;
        for (var p = anchor; p && p !== document.body; p = p.parentElement) {
          var r = null; try { r = p.getBoundingClientRect(); } catch (e1) {}
          if (r && r.width < 460 && r.height > 780) best = p;
        }
        if (!best) return;
        best.setAttribute("data-agentx-tall-nav", "1");
        best.style.setProperty("position", "sticky", "important");
        best.style.setProperty("top", "0", "important");
        best.style.setProperty("height", "100vh", "important");
        best.style.setProperty("max-height", "100vh", "important");
        best.style.setProperty("overflow-y", "auto", "important");
        best.style.setProperty("overflow-x", "hidden", "important");
        best.style.setProperty("align-self", "flex-start", "important");
      } catch (e) { /* never break the console */ }
    }

    // v36: pull the SETTINGS sidebar up with a negative top margin
    // (IN-FLOW). v34/v35 REVERTED: the position:fixed pin took the aside
    // out of the grid, so auto-placement moved the content <main> (no
    // explicit grid-column) into column 1 - under the sidebar, headings
    // hidden, cards shrunk to ~35px. That was worse than the displacement
    // it fixed. A top MARGIN keeps the aside IN FLOW (grid intact, content
    // stays in column 2, no overlap) while shifting it up visually. The
    // displacement varies between loads (410-694px) and is an upstream
    // race, so the margin is a FEEDBACK LOOP, not a constant: each pass
    // measures the aside's top against the content column's top and
    // adjusts the margin by the error (newMargin = oldMargin - error).
    // It converges to the aside sitting at the content top and tracks
    // the race if the natural position moves. Only on /settings/*, wide
    // viewports; never sets display or position.
    // v37: v36's INLINE margin never stuck on a cold load - React
    // re-renders wipe inline styles on elements it manages (L70), and
    // the aside is React-managed. So v37 drives the margin through a CSS
    // VARIABLE (--ax-sidebar-shift) set on <html> (outside React's root,
    // never wiped) + the stylesheet rule above (a stylesheet rule
    // survives React). The shift value is tracked in a module var; the
    // feedback math is unchanged.
    var agentxSidebarShift = 0;
    function fixSettingsSidebarMargin() {
      try {
        if (!agentxWide()) return;
        var path = "";
        try { path = window.location ? window.location.pathname || "" : ""; } catch (e) {}
        if (path.indexOf("/settings") !== 0) return;
        var aside = null;
        try { aside = document.querySelector ? document.querySelector("aside.index-module__sidebar__MIhyN") : null; } catch (e) {}
        if (!aside) {
          try {
            var nav = document.querySelector ? document.querySelector('nav[aria-label="Settings"]') : null;
            if (nav && nav.closest) aside = nav.closest("aside");
          } catch (e2) {}
        }
        if (!aside) return;
        var content = null;
        try { content = document.querySelector ? document.querySelector("main.index-module__content__-76Dm") : null; } catch (e3) {}
        if (!content) return;
        var ar = null, cr = null;
        try { ar = aside.getBoundingClientRect(); } catch (e4) {}
        try { cr = content.getBoundingClientRect(); } catch (e5) {}
        if (!ar || !cr) return;
        if (!(cr.top > 0) || cr.top > 200) return;
        var err = ar.top - cr.top;
        if (err > -5 && err < 5) return;
        var next = Math.round(agentxSidebarShift - err);
        if (next < -800) next = -800;
        if (next > 50) next = 50;
        if (next === agentxSidebarShift) return;
        agentxSidebarShift = next;
        try {
          var de = document.documentElement;
          if (de && de.style && de.style.setProperty) de.style.setProperty("--ax-sidebar-shift", next + "px");
        } catch (e6) {}
      } catch (e) { /* never break the console */ }
    }

    // v13 [5]: the 'Show thinking' row is STILL stacked (icon / heading /
    // description / toggle in one column). The earlier walk looked for a
    // [role=switch] ancestor, which does not match the live toggle. Now: find
    // the heading by its visible text, take the NEAREST FOLLOWING button as
    // the toggle, and make their smallest common ancestor a left-text /
    // right-control row. The toggle is kept - only its position changes.
    function fixShowThinkingRow() {
      try {
        if (!document.createTreeWalker || !window.Node) return;
        var walker = document.createTreeWalker(document.body, 4, null, false);
        var n, textEl = null;
        while ((n = walker.nextNode())) {
          if ((n.nodeValue || "").trim() === "Show thinking") { textEl = n.parentElement; break; }
        }
        if (!textEl) return;
        var all = document.querySelectorAll("button, [role='switch'], input[type='checkbox']");
        var toggle = null;
        for (var i = 0; i < all.length; i++) {
          if (textEl.contains(all[i])) continue;
          if (all[i].compareDocumentPosition(textEl) & Node.DOCUMENT_POSITION_PRECEDING) { toggle = all[i]; break; }
        }
        if (!toggle) return;
        var anc = textEl;
        while (anc && anc !== document.body && !anc.contains(toggle)) anc = anc.parentElement;
        if (!anc || anc === document.body) return;
        anc.style.setProperty("display", "flex", "important");
        anc.style.setProperty("flex-direction", "row", "important");
        anc.style.setProperty("align-items", "center", "important");
        anc.style.setProperty("justify-content", "space-between", "important");
        anc.style.setProperty("gap", "16px", "important");
      } catch (e) { /* never break the console */ }
    }

    // v18 [5]: settings rows must be left-text / right-control. 'Show thinking'
    // AND 'Desktop notifications' both render their toggle BELOW the text on
    // the LEFT. Anchored on the toggle element itself: the smallest ancestor
    // that also holds the label text becomes a flex row with the toggle pushed
    // to the right. Rows already laid out correctly are unaffected.
    function fixToggleRows() {
      try {
        var toggles = document.querySelectorAll("[role='switch'], input[type='checkbox'], button[aria-pressed]");
        for (var i = 0; i < toggles.length; i++) {
          var tg = toggles[i];
          var row = tg.parentElement;
          for (var up = 0; row && row !== document.body && up < 6; up++) {
            if ((row.textContent || "").trim().length > 3) break;
            row = row.parentElement;
          }
          if (!row || row === document.body) continue;
          row.style.setProperty("display", "flex", "important");
          row.style.setProperty("flex-direction", "row", "important");
          // v19: the row WRAPS (the console's own CSS leaves flex-wrap on),
          // so the control drops below the text even in a flex row. The
          // wrap - not the direction - is what stacked Show thinking and
          // Desktop notifications. Never wrap; the copy shrinks instead.
          row.style.setProperty("flex-wrap", "nowrap", "important");
          row.style.setProperty("align-items", "center", "important");
          row.style.setProperty("justify-content", "space-between", "important");
          row.style.setProperty("gap", "16px", "important");
          tg.style.setProperty("margin-left", "auto", "important");
          tg.style.setProperty("flex", "none", "important");
        }
      } catch (e) { /* never break the console */ }
    }

    // v11 [C][D]: the Voice Transcription and Tool Offload radio groups
    // rendered the SAME description on every option - the console reused one
    // string, so 'OpenAI', 'Local Whisper' and 'Whisper API' all claimed to be
    // 'No transcription...', and both offload modes described only the
    // foreground/countdown behaviour. The real per-option descriptions exist in
    // the console bundle; patch them in by option label. TEXT ONLY - no option,
    // control or setting is added, removed or renamed.
    function fixRadioDescriptions() {
      var opts = [
        ["OpenAI",
         "OpenAI provider. Select a specific provider above to enable transcription.",
         "No transcription. Voice messages"],
        ["Local Whisper",
         "Run transcription locally using the openai-whisper Python library. Requires both ffmpeg and openai-whisper to be installed.",
         "No transcription. Voice messages"],
        ["Whisper API",
         "Select which provider to use for audio transcription via the Whisper API. Only providers with a Whisper-compatible endpoint are shown.",
         "No transcription. Voice messages"],
        ["Auto Offload",
         "After the countdown expires, the tool is automatically moved to background execution, allowing the Agent to continue processing other tasks. Suitable for long-running tools.",
         "continues running in the foreground"]
      ];
      try {
        if (!document.createTreeWalker) return;
        var walker = document.createTreeWalker(document.body, 4, null, false);
        var nodes = [], n;
        while ((n = walker.nextNode())) nodes.push(n);
        for (var i = 0; i < nodes.length; i++) {
          var label = (nodes[i].nodeValue || "").trim();
          for (var j = 0; j < opts.length; j++) {
            if (label !== opts[j][0]) continue;
            var cont = nodes[i].parentElement, h = 0;
            while (cont && cont !== document.body && h < 8 &&
                   (cont.textContent || "").indexOf(opts[j][2]) === -1) {
              cont = cont.parentElement; h++;
            }
            if (!cont || cont === document.body) continue;
            var tw = document.createTreeWalker(cont, 4, null, false);
            var m;
            while ((m = tw.nextNode())) {
              if ((m.nodeValue || "").indexOf(opts[j][2]) !== -1) { m.nodeValue = opts[j][1]; break; }
            }
            break;
          }
        }
      } catch (e) { /* never break the console */ }
    }

    // v11 [L]: provider logos on Models (and other images) popped in late and
    // left blank holes in the layout. Load images eagerly and give any that
    // has not arrived yet a quiet placeholder surface, so the page reads as
    // clean and fast instead of showing empty holes.
    function fixImages() {
      try {
        var imgs = document.images;
        for (var i = 0; i < imgs.length; i++) {
          var im = imgs[i];
          if (im.getAttribute("loading") !== "eager") im.setAttribute("loading", "eager");
          if (im.getAttribute("decoding") !== "sync") im.setAttribute("decoding", "sync");
          if (!im.complete) im.style.setProperty("background-color", "var(--ax-surface-2)", "important");
          else if (im.style.backgroundColor) im.style.removeProperty("background-color");
        }
      } catch (e) { /* never break the console */ }
    }

    // v13 [1]: merge the composer's control rows by DOM MANIPULATION. CSS
    // merging (display:contents) and ':has()' never matched the live DOM. This
    // walks DOWN from the controls' common ancestor to the deepest container
    // whose controls are split across two or more children, then physically
    // moves the extra branches' children into the first branch and hides the
    // emptied branches. Anchored on the visible 'Send' label + the textbox.
    // Idempotent, and it never moves or hides the textbox's own branch.
    // v21: timestamp of the last SPA navigation (set by the history wrapper
    // in the init block). The composer merge MOVES nodes; running it while
    // React is committing a route change can leave the chat view unmounted
    // (blank main pane on return navigation, v20 item 10). Skip the merge
    // for 1.5 s after a navigation - the observer re-runs it once settled.
    var agentxLastNav = 0;
    // v22: counters for the probe (is the nav guard starving the merge?).
    var agentxNavCount = 0, agentxMergeSkipped = 0, agentxMergeRan = 0;
    function mergeComposerRows() {
      try {
        if (Date.now() - agentxLastNav < 1500) { agentxMergeSkipped++; return; }
        // v22: also skip while the sidebar search is non-empty. Moving
        // nodes while React filters the conversation list can unmount the
        // chat view (blank main pane after search, v20/v21 item 10).
        try {
          var ssi = document.querySelector ? document.querySelector("input[placeholder*='Search conversations']") : null;
          if (ssi && (ssi.value || "").trim() !== "") { agentxMergeSkipped++; return; }
        } catch (e) {}
        agentxMergeRan++;
        var send = null;
        var allBtns = document.querySelectorAll("button, [role='button']");
        for (var i = 0; i < allBtns.length; i++) {
          var tl = (allBtns[i].textContent || "").trim();
          var al = (allBtns[i].getAttribute("aria-label") || "").trim();
          if (tl === "Send" || al === "Send" || tl === "Send message" || al === "Send message") { send = allBtns[i]; break; }
        }
        if (!send) return;
        var root = send.parentElement, tb = null;
        for (var h = 0; root && root !== document.body && h < 12; h++) {
          tb = root.querySelector("textarea, input[type='text'], [contenteditable='true']");
          if (tb) break;
          root = root.parentElement;
        }
        if (!root || root === document.body || !tb) return;
        var all = root.querySelectorAll("button, select");
        var ctrls = [];
        for (var k = 0; k < all.length; k++) { if (!tb.contains(all[k])) ctrls.push(all[k]); }
        if (ctrls.length < 2) return;
        // v24: skip when the controls already share one row. The merge ran
        // hundreds of times per session (v23 probe: mergeRan 0 -> 592 in
        // ~2 min, never settling) because every observer pass re-ran it even
        // when the layout was already right. One row = same top edge.
        try {
          var top0 = null, oneRow = true;
          for (var sr = 0; sr < ctrls.length; sr++) {
            var rt = ctrls[sr].getBoundingClientRect ? ctrls[sr].getBoundingClientRect().top : 0;
            if (top0 === null) top0 = rt;
            else if (Math.abs(rt - top0) > 3) { oneRow = false; break; }
          }
          if (oneRow && ctrls.length >= 6) return;
        } catch (e) {}
        var lca = ctrls[0];
        for (var a = 1; a < ctrls.length; a++) {
          if (lca.contains(ctrls[a])) continue;
          var cand = lca;
          while (cand && !cand.contains(ctrls[a])) cand = cand.parentElement;
          if (!cand) return;
          lca = cand;
        }
        if (!lca || lca === document.body) return;
        var node = lca, guard = 0;
        while (node && node !== document.body && guard++ < 8) {
          var branches = [], kids = node.children;
          for (var b = 0; b < kids.length; b++) {
            if (tb && kids[b].contains(tb)) continue;
            for (var c = 0; c < ctrls.length; c++) {
              if (kids[b].contains(ctrls[c])) { branches.push(kids[b]); break; }
            }
          }
          if (branches.length >= 2) {
            var target = branches[0];
            for (var d = 1; d < branches.length; d++) {
              var br = branches[d];
              // v21: a <select> control is a branch by itself (contains()
              // is true for the element itself), so the old code moved its
              // <option> CHILDREN into the target - orphaning them as plain
              // text lines in the composer (the v13-v20 cold-load Thinking
              // list: the probe proved the painted list is <option> elements
              // whose parent is DIV.qwenpaw-sender-content-bottom, not a
              // <select>). Move the WHOLE select (options intact), never its
              // children, and do not hide it afterwards.
              if ((br.tagName || "").toUpperCase() === "SELECT") { target.appendChild(br); continue; }
              var move = [];
              for (var e = 0; e < br.children.length; e++) move.push(br.children[e]);
              for (var f = 0; f < move.length; f++) target.appendChild(move[f]);
              br.style.setProperty("display", "none", "important");
            }
            target.style.setProperty("display", "flex", "important");
            // v22: nowrap + tighter gap + shrinkable controls. On the cold
            // load the 8 controls wrapped into two rows (v21 item 1) - the
            // box is at its narrowest before the sidebar settles, and the
            // now-visible Thinking select adds ~80px. Force one row and let
            // the controls compress slightly instead of wrapping.
            target.style.setProperty("flex-wrap", "nowrap", "important");
            target.style.setProperty("gap", "6px", "important");
            for (var sc = 0; sc < ctrls.length; sc++) {
              try {
                ctrls[sc].style.setProperty("flex-shrink", "1", "important");
                ctrls[sc].style.setProperty("min-width", "0", "important");
              } catch (e) {}
            }
            target.style.setProperty("align-items", "center", "important");
            target.style.setProperty("justify-content", "flex-start", "important");
            node.style.setProperty("display", "flex", "important");
            node.style.setProperty("flex-direction", "column", "important");
            node.style.setProperty("gap", "8px", "important");
            return;
          }
          if (branches.length === 1) { node = branches[0]; continue; }
          return;
        }
      } catch (e) { /* never break the console */ }
    }

    // v15 [2]: SAFE pin. v14 moved the pill out of the scroll container,
    // which re-stacked the whole app and blanked the main pane - REVERTED.
    // Back to v13's position:fixed pin (which kept the page whole and the
    // composer painting), but constrained to the SIDEBAR width so it is a
    // bottom-left pill rather than a full-width bar, and the grid icon lands
    // beside the account text instead of at the viewport's right edge. No DOM
    // is moved and no container is resized, so the layout cannot re-stack.
    function pinAccountFooter(row) {
      try {
        row.style.setProperty("position", "fixed", "important");
        row.style.setProperty("left", "12px", "important");
        row.style.setProperty("bottom", "12px", "important");
        row.style.setProperty("z-index", "60", "important");
        row.style.setProperty("width", "280px", "important");
        row.style.setProperty("max-width", "280px", "important");
        row.style.setProperty("box-sizing", "border-box", "important");
        row.style.setProperty("box-shadow", "0 4px 16px rgba(0,0,0,.18)", "important");
        row.style.setProperty("overflow", "visible", "important");
        // v17 [7]: the floating pill overlays the list, hiding the last rows.
        // Give the scrolling list bottom padding so its final rows can be
        // brought clear of the pill instead of being cut off behind it.
        var list = row.parentElement;
        for (var lp = 0; list && list !== document.body && lp < 8; lp++) {
          var ov = "";
          try { ov = window.getComputedStyle(list).overflowY; } catch (e5) {}
          if (ov === "auto" || ov === "scroll") break;
          list = list.parentElement;
        }
        if (list && list !== document.body) list.style.setProperty("padding-bottom", "76px", "important");
      } catch (e) { /* never break the console */ }
    }

    // v13 [1]: the cold-load render storm undoes the DOM merge (React
    // re-renders its two-row structure after the merge lands). Re-run the merge
    // on a short bounded schedule for ~15s after the composer first appears, so
    // it lands AFTER React's final cold render. Purely client-side DOM
    // settling - a setTimeout chain, no server polling.
    var agentxComposerRetries = 0;
    function startComposerRetry() {
      if (agentxComposerRetries) return;
      agentxComposerRetries = 1;
      var tries = 0;
      function tick() {
        tries++;
        try { mergeComposerRows(); } catch (e2) {}
        if (tries < 60) setTimeout(tick, 250);
      }
      setTimeout(tick, 250);
    }

    // v16 [2]: the LAYOUT pins are gated to WIDE viewports. At ~1000px the main
    // pane must paint from the console's OWN layout; forcing 100vh / flex /
    // overflow restructuring there risks compounding a narrow-width layout
    // fault. This only RESTRICTS when the pins apply - wide (1920) behaviour is
    // unchanged, and no DOM is restructured at any width.
    function agentxWide() {
      try {
        var w = window.innerWidth || document.documentElement.clientWidth || 1920;
        return w >= 1200;
      } catch (e) { return true; }
    }

    // v16 [6]: eleven identical eval-judge rows clutter the sidebar with the
    // same truncated prompt. Make them DISTINGUISHABLE without deleting or
    // renaming anything: identical long titles get a small ordinal badge, so
    // each row is readable and unique while the original title is preserved.
    // v18: shared helper - the longest text node in a subtree. Appending to
    // text that ALREADY paints is the only reliable way to make injected text
    // visible here (injected spans render into the a11y tree but not on screen).
    function longestTextNode(root) {
      try {
        if (!document.createTreeWalker) return null;
        var best = null, bestLen = 0;
        var w = document.createTreeWalker(root, 4, null, false);
        var n;
        while ((n = w.nextNode())) {
          var v = (n.nodeValue || "").trim();
          if (v.length > bestLen) { bestLen = v.length; best = n; }
        }
        return best;
      } catch (e) { return null; }
    }

    function dedupeRowTitles() {
      try {
        // v21: skip while the sidebar search is non-empty. Editing text
        // nodes mid-search (while React filters the list) can confuse
        // React's reconciliation and blank the main pane (v20 item 10).
        var si = null;
        try { si = document.querySelector ? document.querySelector("input[placeholder*='Search conversations']") : null; } catch (e0) {}
        if (si && (si.value || "").trim() !== "") return;
        // v27: rows are SESSION ITEMS, not <button>s. The probe's rowEl
        // (v26) is SPAN.sessionItem-module__nameTrack__Gxu7Z inside
        // DIV.nameViewport inside DIV.content - the title lives in a
        // scrolling nameTrack inside the session item. The position filter
        // (v24/v25) only ever found the small 32x32 icon buttons + New task
        // (sideRows 9 of ~54) because the rows themselves are not buttons.
        // Collect the row containers by the sessionItem class (substring
        // match on the module name - the hash suffix can change on rebuild)
        // and read the title from the nameTrack span.
        var rows = [];
        try {
          if (document.querySelectorAll) {
            var srows = document.querySelectorAll("[class*='sessionItem-module__sidebar']");
            for (var i = 0; i < srows.length; i++) rows.push(srows[i]);
          }
        } catch (e1) {}
        var seen = {};
        for (var i = 0; i < rows.length; i++) {
          var el = rows[i];
          // The title is the nameTrack span's text (it may hold TWO copies
          // of the title for the marquee scroll - badge both).
          var tracks = el.querySelectorAll ? el.querySelectorAll("[class*='sessionItem-module__nameTrack']") : [];
          var title = "";
          for (var tk = 0; tk < tracks.length; tk++) {
            var tv = (tracks[tk].textContent || "").trim();
            if (tv.length > title.length) title = tv;
          }
          if (!title || title.length < 3) continue;
          if (title.indexOf("Console account") !== -1 || title.indexOf("Local workspace") !== -1) continue;
          if (title === "New Chat" || title === "New task") continue;
          var key = title.toLowerCase();
          seen[key] = (seen[key] || 0) + 1;
          if (seen[key] < 2) continue;
          // v19: PREPEND the ordinal. v18 appended it - but sidebar titles
          // truncate with an ellipsis, so text appended at the END is
          // clipped off-screen and never paints (the v18 failure: the badge
          // existed in the page data, nothing rendered). The start of the
          // title is always visible, so "#2 " goes there.
          for (var tn = 0; tn < tracks.length; tn++) {
            var nodes = tracks[tn].childNodes || [];
            for (var cn = 0; cn < nodes.length; cn++) {
              if (nodes[cn].nodeType !== 3) continue;
              var cur = nodes[cn].nodeValue || "";
              if (cur.trim().toLowerCase() !== key) continue;
              if (cur.indexOf("#" + seen[key]) !== -1) continue;
              nodes[cn].nodeValue = "#" + seen[key] + " " + cur;
            }
          }
        }
      } catch (e) { /* never break the console */ }
    }

    // v16 [3]: the faint header glyphs read as '+' and 'x'. They are actually
    // the Terminal ('>_') and Open-workspace buttons. Darken them and make them
    // opaque so they read as real controls; their tooltips/labels are untouched.
    // v18 [2]: match the faint top-right header glyphs by their rendered
    // POSITION and by the svg itself, not by host tag or aria-label. This hits
    // them whatever element wraps the icon, and styles both the icon and its
    // host so an inherited faint colour cannot win.
    // v19: the ROOT CAUSE of the faint icons, found by reading the bundle:
    // v16/v18 set the icons to var(--ax-ink), which is #e8eaf0 - near-WHITE.
    // On the console's LIGHT cream header that is invisible by construction.
    // The icons need DARK ink (#1a1d21) on the light background, plus fill
    // and stroke following currentColor so hardcoded light fills cannot win.
    function clarifyHeaderIcons() {
      try {
        var svgs = document.querySelectorAll("svg");
        var w = window.innerWidth || document.documentElement.clientWidth || 1920;
        for (var i = 0; i < svgs.length; i++) {
          var r = null; try { r = svgs[i].getBoundingClientRect(); } catch (e1) {}
          if (!r || r.width === 0 || r.height === 0) continue;
          if (r.right < w - 220 || r.top > 90) continue;
          var host = svgs[i].closest("button, a, [role='button']") || svgs[i].parentElement;
          if (!host) continue;
          host.style.setProperty("opacity", "1", "important");
          host.style.setProperty("color", "#1a1d21", "important");
          svgs[i].style.setProperty("color", "#1a1d21", "important");
          svgs[i].style.setProperty("opacity", "1", "important");
          svgs[i].style.setProperty("stroke-width", "2", "important");
          svgs[i].style.setProperty("fill", "currentColor", "important");
          svgs[i].style.setProperty("stroke", "currentColor", "important");
          var parts = svgs[i].querySelectorAll ? svgs[i].querySelectorAll("*") : [];
          for (var q = 0; q < parts.length; q++) {
            parts[q].style.setProperty("fill", "currentColor", "important");
            parts[q].style.setProperty("stroke", "currentColor", "important");
          }
        }
      } catch (e) { /* never break the console */ }
    }

    // v19: the Thinking menu renders OPEN during the cold render itself (a
    // default-state bug). v17/v18 hid it by CLIMBING from the "XHigh" text
    // node to an ancestor - and that ancestor CONTAINS the whole composer
    // toolbar, so v18's inline display:none hid all 8 controls on the cold
    // load (the v18 regression: empty composer box, placeholder only).
    // Reverse-engineered fix: hide ONLY the option-list elements by their
    // own identity - the console's own popover/picker (real classes from
    // thinking.module-DvpiN7Dn.js). NEVER a climbed ancestor, NEVER our
    // own select (a native <select> renders closed by itself; hiding it
    // would remove the Thinking control). Guard: refuse any element that
    // contains the composer textarea or a control button.
    var agentxThinkingTouched = false;
    var agentxThinkingWired = false;
    function hideColdOpenThinking() {
      try {
        if (agentxThinkingTouched) {
          var prev = document.querySelectorAll ? document.querySelectorAll("[data-agentx-thinking-closed]") : [];
          for (var i = 0; i < prev.length; i++) { prev[i].removeAttribute("data-agentx-thinking-closed"); prev[i].style.removeProperty("display"); }
          return;
        }
        var targets = [];
        var pops = document.querySelectorAll ? document.querySelectorAll(".thinking-module__popover__QESSn,.thinking-module__picker__Rhv9q") : [];
        for (var p = 0; p < pops.length; p++) targets.push(pops[p]);
        // v20: the class targets above never matched in the live page.
        // The console's chunks contain NO "XHigh" literal at all (the level
        // names exist only in our own injected select and in the console's
        // locale data), and the a11y tree says OUR select is [collapsed] -
        // so the painted list is a SEPARATE element the class query cannot
        // see. Find it by its text: the smallest visible element holding
        // the level list (XHigh + Medium + Off), NOT inside our select.
        // The guard below (refuse anything containing the textarea or a
        // control button) is what stops this climbing into the toolbar
        // itself - the v18 lesson. Never hide our own select.
        try {
          var xhNode = null;
          if (document.createTreeWalker) {
            var w2 = document.createTreeWalker(document.body, 4, null, false), nn;
            while ((nn = w2.nextNode())) {
              if ((nn.nodeValue || "").indexOf("XHigh") === -1) continue;
              var par = nn.parentElement;
              if (!par || par.offsetParent === null) continue;
              var anc = par, inOurs = false;
              while (anc && anc !== document.body) {
                if (anc.getAttribute && anc.getAttribute("data-agentx-thinking") !== null) { inOurs = true; break; }
                anc = anc.parentElement;
              }
              if (inOurs) continue;
              xhNode = par;
              break;
            }
          }
          if (xhNode) {
            var cand = xhNode.parentElement, hops = 0;
            while (cand && cand !== document.body && hops < 4) {
              var ct = (cand.textContent || "");
              if (ct.indexOf("XHigh") !== -1 && ct.indexOf("Medium") !== -1 && ct.indexOf("Off") !== -1 && ct.length < 400) { targets.push(cand); break; }
              cand = cand.parentElement;
              hops++;
            }
          }
        } catch (e3) {}
        // v21: ORPHANED <option> elements. The v20 probe proved the painted
        // list is <option> elements whose parent is
        // DIV.qwenpaw-sender-content-bottom - NOT inside any <select>. A
        // native <select> renders closed; <option> elements orphaned in a
        // div render as plain text lines. (They were scattered there when
        // the composer merge moved a <select>'s children out of it - fixed
        // in mergeComposerRows in v21 - but orphans from earlier rounds are
        // already in the live page.) Hide every VISIBLE <option> with no
        // <select> ancestor. Our own select's options live inside a
        // <select>, so they are never touched.
        try {
          var opts = document.querySelectorAll ? document.querySelectorAll("option") : [];
          for (var oi = 0; oi < opts.length; oi++) {
            var op = opts[oi];
            if (!op || op.offsetParent === null) continue;
            var hasSel = false, oa = op.parentElement;
            while (oa && oa !== document.body) { if ((oa.tagName || "").toUpperCase() === "SELECT") { hasSel = true; break; } oa = oa.parentElement; }
            if (hasSel) continue;
            op.setAttribute("data-agentx-thinking-closed", "1");
            op.style.setProperty("display", "none", "important");
          }
        } catch (e4) {}
        for (var t = 0; t < targets.length; t++) {
          var el = targets[t];
          if (!el) continue;
          var bad = false;
          try {
            if (el.querySelector && (el.querySelector("textarea") || el.querySelector("[placeholder*='message navigation']"))) bad = true;
            if (!bad && el.querySelector) {
              var btns = el.querySelectorAll("button");
              for (var b = 0; b < btns.length; b++) {
                var bl = (btns[b].getAttribute("aria-label") || "") + " " + (btns[b].getAttribute("title") || "") + " " + (btns[b].textContent || "");
                if (bl.indexOf("Smart Mode") !== -1 || bl.indexOf("Send message") !== -1 || bl.indexOf("Attach files") !== -1 || bl.indexOf("Context usage") !== -1) { bad = true; break; }
              }
            }
          } catch (e1) {}
          if (bad) continue;
          el.setAttribute("data-agentx-thinking-closed", "1");
          el.style.setProperty("display", "none", "important");
        }
        if (agentxThinkingWired) return;
        var trig = document.querySelector ? (document.querySelector(".thinking-module__trigger__if3ry") || document.querySelector("[data-agentx-thinking]")) : null;
        if (!trig) return;
        agentxThinkingWired = true;
        trig.addEventListener("click", function () {
          agentxThinkingTouched = true;
          try { var pr = document.querySelectorAll("[data-agentx-thinking-closed]"); for (var q = 0; q < pr.length; q++) { pr[q].removeAttribute("data-agentx-thinking-closed"); pr[q].style.removeProperty("display"); } } catch (e2) {}
        }, true);
      } catch (e) { /* never break the console */ }
    }

    // v17 [6]: the three theme preview bars (Light/Dark/System) collapse into a
    // single ~30px overlap with unreadable labels. Anchored on the labels
    // themselves: their common container becomes a real stacked column with
    // gaps, and each bar gets its own height so the label is readable.
    // v19: rewritten from the real component code
    // (GeneralSettings-1TjWEnww.js): the theme picker is a ROW of three
    // <button class="appearanceChoice">, each a COLUMN (miniWindow preview
    // on top, modeLabel text below). v17/v18 climbed from the label text
    // and set the CONTAINER to a column, which stacked the three bars
    // vertically - the exact squish the checks kept reporting. Use the
    // real classes; no text climbing, no guessing.
    function fixThemeBars() {
      try {
        var choices = document.querySelectorAll ? document.querySelectorAll(".GeneralSettings-module__appearanceChoices__mYTAt") : [];
        for (var i = 0; i < choices.length; i++) {
          var c = choices[i];
          c.style.setProperty("display", "flex", "important");
          c.style.setProperty("flex-direction", "row", "important");
          c.style.setProperty("gap", "12px", "important");
          c.style.setProperty("align-items", "stretch", "important");
        }
        var btns = document.querySelectorAll ? document.querySelectorAll(".GeneralSettings-module__appearanceChoice__Qcw7e") : [];
        for (var j = 0; j < btns.length; j++) {
          var b = btns[j];
          b.style.setProperty("display", "flex", "important");
          b.style.setProperty("flex-direction", "column", "important");
          b.style.setProperty("gap", "8px", "important");
          b.style.setProperty("min-height", "110px", "important");
        }
        var wins = document.querySelectorAll ? document.querySelectorAll(".GeneralSettings-module__miniWindow__n7mMQ") : [];
        for (var k = 0; k < wins.length; k++) {
          wins[k].style.setProperty("height", "52px", "important");
          wins[k].style.setProperty("min-height", "52px", "important");
          wins[k].style.setProperty("flex", "none", "important");
          // v25: overflow:hidden - the miniWindow box IS 52px, but its
          // children (miniSidebar/miniChat) are ~110px tall and OVERFLOW
          // visibly, painting the Dark preview down the whole card (the
          // v23/v24 slab; probe: miniChat is the topmost element at the
          // slab centre, inside a rgb(37,37,37) miniWindow). Clip them.
          wins[k].style.setProperty("overflow", "hidden", "important");
        }
        var labs = document.querySelectorAll ? document.querySelectorAll(".GeneralSettings-module__modeLabel__f4mmp") : [];
        for (var m = 0; m < labs.length; m++) {
          labs[m].style.setProperty("display", "flex", "important");
          labs[m].style.setProperty("align-items", "center", "important");
          labs[m].style.setProperty("gap", "6px", "important");
          labs[m].style.setProperty("white-space", "nowrap", "important");
        }
        // v23: kill the black slab behind the theme cards (v22 item 5: a
        // solid black rectangle x~803-1235 behind Dark/System, covering
        // part of Light and extending past System). The miniWindow previews
        // carry the theme colours themselves; the container and the buttons
        // must be transparent so the white settings card shows through.
        // v27: ALSO the InteractiveCard surface + frame that WRAP each
        // button. The probe caught them at rgb(0,0,0) on first paint (v26)
        // - the console's own CSS paints the card shell black, and the
        // button's transparency lets it show through. Transparent all the
        // way down to the white settings card.
        var apc = document.querySelectorAll ? document.querySelectorAll(".GeneralSettings-module__appearanceChoices__mYTAt") : [];
        for (var ac = 0; ac < apc.length; ac++) {
          apc[ac].style.setProperty("background", "transparent", "important");
          apc[ac].style.setProperty("background-color", "transparent", "important");
        }
        var apb = document.querySelectorAll ? document.querySelectorAll(".GeneralSettings-module__appearanceChoice__Qcw7e") : [];
        for (var ab = 0; ab < apb.length; ab++) {
          apb[ab].style.setProperty("background", "transparent", "important");
          apb[ab].style.setProperty("background-color", "transparent", "important");
        }
        var ics = document.querySelectorAll ? document.querySelectorAll(".InteractiveCard-module__surface__cuoJ-, .InteractiveCard-module__frame__o0M0L") : [];
        for (var ic = 0; ic < ics.length; ic++) {
          ics[ic].style.setProperty("background", "transparent", "important");
          ics[ic].style.setProperty("background-color", "transparent", "important");
        }
        // v28: strip the SPLIT GRADIENT (a background-IMAGE, not a colour)
        // off the Theme row + the card shells. The system-preview rule
        // misfired during the render storm and painted the SPLIT gradient
        // on the whole settingRow (probe: the row carries
        // linear-gradient(90deg,#f5f5f4...#111)). Setting background-color
        // transparent never removed it - a gradient is an image. Remove the
        // image itself, on the row and on every shell, so the white settings
        // card shows through.
        var apc0 = document.querySelectorAll ? document.querySelectorAll(".GeneralSettings-module__appearanceChoices__mYTAt") : [];
        for (var ap0 = 0; ap0 < apc0.length; ap0++) {
          apc0[ap0].style.setProperty("background-image", "none", "important");
          var srow = apc0[ap0].parentElement;
          while (srow && srow !== document.body) {
            var scls = (srow.className || "").toString();
            if (scls.indexOf("GeneralSettings-module__settingRow__") !== -1) {
              srow.style.setProperty("background-image", "none", "important");
              srow.style.setProperty("background-color", "transparent", "important");
              break;
            }
            srow = srow.parentElement;
          }
        }
        var apb0 = document.querySelectorAll ? document.querySelectorAll(".GeneralSettings-module__appearanceChoice__Qcw7e") : [];
        for (var ab0 = 0; ab0 < apb0.length; ab0++) {
          apb0[ab0].style.setProperty("background-image", "none", "important");
        }
        for (var ic0 = 0; ic0 < ics.length; ic0++) {
          ics[ic0].style.setProperty("background-image", "none", "important");
        }
        // v21: the Theme row itself stacks (tile above label) even though
        // the bars are fixed - the row holding the appearanceChoices is a
        // flex column in the console's own CSS, so force the ROW (the
        // appearanceChoices' parent) to a flex row with nowrap too. Same
        // for the Desktop Mode row (found by its label text).
        var ap = document.querySelectorAll ? document.querySelectorAll(".GeneralSettings-module__appearanceChoices__mYTAt") : [];
        for (var a = 0; a < ap.length; a++) {
          var prow = ap[a].parentElement;
          if (prow) {
            prow.style.setProperty("display", "flex", "important");
            prow.style.setProperty("flex-direction", "row", "important");
            prow.style.setProperty("flex-wrap", "nowrap", "important");
            prow.style.setProperty("align-items", "center", "important");
          }
        }
        try {
          if (document.createTreeWalker) {
            var w4 = document.createTreeWalker(document.body, 4, null, false), n4;
            while ((n4 = w4.nextNode())) {
              if ((n4.nodeValue || "").trim() !== "Desktop Mode") continue;
              var drow = n4.parentElement;
              for (var dh = 0; drow && drow !== document.body && dh < 5; dh++) {
                var dc = (drow.className || "").toString();
                if (dc.indexOf("settingRow") !== -1) break;
                drow = drow.parentElement;
              }
              if (drow && drow !== document.body) {
                drow.style.setProperty("display", "flex", "important");
                drow.style.setProperty("flex-direction", "row", "important");
                drow.style.setProperty("flex-wrap", "nowrap", "important");
                drow.style.setProperty("align-items", "center", "important");
              }
              break;
            }
          }
        } catch (e5) {}
      } catch (e) { /* never break the console */ }
    }

    // v21: the four GeneralSettings icon tiles (Language / Theme / Console
    // font size / Desktop Mode) are empty even though the probe proves the
    // svg elements EXIST (v20: setIcon:8 withSvg:8). Force visibility
    // inline (the stylesheet rule alone is not reaching them): explicit
    // 18px, dark ink, fill/stroke following currentColor, opacity 1.
    function fixSettingIcons() {
      try {
        var icons = document.querySelectorAll ? document.querySelectorAll(".index-module__settingIcon__jpeXm") : [];
        for (var i = 0; i < icons.length; i++) {
          var ic = icons[i];
          ic.style.setProperty("color", "#1a1d21", "important");
          var sv = ic.querySelector ? ic.querySelector("svg") : null;
          if (!sv) continue;
          sv.style.setProperty("width", "18px", "important");
          sv.style.setProperty("height", "18px", "important");
          sv.style.setProperty("min-width", "18px", "important");
          sv.style.setProperty("min-height", "18px", "important");
          sv.style.setProperty("color", "#1a1d21", "important");
          sv.style.setProperty("opacity", "1", "important");
          sv.style.setProperty("fill", "currentColor", "important");
          sv.style.setProperty("stroke", "currentColor", "important");
          var parts = sv.querySelectorAll ? sv.querySelectorAll("*") : [];
          for (var q = 0; q < parts.length; q++) {
            parts[q].style.setProperty("fill", "currentColor", "important");
            parts[q].style.setProperty("stroke", "currentColor", "important");
          }
          // v22: missing-sprite fallback. The v21 probe proved the svgs HAVE
          // paths (svgEmpty:0 of 8) yet the four top tiles still paint
          // empty - the likely cause is a <use> pointing at a sprite symbol
          // that is not in the document, or a 0x0 render. If the <use>
          // target is missing or the svg renders 0x0, replace it with a
          // plain text glyph for the row so the tile is never empty.
          // (Lower rows' icons paint fine and are never replaced.)
          try {
            var useEl = sv.querySelector ? sv.querySelector("use") : null;
            var missing = false;
            if (useEl) {
              var href = useEl.getAttribute("href") || useEl.getAttribute("xlink:href") || "";
              if (href && href.charAt(0) === "#" && !document.getElementById(href.slice(1))) missing = true;
            }
            var r0 = sv.getBoundingClientRect ? sv.getBoundingClientRect() : null;
            if (r0 && r0.width === 0 && r0.height === 0) missing = true;
            if (missing) {
              var rowEl = ic;
              for (var rh = 0; rowEl && rowEl !== document.body && rh < 5; rh++) {
                var rc = (rowEl.className || "").toString();
                if (rc.indexOf("settingRow") !== -1) break;
                rowEl = rowEl.parentElement;
              }
              var lab = rowEl ? (rowEl.textContent || "") : "";
              var glyph = null;
              if (lab.indexOf("Language") !== -1) glyph = "A";
              else if (lab.indexOf("Theme") !== -1) glyph = "◐";
              else if (lab.indexOf("font size") !== -1) glyph = "Aa";
              else if (lab.indexOf("Desktop Mode") !== -1) glyph = "▣";
              if (glyph) {
                var gs = document.createElement("span");
                gs.textContent = glyph;
                gs.style.cssText = "font-size:18px;line-height:1;color:#1a1d21;font-weight:600;";
                gs.setAttribute("data-agentx-icon-glyph", "1");
                sv.parentElement.replaceChild(gs, sv);
              }
            }
          } catch (e7) {}
        }
      } catch (e) { /* never break the console */ }
    }

    // v15 [4]: tag PURE-ICON elements so the 30px hit-target floor reaches
    // them. The v13 version only tagged <button>, but several icons ('?' help,
    // trash actions) are spans/anchors. Elements that carry visible text are
    // left alone so real text buttons are never inflated.
    function tagIconButtons() {
      try {
        var els = document.querySelectorAll("button, a, span, [role='button']");
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          if (el.getAttribute("data-agentx-icon-btn") === "1") continue;
          if (!el.querySelector("svg")) continue;
          if ((el.textContent || "").trim() !== "") continue;
          el.setAttribute("data-agentx-icon-btn", "1");
        }
      } catch (e) { /* never break the console */ }
    }

    // v13 [3]: the 'Show compact menu' grid icon is also tiny and faint - give
    // it the same chip treatment as the account-row icon.
    function fixCompactMenuIcon() {
      try {
        var btns = document.querySelectorAll("button, [role='button']");
        for (var i = 0; i < btns.length; i++) {
          var al = (btns[i].getAttribute("aria-label") || "").trim();
          var tl = (btns[i].textContent || "").trim();
          if (al.indexOf("compact") === -1 && tl.indexOf("compact") === -1) continue;
          var sv = btns[i].querySelector("svg");
          if (sv) {
            sv.setAttribute("data-agentx-grid-icon", "1");
            btns[i].setAttribute("data-agentx-icon-btn", "1");
          }
        }
      } catch (e) { /* never break the console */ }
    }

    // v12/v13: the grid/sliders icon lives INSIDE the account pill at its right
    // end. Tag the RIGHTMOST svg in the pill (DOM order is not guaranteed to
    // match the visual right edge).
    function fixSidebarGridButton(row) {
      try {
        var svgs = row.querySelectorAll("svg");
        if (!svgs.length) return;
        var best = null, bestX = -1;
        for (var i = 0; i < svgs.length; i++) {
          var r = null; try { r = svgs[i].getBoundingClientRect(); } catch (e1) {}
          if (r && r.left > bestX) { bestX = r.left; best = svgs[i]; }
        }
        if (best) best.setAttribute("data-agentx-grid-icon", "1");
      } catch (e) { /* never break the console */ }
    }

    function fixAccountRow() {
      try {
        var smalls = document.getElementsByTagName("small");
        var row = null;
        for (var i = 0; i < smalls.length; i++) {
          var t = (smalls[i].textContent || "").trim();
          if (t === "Console account" || t === "Local workspace" || t === "QwenPaw Hub") {
            // The row is the subtitle's nearest button-like ancestor. Do NOT
            // require an <img> here: if the avatar renders as a background or
            // an inline svg, requiring one made the whole fix silently no-op
            // and the row stayed one clipped line (v2 browser FAIL).
            var b = smalls[i].closest ? smalls[i].closest("button") : null;
            if (!b) b = smalls[i].parentElement ? smalls[i].parentElement.parentElement : null;
            if (b) { row = b; break; }
          }
        }
        if (!row) return;
        // Mark the row and its text block so the injected CSS (which uses
        // !important) reinforces these inline styles even after React
        // re-renders and drops the inline ones.
        row.setAttribute("data-agentx-account-row", "1");
        row.style.setProperty("display", "flex", "important");
        row.style.alignItems = "center";
        row.style.flexWrap = "nowrap";
        row.style.gap = "10px";
        row.style.width = "100%";
        row.style.boxSizing = "border-box";
        row.style.overflow = "visible";
        row.style.flex = "none";
        // Tall enough for the avatar AND both stacked text lines, so the
        // subtitle is never pushed out of the pill.
        row.style.minHeight = "48px";
        row.style.padding = "8px 12px";
        // v8: the account row is the popup's LAST row, and a height-capped
        // popup clips its second stacked line at the bottom edge (live v8
        // check showed 'satwik' but a truncated 'Console acco…'). Let the
        // small popup panels grow to their content so the whole 48px row is
        // always inside. Bounded walk, and only panels capped below 720px —
        // never the page's main scroll containers.
        var anc = row.parentElement, hops = 0;
        while (anc && anc !== document.body && hops < 7) {
          var acs = null;
          try { acs = window.getComputedStyle(anc); } catch (eAc) {}
          if (acs) {
            var amh = parseFloat(acs.maxHeight), ahh = parseFloat(acs.height);
            var apos = acs.position;
            var capped = (!isNaN(amh) && amh > 0 && amh < 720) ||
              (!isNaN(ahh) && ahh > 0 && ahh < 720 && (apos === "absolute" || apos === "fixed"));
            if (capped) {
              anc.style.setProperty("max-height", "none", "important");
              anc.style.setProperty("height", "auto", "important");
            }
          }
          anc = anc.parentElement; hops++;
        }
        var spans = row.querySelectorAll("span");
        for (var s = 0; s < spans.length; s++) {
          var sp = spans[s];
          if (sp.querySelector && sp.querySelector("img")) {
            sp.style.flex = "0 0 auto";
            sp.style.width = "32px";
            sp.style.height = "32px";
            sp.style.borderRadius = "50%";
            sp.style.overflow = "hidden";
            sp.style.display = "block";
            var img = sp.querySelector("img");
            img.style.width = "100%";
            img.style.height = "100%";
            img.style.objectFit = "cover";
            img.style.display = "block";
          } else if (sp.querySelector && sp.querySelector("small")) {
            // STACK the name above the subtitle — this is the whole fix. The
            // pill is too narrow for both on one line (measured 'satwik' +
            // 'Conso…' sharing y~945-985), so they must be two lines.
            // !important beats the console's own row layout.
            sp.setAttribute("data-agentx-identity-text", "1");
            sp.style.setProperty("display", "flex", "important");
            sp.style.setProperty("flex-direction", "column", "important");
            sp.style.alignItems = "flex-start";
            sp.style.justifyContent = "center";
            sp.style.flex = "1 1 auto";
            sp.style.minWidth = "0";
            sp.style.gap = "2px";
            sp.style.overflow = "visible";
            sp.style.textAlign = "left";
          }
        }
        var strongs = row.querySelectorAll("strong");
        for (var g = 0; g < strongs.length; g++) {
          strongs[g].style.whiteSpace = "nowrap";
          // No ellipsis — the user must read the name in full.
          strongs[g].style.overflow = "visible";
          strongs[g].style.textOverflow = "clip";
          strongs[g].style.maxWidth = "none";
          strongs[g].style.fontSize = "13px";
          strongs[g].style.lineHeight = "1.3";
          strongs[g].style.fontWeight = "600";
        }
        var smalls2 = row.querySelectorAll("small");
        for (var m = 0; m < smalls2.length; m++) {
          smalls2[m].style.whiteSpace = "nowrap";
          smalls2[m].style.overflow = "visible";
          smalls2[m].style.textOverflow = "clip";
          smalls2[m].style.maxWidth = "none";
          smalls2[m].style.fontSize = "11px";
          smalls2[m].style.lineHeight = "1.3";
          smalls2[m].style.opacity = "0.75";
        }
        var svg = row.querySelector("svg");
        if (svg) svg.style.flex = "0 0 auto";
        // Reserve room: the sidebar becomes a flex column, the row's own
        // wrapper never shrinks or clips, and any scroll container above it
        // takes the remaining space so the footer stays inside the viewport.
        var side2 = findSidebarEl();
        var node = row.parentElement;
        var depth = 0;
        while (node && depth < 10) {
          if (node === row.parentElement) {
            node.style.flex = "none";
            node.style.overflow = "visible";
            node.style.minHeight = "0";
          } else {
            var oy = "";
            try { oy = window.getComputedStyle(node).overflowY; } catch (e) {}
            if (oy === "auto" || oy === "scroll") {
              node.style.flex = "1 1 auto";
              node.style.minHeight = "0";
              node.style.overflowY = "auto";
            }
          }
          if (node === side2) {
            node.style.display = "flex";
            node.style.flexDirection = "column";
            node.style.minHeight = "0";
            break;
          }
          node = node.parentElement;
          depth++;
        }
        // v9: explicitly make the conversation list the scrolling child
        // (min-height:0) so the identity row stays inside the viewport, and
        // inject the visible Detection-Rules count badges.
        if (agentxWide()) fixSidebarScroll(row);
        addRuleCountBadges();
        fixSidebarGridButton(row);
        if (agentxWide()) fixTallNavs();
        fixImages();
        fixShowThinkingRow();
        fixToggleRows();
        fixRadioDescriptions();
        mergeComposerRows();
        startComposerRetry();
        pinAccountFooter(row);
        tagIconButtons();
        fixCompactMenuIcon();
        hideColdOpenThinking();
        fixThemeBars();
        dedupeRowTitles();
        clarifyHeaderIcons();
      } catch (e) { /* never break the console */ }
    }
    addAccountMenuActions();
    fixAccountRow();
    // The sidebar may mount after this script runs (React renders async).
    // The observer covers most of it; these two catch the no-further-
    // mutation case and a late account-row mount.
    // Re-run the DOM-writing rules. React re-renders and SPA navigation both
    // drop/re-create the nodes these rules own, so they are re-asserted on
    // load, on short delays, and on History-API navigation (popstate /
    // hashchange) — the settings pages render without a full page load, which
    // is why the label-truncation fixes must not depend on the first pass.
    function agentxReRunDomRules() {
      var ids = ["account-row", "account-menu", "composer-row", "label-truncation", "system-preview", "hide-per-row-more"];
      for (var i = 0; i < ids.length; i++) { try { agentxRunRuleNow(ids[i]); } catch (e) {} }
    }
    window.addEventListener("load", agentxReRunDomRules);
    setTimeout(agentxReRunDomRules, 800);
    setTimeout(agentxReRunDomRules, 2000);
    window.addEventListener("popstate", agentxReRunDomRules);
    window.addEventListener("hashchange", agentxReRunDomRules);

    // ---- Vault item in the account menu ----
    // The account dropdown (Avatar manager, Appearance, Message display,
    // Settings, ...) is the console's own React dialog (role="dialog",
    // named "Settings"), rendered as a portal at the end of the document
    // and rebuilt every time it opens. A one-off insert would vanish on
    // the next open, so a MutationObserver re-inserts the item on every
    // open.
    //
    // The item is a CLONE of the "Settings" button, not a fresh element:
    // cloning copies the exact classes, so it looks identical to the other
    // items without guessing class names. Only the icon (a lock) and the
    // label ("Vault") change. cloneNode copies attributes, not listeners,
    // so the click is ours alone. Inserted right after "Settings" in the
    // first group.
    function findSettingsDialog() {
      var d = document.querySelector('[role="dialog"][aria-label="Settings"]');
      if (d) return d;
      var dialogs = document.querySelectorAll('[role="dialog"]');
      for (var i = 0; i < dialogs.length; i++) {
        var btns = dialogs[i].querySelectorAll("button");
        for (var j = 0; j < btns.length; j++) {
          if ((btns[j].textContent || "").trim() === "Settings") return dialogs[i];
        }
      }
      return null;
    }
    function addVaultMenuItem() {
      try {
        var dialog = findSettingsDialog();
        if (!dialog) return;
        if (dialog.querySelector("[data-qwenpaw-vault-menu]")) return;
        var buttons = dialog.querySelectorAll("button");
        var settingsBtn = null;
        for (var i = 0; i < buttons.length; i++) {
          if ((buttons[i].textContent || "").trim() === "Settings") { settingsBtn = buttons[i]; break; }
        }
        if (!settingsBtn) return;
        var item = settingsBtn.cloneNode(true);
        item.setAttribute("data-qwenpaw-vault-menu", "1");
        // Swap the gear for a lock. Keep the svg element (its classes size
        // it); only the paths change. Line-style icon, 24x24 like the rest.
        var svg = item.querySelector("svg");
        if (svg) {
          svg.setAttribute("viewBox", "0 0 24 24");
          svg.setAttribute("fill", "none");
          svg.setAttribute("stroke", "currentColor");
          svg.innerHTML = '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>';
        }
        // Relabel. Prefer a bare text node reading "Settings"; else a child
        // element holding the label. If neither is found, do not insert —
        // a second "Settings" would be worse than no Vault item.
        var relabeled = false;
        for (var j = 0; j < item.childNodes.length; j++) {
          var n = item.childNodes[j];
          if (n.nodeType === 3 && (n.textContent || "").trim() === "Settings") {
            n.textContent = "Vault";
            relabeled = true;
            break;
          }
        }
        if (!relabeled) {
          var kids = item.querySelectorAll("*");
          for (var k = 0; k < kids.length; k++) {
            if ((kids[k].textContent || "").trim() === "Settings" && !kids[k].querySelector("svg")) {
              kids[k].textContent = "Vault";
              relabeled = true;
              break;
            }
          }
        }
        if (!relabeled) return;
        item.addEventListener("click", function () {
          try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch (e) {}
          openVaultPopup();
        });
        settingsBtn.parentNode.insertBefore(item, settingsBtn.nextSibling);
      } catch (e) { /* never break the console */ }
    }
    // ---- AgentX rebrand (DOM injection, 2026-11-18) ----
    // The product is AgentX; the upstream console still calls itself
    // QwenPaw. The rename is done here, in the browser, by the same
    // MutationObserver that re-inserts the Vault item — never by rewriting
    // the bundle (immutable, cache-pinned for a year). Worst failure of any
    // rule below is a stale label, never a broken console: every rule runs
    // in its own try/catch, and the whole pass is throttled (leading +
    // trailing, 400 ms) so React re-renders cannot make it a hot loop.
    //
    // NEVER-RENAME allowlist (features/rebrand/README.md): localStorage keys
    // (qwenpaw_auth_token, qwenpaw-agent-storage, qwenpaw-last-used-agent),
    // qwenpaw:* events, the qwenpaw- CSS prefix, QWENPAW_AUTH_ENABLED, the
    // ~/.qwenpaw path, API paths, and the literal pip commands
    // (Install qwenpaw[codex], uv pip install 'qwenpaw[whisper]'). The text
    // pass skips any node whose own or parent text contains one of those
    // load-bearing strings, so setup instructions stay truthful. The
    // multi-window safety prompts ("Close QwenPaw?", "still in use in
    // other windows") are NOT hidden — only their product name is renamed.
    // Kill switches: worker env AGENTX_REBRAND=0 (bakes the flag false) or
    // ?rebrand=0 in the page URL (checked at runtime).
    /* AGENTX-REBRAND-START */
    var AGENTX_MENU_LABELS = ["Tutorial", "Feature Demos", "Changelog", "FAQ", "GitHub", "Documentation", "Import"];
    var AGENTX_CHINA_LABELS = ["DashScope", "SiliconFlow", "ModelScope", "Alibaba", "Alibaba Cloud", "Aliyun", "WeCom", "DingTalk", "Feishu", "QQ", "WeChat", "XiaoYi", "Yuanbao"];
    // Upstream hosts the rebrand blocks (block-links-v2, sidebar-help).
    // Host-substring match on the lowercased URL: the two hosts the old
    // block-links covered by prefix (qwenpaw.agentscope.io docs,
    // github.com/agentscope-ai) are included here too, so one helper
    // answers "is this link upstream?" for every caller. The console's
    // own origins (instabox.tech, pages.dev) contain none of these.
    var AGENTX_UPSTREAM_HOSTS = ["qwenpaw.com", "qwenlm.github.io", "github.com/QwenLM", "discord.gg", "alibabacloud.com", "dashscope.aliyuncs.com", "chat.qwen.ai", "qwenpaw.agentscope.io", "github.com/agentscope-ai"];
    // Model display-name map (model-labels, DISPLAY ONLY — text nodes in
    // the picker/composer; never option values, input values, or anything
    // sent to the API). DOCUMENTED JUDGMENT CALL, needs user
    // confirmation (see features/rebrand/README.md): flash = small/fast
    // tier, so deepseek-v4.1-flash-free displays as AgentX-1-Mini and
    // nex-n2.6 displays as AgentX-1. A label matching neither is left
    // alone. The real model ids are unchanged upstream.
    var AGENTX_MODEL_LABELS = [["deepseek-v4.1-flash-free", "AgentX-1-Mini"], ["nex-n2.6", "AgentX-1"]];
    // Inline favicon (head-rebrand): a minimal URL-encoded SVG with the
    // "AX" mark. Inline data-URI, no external URL, no fetch.
    var AGENTX_FAVICON_DATA = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2316a34a'/%3E%3Ctext x='16' y='21' font-size='13' font-family='sans-serif' font-weight='bold' fill='white' text-anchor='middle'%3EAX%3C/text%3E%3C/svg%3E";
    var AGENTX_LOAD_BEARING = ["qwenpaw[codex]", "qwenpaw[whisper]", "QWENPAW_AUTH_ENABLED", "~/.qwenpaw", "qwenpaw_auth_token", "qwenpaw-agent-storage", "qwenpaw-last-used-agent", "qwenpaw:", "qwenpaw-"];
    var agentxLinkBlockerInstalled = false;
    var agentxLastRun = 0;
    var agentxTrailingTimer = null;
    // True while the body MutationObserver is running a rule pass (A9).
    // The rules write to the DOM, and the observer watches characterData
    // across document.body's subtree, so without this flag each pass
    // re-triggers itself. Declared here (var, same scope as the otheragentx
    // state) so the observer closure and the timer both see one binding.
    var agentxInObserverPass = false;
    function agentxRebrandOff() {
      if (!AGENTX_REBRAND_ENABLED) return true;
      try { return new URLSearchParams(location.search).get("rebrand") === "0"; } catch (e) { return false; }
    }
    function agentxIsLoadBearing(text) {
      if (!text) return false;
      for (var i = 0; i < AGENTX_LOAD_BEARING.length; i++) {
        if (text.indexOf(AGENTX_LOAD_BEARING[i]) !== -1) return true;
      }
      return false;
    }
    function agentxRenameTextIn(root) {
      var walker;
      try { walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null); } catch (e) { return 0; }
      var changed = 0;
      var node;
      while ((node = walker.nextNode())) {
        try {
          var t = node.nodeValue;
          if (!t) continue;
          var parent = node.parentNode;
          if (parent && (parent.nodeName === "SCRIPT" || parent.nodeName === "STYLE" || parent.nodeName === "TEXTAREA" || parent.nodeName === "INPUT")) continue;
          // "AgentScope Platform" (the upstream provider card name) is a
          // display name, never load-bearing: rename it unconditionally.
          // The Models card renders the name TRUNCATED in the DOM
          // ("AgentScope Plat…") — the text node never contains the full
          // phrase — so also rename the truncated form and a bare
          // "AgentScope" token (any truncation length). (2026-11-19 QA
          // round 20 + DOM inspection 2026-11-19 ~07:0x IST: the card's
          // accessible name is "AgentScope Plat… Configure" and no
          // "AgentScope Platform" text exists on the page.)
          if (t.indexOf("AgentScope Platform") !== -1) {
            node.nodeValue = t.split("AgentScope Platform").join("AgentX Platform");
            t = node.nodeValue;
            changed += 1;
          }
          if (t.indexOf("AgentScope Plat…") !== -1) {
            node.nodeValue = t.split("AgentScope Plat…").join("AgentX Plat…");
            t = node.nodeValue;
            changed += 1;
          }
          if (t.indexOf("AgentScope") !== -1) {
            node.nodeValue = t.split("AgentScope").join("AgentX");
            t = node.nodeValue;
            changed += 1;
          }
          if (t.indexOf("QwenPaw") === -1) continue;
          if (agentxIsLoadBearing(t)) continue;
          // Parent check, narrowed (2026-11-19, Community page): the old
          // check skipped a node when ANY descendant of its parent held a
          // load-bearing string, so a whole section (the Community warning
          // + "Connect QwenPaw…" button) survived. Only a code-like parent
          // (CODE/PRE/KBD/SAMP) can make its subtree load-bearing; a plain
          // div/p parent never does.
          if (parent && (parent.nodeName === "CODE" || parent.nodeName === "PRE" || parent.nodeName === "KBD" || parent.nodeName === "SAMP") && parent.textContent && agentxIsLoadBearing(parent.textContent)) continue;
          node.nodeValue = t.split("QwenPaw").join("AgentX");
          changed += 1;
        } catch (e) {}
      }
      return changed;
    }
    function agentxHideExact(label, itemSelector, ancestorSelector) {
      var found = 0;
      var els;
      try { els = document.querySelectorAll(itemSelector); } catch (e) { return 0; }
      for (var i = 0; i < els.length; i++) {
        try {
          var el = els[i];
          if (el.children && el.children.length) continue;
          if ((el.textContent || "").trim() !== label) continue;
          var target = el;
          try {
            var anc = el.closest ? el.closest(ancestorSelector) : null;
            if (anc) target = anc;
          } catch (e) {}
          if (target.getAttribute && target.getAttribute("data-agentx-hidden")) continue;
          target.style.display = "none";
          if (target.setAttribute) target.setAttribute("data-agentx-hidden", "1");
          found += 1;
        } catch (e) {}
      }
      return found;
    }
    function agentxHideAncestorByContent(substring, itemSelector, ancestorSelector) {
      var found = 0;
      var els;
      try { els = document.querySelectorAll(itemSelector); } catch (e) { return 0; }
      for (var i = 0; i < els.length; i++) {
        try {
          var el = els[i];
          if ((el.textContent || "").indexOf(substring) === -1) continue;
          var target = null;
          try { target = el.closest ? el.closest(ancestorSelector) : null; } catch (e) {}
          if (!target) target = el.parentNode && el.parentNode.parentNode ? el.parentNode.parentNode : el;
          if (target.getAttribute && target.getAttribute("data-agentx-hidden")) continue;
          target.style.display = "none";
          if (target.setAttribute) target.setAttribute("data-agentx-hidden", "1");
          found += 1;
        } catch (e) {}
      }
      return found;
    }
    // Climb from a matched element to the container that must be hidden
    // (the button / card / menu item itself, not just the name inside it).
    // Fix 2026-11-18 (browser verification): agentxHideExact only hid the
    // leaf that held the label, so icon-only buttons and provider cards
    // survived as unnamed shells. closest() with the container selector is
    // tried first; when the container carries no matching class, walk up a
    // few levels for a card/item-like ancestor, or for the ancestor that is
    // a direct child of a list/grid (that ancestor IS the card). Returns
    // null when no container is found, so the caller hides the element.
    function agentxClimbToContainer(el, containerSelector) {
      var target = null;
      try { target = el.closest ? el.closest(containerSelector) : null; } catch (e) {}
      if (target) return target;
      var cur = el.parentNode;
      for (var depth = 0; cur && cur.nodeType === 1 && depth < 6; depth++) {
        try {
          var cls = "";
          try { cls = (cur.getAttribute("class") || "").toLowerCase(); } catch (e) {}
          var role = "";
          try { role = cur.getAttribute("role") || ""; } catch (e) {}
          var tag = (cur.tagName || "").toLowerCase();
          if (tag === "li" || role === "listitem" ||
              cls.indexOf("card") !== -1 || cls.indexOf("item") !== -1 ||
              cls.indexOf("listitem") !== -1 || cls.indexOf("provider") !== -1 ||
              cls.indexOf("model") !== -1 || cls.indexOf("channel") !== -1) {
            return cur;
          }
          var parent = cur.parentNode;
          if (parent && parent.nodeType === 1) {
            var pCls = "";
            try { pCls = (parent.getAttribute("class") || "").toLowerCase(); } catch (e) {}
            var pRole = "";
            try { pRole = parent.getAttribute("role") || ""; } catch (e) {}
            var pTag = (parent.tagName || "").toLowerCase();
            if (pRole === "list" || pTag === "ul" || pTag === "ol" ||
                pCls.indexOf("list") !== -1 || pCls.indexOf("grid") !== -1) {
              return cur;
            }
          }
        } catch (e) {}
        cur = cur.parentNode;
      }
      return null;
    }
    // Climb from a matched China name to the CARD that must be hidden —
    // never the list that holds all the cards. Fix 2026-11-18 (live
    // browser re-verification): the old climb hid the WHOLE provider
    // list. Root cause, proven by replaying the real card DOM in the
    // harness: the provider card's class is a hashed CSS module,
    // "index-module__groupCardGlass__-GYEf" — "Card" with a capital C —
    // so the case-sensitive [class*='card'] never matched the card,
    // while [class*='provider'] matched the LIST container
    // "index-module__providerCards__fYCGM" and closest() climbed past
    // the card to the list. The settled page then showed no provider
    // cards at all (the transient snapshots caught the list before the
    // rule ran); SiliconFlow / ModelScope / Aliyun were never hidden as
    // cards. This climb is structural and case-insensitive: the card is
    // the ancestor that is a direct child of the list/grid (the provider
    // list, the channel grid, a role=list, a ul/ol), or — failing that —
    // the first ancestor whose lowercased class names the card itself
    // (groupCardGlass = provider card, channelCard = configured channel
    // card, availableItem = available-channel button), skipping the
    // name-bearing leaves (groupCardName / cardTitle / availableItemName).
    // The list/grid container itself is never returned, so non-China
    // providers (OpenAI, Anthropic, DeepSeek, ...) are never hidden
    // with it. Returns null when no card is found, so the caller hides
    // the matched element itself.
    function agentxClimbToChinaCard(el) {
      var cur = el;
      for (var depth = 0; cur && cur.nodeType === 1 && depth < 8; depth++) {
        var parent = cur.parentNode;
        if (parent && parent.nodeType === 1) {
          var pCls = "";
          try { pCls = (parent.getAttribute("class") || "").toLowerCase(); } catch (e) {}
          var pRole = "";
          try { pRole = parent.getAttribute("role") || ""; } catch (e) {}
          var pTag = (parent.tagName || "").toLowerCase();
          if (pCls.indexOf("providercards") !== -1 || pCls.indexOf("availablegrid") !== -1 ||
              pCls.indexOf("channelsgrid") !== -1 || pRole === "list" ||
              pTag === "ul" || pTag === "ol" ||
              pCls.indexOf("list") !== -1 || pCls.indexOf("grid") !== -1) {
            return cur;
          }
        }
        cur = parent;
      }
      cur = el;
      for (var d2 = 0; cur && cur.nodeType === 1 && d2 < 8; d2++) {
        var cls = "";
        try { cls = (cur.getAttribute("class") || "").toLowerCase(); } catch (e) {}
        if (cls.indexOf("providercards") !== -1 || cls.indexOf("availablegrid") !== -1 ||
            cls.indexOf("channelsgrid") !== -1) { cur = cur.parentNode; continue; }
        if (cls.indexOf("groupcardname") !== -1 || cls.indexOf("cardtitle") !== -1 ||
            cls.indexOf("availableitemname") !== -1) { cur = cur.parentNode; continue; }
        if (cls.indexOf("groupcardglass") !== -1 || cls.indexOf("channelcard") !== -1 ||
            cls.indexOf("availableitem") !== -1) {
          return cur;
        }
        cur = cur.parentNode;
      }
      return null;
    }
    // Hide every element whose ACCESSIBLE NAME matches a label — not just
    // elements whose visible text equals it. Fix 2026-11-18 (browser
    // verification): the header Documentation/GitHub buttons and the five
    // Settings-menu icon buttons have no text at all, only an accessible
    // name (aria-label / title), and the China channel cards likewise
    // carry the name as an accessible name while showing only an icon +
    // Configure. The name is read from aria-label, then title, then alt
    // (img), then the element's own text. A name from an attribute may
    // match as a whole word ("Open GitHub" matches "GitHub"); a name from
    // text must match exactly, so a container whose text merely contains
    // a label among other items is never hidden. The container found by
    // the climb function is hidden, not the name element alone. The
    // optional climbFn (2026-11-18, hide-china) replaces
    // agentxClimbToContainer for callers whose cards the generic climb
    // cannot find — it must never return a list container.
    // Matching is CASE-INSENSITIVE (fix 2026-11-18, live browser
    // re-verification #3): the XiaoYi channel survived because the label
    // list spelled it "Xiaoyi" while the console renders the display name
    // "XiaoYi" and the channel icon img alt is the lowercase id "xiaoyi"
    // — "Xiaoyi" occurs ZERO times in the live main bundle, so a
    // case-sensitive match could never fire on either path. The other
    // five China channels hide because their display names match the
    // labels exactly; only XiaoYi differs in case. Lowercasing both
    // sides also covers the icon-alt path (alt is always the lowercase
    // channel id) and any future casing drift in a display name.
    function agentxHideByName(labels, itemSelector, containerSelector, climbFn) {
      var found = 0;
      var els;
      try { els = document.querySelectorAll(itemSelector); } catch (e) { return 0; }
      for (var i = 0; i < els.length; i++) {
        try {
          var el = els[i];
          var name = "";
          var fromAttr = false;
          try { name = el.getAttribute("aria-label") || ""; } catch (e) {}
          if (!name) { try { name = el.getAttribute("title") || ""; } catch (e) {} }
          if (!name) { try { name = el.getAttribute("alt") || ""; } catch (e) {} }
          if (name) fromAttr = true;
          if (!name) { try { name = (el.textContent || "").trim(); } catch (e) {} }
          if (!name) continue;
          var matched = false;
          var nameLower = "";
          try { nameLower = name.toLowerCase(); } catch (e) { nameLower = name; }
          for (var j = 0; j < labels.length; j++) {
            var label = labels[j];
            var labelLower = "";
            try { labelLower = label.toLowerCase(); } catch (e) { labelLower = label; }
            if (nameLower === labelLower) { matched = true; break; }
            if (fromAttr) {
              if (label.indexOf(" ") !== -1) {
                if (nameLower.indexOf(labelLower) !== -1) { matched = true; break; }
              } else {
                var words = nameLower.split(/[^a-z0-9]+/);
                for (var k = 0; k < words.length; k++) {
                  if (words[k] === labelLower) { matched = true; break; }
                }
                if (matched) break;
              }
            }
          }
          if (!matched) continue;
          var target = null;
          try {
            target = climbFn ? climbFn(el) : agentxClimbToContainer(el, containerSelector);
          } catch (e) { target = null; }
          if (!target) target = el;
          if (target.getAttribute && target.getAttribute("data-agentx-hidden")) continue;
          target.style.display = "none";
          if (target.setAttribute) target.setAttribute("data-agentx-hidden", "1");
          found += 1;
        } catch (e) {}
      }
      return found;
    }
    // About item click: delegated, capture-phase, on document. Fix
    // 2026-11-18 (browser verification): the old rule attached a listener
    // to a leaf whose text was EXACTLY "About QwenPaw" / "About AgentX",
    // but the real label carries the version ("About QwenPaw v2.3.0"), so
    // it never matched and clicking About only closed the menu. This one
    // matches by PREFIX ("About QwenPaw" / "About AgentX", version suffix
    // allowed) and walks up from the click target, so it works whether the
    // item is a button, an li, or a div, and whether the click lands on
    // the icon, the text, or the row. Capture phase runs before the
    // menu's own handler, so the upstream navigation never happens; the
    // menu is closed with a best-effort Escape keypress (the menu would
    // otherwise stay open, because its own handler never runs).
    var agentxAboutInstalled = false;
    function agentxAboutRule() {
      if (agentxAboutInstalled) return 0;
      try {
        document.addEventListener("click", function (ev) {
          try {
            var cur = ev.target;
            for (var depth = 0; cur && depth < 8; depth++) {
              try {
                if (cur.nodeType === 1) {
                  var t = (cur.textContent || "").trim();
                  if (t && t.length < 40 &&
                      (t.indexOf("About QwenPaw") === 0 || t.indexOf("About AgentX") === 0)) {
                    try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
                    try { window.open("/status", "_blank"); } catch (e) {}
                    try {
                      var esc = null;
                      if (typeof KeyboardEvent === "function") esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
                      else if (document.createEvent) { esc = document.createEvent("Event"); esc.initEvent("keydown", true, true); esc.key = "Escape"; }
                      if (esc) document.dispatchEvent(esc);
                    } catch (e) {}
                    return;
                  }
                }
              } catch (e) {}
              cur = cur.parentNode;
            }
          } catch (e) {}
        }, true);
        agentxAboutInstalled = true;
        return 1;
      } catch (e) { return 0; }
    }
    // Title watcher: rename document.title the moment the app sets it.
    // Fix 2026-11-18 (browser verification): on navigation the title
    // first read "Settings · QwenPaw" and only flipped to AgentX seconds
    // later, because the body MutationObserver only runs the pass when a
    // body mutation happens. A title change does not mutate the body, so
    // the rename waited for the next re-render. This observer watches the
    // <title> element itself, so the rename is immediate. Setting the
    // title inside the callback re-fires the observer, but the title no
    // longer contains "QwenPaw", so it is a no-op, not a loop. A brief
    // flash can still occur if the app sets the title between the
    // observer's microtask and the rename — that is a known limitation,
    // not chased with a timer loop (quota rule: no wall-clock polling).
    var agentxTitleWatcherInstalled = false;
    function agentxWatchTitle() {
      if (agentxTitleWatcherInstalled) return 0;
      try {
        var titleEl = document.querySelector("title");
        if (!titleEl || typeof MutationObserver !== "function") return 0;
        var titleObserver = new MutationObserver(function () {
          try {
            if (document.title && document.title.indexOf("QwenPaw") !== -1) {
              document.title = document.title.split("QwenPaw").join("AgentX");
            }
          } catch (e) {}
        });
        titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
        agentxTitleWatcherInstalled = true;
        return 1;
      } catch (e) { return 0; }
    }
    // Upstream-host test (block-links-v2, sidebar-help): host-substring
    // match on the lowercased URL, so casing and path/query never matter.
    // A relative URL has no host and never matches.
    function agentxIsUpstreamHref(href) {
      if (!href) return false;
      var h = "";
      try { h = href.toLowerCase(); } catch (e) { h = href; }
      for (var i = 0; i < AGENTX_UPSTREAM_HOSTS.length; i++) {
        if (h.indexOf(AGENTX_UPSTREAM_HOSTS[i].toLowerCase()) !== -1) return true;
      }
      return false;
    }
    function agentxBlockUpstreamLinks() {
      if (agentxLinkBlockerInstalled) return;
      try {
        document.addEventListener("click", function (ev) {
          try {
            var t = ev.target;
            var el = null;
            try { el = t && t.closest ? t.closest("a[href], [data-url], [data-href], form[action]") : null; } catch (e) {}
            if (!el) return;
            // Every URL the clicked element carries: a link can show a
            // harmless href while its data-url / data-href / form action
            // points upstream, so check all of them, not just the first.
            var urls = [];
            try {
              var href = el.getAttribute("href") || "";
              var durl = el.getAttribute("data-url") || "";
              var dhref = el.getAttribute("data-href") || "";
              var act = el.getAttribute("action") || "";
              if (href) urls.push(href);
              if (durl) urls.push(durl);
              if (dhref) urls.push(dhref);
              if (act) urls.push(act);
            } catch (e) {}
            for (var i = 0; i < urls.length; i++) {
              if (urls[i].indexOf(AGENTX_UPSTREAM_DOC) === 0 || urls[i].indexOf(AGENTX_UPSTREAM_GITHUB) === 0 || agentxIsUpstreamHref(urls[i])) {
                ev.preventDefault();
                ev.stopPropagation();
                return;
              }
            }
          } catch (e) {}
        }, true);
        agentxLinkBlockerInstalled = true;
      } catch (e) {}
    }
    // Hide the ROW/CARD holding a short label (hide-powered-by,
    // hide-upgrade, hide-run-in, hide-onboarding, hide-update-banner,
    // hide-shortcuts-dialog). LEAF-ONLY: an element with element children
    // is skipped, so a big container whose text merely contains the label
    // among other content is never hidden — only the leaf holding the
    // label, climbed to its row/card, is. A multi-word label matches as
    // a substring ("Update available" inside "Update available — v2.3.1");
    // a single-word label must match the whole trimmed text, so
    // "Upgrades" never matches "Upgrade" and "Shortcut keys" never
    // matches "Shortcuts". The climb never returns a list container
    // (agentxClimbToContainer skips lists; the closest() selector names
    // rows/cards only). React-safe: display:none on the row, no node
    // moves, no removals. Labels carrying QwenPaw are listed in BOTH
    // spellings: rename-text runs before these rules and already made
    // them "AgentX", so matching only "QwenPaw" would never fire.
    function agentxHideRowByText(substrings, itemSelector, containerSelector) {
      var found = 0;
      var els;
      try { els = document.querySelectorAll(itemSelector); } catch (e) { return 0; }
      for (var i = 0; i < els.length; i++) {
        try {
          var el = els[i];
          if (el.children && el.children.length) continue;
          var t = "";
          try { t = (el.textContent || "").trim(); } catch (e) {}
          if (!t || t.length > 160) continue;
          var tLower = "";
          try { tLower = t.toLowerCase(); } catch (e) { tLower = t; }
          var matched = false;
          for (var j = 0; j < substrings.length; j++) {
            var s = substrings[j];
            var sLower = "";
            try { sLower = s.toLowerCase(); } catch (e) { sLower = s; }
            if (sLower.indexOf(" ") !== -1) { if (tLower.indexOf(sLower) !== -1) { matched = true; break; } }
            else if (tLower === sLower) { matched = true; break; }
          }
          if (!matched) continue;
          var target = null;
          try { target = el.closest ? el.closest(containerSelector) : null; } catch (e) {}
          if (!target) { try { target = agentxClimbToContainer(el, containerSelector); } catch (e) {} }
          if (!target) target = el;
          if (target.getAttribute && target.getAttribute("data-agentx-hidden")) continue;
          target.style.display = "none";
          if (target.setAttribute) target.setAttribute("data-agentx-hidden", "1");
          found += 1;
        } catch (e) {}
      }
      return found;
    }
    // Rename a NEEDLE ("QwenPaw", or a longer phrase) in text nodes whose
    // ancestor chain matches markerFn — the scoped rename used by the
    // Settings / account / workspace / auth / error rules. React-safe:
    // text-node VALUES only, never attributes, never inputs, never
    // load-bearing strings (install commands, env vars, storage keys).
    // The REPLACEMENT is the needle's renamed form ("About AgentX" for
    // the needle "About QwenPaw" — splitting on the needle and joining
    // with plain "AgentX" would drop the word "About").
    function agentxRenameScoped(needle, markerFn, replacement) {
      var rep = replacement || "AgentX";
      var renamed = 0;
      var walker;
      try { walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null); } catch (e) { return 0; }
      var node;
      while ((node = walker.nextNode())) {
        try {
          var t = node.nodeValue;
          if (!t || t.indexOf(needle) === -1) continue;
          var parent = node.parentNode;
          if (parent && (parent.nodeName === "SCRIPT" || parent.nodeName === "STYLE" || parent.nodeName === "TEXTAREA" || parent.nodeName === "INPUT")) continue;
          if (agentxIsLoadBearing(t)) continue;
          var cur = parent;
          var scoped = false;
          for (var d = 0; cur && d < 8; d++) {
            try { if (markerFn(cur)) { scoped = true; break; } } catch (e) {}
            cur = cur.parentNode;
          }
          if (!scoped) continue;
          node.nodeValue = t.split(needle).join(rep);
          renamed += 1;
        } catch (e) {}
      }
      return renamed;
    }
    // Rename a NEEDLE in every text node in the body (same guards as
    // agentxRenameScoped, no scope check). Used when the page itself is
    // the scope — e.g. the rule already knows the pathname is
    // /settings/models — so the scoped walk would only repeat the test.
    function agentxRenameNeedleInBody(needle, replacement) {
      var rep = replacement || "AgentX";
      var renamed = 0;
      var walker;
      try { walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null); } catch (e) { return 0; }
      var node;
      while ((node = walker.nextNode())) {
        try {
          var t = node.nodeValue;
          if (!t || t.indexOf(needle) === -1) continue;
          var parent = node.parentNode;
          if (parent && (parent.nodeName === "SCRIPT" || parent.nodeName === "STYLE" || parent.nodeName === "TEXTAREA" || parent.nodeName === "INPUT")) continue;
          if (agentxIsLoadBearing(t)) continue;
          node.nodeValue = t.split(needle).join(rep);
          renamed += 1;
        } catch (e) {}
      }
      return renamed;
    }
    // Scope marker shared by the Settings rules: an ancestor whose
    // class / aria-label / title names the section (word). Deliberately
    // NOT textContent: a shared ancestor's text contains every label in
    // its subtree ("Settings" in a menu that also holds an About row
    // would false-positive), while a class/aria-label names the section
    // itself. Sibling headings are never ancestors, so they cannot scope
    // a rule — the section's own class/aria-label must carry the name.
    function agentxScopeMarker(el, words) {
      try {
        var cls = "";
        try { cls = (el.getAttribute("class") || "").toLowerCase(); } catch (e) {}
        var lab = "";
        try { lab = ((el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "")).toLowerCase(); } catch (e) {}
        for (var i = 0; i < words.length; i++) {
          if (cls.indexOf(words[i]) !== -1 || lab.indexOf(words[i]) !== -1) return true;
        }
      } catch (e) {}
      return false;
    }
    // Per-chat thinking level (2026-11-18): state + API helpers for the
    // "thinking-selector" rule. The backend already supports per-chat
    // thinking end to end (GET/PUT /api/chats/{id}/thinking); the rule
    // only surfaces it as a selector next to the composer controls.
    // Levels offered: Default (inherit), Off, Low, Medium, High, XHigh.
    // A level the server reports outside that set (minimal/max/budget)
    // is shown by adding an option for it, so the select never lies.
    var agentxThinkingState = { chatId: null, level: null, modelKey: null, pending: null, syncChatId: null, seq: 0 };
    function agentxThinkingHeaders() {
      var t = "";
      try { t = window.localStorage ? (window.localStorage.getItem("qwenpaw_auth_token") || "") : ""; } catch (e) {}
      var h = { "Content-Type": "application/json" };
      if (t) h["Authorization"] = "Bearer " + t;
      return h;
    }
    function agentxThinkingChatId() {
      try {
        var p = window.location ? window.location.pathname || "" : "";
        var parts = p.split("/");
        if (parts.length > 2 && parts[1] === "chat" && parts[2]) return parts[2];
      } catch (e) {}
      return null;
    }
    function agentxThinkingShow(level) {
      try {
        var sel = document.querySelector ? document.querySelector("[data-agentx-thinking]") : null;
        if (!sel || !level) return;
        var has = false;
        for (var i = 0; i < sel.options.length; i++) { if (sel.options[i].value === level) { has = true; break; } }
        if (!has) {
          var o = document.createElement("option");
          o.value = level;
          o.textContent = level.charAt(0).toUpperCase() + level.slice(1);
          sel.appendChild(o);
        }
        sel.value = level;
      } catch (e) {}
    }
    function agentxThinkingNote(text) {
      // Show a one-line reason next to the selector (2026-11-19: a PUT
      // 422 reverted silently — the user saw Default again with no
      // explanation). No timer (the harness forbids timers here):
      // the note stays until the next successful save or chat change
      // clears it. React-safe: our own span, appended only, hidden via
      // style (never removed).
      try {
        var st = agentxThinkingState;
        var note = st.noteEl;
        if (!note || !note.parentElement) {
          var sel = document.querySelector ? document.querySelector("[data-agentx-thinking]") : null;
          if (!sel || !sel.parentElement) return;
          note = document.createElement("span");
          note.setAttribute("data-agentx-thinking-note", "1");
          note.style.cssText = "font-size:11px;color:#f87171;margin-left:6px;white-space:nowrap;flex:none;max-width:260px;overflow:hidden;text-overflow:ellipsis;";
          sel.parentElement.appendChild(note);
          st.noteEl = note;
        }
        note.textContent = text || "";
        note.style.display = "";
      } catch (e) {}
    }
    function agentxThinkingClearNote() {
      try {
        var note = agentxThinkingState.noteEl;
        if (note) note.style.display = "none";
      } catch (e) {}
    }
    function agentxThinkingSync(force) {
      // Pull the server's stored level for the current chat and show it.
      // Applies a pending level (picked on a brand-new chat with no id
      // yet) once the chat has an id. Skips when a sync for this chat is
      // already in flight, and never overwrites a choice the user made
      // meanwhile (generation counter).
      try {
        var chatId = agentxThinkingChatId();
        var st = agentxThinkingState;
        if (!chatId) return;
        // A note belongs to the chat it was shown on: clear it when the
        // chat changes, but NOT on the same-chat re-sync after a 422
        // (that would erase the explanation just shown).
        if (st.chatId !== chatId) agentxThinkingClearNote();
        if (!force && st.chatId === chatId && st.level !== null) return;
        if (st.syncChatId === chatId) return;
        st.chatId = chatId;
        st.syncChatId = chatId;
        var seq = st.seq;
        fetch("/api/chats/" + chatId + "/thinking", { headers: agentxThinkingHeaders() })
          .then(function (r) { if (!r.ok) return null; return r.json(); })
          .then(function (v) {
            st.syncChatId = null;
            if (!v || seq !== st.seq) return;
            if (v.model_key) st.modelKey = v.model_key;
            var lvl = (v.value && v.value.level) ? v.value.level : "inherit";
            st.level = lvl;
            agentxThinkingShow(lvl);
            // Lock hint (2026-11-19): the GET reports the model's
            // thinking control. kind "unknown" with no efforts means
            // this model takes no thinking level — say so on the
            // selector instead of letting every pick 422 silently. A
            // capable model restores the default title.
            try {
              var _sel = document.querySelector ? document.querySelector("[data-agentx-thinking]") : null;
              if (_sel) {
                if (v.control && v.control.kind === "unknown" && (!v.control.efforts || v.control.efforts.length === 0)) {
                  _sel.title = "Thinking depth cannot be adjusted for this model";
                } else {
                  _sel.title = "Thinking level for this chat — Default follows the model, Off disables thinking";
                }
              }
            } catch (e) {}
            if (st.pending && st.pending !== lvl) {
              var pend = st.pending;
              st.pending = null;
              try { window.localStorage.removeItem("agentx_thinking_pending"); } catch (e) {}
              agentxThinkingSave(pend);
            }
          })
          .catch(function () { st.syncChatId = null; });
      } catch (e) {}
    }
    function agentxThinkingSave(level) {
      // Persist the user's choice for the current chat. No id yet (new
      // chat): hold it as pending — the next sync, once the first message
      // creates the chat, applies it. The first turn of a brand-new chat
      // therefore still uses the default; the second turn uses the pick.
      try {
        var st = agentxThinkingState;
        var prev = st.level;
        st.seq++;
        st.level = level;
        var chatId = agentxThinkingChatId();
        if (!chatId) {
          st.pending = level;
          try { window.localStorage.setItem("agentx_thinking_pending", level); } catch (e) {}
          return;
        }
        st.pending = null;
        try { window.localStorage.removeItem("agentx_thinking_pending"); } catch (e) {}
        var url = "/api/chats/" + chatId + "/thinking";
        if (st.modelKey) url += "?model_key=" + encodeURIComponent(st.modelKey);
        fetch(url, { method: "PUT", headers: agentxThinkingHeaders(), body: JSON.stringify({ level: level }) })
          .then(function (r) {
            if (r.status === 409 || r.status === 422) {
              // Read the server's reason and SHOW it: a silent revert
              // (2026-11-19) left the user with Default and no
              // explanation. st.chatId is left alone so the re-sync
              // below does not clear the note it just showed.
              return r.json().catch(function () { return null; }).then(function (v) {
                var detail = (v && (v.detail || v.message)) || "Thinking setting is invalid for this model";
                agentxThinkingNote(detail);
                st.level = null;
                agentxThinkingSync(true);
                return null;
              });
            }
            if (!r.ok) { st.level = prev; agentxThinkingShow(prev); return null; }
            return r.json();
          })
          .then(function (v) {
            if (!v) return;
            if (v.model_key) st.modelKey = v.model_key;
            if (v.value && v.value.level) { st.level = v.value.level; agentxThinkingShow(st.level); agentxThinkingClearNote(); }
          })
          .catch(function () { st.level = prev; agentxThinkingShow(prev); });
      } catch (e) {}
    }
    var AGENTX_RULES = [
      { id: "rename-title", run: function () {
        if (document.title && document.title.indexOf("QwenPaw") !== -1) document.title = document.title.split("QwenPaw").join("AgentX");
      } },
      { id: "rename-attrs", run: function () {
        // rename-attrs-v2 (2026-11-19): also covers alt and data-tooltip.
        // IMG elements are SKIPPED here — the logo rule owns img
        // attributes (alt/title/aria-label): if this rule renamed the
        // logo img's alt to AgentX first, rename-logo's
        // img[alt*="QwenPaw"] selector would never match and the logo
        // would never be swapped for the AgentX wordmark.
        var els;
        try { els = document.querySelectorAll('[aria-label*="QwenPaw"], [placeholder*="QwenPaw"], [title*="QwenPaw"], [alt*="QwenPaw"], [data-tooltip*="QwenPaw"]'); } catch (e) { return; }
        for (var i = 0; i < els.length; i++) {
          try {
            var el = els[i];
            if (el.tagName === "IMG") continue;
            var a = el.getAttribute("aria-label");
            if (a && a.indexOf("QwenPaw") !== -1) el.setAttribute("aria-label", a.split("QwenPaw").join("AgentX"));
            var p = el.getAttribute("placeholder");
            if (p && p.indexOf("QwenPaw") !== -1) el.setAttribute("placeholder", p.split("QwenPaw").join("AgentX"));
            var t = el.getAttribute("title");
            if (t && t.indexOf("QwenPaw") !== -1) el.setAttribute("title", t.split("QwenPaw").join("AgentX"));
            var al = el.getAttribute("alt");
            if (al && al.indexOf("QwenPaw") !== -1) el.setAttribute("alt", al.split("QwenPaw").join("AgentX"));
            var dt = el.getAttribute("data-tooltip");
            if (dt && dt.indexOf("QwenPaw") !== -1) el.setAttribute("data-tooltip", dt.split("QwenPaw").join("AgentX"));
          } catch (e) {}
        }
      } },
      { id: "rename-text", run: function () {
        try { agentxRenameTextIn(document.body); } catch (e) {}
      } },
      { id: "fix-grammar", run: function () {
        // Upstream console grammar (2026-11-18 QA): "Completed 1 steps"
        // and "1 providers online" — the count is 1 but the noun is
        // plural. Fix the singular forms in text nodes; other counts
        // ("2 steps", "3 providers") are already correct and untouched.
        // Regex with \s+ (not a literal space): the DOM inspection
        // showed the tree rendering "1providers online" with the space
        // dropped, so the separator may be a non-breaking space or
        // another whitespace character, and a literal "1 providers"
        // split never matches it (QA round 4).
        // Split-node case (QA round 2): React renders the count and the
        // label in SEPARATE text nodes ("1" | " providers online"), so
        // a single-node "1 providers" never matches. Collect the text
        // nodes in document order first, then fix a "providers" node
        // whose immediately preceding text node ends with "1".
        try {
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          var nodes = [];
          var node;
          while ((node = walker.nextNode())) nodes.push(node);
          for (var i = 0; i < nodes.length; i++) {
            try {
              var n = nodes[i];
              var t = n.nodeValue;
              if (!t) continue;
              var fixed = t.replace(/1\\s+steps/g, "1 step").replace(/1\\s+providers/g, "1 provider");
              if (fixed !== t) { n.nodeValue = fixed; continue; }
              if (t.indexOf("providers") !== -1 && i > 0) {
                // Split-node case: React may render the count and the
                // label in SEPARATE text nodes, but not necessarily
                // adjacent — there can be whitespace-only or empty text
                // nodes between them ("1" | " " | " providers online").
                // Walk backwards past whitespace-only nodes and fix the
                // "providers" node when the first non-whitespace node
                // before it ends with "1".
                var j = i - 1;
                var prevText = "";
                while (j >= 0) {
                  var cand = nodes[j] ? (nodes[j].nodeValue || "") : "";
                  if (/^\\s*$/.test(cand)) { j--; continue; }
                  prevText = cand;
                  break;
                }
                if (/\\b1\\s*$/.test(prevText)) {
                  n.nodeValue = t.split("providers").join("provider");
                }
              }
            } catch (e) {}
          }
        } catch (e) {}
      } },
      { id: "sidebar-ellipsis", run: function () {
        // Sidebar conversation titles (2026-11-18 QA + DOM inspection):
        // titles are cut mid-word with NO ellipsis ("Print Numbers 1 to
        // 20C", "Checking assistant avai"), and the "…" More actions
        // button sits on top of the last character. The rows are NOT
        // <a href="/chat/..."> — they are <button> elements (role
        // button, no href) in the left sidebar, each holding the title
        // text plus a small status <img> (alt "Idle") and a duplicate
        // title for the tooltip. The title is clipped at ~x200 by the
        // button's own overflow (not only by the More actions button,
        // which is a separate sibling that appears on hover). Give the
        // row buttons an ellipsis and right padding so the More actions
        // button has room and the cut reads as "…" instead of a clipped
        // word. The title text may live in a child span/div inside the
        // button (the a11y tree lists no wrapper, but React usually
        // wraps it), so the ellipsis goes on the button AND on any
        // text-bearing child.
        // SHADOW-DOM (2026-11-18 QA rounds 5–14): the rule never took
        // effect in 9 rounds even though the code is deployed and the
        // observer + timer both call it. The remaining explanation is
        // that the sidebar lives in a SHADOW ROOT (or an iframe-like
        // encapsulated subtree) that document.querySelectorAll cannot
        // see — other rules work because they target main-document
        // elements. So collect buttons by walking the whole tree and
        // descending into every shadowRoot.
        function collectButtons(root, out) {
          try {
            var list = root.querySelectorAll ? root.querySelectorAll("button,[role='button']") : [];
            for (var i = 0; i < list.length; i++) out.push(list[i]);
            var all = root.querySelectorAll ? root.querySelectorAll("*") : [];
            for (var j = 0; j < all.length; j++) {
              try {
                var sr = all[j].shadowRoot;
                if (sr) collectButtons(sr, out);
              } catch (e) {}
            }
          } catch (e) {}
          return out;
        }
        // SCOPE TO THE SIDEBAR ONLY (2026-11-18 QA round 17): the rule
        // ran on EVERY button on the page (the left gate was removed in
        // round 15), and the /chat main pane started crashing with a
        // React error boundary ("Something went wrong") on every load —
        // the rule's node-moving wrap step and recursive truncation were
        // touching main-pane buttons React owns, breaking its
        // reconciliation. Find the sidebar container (the element
        // holding the "Conversation History" heading) and only process
        // buttons inside it; main-pane buttons are left entirely alone.
        // The wrap step is REMOVED (it moved text nodes into new spans,
        // changing the DOM shape React expects); truncation alone is
        // sufficient now that the script parses (round 17 sidebar PASS).
        function findSidebarScope() {
          try {
            var els = document.querySelectorAll ? document.querySelectorAll("*") : [];
            for (var i = 0; i < els.length; i++) {
              try {
                var t = els[i].textContent || "";
                if (t.indexOf("Conversation History") !== -1) {
                  // Walk up to a nav/aside/section, or the nearest
                  // ancestor that looks like the sidebar column.
                  var n = els[i];
                  for (var d = 0; d < 6 && n; d++) {
                    var tag = (n.tagName || "").toUpperCase();
                    if (tag === "NAV" || tag === "ASIDE" || tag === "SECTION") return n;
                    n = n.parentElement;
                  }
                  return els[i].parentElement || document;
                }
              } catch (e) {}
            }
          } catch (e) {}
          return null;
        }
        try {
          var scope = findSidebarScope();
          var btns = scope ? collectButtons(scope, []) : [];
          for (var i = 0; i < btns.length; i++) {
            try {
              var b = btns[i];
              // NO early skip on data-agentx-ellipsis (2026-11-18 QA
              // rounds 5–12): React re-renders and RESETS the text
              // node to the full title, but the attribute survives (it
              // is not a React prop), so a skip meant the rule ran once
              // and never re-truncated after React reverted it. The
              // truncation below is idempotent (it skips text already
              // containing "…"), so re-running is safe. The wrapping is
              // guarded separately (see below).
              var name = "";
              try { name = (b.getAttribute("aria-label") || "") + " " + (b.textContent || ""); } catch (e) {}
              if (/more actions/i.test(name)) continue;
              if (/^\\s*(new task|new group|conversation history|by source|manage group)\\s*$/i.test((b.textContent || "").trim())) continue;
              var left = -1;
              try { left = b.getBoundingClientRect ? b.getBoundingClientRect().left : -1; } catch (e) {}
              var txt = (b.textContent || "").trim();
              if (txt.length < 3) continue;
              if (b.setAttribute) b.setAttribute("data-agentx-ellipsis", "1");
              b.style.overflow = "hidden";
              b.style.textOverflow = "ellipsis";
              b.style.whiteSpace = "nowrap";
              b.style.paddingRight = "30px";
              b.style.boxSizing = "border-box";
              b.style.maxWidth = "100%";
              // TRUNCATE FIRST, by length alone (2026-11-18 DOM
              // inspection: the row button is only ~179px wide, not
              // 228px — a 22-char title already overflows, so the old
              // 24-char threshold never fired for it, and the clipping
              // is at a parent container so no overflow measurement can
              // detect it). Cut the longest direct text node to 15
              // chars + "…" when it exceeds 16 chars. This runs before
              // any wrapping, so it cannot be skipped by it.
              // RECURSIVE (2026-11-18 QA round 14): the title may live
              // inside a child element (span/div) rather than as a
              // direct text node, so truncate EVERY text node in the
              // button's subtree, not only direct children.
              try {
                (function truncAll(node) {
                  try {
                    var ch = node.childNodes;
                    for (var q = 0; q < ch.length; q++) {
                      var cn = ch[q];
                      if (cn && cn.nodeType === 3) {
                        var vv = cn.nodeValue || "";
                        if (vv.length > 16 && vv.indexOf("…") === -1) {
                          cn.nodeValue = vv.slice(0, 15).replace(/\\s+$/, "") + "…";
                        }
                      } else if (cn && cn.nodeType === 1) {
                        truncAll(cn);
                      }
                    }
                  } catch (e) {}
                })(b);
              } catch (e) {}
              try {
                var direct = b.childNodes;
                for (var d = 0; d < direct.length; d++) {
                  var dt = direct[d];
                  if (dt && dt.nodeType === 3 && (dt.nodeValue || "").length > 16 && (dt.nodeValue || "").indexOf("…") === -1) {
                    dt.nodeValue = dt.nodeValue.slice(0, 15).replace(/\\s+$/, "") + "…";
                  }
                }
              } catch (e) {}
              var kids = b.querySelectorAll ? b.querySelectorAll("*") : [];
              for (var j = 0; j < kids.length; j++) {
                try {
                  var k = kids[j];
                  if (!k.textContent || !k.textContent.trim()) continue;
                  var tag = (k.tagName || "").toUpperCase();
                  if (tag === "IMG" || tag === "BUTTON" || tag === "INPUT" || tag === "SVG") continue;
                  k.style.overflow = "hidden";
                  k.style.textOverflow = "ellipsis";
                  k.style.whiteSpace = "nowrap";
                  k.style.maxWidth = "100%";
                  // Flex-item floor: in a flex row a text child will
                  // NOT shrink below its content size unless min-width
                  // is 0, so without this the title overflows (clipped
                  // mid-word, no ellipsis) instead of truncating.
                  k.style.minWidth = "0";
                  k.style.flexShrink = "1";
                  // Ellipsis only works on a block container. If the
                  // title lives in an inline element (span) inside a
                  // flex button, the inline box never truncates — make
                  // it a block so the ellipsis engages.
                  if (tag === "SPAN") k.style.display = "block";
                } catch (e) {}
              }
              // WRAP STEP REMOVED (2026-11-18 QA round 17): wrapping
              // moved the title text node into a new <span>, changing
              // the DOM shape React expects — the /chat main pane then
              // crashed with a React error boundary on every load.
              // Truncation (text-node value only, no node moves) is
              // sufficient now that the script parses (round 17 sidebar
              // PASS) and is safe: React overwrites a changed text node
              // on re-render, it never crashes on one.
              try {
                // Truncate by LENGTH, not by measured overflow: the
                // clipping happens at a parent container (the button
                // itself reports no overflow — scrollWidth equals
                // clientWidth — so an overflow check never fires, which
                // is why rounds 5–10 never truncated). The sidebar is
                // ~228px wide and the title starts at ~x31, so ~170px
                // fits ~24 chars; anything longer is cut, so cut it in
                // the text with a real "…".
                var tNodes = b.childNodes;
                for (var m = 0; m < tNodes.length; m++) {
                  var t2 = tNodes[m];
                  if (t2 && t2.nodeType === 3) {
                    var val = t2.nodeValue || "";
                    if (val.trim().length >= 3 && val.length > 16 && val.indexOf("…") === -1) {
                      t2.nodeValue = val.slice(0, 15).replace(/\\s+$/, "") + "…";
                      break;
                    }
                  } else if (t2 && t2.textContent) {
                    var inner = t2.childNodes;
                    for (var q = 0; q < inner.length; q++) {
                      if (inner[q] && inner[q].nodeType === 3 && (inner[q].nodeValue || "").trim().length >= 3) {
                        var v = inner[q].nodeValue;
                        if (v.length > 16 && v.indexOf("…") === -1) {
                          inner[q].nodeValue = v.slice(0, 15).replace(/\\s+$/, "") + "…";
                        }
                        break;
                      }
                    }
                  }
                }
              } catch (e) {}
            } catch (e) {}
          }
        } catch (e) {}
      } },
      { id: "chat-input-fixes", run: function () {
        // Chat composer (2026-11-18 QA + DOM inspection).
        // (a) The blue "This tab queues only" banner has NO container
        // element — it is a bare text node + an info-circle img, both
        // direct children of <main>, directly above the input textbox,
        // with a 0–1 px rendered gap. There is no element to give a
        // margin-bottom to, so the gap goes on the INPUT box instead.
        // The textbox found by placeholder may be an inner <textarea>
        // inside a wrapper div, so the margin goes on the textbox AND
        // on its parent, so whichever renders the box gets the gap.
        // (b) The "Context usage" control is a <button> with NO child
        // elements — its text ("Context usage 10%, cache hit rate 81%")
        // lives only in its accessible name / description, and the only
        // visible content is a 16–18 px circular ring. It is not
        // clipped by an overflow-hidden parent; the text is simply not
        // rendered. Inject a small visible percentage label into the
        // button next to the ring, and let the button grow to fit it.
        // ALSO (2026-11-18 QA round 19): put the gap on the BANNER
        // itself. Find the element holding "This tab queues only" and
        // give it marginBottom — if the banner is a sibling of a higher
        // composer wrapper, input marginTop alone never separates them.
        // No early-skip: React re-renders reset inline styles while
        // attributes survive, so re-apply on every run (same root cause
        // as the sidebar, round 12).
        try {
          var allEls = document.querySelectorAll ? document.querySelectorAll("*") : [];
          for (var bi = 0; bi < allEls.length; bi++) {
            try {
              var be = allEls[bi];
              var bt = be.textContent || "";
              if (bt.indexOf("This tab queues only") !== -1 && be.children && be.children.length <= 3) {
                be.style.marginBottom = "8px";
                break;
              }
            } catch (e) {}
          }
        } catch (e) {}
        try {
          var inputs = document.querySelectorAll("[placeholder]");
          for (var i = 0; i < inputs.length; i++) {
            try {
              var inp = inputs[i];
              var ph = "";
              try { ph = inp.getAttribute ? (inp.getAttribute("placeholder") || "") : ""; } catch (e) {}
              // The chat input's placeholder is "Ask anything, @ to
              // mention" (QA round 18). The old check matched
              // "message navigation", which is NOT the chat input — so
              // the margin never landed on the real textbox and the
              // banner stayed flush on it (rounds 16–18 FAIL).
              if (ph.indexOf("message navigation") === -1 && ph.indexOf("Ask anything") === -1) continue;
              inp.style.marginTop = "8px";
              var parent = inp.parentElement;
              if (parent && parent.tagName && /^(DIV|FORM)$/i.test(parent.tagName)) {
                parent.style.marginTop = "8px";
              }
            } catch (e) {}
          }
          var btns = document.querySelectorAll("button");
          for (var j = 0; j < btns.length; j++) {
            try {
              var b = btns[j];
              if (b.getAttribute && b.getAttribute("data-agentx-ctx-label")) continue;
              var label = "";
              try { label = (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "") + " " + (b.textContent || ""); } catch (e) {}
              if (label.indexOf("Context usage") === -1) continue;
              if (b.setAttribute) b.setAttribute("data-agentx-ctx-label", "1");
              var m = label.match(/Context usage\\s*(\\d+)\\s*%/);
              var pct = m ? m[1] + "%" : "";
              if (!pct) continue;
              var span = document.createElement("span");
              span.textContent = pct;
              span.style.cssText = "font-size:11px;line-height:1;color:#16a34a;font-weight:600;margin-left:4px;white-space:nowrap;flex:none;";
              b.appendChild(span);
              b.style.display = "inline-flex";
              b.style.alignItems = "center";
              b.style.minWidth = "0";
              b.style.width = "auto";
              b.style.maxWidth = "none";
              b.style.overflow = "visible";
            } catch (e) {}
          }
        } catch (e) {}
      } },
      { id: "thinking-selector", run: function () {
        // Per-chat thinking level (2026-11-18, user request: "like in
        // coding agent" — enable/disable + low/medium/high/xhigh).
        // A selector next to the composer controls (same toolbar as the
        // "Context usage" button): Default / Off / Low / Medium / High /
        // XHigh, stored per chat via the backend's own endpoint. React-
        // safe by construction: the select is OUR element, appended (never
        // moved) into the toolbar; React may remove it on a re-render, so
        // the rule re-creates it on every run and re-syncs from the server.
        // No polling: the rule runs on the existing MutationObserver and
        // only fetches when the chat changes (or a save forces a sync).
        try {
          var path = "";
          try { path = window.location ? window.location.pathname || "" : ""; } catch (e) {}
          if (path.indexOf("/chat") !== 0) return;
          var st = agentxThinkingState;
          if (!st.pending) { try { st.pending = window.localStorage ? (window.localStorage.getItem("agentx_thinking_pending") || null) : null; } catch (e) {} }
          // Anchor: the composer toolbar row itself. Primary (user
          // screenshot, 2026-11-19): the Smart Mode control's parent —
          // the row with the mic, model/agent dropdowns, Smart Mode and
          // Send. The selector belongs IN that row, next to Smart Mode.
          // Fallbacks: the "Context usage" button's parent (same toolbar
          // on most console versions), then the chat input's grandparent.
          var toolbar = null;
          try {
            var btns = document.querySelectorAll("button");
            for (var i = 0; i < btns.length; i++) {
              try {
                var b = btns[i];
                var lab = "";
                try { lab = (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "") + " " + (b.textContent || ""); } catch (e) {}
                if (lab.indexOf("Smart Mode") !== -1) { toolbar = b.parentElement; break; }
              } catch (e) {}
            }
            if (!toolbar) {
              for (var ci = 0; ci < btns.length; ci++) {
                try {
                  var cb = btns[ci];
                  var clab = "";
                  try { clab = (cb.getAttribute("aria-label") || "") + " " + (cb.getAttribute("title") || "") + " " + (cb.textContent || ""); } catch (e) {}
                  if (clab.indexOf("Context usage") !== -1) { toolbar = cb.parentElement; break; }
                } catch (e) {}
              }
            }
          } catch (e) {}
          if (!toolbar) {
            try {
              var inputs = document.querySelectorAll("[placeholder]");
              for (var j = 0; j < inputs.length; j++) {
                try {
                  var ph = inputs[j].getAttribute ? (inputs[j].getAttribute("placeholder") || "") : "";
                  if (ph.indexOf("message navigation") !== -1 || ph.indexOf("Ask anything") !== -1) {
                    var p = inputs[j].parentElement;
                    toolbar = p && p.parentElement ? p.parentElement : p;
                    break;
                  }
                } catch (e) {}
              }
            } catch (e) {}
          }
          if (!toolbar) return;
          // thinking-text merge (2026-11-19): the console's own thinking
          // label/option text in this toolbar is renamed here, inside the
          // thinking-selector rule — no separate rule. Text-node values
          // only; the select we create below is our own element.
          try { agentxRenameTextIn(toolbar); } catch (e) {}
          // Global guard (2026-11-19 DOM-inspection round): the anchor
          // can resolve to a DIFFERENT container on different passes —
          // the chat-input grandparent before Smart Mode mounts, the
          // Smart Mode row after. A toolbar-scoped guard let the rule
          // create a SECOND select in the other container: the "native"
          // duplicate below the toolbar WAS ours (the strings "Thinking
          // level for this chat" exist nowhere in the console bundles).
          // One select per document, ever: if one exists, move it (ours
          // only) into the Smart Mode row when that row is found; never
          // create another.
          var sel = null;
          try { sel = document.querySelector ? document.querySelector("[data-agentx-thinking]") : null; } catch (e) {}
          var created = false;
          if (!sel) {
            var label = document.createElement("span");
            label.textContent = "Thinking";
            label.setAttribute("data-agentx-thinking-label", "1");
            label.style.cssText = "font-size:12px;color:#9aa4b2;margin-left:8px;white-space:nowrap;flex:none;";
            sel = document.createElement("select");
            sel.setAttribute("data-agentx-thinking", "1");
            sel.setAttribute("aria-label", "Thinking level for this chat");
            sel.title = "Thinking level for this chat — Default follows the model, Off disables thinking";
            sel.style.cssText = "font-size:12px;color:#e8eaf0;background:#171a21;border:1px solid #343945;border-radius:8px;padding:4px 6px;margin-left:4px;flex:none;cursor:pointer;";
            var opts = [["inherit", "Default"], ["off", "Off"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "XHigh"]];
            for (var k = 0; k < opts.length; k++) {
              var o = document.createElement("option");
              o.value = opts[k][0];
              o.textContent = opts[k][1];
              sel.appendChild(o);
            }
            sel.addEventListener("change", function () { agentxThinkingSave(sel.value); });
            sel.value = "inherit";
            toolbar.appendChild(label);
            toolbar.appendChild(sel);
            created = true;
          } else if (toolbar) {
            // The select already exists somewhere else (created under a
            // fallback anchor before Smart Mode mounted): move OUR label
            // + select into the Smart Mode row. Moving our own elements
            // only — React's nodes are never touched.
            try {
              if (sel.parentElement !== toolbar) {
                var _lab = null;
                try { _lab = document.querySelector ? document.querySelector("[data-agentx-thinking-label]") : null; } catch (e) {}
                if (_lab && _lab.parentElement !== toolbar) toolbar.appendChild(_lab);
                toolbar.appendChild(sel);
              }
            } catch (e) {}
          }
          // v21: the composer merge used to move a <select>'s <option>
          // children out of it (orphaning them as text lines - the cold-load
          // Thinking list). If our select lost options, put them back so the
          // control still works. (The merge itself is fixed in v21 to move
          // a whole <select>, never its children.)
          try {
            if (sel) {
              var need = { "inherit": "Default", "off": "Off", "low": "Low", "medium": "Medium", "high": "High", "xhigh": "XHigh" };
              var have = {};
              for (var oi2 = 0; sel.options && oi2 < sel.options.length; oi2++) have[sel.options[oi2].value] = true;
              for (var nk in need) {
                if (!have[nk]) { var no = document.createElement("option"); no.value = nk; no.textContent = need[nk]; sel.appendChild(no); }
              }
            }
          } catch (e5) {}
          var chatId = agentxThinkingChatId();
          if (chatId && st.chatId === chatId && st.level) agentxThinkingShow(st.level);
          else if (chatId) agentxThinkingSync(false);
          else if (st.pending) agentxThinkingShow(st.pending);
          else if (created) agentxThinkingShow("inherit");
        } catch (e) {}
      } },
      { id: "hide-native-thinking", run: function () {
        // The console's own thinking control (2026-11-19 QA round 20 +
        // DOM inspection 2026-11-19 ~07:0x IST): a second Thinking
        // dropdown below the composer toolbar, unsynced with the per-chat
        // selector above it. The injected selector in the Smart Mode row
        // IS the thinking control now; hide the native one so there is
        // exactly one. The native composer control is labelled
        // "Thinking level for this chat" — IDENTICAL to ours, with the
        // same default title — so the label can never distinguish them:
        // the ONLY discriminator is the data-agentx-thinking attribute,
        // which our select carries from creation (set before append) and
        // the native one never does. ("Thinking intensity" is a different
        // screen's label; it is kept as a match too.) Only when the
        // injected selector exists — otherwise the user would be left
        // with no thinking control at all.
        try {
          var sel = document.querySelector ? document.querySelector("[data-agentx-thinking]") : null;
          if (!sel) return;
          var els = document.querySelectorAll ? document.querySelectorAll("button, select, [role='button']") : [];
          for (var i = 0; i < els.length; i++) {
            try {
              var el = els[i];
              if (el.getAttribute && (el.getAttribute("data-agentx-thinking") || el.getAttribute("data-agentx-thinking-label") || el.getAttribute("data-agentx-hidden"))) continue;
              var lab = "";
              try { lab = (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "") + " " + (el.textContent || ""); } catch (e) {}
              var low = lab.toLowerCase();
              if (low.indexOf("thinking intensity") === -1 && low.indexOf("thinking level for this chat") === -1) continue;
              el.style.display = "none";
              if (el.setAttribute) el.setAttribute("data-agentx-hidden", "1");
            } catch (e) {}
          }
        } catch (e) {}
      } },
      { id: "queue-takeover", run: function () {
        // Multi-tab takeover (2026-11-19 Step 10, fixed 2026-11-19 takeover2):
        // the console's single-sender ownership lock (Web Lock
        // qwenpaw:queue-owner) leaves a non-owner tab queuing forever, and
        // its "Interrupt & send" button is a dead no-op there. The bundle
        // patch (features/queue-takeover) makes the owner tab abort its
        // ownership AbortController on a "release-ownership"
        // BroadcastChannel message. This rule adds the affordance: a
        // "Take over sending" button on the queue-only banner, and hides
        // the dead "Interrupt & send" button while the banner is up.
        //
        // TAKEOVER1 LIVE FAILURE (browser-verified 2026-11-19 ~08:55 IST):
        // the button rendered THREE times with independent state, and the
        // owner never released. Two causes, both fixed here and in the
        // takeover2 image:
        //  (1) The old guard was anchor-scoped (banner.querySelector):
        //  the rule runs on every MutationObserver tick, and appending the
        //  button lengthens the winning div, so the next run picks a
        //  different nested banner div while earlier buttons survive on
        //  theirs. The guard is now DOCUMENT-WIDE (one button in the
        //  whole document); an existing button is MOVED onto the current
        //  banner instead of creating a new one, so there is exactly one
        //  button with one shared state. A button stranded after the
        //  banner is gone is removed.
        //  (2) The takeover1 image patched the content-hashed bundles IN
        //  PLACE without changing their filenames, while Pages serves
        //  /assets/* as immutable for a year — a tab that had loaded the
        //  console before kept running the OLD bundle, whose listener has
        //  no release-ownership branch, so the message fell through to a
        //  no-op. The takeover2 image gives the two patched chunks fresh
        //  URLs (entry script ?v=takeover2, chat chunk renamed); see
        //  features/queue-takeover/README.md.
        // The button is placed on the BANNER ROOT (climbed from the text
        // div while the parent holds only the banner text), with
        // white-space:nowrap, so its label cannot truncate. If the owner
        // still has not released after 15s (stale owner tab), the button
        // re-enables so the user can retry instead of staring at a dead
        // "Takeover requested…" — one-shot timer in the click handler
        // only, never a poll.
        try {
          var path = "";
          try { path = window.location ? window.location.pathname || "" : ""; } catch (e) {}
          var chatId = "";
          try { chatId = agentxThinkingChatId ? agentxThinkingChatId() : ""; } catch (e) {}
          if (path.indexOf("/chat") !== 0) return;
          function findBanner() {
            try {
              if (!document.querySelectorAll) return null;
              var divs = document.querySelectorAll("div");
              var best = null, bestLen = 0;
              for (var i = 0; i < divs.length; i++) {
                var t = "";
                try { t = divs[i].textContent || ""; } catch (e) {}
                if (t.indexOf("This tab queues only") !== -1 && (best === null || t.length < bestLen)) { best = divs[i]; bestLen = t.length; }
              }
              return best;
            } catch (e) { return null; }
          }
          function stripLabels(s) {
            return (s || "").split("Take over sending").join("").split("Takeover requested…").join("");
          }
          var banner = findBanner();
          // Hide the dead "Interrupt & send" while the banner is up;
          // restore it when this tab becomes the owner (banner gone).
          try {
            if (document.querySelectorAll) {
              var btns = document.querySelectorAll("button");
              for (var j = 0; j < btns.length; j++) {
                var b = btns[j];
                try {
                  if (b.getAttribute && b.getAttribute("data-agentx-takeover")) continue;
                  if ((b.textContent || "").indexOf("Interrupt") === -1) continue;
                  if (banner) {
                    if (!b.getAttribute || b.getAttribute("data-agentx-interrupt-hidden") !== "1") {
                      if (b.setAttribute) b.setAttribute("data-agentx-interrupt-hidden", "1");
                      b.style.display = "none";
                    }
                  } else if (b.getAttribute && b.getAttribute("data-agentx-interrupt-hidden") === "1") {
                    if (b.setAttribute) b.setAttribute("data-agentx-interrupt-hidden", "0");
                    b.style.display = "";
                  }
                } catch (e) {}
              }
            }
          } catch (e) {}
          // Document-wide guard: exactly one takeover button, ever.
          var existing = null;
          try { existing = document.querySelector ? document.querySelector("[data-agentx-takeover]") : null; } catch (e) {}
          if (!banner) {
            try { if (existing && existing.parentElement) existing.parentElement.removeChild(existing); } catch (e) {}
            return;
          }
          // Banner root: climb from the text div while the parent holds
          // only the banner text (plus our button's label). Stops at the
          // first ancestor with any other text, at body, or after 4 steps.
          var root = banner;
          try {
            var baseText = stripLabels(banner.textContent || "");
            if (baseText) {
              for (var d = 0; d < 4; d++) {
                var par = root.parentElement;
                if (!par || par === document.body || par === document.documentElement) break;
                var pt = "";
                try { pt = par.textContent || ""; } catch (e) {}
                var rest = stripLabels(pt).split(baseText).join("");
                if (rest.trim() !== "") break;
                root = par;
              }
            }
          } catch (e) {}
          if (existing) {
            try { if (existing.parentElement !== root) root.appendChild(existing); } catch (e) {}
            return;
          }
          var btn = document.createElement("button");
          btn.setAttribute("data-agentx-takeover", "1");
          btn.textContent = "Take over sending";
          btn.style.cssText = "font-size:12px;color:#e8eaf0;background:#171a21;border:1px solid #343945;border-radius:8px;padding:4px 10px;margin-left:8px;flex:none;white-space:nowrap;cursor:pointer;";
          btn.addEventListener("click", function () {
            try {
              if (typeof BroadcastChannel === "undefined") return;
              var ch = new BroadcastChannel("qwenpaw:queue");
              ch.postMessage({ type: "release-ownership", sessionId: chatId });
              btn.disabled = true;
              btn.textContent = "Takeover requested…";
              setTimeout(function () {
                try {
                  if (!btn.isConnected) return;
                  if (!findBanner()) return;
                  btn.disabled = false;
                  btn.textContent = "Take over sending";
                } catch (e) {}
              }, 15000);
            } catch (e) {}
          });
          root.appendChild(btn);
        } catch (e) {}
      } },
      { id: "settings-white-area", run: function () {
        // Settings pages (2026-11-19, browser-verified): the outer
        // settings <main> shell is only ~819px tall in a 998px viewport
        // — the cream ends and the white body shows below (a 179px
        // strip). Content is NOT cut off (it scrolls inside; Save is
        // the last element); the direct origin has no white area.
        //
        // ROUND 1 (2026-11-19 ~08:1x IST) stretched the shell to
        // 100dvh and painted <html> + <body> with the shell's own
        // computed background. Browser-verified PARTIAL: cream ends
        // ~894 (was 819), ~104px white strip left in light mode;
        // dark mode filled.
        //
        // ROUND 2 painted <html> + <body> with the console's own
        // --app-bg theme variable and stretched the shell AND its
        // ancestors to 100dvh. Browser-verified ZERO CHANGE (~08:41
        // IST): the strip stayed ~104px in light mode even though
        // curl shows the new code in the served HTML. Diagnosis from
        // the SERVED console bundle (index-tgCT4NPx.css): the shell
        // is a .page-content whose background is transparent inside
        // .index-module__mainContentLayout — and THAT wrapper has
        // background:var(--app-surface) (white in light mode) and
        // height:100%, so it covers the <html>/<body> paint. Round 2
        // painted only the document elements, never the wrapper.
        //
        // ROUND 3: paint the SHELL and EVERY ANCESTOR up to <body>
        // with the theme paint (never the shell's own background),
        // keep the 100dvh stretch, and write a VISIBLE diagnostic
        // line as page text (the cloud browser has no DevTools, so
        // the probe must be readable as text): the line proves the
        // rule ran and names, via strip probes, the element that
        // actually paints the strip. The line is TEMPORARY — remove
        // it in the follow-up round once the values are read.
        //
        // ROUND 4 (2026-11-19 ~09:0x IST): browser-verified FIXED
        // — light mode cream fills to y=998 (0px strip) at top AND
        // max scroll, dark mode dark-filled, and the diagnostic
        // line was read (rule=ran, shell h=998, body/html bg
        // rgb(249,248,244)). The diagnostic line and its probe are
        // removed here; the paint + stretch are untouched. The
        // rule still no-ops before the nav mounts and cleans up on
        // leaving /settings.
        try {
          var path = "";
          try { path = window.location ? window.location.pathname || "" : ""; } catch (e) {}
          var body = document.body || null;
          var root = null;
          try { root = document.documentElement || null; } catch (e) {}
          function agentxClearSettingsPaint() {
            var had = false;
            try { had = !!(body && body.getAttribute && body.getAttribute("data-agentx-settings-bg") === "1"); } catch (e) {}
            if (had) {
              try {
                if (document.querySelectorAll) {
                  var painted = document.querySelectorAll("[data-agentx-settings-bg]");
                  for (var i = 0; i < painted.length; i++) {
                    var pel = painted[i];
                    if (pel.style && pel.style.removeProperty) pel.style.removeProperty("background-color");
                    else if (pel.style) pel.style.backgroundColor = "";
                    if (pel.removeAttribute) pel.removeAttribute("data-agentx-settings-bg");
                  }
                }
              } catch (e) {}
              if (body && body.setAttribute) body.setAttribute("data-agentx-settings-bg", "0");
              // <html> is outside the mock's body search tree and the
              // sweep above may miss it in a real document too if its
              // marker was cleared first — remove its paint directly.
              if (root && root.style && root.style.removeProperty) root.style.removeProperty("background-color");
              else if (root && root.style) root.style.backgroundColor = "";
              try {
                if (document.querySelectorAll) {
                  var prev = document.querySelectorAll("[data-agentx-settings-stretch]");
                  for (var j = 0; j < prev.length; j++) {
                    var sel = prev[j];
                    if (sel.style && sel.style.removeProperty) sel.style.removeProperty("min-height");
                    else if (sel.style) sel.style.minHeight = "";
                    if (sel.removeAttribute) sel.removeAttribute("data-agentx-settings-stretch");
                  }
                }
              } catch (e) {}
            }
          }
          if (path.indexOf("/settings") !== 0) {
            agentxClearSettingsPaint();
            return;
          }
          var nav = null;
          try { nav = document.querySelector ? document.querySelector('nav[aria-label="Settings"]') : null; } catch (e) {}
          if (!nav) return;
          var shell = null;
          try { shell = nav.closest ? nav.closest("main") : null; } catch (e) {}
          if (!shell) return;
          var dark = false;
          try { dark = !!(root && root.classList && root.classList.contains && root.classList.contains("dark-mode")); } catch (e) {}
          var paint = "";
          try {
            if (window.getComputedStyle && root) {
              var rcs = window.getComputedStyle(root);
              if (rcs && rcs.getPropertyValue) paint = (rcs.getPropertyValue("--app-bg") || "").trim();
            }
          } catch (e) {}
          if (!paint || (paint.indexOf("#") !== 0 && paint.indexOf("rgb") !== 0)) {
            paint = dark ? "#141414" : "#f9f8f4";
          }
          function agentxSetBg(el) {
            if (!el || !el.style) return;
            try {
              if (el.style.setProperty) el.style.setProperty("background-color", paint, "important");
              else el.style.backgroundColor = paint;
            } catch (e) {
              try { el.style.backgroundColor = paint; } catch (e2) {}
            }
            try { if (el.setAttribute) el.setAttribute("data-agentx-settings-bg", "1"); } catch (e) {}
          }
          function agentxStretch(el) {
            if (!el || !el.style) return;
            try {
              if (el.style.setProperty) {
                el.style.setProperty("min-height", "100vh", "important");
                el.style.setProperty("min-height", "100dvh", "important");
              } else {
                el.style.minHeight = "100vh";
                el.style.minHeight = "100dvh";
              }
            } catch (e) {
              try { el.style.minHeight = "100dvh"; } catch (e2) {}
            }
            try { if (el.style) el.style.boxSizing = "border-box"; } catch (e) {}
            try { if (el.setAttribute) el.setAttribute("data-agentx-settings-stretch", "1"); } catch (e) {}
          }
          agentxSetBg(body);
          agentxSetBg(root);
          agentxSetBg(shell);
          agentxStretch(shell);
          var anc = null;
          try { anc = shell.parentElement || null; } catch (e) {}
          while (anc && anc !== body && anc !== root) {
            agentxSetBg(anc);
            agentxStretch(anc);
            try { anc = anc.parentElement || null; } catch (e) { anc = null; }
          }
          if (body && body.setAttribute) body.setAttribute("data-agentx-settings-bg", "1");

        } catch (e) {}
      } },
      { id: "page-bottom-padding", run: function () {
        // The three machine actions used to be floating pills pinned to the
        // bottom-right, so <main> needed 170px of bottom padding for the
        // last row of content to clear them (QA round 7: only "Conf" was
        // visible on a provider card). They now live in the left sidebar,
        // so the big dead strip is gone — a modest pad keeps the last row
        // off the very edge (whitespace, not clearance).
        try {
          var main = document.querySelector ? document.querySelector("main") : null;
          if (main && !main.getAttribute("data-agentx-bottom-pad")) {
            main.setAttribute("data-agentx-bottom-pad", "1");
            main.style.paddingBottom = "32px";
            main.style.boxSizing = "border-box";
          }
        } catch (e) {}
      } },
      { id: "account-row", run: function () {
        // Keep the satwik account row fully visible on every mutation.
        // React re-renders can re-stack the sidebar footer; the fix is
        // idempotent, so re-running it here is what makes it stick (the
        // same reason the old pill-positions rule re-asserted offsets).
        try { fixAccountRow(); } catch (e) {}
      } },
      { id: "account-menu", run: function () {
        // Rohan (2026-11-20): the Computer / Rest machine rows live in the
        // console's OWN account popup, which React rebuilds on every open —
        // so re-add them on every mutation (idempotent per marker).
        try { addAccountMenuActions(); } catch (e) {}
      } },
      { id: "composer-row", run: function () {
        // FULL REBUILD v6 — anchored on the REAL composer, not one placeholder
        // string. The live textbox's visible hint is '↑↓ for message
        // navigation · / for quick commands', NOT 'Ask anything', so the old
        // placeholder anchor matched NOTHING and this rule silently returned
        // early — which is exactly why v3/v4/v5 never merged the rows even
        // though the code looked right. The textbox is now found by ANY of
        // several independent signals (placeholder/aria-label/title containing
        // 'message navigation' or 'Ask anything', the textbox sitting directly
        // before the mic/attach controls, or the Send button's ancestor).
        // GEOMETRY (measured): row 1 (mic, attach, Default) is LEFT-aligned;
        // row 2 (context %, agent default, Smart Mode, Thinking, Send) is
        // CENTRED as a group with ~200px empty on its left and Send hard
        // against the right edge. So merging alone is not enough — the
        // centring is reset too (justify-content:flex-start on the merged row
        // and margin-left:0 on every control), otherwise the merged row would
        // still centre. Rows are flattened with display:contents into their
        // lowest common ancestor, which becomes ONE left-aligned wrapping flex
        // row with an even 8px gap; all controls 32px, compact pills. Nothing
        // is removed and no node is re-parented (React is untouched). The
        // console's responsive collapse of 'Agent default'/'Smart Mode' to
        // icons at narrow width is preserved — labels are never forced open.
        try {
          function cName(el) {
            try { return ((el.textContent || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "")).trim(); } catch (e) { return ""; }
          }
          function isSend(el) {
            var t = ""; try { t = (el.type || "").toLowerCase(); } catch (e) {}
            var n = cName(el);
            return t === "submit" || /^send$/i.test(n) || /send message/i.test(n);
          }
          function isTextbox(el) {
            var tag = ""; try { tag = (el.tagName || "").toUpperCase(); } catch (e) {}
            if (tag === "TEXTAREA") return true;
            if (tag === "INPUT") { var ty = ""; try { ty = (el.type || "").toLowerCase(); } catch (e2) {} return ty === "" || ty === "text" || ty === "search"; }
            return false;
          }
          function hint(el) {
            try { return (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || ""); } catch (e) { return ""; }
          }
          // Signal 1: the Send control (the most reliable composer landmark).
          var sendBtn = null;
          var allBtns = document.querySelectorAll ? document.querySelectorAll("button") : [];
          for (var i = 0; i < allBtns.length; i++) { if (isSend(allBtns[i])) { sendBtn = allBtns[i]; break; } }
          // Signal 2: the textbox, by any of its naming signals.
          var tb = null;
          var tbs = document.querySelectorAll ? document.querySelectorAll("textarea, input, [contenteditable='true'], [contenteditable='']") : [];
          for (var j = 0; j < tbs.length; j++) {
            var h = hint(tbs[j]);
            if (/message navigation/i.test(h) || /ask anything/i.test(h)) { tb = tbs[j]; break; }
          }
          // Signal 3: the textbox sitting directly before the mic/attach row.
          if (!tb && sendBtn) {
            var up = sendBtn, dd = 0;
            while (up && dd < 8 && !tb) {
              var prev = up.previousElementSibling;
              while (prev) {
                if (isTextbox(prev) || (prev.querySelector && prev.querySelector("textarea, input[type='text']"))) { tb = isTextbox(prev) ? prev : prev.querySelector("textarea, input[type='text']"); break; }
                prev = prev.previousElementSibling;
              }
              up = up.parentElement; dd++;
            }
          }
          // Composer root = the common ancestor of Send and the textbox (or an
          // ancestor of whichever was found that also holds the other kind).
          var comp = null;
          if (sendBtn && tb) {
            comp = sendBtn;
            var dc = 0;
            while (comp && dc < 10 && !comp.contains(tb)) { comp = comp.parentElement; dc++; }
          } else if (sendBtn) {
            comp = sendBtn;
            var de = 0;
            while (comp && de < 10) {
              var tq = comp.querySelectorAll ? comp.querySelectorAll("textarea, input[type='text'], [contenteditable='true']") : [];
              if (tq.length > 0) break;
              comp = comp.parentElement; de++;
            }
          } else if (tb) {
            comp = tb;
            var df = 0;
            while (comp && df < 10) {
              var bq = comp.querySelectorAll ? comp.querySelectorAll("button") : [];
              var found = false;
              for (var q = 0; q < bq.length; q++) { if (isSend(bq[q])) { found = true; break; } }
              if (found) break;
              comp = comp.parentElement; df++;
            }
          }
          if (!comp || comp === document.body || comp === document.documentElement) return;
          comp.setAttribute("data-agentx-composer", "1");

          // Every toolbar control in the composer.
          var ctrls = [];
          var all = comp.querySelectorAll("button, select");
          for (var k = 0; k < all.length; k++) {
            if (all[k].id === "qwenpawComputerClose") continue;
            ctrls.push(all[k]);
          }
          if (!ctrls.length) return;

          // v8 (Astryx/Modern-Web pattern): the toolbar is ONE flex container
          // and every wrapper between it and the controls is layout-agnostic.
          // Keyed on the COMPOSER ROOT (found from the textbox + Send, which
          // exist from the first paint) instead of the LCA of all 8 controls —
          // v7 waited for every control to mount before the LCA was correct,
          // which is why the one-row layout only settled after ~60-90s. Here
          // the merge happens as soon as the composer exists and stays stable
          // as the remaining controls mount into the same wrappers.
          if (!comp || comp === document.body) return;
          comp.setAttribute("data-agentx-composer-toolbar", "1");
          comp.style.setProperty("display", "flex", "important");
          comp.style.setProperty("flex-wrap", "wrap", "important");
          comp.style.setProperty("gap", "8px", "important");
          comp.style.setProperty("align-items", "center", "important");
          comp.style.setProperty("justify-content", "flex-start", "important");

          // Flatten the ancestor chain of EVERY mounted control up to the
          // composer root (skipping any wrapper that holds the textbox), so
          // all controls become direct flex items of the one row. Wrappers
          // that hold no control yet are flattened on a later pass, when their
          // controls mount — the layout does not depend on all 8 being present.
          for (var b = 0; b < ctrls.length; b++) {
            var up2 = ctrls[b].parentElement;
            while (up2 && up2 !== comp) {
              var skip = false;
              if (tb && up2.contains(tb)) skip = true;
              if (!skip) {
                var tag = ""; try { tag = (up2.tagName || "").toUpperCase(); } catch (e3) {}
                if (tag === "DIV" || tag === "SPAN" || tag === "UL" || tag === "NAV" || tag === "SECTION") {
                  up2.setAttribute("data-agentx-composer-flat", "1");
                  up2.style.setProperty("display", "contents", "important");
                }
                up2.style.setProperty("justify-content", "flex-start", "important");
                up2.style.setProperty("margin-left", "0", "important");
                up2.style.setProperty("margin-right", "0", "important");
              }
              up2 = up2.parentElement;
            }
          }

          // The textbox takes its OWN full-width line above the control row, so
          // the controls always share the next line as one even row (and the
          // textbox can never be pulled into the control row as a flex item).
          if (tb) {
            var tbLine = tb;
            while (tbLine && tbLine.parentElement && tbLine.parentElement !== comp) {
              tbLine = tbLine.parentElement;
            }
            if (tbLine && tbLine !== comp && tbLine.parentElement === comp) {
              tbLine.setAttribute("data-agentx-composer-line", "1");
              tbLine.style.setProperty("flex", "0 0 100%", "important");
              tbLine.style.setProperty("max-width", "100%", "important");
            }
          }

          // Uniform 32px controls, compact pills, even 8px spacing, Send
          // attached to the group (no auto margin pushing it to the edge).
          // v7: compacted HARDER (11px type, 2px 6px padding, no min-width).
          // The 8 controls did not fit one 824px row at their natural widths —
          // the total hovered right at the box width, which is why flex-wrap
          // wrapped at an UNSTABLE point that shifted between renders (the
          // async Thinking selector changed the total). Compacted this small
          // there is ~200px of slack at 1919px, so the row does not wrap at
          // all and the layout stops flipping between variants.
          for (var c = 0; c < ctrls.length; c++) {
            var el = ctrls[c];
            el.style.setProperty("min-height", "32px", "important");
            el.style.setProperty("height", "32px", "important");
            el.style.setProperty("box-sizing", "border-box", "important");
            el.style.setProperty("padding", "2px 6px", "important");
            el.style.setProperty("font-size", "11px", "important");
            el.style.setProperty("flex", "0 0 auto", "important");
            el.style.setProperty("min-width", "0", "important");
            el.style.setProperty("white-space", "nowrap", "important");
            el.style.setProperty("margin-left", "0", "important");
            el.style.setProperty("margin-right", "0", "important");
          }
        } catch (e) { /* never break the console */ }
      } },
      { id: "label-truncation", run: function () {
        // THIRD round (Rohan v5). v3 and v4 both failed in the live browser,
        // so this pass no longer trusts a single mechanism or a layout probe:
        //  (1) JS-side truncation — if the console shortens the STRING before
        //      rendering, the DOM itself holds "Community & mes…" and no CSS
        //      fix can recover it. Those truncated forms are replaced with
        //      the full label outright (only when the cut is followed by an
        //      ellipsis, so a genuine label that merely starts the same way is
        //      never corrupted).
        //  (2) CSS ellipsis — EVERY ancestor of a matched label, up to 8 hops,
        //      is unclipped UNCONDITIONALLY (wrap + overflow visible + clip +
        //      line-clamp off). Dropping the "is it clipped?" probe removes
        //      the failure mode where layout was measured before the labels
        //      were laid out (scrollWidth still equal to clientWidth), which
        //      is why v4's gated detection silently did nothing.
        //  (3) Re-run coverage — the observer re-runs this on every mutation,
        //      and it is also re-run on SPA navigation (popstate/hashchange)
        //      and on load, so labels that render after the first pass are
        //      still caught.
        var repairs = [
          ["Community & mes", "Community & messaging"],
          ["Voice Transcrip", "Voice Transcription"],
          ["Pending Approva", "Pending Approvals"],
          ["Command Injecti", "Command Injection"],
          ["Privilege Escal", "Privilege Escalation"],
          // The console bundle names this rule "Sensitive File Access"
          // (sensitive_file_access); the Detection-Rules card truncates it to
          // "Sensitive File…" — the only title still cut in v5, because it had
          // no repair entry (the other five were repaired or never cut).
          ["Sensitive File", "Sensitive File Access"],
          ["Create From Tem", "Create From Template"],
        ];
        // NOTE: the Security > Detection Rules titles are deliberately NOT in
        // this list. Their truncation was JS-side (the console cut the string
        // before rendering), which the repairs list above already undoes, so
        // the full text fits the wide card on one line. Unclipping them via CSS
        // changed the title's box and displaced/hid the '4 / 4' / '2 / 2'
        // counts (v6 overlapped them, v7 hid them entirely), so those titles
        // are repaired by TEXT only and the cards' own layout is left alone.
        var labels = [
          "Community & messaging", "Voice Transcription", "Pending Approvals",
          "Connect AgentX", "Connect QwenPaw", "Token Usage",
          "Agent Management", "Tool Offload", "Skill Pool", "Environments",
          "Cron Jobs", "Heartbeat", "Backups", "Debug",
          "Configuration", "Extension", "Channels",
        ];
        try {
          if (!document.createTreeWalker) return;
          var walker = document.createTreeWalker(document.body, 4, null, false);
          var hits = [];
          var node;
          while ((node = walker.nextNode())) {
            var t = node.nodeValue || "";
            // 'Bot Prefix:Not set' -> 'Bot Prefix: Not set' (missing space).
            if (t.indexOf("Bot Prefix:Not set") !== -1) {
              node.nodeValue = t.replace(/Bot Prefix:Not set/g, "Bot Prefix: Not set");
              t = node.nodeValue;
            }
            // v11 [F]: a clock value must stay on one line - its flex box was
            // being shrunk until '13 : 22' broke onto three separate lines.
            if (agentxIsClockText(t.trim()) && node.parentElement) {
              var cp = node.parentElement;
              cp.style.setProperty("white-space", "nowrap", "important");
              cp.style.setProperty("flex", "none", "important");
              cp.style.setProperty("min-width", "max-content", "important");
            }
            // v11 [F]: 'Thinking depth cannot be adjusted' was pale orange on
            // cream - nearly unreadable. Darken it to a high-contrast amber.
            if (t.indexOf("Thinking depth cannot be adjusted") !== -1 && node.parentElement) {
              node.parentElement.style.setProperty("color", "#92400e", "important");
            }
            // (1) Restore full labels from their truncated forms.
            for (var r = 0; r < repairs.length; r++) {
              var cut = repairs[r][0], full = repairs[r][1];
              if (t.indexOf(cut) !== -1 && t.indexOf(full) === -1) {
                var fixed = t.split(cut + "\u2026").join(full).split(cut + "...").join(full);
                if (fixed !== t) { node.nodeValue = fixed; t = fixed; }
              }
            }
            for (var i = 0; i < labels.length; i++) {
              if (t.indexOf(labels[i]) !== -1 && node.parentElement) { hits.push(node.parentElement); break; }
            }
          }
          // (2) Unclip the label and its IMMEDIATE parent only, and wrap the
          // text WITHIN its box (overflow-wrap) instead of letting it spill
          // out. v6's 8-hop overflow:visible sweep made the Detection-Rules
          // titles spill over their '4 / 4' / '2 / 2' counts and pushed those
          // counts out of their cards; wrapping in place keeps every count in
          // its card while still removing every ellipsis.
          for (var k = 0; k < hits.length; k++) {
            var cur = hits[k], hops = 0;
            while (cur && cur !== document.body && hops < 2) {
              cur.classList.add("agentx-unclip");
              cur.style.setProperty("white-space", "normal", "important");
              cur.style.setProperty("text-overflow", "clip", "important");
              cur.style.setProperty("overflow-wrap", "break-word", "important");
              cur.style.setProperty("word-break", "break-word", "important");
              cur.style.setProperty("-webkit-line-clamp", "none", "important");
              cur = cur.parentElement; hops++;
            }
          }
          // (3) v11 BUG-HUNT [H]: buttons and headings must never show a cut
          // label ('Create From Tem…', 'Sync to Skill P…', 'Browse Official…',
          // 'Refresh backend…', ...). Any button/heading that is actually
          // clipped (overflow hidden or ellipsis AND content wider than its
          // box) is unclipped IN PLACE - the text wraps within its own box and
          // the element may grow vertically - so the full label is visible
          // without pushing content sideways. Nothing is removed or renamed.
          var clipEls = document.querySelectorAll("button, h1, h2, h3, h4, h5, h6, th, label, summary");
          for (var ci = 0; ci < clipEls.length; ci++) {
            var ce = clipEls[ci], cst = null;
            try { cst = window.getComputedStyle(ce); } catch (eC) {}
            if (!cst) continue;
            var trunc = (cst.textOverflow === "ellipsis") || (cst.overflowX === "hidden") || (cst.overflow === "hidden");
            if (!trunc) continue;
            var sw = 0, cw = 0; try { sw = ce.scrollWidth; cw = ce.clientWidth; } catch (eD) {}
            if (sw <= cw + 1) continue;
            ce.classList.add("agentx-unclip");
            ce.style.setProperty("white-space", "normal", "important");
            ce.style.setProperty("text-overflow", "clip", "important");
            ce.style.setProperty("overflow-wrap", "break-word", "important");
            ce.style.setProperty("word-break", "break-word", "important");
            ce.style.setProperty("-webkit-line-clamp", "none", "important");
            ce.style.setProperty("height", "auto", "important");
          }
        } catch (e) { /* never break the console */ }
      } },
      { id: "system-preview", run: function () {
        // Rohan v5: the "System" theme preview STILL shows a jagged diagonal
        // light/dark boundary slicing the text lines and the orange bar. v4
        // only inspected the card's own background-image and missed it, so
        // this pass neutralises EVERY painter inside the card — gradients,
        // clip-paths and inline svg — then paints the card with the same
        // clean vertical two-tone split the Light/Dark cards read as.
        try {
          if (!document.createTreeWalker || !document.body) return;
          var names = ["System", "System theme", "Use system theme"];
          var walker2 = document.createTreeWalker(document.body, 4, null, false);
          var labels2 = [];
          var node2;
          while ((node2 = walker2.nextNode())) {
            var tv = (node2.nodeValue || "").trim();
            for (var i2 = 0; i2 < names.length; i2++) {
              if (tv === names[i2] && node2.parentElement) { labels2.push(node2.parentElement); break; }
            }
          }
          for (var k2 = 0; k2 < labels2.length; k2++) {
            // The card is the label's card-sized ancestor (the clickable
            // theme option), not the label itself.
            var card = labels2[k2], hops2 = 0;
            // v6 FIX: the gate was WIDTH>120, but the label strip at the bottom
            // of the card is already card-WIDE (~450px) though only ~35px tall,
            // so the walk stopped at the label strip (which is already a clean
            // vertical split) and never reached the card holding the slanted
            // preview — that is why v5 changed nothing. Gate on HEIGHT instead:
            // the card is ~160px tall (preview + label strip), the strip ~35px.
            // v28: ALSO cap the width (<300). During the cold-load render
            // storm the button can be collapsed (height<=100), so the climb
            // sails past it to the settingRow (~800px wide, ~160px tall),
            // which passes the old gate - and the rule then paints the SPLIT
            // gradient on the WHOLE ROW. That is the black slab (v22-v27):
            // the probe caught the settingRow carrying the SPLIT gradient.
            // A theme card is ~160px wide; a row is ~800px. Never paint a
            // container.
            while (card && card !== document.body && hops2 < 8) {
              var cr = card.getBoundingClientRect();
              if (cr.height > 100 && cr.width > 120 && cr.width < 300) break;
              card = card.parentElement; hops2++;
            }
            if (!card || card === document.body) continue;
            // v28: refuse containers outright (belt and braces - the width
            // cap above should already exclude them).
            var ccls = (card.className || "").toString();
            if (ccls.indexOf("settingRow") !== -1 || ccls.indexOf("settingsCard") !== -1 || ccls.indexOf("appearanceChoices") !== -1) continue;
            // Tag the card so the injected CSS — which also reaches the
            // ::before/::after painters that inline styles cannot touch — can
            // strip every diagonal painter inside it.
            card.setAttribute("data-agentx-system-card", "1");
            // v6: the diagonal is drawn by the PREVIEW element (the one ABOVE
            // the label strip), not the card and not the label strip. Find it:
            // climb from the label to the card's direct child (the label
            // strip), then take its previous sibling — the preview block.
            var strip = labels2[k2];
            while (strip && strip.parentElement !== card) strip = strip.parentElement;
            var preview = (strip && strip.parentElement === card) ? strip.previousElementSibling : null;
            if (!preview && card.firstElementChild && card.firstElementChild !== strip) preview = card.firstElementChild;
            var target = preview || card;
            target.setAttribute("data-agentx-system-preview", "1");
            // Strip painters inside the preview's subtree (inline, for real
            // elements; the injected CSS covers the pseudo-elements).
            // v8: REPLACE each gradient in the preview with the clean vertical
            // split instead of stripping it to none. v7 stripped the diagonal
            // gradient on the VISIBLE surface away entirely, which left that
            // surface showing its own light background-colour; the dark half
            // never appeared because the split was painted on a wrapper behind
            // it. Repainting the same element that drew the diagonal guarantees
            // the dark half is on the visible surface.
            var SPLIT = "linear-gradient(90deg,#f5f5f4 0%,#f5f5f4 50%,#111 50%,#111 100%)";
            var scope = [target].concat([].slice.call(target.querySelectorAll("*")));
            for (var q = 0; q < scope.length; q++) {
              var el = scope[q], bg = "", clip = "";
              try { bg = window.getComputedStyle(el).backgroundImage; } catch (e2) {}
              try { clip = window.getComputedStyle(el).clipPath; } catch (e3) {}
              if (bg && bg.indexOf("gradient") !== -1) el.style.setProperty("background-image", SPLIT, "important");
              if (clip && clip !== "none") el.style.setProperty("clip-path", "none", "important");
              var svgs = el.tagName === "svg" ? [el] : (el.querySelectorAll ? el.querySelectorAll("svg") : []);
              for (var s = 0; s < svgs.length; s++) svgs[s].style.setProperty("display", "none", "important");
            }
            // Clean vertical two-tone split (left light, right dark) on the
            // preview surface itself.
            target.style.setProperty("background-image", SPLIT, "important");
            target.style.setProperty("background-color", "transparent", "important");
            target.style.setProperty("clip-path", "none", "important");
            target.style.setProperty("overflow", "hidden", "important");
          }
        } catch (e) { /* never break the console */ }
      } },
      { id: "hide-per-row-more", run: function () {
        // Rohan v5: every conversation row in the sidebar carries its own
        // hover-revealed "More actions" button (14 of them at 1919px). That
        // is per-row clutter, and the machine actions live in the account
        // popup now, so these are hidden outright. v4 deleted the old
        // hidePerRowMoreButtons() helper along with the sidebar pill, which
        // also removed the only thing hiding these — this rule restores that
        // hiding as a proper rule. Matched by accessible name inside the
        // sidebar, so no other control is touched.
        try {
          var side = findSidebarEl();
          if (!side) return;
          var btns = side.querySelectorAll("button");
          for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            var name = "";
            try { name = ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).trim(); } catch (e) {}
            if (/more actions/i.test(name)) {
              b.style.setProperty("display", "none", "important");
              b.setAttribute("data-agentx-hidden-more", "1");
            }
          }
        } catch (e) { /* never break the console */ }
      } },
      { id: "rename-logo", run: function () {
        // Sidebar logo: an <img> with alt "QwenPaw" (browser verification
        // 2026-11-18: the sidebar still showed "QwenPaw" + "v2.3.0" on
        // every console page). An image cannot be renamed, so swap it for
        // the AgentX wordmark in text, in the same brand slot, so the
        // sidebar layout does not shift. The alt is renamed first, so the
        // a11y tree says AgentX even if the swap is skipped.
        // Size gate (2026-11-18 QA round 2): the bottom-left user card
        // ALSO carries a small QwenPaw avatar image, and swapping THAT
        // for an 18px "AgentX" span overflows its circle and prints over
        // the "satwik" / "Console account" text. Only the large brand
        // logo gets the text swap; a small avatar keeps its image (alt
        // renamed) so the user card stays readable. Gate on the
        // DISPLAYED width (getBoundingClientRect), not naturalWidth:
        // the logo file is intrinsically large, so naturalWidth passed
        // the avatar too — the avatar is DISPLAYED small (~32px) while
        // the brand logo is displayed large. An image whose displayed
        // size is not known yet (not laid out, width 0) is left alone —
        // it still matches the selector on a later pass, once laid out,
        // so the decision is made with a real size.
        // rename-logo-v2 (2026-11-19): also match imgs by title and
        // aria-label, not only alt — the brand logo may carry its name
        // on either attribute. The same size gate applies. Non-img
        // elements matched by title/aria-label get an attribute rename
        // only (no swap: a button is not a logo). rename-attrs skips
        // IMG elements, so the img's QwenPaw attributes survive until
        // this rule runs and the swap can still match them.
        var imgs;
        try { imgs = document.querySelectorAll('img[alt*="QwenPaw"], img[title*="QwenPaw"], img[aria-label*="QwenPaw"], [title*="QwenPaw"], [aria-label*="QwenPaw"]'); } catch (e) { return; }
        for (var i = 0; i < imgs.length; i++) {
          try {
            var img = imgs[i];
            if (img.getAttribute && img.getAttribute("data-agentx-logo")) continue;
            try { var ti = img.getAttribute("title"); if (ti && ti.indexOf("QwenPaw") !== -1) img.setAttribute("title", ti.split("QwenPaw").join("AgentX")); } catch (e) {}
            try { var ai = img.getAttribute("aria-label"); if (ai && ai.indexOf("QwenPaw") !== -1) img.setAttribute("aria-label", ai.split("QwenPaw").join("AgentX")); } catch (e) {}
            if (img.tagName !== "IMG") continue;
            var w = 0;
            try { w = img.getBoundingClientRect ? img.getBoundingClientRect().width : 0; } catch (e) {}
            if (!w) { try { w = img.width || 0; } catch (e) {} }
            if (!w) continue;
            if (img.setAttribute) img.setAttribute("data-agentx-logo", "1");
            try { img.setAttribute("alt", (img.getAttribute("alt") || "").split("QwenPaw").join("AgentX")); } catch (e) {}
            if (w < 80) continue;
            try {
              var parent = img.parentNode;
              if (parent && document.createElement && parent.replaceChild) {
                var label = document.createElement("span");
                label.textContent = "AgentX";
                try { label.setAttribute("style", "font-weight:700;font-size:18px;line-height:1;"); } catch (e) {}
                parent.replaceChild(label, img);
              } else {
                img.style.display = "none";
              }
            } catch (e) { try { img.style.display = "none"; } catch (e2) {} }
          } catch (e) {}
        }
      } },
      { id: "hide-menu", run: function () {
        agentxHideByName(AGENTX_MENU_LABELS, "button, a, li, [role='menuitem'], [role='button'], [role='option'], span, div", "button, a, li, [role='menuitem'], [class*='menu-item']");
      } },
      { id: "hide-about", run: function () { agentxAboutRule(); } },
      { id: "hide-language", run: function () {
        var els;
        try { els = document.querySelectorAll('[aria-label*="Language"], [title*="Language"]'); } catch (e) { return; }
        for (var i = 0; i < els.length; i++) {
          try {
            var el = els[i];
            var target = el;
            try {
              var anc = el.closest ? el.closest("li, [role='menuitem'], button") : null;
              if (anc) target = anc;
            } catch (e) {}
            if (target.getAttribute && target.getAttribute("data-agentx-hidden")) continue;
            target.style.display = "none";
            if (target.setAttribute) target.setAttribute("data-agentx-hidden", "1");
          } catch (e) {}
        }
      } },
      { id: "hide-desktop-prompt", run: function () {
        agentxHideAncestorByContent("is ready to install", "[role='dialog'], [class*='modal'], [class*='banner'], [class*='alert'], [class*='notice']", "[role='dialog'], [class*='modal'], [class*='banner'], [class*='alert'], [class*='notice']");
      } },
      { id: "hide-codex-qoder", run: function () {
        agentxHideExact("QwenPaw, Codex and Qoder profiles", "li, button, a, [role='menuitem'], span, div, h1, h2, h3, h4", "li, [role='menuitem'], [class*='card'], [class*='row'], section, div");
        agentxHideExact("AgentX, Codex and Qoder profiles", "li, button, a, [role='menuitem'], span, div, h1, h2, h3, h4", "li, [role='menuitem'], [class*='card'], [class*='row'], section, div");
      } },
      { id: "hide-voice", run: function () {
        agentxHideAncestorByContent("qwenpaw[whisper]", "code, pre, kbd, span, div, p", "section, [class*='card'], [class*='setting'], [class*='panel']");
      } },
      { id: "hide-import-text", run: function () {
        agentxHideAncestorByContent("Import data from other AI applications", "span, div, p, li", "section, [class*='card'], [class*='row'], li, div");
      } },
      { id: "hide-china", run: function () {
        // agentxClimbToChinaCard, not the generic climb: the generic
        // climb hid the whole provider list (see agentxClimbToChinaCard).
        agentxHideByName(AGENTX_CHINA_LABELS, "li, button, a, [role='menuitem'], [role='listitem'], span, div, h1, h2, h3, h4, img", null, agentxClimbToChinaCard);
      } },
      { id: "footer-rebrand", run: function () {
        // Part 3 (2026-11-19): rename QwenPaw in page footers to AgentX.
        // Text-node VALUES only, footer scope only — the same text
        // elsewhere is rename-text's job, not this rule's.
        var footers;
        try { footers = document.querySelectorAll("footer, [role='contentinfo']"); } catch (e) { return; }
        for (var i = 0; i < footers.length; i++) {
          try { agentxRenameTextIn(footers[i]); } catch (e) {}
        }
      } },
      { id: "block-links-v2", run: function () {
        // Part 3 (2026-11-19): the extended upstream-link blocker.
        // agentxBlockUpstreamLinks now matches by host substring and
        // checks href + data-url + data-href + form action. Install-once
        // (agentxLinkBlockerInstalled), so this rule and block-links
        // share one listener and never double-install.
        agentxBlockUpstreamLinks();
      } },
      { id: "hide-powered-by", run: function () {
        // Part 3 (2026-11-19): hide "Powered by QwenPaw" badges. Both
        // spellings are listed: rename-text runs first and already made
        // it "Powered by AgentX", so the QwenPaw spelling alone would
        // never fire. The whole badge container is hidden, not the text.
        agentxHideRowByText(["Powered by QwenPaw", "Powered by AgentX"], "span, div, p, li, a, button, footer", "li, section, [role='menuitem'], button, [class*='card'], [class*='row'], [class*='banner'], [class*='badge'], [class*='item'], footer");
      } },
      { id: "hide-feedback", run: function () {
        // Part 3 (2026-11-19): hide Feedback / "Send feedback"
        // affordances. agentxHideByName (exact text match for
        // text-sourced names) so a paragraph merely mentioning feedback
        // is never hidden — only the affordance itself.
        agentxHideByName(["Feedback", "Send feedback"], "button, a, li, [role='menuitem'], [role='button']", "button, a, li, [role='menuitem']");
      } },
      { id: "settings-about", run: function () {
        // Part 3 (2026-11-19): in Settings, rename "About QwenPaw" rows
        // to "About AgentX". rename-text already renames globally; this
        // rule is the scoped guarantee for the Settings row. The
        // hide-about capture listener (which intercepts the click to
        // /status) is untouched — this rule only renames text nodes.
        var inSettings = false;
        try { inSettings = (window.location && window.location.pathname ? window.location.pathname : "").indexOf("/settings") !== -1; } catch (e) {}
        if (inSettings) { agentxRenameNeedleInBody("About QwenPaw", "About AgentX"); return; }
        agentxRenameScoped("About QwenPaw", function (el) { return agentxScopeMarker(el, ["setting"]); }, "About AgentX");
      } },
      { id: "settings-language", run: function () {
        // Part 3 (2026-11-19): hide the language switcher in Settings.
        // Broader than hide-language (aria-label/title "Language"): also
        // hide a Settings row whose VISIBLE label is exactly "Language".
        // Exact match only — "Language: English" and "Languages" stay.
        var els;
        try { els = document.querySelectorAll("li, button, a, [role='menuitem'], span, div"); } catch (e) { return; }
        for (var i = 0; i < els.length; i++) {
          try {
            var el = els[i];
            var t = "";
            try { t = (el.textContent || "").trim(); } catch (e) {}
            if (t !== "Language") continue;
            var target = null;
            try { target = el.closest ? el.closest("li, [role='menuitem'], section, [class*='row'], [class*='setting']") : null; } catch (e) {}
            if (!target) { try { target = agentxClimbToContainer(el, "li, [role='menuitem'], section"); } catch (e) {} }
            if (!target) target = el;
            if (target.getAttribute && target.getAttribute("data-agentx-hidden")) continue;
            target.style.display = "none";
            if (target.setAttribute) target.setAttribute("data-agentx-hidden", "1");
          } catch (e) {}
        }
      } },
      { id: "settings-providers", run: function () {
        // Part 3 (2026-11-19): in Settings > Models, rename "QwenPaw"
        // provider/section labels to AgentX. TEXT ONLY — never provider
        // IDs, never API values (those live in inputs/attributes, which
        // this walk never touches).
        var path = "";
        try { path = (window.location && window.location.pathname ? window.location.pathname : ""); } catch (e) {}
        if (path.indexOf("/settings") !== -1) { agentxRenameNeedleInBody("QwenPaw"); return; }
        agentxRenameScoped("QwenPaw", function (el) { return agentxScopeMarker(el, ["model", "provider"]); });
      } },
      { id: "settings-integrations", run: function () {
        // Part 3 (2026-11-19): in Settings > Integrations, rename
        // QwenPaw mentions to AgentX. Text only, same guards as
        // settings-providers.
        var path = "";
        try { path = (window.location && window.location.pathname ? window.location.pathname : ""); } catch (e) {}
        if (path.indexOf("/settings") !== -1) { agentxRenameNeedleInBody("QwenPaw"); return; }
        agentxRenameScoped("QwenPaw", function (el) { return agentxScopeMarker(el, ["integration"]); });
      } },
      { id: "hide-upgrade", run: function () {
        // Part 3 (2026-11-19): hide Upgrade / "Upgrade to Pro" / pricing
        // upsell UI. Buttons by exact accessible name; upsell cards by
        // their leaf label, climbed to the card — never the list.
        agentxHideByName(["Upgrade", "Upgrade to Pro"], "button, a, li, [role='menuitem'], span, div", "button, a, li, [role='menuitem'], [class*='card'], [class*='row']");
        agentxHideRowByText(["Upgrade to Pro"], "span, p, h1, h2, h3, h4", "li, section, [class*='card'], [class*='row'], [class*='banner'], button");
      } },
      { id: "account-card", run: function () {
        // Part 3 (2026-11-19): rename the account/user card's QwenPaw
        // mentions to AgentX. Text nodes only — the satwik username and
        // avatar are never touched (no "QwenPaw" text node is ever the
        // username, and images are not text nodes).
        agentxRenameScoped("QwenPaw", function (el) { return agentxScopeMarker(el, ["account", "profile", "user-card"]); });
      } },
      { id: "workspace-switcher", run: function () {
        // Part 3 (2026-11-19): rename QwenPaw in the workspace switcher
        // to AgentX. Text only.
        agentxRenameScoped("QwenPaw", function (el) { return agentxScopeMarker(el, ["workspace", "switcher"]); });
      } },
      { id: "sidebar-help", run: function () {
        // Part 3 (2026-11-19): hide sidebar Help / docs links that point
        // upstream. The decision reuses the block-links host list
        // (agentxIsUpstreamHref): a sidebar link is hidden only when its
        // href is upstream. Same-origin sidebar links stay; upstream
        // links OUTSIDE the sidebar stay visible here (block-links still
        // blocks their clicks) — this rule only hides sidebar rows.
        var links;
        try { links = document.querySelectorAll("a[href]"); } catch (e) { return; }
        for (var i = 0; i < links.length; i++) {
          try {
            var a = links[i];
            var href = "";
            try { href = a.getAttribute("href") || ""; } catch (e) {}
            if (!agentxIsUpstreamHref(href)) continue;
            var cur = a;
            var inSidebar = false;
            for (var d = 0; cur && d < 8; d++) {
              try {
                var tag = (cur.tagName || "").toUpperCase();
                var cls = "";
                try { cls = (cur.getAttribute("class") || "").toLowerCase(); } catch (e) {}
                if (tag === "NAV" || tag === "ASIDE" || cls.indexOf("sidebar") !== -1) { inSidebar = true; break; }
              } catch (e) {}
              cur = cur.parentNode;
            }
            if (!inSidebar) continue;
            var target = null;
            try { target = a.closest ? a.closest("li, button, a, [role='menuitem']") : null; } catch (e) {}
            if (!target) target = a;
            if (target.getAttribute && target.getAttribute("data-agentx-hidden")) continue;
            target.style.display = "none";
            if (target.setAttribute) target.setAttribute("data-agentx-hidden", "1");
          } catch (e) {}
        }
      } },
      { id: "model-labels", run: function () {
        // Part 3 (2026-11-19): DISPLAY-ONLY model display names —
        // "deepseek-v4.1-flash-free" shows as "AgentX-1-Mini",
        // "nex-n2.6" shows as "AgentX-1" (mapping is a documented
        // judgment call, needs user confirmation — see README). Only
        // text nodes inside the model picker / composer are renamed:
        // an ancestor must carry a model/picker/composer marker
        // (aria-label/title "model", class model/picker/composer,
        // role combobox/listbox/option, or a SELECT). Option VALUE
        // attributes, input values, and API payloads are never touched
        // — this walk only ever assigns nodeValue on text nodes, and a
        // label matching neither mapping is left alone.
        try {
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          var node;
          while ((node = walker.nextNode())) {
            try {
              var t = node.nodeValue;
              if (!t) continue;
              var hit = false;
              for (var m = 0; m < AGENTX_MODEL_LABELS.length; m++) { if (t.indexOf(AGENTX_MODEL_LABELS[m][0]) !== -1) { hit = true; break; } }
              if (!hit) continue;
              var parent = node.parentNode;
              if (parent && (parent.nodeName === "SCRIPT" || parent.nodeName === "STYLE" || parent.nodeName === "TEXTAREA" || parent.nodeName === "INPUT")) continue;
              var cur = parent;
              var scoped = false;
              for (var d = 0; cur && d < 8; d++) {
                try {
                  var tag = (cur.tagName || "").toUpperCase();
                  var cls = "";
                  try { cls = (cur.getAttribute("class") || "").toLowerCase(); } catch (e) {}
                  var lab = "";
                  try { lab = ((cur.getAttribute("aria-label") || "") + " " + (cur.getAttribute("title") || "")).toLowerCase(); } catch (e) {}
                  var ph = "";
                  try { ph = cur.getAttribute("placeholder") || ""; } catch (e) {}
                  var role = "";
                  try { role = (cur.getAttribute("role") || "").toLowerCase(); } catch (e) {}
                  if (tag === "SELECT" || tag === "OPTION" || role === "combobox" || role === "listbox" || role === "option" ||
                      cls.indexOf("model") !== -1 || cls.indexOf("picker") !== -1 || cls.indexOf("composer") !== -1 ||
                      lab.indexOf("model") !== -1 ||
                      ph.indexOf("Ask anything") !== -1 || ph.indexOf("message navigation") !== -1) { scoped = true; break; }
                } catch (e) {}
                cur = cur.parentNode;
              }
              if (!scoped) continue;
              var fixed = t;
              for (var k = 0; k < AGENTX_MODEL_LABELS.length; k++) { fixed = fixed.split(AGENTX_MODEL_LABELS[k][0]).join(AGENTX_MODEL_LABELS[k][1]); }
              node.nodeValue = fixed;
            } catch (e) {}
          }
        } catch (e) {}
      } },
      { id: "title-observer", run: function () {
        // Part 3 (2026-11-19): re-apply rename-title on head <title>
        // mutations — wire the existing agentxWatchTitle() into a rule:
        // install once (the flag inside agentxWatchTitle guards the
        // second install) and rename the title immediately, so a title
        // set before the observer fires is still renamed on this pass.
        // No second observer is ever installed.
        agentxWatchTitle();
        try { if (document.title && document.title.indexOf("QwenPaw") !== -1) document.title = document.title.split("QwenPaw").join("AgentX"); } catch (e) {}
      } },
      { id: "head-rebrand", run: function () {
        // Part 3 (2026-11-19): rename the head metadata — og:title /
        // twitter:title / og:description / twitter:description meta
        // content (QwenPaw -> AgentX), the inline application-name meta,
        // and the favicon (link[rel~="icon"] href becomes the inline
        // data-URI AX mark — no external URL). MANIFEST: link[rel=
        // "manifest"] points at an EXTERNAL file — do NOT fetch it;
        // there is no inline manifest name to rewrite, so if no inline
        // application-name meta exists this part is a no-op (documented
        // in the README). Attributes only; no node moves.
        try {
          var metas;
          try { metas = document.querySelectorAll('meta[property="og:title"], meta[property="twitter:title"], meta[property="og:description"], meta[property="twitter:description"], meta[name="application-name"]'); } catch (e) { metas = []; }
          for (var i = 0; i < metas.length; i++) {
            try {
              var c = metas[i].getAttribute("content");
              if (c && c.indexOf("QwenPaw") !== -1) metas[i].setAttribute("content", c.split("QwenPaw").join("AgentX"));
            } catch (e) {}
          }
        } catch (e) {}
        try {
          var links;
          try { links = document.querySelectorAll("link"); } catch (e) { links = []; }
          for (var j = 0; j < links.length; j++) {
            try {
              var rel = (links[j].getAttribute("rel") || "").toLowerCase();
              if (rel.indexOf("icon") !== -1) links[j].setAttribute("href", AGENTX_FAVICON_DATA);
            } catch (e) {}
          }
        } catch (e) {}
      } },
      { id: "export-rebrand", run: function () {
        // Part 3 (2026-11-19): hide community-share controls; for
        // a[download] links rewrite the DISPLAYED text only — never the
        // href, never the download filename (those are real file paths).
        agentxHideByName(["Share to community", "Share to Community", "Community share"], "button, a, li, [role='menuitem'], span, div", "button, a, li, [role='menuitem']");
        try {
          var links = document.querySelectorAll("a[download]");
          for (var i = 0; i < links.length; i++) {
            try {
              var ch = links[i].childNodes;
              for (var j = 0; j < ch.length; j++) {
                if (ch[j] && ch[j].nodeType === 3 && ch[j].nodeValue && ch[j].nodeValue.indexOf("QwenPaw") !== -1) {
                  ch[j].nodeValue = ch[j].nodeValue.split("QwenPaw").join("AgentX");
                }
              }
            } catch (e) {}
          }
        } catch (e) {}
      } },
      { id: "hide-run-in", run: function () {
        // Part 3 (2026-11-19): hide "Run in QwenPaw" / "Open in
        // QwenPaw" buttons. Both spellings: rename-text already made
        // them "AgentX" by the time this rule runs.
        agentxHideRowByText(["Run in QwenPaw", "Run in AgentX", "Open in QwenPaw", "Open in AgentX"], "button, a, span, div, li", "button, a, li, [role='menuitem'], [class*='card'], [class*='row']");
      } },
      { id: "auth-rebrand", run: function () {
        // Part 3 (2026-11-19): rename QwenPaw on the sign-in/auth
        // screens to AgentX. TEXT ONLY — never tokens, never inputs,
        // never form actions (the walk skips INPUT/TEXTAREA parents and
        // only ever assigns nodeValue on text nodes).
        var path = "";
        try { path = (window.location && window.location.pathname ? window.location.pathname : ""); } catch (e) {}
        if (path.indexOf("/login") !== -1 || path.indexOf("/auth") !== -1 || path.indexOf("/signin") !== -1) { agentxRenameNeedleInBody("QwenPaw"); return; }
        agentxRenameScoped("QwenPaw", function (el) { return agentxScopeMarker(el, ["auth", "login", "sign-in"]); });
      } },
      { id: "error-rebrand", run: function () {
        // Part 3 (2026-11-19): rename QwenPaw in error boundary / error
        // toast text to AgentX. Text only, scoped to error/toast/alert
        // containers — normal page text is rename-text's job.
        agentxRenameScoped("QwenPaw", function (el) {
          try {
            var role = "";
            try { role = (el.getAttribute("role") || "").toLowerCase(); } catch (e) {}
            if (role === "alert") return true;
          } catch (e) {}
          return agentxScopeMarker(el, ["error", "toast", "alert"]);
        });
      } },
      { id: "hide-onboarding", run: function () {
        // Part 3 (2026-11-19): hide the first-run onboarding / tutorial
        // overlay cards. The whole card is hidden (climbed to the card),
        // never the page. "Getting started" docs links do not match any
        // label here and stay visible.
        agentxHideRowByText(["Welcome to QwenPaw", "Welcome to AgentX", "Get started", "Take the tour", "First run"], "span, div, p, h1, h2, h3, button, li", "li, section, [role='dialog'], [class*='card'], [class*='modal'], [class*='overlay'], [class*='row'], button");
      } },
      { id: "hide-update-banner", run: function () {
        // Part 3 (2026-11-19): hide the "update available" banner. The
        // pinned-version shim already answers the version check, so the
        // banner is stale UI if it still renders. "Updated ..." notes
        // (past tense) do not match and stay.
        agentxHideRowByText(["Update available", "A new version is available", "New version available", "Update to v"], "span, div, p, li, button", "li, section, [role='alert'], [class*='banner'], [class*='card'], [class*='row']");
      } },
      { id: "hide-shortcuts-dialog", run: function () {
        // Part 3 (2026-11-19): hide the keyboard-shortcuts dialog
        // trigger/row in help menus. Only the TRIGGER UI is hidden —
        // the shortcuts themselves (key handlers) are never touched, so
        // every shortcut keeps working.
        agentxHideRowByText(["Keyboard shortcuts", "Shortcuts"], "button, a, li, [role='menuitem'], span, div", "li, [role='menuitem'], button, [class*='row'], section");
      } },
      { id: "block-links", run: function () { agentxBlockUpstreamLinks(); } },
    ];
    function agentxRunRules() {
      if (agentxRebrandOff()) return;
      var now = Date.now();
      if (now - agentxLastRun < 400) {
        if (!agentxTrailingTimer) {
          agentxTrailingTimer = setTimeout(function () {
            agentxTrailingTimer = null;
            agentxRunRules();
          }, 400);
        }
        return;
      }
      agentxLastRun = now;
      for (var i = 0; i < AGENTX_RULES.length; i++) {
        try { AGENTX_RULES[i].run(); } catch (e) { try { console.debug("[agentx] rule failed: " + AGENTX_RULES[i].id, e); } catch (e2) {} }
      }
    }
    /* AGENTX-REBRAND-END */
    // Run one rule by id, synchronously and unthrottled. The three
    // fragile fixes (grammar, sidebar ellipsis, chat input) fight React:
    // React re-renders and reverts the DOM mutation, and the 400 ms
    // throttle in agentxRunRules leaves a window where the unfixed text
    // shows (QA round 4: "1 providers online" still plural after 5 s).
    // Running them synchronously in the observer callback re-applies the
    // fix on every mutation, so React never wins the race for long.
    function agentxRunRuleNow(id) {
      try {
        for (var i = 0; i < AGENTX_RULES.length; i++) {
          if (AGENTX_RULES[i].id === id) { AGENTX_RULES[i].run(); return; }
        }
      } catch (e) {}
    }
    // v20: DECOUPLED page fixes. The v19 fixes (theme bars, toggle rows,
    // dup badges, Thinking hide, counts, header icons) lived ONLY inside
    // fixAccountRow(), which EARLY-RETURNS when the account row's <small>
    // ("Console account" / "Local workspace") is not found - so on any
    // page/load where the row is not yet mounted, NONE of them ran, even
    // though the code looked right and the CSS was served. That is the
    // most likely reason v19's Settings fixes never visibly landed while
    // the counts (same function, but the row WAS found on Security) did.
    // These fixes now run on EVERY observer pass and on a 2s timer,
    // independent of the account row. All are idempotent; running them
    // twice (here + inside fixAccountRow) is harmless.
    function agentxRunPageFixes() {
      try { addRuleCountBadges(); } catch (e) {}
      try { fixToggleRows(); } catch (e) {}
      try { fixThemeBars(); } catch (e) {}
      try { dedupeRowTitles(); } catch (e) {}
      try { hideColdOpenThinking(); } catch (e) {}
      try { clarifyHeaderIcons(); } catch (e) {}
      try { fixShowThinkingRow(); } catch (e) {}
      try { fixSettingIcons(); } catch (e) {}
      try { fixTallNavs(); } catch (e) {}
      try { fixSettingsSidebarMargin(); } catch (e) {}
      try { fixImages(); } catch (e) {}
      try { fixRadioDescriptions(); } catch (e) {}
    }
    // v11: the rule list is extracted so the observer callback and its
    // TRAILING re-run share one implementation, and a queued flag records when
    // mutations arrived while a pass was already running.
    var agentxPassQueued = false;
    function agentxRunAllRules() {
      addVaultMenuItem();
      agentxRunRuleNow("fix-grammar");
      agentxRunRuleNow("sidebar-ellipsis");
      agentxRunRuleNow("chat-input-fixes");
      agentxRunRuleNow("thinking-selector");
      agentxRunRuleNow("queue-takeover");
      agentxRunRuleNow("settings-white-area");
      agentxRunRuleNow("page-bottom-padding");
      agentxRunRuleNow("account-row");
      agentxRunRuleNow("account-menu");
      agentxRunRuleNow("composer-row");
      agentxRunRuleNow("label-truncation");
      agentxRunRuleNow("system-preview");
      agentxRunRuleNow("hide-per-row-more");
      agentxRunRules();
      agentxRunPageFixes();
    }
    function agentxRunObserverPass() {
      if (agentxInObserverPass) return;
      agentxInObserverPass = true;
      try {
        agentxRunAllRules();
      } finally {
        // Clear the flag on a later task, not synchronously (A9): mutations
        // made during this pass are delivered as a microtask after it returns.
        setTimeout(function () { agentxInObserverPass = false; }, 0);
        // v11: mutations that arrived WHILE this pass was running were dropped
        // by the guard. Re-run once on a later task so React's final cold-load
        // render is always processed; bounded to one re-run per pass, and any
        // later render is caught by a normal observer pass.
        setTimeout(function () {
          if (!agentxPassQueued) return;
          agentxPassQueued = false;
          agentxInObserverPass = true;
          try { agentxRunAllRules(); }
          finally { setTimeout(function () { agentxInObserverPass = false; }, 0); }
        }, 0);
      }
    }
    try {
      var vaultMenuObserver = new MutationObserver(function () {
        // RE-ENTRANCY GUARD (A9, 2026-11-19). Seven of the eight rules
        // below write to the DOM unconditionally (nodeValue / textContent /
        // appendChild), and this observer watches characterData across
        // document.body's whole subtree — so each rule's own write is a
        // mutation that fires this callback again. Without this flag the
        // callback re-enters itself and the page spends its main thread
        // re-running 44 rules over 42 querySelectorAll sites forever, which
        // is what a constrained renderer sees as
        // renderer_probe_timeout / browser_error.
        //
        // The flag makes each callback a single pass: writes made DURING
        // the pass do not queue another endless run. Mutations React makes
        // afterwards still arrive normally, so the fixes still re-apply.
        // v11 COLD-LOAD FIX: mutations arriving while a pass is already
        // running were previously DROPPED. On a cold post-login load React's
        // final composer render landed inside that dropped window, so the
        // row-flatten attributes were never written and the composer stayed
        // two rows until a reload. Record the arrival so the pass's trailing
        // re-run processes the final DOM state. See agentxRunObserverPass.
        if (agentxInObserverPass) { agentxPassQueued = true; return; }
        agentxRunObserverPass();
      });
      // characterData: React updates a text node in place (nodeValue)
      // when it re-renders — e.g. the Models page resetting "1 provider
      // online" back to "1 providers online". A childList-only observer
      // never fires for that, so the grammar fix was never re-applied
      // after the first React re-render (2026-11-18 DOM inspection).
      vaultMenuObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      // Timer re-apply (2026-11-18 QA rounds 5–13): the sidebar rule
      // still did not stick even after removing the done-marker skip —
      // React re-renders can revert the text node between observer
      // firings, and the observer may not fire for every React commit.
      // A 1.5 s timer re-runs the sidebar truncation independently, so
      // a reverted title is re-cut within ~1.5 s no matter what React
      // does. The truncation is idempotent (skips text already holding
      // "…"), so the timer is cheap and safe.
      // UI-TIMER-ALLOWLIST: sidebar-ellipsis re-apply timer. Client-side
      // only, runs only while the user has the console open, makes no
      // network calls and writes no data — it only re-truncates sidebar
      // title text nodes. Not a server poll loop.
      try {
        setInterval(function () { // UI-TIMER-ALLOWLIST: sidebar-ellipsis re-apply
          try { agentxRunRuleNow("sidebar-ellipsis"); } catch (e) {}
        }, 1500);
      } catch (e) {}
      // v20: page-fixes re-apply timer. The observer can drop React's final
      // cold-load render (re-entrancy guard + one bounded trailing re-run),
      // and a late settings-chunk mount or an API-driven re-render can
      // replace the nodes the fixes styled. A 2 s local re-apply catches
      // those windows. Client-side only, no network, no data writes.
      try {
        setInterval(function () { // UI-TIMER-ALLOWLIST: page-fixes re-apply
          try { agentxRunPageFixes(); } catch (e) {}
        }, 2000);
      } catch (e) {}
      // v21: record SPA navigations so the composer merge (which MOVES
      // nodes) stays out of React's route-change commit (see agentxLastNav).
      try {
        var _navMark = function () { try { agentxLastNav = Date.now(); agentxNavCount++; } catch (e) {} };
        window.addEventListener("popstate", _navMark);
        window.addEventListener("hashchange", _navMark);
        if (window.history && window.history.pushState && !window.history.pushState.agentxWrapped) {
          var _ps = window.history.pushState, _rs = window.history.replaceState;
          var _wrapNav = function (orig) { return function () { var r = orig.apply(this, arguments); _navMark(); return r; }; };
          window.history.pushState = _wrapNav(_ps);
          window.history.pushState.agentxWrapped = true;
          window.history.replaceState = _wrapNav(_rs);
          window.history.replaceState.agentxWrapped = true;
        }
      } catch (e) {}
      addVaultMenuItem();
      agentxRunRules();
      agentxWatchTitle();
    } catch (e) { /* observer unavailable; the floating Vault button still works */ }
  } catch (e) { /* never break the console */ }
})();
</script>`;
}

function fmtCooldownRemaining(seconds) {
  // One shared formatter for the cooldown page: whole minutes, rounded up,
  // so 90 s reads as 2 minutes, never as a false-precise 1.5. Null, zero or
  // non-numeric input means the cooldown length is unknown, so no time
  // text is rendered at all (inventing one would be worse than none).
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0) { return ""; }
  var mins = Math.ceil(seconds / 60);
  if (mins <= 1) { return "about 1 minute"; }
  return "about " + mins + " minutes";
}

function wakingPage(retryAfter) {
  // Live progress, not a blank wait (sleep/wake fix, 2026-11-17): the old
  // page was static text + a 30 s meta-refresh, so a cold wake looked like
  // a hung "Loading..." screen. This page shows an elapsed timer, a
  // determinate bar (transform scaleX, never width), and a status line, and
  // polls the console every 5 s, reloading the moment the console answers
  // instead of waiting for the next refresh. The meta-refresh stays as a
  // no-JS fallback. Rebuilt 2026-11-19 as one centred card (Smart
  // Sleep/Wake Part 2): string concatenation only, no backticks, no
  // interpolation, no external assets. Titles keep the project-wide
  // AgentX dash separator, which the rebrand harness requires verbatim;
  // sloplint gate 19 flags that dash in <title>, never in body copy.
  var usual = 60;
  if (typeof retryAfter === "number" && isFinite(retryAfter) && retryAfter > 0) { usual = retryAfter; }
  var usualText = "Usually ready in about a minute.";
  if (usual !== 60) { usualText = "Usually ready in about " + usual + " seconds."; }
  return new Response(
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta http-equiv=\"refresh\" content=\"60\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>AgentX: Waking up</title>" +
    "<meta name=\"description\" content=\"AgentX is waking up. The console opens when the machine answers.\">" +
    "<style>" +
    "/* Hallmark · v2.0.0 · theme: AgentX status (custom) · genre modern-minimal · shape: one card */" +
    "/* Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V4 · weakest: S, led with the live state */" +
    ":root{color-scheme:dark;--color-bg:oklch(0.23 0.012 260);--color-surface:oklch(0.28 0.014 260);--color-track:oklch(0.35 0.012 260);--color-ink:oklch(0.93 0.008 250);--color-muted:oklch(0.74 0.01 250);--color-line:oklch(0.40 0.012 260);--color-accent:oklch(0.75 0.13 155);--color-accent-ink:oklch(0.24 0.03 160);--font-display:Georgia,\"Times New Roman\",serif;--font-body:system-ui,-apple-system,\"Segoe UI\",sans-serif;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:32px;--radius-card:16px;--radius-control:10px;--text-title:1.75rem;--text-body:1rem;--text-small:0.875rem;--width-card:38rem;}" +
    "*{box-sizing:border-box;}::selection{background:var(--color-accent);color:var(--color-accent-ink);}html{scrollbar-color:var(--color-line) var(--color-bg);}" +
    "html,body{overflow-x:clip;}" +
    "body{margin:0;min-height:100svh;display:grid;place-items:center;padding:var(--space-6) var(--space-4);background:var(--color-bg);color:var(--color-ink);font-family:var(--font-body);font-size:var(--text-body);line-height:1.55;}" +
    "main{width:100%;max-width:var(--width-card);background:var(--color-surface);border:1px solid var(--color-line);border-radius:var(--radius-card);padding:var(--space-6);}" +
    "h1{font-family:var(--font-display);font-size:var(--text-title);line-height:1.15;margin:0 0 var(--space-3);overflow-wrap:break-word;min-width:0;text-wrap:balance;}" +
    "p{margin:0 0 var(--space-4);}" +
    "p:last-child{margin-bottom:0;}" +
    ".fine{color:var(--color-muted);font-size:var(--text-small);}" +
    ".bar{background:var(--color-track);border-radius:var(--radius-control);height:8px;overflow:hidden;margin:var(--space-4) 0;}" +
    ".bar-fill{background:var(--color-accent);height:100%;border-radius:var(--radius-control);transform:scaleX(0.08);transform-origin:left center;transition:transform 1s linear;}" +
    "a{color:var(--color-accent);}a:active{opacity:0.8;}" +
    "a:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px;}" +
    "@media (prefers-reduced-motion:reduce){.bar-fill{transition:none;}}" +
    "</style></head>" +
    "<body><main id=\"wakeCard\" data-usual=\"" + usual + "\">" +
    "<h1>AgentX is waking up</h1>" +
    "<p id=\"status\">The machine was paused and is starting now.</p>" +
    "<div class=\"bar\"><div class=\"bar-fill\" id=\"barFill\"></div></div>" +
    "<p>Elapsed <span id=\"elapsed\">0s</span>. " + usualText + "</p>" +
    "<p><a href=\"/status\">Status page</a></p>" +
    "</main>" +
    "<script>(function(){/* UI-TIMER-ALLOWLIST: waking page progress tick, 1s elapsed and bar update while the user watches the machine wake */var t0=Date.now();var el=document.getElementById(\"elapsed\");var bar=document.getElementById(\"barFill\");var st=document.getElementById(\"status\");var usual=Number(document.getElementById(\"wakeCard\").dataset.usual)||60;var tries=0;function paint(){var s=Math.floor((Date.now()-t0)/1000);el.textContent=s+\"s\";var frac=Math.min(0.08+s/usual*0.88,0.96);bar.style.transform=\"scaleX(\"+frac+\")\";}setInterval(paint,1000);paint();function schedule(){setTimeout(poll,5000);}function poll(){tries++;fetch(location.pathname+location.search,{cache:\"no-store\",headers:{Accept:\"text/html\"}}).then(function(r){if(r.status!==200){schedule();return;}return r.text().then(function(t){if(t.indexOf(\'id=\"root\"\')!==-1){st.textContent=\"Machine is up. Loading the console.\";bar.style.transform=\"scaleX(1)\";location.reload();return;}if(tries<3){st.textContent=\"The machine was paused and is starting now.\";}else{st.textContent=\"Still waking. The machine usually takes about a minute. Keeping watch.\";}schedule();});}).catch(function(){schedule();});}setTimeout(poll,3000);})();</script>" +
    "</body></html>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Retry-After": "30", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" } },
  );
}

/**
 * The cooldown page.
 *
 * retryAfter is seconds; untilText is the human wall-clock ("2026-11-16
 * 07:53 UTC") parsed from InstaBox's own message. Showing the time is the
 * difference between "wait" and "come back at 13:23" — the second is actionable,
 * and it is what Rohan asked for. Rebuilt 2026-11-19 as one centred card
 * (Smart Sleep/Wake Part 2): the bar is determinate from data-start and
 * data-end and hidden when data-start is absent; the page reloads once at
 * cooldown end, guarded to at most one auto-reload per 30 s per tab.
 */
function cooldownPage(retryAfter, untilText) {
  var mins = null;
  if (typeof retryAfter === "number" && isFinite(retryAfter) && retryAfter > 0) { mins = Math.ceil(retryAfter / 60); }
  var remain = fmtCooldownRemaining(retryAfter);
  var start = 0;
  var end = 0;
  if (mins !== null) { start = Date.now(); end = start + retryAfter * 1000; }
  var barAttrs = "";
  var barHidden = " hidden";
  if (mins !== null) { barAttrs = " data-start=\"" + start + "\" data-end=\"" + end + "\""; barHidden = ""; }
  var remainHtml = "";
  if (remain) {
    remainHtml = "<p><span id=\"remainingText\">" + remain + " left.</span>";
    if (untilText) { remainHtml = remainHtml + " Come back at " + untilText + "."; }
    remainHtml = remainHtml + "</p>";
  }
  return new Response(
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    // Auto-refresh exactly when the cooldown is due to end, so the visitor does
    // not have to guess — and so we do not poll early (every early request is
    // refused and teaches the user the page is broken).
    (retryAfter ? "<meta http-equiv=\"refresh\" content=\"" + Math.max(5, mins * 60) + "\">" : "") +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>AgentX: Cooldown</title>" +
    "<meta name=\"description\" content=\"AgentX is in max-run cooldown. This page reloads when the cooldown ends.\">" +
    "<style>" +
    "/* Hallmark · v2.0.0 · theme: AgentX status (custom) · genre modern-minimal · shape: one card */" +
    "/* Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V4 · weakest: S, led with the live state */" +
    ":root{color-scheme:dark;--color-bg:oklch(0.23 0.012 260);--color-surface:oklch(0.28 0.014 260);--color-track:oklch(0.35 0.012 260);--color-ink:oklch(0.93 0.008 250);--color-muted:oklch(0.74 0.01 250);--color-line:oklch(0.40 0.012 260);--color-accent:oklch(0.75 0.13 155);--color-accent-ink:oklch(0.24 0.03 160);--font-display:Georgia,\"Times New Roman\",serif;--font-body:system-ui,-apple-system,\"Segoe UI\",sans-serif;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:32px;--radius-card:16px;--radius-control:10px;--text-title:1.75rem;--text-body:1rem;--text-small:0.875rem;--width-card:38rem;}" +
    "*{box-sizing:border-box;}::selection{background:var(--color-accent);color:var(--color-accent-ink);}html{scrollbar-color:var(--color-line) var(--color-bg);}" +
    "html,body{overflow-x:clip;}" +
    "body{margin:0;min-height:100svh;display:grid;place-items:center;padding:var(--space-6) var(--space-4);background:var(--color-bg);color:var(--color-ink);font-family:var(--font-body);font-size:var(--text-body);line-height:1.55;}" +
    "main{width:100%;max-width:var(--width-card);background:var(--color-surface);border:1px solid var(--color-line);border-radius:var(--radius-card);padding:var(--space-6);}" +
    "h1{font-family:var(--font-display);font-size:var(--text-title);line-height:1.15;margin:0 0 var(--space-3);overflow-wrap:break-word;min-width:0;text-wrap:balance;}" +
    "p{margin:0 0 var(--space-4);}" +
    "p:last-child{margin-bottom:0;}" +
    ".fine{color:var(--color-muted);font-size:var(--text-small);}" +
    ".bar{background:var(--color-track);border-radius:var(--radius-control);height:8px;overflow:hidden;margin:var(--space-4) 0;}" +
    ".bar-fill{background:var(--color-accent);height:100%;border-radius:var(--radius-control);transform:scaleX(0);transform-origin:left center;transition:transform 1s linear;}" +
    "a{color:var(--color-accent);}a:active{opacity:0.8;}" +
    "a:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px;}" +
    "@media (prefers-reduced-motion:reduce){.bar-fill{transition:none;}}" +
    "</style></head>" +
    "<body><main>" +
    "<h1>AgentX is in max-run cooldown</h1>" +
    "<p>The machine hit its maximum run length and is cooling down. Nothing can wake it until the cooldown ends.</p>" +
    "<div class=\"bar\" id=\"barWrap\"" + barAttrs + barHidden + "><div class=\"bar-fill\" id=\"barFill\"></div></div>" +
    remainHtml +
    "<p>The keep-alive Worker brings it back once the cooldown ends.</p>" +
    "<p><a href=\"/status\">Status page</a></p>" +
    "</main>" +
    "<script>(function(){/* UI-TIMER-ALLOWLIST: cooldown bar and countdown tick, 1s update while the user watches the cooldown end */var wrap=document.getElementById(\"barWrap\");var fill=document.getElementById(\"barFill\");var rem=document.getElementById(\"remainingText\");var start=Number(wrap.dataset.start)||0;var end=Number(wrap.dataset.end)||0;var KEY=\"agentxCooldownReloadAt\";var reloadTried=false;if(!start||!end){wrap.hidden=true;return;}function fmtLeft(ms){var mins=Math.ceil(ms/60000);if(mins<=1){return \"about 1 minute left.\";}return \"about \"+mins+\" minutes left.\";}function tryReload(){var last=0;try{last=Number(sessionStorage.getItem(KEY))||0;}catch(e){last=0;}var now=Date.now();if(now-last<30000){setTimeout(tryReload,30000);return;}try{sessionStorage.setItem(KEY,String(now));}catch(e){}location.reload();}function tick(){var now=Date.now();var total=end-start;var done=now-start;var frac=done/total;if(frac<0){frac=0;}if(frac>1){frac=1;}fill.style.transform=\"scaleX(\"+frac+\")\";if(now>=end){if(rem){rem.textContent=\"Cooldown over. Loading.\";}if(!reloadTried){reloadTried=true;tryReload();}return;}if(rem){rem.textContent=fmtLeft(end-now);}}setInterval(tick,1000);tick();})();</script>" +
    "</body></html>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'", ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) } },
  );
}

function parseRetryAfter(res, bodyText) {
  const h = res.headers.get("Retry-After");
  if (h && /^\d+$/.test(h.trim())) return Number(h.trim());
  try {
    const j = JSON.parse(bodyText || "{}");
    const s = j?.error?.retryAfterSeconds ?? j?.retryAfterSeconds;
    if (typeof s === "number") return s;
  } catch { /* not JSON */ }
  return null;
}

async function proxy(request, url, env, ctx) {
  // --- qwenpaw-query-token-leak mitigation (audit item, fixed 2026-11-15) ---
  // QwenPaw's console accepts the bearer token as `?token=` on EVERY request
  // (`app/auth.py::_extract_token` falls through to the query param; the SPA
  // itself emits `?token=` URLs for file previews). We cannot patch the
  // upstream container, and the SPA depends on the behaviour — so the fix
  // belongs here, at the only hop we control:
  //
  //   1. lift `?token=` into an `Authorization: Bearer` header, and
  //   2. DELETE it from the forwarded URL.
  //
  // The origin still authorizes (it checks the header FIRST), but the token
  // never reaches the InstaBox edge access log, and never appears in a
  // proxied redirect Location or an upstream error body.
  const fwdUrl = new URL(request.url);
  const queryToken = fwdUrl.searchParams.get("token");
  if (queryToken) {
    fwdUrl.searchParams.delete("token");
  }
  const originUrl = ORIGIN + fwdUrl.pathname + fwdUrl.search;
  const pagesOrigin = url.origin;
  const isSafeMethod = request.method === "GET" || request.method === "HEAD";

  const buildRequest = (targetUrl) => {
    const req = new Request(targetUrl || originUrl, request);
    req.headers.delete("host");
    req.headers.delete("cf-connecting-ip");
    req.headers.delete("cf-ipcountry");
    req.headers.delete("cf-ray");
    req.headers.delete("cf-visitor");
    req.headers.set("X-Forwarded-Host", url.host);
    req.headers.set("X-Forwarded-Proto", "https");
    // Apply the lifted token only when the caller did not already send a
    // bearer credential — an explicit header always wins.
    if (queryToken && !req.headers.get("Authorization")) {
      req.headers.set("Authorization", "Bearer " + queryToken);
    }
    return req;
  };

  let res;
  try {
    res = await fetch(buildRequest());
  } catch {
    // Deliberately generic: fetch error text can contain the origin URL
    // or stack fragments — never reflect it to the visitor. Optional catch
    // binding (the error is unused on purpose, not by oversight).
    return new Response("AgentX origin unreachable. Try again in a moment.", {
      status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  // Renamed-chunk fallback (P0 /chat render error, 2026-11-20).
  // The takeover2 cache-bust renamed one content-hashed console chunk
  // (index-opcB8AGu.js -> index-opcB8AGu-tk2.js) and rewrote the entry
  // chunk's dynamic import to the new name. The entry chunk is served
  // under the versioned URL and edge-cached, so a browser keeps asking
  // for the RENAMED chunk even after the machine's console has reverted
  // to a build that only has the ORIGINAL filename (container recreate,
  // console re-sync, snapshot restore all do this). The renamed chunk
  // then 404s at the origin, the /chat lazy import rejects, and React
  // renders the "Something went wrong" error boundary — exactly the
  // reported P0 (shell + sidebar fine, main chat panel fails after
  // "Loading...").
  //
  // Fix: on a 404 for a hashed asset whose name carries the takeover
  // version marker (-tk<N>), retry once against the original filename,
  // which the origin still has. Self-healing in both directions: when the
  // origin is re-patched the first fetch returns 200 and this never runs;
  // while it is not, the console still loads instead of erroring. Scoped
  // to a 404 on a -tk<N> hashed asset so it can never mask a genuine
  // missing-route 404 or an API error.
  let assetFallback = false;
  if (res.status === 404 && isSafeMethod) {
    const renamed = /^\/assets\/([A-Za-z0-9._-]+?)-tk[0-9]+\.(js|css|woff2?|png|svg|jpe?g|webp|ico|map)$/i.exec(fwdUrl.pathname);
    if (renamed) {
      const fallbackPath = "/assets/" + renamed[1] + "." + renamed[2] + fwdUrl.search;
      try {
        const alt = await fetch(buildRequest(ORIGIN + fallbackPath));
        if (alt.status === 200) {
          res = alt;
          assetFallback = true;
        } else if (alt && alt.body) {
          try { await alt.body.cancel(); } catch { /* already consumed */ }
        }
      } catch { /* origin unreachable for the fallback too — keep the 404 */ }
    }
  }

  // 503 = InstaBox is waking the machine. Wait, then retry once (safe methods
  // only — a streamed request body cannot be sent twice). Still waking after
  // that: return the auto-refreshing waking page.
  if (res.status === 503 && isSafeMethod) {
    let retryAfter = null;
    try {
      const bodyText = await res.text();
      retryAfter = parseRetryAfter(res, bodyText);
    } catch { /* ignore */ }
    try {
      await sleep(WAKE_WAIT_MS);
      res = await fetch(buildRequest());
    } catch {
      return wakingPage(retryAfter);
    }
    if (res.status === 503) {
      try {
        const bodyText = await res.text();
        retryAfter = parseRetryAfter(res, bodyText) ?? retryAfter;
      } catch { /* ignore */ }
      return wakingPage(retryAfter);
    }
  } else if (res.status === 503) {
    return wakingPage(null);
  }

  // 409 = max-run cooldown (or another operation conflict). Surface it plainly.
  if (res.status === 409) {
    let retryAfter = null;
    let code = null;
    let untilText = null;
    try {
      const bodyText = await res.text();
      retryAfter = parseRetryAfter(res, bodyText);
      // InstaBox's own message carries the wall-clock instant:
      //   "machine is cooling down until 2026-11-16T07:53:20Z"
      // Quoting it back turns "wait" into "come back at 13:23", which is what
      // Rohan asked for and what a person can act on.
      const m = /until\s+([0-9T:.\-]+Z)/i.exec(bodyText || "");
      if (m) {
        const t = Date.parse(m[1]);
        if (Number.isFinite(t)) {
          untilText = new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
          // Trust the timestamp over the seconds field when both exist: the
          // seconds are relative to the response and drift if it is cached.
          const derived = Math.max(1, Math.round((t - Date.now()) / 1000));
          if (Number.isFinite(derived)) retryAfter = Math.min(retryAfter ?? derived, derived);
        }
      }
      code = JSON.parse(bodyText || "{}")?.error?.code ?? null;
    } catch { /* ignore */ }
    if (code === "machine_cooldown") return cooldownPage(retryAfter, untilText);
    return new Response(
      `AgentX is busy with another operation (409 ${code || ""}). Retry in a moment.`,
      { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    );
  }

  const headers = rewriteHeaders(res, pagesOrigin);

  // WebSocket upgrade: return the upgrade response (with its webSocket) as-is.
  if (res.status === 101 && res.webSocket) {
    return new Response(null, { status: 101, headers, webSocket: res.webSocket });
  }

  // Side-panel injection (Rakazo's right bot sidebar, worker-injection
  // way): the QwenPaw console is a React SPA whose HTML the proxy serves.
  // Its CSP is only `frame-ancestors 'self'` — no script-src — so an
  // injected same-origin <script> runs. The script appends a floating
  // "Computer" button + a 316px right sidebar panel (iframe to /desktop)
  // to document.body, OUTSIDE React's #root, so React re-renders can
  // never remove it. Only the SPA index is injected (marker
  // `<div id="root"`); API JSON, SSE streams and assets are untouched.
  // The injection is defensive (try/catch, feature-detect) so a failure
  // can never break the console.
  //
  // AgentX rebrand (2026-11-18): the same injection carries the early shim
  // (headShim — fetch/window.open patches, must run before the deferred
  // module bundle) and the rebrand rules (inside computerPanelScript).
  // The <title> is rewritten here at the proxy layer because the root HTML
  // is ours to serve; the observer renames it again if React changes it.
  // Kill switch: AGENTX_REBRAND=0 (worker env) skips the shim and bakes
  // the rebrand flag false; ?rebrand=0 skips it per page load at runtime.
  if (isSafeMethod && res.status === 200 && (headers.get("Content-Type") || "").includes("text/html")) {
    try {
      const html = await res.text();
      if (html.includes('<div id="root"') && html.includes("</body>")) {
        // A console page load is a visit (sleep/wake signal). Fire-and-forget.
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(recordLastVisit(env));
        const rebrandEnabled = env.AGENTX_REBRAND !== "0";
        // B2 / /chat unification (2026-11-19): the console's own index.html
        // may already carry the baked rebrand (features/rebrand/bake_rebrand.py
        // injects the same block at image-build time). When it does, the
        // ORIGIN serves the AgentX look itself, and injecting here again
        // would apply every rule twice — double observers, double Vault/
        // Rest/Computer pills, double grammar fixes. So the injection is
        // skipped and the origin HTML is passed through as-is. The header
        // work below (no-store, CSP-Report-Only, Referrer-Policy) and the
        // visit record still apply either way.
        const alreadyBaked = html.includes("agentx-rebrand-baked");
        const titled = alreadyBaked ? html : html.replace("<title>QwenPaw Console</title>", "<title>AgentX Console</title>");
        // Logo-flash guard (2026-11-19 QA round 20): the header logo img
        // (alt "QwenPaw") painted before the rebrand observer renamed it.
        // Hide QwenPaw-alt imgs until rename-logo processes them (it sets
        // data-agentx-logo, which lifts the hide; the big logo is swapped
        // for the AgentX text label anyway). visibility, not display: the
        // rule's size gate needs a real displayed width. Only when the
        // rebrand is on — with ?rebrand=0 the console shows QwenPaw.
        const rebrandStyle = (rebrandEnabled && !alreadyBaked) ? '<style>img[alt*="QwenPaw"]:not([data-agentx-logo]){visibility:hidden !important}</style>' : "";
        // Search settings UI (2026-11-18): the Settings "Search" section
        // (TinyFish key + feature checkboxes) loads as a module from the
        // Pages assets and self-mounts when the Settings page is present.
        // A module script is deferred, so it runs after the SPA HTML parses.
        const searchSettingsScript = alreadyBaked ? "" : '<script type="module" src="/search-settings-ui.js"></script>';
        // The shim term is hoisted so the injection stays a flat statement:
        // nesting it inside the alreadyBaked ternary would read as a nested
        // ternary and hide which branch actually runs.
        const shimTag = rebrandEnabled ? headShim() : "";
        let injected = titled;
        if (!alreadyBaked) {
          injected = titled.replace("</body>", rebrandStyle + shimTag + computerPanelScript(rebrandEnabled) + searchSettingsScript + "</body>");
        }
        headers.set("Cache-Control", "no-store, no-transform");
        headers.delete("ETag");
        headers.delete("Last-Modified");
        headers.delete("Content-Length");
        // AgentX rebrand (2026-11-18): block the Alibaba CDN illustration
        // images (gw.alicdn.com / img.alicdn.com, 17 distinct URLs on
        // channel/setup pages) at the header layer. Report-Only first —
        // nothing is blocked yet, violations are logged to the console;
        // promote to an enforcing img-src after a day of reports. No
        // report-uri is set (no endpoint exists yet); check DevTools.
        // Referrer-Policy no-referrer overrides the same-origin set by
        // rewriteHeaders for this HTML response only: strictly better for
        // the token-leak fix (nothing is sent anywhere) and it does not
        // break same-origin navigation, which does not need a Referer.
        headers.set("Content-Security-Policy-Report-Only", "img-src 'self' data: blob:");
        headers.set("Referrer-Policy", "no-referrer");
        return new Response(injected, { status: res.status, statusText: res.statusText, headers });
      }
      return new Response(html, { status: res.status, statusText: res.statusText, headers });
    } catch {
      // The origin body could not be read (it may now be consumed) —
      // do not return a broken stream.
      return new Response("AgentX console temporarily unavailable. Try again in a moment.", {
        status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
  }

  // Hashed-asset caching (sleep/wake + slow-open fix, 2026-11-17): the
  // console SPA is a 1 MB JS bundle whose filename carries a content hash
  // (e.g. /assets/index-DZrIuh3B.js). It is re-downloaded fresh on EVERY
  // load today because the proxy (and/or the origin) marks it no-store —
  // a big part of the slow open. A content-hashed filename can never go
  // stale (a rebuild produces a NEW filename, and the HTML references the
  // new one), so it is safe to cache for a year. HTML and API responses
  // keep no-store. The hash test is deliberately strict: a bare
  // /assets/foo.js (no hash) stays no-store.
  if (/^\/assets\/[^/]*-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/.test(url.pathname)) {
    // A fallback-served asset is the origin's content for a DIFFERENT
    // filename, so it must not be pinned for a year — a re-patched origin
    // could never win. Revalidate quickly instead.
    headers.set("Cache-Control", assetFallback ? "public, max-age=60" : "public, max-age=31536000, immutable");
    headers.delete("ETag");
    headers.delete("Last-Modified");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Status / wake page — served from static assets, not proxied.
    if (path === "/status" || path === "/status.html") {
      if (!env.ASSETS) {
        return new Response("Status page assets are not bound.", { status: 500 });
      }
      // NOTE: fetch "status-page.html", not "status.html" — Pages redirects
      // a request for /status.html to the clean URL /status (308), which
      // would loop back here. The differently-named asset is served as-is.
      return env.ASSETS.fetch(new Request(url.origin + "/status-page.html"));
    }

    // Search settings UI — the Settings "Search" section (TinyFish key +
    // feature checkboxes, 2026-11-18). The module is a Pages static asset
    // (pages/public/search-settings-ui.js); without this route the request
    // falls through to the console proxy, which answers with the SPA HTML
    // (B-35) and the <script src> parses as nothing.
    if (path === "/search-settings-ui.js") {
      if (!env.ASSETS) {
        return new Response("Search settings assets are not bound.", { status: 500 });
      }
      return env.ASSETS.fetch(new Request(url.origin + "/search-settings-ui.js"));
    }

    // Computer (rebuilt from Rakazo's design, 2026-11-15). Everything under
    // /computer is its own surface; the console proxy below is untouched.
    // `/vendor/*` is routed to the computer surface too. The UI loads xterm
    // from `/vendor/xterm.js`, and without this the request fell through to the
    // CONSOLE PROXY — which answered it with the QwenPaw SPA: 200, text/html,
    // 45,989 bytes. A `<script src>` served as HTML parses as nothing, so
    // `window.Terminal` was never defined and the terminal pane stayed black
    // while the session still showed "connected" (BUGS.md B-35).
    //
    // A 200 with the wrong body type is the worst failure shape there is: no
    // onerror, no console message, nothing to grep. Serving it from the Pages
    // asset binding with the right MIME is the fix.
    if (path === "/computer" || path.startsWith("/computer/") || path.startsWith("/vendor/")) {
      try {
        return await handleComputer(request, env, url);
      } catch (err) {
        return new Response(JSON.stringify({ error: "computer_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Vault (Rakazo-style API-key vault, 2026-11-17). Everything under /vault
    // is its own surface; the console proxy below is untouched. The page
    // itself is exempt from the session gate (B-39 lesson — the page is
    // static bytes, the way in); every endpoint it calls is gated by the
    // vault router's own requiresSession(). ORIGIN is passed through so
    // /vault/reveal can verify the console bearer token against
    // /api/cron/jobs (the same probe /api/session/mint uses).
    if (path === "/vault" || path.startsWith("/vault/")) {
      try {
        return await handleVault(request, env, url, ORIGIN);
      } catch (err) {
        return new Response(JSON.stringify({ error: "vault_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Settings Reset (2026-11-18). Everything under /reset is its own
    // surface; the page itself is exempt from the session gate (B-39 lesson),
    // every API call is verified live against the console by the reset
    // router's authenticate() and forwarded to the machine-side reset
    // broker. See features/reset/README.md.
    if (path === "/reset" || path.startsWith("/reset/")) {
      try {
        return await handleReset(request, env, url, ORIGIN);
      } catch (err) {
        return new Response(JSON.stringify({ error: "reset_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // ---- session for the /computer surface (see pages/public/session.js) ----
    //
    // This is the ONLY place a DESKTOP_SESSION cookie is minted. It requires a
    // bearer token the console actually accepts, so the cookie inherits the
    // console's own revocation behaviour: revoke the token upstream and the
    // next mint fails. The cookie carries no console credential — it is only
    // proof that this browser passed that check within the TTL.
    //
    // POST only: a GET would be mintable by any <img src>, which turns every
    // page that can embed a URL into a session factory.
    if (path === "/api/session/mint") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "method_not_allowed" }), {
          status: 405, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const auth = await authenticate(request, env, ORIGIN);
      if (!auth.ok) {
        return new Response(JSON.stringify({
          error: auth.error,
          detail: auth.detail || null,
        }), {
          status: auth.status || 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const secret = env.COMPUTER_SESSION_SECRET || env.COMPUTER_CAPABILITY_SECRET;
      const value = await mintSession(secret, { ttlMs: SESSION_TTL_MS });
      if (!value) {
        // Fail closed and NAME the missing secret. Minting an unsigned or
        // default-keyed session would be worse than minting none.
        return new Response(JSON.stringify({
          error: "unconfigured",
          detail: "COMPUTER_SESSION_SECRET (or COMPUTER_CAPABILITY_SECRET) is not set, "
            + "so no session can be minted.",
        }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      return new Response(JSON.stringify({ ok: true, expiresInMs: SESSION_TTL_MS }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": sessionSetCookie(value),
        },
      });
    }

    // Honest status read: the /computer page asks this on load so it can tell
    // "you are not signed in" apart from "the store is broken". No cookie is
    // returned by this endpoint, so it is safe to answer anonymously.
    if (path === "/api/session/state") {
      const s = await sessionFromRequest(env, request);
      return new Response(JSON.stringify({ ok: s.ok, reason: s.ok ? null : s.reason }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // Clearing is a POST for the same reason minting is: a logout reachable by
    // GET is a logout a third-party <img> can trigger.
    if (path === "/api/session/clear") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "method_not_allowed" }), {
          status: 405, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": sessionClearCookie(),
        },
      });
    }

    // ---- machine rest / state (Rohan's manual-rest feature) ----
    // The Rest button lives in the console header (injected below) so it is
    // always reachable; these are the endpoints behind it.
    if (path === "/api/machine/rest") {
      try {
        return await restMachine(request, env, ORIGIN);
      } catch (err) {
        return new Response(JSON.stringify({ error: "machine_rest_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }
    // Intelligent sleep/wake (2026-11-17): the keep-alive Worker calls this
    // when its decision function says SLEEP. Auth is the shared SLEEP_TOKEN
    // (machine-control.js), not a console session — the keep-alive Worker
    // has no console session. Pages holds INSTABOX_API_KEY and suspends.
    if (path === "/api/machine/sleep") {
      try {
        return await sleepMachine(request, env);
      } catch (err) {
        return new Response(JSON.stringify({ error: "machine_sleep_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }
    if (path === "/api/machine/state") {
      try {
        return await machineState(env);
      } catch (err) {
        return new Response(JSON.stringify({ error: "machine_state_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    return proxy(request, url, env, ctx);
  },
};

// --- Intelligent sleep/wake: last-visit recording (2026-11-17) ----------
// A console page load is a visit: the user is here, so the keep-alive
// must keep the machine awake. Recorded in D1 meta (sleepwake:last-visit),
// throttled to one write per 5 minutes so a page reload storm cannot
// burn the D1 write budget. Fire-and-forget via ctx.waitUntil so the
// write never delays the console. Never throws (a failed write must not
// break the page). Only page loads count — /api/* polling is excluded
// (the SPA polls constantly; counting it would keep the machine awake
// forever). The call site is the HTML-injection branch in proxy(), which
// only fires for the SPA index.
async function recordLastVisit(env) {
  const db = env.COMPUTER_DB || env.QWENPAW_DB;
  if (!db) return;
  try {
    const now = Date.now();
    const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind("sleepwake:last-visit").first();
    const prev = row && row.value ? Number(row.value) : NaN;
    if (Number.isFinite(prev) && now - prev < 5 * 60_000) return;
    await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind("sleepwake:last-visit", String(now)).run();
  } catch { /* never break the console */ }
}
