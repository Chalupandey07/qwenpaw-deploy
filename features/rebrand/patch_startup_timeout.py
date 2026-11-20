#!/usr/bin/env python3
"""Patch the QwenPaw console's startup timeout from 30s to 180s.

The console's index.html has an inline boot guard: if #root does not mount
within 30 seconds it throws StartupTimeoutError and shows a failure page.
On a slow connection (the console takes minutes to load the 1MB bundle +
chunks) the guard fires even though the server is healthy. 180s (3 minutes)
gives a slow connection time to load without changing any other behaviour.

Patches BOTH console copies (the venv site-packages copy Python imports,
and the /app/src copy). Idempotent: if the 180s values are already present
it does nothing; if the 30s values are absent it fails loudly.
"""
import sys

ROOTS = [
    "/app/venv/lib/python3.11/site-packages",
    "/app/src",
]

OLD_MSG = "Console did not mount within 30000 ms"
NEW_MSG = "Console did not mount within 180000 ms"
OLD_TAIL = 'R(a,"timeout",null)},3e4)'
NEW_TAIL = 'R(a,"timeout",null)},18e4)'

for root in ROOTS:
    path = f"{root}/qwenpaw/console/index.html"
    html = open(path, encoding="utf-8").read()
    if NEW_MSG in html and OLD_MSG not in html and NEW_TAIL in html:
        print(f"already patched: {path}")
        continue
    assert html.count(OLD_MSG) == 1, f"{path}: expected 1x {OLD_MSG!r}, found {html.count(OLD_MSG)}"
    assert html.count(OLD_TAIL) == 1, f"{path}: expected 1x {OLD_TAIL!r}, found {html.count(OLD_TAIL)}"
    html = html.replace(OLD_MSG, NEW_MSG).replace(OLD_TAIL, NEW_TAIL)
    open(path, "w", encoding="utf-8").write(html)
    # verify
    check = open(path, encoding="utf-8").read()
    assert check.count(NEW_MSG) == 1 and check.count(OLD_MSG) == 0, f"{path}: verify failed (msg)"
    assert check.count(NEW_TAIL) == 1, f"{path}: verify failed (tail)"
    print(f"patched: {path}")

print("startup timeout 30s -> 180s OK")
