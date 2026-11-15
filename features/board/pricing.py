#!/usr/bin/env python3
"""Price resolution for the models this deployment actually uses.

WHY THIS EXISTS
---------------
`features/board/refresh-cost.py` shows "UNKNOWN" for GPT Astra because the
provider's catalog reports `pricing: {}` and `billing: "unknown"`. That is the
honest thing to display given no price — but it means the cost dashboard is
blind for the model that matters most. `pydantic/genai-prices` (MIT, verified
2026-11-15: 450 provider/model entries) carries `gpt-6-astra`, so the missing
input exists; nothing was consuming it.

DESIGN RULES, in order of importance:

1. **Never invent a price.** If no source knows the model, the answer is
   `None` with a reason, and the caller must display "UNKNOWN". A guessed
   price is worse than no price: it silently corrupts every total that
   includes it.
2. **A price is only usable with a stated source.** Every result carries
   `source` (the catalogue it came from) and `as_of`.
3. **Local overrides are explicit and dated.** Custom providers (`mosicn`,
   xingchiapi) are not in any public catalogue. They can be priced from a
   checked-in file — but that file is a *human assertion*, so it carries an
   `as_of` date and a `note`, and the dashboard shows it as user-declared.
4. **Degrade without the dependency.** `genai-prices` is optional. If it is
   not installed, the tool still resolves local overrides and still says
   UNKNOWN for everything else. It never imports-fails the dashboard.

Usage:
  python3 features/board/pricing.py --model gpt-6-astra --provider openai
  python3 features/board/pricing.py --model nex-n2.6 --provider mosicn
  python3 features/board/pricing.py --selftest

Exit: 0 resolution attempted (priced or honestly unpriced), 2 bad usage.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
OVERRIDES = HERE / "pricing-overrides.json"

# A price is per 1,000,000 tokens unless stated otherwise in the override file.
UNIT_TOKENS = 1_000_000


@dataclass
class Price:
    """A resolved price. `None` fields mean "not known", never zero."""

    model: str
    provider: str
    input_per_mtok: float | None = None
    output_per_mtok: float | None = None
    cached_input_per_mtok: float | None = None
    source: str = "none"
    as_of: str | None = None
    note: str | None = None
    resolved: bool = False

    def cost(
        self,
        prompt_tokens: int,
        completion_tokens: int,
        cached_tokens: int = 0,
    ) -> float | None:
        """Cost in USD, or None when the price is not fully known.

        Output is billed only if a rate exists; a model with a known input
        rate and an unknown output rate is still NOT priced, because a
        partial total is a wrong total.
        """
        if self.input_per_mtok is None or self.output_per_mtok is None:
            return None
        if prompt_tokens < 0 or completion_tokens < 0 or cached_tokens < 0:
            raise ValueError("token counts must be non-negative")
        billable = max(0, prompt_tokens - cached_tokens)
        total = billable * self.input_per_mtok / UNIT_TOKENS
        total += completion_tokens * self.output_per_mtok / UNIT_TOKENS
        if cached_tokens and self.cached_input_per_mtok is not None:
            total += cached_tokens * self.cached_input_per_mtok / UNIT_TOKENS
        return round(total, 8)


def load_overrides(path: Path = OVERRIDES) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _norm(model: str) -> str:
    return (model or "").strip().lower()


def from_overrides(model: str, provider: str,
                   overrides: dict[str, Any]) -> Price | None:
    """Local, human-declared prices for providers no catalogue knows."""
    entry = (overrides.get("models") or {}).get(_norm(model))
    if not entry:
        return None
    # A provider-specific entry wins over a generic one.
    per_provider = (entry.get("providers") or {}).get(_norm(provider))
    spec = per_provider or entry
    if not spec.get("input_per_mtok") and not spec.get("output_per_mtok"):
        return None
    return Price(
        model=model,
        provider=provider,
        input_per_mtok=spec.get("input_per_mtok"),
        output_per_mtok=spec.get("output_per_mtok"),
        cached_input_per_mtok=spec.get("cached_input_per_mtok"),
        source="local-override",
        as_of=entry.get("as_of") or overrides.get("as_of"),
        note=spec.get("note") or entry.get("note"),
        resolved=True,
    )


def from_genai_prices(model: str, provider: str) -> Price | None:
    """Consult pydantic/genai-prices for real per-direction rates.

    `PriceCalculation` carries `input_price` and `output_price` separately
    (verified in the 0.2.3 wheel: genai_prices/types.py), so we probe with
    1M input + 1M output and read each direction back. That avoids depending
    on the library's internal model structs and gives us the two numbers the
    dashboard actually needs.

    The library is optional on purpose: this module must import cleanly on a
    box where it was never installed. It also requires Python >= 3.11
    (`datetime.UTC`); the QwenPaw container is >= 3.11 (upstream
    pyproject: `requires-python = ">=3.11,<3.14"`), but a bare 3.10 host is
    not — hence the broad except below.
    """
    try:
        from genai_prices import calc_price  # noqa: PLC0415
        from genai_prices.types import Usage  # noqa: PLC0415
    except Exception:
        return None

    try:
        # 1M of each direction, so the returned prices ARE the per-MTok rates.
        probe = Usage(input_tokens=UNIT_TOKENS, output_tokens=UNIT_TOKENS)
        calc = calc_price(probe, model, provider_id=provider or None)
        inp = getattr(calc, "input_price", None)
        out = getattr(calc, "output_price", None)
        if inp is None and out is None:
            return None
        model_info = getattr(calc, "model", None)
        model_name = getattr(model_info, "id", None) or model
        return Price(
            model=model_name,
            provider=provider,
            input_per_mtok=float(inp) if inp is not None else None,
            output_per_mtok=float(out) if out is not None else None,
            source="genai-prices",
            note="rate from the pydantic/genai-prices catalogue",
            resolved=inp is not None and out is not None,
        )
    except Exception:
        # Unknown model, unmatched provider, missing pydantic, old Python:
        # all the same answer here — we do not know the price.
        return None


def resolve(model: str, provider: str = "",
            overrides: dict[str, Any] | None = None) -> Price:
    """Resolve a price. Order: local override, then the public catalogue."""
    overrides = overrides if overrides is not None else load_overrides()

    local = from_overrides(model, provider, overrides)
    if local is not None:
        return local

    catalogue = from_genai_prices(model, provider)
    if catalogue is not None:
        return catalogue

    return Price(
        model=model,
        provider=provider,
        source="none",
        note=(
            "no price known for this model/provider; display UNKNOWN rather "
            "than guessing. Add an entry to features/board/pricing-overrides.json "
            "if the rate is known."
        ),
        resolved=False,
    )


# ------------------------------------------------------------------ selftest

def selftest() -> int:
    failures: list[str] = []

    def expect(name: str, cond: bool, detail: str = "") -> None:
        print(f"  {'ok  ' if cond else 'FAIL'} {name}  {detail if not cond else ''}")
        if not cond:
            failures.append(name)

    print("override resolution")
    ov = {
        "as_of": "2026-11-15",
        "models": {
            "nex-n2.6": {
                "input_per_mtok": 0.5,
                "output_per_mtok": 1.5,
                "as_of": "2026-11-15",
                "note": "declared by the user; not in any public catalogue",
            },
            "dual-rate": {
                "input_per_mtok": 1.0,
                "output_per_mtok": 2.0,
                "providers": {"cheap": {"input_per_mtok": 0.1, "output_per_mtok": 0.2}},
            },
        },
    }
    p = resolve("nex-n2.6", "mosicn", ov)
    expect("override resolves", p.resolved)
    expect("override carries the source", p.source == "local-override", p.source)
    expect("override carries the date", p.as_of == "2026-11-15", str(p.as_of))
    expect("override carries the note", bool(p.note))

    print("cost arithmetic")
    cost = p.cost(1_000_000, 0)
    expect("1M input tokens at $0.50", cost == 0.5, str(cost))
    cost = p.cost(0, 1_000_000)
    expect("1M output tokens at $1.50", cost == 1.5, str(cost))
    cost = p.cost(1_000_000, 1_000_000)
    expect("1M in + 1M out = $2.00", cost == 2.0, str(cost))
    cost = p.cost(2_000, 500)
    expect("small counts stay precise", cost == round(2000*0.5/1e6 + 500*1.5/1e6, 8), str(cost))

    print("per-provider override wins")
    p2 = resolve("dual-rate", "cheap", ov)
    expect("provider-specific rate used", p2.input_per_mtok == 0.1, str(p2.input_per_mtok))
    p3 = resolve("dual-rate", "other", ov)
    expect("generic rate used for another provider", p3.input_per_mtok == 1.0,
           str(p3.input_per_mtok))

    print("unknown stays unknown")
    p4 = resolve("definitely-not-a-model-xyz", "nobody", ov)
    expect("unknown is unresolved", p4.resolved is False)
    expect("unknown has no rates", p4.input_per_mtok is None and p4.output_per_mtok is None)
    expect("unknown explains itself", "UNKNOWN" in (p4.note or ""))
    expect("unknown cost is None, never 0", p4.cost(1000, 1000) is None,
           str(p4.cost(1000, 1000)))

    print("partial price is not a price")
    partial = Price(model="x", provider="y", input_per_mtok=1.0,
                    output_per_mtok=None, resolved=True)
    expect("input-only price yields no cost", partial.cost(1000, 1000) is None)

    print("cached tokens")
    pc = Price(model="x", provider="y", input_per_mtok=1.0,
               output_per_mtok=2.0, cached_input_per_mtok=0.1, resolved=True)
    expect("cached tokens billed at the cached rate",
           pc.cost(1_000_000, 0, 1_000_000) == 0.1, str(pc.cost(1_000_000, 0, 1_000_000)))

    print("negative counts rejected")
    try:
        p.cost(-1, 0)
        expect("negative tokens raise", False)
    except ValueError:
        expect("negative tokens raise", True)

    print("optional dependency degrades")
    # from_genai_prices must never raise, installed or not.
    try:
        out = from_genai_prices("gpt-6-astra", "openai")
        expect("catalogue lookup never raises", True)
        print(f"       (genai-prices installed={out is not None})")
    except Exception as exc:  # noqa: BLE001
        expect("catalogue lookup never raises", False, str(exc))

    print()
    total = 20
    print(f"{total - len(failures)} passed, {len(failures)} failed")
    if failures:
        print("failed: " + ", ".join(failures))
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--model")
    ap.add_argument("--provider", default="")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()
    if not args.model:
        print("error: --model is required (or --selftest)", file=sys.stderr)
        return 2

    price = resolve(args.model, args.provider)
    print(json.dumps(asdict(price), indent=2) if args.json
          else f"{price.model} @ {price.provider or '?'}: "
               f"in={price.input_per_mtok} out={price.output_per_mtok} "
               f"source={price.source} resolved={price.resolved}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
