# -*- coding: utf-8 -*-
"""Cost ledger API: /cost, /cost/budget, /cost/reset.

Added by the cost-ledger patch (features/cost-ledger). Mirrors
``app/routers/token_usage.py`` in shape. All figures come from the live
``TokenUsageManager`` summary (which includes the in-memory buffer, not
just the flushed file) priced by the static table in
``token_usage/cost_ledger.py``. Nothing here fetches a price from the
network and nothing here deletes usage history.

  GET  /api/cost          today + cumulative tokens/cost, per-model and
                          per-day breakdown, budget remaining, status
                          (allow/alert/deny), current-run totals.
  POST /api/cost/budget   set the daily budgets (query params
                          daily_token_budget, daily_usd_budget). Validated,
                          atomically persisted to working/cost-budget.json,
                          applied to the process-wide gate in place — this
                          is the command that unblocks denied calls.
  POST /api/cost/reset    clear today's alerted/denied counters. It does
                          NOT reset spend: if spend is still over budget,
                          calls stay denied until the budget is raised.
"""

from datetime import date

from fastapi import APIRouter, Query

from ...constant import WORKING_DIR
from ...token_usage import get_token_usage_manager
from ...token_usage.cost_ledger import (
    BUDGET_FILENAME,
    STATE_FILENAME,
    Budget,
    get_process_gate,
    load_state,
    price_for,
    save_budget_atomic,
    save_state_atomic,
)

router = APIRouter(prefix="/cost", tags=["cost"])


def _price_summary(summary) -> tuple[int, float, bool]:
    """(total tokens, USD over PRICED models, cost-complete flag).

    The USD figure is a partial sum when any model is unpriced — it
    must never be None for the whole day, or the USD cap would stop
    binding the moment one unpriced model appears (same fix as in
    cost_ledger.compute_ledger).
    """
    gate = get_process_gate(WORKING_DIR)
    total_usd = 0.0
    known = True
    for entry in (getattr(summary, "by_model", {}) or {}).values():
        price = price_for(
            gate.prices,
            getattr(entry, "provider_id", "") or "",
            getattr(entry, "model", "") or "",
        )
        if price is None:
            known = False
            continue
        total_usd += (
            getattr(entry, "prompt_tokens", 0) / 1_000_000
            * price["input_usd_per_1m"]
            + getattr(entry, "completion_tokens", 0) / 1_000_000
            * price["output_usd_per_1m"]
        )
    tokens = summary.total_prompt_tokens + summary.total_completion_tokens
    return tokens, round(total_usd, 6), known


@router.get(
    "",
    summary="Get cost ledger summary",
    description=(
        "Today + cumulative tokens and USD cost per model, budget "
        "remaining, and the gate status (allow/alert/deny)."
    ),
)
async def get_cost() -> dict:
    """Return the cost ledger for today and cumulatively."""
    manager = get_token_usage_manager()
    gate = get_process_gate(WORKING_DIR)
    today = date.today()
    today_summary = await manager.get_summary(
        start_date=today, end_date=today
    )
    # Cumulative = everything recorded (the file starts 2026-11).
    all_summary = await manager.get_summary(
        start_date=date(2026, 1, 1), end_date=today
    )
    today_tokens, today_usd, today_known = _price_summary(today_summary)
    total_tokens, total_usd, total_known = _price_summary(all_summary)
    decision = gate.check(today_tokens, today_usd)
    by_model = {}
    for key, entry in (getattr(all_summary, "by_model", {}) or {}).items():
        price = price_for(
            gate.prices,
            getattr(entry, "provider_id", "") or "",
            getattr(entry, "model", "") or "",
        )
        cost = None
        if price is not None:
            cost = round(
                getattr(entry, "prompt_tokens", 0) / 1_000_000
                * price["input_usd_per_1m"]
                + getattr(entry, "completion_tokens", 0) / 1_000_000
                * price["output_usd_per_1m"],
                6,
            )
        by_model[key] = {
            "provider_id": getattr(entry, "provider_id", ""),
            "model": getattr(entry, "model", ""),
            "prompt_tokens": getattr(entry, "prompt_tokens", 0),
            "completion_tokens": getattr(entry, "completion_tokens", 0),
            "total_tokens": getattr(entry, "prompt_tokens", 0)
            + getattr(entry, "completion_tokens", 0),
            "call_count": getattr(entry, "call_count", 0),
            "cost_usd": cost,
            "unpriced": price is None,
        }
    budget = gate.budget
    return {
        "today": today.isoformat(),
        "today_tokens": today_tokens,
        "today_cost_usd": today_usd,
        "today_cost_known": today_known,
        "total_tokens": total_tokens,
        "total_cost_usd": total_usd,
        "total_cost_known": total_known,
        "by_model": by_model,
        "by_date": {
            day: {
                "prompt_tokens": entry.prompt_tokens,
                "completion_tokens": entry.completion_tokens,
                "total_tokens": entry.prompt_tokens
                + entry.completion_tokens,
                "call_count": entry.call_count,
            }
            for day, entry in (
                getattr(all_summary, "by_date", {}) or {}
            ).items()
        },
        "budget": budget.to_dict(),
        "budget_remaining_tokens": (
            None
            if budget.daily_token_budget is None
            else max(budget.daily_token_budget - today_tokens, 0)
        ),
        "budget_remaining_usd": (
            None
            if budget.daily_usd_budget is None or today_usd is None
            else round(max(budget.daily_usd_budget - today_usd, 0.0), 6)
        ),
        "status": decision.status,
        "status_reason": decision.reason,
        "fraction_of_budget": round(decision.fraction, 4),
        "current_run": gate.run_summary(),
        "denied_calls": int(gate.state.get("denied_calls", 0)),
    }


@router.post(
    "/budget",
    summary="Set the daily budgets",
    description=(
        "Raise (or lower) the daily token and/or USD budget. Validated "
        "and atomically persisted; applied in place, so denied calls "
        "unblock without a restart."
    ),
)
async def set_cost_budget(
    daily_token_budget: int | None = Query(
        None, description="Daily token budget (> 0). Omit to leave unchanged."
    ),
    daily_usd_budget: float | None = Query(
        None, description="Daily USD budget (> 0). Omit to leave unchanged."
    ),
) -> dict:
    """Set the daily budgets; returns the new budget + status."""
    gate = get_process_gate(WORKING_DIR)
    budget = Budget(
        daily_token_budget=(
            daily_token_budget
            if daily_token_budget is not None
            else gate.budget.daily_token_budget
        ),
        daily_usd_budget=(
            daily_usd_budget
            if daily_usd_budget is not None
            else gate.budget.daily_usd_budget
        ),
        alert_fraction=gate.budget.alert_fraction,
    )
    budget.validate()
    save_budget_atomic(WORKING_DIR / BUDGET_FILENAME, budget)
    gate.budget = budget
    return {"budget": budget.to_dict()}


@router.post(
    "/reset",
    summary="Reset today's alert/denied counters",
    description=(
        "Clears the alerted/denied counters for today. It does NOT reset "
        "spend: if spend is still over budget, calls stay denied until "
        "the budget is raised (POST /cost/budget)."
    ),
)
async def reset_cost_state() -> dict:
    """Clear today's alert/denied counters."""
    gate = get_process_gate(WORKING_DIR)
    state = load_state(WORKING_DIR / STATE_FILENAME)
    state["alerted_dates"] = []
    state["denied_calls"] = 0
    save_state_atomic(WORKING_DIR / STATE_FILENAME, state)
    gate.state = state
    return {
        "reset": True,
        "note": (
            "Alert/denied counters cleared. If spend is still over "
            "budget, calls stay denied until the budget is raised "
            "(POST /cost/budget)."
        ),
    }
