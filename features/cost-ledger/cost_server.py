#!/usr/bin/env python3
"""Reference /cost server (stdlib only) for the QwenPaw cost ledger.

This is NOT the deployed endpoint — it is a runnable reference for the
spec, so the parent can see the exact /cost behaviour without building
the derived image. The deployed endpoint is the FastAPI router
``src/patched/cost.py`` (``GET /api/cost``), installed by the patch.

Routes (all JSON):
  GET  /cost          ledger summary: today + cumulative tokens/cost,
                      per-model + per-day breakdown, budget remaining,
                      status (allow/alert/deny), current run (zeros here —
                      this standalone server has no live gate; in the
                      image the router reads the process-wide gate).
  GET  /cost/prices   the static price table actually in use.
  POST /cost/budget   {"daily_token_budget": N, "daily_usd_budget": M}
                      validated (> 0 or null), atomically persisted.
                      This is the command that raises the budget and
                      unblocks denied calls.
  POST /cost/reset    {"confirm": true} — clears today's alerted/denied
                      state for the current day only. It never deletes
                      usage history (token_usage.json is untouched).

Usage:
  python3 cost_server.py --usage token_usage.json --prices cost-prices.json \\
      --budget cost-budget.json --state cost-ledger-state.json --port 8896
  curl http://127.0.0.1:8896/cost
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cost_ledger import (  # noqa: E402
    CostGate,
    build_summary,
    load_budget,
    load_prices,
    load_state,
    save_budget_atomic,
    save_state_atomic,
)


class CostHandler(BaseHTTPRequestHandler):
    usage_path: Path = Path("token_usage.json")
    prices_path: Path | None = None
    budget_path: Path | None = None
    state_path: Path | None = None

    def log_message(self, *args: object) -> None:
        pass  # keep stdout clean; this is a reference server

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, indent=2, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > 1_000_000:
            return None
        try:
            raw = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None
        return raw if isinstance(raw, dict) else None

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        if self.path in ("/cost", "/cost/"):
            summary = build_summary(
                self.usage_path,
                prices_path=self.prices_path,
                budget_path=self.budget_path,
                state_path=self.state_path,
            )
            summary["current_run"] = {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "cost_usd": 0.0,
                "calls": 0,
            }
            self._send(200, summary)
        elif self.path in ("/cost/prices", "/cost/prices/"):
            self._send(200, {"prices": load_prices(self.prices_path)})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - http.server naming
        if self.path in ("/cost/budget", "/cost/budget/"):
            body = self._read_json()
            if body is None:
                self._send(400, {"error": "expected a JSON object body"})
                return
            if self.budget_path is None:
                self._send(400, {"error": "no budget file configured"})
                return
            budget = load_budget(self.budget_path)
            if "daily_token_budget" in body:
                budget.daily_token_budget = body["daily_token_budget"]
            if "daily_usd_budget" in body:
                budget.daily_usd_budget = body["daily_usd_budget"]
            if "alert_fraction" in body:
                budget.alert_fraction = body["alert_fraction"]
            try:
                budget.validate()
                save_budget_atomic(self.budget_path, budget)
            except (ValueError, OSError) as exc:
                self._send(400, {"error": f"invalid budget: {exc}"})
                return
            self._send(200, {"budget": budget.to_dict()})
        elif self.path in ("/cost/reset", "/cost/reset/"):
            body = self._read_json()
            if body is None or body.get("confirm") is not True:
                self._send(
                    400,
                    {"error": 'POST {"confirm": true} to reset today\'s alert/denied state'},
                )
                return
            if self.state_path is None:
                self._send(400, {"error": "no state file configured"})
                return
            state = load_state(self.state_path)
            state["alerted_dates"] = []
            state["denied_calls"] = 0
            try:
                save_state_atomic(self.state_path, state)
            except OSError as exc:
                self._send(500, {"error": f"could not save state: {exc}"})
                return
            # Raising the budget is the real unblock; a reset only clears
            # the alert/denied counters. Say so in the response.
            self._send(
                200,
                {
                    "reset": True,
                    "note": (
                        "Alert/denied counters cleared. If spend is still "
                        "over budget, calls stay denied until the budget "
                        "is raised (POST /cost/budget)."
                    ),
                },
            )
        else:
            self._send(404, {"error": "not found"})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Reference /cost server.")
    parser.add_argument("--usage", default="token_usage.json")
    parser.add_argument("--prices", default=None)
    parser.add_argument("--budget", default=None)
    parser.add_argument("--state", default=None)
    parser.add_argument("--port", type=int, default=8896)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args(argv)

    CostHandler.usage_path = Path(args.usage)
    CostHandler.prices_path = Path(args.prices) if args.prices else None
    CostHandler.budget_path = Path(args.budget) if args.budget else None
    CostHandler.state_path = Path(args.state) if args.state else None

    server = ThreadingHTTPServer((args.host, args.port), CostHandler)
    print(
        f"cost ledger reference server on http://{args.host}:{args.port}/cost",
        file=sys.stderr,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
