#!/usr/bin/env python3
"""Preflight before a T50–T57 browser round.

WHY THIS EXISTS
---------------
The 2026-11-15 browser round failed T52/T53/T56 on a single cause that had
nothing to do with the desktop: the Cloudflare KV free tier's 1,000
writes/day was spent, so every user-facing write (takeover, mode switch,
needs-you raise) answered 500 while all reads looked fine. Muse then spent a
real browser session discovering that.

This script answers four questions in ~10 seconds, BEFORE a browser session
is scheduled:

  1. Is the machine up, or paused / cooling down? (a paused box makes every
     machine test BLOCKED, not failed)
  2. Is the KV write budget still available? (the one that caused the
     incident)
  3. Is the fix that bounded it actually deployed? (watcher throttle)
  4. Are the desktop services and the gate healthy?

Read-only, and deliberately cheap: it performs at most ONE KV write probe,
into a throwaway key that is deleted immediately, and only with --probe-write.
Without that flag it does zero writes — because on a spent-quota day every
probe write is a write you cannot get back.

Usage:
  python3 preflight.py                    # reads only, no KV write
  python3 preflight.py --probe-write      # + one write/delete of a scratch key
  python3 preflight.py --probe-write --json

Exit: 0 = clear to run the browser round, 3 = BLOCKED (with the reason),
      1 = the preflight itself could not run.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

IB = Path.home() / "workspace/custom-connectors/custom.instabox/bin/ib.py"
CF = Path.home() / "workspace/custom-connectors/custom.cloudflare/bin/cf.py"
CF_ACCOUNT = "ca85fe3692c3f378200950999df9a35e"
DESKTOP_KV = "3eb38e6ebdce41f0a7ed744a99afee46"
MACHINE = "m_agq5wqqo2fvypym7rjlpvngc2m"

KEEPALIVE = "https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev"
PAGES = "https://qwenpawx.pages.dev"

PROBE_KEY = "preflight:probe"
TIMEOUT = 25


def http_json(url: str, timeout: int = TIMEOUT):
    """GET a URL and parse JSON. Cloudflare sometimes truncates urllib reads
    on this box, so fall back to curl (same workaround the test runner uses)."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as res:
            raw = res.read().decode("utf-8", "replace")
        return json.loads(raw), ""
    except Exception:
        pass
    try:
        out = subprocess.run(
            ["curl", "-sS", "--max-time", str(timeout), url],
            capture_output=True, text=True, timeout=timeout + 10,
        )
        if out.returncode != 0:
            return None, f"curl exit {out.returncode}: {out.stderr[:160]}"
        return json.loads(out.stdout), ""
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"


def run(argv, timeout=60):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except Exception as exc:  # noqa: BLE001
        return 1, "", str(exc)


def cf_get(path: str):
    rc, out, err = run(["python3", str(CF), "get", path])
    if rc != 0:
        return None, f"cf.py exit {rc}: {(err or out)[:160]}"
    try:
        return json.loads(out), ""
    except Exception:
        return None, f"cf.py returned non-JSON: {out[:160]}"


def check_machine(report):
    body, err = http_json(KEEPALIVE + "/status")
    if body is None:
        report["machine"] = {"state": "unknown", "error": err}
        report["blockers"].append(
            "keep-alive /status unreachable — cannot tell whether the machine "
            f"is paused ({err})"
        )
        return
    state = str(body.get("status", "unknown"))
    report["machine"] = {
        "state": state,
        "httpStatus": body.get("httpStatus"),
        "failures": body.get("failures"),
        "source": body.get("source"),
    }
    if state in ("waking", "cooldown", "conflict"):
        report["blockers"].append(
            f"machine is {state} — a Free-tier box in {state} makes every "
            f"machine test BLOCKED, not failed. Wait and re-run."
        )
    elif state != "up":
        report["warnings"].append(f"machine state is {state!r}, not 'up'")


def check_gate(report):
    body, err = http_json(PAGES + "/api/auth/status")
    gt, gerr = http_json(PAGES + "/desktop/__lease?computer=default")
    report["gate"] = {
        "auth_status": body if body is not None else f"error: {err}",
        "lease_default": gt if gt is not None else f"error: {gerr}",
    }
    if body is None:
        report["blockers"].append(
            f"console /api/auth/status unreachable ({err}) — a browser round "
            f"cannot log in"
        )
    if gt is None:
        report["warnings"].append(
            f"/desktop/__lease unreachable ({gerr}) — desktop reads failing"
        )


def check_kv_read(report):
    """A read is cheap and always allowed, even on a spent-quota day."""
    data, err = cf_get(
        f"/client/v4/accounts/{CF_ACCOUNT}/storage/kv/namespaces/"
        f"{DESKTOP_KV}/values/lease:default"
    )
    report["kv_read"] = {
        "ok": err == "",
        "value": data if err == "" else None,
        "error": err or None,
    }
    if err:
        report["blockers"].append(
            f"KV READ failed ({err}) — reads should always work; a broken KV "
            f"binding means every desktop state check is unreliable"
        )


def check_kv_write(report, do_write: bool):
    """At most ONE write, to a scratch key, deleted immediately.

    The error that identifies a spent quota is Cloudflare error code 10048.
    """
    if not do_write:
        report["kv_write"] = {
            "probed": False,
            "note": "skipped (read-only run). Re-run with --probe-write "
                    "before scheduling a browser round.",
        }
        report["warnings"].append(
            "KV write budget NOT probed — the 2026-11-15 browser round failed "
            "entirely because of a spent write quota. Use --probe-write."
        )
        return

    scratch = Path("/tmp/preflight-probe.json")
    scratch.write_text(json.dumps({"probe": True, "at": int(time.time())}))
    kv_path = (f"/client/v4/accounts/{CF_ACCOUNT}/storage/kv/namespaces/"
               f"{DESKTOP_KV}/values/{PROBE_KEY}")
    rc, out, err = run(["python3", str(CF), "put-raw", kv_path, str(scratch),
                        "application/json"])
    blob = (out or "") + (err or "")
    spent = "10048" in blob or "free usage limit" in blob.lower()
    success = False
    try:
        success = json.loads(out).get("success") is True
    except Exception:
        success = rc == 0 and "error" not in blob.lower()

    report["kv_write"] = {
        "probed": True,
        "rc": rc,
        "success": success,
        "quota_spent": spent,
        "detail": blob[:300],
    }
    # Always try to clean up, even on failure.
    d_rc, _, d_err = run(["python3", str(CF), "delete", kv_path])
    report["kv_write"]["cleanup_rc"] = d_rc

    if spent:
        report["blockers"].append(
            "KV WRITE QUOTA SPENT (error 10048) — this is exactly the "
            "2026-11-15 incident. Takeover / mode switch / needs-you will all "
            "fail in the browser. The quota resets at midnight UTC; wait for "
            "the reset before a browser round."
        )
    elif not success:
        report["blockers"].append(
            f"KV write probe failed for a non-quota reason (rc={rc}) — "
            f"investigate before a browser round: {blob[:160]}"
        )
    try:
        scratch.unlink()
    except OSError:
        pass


def check_services(report):
    """One read-only exec: are the desktop services up?"""
    try:
        cmd = (
            "systemctl is-active desktop-vnc-view.service "
            "desktop-vnc-qa.service desktop-novnc-view.service "
            "desktop-terminal.service desktop-lease-watcher.service "
            "mcp-computer-use.service mcp-computer-use-qa.service "
            "desktop-window-watch.service 2>&1 | tr '\\n' ','"
        )
        with open("/tmp/preflight-exec.json", "w") as fh:
            json.dump({"cmd": cmd, "timeoutSeconds": 40}, fh)
        rc, out, err = run(["python3", str(IB), "exec", MACHINE,
                            "/tmp/preflight-exec.json"], timeout=120)
        if rc != 0:
            report["services"] = {"error": (err or out)[:200]}
            report["warnings"].append(
                "could not read service states (machine may be paused)"
            )
            return
        data = json.loads(out)
        states = [s for s in data.get("stdout", "").strip().split(",") if s]
        report["services"] = {"states": states}
        down = [s for s in states if s not in ("active",)]
        if down:
            report["blockers"].append(
                f"{len(down)} desktop service(s) not active: "
                f"{', '.join(down)} — the browser round would fail"
            )
    except Exception as exc:  # noqa: BLE001
        report["services"] = {"error": str(exc)[:200]}
        report["warnings"].append(f"service check skipped: {exc}")
    finally:
        try:
            os.unlink("/tmp/preflight-exec.json")
        except OSError:
            pass


def check_watcher_throttle(report):
    """Confirm the code that BOUNDED the KV burn is actually deployed.

    The incident's durable fix is change-only preview uploads with a floor.
    If the live watcher still uploads unconditionally, the quota will be spent
    again and a browser round is pointless.
    """
    try:
        with open("/tmp/preflight-watch.json", "w") as fh:
            json.dump(
                {"cmd": "grep -c 'sha256\\|PREVIEW_MIN_INTERVAL\\|120' "
                        "/data/home/mcp-proxy/lease-watcher.py 2>/dev/null || echo 0",
                 "timeoutSeconds": 40},
                fh,
            )
        rc, out, err = run(["python3", str(IB), "exec", MACHINE,
                            "/tmp/preflight-watch.json"], timeout=120)
        if rc != 0:
            report["watcher_throttle"] = {"error": (err or out)[:160]}
            report["warnings"].append("could not verify the watcher throttle")
            return
        count = int(json.loads(out).get("stdout", "0").strip() or 0)
        report["watcher_throttle"] = {"markers": count, "present": count > 0}
        if count == 0:
            report["blockers"].append(
                "the live lease-watcher has NO change-only/throttle markers — "
                "the KV burn fix is not deployed on the machine, so the quota "
                "will be spent again"
            )
    except Exception as exc:  # noqa: BLE001
        report["watcher_throttle"] = {"error": str(exc)[:160]}
    finally:
        try:
            os.unlink("/tmp/preflight-watch.json")
        except OSError:
            pass


def quota_reset_note() -> str:
    """Next midnight UTC (the KV free-tier reset), with the wait in hours."""
    from datetime import timedelta

    now = datetime.now(timezone.utc)
    nxt = datetime(now.year, now.month, now.day, tzinfo=timezone.utc) + timedelta(days=1)
    hours = (nxt - now).total_seconds() / 3600
    return (
        f"next KV quota reset: {nxt.isoformat()} "
        f"(in {hours:.1f} h; 05:30 IST)"
    )


def tooling_available(report) -> dict[str, bool]:
    """Are the machine/Cloudflare connectors present on THIS host?

    They live on Muse's box (`~/workspace/custom-connectors/...`), not on a
    generic dev VM. Missing tooling is NOT a blocker — it means this
    preflight was run from the wrong host, and saying BLOCKED there would be
    a false alarm. The distinction matters: a real quota block must be
    unmistakable.
    """
    have = {"ib": IB.is_file(), "cf": CF.is_file()}
    report["tooling"] = {k: ("present" if v else "absent") for k, v in have.items()}
    if not all(have.values()):
        missing = [str(p) for p, ok in ((IB, have["ib"]), (CF, have["cf"])) if not ok]
        report["warnings"].append(
            "machine/Cloudflare connectors are not installed on this host "
            f"(missing: {', '.join(missing)}). Run this preflight on the box "
            "that has them; the checks that need them were skipped, not failed."
        )
    return have


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--probe-write", action="store_true",
                    help="perform ONE scratch KV write+delete to test the quota")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--skip-machine", action="store_true")
    args = ap.parse_args(argv)

    report = {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "blockers": [],
        "warnings": [],
        "quota": quota_reset_note(),
    }

    try:
        have = tooling_available(report)
        check_machine(report)
        check_gate(report)
        if have["cf"]:
            check_kv_read(report)
        else:
            report["kv_read"] = {"ok": None, "note": "cf.py absent on this host"}
        if not args.skip_machine and have["ib"]:
            check_services(report)
            check_watcher_throttle(report)
        elif not have["ib"]:
            report["services"] = {"note": "ib.py absent on this host"}
            report["watcher_throttle"] = {"note": "ib.py absent on this host"}
        if have["cf"]:
            check_kv_write(report, args.probe_write)
        else:
            report["kv_write"] = {"probed": False,
                                  "note": "cf.py absent on this host"}
    except Exception as exc:  # noqa: BLE001
        print(f"preflight failed to run: {exc}", file=sys.stderr)
        return 1

    clear = not report["blockers"]
    report["clearToRunBrowserRound"] = clear
    report["complete"] = bool(
        (report.get("tooling", {}).get("cf") == "present")
        and (report.get("tooling", {}).get("ib") == "present")
        and report.get("kv_write", {}).get("probed")
    )

    if args.json:
        print(json.dumps(report, indent=2, default=str))
    else:
        print(f"preflight @ {report['checkedAt']}")
        print(f"  tooling : "
              f"ib={report.get('tooling', {}).get('ib', '?')} "
              f"cf={report.get('tooling', {}).get('cf', '?')}")
        print(f"  machine : {report.get('machine', {}).get('state')}")
        kvw = report.get("kv_write", {})
        if kvw.get("probed"):
            print(f"  kv write: "
                  f"{'QUOTA SPENT' if kvw.get('quota_spent') else 'ok'}")
        else:
            print("  kv write: not probed")
        wt = report.get("watcher_throttle", {})
        print(f"  watcher : "
              f"{'throttled' if wt.get('present') else wt.get('error') or wt.get('note', 'unknown')}")
        print(f"  {report['quota']}")
        if report["blockers"]:
            print("\n  BLOCKED — do not schedule a browser round:")
            for b in report["blockers"]:
                print(f"   - {b}")
        elif not report["complete"]:
            print("\n  INCOMPLETE — run this on the box with the connectors and "
                  "with --probe-write before scheduling a browser round.")
        else:
            print("\n  CLEAR — safe to run the T50–T57 browser round.")
        if report["warnings"]:
            print("\n  warnings:")
            for w in report["warnings"]:
                print(f"   - {w}")
    return 0 if clear else 3


if __name__ == "__main__":
    raise SystemExit(main())
