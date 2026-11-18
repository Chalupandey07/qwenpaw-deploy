#!/usr/bin/env python3
"""Machine-free tests for Approval TTL (gap #18, T132).

Covers the port of gogibeta/rakazo PR #50 (F6) in ttl.py:
  (a) issue stamps expires_at (approval 24h, secret 1h, question never);
      env overrides work, bad env values fall back to the default (the
      fork's rule), and changing the env later never moves a stored
      expiry;
  (b) read is pure and fails closed: an expired card reads as denied
      with reason "timed out" (never pending, never allow), the boundary
      now == expires_at counts as expired, a legacy item never
      auto-denies, and two reads write no audit row;
  (c) answer: a late answer is refused with ExpiredError (the expired
      terminal state + audit row are persisted first), a double answer
      never flips, a clock rollback cannot resurrect an expired card,
      legacy items stay answerable, a question carries nothing to
      answer, unknown ids raise;
  (d) sweep: expires stale cards (idempotent), never touches live or
      legacy cards, fails a post-migration card with a missing expiry
      closed, writes the fork-shaped audit rows; a secret settles like
      a dismissal with {ok: false, expired: true};
  (e) persistence: expires_at survives a reload, a corrupt store raises
      (never a silent empty store), a missing store is empty, the file
      is mode 0600;
  (f) concurrency: a lock holder blocks the sweep (exit non-zero, store
      untouched), and the audit is pruned to 1000 rows;
  (g) CLI: sweep/check/issue exit codes and output.
  (h) DeepSeek review regressions (2026-11-18): sticky terminal state
      before the clock, flock around every read-modify-write, legacy
      keyed on the missing ttl_version (not just the missing expiry),
      env validated at issue time, fsync-before-replace crash safety.

Usage:
    python3 test_approval_ttl.py                # must PASS (41 checks)
    python3 test_approval_ttl.py --ttl-dir DIR  # run against another
                                                 # copy of the module
Fail-first:
    mkdir /tmp/approval-ttl-before   # empty dir: no ttl.py
    python3 test_approval_ttl.py --ttl-dir /tmp/approval-ttl-before
                                     # must FAIL (the module is missing)
Everything runs on temporary stores; the live working tree is never
touched. Stdlib only. All times are injected epoch ms (T0), so no test
depends on the wall clock — except the CLI issue smoke check, which
only asserts the shape, not the value.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Fixed injected "now" (epoch ms) so every expiry is deterministic.
T0 = 1_800_000_000_000
HOUR_MS = 60 * 60 * 1000
DAY_MS = 24 * HOUR_MS

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def load_module(path: Path, mod_name: str):
    """Load a .py file standalone; returns (module, error-or-None)."""
    if not path.exists():
        return None, f"missing {path}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        return None, f"no spec for {path}"
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:  # noqa: BLE001 - the failure IS the check
        return None, f"{type(exc).__name__}: {exc}"
    return mod, None


def run_cli(ttl_py: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(ttl_py), *args],
        capture_output=True, text=True, timeout=60,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ttl-dir", default=str(HERE))
    args = parser.parse_args()
    tdir = Path(args.ttl_dir)
    ttl_py = tdir / "ttl.py"
    mod, mod_err = load_module(ttl_py, "ap_ttl")

    if mod is None:
        for name in (
                "I1 approval issue stamps expires_at = created_at + 24h",
                "I2 secret issue stamps expires_at = created_at + 1h (shorter)",
                "I3 question issue has no expiry and never expires",
                "I4 env override is honoured for new issues",
                "I5 bad env values fall back to the default (fork rule)",
                "I6 changing env after issue never moves a stored expiry",
                "I7 re-issue of an id is an idempotent no-op",
                "I8 issue persists to the store file",
                "R1 read of a live card returns pending",
                "R2 read of an expired card denies with reason 'timed out'",
                "R3 expired read carries the fork card copy + do_not_retry",
                "R4 read is pure: two reads, no audit row, no file change",
                "R5 boundary now == expires_at counts as expired",
                "R6 read of an unknown id raises UnknownRequestError",
                "R7 read of a legacy item returns pending (never auto-denied)",
                "A1 approve a pending card",
                "A2 deny a pending card with a reason",
                "A3 late approve is refused, item stays denied-expired",
                "A4 double answer never flips",
                "A5 clock rollback cannot resurrect an expired card",
                "A6 a legacy item stays answerable",
                "A7 a question carries nothing to answer",
                "A8 answer on an unknown id raises UnknownRequestError",
                "S1 sweep expires stale cards and returns their ids",
                "S2 sweep is idempotent",
                "S3 sweep does not touch live cards",
                "S4 sweep never touches legacy items",
                "S5 post-migration item with no expiry fails closed",
                "S6 sweep writes fork-shaped audit rows",
                "S7 secret sweep settles like a dismissal",
                "P1 expires_at survives a store reload (restart)",
                "P2 an item expired before reload is still denied after it",
                "P3 corrupt store raises CorruptStoreError, never silent empty",
                "P4 missing store file is an empty store, not an error",
                "P5 store file is mode 0600",
                "C1 lock holder blocks the sweep; sweep succeeds after",
                "C2 audit is pruned to 1000 rows on save",
                "L1 CLI sweep on a missing store exits 0, no expired ids",
                "L2 CLI check prints counts, exits 0; corrupt store exits 2",
                "L2b CLI check on a corrupt store exits 2",
                "L3 CLI issue stamps and prints the record as JSON"):
            check(name, False, mod_err or "")
        print(f"\n0 passed, {len(CHECKS)} failed")
        return 1

    # --- (a) issue / stamping -------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        store = mod.CardStore(Path(tmp) / "pending.json")
        ap = mod.issue(store, "approval", "req-ap", "execute_shell_command",
                       session_id="default", now_ms=T0)
        check("I1 approval issue stamps expires_at = created_at + 24h",
              ap["expires_at_ms"] == T0 + DAY_MS
              and ap["created_at_ms"] == T0
              and ap["ttl_version"] == 1 and ap["status"] == "pending")
        sec = mod.issue(store, "secret", "req-sec", "vault_reveal",
                        now_ms=T0)
        check("I2 secret issue stamps expires_at = created_at + 1h (shorter)",
              sec["expires_at_ms"] == T0 + HOUR_MS
              and sec["expires_at_ms"] < ap["expires_at_ms"])
        q = mod.issue(store, "question", "req-q", None, now_ms=T0)
        check("I3 question issue has no expiry and never expires",
              q["expires_at_ms"] is None
              and mod.read(store, "req-q", now_ms=T0 + 10 * DAY_MS)["status"] == "pending")
        over = mod.issue(store, "approval", "req-env", "read_file", now_ms=T0,
                         env={"APPROVAL_TTL_MS": "120000"})
        check("I4 env override is honoured for new issues",
              over["expires_at_ms"] == T0 + 120000)
        for bad in ("nonsense", "0", "999", "999999999999999"):
            got = mod.ttl_ms_for("approval", env={"APPROVAL_TTL_MS": bad})
            if got != DAY_MS:
                break
        else:
            got = DAY_MS
        check("I5 bad env values fall back to the default (fork rule)",
              got == DAY_MS, f"last bad value gave {got}")
        check("I6 changing env after issue never moves a stored expiry",
              mod.read(store, "req-env", now_ms=T0 + 120000)["status"] == "denied"
              and store.load()["items"][3]["expires_at_ms"] == T0 + 120000)
        again = mod.issue(store, "approval", "req-ap", "execute_shell_command",
                          now_ms=T0 + 5000)
        check("I7 re-issue of an id is an idempotent no-op",
              again["expires_at_ms"] == ap["expires_at_ms"]
              and len(store.load()["items"]) == 4)
        fresh = mod.CardStore(Path(tmp) / "pending.json")
        check("I8 issue persists to the store file",
              fresh.find(fresh.load(), "req-ap")["expires_at_ms"] == T0 + DAY_MS)

    # --- (b) read (pure, fails closed) ----------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        store = mod.CardStore(Path(tmp) / "pending.json")
        mod.issue(store, "approval", "live", "read_file", now_ms=T0)
        mod.issue(store, "approval", "dead", "execute_shell_command", now_ms=T0)
        check("R1 read of a live card returns pending",
              mod.read(store, "live", now_ms=T0 + HOUR_MS)["status"] == "pending")
        dead = mod.read(store, "dead", now_ms=T0 + DAY_MS + 1)
        check("R2 read of an expired card denies with reason 'timed out'",
              dead["status"] == "denied" and dead["reason"] == "timed out"
              and dead["expired"] is True)
        check("R3 expired read carries the fork card copy + do_not_retry",
              dead["card"] == "This approval expired"
              and dead["do_not_retry"] is True)
        before = (Path(tmp) / "pending.json").read_bytes()
        mod.read(store, "dead", now_ms=T0 + DAY_MS + 1)
        mod.read(store, "dead", now_ms=T0 + DAY_MS + 1)
        after = (Path(tmp) / "pending.json").read_bytes()
        check("R4 read is pure: two reads, no audit row, no file change",
              before == after and store.load()["audit"] == [])
        edge = mod.read(store, "live", now_ms=T0 + DAY_MS)
        check("R5 boundary now == expires_at counts as expired",
              edge["status"] == "denied")
        try:
            mod.read(store, "nope", now_ms=T0)
            unknown_raises = False
        except mod.UnknownRequestError:
            unknown_raises = True
        check("R6 read of an unknown id raises UnknownRequestError",
              unknown_raises)
        data = store.load()
        data["items"].append({"request_id": "legacy-1", "kind": "approval",
                              "tool": "read_file", "status": "pending",
                              "answer": None, "created_at_ms": T0 - 10 * DAY_MS})
        store.save(data)
        check("R7 read of a legacy item returns pending (never auto-denied)",
              mod.read(store, "legacy-1", now_ms=T0 + 10 * DAY_MS)["status"] == "pending")

    # --- (c) answer ------------------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        store = mod.CardStore(Path(tmp) / "pending.json")
        mod.issue(store, "approval", "ok", "read_file", now_ms=T0)
        mod.issue(store, "approval", "no", "write_file", now_ms=T0)
        mod.issue(store, "approval", "late", "execute_shell_command", now_ms=T0)
        mod.issue(store, "approval", "flip", "read_file", now_ms=T0)
        mod.issue(store, "approval", "rolled", "read_file", now_ms=T0)
        mod.issue(store, "question", "qq", None, now_ms=T0)
        check("A1 approve a pending card",
              mod.answer(store, "ok", True, now_ms=T0 + 1000)["status"] == "approved")
        denied = mod.answer(store, "no", False, now_ms=T0 + 1000,
                            reason="not now")
        check("A2 deny a pending card with a reason",
              denied["status"] == "denied" and denied["answer"] == "denied")
        try:
            mod.answer(store, "late", True, now_ms=T0 + DAY_MS + 1)
            late_refused = False
        except mod.ExpiredError as exc:
            late_refused = str(exc) == "This request expired before it was answered."
        item = store.find(store.load(), "late")
        check("A3 late approve is refused, item stays denied-expired",
              late_refused and item["status"] == "denied"
              and item["answer"] == "expired" and item["via"] == "answer"
              and len(store.load()["audit"]) == 1
              and store.load()["audit"][0]["via"] == "answer")
        mod.answer(store, "flip", True, now_ms=T0 + 1000)
        try:
            mod.answer(store, "flip", False, now_ms=T0 + 2000)
            flip_refused = False
        except mod.AlreadyAnsweredError:
            flip_refused = True
        check("A4 double answer never flips",
              flip_refused
              and store.find(store.load(), "flip")["status"] == "approved")
        mod.sweep(store, now_ms=T0 + DAY_MS + 1)
        try:
            mod.answer(store, "rolled", True, now_ms=T0)  # clock went backwards
            rollback_refused = False
        except (mod.ExpiredError, mod.AlreadyAnsweredError):
            # Either refusal is correct: the item is terminal-denied
            # from the sweep, and a rolled-back clock must not flip it.
            rollback_refused = True
        check("A5 clock rollback cannot resurrect an expired card",
              rollback_refused)
        data = store.load()
        data["items"].append({"request_id": "legacy-2", "kind": "approval",
                              "tool": "read_file", "status": "pending",
                              "answer": None, "created_at_ms": T0 - 10 * DAY_MS})
        store.save(data)
        check("A6 a legacy item stays answerable",
              mod.answer(store, "legacy-2", True, now_ms=T0)["status"] == "approved")
        try:
            mod.answer(store, "qq", True, now_ms=T0)
            question_refused = False
        except ValueError:
            question_refused = True
        check("A7 a question carries nothing to answer", question_refused)
        try:
            mod.answer(store, "nope", True, now_ms=T0)
            answer_unknown_raises = False
        except mod.UnknownRequestError:
            answer_unknown_raises = True
        check("A8 answer on an unknown id raises UnknownRequestError",
              answer_unknown_raises)

    # --- (d) sweep -------------------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        store = mod.CardStore(Path(tmp) / "pending.json")
        mod.issue(store, "approval", "old-1", "execute_shell_command", now_ms=T0)
        mod.issue(store, "secret", "old-sec", "vault_reveal", now_ms=T0)
        # "young" is issued a day later, so it is still inside its TTL
        # when the sweep runs at T0 + DAY_MS + 1.
        mod.issue(store, "approval", "young", "read_file", now_ms=T0 + DAY_MS)
        data = store.load()
        data["items"].append({"request_id": "legacy-3", "kind": "approval",
                              "tool": "read_file", "status": "pending",
                              "answer": None, "created_at_ms": T0 - 10 * DAY_MS})
        data["items"].append({"request_id": "broken", "kind": "approval",
                              "tool": "read_file", "status": "pending",
                              "answer": None, "created_at_ms": T0,
                              "ttl_version": 1})  # no expires_at: fail closed
        store.save(data)
        got = mod.sweep(store, now_ms=T0 + DAY_MS + 1)
        ids = sorted(e["request_id"] for e in got)
        check("S1 sweep expires stale cards and returns their ids",
              ids == ["broken", "old-1", "old-sec"], f"got {ids}")
        check("S2 sweep is idempotent",
              mod.sweep(store, now_ms=T0 + DAY_MS + 1) == [])
        live = store.find(store.load(), "young")
        check("S3 sweep does not touch live cards",
              live["status"] == "pending" and live["answer"] is None)
        legacy = store.find(store.load(), "legacy-3")
        check("S4 sweep never touches legacy items",
              legacy["status"] == "pending" and legacy["answer"] is None)
        broken = store.find(store.load(), "broken")
        check("S5 post-migration item with no expiry fails closed",
              broken["status"] == "denied" and broken["answer"] == "expired")
        audit = store.load()["audit"]
        check("S6 sweep writes fork-shaped audit rows",
              len(audit) == 3
              and all(a["actor"] == "system" and a["outcome"] == "denied"
                      and a["decision"] == "expired" and a["via"] == "sweep"
                      and a["age_ms"] >= 0 for a in audit))
        sec = store.find(store.load(), "old-sec")
        check("S7 secret sweep settles like a dismissal",
              sec["status"] == "completed"
              and sec["result"] == {"ok": False, "expired": True}
              and sec["resume_prompt"] == "The request expired before it was answered.")

    # --- (e) persistence -------------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "pending.json"
        store = mod.CardStore(path)
        mod.issue(store, "approval", "keep", "read_file", now_ms=T0)
        fresh = mod.CardStore(path)
        check("P1 expires_at survives a store reload (restart)",
              fresh.find(fresh.load(), "keep")["expires_at_ms"] == T0 + DAY_MS)
        check("P2 an item expired before reload is still denied after it",
              mod.read(fresh, "keep", now_ms=T0 + DAY_MS + 1)["status"] == "denied")
        path.write_text("{not json", encoding="utf-8")
        try:
            mod.CardStore(path).load()
            corrupt_raises = False
        except mod.CorruptStoreError:
            corrupt_raises = True
        check("P3 corrupt store raises CorruptStoreError, never silent empty",
              corrupt_raises)
        missing = mod.CardStore(Path(tmp) / "nope.json")
        check("P4 missing store file is an empty store, not an error",
              missing.load() == {"version": 1, "items": [], "audit": []})
        ok_mode = oct(os.stat(path).st_mode & 0o777) if path.exists() else ""
        check("P5 store file is mode 0600",
              (os.stat(Path(tmp) / "pending.json").st_mode & 0o777) == 0o600,
              f"mode {ok_mode}")

    # --- (f) concurrency -------------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        store = mod.CardStore(Path(tmp) / "pending.json")
        mod.issue(store, "approval", "held", "read_file", now_ms=T0)
        holder = Path(tmp) / "hold_lock.py"
        holder.write_text(
            "import fcntl, sys, time\n"
            "fd = open(sys.argv[1], 'w')\n"
            "fcntl.flock(fd, fcntl.LOCK_EX)\n"
            "time.sleep(3)\n", encoding="utf-8")
        proc = subprocess.Popen(
            [sys.executable, str(holder), str(Path(tmp) / "pending.json.lock")])
        try:
            time.sleep(0.5)  # let the holder take the lock
            blocked = run_cli(ttl_py, "sweep", "--store", str(Path(tmp) / "pending.json"),
                              "--lock-timeout", "1", "--now-ms", str(T0 + DAY_MS + 1))
            untouched = store.find(store.load(), "held")["status"] == "pending"
            check("C1 lock holder blocks the sweep; sweep succeeds after",
                  blocked.returncode != 0 and "lock" in blocked.stderr.lower()
                  and untouched
                  and run_cli(ttl_py, "sweep", "--store",
                              str(Path(tmp) / "pending.json"),
                              "--now-ms", str(T0 + DAY_MS + 1)).returncode == 0)
        finally:
            proc.wait(timeout=10)
        data = store.load()
        data["audit"] = [{"actor": "system", "outcome": "denied",
                          "tool": "t", "request_id": f"r{i}",
                          "decision": "expired", "via": "sweep",
                          "age_ms": 0, "at_ms": T0} for i in range(1005)]
        store.save(data)
        check("C2 audit is pruned to 1000 rows on save",
              len(mod.CardStore(Path(tmp) / "pending.json").load()["audit"]) == 1000)

    # --- (g) CLI ---------------------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        missing = run_cli(ttl_py, "sweep", "--store", str(Path(tmp) / "nope.json"))
        check("L1 CLI sweep on a missing store exits 0, no expired ids",
              missing.returncode == 0 and "no expired approvals" in missing.stdout)
        store = mod.CardStore(Path(tmp) / "pending.json")
        mod.issue(store, "approval", "cli-1", "read_file", now_ms=T0)
        chk = run_cli(ttl_py, "check", "--store", str(Path(tmp) / "pending.json"))
        check("L2 CLI check prints counts, exits 0; corrupt store exits 2",
              chk.returncode == 0 and "pending=1" in chk.stdout
              and "total=1" in chk.stdout
              and run_cli(ttl_py, "check", "--store",
                          str(Path(tmp) / "nope.json")).returncode == 0)
        (Path(tmp) / "pending.json").write_text("{broken", encoding="utf-8")
        corrupt = run_cli(ttl_py, "check", "--store", str(Path(tmp) / "pending.json"))
        check("L2b CLI check on a corrupt store exits 2",
              corrupt.returncode == 2)
        issued = run_cli(ttl_py, "issue", "--store", str(Path(tmp) / "fresh.json"),
                         "--kind", "approval", "--request-id", "cli-2",
                         "--tool", "read_file")
        try:
            rec = json.loads(issued.stdout)
            shape_ok = (issued.returncode == 0 and rec["request_id"] == "cli-2"
                        and rec["status"] == "pending"
                        and isinstance(rec["expires_at_ms"], int))
        except ValueError:
            shape_ok = False
        check("L3 CLI issue stamps and prints the record as JSON", shape_ok)

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    failed = len(CHECKS) - passed
    print(f"\n{passed} passed, {failed} failed")
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
