#!/usr/bin/env python3
"""Machine-free tests for the bloat-winwin telemetry removal (T118).

The patch replaces ``qwenpaw/utils/telemetry.py`` and
``qwenpaw/utils/daily_telemetry.py`` with stubs that keep every public
name the rest of the codebase imports, as safe no-ops, with no
endpoint constant, no network code, no sender thread, and no disk
writes.

Usage:
    python3 test_bloat_winwin.py [--telemetry PATH] [--daily PATH]
Defaults to src/patched/telemetry.py and src/patched/daily_telemetry.py
next to this file. Point the flags at src/pristine/* to prove the
test FAILS on the upstream files (fail-first):

    python3 test_bloat_winwin.py --telemetry src/pristine/telemetry.py \
        --daily src/pristine/daily_telemetry.py     # must FAIL
    python3 test_bloat_winwin.py                     # must PASS (all checks)

The stub files are stdlib-only, so they load standalone via importlib
without the qwenpaw package. The pristine files import
``..__version__`` / ``..constant`` / ``httpx`` relatively, so they
cannot load standalone — that is itself recorded as a failed check
(the test loads by file path; an ImportError means the module cannot
even be exercised in isolation, which the stub fixes).
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import sys
import tempfile
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENDPOINT_HOST = "qwenpawelemetry-sukzkbfzhc.ap-southeast-1.fcapp.run"

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def load_module(path: Path, mod_name: str):
    """Load a .py file standalone; returns (module, error-or-None)."""
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        return None, f"no spec for {path}"
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:  # noqa: BLE001 - the failure IS the check
        return None, f"{type(exc).__name__}: {exc}"
    return mod, None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--telemetry", default=str(HERE / "src" / "patched" / "telemetry.py"))
    parser.add_argument("--daily", default=str(HERE / "src" / "patched" / "daily_telemetry.py"))
    args = parser.parse_args()
    telemetry_path = Path(args.telemetry)
    daily_path = Path(args.daily)

    print(f"telemetry: {telemetry_path}")
    print(f"daily:     {daily_path}")
    tel_src = telemetry_path.read_text(encoding="utf-8")
    daily_src = daily_path.read_text(encoding="utf-8")

    # --- Static: nothing that can phone home may remain ---------------
    check("T1 telemetry: no endpoint hostname in source", ENDPOINT_HOST not in tel_src)
    check("T2 daily: no endpoint hostname in source", ENDPOINT_HOST not in daily_src)
    check("T3 telemetry: no TELEMETRY_ENDPOINT constant", "TELEMETRY_ENDPOINT" not in tel_src)
    check("T4 daily: no TELEMETRY_ENDPOINT constant", "TELEMETRY_ENDPOINT" not in daily_src)
    check("T5 telemetry: no httpx import", "httpx" not in tel_src)
    check("T6 daily: no httpx import", "httpx" not in daily_src)
    check("T7 telemetry: no .post( network call", ".post(" not in tel_src)
    check("T8 daily: no .stream( / client.post network call",
          ".post(" not in daily_src and ".stream(" not in daily_src)
    check("T9 daily: no sender thread", "threading.Thread" not in daily_src and "Thread(" not in daily_src)
    check("T10 telemetry: no subprocess probes", "subprocess" not in tel_src)
    check("T11 telemetry: no uuid/install-id generation", "uuid" not in tel_src)

    # --- Behaviour: telemetry stub --------------------------------------
    tel, err = load_module(telemetry_path, "bw_telemetry")
    check("T12 telemetry module loads standalone", tel is not None, err or "")
    if tel is not None:
        check("T13 TELEMETRY_MARKER_FILE keeps its value",
              getattr(tel, "TELEMETRY_MARKER_FILE", None) == ".telemetry_collected")
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            check("T14 is_telemetry_opted_out -> True",
                  tel.is_telemetry_opted_out(wd) is True)
            check("T15 has_telemetry_been_collected -> True",
                  tel.has_telemetry_been_collected(wd) is True)
            check("T16 collect_and_upload_telemetry -> False",
                  tel.collect_and_upload_telemetry(wd) is False)
            check("T17 get_system_info -> {}",
                  tel.get_system_info() == {})
            check("T18 get_environment_info -> {}",
                  tel.get_environment_info() == {})
            tel.mark_telemetry_collected(wd, opted_out=True)
            with tel.telemetry_marker(wd) as data:
                data["opted_out"] = True
            check("T19 stub writes no marker file",
                  not (wd / ".telemetry_collected").exists()
                  and list(wd.iterdir()) == [])

    # --- Behaviour: daily stub ------------------------------------------
    daily, err = load_module(daily_path, "bw_daily")
    check("T20 daily module loads standalone", daily is not None, err or "")
    if daily is not None:
        before = threading.active_count()
        svc = daily.start_daily_telemetry()
        check("T21 start_daily_telemetry returns a service with close/record",
              hasattr(svc, "close") and hasattr(svc, "record") and hasattr(svc, "start"))
        svc.start()
        check("T22 start() spawns no thread", threading.active_count() == before,
              f"threads {before} -> {threading.active_count()}")
        check("T23 no qwenpaw-daily-telemetry thread exists",
              not any(t.name == "qwenpaw-daily-telemetry" for t in threading.enumerate()))
        check("T24 record() -> False", asyncio.run(svc.record()) is False)
        asyncio.run(svc.close())
        check("T25 record_agent_activity() is an awaitable no-op",
              asyncio.run(daily.record_agent_activity()) is None)
        check("T26 DailyTelemetry class importable with directory arg",
              daily.DailyTelemetry(directory=Path("/tmp")) is not None)

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    failed = len(CHECKS) - passed
    print(f"\n{passed} passed, {failed} failed")
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
