#!/usr/bin/env python3
"""Cost ledger for QwenPaw (AgentX) — token/cost ledger with a hard kill switch.

Stdlib only. This module is the reference implementation AND the file the
derived-image patch installs as ``qwenpaw/token_usage/cost_ledger.py`` (see
``src/patched/cost_ledger.py``, byte-identical). It must load standalone,
with no qwenpaw import at module top, so the machine-free test can drive it
without the full QwenPaw import chain. Anything that needs QwenPaw
(the usage manager, the working directory) is imported lazily inside the
async helper at the bottom.

What it does
------------
1. Reads the EXISTING ``token_usage.json`` format (the source of truth — its
   format is never changed) and prices it from a STATIC price table
   (``cost-prices.json``; defaults baked in below, overrides read from the
   working directory). No price is ever fetched from the network.
2. Enforces a daily budget: alert at 80%, HARD STOP at 100%. The check runs
   BEFORE each model call (the patch hooks ``TokenRecordingModelWrapper``),
   and parallel calls reserve estimated input tokens first, so N calls
   issued at 99% cannot all slip through on the same stale reading.

Billing rules (stated, not hidden)
----------------------------------
- Billable input tokens = ``prompt_tokens`` ONLY. ``cache_read_tokens`` /
  ``cache_write_tokens`` are a SUBSET of ``prompt_tokens`` (see
  ``token_usage/manager.py`` ``_cache_usage_metrics``: the cache-eligible
  denominator IS ``prompt_tokens`` for non-Anthropic providers), so adding
  them would double-count. They are reported, never billed.
- Billable output tokens = ``completion_tokens``.
- Cost = input / 1e6 * input_price + output / 1e6 * output_price, priced by
  ``provider:model`` first, then by model name alone. A model with no price
  in the table has cost ``None`` (unpriced) — its TOKENS still count, and the
  token budget still binds it. The USD budget binds only priced spend.
- Budgets are DAILY (local date). Either cap binds: the day stops when the
  token cap OR the USD cap is reached. A cap set to ``null`` disables it.
- Input tokens for a call not yet made are ESTIMATED as ``chars / 3.6``
  (the repo-wide token-estimate convention, see ``features/memory/recall.py``).
  The estimate is a reservation, not a charge: it is released when the real
  usage is recorded, and the next check reads the real totals.

Fail-open, bounded (DeepSeek design review 2026-11-18)
-------------------------------------------------------
If the usage summary cannot be read (transient file/buffer error), the call
is ALLOWED using the last-known-good snapshot plus the in-memory
reservations — a failed read must not take down every chat. The exposure is
a handful of calls, bounded by the reservations. The ONE exception: if the
last-known-good snapshot is itself already at/over 100%, the call is denied
— there is nothing transient about being over budget.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Defaults (repo defaults, NOT amounts/prices the user agreed to)
# ---------------------------------------------------------------------------

# Daily token budget default: ~2.5x the observed 2026-11-14 day (~73,000
# tokens, see features/approvals/README.md). Agentic loops resend full
# context every turn, so a busy day can reach this honestly — the 80%
# alert is the warning to raise it, not proof of a runaway.
DEFAULT_DAILY_TOKEN_BUDGET = 200_000
# Daily USD budget default: a conservative round number. The active model is
# free, so USD spend is $0 until a paid provider is used; $5/day bounds the
# first paid-model surprise. The user changes both numbers, they are not
# agreed spend.
DEFAULT_DAILY_USD_BUDGET = 5.0
DEFAULT_ALERT_FRACTION = 0.8

# Static price table, USD per 1,000,000 tokens. Keys are "provider:model".
# Free models are $0 by definition of their free tier. mosicn/nex-n2.6 is a
# REPO DEFAULT PLACEHOLDER, not a vendor quote — see cost-prices.json.
DEFAULT_PRICES: dict[str, dict[str, float]] = {
    "kilo:kilo-auto/free": {"input_usd_per_1m": 0.0, "output_usd_per_1m": 0.0},
    "deepseek:deepseek-v4.1-flash-free": {
        "input_usd_per_1m": 0.0,
        "output_usd_per_1m": 0.0,
    },
    "jev:jev-1.13-free": {"input_usd_per_1m": 0.0, "output_usd_per_1m": 0.0},
    "mosicn:nex-n2.6": {"input_usd_per_1m": 1.0, "output_usd_per_1m": 3.0},
}

# File names in the working directory (overrides; absent = defaults above).
PRICES_FILENAME = "cost-prices.json"
BUDGET_FILENAME = "cost-budget.json"
STATE_FILENAME = "cost-ledger-state.json"
ALERTS_FILENAME = "cost-alerts.jsonl"

DENIAL_PREFIX = "Budget exhausted"


class CostBudgetExhaustedError(RuntimeError):
    """Raised (never returned as a silent skip) when the budget is spent.

    The model call is refused BEFORE it is made. The message is the denial
    the user/agent sees; it always starts with "Budget exhausted" and names
    the cap, the spend, and the remedy (raise or reset the budget).
    """


# ---------------------------------------------------------------------------
# token_usage.json parsing (format unchanged — the source of truth)
# ---------------------------------------------------------------------------


@dataclass
class UsageRow:
    """One (date, agent, provider, model) row from token_usage.json."""

    date: str
    agent_id: str
    provider_id: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    call_count: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


def _as_int(value: object) -> int:
    try:
        return max(int(value), 0)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def parse_token_usage(data: object) -> list[UsageRow]:
    """Parse a token_usage.json document into rows.

    Top-level keys are dates ("2026-11-14"); each maps a
    "agent\\x1fprovider\\x1fmodel" key (\\x1f = unit separator, see
    features/approvals/README.md) to the counts dict. Rows whose model
    cannot be recovered are skipped, never guessed.
    """
    rows: list[UsageRow] = []
    if not isinstance(data, dict):
        return rows
    for date_str, by_key in data.items():
        if not isinstance(by_key, dict):
            continue
        for key, entry in by_key.items():
            if not isinstance(entry, dict):
                continue
            agent_id, provider_id, model = "", "", ""
            parts = str(key).split("\x1f")
            if len(parts) == 3:
                agent_id, provider_id, model = parts
            elif len(parts) == 2:
                provider_id, model = parts
            model = entry.get("model_name") or model
            provider_id = entry.get("provider_id") or provider_id
            agent_id = entry.get("agent_id") or agent_id
            if not model:
                continue
            rows.append(
                UsageRow(
                    date=str(date_str),
                    agent_id=str(agent_id),
                    provider_id=str(provider_id),
                    model=str(model),
                    prompt_tokens=_as_int(entry.get("prompt_tokens")),
                    completion_tokens=_as_int(entry.get("completion_tokens")),
                    cache_read_tokens=_as_int(entry.get("cache_read_tokens")),
                    cache_write_tokens=_as_int(
                        entry.get("cache_write_tokens")
                    ),
                    call_count=_as_int(entry.get("call_count")),
                )
            )
    return rows


def load_token_usage_file(path: str | Path) -> list[UsageRow]:
    """Read token_usage.json from disk. Missing/corrupt file = no rows."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return parse_token_usage(data)


# ---------------------------------------------------------------------------
# Pricing (static table only — no network fetch anywhere in this file)
# ---------------------------------------------------------------------------


def load_prices(path: str | Path | None = None) -> dict[str, dict[str, float]]:
    """Load the price table; ``None``/missing/invalid file = defaults.

    A file may carry a "models" wrapper (as cost-prices.json does) or be a
    bare {key: {input/output}} mapping. Invalid entries are dropped, never
    guessed.
    """
    prices = {k: dict(v) for k, v in DEFAULT_PRICES.items()}
    if path is None:
        return prices
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        # A corrupt price file must not brick chats — fall back to
        # defaults, but SAY so: silently dropping the user's prices
        # would understate cost.
        logger.warning("cost ledger: price file %s unreadable (%s); "
                       "using built-in defaults", path, exc)
        return prices
    table = raw.get("models") if isinstance(raw, dict) else None
    if not isinstance(table, dict):
        table = raw if isinstance(raw, dict) else {}
    for key, entry in table.items():
        if not isinstance(entry, dict):
            continue
        try:
            in_p = float(entry["input_usd_per_1m"])
            out_p = float(entry["output_usd_per_1m"])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(in_p) and math.isfinite(out_p) and in_p >= 0 and out_p >= 0:
            prices[str(key)] = {
                "input_usd_per_1m": in_p,
                "output_usd_per_1m": out_p,
            }
    return prices


def price_for(
    prices: dict[str, dict[str, float]], provider_id: str, model: str
) -> dict[str, float] | None:
    """Price lookup: "provider:model" first, then bare model name."""
    if provider_id and f"{provider_id}:{model}" in prices:
        return prices[f"{provider_id}:{model}"]
    return prices.get(model)


def cost_of_row(
    row: UsageRow, prices: dict[str, dict[str, float]]
) -> float | None:
    """USD cost of one row, or None when the model has no price.

    Input billed on prompt_tokens ONLY (cache tokens are a subset of it —
    see the module docstring); output billed on completion_tokens.
    """
    price = price_for(prices, row.provider_id, row.model)
    if price is None:
        return None
    return (
        row.prompt_tokens / 1_000_000 * price["input_usd_per_1m"]
        + row.completion_tokens / 1_000_000 * price["output_usd_per_1m"]
    )


# ---------------------------------------------------------------------------
# Ledger computation
# ---------------------------------------------------------------------------


def compute_ledger(
    rows: list[UsageRow],
    prices: dict[str, dict[str, float]],
    today: str | None = None,
) -> dict:
    """Aggregate rows into per-model / per-day / cumulative totals + cost.

    ``today`` defaults to the local date. "today" is the budget period;
    "cumulative" is everything in the file. A model with no price is
    listed with cost_usd None and unpriced True — its tokens still count.
    The TOTAL cost fields are the sum over PRICED models only (a LOWER
    BOUND when unpriced models exist); ``*_cost_known`` False means the
    total is partial, not unknown. This matters for the gate: a day that
    mixes one unpriced call with paid calls must still accrue the paid
    spend against the USD cap — returning None for the whole day would
    disable the USD cap entirely (caught by the post-implementation
    DeepSeek review, 2026-11-18).
    """
    if today is None:
        today = date.today().isoformat()
    by_model: dict[str, dict] = {}
    by_date: dict[str, dict] = {}
    total_prompt = total_completion = total_calls = 0
    total_cost = 0.0
    cost_known = True
    today_prompt = today_completion = today_calls = 0
    today_cost = 0.0
    today_cost_known = True

    for row in rows:
        cost = cost_of_row(row, prices)
        key = f"{row.provider_id}:{row.model}" if row.provider_id else row.model
        m = by_model.setdefault(
            key,
            {
                "provider_id": row.provider_id,
                "model": row.model,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "call_count": 0,
                "cost_usd": 0.0,
                "unpriced": False,
            },
        )
        m["prompt_tokens"] += row.prompt_tokens
        m["completion_tokens"] += row.completion_tokens
        m["total_tokens"] += row.total_tokens
        m["call_count"] += row.call_count
        if cost is None:
            m["unpriced"] = True
            cost_known = False
        else:
            m["cost_usd"] = round(m["cost_usd"] + cost, 6)

        d = by_date.setdefault(
            row.date,
            {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
             "call_count": 0, "cost_usd": 0.0, "unpriced": False},
        )
        d["prompt_tokens"] += row.prompt_tokens
        d["completion_tokens"] += row.completion_tokens
        d["total_tokens"] += row.total_tokens
        d["call_count"] += row.call_count
        if cost is None:
            d["unpriced"] = True
        else:
            d["cost_usd"] = round(d["cost_usd"] + cost, 6)

        total_prompt += row.prompt_tokens
        total_completion += row.completion_tokens
        total_calls += row.call_count
        if cost is None:
            cost_known = False
        else:
            total_cost += cost
        if row.date == today:
            today_prompt += row.prompt_tokens
            today_completion += row.completion_tokens
            today_calls += row.call_count
            if cost is None:
                today_cost_known = False
            else:
                today_cost += cost

    for m in by_model.values():
        m["cost_usd"] = None if m["unpriced"] and m["cost_usd"] == 0.0 else m["cost_usd"]
    return {
        "today": today,
        "today_tokens": today_prompt + today_completion,
        "today_prompt_tokens": today_prompt,
        "today_completion_tokens": today_completion,
        "today_calls": today_calls,
        # Partial sum over priced models (see docstring); None is never
        # returned for the totals — None would disable the USD cap.
        "today_cost_usd": round(today_cost, 6),
        "today_cost_known": today_cost_known,
        "total_tokens": total_prompt + total_completion,
        "total_prompt_tokens": total_prompt,
        "total_completion_tokens": total_completion,
        "total_calls": total_calls,
        "total_cost_usd": round(total_cost, 6),
        "total_cost_known": cost_known,
        "by_model": dict(sorted(by_model.items())),
        "by_date": dict(sorted(by_date.items())),
    }


# ---------------------------------------------------------------------------
# Budget config (user-settable; atomic writes; validated)
# ---------------------------------------------------------------------------


@dataclass
class Budget:
    daily_token_budget: int | None = DEFAULT_DAILY_TOKEN_BUDGET
    daily_usd_budget: float | None = DEFAULT_DAILY_USD_BUDGET
    alert_fraction: float = DEFAULT_ALERT_FRACTION

    def validate(self) -> None:
        if self.daily_token_budget is not None:
            if not isinstance(self.daily_token_budget, int) or isinstance(
                self.daily_token_budget, bool
            ):
                raise ValueError("daily_token_budget must be an integer or null")
            if self.daily_token_budget <= 0:
                raise ValueError("daily_token_budget must be > 0 or null")
        if self.daily_usd_budget is not None:
            if not isinstance(self.daily_usd_budget, (int, float)) or isinstance(
                self.daily_usd_budget, bool
            ):
                raise ValueError("daily_usd_budget must be a number or null")
            if not math.isfinite(float(self.daily_usd_budget)):
                raise ValueError("daily_usd_budget must be finite")
            if float(self.daily_usd_budget) <= 0:
                raise ValueError("daily_usd_budget must be > 0 or null")
        if not (0 < self.alert_fraction < 1):
            raise ValueError("alert_fraction must be between 0 and 1")

    def to_dict(self) -> dict:
        return {
            "daily_token_budget": self.daily_token_budget,
            "daily_usd_budget": self.daily_usd_budget,
            "alert_fraction": self.alert_fraction,
        }


def load_budget(path: str | Path | None = None) -> Budget:
    """Load the budget; ``None``/missing/invalid file = defaults."""
    budget = Budget()
    if path is None:
        return budget
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.warning("cost ledger: budget file %s unreadable (%s); "
                       "using built-in defaults", path, exc)
        return budget
    if not isinstance(raw, dict):
        return budget
    candidate = Budget(
        daily_token_budget=raw.get(
            "daily_token_budget", DEFAULT_DAILY_TOKEN_BUDGET
        ),
        daily_usd_budget=raw.get("daily_usd_budget", DEFAULT_DAILY_USD_BUDGET),
        alert_fraction=raw.get("alert_fraction", DEFAULT_ALERT_FRACTION),
    )
    try:
        candidate.validate()
    except ValueError as exc:
        logger.warning("cost ledger: budget file %s invalid (%s); "
                       "using built-in defaults", path, exc)
        return budget
    return candidate


def save_budget_atomic(path: str | Path, budget: Budget) -> None:
    """Validate, then write via temp file + rename (never a torn file)."""
    budget.validate()
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(budget.to_dict(), fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Gate state (alert-once + denial count + last-known-good snapshot)
# ---------------------------------------------------------------------------


def load_state(path: str | Path | None = None) -> dict:
    state: dict = {"alerted_dates": [], "denied_calls": 0,
                   "last_known_good": None}
    if path is None:
        return state
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.warning("cost ledger: state file %s unreadable (%s); "
                       "starting with empty state", path, exc)
        return state
    if isinstance(raw, dict):
        state.update({k: raw.get(k, v) for k, v in state.items()})
    return state


def save_state_atomic(path: str | Path, state: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def append_alert_record(
    path: str | Path, record: dict
) -> None:
    """Append one JSONL alert/denial line. Best-effort: never raises."""
    try:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, sort_keys=True) + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# The gate: alert at 80%, hard stop at 100%
# ---------------------------------------------------------------------------


@dataclass
class Decision:
    status: str  # "allow" | "alert" | "deny"
    reason: str
    fraction: float  # highest of token/usd fractions (0..inf)
    binding: str  # "tokens" | "usd" | "none"

    @property
    def allowed(self) -> bool:
        return self.status in ("allow", "alert")


@dataclass
class Reservation:
    estimated_input_tokens: int
    estimated_cost_usd: float


@dataclass
class CostGate:
    """In-process budget gate. One per process; reservations are the
    concurrency control: parallel calls reserve BEFORE the model call, so
    they cannot all pass on the same stale spent reading."""

    budget: Budget = field(default_factory=Budget)
    prices: dict[str, dict[str, float]] = field(
        default_factory=lambda: {k: dict(v) for k, v in DEFAULT_PRICES.items()}
    )
    state: dict = field(default_factory=load_state)
    reserved_tokens: int = 0
    reserved_usd: float = 0.0
    # Current run (process lifetime) — what /cost reports as "current_run".
    run_prompt_tokens: int = 0
    run_completion_tokens: int = 0
    run_cost_usd: float = 0.0
    run_calls: int = 0

    # -- pure check ------------------------------------------------------
    def fraction(
        self, spent_tokens: int, spent_usd: float | None
    ) -> tuple[float, str]:
        """Highest budget fraction consumed, and which cap binds."""
        token_frac = (
            spent_tokens / self.budget.daily_token_budget
            if self.budget.daily_token_budget
            else 0.0
        )
        usd_frac = (
            spent_usd / self.budget.daily_usd_budget
            if self.budget.daily_usd_budget and spent_usd is not None
            else 0.0
        )
        if token_frac >= usd_frac:
            return token_frac, "tokens"
        return usd_frac, "usd"

    def check(
        self, spent_tokens: int, spent_usd: float | None
    ) -> Decision:
        """Decide on SPENT totals (reservations NOT included — the caller
        adds them). Pure: no state change, safe to call for /cost."""
        frac, binding = self.fraction(spent_tokens, spent_usd)
        if frac >= 1.0:
            return Decision(
                "deny",
                self._denial(spent_tokens, spent_usd, frac, binding),
                frac,
                binding,
            )
        if frac >= self.budget.alert_fraction:
            return Decision(
                "alert",
                (
                    f"Cost alert: today's spend is {spent_tokens} tokens"
                    + (
                        f" (${spent_usd:.4f})"
                        if spent_usd is not None
                        else " (cost unknown — unpriced model)"
                    )
                    + f", {frac * 100:.0f}% of the daily budget "
                    f"({binding} cap). Raise the budget or reset it "
                    f"before it hits 100%."
                ),
                frac,
                binding,
            )
        return Decision("allow", "Within budget.", frac, binding)

    def _denial(
        self,
        spent_tokens: int,
        spent_usd: float | None,
        frac: float,
        binding: str,
    ) -> str:
        if binding == "tokens":
            cap = f"{self.budget.daily_token_budget} tokens/day"
        else:
            cap = f"${self.budget.daily_usd_budget:.2f}/day"
        return (
            f"{DENIAL_PREFIX}: today's spend is {spent_tokens} tokens"
            + (f" (${spent_usd:.4f})" if spent_usd is not None else "")
            + f", {frac * 100:.0f}% of the daily budget ({cap}, {binding} "
            f"cap). No further model calls until the budget is raised "
            f"(POST /api/cost/budget) or reset (POST /api/cost/reset)."
        )

    # -- stateful check + reserve ----------------------------------------
    def check_and_record(
        self,
        spent_tokens: int,
        spent_usd: float | None,
        date_str: str | None = None,
    ) -> tuple[Decision, bool]:
        """Check, and record the 80% alert once per day.

        Returns (decision, alerted_now). A denial increments the denial
        counter in state (the caller persists it).
        """
        date_str = date_str or date.today().isoformat()
        decision = self.check(spent_tokens, spent_usd)
        alerted_now = False
        if decision.status in ("alert", "deny"):
            if date_str not in self.state.get("alerted_dates", []):
                self.state.setdefault("alerted_dates", []).append(date_str)
                alerted_now = True
        if decision.status == "deny":
            self.state["denied_calls"] = int(self.state.get("denied_calls", 0)) + 1
        return decision, alerted_now

    def reserve(
        self,
        estimated_input_tokens: int,
        provider_id: str,
        model: str,
        spent_tokens: int,
        spent_usd: float | None,
    ) -> tuple[Decision, Reservation | None]:
        """Reserve estimated input BEFORE the model call.

        The projected spend (spent + already reserved + this estimate) is
        what is checked, so parallel calls cannot all pass at 99%. On
        deny nothing is reserved. On allow/alert the reservation is held
        until release() — the wrapper releases it once the real usage is
        recorded (the next check then sees the real totals, not the
        estimate). Output tokens are NOT estimated: a call admitted at
        99% can still emit output past the cap, and the NEXT call is
        denied — the cap bounds the day, not a single call's output.
        """
        price = price_for(self.prices, provider_id, model)
        est_usd = (
            estimated_input_tokens / 1_000_000 * price["input_usd_per_1m"]
            if price is not None
            else 0.0
        )
        projected_tokens = spent_tokens + self.reserved_tokens + estimated_input_tokens
        projected_usd = (
            (spent_usd or 0.0) + self.reserved_usd + est_usd
            if spent_usd is not None or price is not None
            else None
        )
        decision = self.check(projected_tokens, projected_usd)
        if decision.status == "deny":
            return decision, None
        self.reserved_tokens += estimated_input_tokens
        self.reserved_usd += est_usd
        return decision, Reservation(estimated_input_tokens, est_usd)

    def release(self, reservation: Reservation | None) -> None:
        if reservation is None:
            return
        self.reserved_tokens = max(
            0, self.reserved_tokens - reservation.estimated_input_tokens
        )
        self.reserved_usd = max(
            0.0, self.reserved_usd - reservation.estimated_cost_usd
        )

    def note_completed_call(
        self, prompt_tokens: int, completion_tokens: int, cost_usd: float | None
    ) -> None:
        """Record a finished call in the current-run totals.

        Also invalidates the summary cache: the usage just recorded is
        already in the buffer's merged data (get_merged_data folds in
        queued-but-unflushed events), so the next pre-call check must
        read fresh totals, not the cached pre-call snapshot. Without
        this, up to 5 s of real spend was invisible to the next check
        (caught by the post-implementation DeepSeek review, 2026-11-18).
        """
        self.run_prompt_tokens += max(int(prompt_tokens), 0)
        self.run_completion_tokens += max(int(completion_tokens), 0)
        self.run_calls += 1
        if cost_usd is not None:
            self.run_cost_usd += cost_usd
        invalidate_summary_cache()

    def run_summary(self) -> dict:
        return {
            "prompt_tokens": self.run_prompt_tokens,
            "completion_tokens": self.run_completion_tokens,
            "total_tokens": self.run_prompt_tokens + self.run_completion_tokens,
            "cost_usd": round(self.run_cost_usd, 6),
            "calls": self.run_calls,
        }

    def raise_budget(
        self,
        daily_token_budget: int | None = None,
        daily_usd_budget: float | None = None,
    ) -> Budget:
        """Raise (or set) the budget, in memory only.

        Unblocks denied calls immediately: the next check re-reads the
        new caps. Persistence is the caller's job — POST /cost/budget
        and the CLI ``--set-budget`` save the file; calling this alone
        does not.
        """
        if daily_token_budget is not None:
            self.budget.daily_token_budget = daily_token_budget
        if daily_usd_budget is not None:
            self.budget.daily_usd_budget = daily_usd_budget
        self.budget.validate()
        return self.budget


def estimate_input_tokens(messages: object) -> int:
    """Estimate input tokens as chars / 3.6 (repo-wide convention).

    Accepts the message list the model call receives: dicts with a string
    or block-list "content", or plain strings. Unknown shapes count 0.
    """
    chars = 0

    def _count_text(text: object) -> None:
        nonlocal chars
        if isinstance(text, str):
            chars += len(text)

    def _count_content(content: object) -> None:
        if isinstance(content, str):
            _count_text(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    _count_text(block.get("text"))
                    _count_text(block.get("content"))
                elif isinstance(block, str):
                    _count_text(block)

    if isinstance(messages, str):
        _count_text(messages)
    elif isinstance(messages, list):
        for msg in messages:
            if isinstance(msg, dict):
                # Content only: the role ("user"/"assistant"/...) is a
                # fixed few chars, not billable content. Counting it made
                # a 3,600-char message estimate 1,002 tokens instead of
                # the hand-computed 1,000 (caught by T125's first run).
                _count_content(msg.get("content"))
            elif isinstance(msg, str):
                _count_text(msg)
    return max(math.ceil(chars / 3.6), 0)


# ---------------------------------------------------------------------------
# Live pre-call enforcement (used by the patched TokenRecordingModelWrapper)
# ---------------------------------------------------------------------------

# Cache the last summary read for 5 s so the check does not re-aggregate
# the buffer+file on every model call; reservations cover the gap.
_SUMMARY_CACHE_SECONDS = 5.0
_cached_summary: dict | None = None
_cached_at: float = 0.0


def invalidate_summary_cache() -> None:
    """Drop the cached summary so the next check reads fresh totals.

    Called from CostGate.note_completed_call when a call's real usage
    is recorded. Without this the cache hid up to 5 s of real spend
    from the next check.
    """
    global _cached_summary, _cached_at
    _cached_summary = None
    _cached_at = 0.0


async def enforce_before_model_call(
    gate: CostGate,
    provider_id: str,
    model: str,
    messages: object,
    working_dir: str | Path,
) -> Reservation | None:
    """The pre-call check the patched wrapper awaits before delegating.

    Returns the reservation the caller must release after the real usage
    is recorded (in a finally). Raises CostBudgetExhaustedError on deny.
    Fail-open, bounded: if the summary cannot be read, the
    last-known-good snapshot + reservations decide; deny only if that
    snapshot is itself already at/over 100%.
    """
    import time as _time

    global _cached_summary, _cached_at
    working_dir = Path(working_dir)
    today = date.today().isoformat()
    spent_tokens: int | None = None
    spent_usd: float | None = None
    try:
        # Lazy: this module must import standalone (stdlib only) for the
        # machine-free test, so the manager is imported here, not at top.
        from .manager import get_token_usage_manager
    except Exception as exc:
        # An import failure is a packaging bug, not a transient read
        # error — log it loudly instead of silently disabling the gate.
        logger.warning(
            "cost ledger: cannot import token usage manager (%s); "
            "budget checks will fail open on the last-known-good "
            "snapshot only", exc)
        get_token_usage_manager = None  # type: ignore[assignment]
    try:
        if get_token_usage_manager is None:
            raise RuntimeError("token usage manager unavailable")
        now = _time.monotonic()
        if _cached_summary is not None and now - _cached_at < _SUMMARY_CACHE_SECONDS:
            summary = _cached_summary
        else:
            manager = get_token_usage_manager()
            start = date.fromisoformat(today)
            summary_obj = await manager.get_summary(
                start_date=start, end_date=start
            )
            summary = {
                "tokens": summary_obj.total_prompt_tokens
                + summary_obj.total_completion_tokens,
                # Priced partial sum (see below); never None, so the USD
                # cap still binds the priced spend when some other model
                # of the day is unpriced.
                "usd": 0.0,
                "usd_partial": False,
            }
            by_model = getattr(summary_obj, "by_model", {}) or {}
            total_usd = 0.0
            for entry in by_model.values():
                price = price_for(
                    gate.prices,
                    getattr(entry, "provider_id", "") or "",
                    getattr(entry, "model", "") or "",
                )
                if price is None:
                    # Unpriced model: its tokens bind via the token cap;
                    # its dollars are unknown and must NOT zero the
                    # priced spend of the other models (the old code set
                    # the whole day's USD to None here, disabling the
                    # USD cap whenever any model was unpriced).
                    summary["usd_partial"] = True
                    continue
                total_usd += (
                    getattr(entry, "prompt_tokens", 0) / 1_000_000
                    * price["input_usd_per_1m"]
                    + getattr(entry, "completion_tokens", 0) / 1_000_000
                    * price["output_usd_per_1m"]
                )
            summary["usd"] = round(total_usd, 6)
            _cached_summary = summary
            _cached_at = now
            gate.state["last_known_good"] = {
                "date": today,
                "tokens": summary["tokens"],
                "usd": summary["usd"],
                "usd_partial": summary["usd_partial"],
                "at_iso": datetime.now(tz=timezone.utc).isoformat(
                    timespec="seconds"
                ),
            }
            # Persist the snapshot now, not only on alert: after a
            # restart with a failing read, the fallback below needs
            # today's snapshot to exist. Best-effort; a failed write
            # never blocks the call.
            try:
                save_state_atomic(working_dir / STATE_FILENAME, gate.state)
            except Exception:
                pass
        spent_tokens = int(summary["tokens"])
        spent_usd = summary["usd"]
    except Exception as exc:
        # Fail-open, bounded: fall back to the last-known-good snapshot.
        logger.warning(
            "cost ledger: usage summary read failed (%s); falling back "
            "to the last-known-good snapshot", exc)
        snapshot = (gate.state or {}).get("last_known_good") or {}
        if not snapshot or snapshot.get("date") != today:
            # No snapshot, or a snapshot from a previous day: a stale
            # snapshot must never decide today's calls (a stale-high
            # one would block every chat; a stale-low one would allow
            # spend through). No evidence of spend: allow, bounded by
            # the reservations below.
            spent_tokens, spent_usd = 0, 0.0
        else:
            spent_tokens = int(snapshot.get("tokens") or 0)
            spent_usd = snapshot.get("usd")
            if spent_usd is None:
                spent_usd = 0.0
            decision, _ = gate.check_and_record(spent_tokens, spent_usd, today)
            if decision.status == "deny":
                raise CostBudgetExhaustedError(decision.reason)
            # Below the cap on (today's) snapshot data: allow; the
            # reservation below bounds the rest.
            est = estimate_input_tokens(messages)
            _decision, reservation = gate.reserve(
                est, provider_id, model, spent_tokens, spent_usd
            )
            if _decision.status == "deny":
                raise CostBudgetExhaustedError(_decision.reason)
            return reservation

    assert spent_tokens is not None
    decision, alerted_now = gate.check_and_record(spent_tokens, spent_usd, today)
    if decision.status == "deny":
        raise CostBudgetExhaustedError(decision.reason)
    est = estimate_input_tokens(messages)
    decision, reservation = gate.reserve(
        est, provider_id, model, spent_tokens, spent_usd
    )
    if decision.status == "deny":
        # The projection (spent + reserved + this estimate) is over the
        # cap even though spent alone is not: count the denial, and
        # persist the counter best-effort so a restart does not erase it.
        gate.state["denied_calls"] = int(gate.state.get("denied_calls", 0)) + 1
        try:
            save_state_atomic(working_dir / STATE_FILENAME, gate.state)
        except Exception:
            pass
        raise CostBudgetExhaustedError(decision.reason)
    if alerted_now or decision.status == "alert":
        append_alert_record(
            working_dir / ALERTS_FILENAME,
            {
                "at": datetime.now(tz=timezone.utc).isoformat(timespec="seconds"),
                "type": "alert" if decision.status == "alert" else "deny",
                "date": today,
                "spent_tokens": spent_tokens,
                "spent_usd": spent_usd,
                "fraction": round(decision.fraction, 4),
                "provider_id": provider_id,
                "model": model,
                "reason": decision.reason,
            },
        )
        try:
            save_state_atomic(working_dir / STATE_FILENAME, gate.state)
        except Exception:
            # State persistence is best-effort: any failure (not just
            # OSError — e.g. a serialization error) must never block
            # the call or leak the reservation, which the caller is
            # about to receive below.
            pass
    return reservation


def get_cost_gate(
    working_dir: str | Path | None = None,
) -> CostGate:
    """Build a gate from the working-directory overrides (or defaults)."""
    if working_dir is None:
        return CostGate()
    working_dir = Path(working_dir)
    return CostGate(
        budget=load_budget(working_dir / BUDGET_FILENAME),
        prices=load_prices(working_dir / PRICES_FILENAME),
        state=load_state(working_dir / STATE_FILENAME),
    )


_PROCESS_GATE: CostGate | None = None


def get_process_gate(
    working_dir: str | Path | None = None,
) -> CostGate:
    """The process-wide gate, shared by the model wrapper and /cost.

    The first call builds it (from the working-directory overrides when
    given); later calls return the same instance, so reservations and
    current-run totals are shared. A budget raised via POST /cost/budget
    updates this instance in place — no restart needed.
    """
    global _PROCESS_GATE
    if _PROCESS_GATE is None:
        _PROCESS_GATE = get_cost_gate(working_dir)
    return _PROCESS_GATE


# ---------------------------------------------------------------------------
# CLI: print the ledger as JSON, or set the budget
# ---------------------------------------------------------------------------


def build_summary(
    usage_path: str | Path,
    prices_path: str | Path | None = None,
    budget_path: str | Path | None = None,
    state_path: str | Path | None = None,
    today: str | None = None,
) -> dict:
    rows = load_token_usage_file(usage_path)
    prices = load_prices(prices_path)
    budget = load_budget(budget_path)
    state = load_state(state_path)
    ledger = compute_ledger(rows, prices, today=today)
    gate = CostGate(budget=budget, prices=prices, state=state)
    decision = gate.check(ledger["today_tokens"], ledger["today_cost_usd"])
    return {
        "ledger": ledger,
        "budget": budget.to_dict(),
        "budget_remaining_tokens": (
            None
            if budget.daily_token_budget is None
            else max(budget.daily_token_budget - ledger["today_tokens"], 0)
        ),
        "budget_remaining_usd": (
            None
            if budget.daily_usd_budget is None
            else round(
                max(budget.daily_usd_budget - ledger["today_cost_usd"], 0.0), 6
            )
        ),
        "status": decision.status,
        "status_reason": decision.reason,
        "fraction_of_budget": round(decision.fraction, 4),
        "denied_calls": int(state.get("denied_calls", 0)),
        "alerted_dates": state.get("alerted_dates", []),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Cost ledger: price token_usage.json, show /cost, set budget."
    )
    parser.add_argument("--usage", default="token_usage.json")
    parser.add_argument("--prices", default=None)
    parser.add_argument("--budget", default=None)
    parser.add_argument("--state", default=None)
    parser.add_argument("--today", default=None)
    parser.add_argument("--set-budget-tokens", type=int, default=None)
    parser.add_argument("--set-budget-usd", type=float, default=None)
    args = parser.parse_args(argv)

    if args.set_budget_tokens is not None or args.set_budget_usd is not None:
        if args.budget is None:
            print("error: --set-budget needs --budget <path>", file=sys.stderr)
            return 2
        budget = load_budget(args.budget)
        if args.set_budget_tokens is not None:
            budget.daily_token_budget = args.set_budget_tokens
        if args.set_budget_usd is not None:
            budget.daily_usd_budget = args.set_budget_usd
        try:
            budget.validate()
            save_budget_atomic(args.budget, budget)
        except ValueError as exc:
            print(f"error: invalid budget: {exc}", file=sys.stderr)
            return 2
        print(json.dumps(budget.to_dict(), indent=2, sort_keys=True))
        return 0

    summary = build_summary(
        args.usage,
        prices_path=args.prices,
        budget_path=args.budget,
        state_path=args.state,
        today=args.today,
    )
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
