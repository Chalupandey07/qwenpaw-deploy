#!/usr/bin/env python3
"""Machine-free tests for the cost ledger + hard kill switch (T125).

Covers features/cost-ledger/cost_ledger.py (the reference implementation,
byte-identical to src/patched/cost_ledger.py), the /cost reference server,
and the derived-image patch.

Usage:
    python3 test_cost_ledger.py                    # must PASS (all checks)
    python3 test_cost_ledger.py --no-cap           # must FAIL: the same
        # denial scenario run against a no-cap stub gate (the pre-change
        # behaviour: a call at 150% of budget still goes through).
        # This is the fail-first proof — there is no cap to refuse it.

Hand-computed sample (see SAMPLE below; prices: nex-n2.6 $1.00 in /
$3.00 out per 1M, kilo-auto/free $0):
  2026-11-18  kilo  50,000 in / 20,000 out, 10 calls -> $0.00
  2026-11-18  nex  100,000 in / 40,000 out,  5 calls -> $0.10 + $0.12 = $0.22
  2026-11-17  nex  200,000 in / 50,000 out,  8 calls -> $0.20 + $0.15 = $0.35
  Totals: prompt 350,000, completion 110,000, all 460,000, calls 23,
  cost $0.57. Today (11-18): 210,000 tokens, $0.22, 15 calls.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib import request as urlrequest

HERE = Path(__file__).resolve().parent

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def load_module(path: Path, mod_name: str):
    """Load a .py file standalone; returns (module, error-or-None).

    The module MUST be registered in sys.modules before exec_module:
    dataclasses (Python 3.12) resolves ``cls.__module__`` through
    sys.modules, and an unregistered module fails with
    "AttributeError: 'NoneType' object has no attribute '__dict__'"
    at the first @dataclass. (Caught by T125's first run.)
    """
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        return None, f"no spec for {path}"
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:  # noqa: BLE001 - the failure IS the check
        return None, f"{type(exc).__name__}: {exc}"
    return mod, None


SAMPLE = {
    "2026-11-18": {
        "default\x1fkilo\x1fkilo-auto/free": {
            "provider_id": "kilo",
            "model_name": "kilo-auto/free",
            "prompt_tokens": 50000,
            "completion_tokens": 20000,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "call_count": 10,
            "agent_id": "default",
        },
        "default\x1fmosicn\x1fnex-n2.6": {
            "provider_id": "mosicn",
            "model_name": "nex-n2.6",
            "prompt_tokens": 100000,
            "completion_tokens": 40000,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "call_count": 5,
            "agent_id": "default",
        },
    },
    "2026-11-17": {
        "default\x1fmosicn\x1fnex-n2.6": {
            "provider_id": "mosicn",
            "model_name": "nex-n2.6",
            "prompt_tokens": 200000,
            "completion_tokens": 50000,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "call_count": 8,
            "agent_id": "default",
        },
    },
}


class NoCapGate:
    """The pre-change behaviour: no cap exists, every call goes through.

    Used by --no-cap to prove the denial checks fail without the ledger.
    Mirrors the CostGate call surface used by the scenario below.
    """

    def __init__(self, *args, **kwargs):
        self.state = {"denied_calls": 0}

    def check(self, spent_tokens, spent_usd):
        from collections import namedtuple

        D = namedtuple("Decision", ["status", "reason", "fraction", "binding"])
        return D("allow", "Within budget.", 0.0, "none")

    def reserve(self, est, provider, model, spent_tokens, spent_usd):
        from collections import namedtuple

        D = namedtuple("Decision", ["status", "reason", "fraction", "binding"])
        R = namedtuple("Reservation", ["estimated_input_tokens", "estimated_cost_usd"])
        return D("allow", "Within budget.", 0.0, "none"), R(est, 0.0)

    def release(self, reservation):
        pass

    def raise_budget(self, *args, **kwargs):
        pass


def fake_model_call(gate, spent_tokens, spent_usd, est_tokens=1000):
    """Simulate one model call through the gate. Returns (executed, denial).

    This is the shape the patched TokenRecordingModelWrapper has: reserve
    first, execute only when allowed, raise the denial otherwise.
    """
    decision, reservation = gate.reserve(
        est_tokens, "mosicn", "nex-n2.6", spent_tokens, spent_usd
    )
    if decision.status == "deny":
        return 0, decision.reason
    gate.release(reservation)
    return 1, ""


def run_gate_scenarios(mod, no_cap: bool) -> None:
    """Denial/alert scenarios. With no_cap=True they must FAIL (fail-first)."""
    gate_cls = NoCapGate if no_cap else mod.CostGate
    budget = None if no_cap else mod.Budget(
        daily_token_budget=100000, daily_usd_budget=None
    )
    gate = gate_cls() if no_cap else gate_cls(budget=budget)

    # (b) 80% alert fires at exactly 80% and not before.
    check(
        "B1 79,999/100,000 tokens: allow, no alert",
        gate.check(79999, None).status == "allow",
        f"got {gate.check(79999, None).status}",
    )
    check(
        "B2 80,000/100,000 tokens: alert at exactly 80%",
        gate.check(80000, None).status == "alert",
        f"got {gate.check(80000, None).status}",
    )
    check(
        "B3 99,999/100,000 tokens: alert, NOT deny",
        gate.check(99999, None).status == "alert",
        f"got {gate.check(99999, None).status}",
    )
    # (c) 100% hard stop refuses the call with the budget-exhausted denial.
    d100 = gate.check(100000, None)
    check(
        "C1 100,000/100,000 tokens: deny",
        d100.status == "deny",
        f"got {d100.status}",
    )
    check(
        "C2 denial message starts 'Budget exhausted'",
        d100.reason.startswith("Budget exhausted"),
        d100.reason[:60],
    )
    executed, denial = fake_model_call(gate, 150000, None)
    check(
        "C3 call at 150% of budget: 0 executions",
        executed == 0,
        f"executed={executed}",
    )
    check(
        "C4 call at 150% of budget: denial returned",
        denial.startswith("Budget exhausted"),
        denial[:60],
    )
    # (d) raising the budget unblocks calls again.
    if not no_cap:
        gate.raise_budget(daily_token_budget=200000)
    executed, denial = fake_model_call(gate, 100000, None)
    check(
        "D1 after raising budget to 200,000: call at 100,000 executes",
        executed == 1,
        f"executed={executed} denial={denial[:40]}",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ledger", default=str(HERE / "cost_ledger.py"))
    parser.add_argument("--no-cap", action="store_true",
                        help="fail-first: run denial scenarios with no cap")
    args = parser.parse_args()
    ledger_path = Path(args.ledger)

    mod, err = load_module(ledger_path, "cl_ledger")
    check("L0 cost_ledger.py loads standalone (stdlib only)", mod is not None, err or "")
    if mod is None:
        print(f"\n0 passed, {len(CHECKS)} failed")
        return 1

    # --- (a) ledger math on the hand-computed sample ----------------------
    rows = mod.parse_token_usage(SAMPLE)
    check("A1 sample parses to 3 rows", len(rows) == 3, f"got {len(rows)}")
    prices = mod.load_prices(HERE / "cost-prices.json")
    ledger = mod.compute_ledger(rows, prices, today="2026-11-18")
    check("A2 total prompt tokens 350,000",
          ledger["total_prompt_tokens"] == 350000,
          str(ledger["total_prompt_tokens"]))
    check("A3 total completion tokens 110,000",
          ledger["total_completion_tokens"] == 110000,
          str(ledger["total_completion_tokens"]))
    check("A4 total tokens 460,000",
          ledger["total_tokens"] == 460000, str(ledger["total_tokens"]))
    check("A5 total calls 23", ledger["total_calls"] == 23,
          str(ledger["total_calls"]))
    check("A6 total cost $0.57 (0.22 + 0.35)",
          ledger["total_cost_usd"] == 0.57,
          str(ledger["total_cost_usd"]))
    check("A7 today (11-18) tokens 210,000",
          ledger["today_tokens"] == 210000, str(ledger["today_tokens"]))
    check("A8 today cost $0.22",
          ledger["today_cost_usd"] == 0.22, str(ledger["today_cost_usd"]))
    check("A9 today calls 15", ledger["today_calls"] == 15,
          str(ledger["today_calls"]))
    nex = ledger["by_model"].get("mosicn:nex-n2.6", {})
    check("A10 nex-n2.6: 390,000 tokens, $0.57",
          nex.get("total_tokens") == 390000 and nex.get("cost_usd") == 0.57,
          str(nex))
    kilo = ledger["by_model"].get("kilo:kilo-auto/free", {})
    check("A11 kilo-auto/free: 70,000 tokens, $0.00",
          kilo.get("total_tokens") == 70000 and kilo.get("cost_usd") == 0.0,
          str(kilo))
    check("A12 by_date has both days",
          set(ledger["by_date"]) == {"2026-11-17", "2026-11-18"},
          str(sorted(ledger["by_date"])))

    # Cache tokens are a subset of prompt_tokens: never double-counted.
    cache_row = mod.UsageRow(
        date="2026-11-18", agent_id="default", provider_id="mosicn",
        model="nex-n2.6", prompt_tokens=10000, completion_tokens=0,
        cache_read_tokens=8000, cache_write_tokens=2000)
    check("A13 cache tokens not billed: 10,000 in = $0.01, not $0.018",
          mod.cost_of_row(cache_row, prices) == 0.01,
          str(mod.cost_of_row(cache_row, prices)))

    # Unpriced model: cost unknown, tokens still count, token cap binds.
    ghost = mod.UsageRow(
        date="2026-11-18", agent_id="default", provider_id="acme",
        model="mystery-1", prompt_tokens=1000, completion_tokens=500)
    check("A14 unpriced model cost is None",
          mod.cost_of_row(ghost, prices) is None)
    ghost_ledger = mod.compute_ledger([ghost], prices, today="2026-11-18")
    check("A15 unpriced model: tokens count, total_cost_known False",
          ghost_ledger["total_tokens"] == 1500
          and ghost_ledger["total_cost_known"] is False)
    # Post-implementation DeepSeek review: a day mixing one unpriced
    # model with paid ones must still accrue the PAID spend against the
    # USD cap — the total is the priced partial sum, not None.
    mixed = mod.compute_ledger(
        [mod.UsageRow(date="2026-11-18", agent_id="default",
                      provider_id="mosicn", model="nex-n2.6",
                      prompt_tokens=100000, completion_tokens=40000),
         ghost],
        prices, today="2026-11-18")
    check("A15b mixed day: today cost is the priced partial sum $0.22",
          mixed["today_cost_usd"] == 0.22
          and mixed["today_cost_known"] is False,
          str(mixed["today_cost_usd"]))
    gate_usd = mod.CostGate(
        budget=mod.Budget(daily_token_budget=None, daily_usd_budget=5.0))
    check("A15c USD cap binds on the priced partial sum alone",
          gate_usd.check(0, mixed["today_cost_usd"]).status == "allow"
          and gate_usd.check(0, 5.0).status == "deny")

    # Estimate: chars / 3.6, block-list content.
    check("A16 estimate: 3,600 chars = 1,000 tokens",
          mod.estimate_input_tokens(
              [{"role": "user", "content": "x" * 3600}]) == 1000)
    check("A17 estimate: block-list content counted",
          mod.estimate_input_tokens(
              [{"role": "user",
                "content": [{"type": "text", "text": "y" * 360}]}]) == 100)

    # --- (b)(c)(d) gate scenarios -----------------------------------------
    run_gate_scenarios(mod, no_cap=args.no_cap)

    # Alert-once + denial counter (real gate only; the stub has no state).
    if not args.no_cap:
        gate = mod.CostGate(
            budget=mod.Budget(daily_token_budget=100000, daily_usd_budget=None)
        )
        _, alerted1 = gate.check_and_record(80000, None, "2026-11-18")
        _, alerted2 = gate.check_and_record(85000, None, "2026-11-18")
        check("B4 80% alert recorded once per day",
              alerted1 is True and alerted2 is False,
              f"{alerted1}/{alerted2}")
        gate.check_and_record(100000, None, "2026-11-18")
        check("C5 denial increments denied_calls",
              gate.state.get("denied_calls", 0) == 1,
              str(gate.state.get("denied_calls")))

        # Reservation closes the parallel-call race.
        race = mod.CostGate(
            budget=mod.Budget(daily_token_budget=100000, daily_usd_budget=None)
        )
        d1, r1 = race.reserve(60000, "mosicn", "nex-n2.6", 0, None)
        d2, r2 = race.reserve(60000, "mosicn", "nex-n2.6", 0, None)
        check("R1 first 60k reservation allowed at 0 spent",
              d1.status == "allow", d1.status)
        check("R2 second 60k reservation denied (projected 120k)",
              d2.status == "deny" and r2 is None, d2.status)
        race.release(r1)
        d3, r3 = race.reserve(60000, "mosicn", "nex-n2.6", 0, None)
        check("R3 after release, 60k reservation allowed again",
              d3.status == "allow", d3.status)

        # Post-implementation DeepSeek review: completing a call must
        # invalidate the 5 s summary cache, or up to 5 s of real spend
        # is invisible to the next check.
        mod._cached_summary = {"tokens": 1, "usd": 0.0}
        mod._cached_at = 1.0
        race.note_completed_call(100, 50, 0.0004)
        check("R4 completing a call invalidates the summary cache",
              mod._cached_summary is None)

        # Budget validation + atomic save/load round-trip.
        with tempfile.TemporaryDirectory() as tmp:
            bp = Path(tmp) / "cost-budget.json"
            bad = mod.Budget(daily_token_budget=-5)
            try:
                bad.validate()
                valid_bad = False
            except ValueError:
                valid_bad = True
            check("V1 negative token budget rejected", valid_bad)
            bad_usd = mod.Budget(daily_usd_budget=float("nan"))
            try:
                bad_usd.validate()
                valid_nan = False
            except ValueError:
                valid_nan = True
            check("V2 NaN USD budget rejected", valid_nan)
            good = mod.Budget(daily_token_budget=123456, daily_usd_budget=7.5)
            mod.save_budget_atomic(bp, good)
            check("V3 budget round-trips through atomic save",
                  mod.load_budget(bp).to_dict() == good.to_dict())
            (Path(tmp) / "bad.json").write_text("{not json", encoding="utf-8")
            check("V4 corrupt budget file falls back to defaults",
                  mod.load_budget(Path(tmp) / "bad.json").daily_token_budget
                  == mod.DEFAULT_DAILY_TOKEN_BUDGET)

    # --- (e) no network fetch: all prices are static ----------------------
    for fname in ("cost_ledger.py", "cost_server.py", "src/patched/cost.py"):
        src = (HERE / fname).read_text(encoding="utf-8")
        check(f"E1 {fname}: no httpx/requests/urllib.request/urlopen",
              "httpx" not in src and "requests" not in src
              and "urllib.request" not in src and "urlopen" not in src)
    prices_raw = (HERE / "cost-prices.json").read_text(encoding="utf-8")
    check("E2 price table contains no URL (nothing to fetch)",
          "http" not in prices_raw)
    check("E3 price table covers all four models in use",
          all(k in prices_raw for k in
              ("kilo-auto/free", "nex-n2.6", "deepseek-v4.1-flash-free",
               "jev-1.13-free")))

    # --- patch: applies cleanly to pristine, reproduces patched ----------
    patch_path = HERE / "qwenpaw-cost-ledger.patch"
    check("P0 patch file exists", patch_path.exists())
    if patch_path.exists() and not args.no_cap:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "app"
            (root / "src" / "qwenpaw" / "token_usage").mkdir(parents=True)
            (root / "src" / "qwenpaw" / "app" / "routers").mkdir(parents=True)
            shutil.copy(HERE / "src" / "pristine" / "model_wrapper.py",
                        root / "src" / "qwenpaw" / "token_usage" / "model_wrapper.py")
            shutil.copy(HERE / "src" / "pristine" / "routers_init.py",
                        root / "src" / "qwenpaw" / "app" / "routers" / "__init__.py")
            proc = subprocess.run(
                ["patch", "-p1", "--dry-run", "-i", str(patch_path)],
                cwd=root, capture_output=True, text=True)
            check("P1 patch dry-runs cleanly (-p1) on pristine files",
                  proc.returncode == 0, proc.stderr.strip()[:200])
            proc = subprocess.run(
                ["patch", "-p1", "-i", str(patch_path)],
                cwd=root, capture_output=True, text=True)
            ok_apply = proc.returncode == 0
            if ok_apply:
                for rel, patched in (
                    ("src/qwenpaw/token_usage/model_wrapper.py",
                     "src/patched/model_wrapper.py"),
                    ("src/qwenpaw/app/routers/__init__.py",
                     "src/patched/routers_init.py"),
                    ("src/qwenpaw/token_usage/cost_ledger.py",
                     "src/patched/cost_ledger.py"),
                    ("src/qwenpaw/app/routers/cost.py",
                     "src/patched/cost.py"),
                ):
                    if (root / rel).read_text(encoding="utf-8") != (
                            HERE / patched).read_text(encoding="utf-8"):
                        ok_apply = False
            check("P2 patch applies and reproduces the patched files",
                  ok_apply)
        patched_src = (HERE / "src" / "patched" / "model_wrapper.py").read_text(
            encoding="utf-8")
        pristine_src = (HERE / "src" / "pristine" / "model_wrapper.py").read_text(
            encoding="utf-8")
        check("P3 patched wrapper hooks the pre-call check",
              "_enforce_cost_budget(self, messages)" in patched_src
              and "enforce_before_model_call" in patched_src
              and "_release_cost_reservation" in patched_src)
        check("P4 pristine wrapper has no cost hook (fail-first source)",
              "_enforce_cost_budget" not in pristine_src)
        check("P5 patched cost_ledger.py is byte-identical to the reference",
              (HERE / "src" / "patched" / "cost_ledger.py").read_text(
                  encoding="utf-8")
              == (HERE / "cost_ledger.py").read_text(encoding="utf-8"))
        check("P6 patched router registers /cost",
              "cost_router" in (HERE / "src" / "patched" / "routers_init.py")
              .read_text(encoding="utf-8"))

    # --- CLI + reference /cost server --------------------------------------
    if not args.no_cap:
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            usage = tmp / "token_usage.json"
            usage.write_text(json.dumps(SAMPLE), encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(HERE / "cost_ledger.py"),
                 "--usage", str(usage),
                 "--prices", str(HERE / "cost-prices.json"),
                 "--budget", str(HERE / "cost-budget.json"),
                 "--today", "2026-11-18"],
                capture_output=True, text=True)
            try:
                cli = json.loads(proc.stdout)
                cli_ok = (cli["ledger"]["today_cost_usd"] == 0.22
                          and cli["ledger"]["today_tokens"] == 210000
                          and cli["status"] == "deny")  # 210k > 200k default
            except (ValueError, KeyError):
                cli_ok = False
            check("S1 CLI: today $0.22 / 210,000 tokens / status deny",
                  proc.returncode == 0 and cli_ok, proc.stdout[:200])

            # Reference server: GET /cost, POST /cost/budget, POST /cost/reset.
            sys.path.insert(0, str(HERE))
            import cost_server as srv  # noqa: E402

            budget_f = tmp / "cost-budget.json"
            shutil.copy(HERE / "cost-budget.json", budget_f)
            state_f = tmp / "cost-ledger-state.json"
            srv.CostHandler.usage_path = usage
            srv.CostHandler.prices_path = HERE / "cost-prices.json"
            srv.CostHandler.budget_path = budget_f
            srv.CostHandler.state_path = state_f
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), srv.CostHandler)
            port = httpd.server_address[1]
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                with urlrequest.urlopen(
                        f"http://127.0.0.1:{port}/cost") as resp:
                    body = json.loads(resp.read())
                check("S2 GET /cost: today $0.22, status deny (210k > 200k)",
                      body["ledger"]["today_cost_usd"] == 0.22
                      and body["status"] == "deny",
                      str(body.get("status")))
                req = urlrequest.Request(
                    f"http://127.0.0.1:{port}/cost/budget",
                    data=json.dumps(
                        {"daily_token_budget": 500000}).encode(),
                    headers={"Content-Type": "application/json"},
                    method="POST")
                with urlrequest.urlopen(req) as resp:
                    raised = json.loads(resp.read())
                check("S3 POST /cost/budget raises token budget to 500,000",
                      raised["budget"]["daily_token_budget"] == 500000)
                with urlrequest.urlopen(
                        f"http://127.0.0.1:{port}/cost") as resp:
                    body = json.loads(resp.read())
                check("S4 GET /cost after raise: status allow",
                      body["status"] == "allow", body["status"])
                req = urlrequest.Request(
                    f"http://127.0.0.1:{port}/cost/reset",
                    data=json.dumps({"confirm": True}).encode(),
                    headers={"Content-Type": "application/json"},
                    method="POST")
                with urlrequest.urlopen(req) as resp:
                    reset = json.loads(resp.read())
                check("S5 POST /cost/reset with confirm:true succeeds",
                      reset.get("reset") is True)
            finally:
                httpd.shutdown()
                httpd.server_close()

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    failed = len(CHECKS) - passed
    print(f"\n{passed} passed, {failed} failed")
    return 0 if passed == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
