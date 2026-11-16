#!/usr/bin/env node
/**
 * Harness T100 — the Asleep overlay is actually hidden when the preview is live.
 *
 * THE BUG THIS EXISTS FOR (BUGS.md B-30)
 *
 * The sidebar preview stayed on "Asleep" with a Wake button while `/computer`
 * reported `running` (Gen 39-41) and the large overlay showed the real XFCE
 * desktop. The preview never displayed the desktop at all.
 *
 * The JS was already correct:
 *
 *     el.previewAsleep.hidden = live;      // live = status is running/up
 *
 * but `.preview .asleep { display: grid }` (specificity 0,2,0) outranks the UA
 * stylesheet's `[hidden] { display: none }` (0,1,0). So the attribute was set,
 * the computed `display` stayed `grid`, and the opaque overlay kept covering
 * the preview iframe. Every sibling overlay in the file already carried an
 * explicit `[hidden]` companion rule — `.screen-veil[hidden]`, `.err[hidden]`,
 * `.card[hidden]` — and this one was simply missing.
 *
 * WHY THIS TEST EVALUATES SPECIFICITY INSTEAD OF GREPPING
 *
 * A string assertion ("does the file contain `.asleep[hidden]`?") would pass on
 * a rule that sits in a later overridden block, inside a media query that never
 * matches, or next to a `!important` that reverses it. The bug is a CASCADE
 * failure, so the test has to model the cascade: parse the selectors that can
 * match the element, compute their specificity, and confirm the winning
 * declaration is `display:none` when the attribute is present.
 *
 * No CSS library is used — a dependency for one assertion is a worse trade than
 * ~80 lines of specificity arithmetic, and it keeps the test runnable in the
 * repo's existing "node file.mjs" style.
 *
 * Run: node features/computer/harness-preview-asleep.mjs
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
const styleSrc = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ""])[1];
const jsSrc = (html.match(/<script>([\s\S]*?)<\/script>/) || [, ""])[1];

// ---------------------------------------------------------------- CSS parsing
/** Strip comments so they cannot be mistaken for rules. */
const css = styleSrc.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Selector specificity as [ids, classes, types].
 *
 * Handles the subset this stylesheet actually uses: type selectors, classes,
 * ids, attribute selectors (`[hidden]`), and descendant compounds. Pseudo-
 * classes count as classes; `:not()` would need special handling and does not
 * appear here (asserted below, so this simplification cannot rot silently).
 */
function specificity(selector) {
  const sel = selector.trim();
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  // Attributes and pseudo-classes both count at the class level.
  const classes = (sel.match(/\.[\w-]+/g) || []).length
    + (sel.match(/\[[^\]]+\]/g) || []).length
    + (sel.match(/:(?!:)[\w-]+(\([^)]*\))?/g) || []).length;
  const types = (sel.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return [ids, classes, types];
}

const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

/** Parse flat rules: `sel, sel { decls }`. Nested at-rules are reported. */
function parseRules(source) {
  const rules = [];
  const atRules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(source))) {
    const selector = m[1].trim();
    const body = m[2].trim();
    if (selector.startsWith("@")) { atRules.push(selector); continue; }
    rules.push({ selector, body, selectors: selector.split(",").map((s) => s.trim()) });
  }
  return { rules, atRules };
}

const { rules, atRules } = parseRules(css);

/**
 * Which `display` declaration wins for an element with these classes,
 * id, tag and attributes?
 */
function winningDisplay({ tag, id, classes, attrs = [] }, source = css) {
  const parsed = parseRules(source);
  let best = null;
  for (const rule of parsed.rules) {
    for (const sel of rule.selectors) {
      // Does this selector match the element? Only the simple forms used here:
      // `.a .b`, `.a.b`, `#x`, `tag`, `[attr]` compounds.
      const simple = sel.split(/\s+/).pop();
      const selClasses = (simple.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
      const selId = (simple.match(/#([\w-]+)/) || [])[1];
      const selAttrs = (simple.match(/\[([\w-]+)\]/g) || []).map((a) => a.slice(1, -1));
      const selTag = (simple.match(/^[a-zA-Z][\w-]*/) || [])[0];
      if (selId && selId !== id) continue;
      if (selTag && selTag.toLowerCase() !== tag) continue;
      if (!selClasses.every((c) => classes.includes(c))) continue;
      if (!selAttrs.every((a) => attrs.includes(a))) continue;

      const decl = (rule.body.match(/(?:^|;)\s*display\s*:\s*([^;]+)/) || [])[1];
      if (!decl) continue;
      const spec = specificity(sel);
      const important = /!important/.test(decl);
      const candidate = { spec, important, value: decl.replace(/!important/, "").trim(), sel };
      if (!best
        || (candidate.important && !best.important)
        || (candidate.important === best.important && cmp(candidate.spec, best.spec) > 0)) {
        best = candidate;
      }
    }
  }
  return best;
}

// The preview overlay as it exists in the markup.
const ASLEEP_LIVE = { tag: "div", id: "previewAsleep", classes: ["asleep"], attrs: [] };
const ASLEEP_HIDDEN = { tag: "div", id: "previewAsleep", classes: ["asleep"], attrs: ["hidden"] };

console.log("css: the overlay's own rule still exists (nothing was deleted to win)");
{
  const plain = winningDisplay(ASLEEP_LIVE);
  check("an unhidden .asleep overlay is display:grid",
    plain && plain.value === "grid", JSON.stringify(plain));
  check("…and it is still opaque (it must genuinely cover the preview)",
    /background:#0b0d11/.test((rules.find((r) => r.selector === ".preview .asleep") || {}).body || ""),
    "hiding is not the same as removing it");
}

console.log("css: THE FIX — hidden wins over the class rule");
{
  const hiddenRule = rules.find((r) => r.selectors.some((s) => /\.asleep\[hidden\]/.test(s)));
  check("a `.asleep[hidden]` rule exists", Boolean(hiddenRule),
    "without it the UA's [hidden] loses to .preview .asleep");
  check("its specificity beats `.preview .asleep`",
    hiddenRule && cmp(specificity(".preview .asleep[hidden]"), specificity(".preview .asleep")) > 0,
    hiddenRule ? `${JSON.stringify(specificity(".preview .asleep[hidden]"))} vs ${JSON.stringify(specificity(".preview .asleep"))}` : "");

  const win = winningDisplay(ASLEEP_HIDDEN);
  check("with [hidden], the winning display is none",
    win && win.value === "none",
    `winner: ${win ? `${win.sel} => ${win.value} (${JSON.stringify(win.spec)})` : "none"}`);
  check("…and it wins on specificity, not !important",
    win && !win.important, "an !important here would be a different (worse) fix");
}

console.log("css: every sibling overlay still behaves (no regression)");
{
  // The three that already worked must keep working.
  const siblings = [
    [{ tag: "div", id: "ovVeil", classes: ["screen-veil"], attrs: ["hidden"] }, "none"],
    [{ tag: "div", id: "ovErr", classes: ["err"], attrs: ["hidden"] }, "none"],
    [{ tag: "div", id: "needsYou", classes: ["card"], attrs: ["hidden"] }, "none"],
  ];
  for (const [el, want] of siblings) {
    const win = winningDisplay(el);
    check(`.${el.classes[0]}[hidden] is ${want}`,
      win && win.value === want, `got ${win && win.value}`);
  }
}

console.log("css: the fix cannot be defeated by a later rule");
{
  // If a later rule re-declared display on the overlay, the cascade would need
  // re-checking — this catches a future edit that adds one.
  // Start AFTER the fix rule's closing brace. Slicing from `idx + 1` included
  // the fix rule itself, so the check failed on the very rule it was meant to
  // validate — a self-referential false failure.
  const idx = css.indexOf(".preview .asleep[hidden]");
  const after = css.slice(css.indexOf("}", idx) + 1);
  const laterDisplayOnAsleep = [...parseRules(after).rules]
    .filter((r) => r.selectors.some((s) => /\.asleep/.test(s)))
    .filter((r) => /(?:^|;)\s*display\s*:/.test(r.body));
  check("no later rule re-declares display on .asleep",
    laterDisplayOnAsleep.length === 0,
    JSON.stringify(laterDisplayOnAsleep.map((r) => r.selector)));
  check("the stylesheet uses no :not() (the parser above assumes so)",
    !/:not\(/.test(css), "if this changes, the specificity model needs updating");
  check("no @media block could hide the rule from evaluation",
    atRules.length === 0 || !/display/.test(css.slice(css.indexOf("@media"), css.indexOf("@media") + 200)),
    JSON.stringify(atRules));
}

console.log("js: the logic was already right, and is asserted so it stays right");
{
  check("render() sets previewAsleep.hidden from `live`",
    /el\.previewAsleep\.hidden\s*=\s*live\b/.test(jsSrc),
    "the bug was CSS, not this line — do not 'fix' it here");
  check("`live` means status running or up",
    /const live\s*=\s*state\.status === "running" \|\| state\.status === "up"/.test(jsSrc),
    "a narrower definition would hide the overlay on a live machine");
  // Count ASSIGNMENTS, not mentions: `el.previewAsleep` also appears in the
  // element cache, and a comment may name it. Only writes to `.hidden` can
  // fight render(), so only those are counted.
  const writes = (jsSrc.match(/previewAsleep\.hidden\s*=/g) || []).length;
  check("nothing else toggles the overlay's visibility", writes === 1,
    `${writes} writes to previewAsleep.hidden; more than one would fight render()`);
  check("the element is still cached exactly once",
    (jsSrc.match(/previewAsleep: \$\("previewAsleep"\)/g) || []).length === 1);
  check("the overlay is hidden in the markup by default",
    /id="previewAsleep"[^>]*\bhidden\b/.test(html),
    "before the first poll it must not show a false 'Asleep'");
}

console.log("the fix is scoped: nothing else changed");
{
  // Guard against the fix quietly turning into a redesign.
  const diffWorthy = [
    ["preview iframe is still an iframe", /<iframe id="previewFrame"/.test(html)],
    ["the Wake button still exists", /id="previewWake"/.test(html)],
    ["the Open button still exists", /id="previewOpen"/.test(html)],
    ["the overlay text is still 'Asleep'", /<span>Asleep<\/span>/.test(html)],
  ];
  for (const [name, cond] of diffWorthy) check(name, cond);
}

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
