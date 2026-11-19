#!/usr/bin/env python3
"""Apply the queue-takeover bundle patch to the QwenPaw console assets.

The console bundles are minified (whole statements on one line), so a
unified diff cannot address a fragment mid-line. This script does exact
string surgery instead, with the same fail-closed guarantee as the
gatefix `patch` flow: every anchor must occur EXACTLY ONCE in the file,
or the script exits non-zero and the image build fails. Running it on
an already-patched file also fails (the anchors are gone), so a
double-patch can never happen silently.

Usage: python3 apply-queue-takeover.py <index-DZrIuh3B.js> <index-opcB8AGu.js>
Exits 0 only when both files were patched exactly once each.
"""
import sys

# (anchor, replacement) pairs, in application order.
SHARED_PATCHES = [
    # Channel listener (index-DZrIuh3B.js): the owner tab aborts its
    # ownership AbortController when a "release-ownership" message
    # arrives on BroadcastChannel("qwenpaw:queue"). The requester's
    # already-waiting holdOwnershipLock is then granted, the banner
    # hides, and the drain loop drains the queue. Inserted BEFORE the
    # migrate branch so it returns before any other handling.
    (
        'const o=ao.getState();if(n.type==="migrate"){',
        'const o=ao.getState();'
        'if(n.type==="release-ownership"){'
        'const c=window.__agentxOwnerControllers&&'
        'window.__agentxOwnerControllers.get(n.sessionId);'
        'if(c)c.abort();return}'
        'if(n.type==="migrate"){',
    ),
]

CHAT_PATCHES = [
    # Hold effect (index-opcB8AGu.js): register the owner AbortController
    # in the module-level registry (keyed by chat id p) so the listener
    # above can abort it. Created on demand; the same Map instance is
    # shared because it lives on window.
    (
        'const o=new AbortController;let m=!1,h;',
        'const o=new AbortController;'
        '(window.__agentxOwnerControllers||'
        '(window.__agentxOwnerControllers=new Map())).set(p,o);'
        'let m=!1,h;',
    ),
    # Effect cleanup: unregister (the cleanup already aborts o). Without
    # this the Map would hold a dead controller for a chat the tab left.
    (
        'return y(),()=>{o.abort(),I(),clearTimeout(h)}},[x,p,w,_]);',
        'return y(),()=>{o.abort(),'
        'window.__agentxOwnerControllers&&'
        'window.__agentxOwnerControllers.delete(p),'
        'I(),clearTimeout(h)}},[x,p,w,_]);',
    ),
]


def patch_file(path, patches):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    for anchor, replacement in patches:
        count = text.count(anchor)
        if count != 1:
            print(f"FAIL {path}: anchor occurs {count}x (need exactly 1): {anchor[:80]!r}",
                  file=sys.stderr)
            return False
        text = text.replace(anchor, replacement, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return True


def main(argv):
    if len(argv) != 3:
        print("usage: apply-queue-takeover.py <index-DZrIuh3B.js> <index-opcB8AGu.js>",
              file=sys.stderr)
        return 2
    ok = patch_file(argv[1], SHARED_PATCHES)
    ok = patch_file(argv[2], CHAT_PATCHES) and ok
    print("patched" if ok else "FAILED", argv[1], argv[2])
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
