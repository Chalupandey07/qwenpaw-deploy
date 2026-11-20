#!/usr/bin/env node
/**
 * Generate the AgentX rebrand block as STATIC text for baking into the
 * console's own index.html (B2 / /chat unification).
 *
 * Today the AgentX look exists only at the Pages proxy layer:
 * pages/public/_worker.js injects headShim() + computerPanelScript() +
 * search-settings-ui.js into the served HTML. The direct origin serves
 * the raw QwenPaw console, so the two disagree. Baking the SAME block
 * into the console's index.html makes the origin match Pages.
 *
 * The block must be byte-identical to what the proxy injects — these
 * functions in _worker.js are the single source of truth (the "spec").
 * Rather than hand-copying 145 KB of rules (which would drift), this
 * script IMPORTS the real functions from _worker.js and emits their
 * output. The repo's committed baked-injection.html is regenerated from
 * here whenever the rebrand changes.
 *
 * Usage:  node features/rebrand/generate-baked-block.mjs [--check]
 *   default: write features/rebrand/baked-injection.html
 *   --check: regenerate and exit 1 if the committed file differs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, "..", "..", "pages", "public");
const OUT = path.join(HERE, "baked-injection.html");

const MARKER_START = "<!-- agentx-rebrand-baked:start -->";
const MARKER_END = "<!-- agentx-rebrand-baked:end -->";

/** Build a temp copy of pages/public that Node can import as ESM. */
function buildImportableCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), "bake-"));
  // The whole public tree is copied so _worker.js's relative imports
  // (./machine-control.js -> ./machine-rest.js -> ./computer/*.js)
  // resolve exactly as they do in the real deployment.
  execFileSync("cp", ["-r", `${PUBLIC}/.`, `${dir}/`]);
  // The public tree uses ESM syntax in .js files; Node needs this to
  // treat them as modules rather than CommonJS.
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  // Export the two injection builders, which the proxy uses internally.
  const worker = path.join(dir, "_worker.js");
  writeFileSync(
    worker,
    readFileSync(worker, "utf8") +
      "\nexport { headShim, computerPanelScript };\n",
  );
  return dir;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const dir = buildImportableCopy();
  let block;
  try {
    const mod = await import(pathToFileUrl(path.join(dir, "_worker.js")));
    // These MUST mirror pages/public/_worker.js L3122-3127 exactly:
    //   rebrandStyle + headShim() + computerPanelScript(true) + searchSettingsScript
    const rebrandStyle =
      '<style>img[alt*="QwenPaw"]:not([data-agentx-logo]){visibility:hidden !important}</style>';
    const searchSettingsScript =
      '<script type="module" src="/search-settings-ui.js"></script>';
    const head = mod.headShim();
    const panel = mod.computerPanelScript(true);
    if (!head || !panel || !panel.includes("AGENTX_REBRAND_ENABLED")) {
      throw new Error("the extracted rebrand functions returned no usable block");
    }
    block =
      MARKER_START +
      "\n" +
      rebrandStyle +
      head +
      panel +
      searchSettingsScript +
      "\n" +
      MARKER_END;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (checkOnly) {
    const committed = readFileSync(OUT, "utf8");
    if (committed !== block) {
      console.error("STALE: baked-injection.html does not match _worker.js.");
      console.error("Regenerate it: node features/rebrand/generate-baked-block.mjs");
      process.exit(1);
    }
    console.log(`baked-injection.html matches _worker.js (${block.length} bytes)`);
    return;
  }

  writeFileSync(OUT, block);
  console.log(`wrote ${OUT} (${block.length} bytes)`);
}

function pathToFileUrl(p) {
  return "file://" + p.split(path.sep).map(encodeURIComponent).join("/");
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
