#!/usr/bin/env python3
"""Cache-bust the two patched console chunks for takeover2.

Why: takeover1 patched the content-hashed bundles IN PLACE without
changing their filenames, while Pages serves /assets/* as immutable for
a year. A tab that had loaded the console before therefore kept running
the OLD bundle (no release-ownership branch, no controller registry),
so the takeover button posted a message the stale bundle ignored. The
browser only fetches a new copy when the URL changes, so takeover2
gives the two patched chunks fresh URLs:

  * the entry script in index.html gains ?v=takeover2, so the browser
    fetches a fresh shared chunk (index-DZrIuh3B.js). The shared chunk
    itself is NOT renamed: 287 asset files reference it, and every other
    chunk is byte-identical, so serving them from cache is harmless.
  * the chat chunk is RENAMED index-opcB8AGu.js -> index-opcB8AGu-tk2.js
    (only 2 files reference it, 3 occurrences), and its static import of
    the shared chunk gains the same ?v=takeover2, so the Chat page and
    the entry share one fresh store instance instead of two.

Exact string surgery with the same fail-closed guarantee as
apply-queue-takeover.py: every anchor must occur EXACTLY ONCE in its
file, the rename target must not already exist, and after the edit the
old chat-chunk name must occur ZERO times across the touched files.
Running it on an already-renamed tree fails (the anchors are gone), so
a double-rename can never happen silently.

Usage: python3 rename-chunks-tk2.py <console-dir>
  console-dir holds index.html and assets/ (one copy of the console).
  The Dockerfile runs it once per copy (/app/src/... and site-packages).
Exits 0 only when every replacement and the rename landed exactly once.
"""
import os
import sys

OLD_CHAT = "index-opcB8AGu.js"
NEW_CHAT = "index-opcB8AGu-tk2.js"
SHARED = "index-DZrIuh3B.js"
VERSION = "takeover2"

# (relative path, anchor, replacement) — each anchor exactly once.
REPLACEMENTS = [
    ("index.html",
     'src="/assets/' + SHARED + '"',
     'src="/assets/' + SHARED + '?v=' + VERSION + '"'),
    (os.path.join("assets", SHARED),
     '"assets/' + OLD_CHAT + '"',
     '"assets/' + NEW_CHAT + '"'),
    (os.path.join("assets", SHARED),
     '"./' + OLD_CHAT + '"',
     '"./' + NEW_CHAT + '"'),
    (os.path.join("assets", "TerminalView-Ik57q2nE.js"),
     'from"./' + OLD_CHAT + '"',
     'from"./' + NEW_CHAT + '"'),
    (os.path.join("assets", NEW_CHAT),
     'from"./' + SHARED + '"',
     'from"./' + SHARED + '?v=' + VERSION + '"'),
]

# Files whose content must not mention the old chat-chunk name afterwards.
CHECK_FILES = [
    "index.html",
    os.path.join("assets", SHARED),
    os.path.join("assets", "TerminalView-Ik57q2nE.js"),
    os.path.join("assets", NEW_CHAT),
]


def replace_once(root, rel, anchor, replacement):
    path = os.path.join(root, rel)
    with open(path, encoding="utf-8") as f:
        text = f.read()
    count = text.count(anchor)
    if count != 1:
        print(f"FAIL {path}: anchor occurs {count}x (need exactly 1): {anchor[:80]!r}",
              file=sys.stderr)
        return False
    with open(path, "w", encoding="utf-8") as f:
        f.write(text.replace(anchor, replacement, 1))
    return True


def main(argv):
    if len(argv) != 2:
        print("usage: rename-chunks-tk2.py <console-dir>", file=sys.stderr)
        return 2
    root = argv[1]
    assets = os.path.join(root, "assets")
    old_chat = os.path.join(assets, OLD_CHAT)
    new_chat = os.path.join(assets, NEW_CHAT)
    if not os.path.isfile(os.path.join(root, "index.html")):
        print(f"FAIL {root}: no index.html", file=sys.stderr)
        return 1
    if not os.path.isfile(old_chat):
        print(f"FAIL {old_chat}: missing (already renamed?)", file=sys.stderr)
        return 1
    if os.path.exists(new_chat):
        print(f"FAIL {new_chat}: already exists (already renamed?)", file=sys.stderr)
        return 1
    # 1. Entry query in index.html + reference renames in the shared chunk
    #    and TerminalView (all before the file rename, so the anchors exist).
    ok = True
    for rel, anchor, replacement in REPLACEMENTS[:4]:
        ok = replace_once(root, rel, anchor, replacement) and ok
    if not ok:
        return 1
    # 2. Rename the chat chunk itself.
    os.rename(old_chat, new_chat)
    for suffix in (".br", ".gz"):
        stale = old_chat + suffix
        if os.path.exists(stale):
            os.remove(stale)
    # 3. Query on the chat chunk's static import of the shared chunk.
    ok = replace_once(root, REPLACEMENTS[4][0], REPLACEMENTS[4][1],
                      REPLACEMENTS[4][2])
    if not ok:
        return 1
    # 4. Verify: old name gone everywhere, versioned entry exactly twice
    #    (index.html + the chat chunk's import).
    for rel in CHECK_FILES:
        path = os.path.join(root, rel)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        if OLD_CHAT in text:
            print(f"FAIL {path}: old name {OLD_CHAT!r} still present",
                  file=sys.stderr)
            return 1
    versioned = SHARED + "?v=" + VERSION
    hits = 0
    for rel in ("index.html", os.path.join("assets", NEW_CHAT)):
        with open(os.path.join(root, rel), encoding="utf-8") as f:
            hits += f.read().count(versioned)
    if hits != 2:
        print(f"FAIL versioned entry {versioned!r} occurs {hits}x (need 2)",
              file=sys.stderr)
        return 1
    print(f"renamed {OLD_CHAT} -> {NEW_CHAT} in {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
