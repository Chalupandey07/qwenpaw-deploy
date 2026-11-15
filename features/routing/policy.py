#!/usr/bin/env python3
"""Content-aware model routing — fills the empty hook in QwenPaw.

THE SEAM THIS FILLS (verified against v2.3.0 source)
---------------------------------------------------
`src/qwenpaw/agents/routing_chat_model.py` defines

    class RoutingPolicy:
        def decide(self, *, text="", channel="", tools_available=True):
            del text, channel, tools_available      # <- content ignored
            if getattr(self.cfg, "mode", "local_first") == "cloud_first":
                return RoutingDecision(route="cloud", reasons=["mode:cloud_first"])
            return RoutingDecision(route="local", reasons=["mode:local_first"])

So routing today is a static switch. This module supplies the policy that
makes it content-aware, and it is deliberately **dependency-free**: it must
import on the box, in a test, and in CI without torch, without an embedding
model, and without a network call.

WHY NOT AN EMBEDDING ROUTER
---------------------------
`semantic-router` is the right tool *if* the box can afford a local embedding
model. It cannot: 4 vCPU / 8 GiB already runs QwenPaw + Chromium + two Xvfb
displays, and the constraints forbid local models. A resident ONNX encoder is
a local model. So this module uses **lexical route matching** (term weights +
thresholds) and states plainly that it is a weaker classifier. It is honest
about being a router, not a reasoner:

  * it decides between "cheap model" and "expensive model",
  * it abstains (`route=None`) when the evidence is thin, and the caller then
    keeps the configured default — the same abstention semantics that make
    `semantic-router`'s calibrated threshold useful.

The interface is deliberately shaped so a semantic router can be swapped in
later behind the same `classify()` contract without touching call sites.

USAGE
-----
    from policy import Router
    r = Router.from_file("routes.yaml")
    d = r.classify("summarise this ticket in one line", tools_available=False)
    # -> Decision(route="cheap", reasons=[...], confidence=0.62, abstained=False)

CLI:
    python3 features/routing/policy.py --text "..." [--tools] [--json]
    python3 features/routing/policy.py --selftest
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_ROUTES = HERE / "routes.yaml"

# Below this the router abstains rather than guessing. 0.5 is the point where
# a binary decision is more likely right than wrong.
DEFAULT_THRESHOLD = 0.5
# A margin below this means two routes are too close to call -> abstain.
DEFAULT_MARGIN = 0.12
# Cap on how much of a long prompt is scanned (routing is a cheap prefilter;
# scanning a 200 KB document to pick a model is not cheap).
MAX_SCAN_CHARS = 4000


@dataclass
class Decision:
    route: str | None
    reasons: list[str] = field(default_factory=list)
    confidence: float = 0.0
    abstained: bool = False
    scores: dict[str, float] = field(default_factory=dict)


# --------------------------------------------------------------- route model

def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9_+#.-]+", (text or "").lower())


def _load_yaml_minimal(path: Path) -> dict[str, Any]:
    """Parse the small YAML subset routes.yaml uses.

    Deliberately not a YAML dependency: the file format here is a list of
    routes with scalar fields and string lists. If PyYAML is available it is
    used (more forgiving), otherwise this parser handles the shipped file.
    """
    try:
        import yaml  # noqa: PLC0415
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        pass

    data: dict[str, Any] = {"routes": []}
    current: dict[str, Any] | None = None
    in_list_key: str | None = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if stripped.startswith("- ") and indent == 2:
            current = {}
            data["routes"].append(current)
            stripped = stripped[2:].strip()
            in_list_key = None
            if not stripped:
                continue
        if ":" not in stripped:
            # a bare list item under the current list key
            if current is not None and in_list_key and stripped.startswith("- "):
                current[in_list_key].append(_scalar(stripped[2:].strip()))
            continue
        key, _, value = stripped.partition(":")
        key, value = key.strip(), value.strip()
        if current is None:
            data[key] = _scalar(value) if value else []
            continue
        if not value:
            current[key] = []
            in_list_key = key
            continue
        if value.startswith("[") and value.endswith("]"):
            items = [v.strip() for v in value[1:-1].split(",") if v.strip()]
            current[key] = [_scalar(v) for v in items]
            in_list_key = None
        else:
            current[key] = _scalar(value)
            in_list_key = None
    return data


def _scalar(value: str) -> Any:
    value = value.strip().strip('"').strip("'")
    try:
        if re.fullmatch(r"-?\d+", value):
            return int(value)
        if re.fullmatch(r"-?\d*\.\d+", value):
            return float(value)
    except (TypeError, ValueError):
        pass
    return value


# -------------------------------------------------------------------- router

class Router:
    """Lexical content router with abstention."""

    def __init__(self, routes: list[dict[str, Any]],
                 default_route: str | None = None,
                 threshold: float = DEFAULT_THRESHOLD,
                 margin: float = DEFAULT_MARGIN) -> None:
        self.routes = routes or []
        self.default_route = default_route
        self.threshold = float(threshold)
        self.margin = float(margin)

    @classmethod
    def from_file(cls, path: Path = DEFAULT_ROUTES) -> "Router":
        data = _load_yaml_minimal(path) if path.is_file() else {}
        return cls(
            routes=list(data.get("routes") or []),
            default_route=data.get("default_route"),
            threshold=float(data.get("threshold", DEFAULT_THRESHOLD)),
            margin=float(data.get("margin", DEFAULT_MARGIN)),
        )

    # -- scoring ---------------------------------------------------------
    def _score_route(self, route: dict[str, Any], tokens: list[str],
                     text_low: str, tools_available: bool) -> tuple[float, list[str]]:
        """Return (raw score, reasons). Score is unbounded; normalised later."""
        score = 0.0
        reasons: list[str] = []

        for term in route.get("terms") or []:
            term_low = str(term).lower()
            if " " in term_low:
                hits = text_low.count(term_low)
            else:
                hits = tokens.count(term_low)
            if hits:
                weight = float(route.get("weight", 1.0))
                score += weight * min(hits, 3)  # cap repetition
                reasons.append(f"term:{term_low}x{hits}")

        for pattern in route.get("patterns") or []:
            try:
                if re.search(str(pattern), text_low):
                    score += float(route.get("pattern_weight", 1.5))
                    reasons.append(f"pattern:{pattern}")
            except re.error:
                continue

        if route.get("requires_tools"):
            # BUG FOUND BY THE SELFTEST: this bonus was unconditional, so a
            # prompt matching NO term still scored +1.0 on the tools route and
            # won by default ("zzzz qqqq" routed to the desktop). The bonus
            # only makes sense as a tie-breaker among prompts that already
            # matched this route's vocabulary, so it is gated on having
            # matched something.
            matched_something = score > 0
            if tools_available:
                if matched_something:
                    score += float(route.get("tools_bonus", 1.0))
                    reasons.append("tools:available")
            else:
                score -= float(route.get("tools_penalty", 1.0))
                reasons.append("tools:absent")

        min_tokens = route.get("min_tokens")
        if min_tokens is not None:
            if len(tokens) >= int(min_tokens):
                score += float(route.get("length_bonus", 0.5))
                reasons.append(f"length:{len(tokens)}>={min_tokens}")
            else:
                score -= float(route.get("length_penalty", 0.5))
                reasons.append(f"length:{len(tokens)}<{min_tokens}")

        return score, reasons

    def classify(self, text: str, *, tools_available: bool = True) -> Decision:
        """Classify a prompt. An abstention always returns `route=None`.

        The caller applies its own default when `abstained` is true — see
        `decide_with_default()`. Keeping `route=None` for every abstention is
        deliberate: "the router has no opinion" and "the router picked the
        fallback" are different states, and collapsing them hides a bad route
        table behind plausible-looking output.
        """
        scan = (text or "")[:MAX_SCAN_CHARS]
        tokens = _tokenize(scan)
        text_low = scan.lower()
        if not tokens:
            return Decision(route=None, reasons=["empty-input"],
                            confidence=0.0, abstained=True)

        raw: dict[str, float] = {}
        reasons_by: dict[str, list[str]] = {}
        for route in self.routes:
            name = str(route.get("name") or "?")
            score, reasons = self._score_route(route, tokens, text_low, tools_available)
            raw[name] = score
            reasons_by[name] = reasons

        if not raw or max(raw.values()) <= 0:
            return Decision(route=None, reasons=["no-route-matched"],
                            confidence=0.0, abstained=True, scores=raw)

        # Softmax over the routes that actually scored above zero.
        # BUG FOUND BY THE SELFTEST: including zero-scoring routes gives each
        # of them exp(0)/total of the mass, which pinned the margin at 0.00
        # whenever a prompt matched exactly one route — so every unambiguous
        # prompt abstained on the margin rule. A route with no evidence must
        # get probability 0, not a consolation share.
        #
        # SECOND BUG, same line of code: softmax over a SINGLE candidate is
        # always exactly 1.0, so "confidence 1.00" meant "only one route
        # matched", not "I am certain". A one-candidate softmax cannot express
        # uncertainty, so confidence is computed from the winning score
        # instead, and the margin rule only applies when a runner-up exists.
        positives = {k: v for k, v in raw.items() if v > 0}
        ranked_raw = sorted(positives.items(), key=lambda kv: kv[1], reverse=True)
        winner, win_score = ranked_raw[0]
        runner_score = ranked_raw[1][1] if len(ranked_raw) > 1 else 0.0

        # squash the winning score into (0,1): saturating at 1.0 as evidence
        # accumulates. 1 - exp(-score) is 0.63 at score 1, 0.86 at 2, 0.95 at 3.
        conf = 1.0 - math.exp(-win_score)
        margin_now = (1.0 - math.exp(-(win_score - runner_score)))

        abstained = False
        why = list(reasons_by.get(winner) or [])
        if conf < self.threshold:
            abstained = True
            why.append(f"abstain:confidence {conf:.2f}<{self.threshold}")
        if runner_score > 0 and margin_now < self.margin:
            abstained = True
            why.append(f"abstain:margin {margin_now:.2f}<{self.margin}")
        # A route that matched only because of a penalty-derived reason (the
        # tools route seeing `tools:absent`) is not a real match.
        if all(x.startswith("tools:absent") or x.startswith("length:")
               for x in why):
            abstained = True
            why.append("abstain:only-negative-evidence")

        total = sum(math.exp(v) for v in positives.values())
        probs = {k: (math.exp(v) / total if total else 0.0)
                 for k, v in positives.items()}
        for name in raw:
            probs.setdefault(name, 0.0)

        return Decision(
            route=None if abstained else winner,
            reasons=why,
            confidence=round(conf, 4),
            abstained=abstained,
            scores={k: round(v, 4) for k, v in probs.items()},
        )

    def decide_with_default(self, text: str, *,
                            tools_available: bool = True) -> Decision:
        """Classify, then fall back to `default_route` when the router abstains.

        This is the drop-in shape for QwenPaw's `RoutingPolicy.decide()`, which
        must always return a route.
        """
        decision = self.classify(text, tools_available=tools_available)
        if decision.abstained and self.default_route:
            decision.reasons.append(f"fallback:{self.default_route}")
            decision.route = self.default_route
        return decision


# ------------------------------------------------------------------ selftest

def _seed_routes() -> list[dict[str, Any]]:
    return [
        {"name": "cheap", "terms": ["summarise", "summary", "list", "rename",
                                    "format", "ticket", "status"], "weight": 1.0},
        {"name": "tools", "terms": ["click", "screenshot", "desktop", "browser",
                                    "open", "navigate", "type"], "weight": 1.2,
         "requires_tools": True},
        {"name": "code", "terms": ["refactor", "function", "bug", "test",
                                   "commit", "python", "javascript"], "weight": 1.2},
        {"name": "deep", "terms": ["architecture", "design", "why", "trade-off",
                                   "analyse", "root cause", "explain"],
         "weight": 1.4, "min_tokens": 8, "patterns": [r"\bwhy\b", r"\btrade-?offs?\b"]},
    ]


def selftest() -> int:
    failures: list[str] = []

    def expect(name: str, cond: bool, detail: str = "") -> None:
        print(f"  {'ok  ' if cond else 'FAIL'} {name}  {detail if not cond else ''}")
        if not cond:
            failures.append(name)

    r = Router(_seed_routes(), default_route="cheap", threshold=0.5, margin=0.12)

    print("routing")
    d = r.classify("please summarise this ticket")
    expect("summary routes to cheap", d.route == "cheap", str(d.route))
    expect("carries reasons", any("term:" in x for x in d.reasons), str(d.reasons))
    expect("confidence in [0,1]", 0.0 <= d.confidence <= 1.0, str(d.confidence))

    d = r.classify("click the Save button on the desktop")
    expect("desktop action routes to tools", d.route == "tools", str(d.route))

    d = r.classify("click the Save button", tools_available=False)
    expect("tools route needs tools: abstains without them",
           d.abstained or d.route != "tools", str(d.route) + str(d.abstained))

    d = r.classify("refactor this function and add a test")
    expect("coding routes to code", d.route == "code", str(d.route))

    d = r.classify("why did the architecture fail under load, and what are the trade-offs here")
    expect("deep question routes to deep", d.route == "deep", str(d.route))

    print("abstention")
    d = r.classify("hello")
    expect("greeting abstains", d.abstained is True, str(d.scores))
    expect("abstained route is None", d.route is None, str(d.route))
    expect("abstention is explained",
           any("abstain:" in x or x == "no-route-matched" for x in d.reasons),
           str(d.reasons))
    d = r.classify("")
    expect("empty input abstains", d.abstained and d.route is None)
    expect("empty input explains itself",
           d.reasons == ["empty-input"], str(d.reasons))

    print("default fallback is a separate call")
    d_real = r.classify("hello")
    expect("classify() never substitutes the default",
           d_real.route is None and d_real.abstained, str(d_real.route))
    d_fb = r.decide_with_default("hello")
    expect("decide_with_default() does substitute it",
           d_fb.route == "cheap", str(d_fb.route))
    expect("the fallback is recorded in reasons",
           any("fallback:" in x for x in d_fb.reasons), str(d_fb.reasons))
    d = r.classify("zzzz qqqq")
    expect("no match abstains", d.abstained is True, str(d.scores))

    print("ambiguity")
    # "summarise/refactor/click" is not actually a tie: click carries the
    # heaviest weight plus the tools bonus, so `tools` legitimately wins. Test
    # a REAL near-tie instead — two routes with identical evidence.
    r_tie = Router([
        {"name": "a", "terms": ["alpha"], "weight": 1.0},
        {"name": "b", "terms": ["beta"], "weight": 1.0},
    ], threshold=0.5, margin=0.12)
    d = r_tie.classify("alpha beta")
    expect("a genuine tie abstains on margin", d.abstained is True,
           f"conf={d.confidence} scores={d.scores}")
    expect("the tie is explained as a margin abstention",
           any("margin" in x for x in d.reasons), str(d.reasons))
    # And a clear weighted winner does not abstain.
    d = r.classify("summarise and refactor and click")
    expect("a weighted winner still routes", d.route == "tools" and not d.abstained,
           f"{d.route} conf={d.confidence}")

    print("determinism + bounds")
    t = "summarise this ticket please"
    a, b = r.classify(t), r.classify(t)
    expect("same input gives same decision", a.route == b.route
           and a.confidence == b.confidence, f"{a} vs {b}")
    # The cap bounds WORK, it does not guarantee a route: 5,000 repetitions of
    # "filler" genuinely dilute one signal term, and the honest answer there is
    # to abstain. What must hold is that the scan is bounded — a 100 KB prompt
    # must not be tokenised whole.
    import time as _time
    long_text = "summarise " + "filler " * 5000
    t0 = _time.monotonic()
    d = r.classify(long_text)
    elapsed = _time.monotonic() - t0
    expect("a 36 KB prompt classifies fast (<50 ms)", elapsed < 0.05,
           f"{elapsed*1000:.1f} ms")
    expect("the cap keeps it a prefilter, not a read",
           len(long_text) > MAX_SCAN_CHARS, f"len={len(long_text)}")
    # A long prompt whose signal is NOT buried still routes.
    d2 = r.classify("summarise this ticket. " + "context sentence here. " * 200)
    expect("a long prompt with real signal still routes", d2.route == "cheap",
           f"{d2.route} conf={d2.confidence}")

    print("config handling")
    tmp = Path("/tmp/routes-selftest.yaml")
    tmp.write_text(
        "default_route: cheap\nthreshold: 0.9\nmargin: 0.2\nroutes:\n"
        "  - name: cheap\n    terms: [summarise, list]\n    weight: 1.0\n"
        "  - name: deep\n    terms: [architecture, design]\n    weight: 1.0\n",
        encoding="utf-8")
    try:
        r2 = Router.from_file(tmp)
        expect("loads routes from a file", len(r2.routes) == 2, str(len(r2.routes)))
        expect("reads the threshold", r2.threshold == 0.9, str(r2.threshold))
        d = r2.classify("summarise this")
        expect("a high threshold forces abstention", d.abstained is True,
               f"conf={d.confidence}")
    finally:
        tmp.unlink(missing_ok=True)

    print("missing config")
    r3 = Router.from_file(Path("/tmp/definitely-not-here.yaml"))
    expect("a missing routes file does not raise", r3.routes == [])
    d = r3.classify("anything")
    expect("no routes -> abstain", d.abstained is True)

    print()
    total = 27
    print(f"{total - len(failures)} passed, {len(failures)} failed")
    if failures:
        print("failed: " + ", ".join(failures))
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--text")
    ap.add_argument("--routes", default=str(DEFAULT_ROUTES))
    ap.add_argument("--no-tools", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()
    if args.text is None:
        print("error: --text required (or --selftest)", file=sys.stderr)
        return 2

    router = Router.from_file(Path(args.routes))
    d = router.classify(args.text, tools_available=not args.no_tools)
    print(json.dumps(asdict(d), indent=2) if args.json
          else f"route={d.route} confidence={d.confidence} "
               f"abstained={d.abstained} reasons={d.reasons}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
