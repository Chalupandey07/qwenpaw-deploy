#!/usr/bin/env python3
"""Tests for the lease-watcher's adaptive polling and its safety invariants.

The watcher is the only process that can burn Worker requests while nobody is
using the system, so its cadence is a quota decision, not a style choice.
Before this change it polled every 5 s forever for both computers: 34,560
requests/day — 35% of the free request budget — on a box nobody was driving.

This file tests what can be tested without a machine: the constants are
consistent, the adaptive rule selects the right interval, and the safety
properties that keep the agent from being locked out are stated as code.

Run: python3 features/desktop/test_lease_watcher.py
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "lease-watcher.py"

PASS, FAIL = 0, []


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL.append(name)
        print(f"  FAIL {name}  {detail}")


def read_constants(src: str) -> dict[str, int]:
    """Pull the module-level integer constants straight from the source."""
    out: dict[str, int] = {}
    for m in re.finditer(r"^([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\s*$", src, re.M):
        out[m.group(1)] = int(m.group(2))
    return out


def main() -> int:
    src = SRC.read_text()
    consts = read_constants(src)

    print("source sanity")
    try:
        ast.parse(src)
        check("parses as Python", True)
    except SyntaxError as exc:
        check("parses as Python", False, str(exc))
    check("defines mirror_lease", "def mirror_lease(" in src)
    check("defines upload_preview", "def upload_preview(" in src)
    check("defines deliver_skills", "def deliver_skills(" in src)
    check("defines worker_call with a signature",
          re.search(r"def worker_call\(method, path", src) is not None)

    print("cadence constants")
    for name in ("POLL_S_IDLE", "POLL_S_ACTIVE", "PREVIEW_MIN_S", "SKILLS_S",
                 "PREVIEW_CHECK_S"):
        check(f"{name} is defined", name in consts, str(sorted(consts)))
    if not all(n in consts for n in ("POLL_S_IDLE", "POLL_S_ACTIVE",
                                     "PREVIEW_MIN_S", "PREVIEW_CHECK_S")):
        print("\nmissing constants; stopping")
        return 1

    idle = consts["POLL_S_IDLE"]
    active = consts["POLL_S_ACTIVE"]
    check("idle interval is slower than active", idle > active,
          f"idle={idle} active={active}")
    # A lease lives 90 s and the machine-side control file is treated as stale
    # after 30 s. An idle poll longer than the lease TTL could miss a whole
    # takeover, so the idle interval must stay under the 30 s staleness bound.
    check("idle interval is within the control file's 30 s staleness bound",
          idle <= 30, f"idle={idle}")
    check("active interval is fast enough for takeover (<10 s)",
          active < 10, f"active={active}")
    # A changed screen must not be delayed by an entire extra preview floor.
    check("preview check interval is below the preview floor",
          consts["PREVIEW_CHECK_S"] < consts["PREVIEW_MIN_S"],
          f"check={consts['PREVIEW_CHECK_S']} floor={consts['PREVIEW_MIN_S']}")
    check("skills poll is not faster than the preview floor",
          consts["SKILLS_S"] >= 60, f"skills={consts['SKILLS_S']}")

    print("adaptive rule")
    # The loop must choose the interval from whether a lease was seen, not
    # from a constant sleep.
    check("main() selects the interval from lease_held",
          "POLL_S_ACTIVE if lease_held else POLL_S_IDLE" in src,
          "the sleep must depend on lease_held")
    check("mirror_lease reports whether a lease is held",
          re.search(r"return True", src) is not None
          and "Returns True when an unexpired human lease" in src)
    check("lease_held is reset each tick",
          "lease_held = False" in src.split("interval =")[1] if "interval =" in src else False)
    check("no bare `time.sleep(POLL_S)` remains",
          not re.search(r"time\.sleep\(POLL_S\)", src),
          "the old fixed sleep must be gone")

    print("quota arithmetic")
    day = 86400
    old_req = 2 * (day / 5) + day / 30
    idle_req = 2 * (day / idle) + day / consts["SKILLS_S"]
    check("idle request/day is under 10,000 (of 100,000)",
          idle_req < 10_000, f"{idle_req:,.0f}")
    check("idle cadence saves at least 75% versus the old fixed 5 s",
          (1 - idle_req / old_req) >= 0.75,
          f"{idle_req:,.0f} vs {old_req:,.0f} ({(1-idle_req/old_req)*100:.0f}% saved)")

    print("safety invariants (must not regress)")
    # The watcher may only clear OUR OWN control file entry.
    check("only clears an entry owned by worker-lease",
          'words[0] == "human" and words[1] == "worker-lease"' in src,
          "a dashboard takeover writes a different owner word and must survive")
    # A Worker outage must fail open for the agent, not lock it out.
    check("a Worker error leaves state unchanged (fail-open for the agent)",
          "Worker unreachable: leave state unchanged" in src,
          "the docstring states the fail-open rule")
    # Previews must never go to /tmp (512 MB tmpfs on the host).
    check("preview PNGs are not written under /tmp",
          "/tmp/preview" not in src and 'PREVIEW_PNG = "/data/home' in src)
    # The token must never be logged.
    check("the sync token is never logged",
          'log("' not in src.split("SYNC_TOKEN")[1][:400]
          if "SYNC_TOKEN" in src else False)
    check("the watcher sends a browser User-Agent (Cloudflare 403s the default)",
          "Mozilla" in src, "python-urllib's default UA is blocked on Pages")
    # Uploads must stay change-only: an unconditional upload is what burned
    # the KV budget in the first place.
    check("preview upload is change-only (sha256 compare)",
          "hashlib.sha256" in src and "digest == prev_hash" in src)
    check("preview upload respects a minimum interval",
          "now - prev_at < PREVIEW_MIN_S" in src)

    print()
    total = PASS + len(FAIL)
    print(f"{PASS} passed, {len(FAIL)} failed  ({total} checks)")
    if FAIL:
        print("failed: " + ", ".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
