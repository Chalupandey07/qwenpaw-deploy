#!/usr/bin/env python3
"""Bake the AgentX rebrand into the console's own index.html (B2).

Today the AgentX look is applied only at the Pages proxy layer
(pages/public/_worker.js injects headShim + computerPanelScript +
search-settings-ui.js into the served HTML). The direct origin serves
the raw QwenPaw console, so `/chat` looks different depending on whether
the user arrives through Pages or directly — the unification this task
asks for.

This script makes the ORIGIN serve the rebrand itself: it injects the
committed `baked-injection.html` block (generated from _worker.js by
generate-baked-block.mjs, so it is byte-identical to what the proxy
injects) into the console's index.html, rewrites the console title, and
copies `search-settings-ui.js` next to index.html so the injected
module tag resolves on the origin.

Idempotent via the `agentx-rebrand-baked` marker: a console that already
carries the block is left untouched, so the build can be re-run.

Fail-closed: a missing index.html, a missing `</body>` anchor, or a
marker that does not survive is a hard error (non-zero exit) so the
image build fails loudly instead of shipping a half-baked console.

Usage:
    python3 bake_rebrand.py /app/venv/lib/python3.11/site-packages /app/src
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

#: The console's index, relative to a root (see the takeover Dockerfile:
#: /app/src/qwenpaw/console/index.html and the site-packages twin).
CONSOLE_INDEX_REL = "qwenpaw/console/index.html"

#: The static module the injected tag loads; copied next to index.html.
SEARCH_UI_REL = "qwenpaw/console/search-settings-ui.js"

#: Idempotence marker, written into index.html.
MARKER = "agentx-rebrand-baked"

#: The upstream console title, rewritten to the product title.
TITLE_FROM = "<title>QwenPaw Console</title>"
TITLE_TO = "<title>AgentX Console</title>"


def bake(root: Path) -> tuple[bool, str]:
    """Bake the rebrand into one console tree. (changed, message)."""
    index = root / CONSOLE_INDEX_REL
    if not index.is_file():
        return False, f"NOT FOUND: {index}"
    html = index.read_text(encoding="utf-8")

    if MARKER in html:
        return False, f"already baked: {index}"

    if "</body>" not in html:
        return False, f"REFUSED: {index} has no </body> anchor"

    block = (HERE / "baked-injection.html").read_text(encoding="utf-8")
    if MARKER not in block:
        return False, "REFUSED: baked-injection.html has no marker; regenerate it"

    # Same title rewrite the proxy performs, so the origin matches.
    if TITLE_FROM in html:
        html = html.replace(TITLE_FROM, TITLE_TO)

    # Inject before </body>, exactly where the proxy puts it.
    html = html.replace("</body>", block + "</body>", 1)

    # The injected tag loads /search-settings-ui.js; on the origin that
    # file must be served by the console itself, so place it beside
    # index.html (the console's static root). The source lives in the
    # repo at pages/public/, two levels above this directory.
    src_ui = HERE.parent.parent / "pages" / "public" / "search-settings-ui.js"
    if not src_ui.is_file():
        return False, f"NOT FOUND: {src_ui}"
    dest_ui = root / SEARCH_UI_REL
    dest_ui.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src_ui, dest_ui)

    index.write_text(html, encoding="utf-8")

    # Fail closed: the marker and the anchor must both have landed.
    final = index.read_text(encoding="utf-8")
    if MARKER not in final or "</body>" not in final:
        return False, f"REFUSED: marker did not survive in {index}"
    return True, f"baked: {index} (+ {dest_ui.name})"


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__ or "")
        return 2
    failures = 0
    for arg in argv[1:]:
        root = Path(arg)
        if not root.is_dir():
            print(f"REFUSED: {root} is not a directory", file=sys.stderr)
            failures += 1
            continue
        changed, msg = bake(root)
        print(msg)
        if msg.startswith(("NOT FOUND", "REFUSED")):
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
