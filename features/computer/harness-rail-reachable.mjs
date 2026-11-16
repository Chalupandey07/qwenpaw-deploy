#!/usr/bin/env node
/**
 * Harness T104 — the sidebar must stay reachable after the screen connects.
 *
 * THE LIVE FAILURE (10th browser check, 14:08-15:22 IST)
 *
 * The rail (Live / Terminal / Teach / Advanced, preview, "Open terminal") was
 * visible only for 1-2 s during "Opening the computer…", then hid and could not
 * be brought back. The browser tried reload-and-click races, pixel clicks at
 * the rail coordinates, element-reference clicks (refused as "covered"), Tab
 * (which went into the noVNC screen and reached the remote desktop), edge
 * hover/drag, the top-bar controls, and a new tab. Nothing worked. The Terminal
 * tab could therefore never be selected, which is why the B-33 terminal fix
 * could not even be verified.
 *
 * ROOT CAUSE — two structural faults, not a timer
 *
 * 1. `#overlay` was `position:fixed; inset:0; z-index:30` — a full-viewport
 *    layer above everything — and the boot code opened it AUTOMATICALLY on any
 *    window wider than 1100px:
 *
 *        if (q.get("overlay") === "1" || window.innerWidth > 1100) openOverlay();
 *
 *    So on every normal desktop the rail was covered from the first second,
 *    and the screen iframe inside the overlay swallowed clicks aimed at it.
 *    That is the "covered" refusal in the browser's own log.
 *
 * 2. `#stage` had NO iframe at all — only a veil. The overlay was the only
 *    place a screen could appear, which is why making it mandatory looked
 *    reasonable and why nothing else could show the desktop.
 *
 * There was also no persistent control to reopen the overlay: the only exit was
 * the overlay's own ✕, so once covered there was no way back.
 *
 * WHAT THIS ASSERTS
 *
 *   a. the overlay does not cover the rail (it starts where the rail ends), and
 *   b. it does not open by itself on a desktop-width window;
 *   c. a persistent trigger exists in the rail header and is wired;
 *   d. `#stage` has a real frame, so the desktop can render beside the rail;
 *   e. the stage frame obeys the same pointer gate as the overlay;
 *   f. the Terminal tab is inside the rail (hence never covered) and is
 *      clickable — i.e. nothing above it intercepts.
 *
 * It cannot run a browser, so it models the two things a browser would prove:
 * geometry (does the overlay rectangle overlap the rail?) and stacking (is
 * anything above the rail?). Those are the actual defects.
 *
 * Run: node features/computer/harness-rail-reachable.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PUBLIC = resolve(REPO, "pages/public");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

const html = readFileSync(resolve(PUBLIC, "computer/ui.html"), "utf8");
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ""])[1]
  .replace(/\/\*[\s\S]*?\*\//g, "");
const js = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));

/** Extract one rule's declarations by selector, ignoring @media for now. */
function rule(selector) {
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g");
  const out = [];
  let m;
  while ((m = re.exec(css))) out.push(m[1]);
  return out;
}

/** Minimal declaration parser. */
function decls(body) {
  const out = {};
  for (const part of body.split(";")) {
    const i = part.indexOf(":");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const RAIL_W = 316;

console.log("geometry: the overlay does not sit on top of the rail");
{
  const bodies = rule("#overlay");
  check("an #overlay rule exists", bodies.length > 0);
  const base = decls(bodies[0] || "");
  check("the overlay is not `inset:0` (a full-viewport layer)",
    base.inset !== "0" && base.inset !== "0px",
    `inset=${JSON.stringify(base.inset)} — this is what covered the rail`);
  check("its left edge starts where the rail ends",
    String(base.left || "").replace("px", "") === String(RAIL_W),
    `left=${JSON.stringify(base.left)} must equal the rail width ${RAIL_W}px`);
  check("it is still anchored to the viewport on the other three sides",
    base.top === "0" && base.right === "0" && base.bottom === "0",
    JSON.stringify({ top: base.top, right: base.right, bottom: base.bottom }));
  check("it is still above the stage (it is a layer, not a sibling in flow)",
    Number(base["z-index"] || 0) > 0, String(base["z-index"]));
}

console.log("geometry: below the breakpoint the rail is full-width, so the overlay may cover");
{
  // The media query at <=860px makes #rail 100% wide and hides #stage. In that
  // layout there is no rail to sit beside, so the overlay must take everything
  // — and the rail is reached by closing it (the ✕ still works).
  const media = /@media\s*\(max-width:\s*860px\)\s*\{([^}]*\}[^}]*)\}/.exec(css);
  check("the small-screen override exists", Boolean(media), String(media && media[1]));
  check("it resets the overlay's left edge to 0",
    media && /#overlay[^{]*\{\s*left:\s*0/.test(media[1]),
    String(media && media[1]));
}

console.log("boot: the overlay does not open by itself on a desktop-width window");
{
  check("the width-based auto-open is gone",
    !/window\.innerWidth\s*>\s*1100/.test(js),
    "`innerWidth > 1100` opened a full-viewport overlay on every desktop — the bug");
  check("the overlay opens only when explicitly requested",
    /q\.get\("overlay"\) === "1"\)\s*openOverlay\(\)/.test(js),
    "?overlay=1 is the opt-in");
  check("the screen still loads when the overlay is not opened",
    /void loadScreen\(\)/.test(js.slice(js.indexOf("await refresh();"))),
    "without this the rail would show a dead stage");
}

console.log("reachability: a persistent control exists and is wired");
{
  check("the rail header has a persistent Open button",
    /id="railExpand"/.test(html), "there was NO way back once covered");
  check("the button lives inside #rail, not the overlay",
    (() => {
      const railAt = html.indexOf('id="rail"');
      const overlayAt = html.indexOf('id="overlay"');
      const btnAt = html.indexOf('id="railExpand"');
      return railAt < btnAt && btnAt < overlayAt;
    })(), "a control inside the overlay could be covered by the screen iframe");
  check("the button is cached and click-wired",
    /railExpand:\s*\$\("railExpand"\)/.test(js)
    && /el\.railExpand\.addEventListener\("click",\s*\(\)\s*=>\s*openOverlay\(\)\)/.test(js));
  check("the preview Open button still works too",
    /el\.previewOpen\.addEventListener\("click",\s*\(\)\s*=>\s*openOverlay\(\)\)/.test(js));
}

console.log("stage: the desktop can render BESIDE the rail");
{
  check("#stage contains a real iframe", /id="stageFrame"/.test(html),
    "it held only a veil, so the overlay was the only place a screen could appear");
  check("the stage frame is sandboxed like the others",
    /id="stageFrame"[\s\S]{0,200}sandbox="allow-scripts allow-pointer-lock"/.test(html),
    "it must stay opaque-origin: the CORS fix depends on it");
  check("mountFrames points the stage frame at the screen",
    /el\.stageFrame\.src = screenPage/.test(js),
    "an unset src is a blank pane beside a working rail");
  check("the stage frame obeys the control gate",
    /el\.stageFrame\.style\.pointerEvents = held \? "auto" : "none"/.test(js),
    "the UI must not invite a click that cannot work");
  check("the stage veil is hidden when connected",
    /phase === "connected"\)\s*\{\s*veil\.hidden = true/.test(js));
}

console.log("stacking: nothing sits above the rail");
{
  // Anything with a z-index that is fixed/absolute AND spans from the left
  // edge could intercept a click on the rail. The only such elements allowed
  // are the toast (pointer-events:none) and the overlay (which now starts at
  // 316px).
  const candidates = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map((m) => ({ sel: m[1].trim(), d: decls(m[2]) }))
    .filter((r) => r.d.position === "fixed" || r.d.position === "absolute")
    .filter((r) => Number(r.d["z-index"] || 0) >= 1);
  const offenders = candidates.filter((r) => {
    if (/#overlay/.test(r.sel)) return false;              // starts at 316px
    if (/toast/.test(r.sel)) return false;                 // pointer-events:none
    if (!(r.d.left === "0" || r.d.inset === "0")) return false;  // not full-width
    return !/pointer-events:\s*none/.test(
      (rule(r.sel)[0] || "").toString());
  });
  check("no z-indexed full-width layer other than the overlay",
    offenders.length === 0,
    JSON.stringify(offenders.map((o) => o.sel)));

  check("the toast cannot intercept a click",
    /pointer-events:\s*none/.test(rule(".toast")[0] || ""),
    "a fixed overlay with pointer-events auto over the rail would block it");
}

console.log("the Terminal tab is inside the rail and reachable");
{
  const tabsAt = html.indexOf('role="tablist"');
  const overlayAt = html.indexOf('id="overlay"');
  check("the tab list precedes the overlay in the DOM",
    tabsAt !== -1 && tabsAt < overlayAt,
    "the rail is the first surface; the overlay comes after it");
  check("the Terminal tab exists", /data-tab="terminal"/.test(html));
  check("the Terminal pane holds the Open button",
    /data-pane="terminal"[\s\S]{0,900}id="termOpen"/.test(html));
  check("the pane is reachable by clicking its tab (the wiring exists)",
    /querySelectorAll\("\.tab"\)\.forEach/.test(js)
    && /setAttribute\("aria-selected"/.test(js));
}

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
