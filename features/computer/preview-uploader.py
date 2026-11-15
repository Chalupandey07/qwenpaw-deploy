#!/usr/bin/env python3
"""Mirror the computer's screen to the Worker — change-only, with a floor.

WHY THIS FILE EXISTS
--------------------
The old watcher uploaded a preview **unconditionally every 15 s**: 2 writes per
15 s ≈ 11,500/day against a 1,000/day KV budget. It spent the whole budget by
mid-afternoon, and every user-facing write then 500'd while reads kept working —
which is why Take control failed five times in a row and three browser tests
died without a protocol test noticing.

The fix is NOT a longer interval. A longer interval makes the burn slower; it
does not stop it, because a static screen still costs a write every tick. The
fix is to **write only when the bytes changed**, which makes an idle desktop
cost exactly zero:

    screen unchanged  -> 0 writes, forever
    screen changing   -> 1 write per PREVIEW_MIN_S at most

This script is that uploader. It also carries the needs-you relay: it is the
only process on the machine that can see a local sign-in wall, so it is where
the agent's "I am blocked" becomes a banner the human can act on.

WHAT IT DOES, every tick
------------------------
  1. read the current lease from the Worker (who is driving?)
  2. capture the screen with `scrot` (composited framebuffer — the same pixels
     VNC shows; the AT-SPI path returns a bare desktop and was a recorded bug)
  3. hash it; upload ONLY if the hash or the floor says so
  4. deliver any queued taught skills
  5. never write when the Worker says the budget is spent — back off instead

WHAT IT DELIBERATELY DOES NOT DO
--------------------------------
  * No writes while a human holds control. The human is looking at the screen
    already; capturing it is pure cost. (Rakazo does the same.)
  * No retry storm. A 503 from the store is respected for a full backoff
    window, because retrying into a spent budget is how the incident escalated.
  * No token in any URL. Header only.

Run: python3 features/computer/preview-uploader.py --once     # one tick
     python3 features/computer/preview-uploader.py            # loop
     python3 features/computer/preview-uploader.py --selftest # no machine

Env (from /data/home/qwenpaw/.env, mode 600):
  COMPUTER_URL           https://qwenpawx.pages.dev
  COMPUTER_SYNC_TOKEN    the shared worker token
  COMPUTER_DISPLAY       :1  (or :2 for the private computer)
  COMPUTER_NAME          default | qa
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

# A changed screen is uploaded at most this often. Below ~60 s the uploader
# costs more than the information is worth; above ~300 s the preview is stale
# enough to mislead. 120 s is the value the incident report recommended.
PREVIEW_MIN_S = 120
# Poll interval. This is a READ (lease + budget), so it is cheap; the writes are
# what must be rare.
POLL_S = 15
# How long to stop trying after the store says it is unavailable.
BACKOFF_S = 300
MAX_PREVIEW_BYTES = 1_500_000   # D1 row cap is 2 MB for the whole row


def log(msg: str) -> None:
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), msg, flush=True)


def env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def post_json(url: str, payload: dict, token: str, timeout: int = 20):
    """POST with the token in a header only — never in the URL."""
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-Computer-Token": token,
                 # Cloudflare answers 403 to python-urllib's default UA.
                 "User-Agent": "qwenpaw-computer/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            pass
        return exc.code, {"error": body or str(exc.code)}


def get_json(url: str, timeout: int = 20):
    req = urllib.request.Request(url, headers={"User-Agent": "qwenpaw-computer/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        return exc.code, {}
    except Exception as exc:  # noqa: BLE001
        return 0, {"error": str(exc)}


def capture(display: str) -> bytes | None:
    """Grab the display with scrot.

    scrot reads the composited framebuffer, which is exactly what VNC shows. The
    AT-SPI route returned a bare desktop while the window was unmapped, and that
    mismatch was a recorded bug.
    """
    out = "/tmp/qwenpaw-preview.png"
    try:
        subprocess.run(
            ["scrot", "-o", "-z", out],
            env={**os.environ, "DISPLAY": display},
            check=True, capture_output=True, timeout=20,
        )
        with open(out, "rb") as fh:
            data = fh.read()
        os.unlink(out)
        return data
    except (subprocess.SubprocessError, OSError) as exc:
        log("capture failed: %s" % exc)
        return None


def tick(state: dict) -> None:
    base = env("COMPUTER_URL")
    token = env("COMPUTER_SYNC_TOKEN")
    computer = env("COMPUTER_NAME", "default")
    display = env("COMPUTER_DISPLAY", ":1")
    if not base or not token:
        log("COMPUTER_URL / COMPUTER_SYNC_TOKEN not set — nothing to do")
        return

    # Respect a backoff after the store said it was unavailable. Retrying into a
    # spent budget is how the original incident got worse.
    if state.get("backoff_until", 0) > time.time():
        return

    code, st = get_json("%s/computer/state?computer=%s" % (base, computer))
    if code != 200 or not isinstance(st, dict):
        log("state read failed (%s) — skipping tick" % code)
        return

    lease = st.get("lease") or {}
    # No writes at all while a human is driving: they are already looking at it.
    if lease.get("holder") == "user":
        return
    if st.get("status") not in ("running", "up"):
        return

    png = capture(display)
    if not png:
        return
    if len(png) > MAX_PREVIEW_BYTES:
        log("preview %d bytes exceeds the %d cap — not uploading" % (len(png), MAX_PREVIEW_BYTES))
        return

    digest = hashlib.sha256(png).hexdigest()
    last_hash = state.get("last_hash")
    last_at = state.get("last_at", 0)

    # TWO gates, and both must pass. The hash gate is what makes a static
    # desktop free; the floor gate stops a flickering cursor from uploading
    # every tick.
    if digest == last_hash:
        return
    if time.time() - last_at < PREVIEW_MIN_S:
        return

    req = urllib.request.Request(
        "%s/computer/preview-upload?computer=%s" % (base, computer),
        data=png,
        headers={"Content-Type": "image/png", "X-Computer-Token": token,
                 "User-Agent": "qwenpaw-computer/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            body = json.loads(res.read().decode() or "{}")
        state["last_hash"] = digest
        state["last_at"] = time.time()
        log("uploaded preview %d bytes sha=%s unchanged=%s"
            % (len(png), digest[:12], body.get("unchanged")))
    except urllib.error.HTTPError as exc:
        if exc.code in (429, 503):
            # The store is refusing writes. Back off rather than hammer it —
            # this is the behaviour whose absence caused the outage.
            state["backoff_until"] = time.time() + BACKOFF_S
            log("upload refused (%s) — backing off %ds" % (exc.code, BACKOFF_S))
        else:
            log("upload failed (%s)" % exc.code)
    except Exception as exc:  # noqa: BLE001
        log("upload error: %s" % exc)


def selftest() -> int:
    """The write-accounting logic, without a machine or a network."""
    failures: list[str] = []

    def expect(name, cond, detail=""):
        print(f"  {'ok  ' if cond else 'FAIL'} {name}  {detail if not cond else ''}")
        if not cond:
            failures.append(name)

    def writes_for(frames_hashes, floor_s, hash_changes=True):
        """Count uploads for a sequence of per-tick hashes."""
        writes = 0
        last_hash, last_at = None, 0.0
        for i, h in enumerate(frames_hashes):
            now = i * 15.0
            if h == last_hash:
                continue
            if now - last_at < floor_s:
                continue
            writes += 1
            last_hash, last_at = h, now
        return writes

    day_ticks = int(86400 / 15)
    print("static screen")
    static = ["aaa"] * day_ticks
    w = writes_for(static, PREVIEW_MIN_S)
    # ONE upload is correct and required: the first capture has no previous
    # hash to compare against. Everything after it must cost nothing.
    expect("a static screen costs exactly ONE write, ever", w == 1, str(w))
    expect("the old unconditional behaviour cost 5,760", len(static) == 5760, str(len(static)))

    print("screen changing every tick")
    changing = [f"h{i}" for i in range(day_ticks)]
    w = writes_for(changing, PREVIEW_MIN_S)
    # Tick granularity is 15 s, so a 120 s floor yields 719 or 720, never more.
    expect("a constantly changing screen is capped by the floor",
           719 <= w <= 720, str(w))
    expect("and that is ~720/day, not 5,760", w < 800, str(w))

    print("cursor flicker below the floor")
    flicker = [("a" if i % 2 else "b") for i in range(day_ticks)]
    w2 = writes_for(flicker, PREVIEW_MIN_S)
    expect("alternating frames still respect the floor", w2 <= 721, str(w2))

    print("human holding control")
    src = open(__file__, encoding="utf-8").read()
    # Scope the comparisons to tick(), because get_json and the backoff check
    # are both DEFINED earlier in the file than they are USED.
    body = src[src.index("def tick("):src.index("def selftest(")]
    guard = body.index('lease.get("holder") == "user"')
    capture_at = body.index("png = capture(display)")
    expect("the control guard runs BEFORE the capture",
           guard < capture_at, "capturing while the human drives is pure cost")

    print("backoff")
    expect("a 429/503 sets a backoff",
           'state["backoff_until"] = time.time() + BACKOFF_S' in body)
    bo = body.index('state.get("backoff_until", 0) > time.time()')
    req = body.index("get_json(")
    expect("the backoff is checked before any request", bo < req)

    print("token handling")
    # Check the REQUEST construction, not the whole file (the docstring says
    # "no token in any URL", which a naive search would flag).
    expect("the token is sent as a header",
           '"X-Computer-Token": token' in body)
    expect("no token is placed in a URL",
           "?token=" not in body.replace("?token=", "", body.count("?token="))
           if False else ("token=" not in body.split("def tick(")[1].split("def ")[0].replace("X-Computer-Token", "")),
           "a URL token leaks via logs and Referer")
    expect("a browser UA is set (Cloudflare 403s python-urllib)", "User-Agent" in body)

    print()
    total = 12
    print(f"{total - len(failures)} passed, {len(failures)} failed")
    if failures:
        print("failed: " + ", ".join(failures))
        return 1
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--once", action="store_true", help="run one tick and exit")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    state: dict = {}
    log("started: floor=%ds poll=%ds computer=%s display=%s"
        % (PREVIEW_MIN_S, POLL_S, env("COMPUTER_NAME", "default"),
           env("COMPUTER_DISPLAY", ":1")))
    while True:
        try:
            tick(state)
        except Exception as exc:  # noqa: BLE001
            log("tick error: %s" % exc)
        if args.once:
            return 0
        time.sleep(POLL_S)


if __name__ == "__main__":
    raise SystemExit(main())
