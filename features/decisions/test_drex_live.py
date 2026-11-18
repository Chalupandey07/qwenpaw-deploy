#!/usr/bin/env python3
"""Live test for Drex (NACE) -- run by the parent once the NACE key arrives.

Takes the key from the ENVIRONMENT ONLY (NACE_API_KEY). Never a file,
never committed, never printed. Without a key it FAILS CLOSED:
prints "blocked on NACE key" and exits 2 -- no fake pass, no empty
Bearer header, no call.

What it proves: transport only. One POST /v1/systemone with a typed
choice question; asserts the answer is one of the offered options and a
probability comes back. It says NOTHING about calibration -- that needs
recorded (predicted probability, actual outcome) pairs run through
decide.py's calibrate(). A pass prints "transport OK".

Usage (parent, on any machine with network access to console.nace.ai):
    NACE_API_KEY='<key from Rohan>' python3 features/decisions/test_drex_live.py
    # optional overrides:
    NACE_BASE_URL=https://console.nace.ai DREX_LIVE_TIMEOUT_S=15 \
        NACE_API_KEY='<key>' python3 features/decisions/test_drex_live.py

Exit codes: 0 transport OK; 1 the call failed (401/404/unreachable/bad
shape -- the detail is printed, key scrubbed); 2 blocked on NACE key.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_BASE = "https://console.nace.ai"
MODEL = "drex-max-v1.1"


def load_decide():
    spec = importlib.util.spec_from_file_location("decide_live", HERE / "decide.py")
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["decide_live"] = mod  # dataclasses look the module up
    spec.loader.exec_module(mod)
    return mod


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Live Drex transport test (needs NACE_API_KEY).")
    ap.add_argument("--timeout", type=float, default=None,
                    help="request timeout in seconds (default: DREX_LIVE_TIMEOUT_S or 15)")
    args = ap.parse_args(argv)

    key = os.environ.get("NACE_API_KEY", "").strip()
    if not key:
        print("blocked on NACE key: set NACE_API_KEY in the environment "
              "(never in a file, never committed) and re-run.", file=sys.stderr)
        return 2

    base = os.environ.get("NACE_BASE_URL", "").strip() or DEFAULT_BASE
    timeout = args.timeout or float(os.environ.get("DREX_LIVE_TIMEOUT_S", "15"))
    print(f"provider: drex  model: {MODEL}  base: {base}  timeout: {timeout}s")
    print("key: present (value never printed)")

    decide = load_decide()
    client = decide.DecisionClient(provider="drex", api_key=key, timeout=timeout)
    if not client.is_enabled():
        print(f"live test cannot run: {client.status()['reason']}", file=sys.stderr)
        return 1

    options = ["urgent", "routine", "ignore"]
    try:
        verdict = client.decide(
            "A user reports the production server is down and customers cannot check out.",
            [decide.Question("priority", "choice", options=options,
                             prompt="How should this incoming message be handled?")])
    except decide.DecisionUnavailable as exc:
        # The client never puts the key in its errors; scrub anyway.
        detail = str(exc).replace(key, "<redacted>")
        print(f"live test FAILED: {detail}", file=sys.stderr)
        return 1

    answer = verdict.answers.get("priority")
    prob = verdict.confidence
    if answer not in options:
        print(f"live test FAILED: answer {answer!r} is not one of {options}",
              file=sys.stderr)
        return 1
    if prob is None:  # 0.0 is a valid probability; only None is missing
        print("live test FAILED: no probability came back with the answer",
              file=sys.stderr)
        return 1
    print(f"transport OK: answer={answer!r} probability={prob} "
          f"latency_ms={verdict.latency_ms}")
    print("NOTE: transport only -- calibration is NOT proven by this call. "
          "Record (probability, outcome) pairs and run decide.py calibrate().")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
