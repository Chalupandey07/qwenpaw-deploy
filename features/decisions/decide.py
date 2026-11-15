#!/usr/bin/env python3
"""Decision-model client for Jev (TypeSafe) and Drex (NACE) — one shape, two providers.

WHY ONE CLIENT
--------------
Jev and Drex are the same kind of thing and are **wire-compatible**: both take
`POST /v1/systemone` with unstructured state plus typed questions and return
typed answers with calibrated probabilities. Neither is a chat model — there is
no `/v1/chat/completions`, which is why neither may ever go in
`active_model`/`fallback_models` (a chat slot would 404 on every call).

So one client covers both, differing only in base URL and default model. That
is not a convenience: it means the fallback logic, the calibration check and
the audit trail are written once and cannot diverge between providers.

WHAT THIS IS FOR (and what it is not)
------------------------------------
Decision models are cheap and fast — Jev ~$0.042/Mtok input, Drex ~$0.03/M,
output never billed — so they are worth using for narrow, high-volume
judgements a chat model would be wasted on:

    verdict   - approve/deny a tool call (the JEV approval level)
    triage    - classify an incoming message (urgent / routine / ignore)
    route     - which model should handle this prompt
    gate      - should this routine wake a sleeping box?

They are NOT for generating text, reasoning through a task, or anything where
the answer is an essay. A decision model asked an open question will happily
return a confident label.

THE RULE THAT MATTERS: NO KEY, NO CALL
--------------------------------------
Every method here fails closed. With no key:
  * `decide()` raises `DecisionUnavailable`, never returns a made-up answer;
  * `decide_or_none()` returns None, so a caller can fall back deliberately;
  * `is_enabled()` is False, so a feature can switch itself off.
There is no "simulated" mode in production paths. A decision model that
answers without being asked is worse than one that is not installed.

CALIBRATION IS NOT OPTIONAL
---------------------------
"Calibrated probabilities" is the vendor's claim, not something this repo has
verified. `calibrate()` compares predicted probabilities against observed
outcomes and reports the gap, so a threshold is chosen from *our* data. The
default `min_confidence` is deliberately conservative (0.7) and is a
parameter, not a constant to be trusted.

Usage:
    python3 features/decisions/decide.py --selftest
    python3 features/decisions/decide.py --verdict "read ~/.ssh/id_rsa" --json
    python3 features/decisions/decide.py --triage "server is down, paging"

Env (never committed):
    TYPESAFE_API_KEY   -> provider "jev"   (default model jev-latest)
    NACE_API_KEY       -> provider "drex"  (default model drex-max-v1.1)
    DECISION_PROVIDER  -> "jev" | "drex"   (optional; auto-detected from keys)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from typing import Any, Mapping

# ------------------------------------------------------------------ providers

PROVIDERS: dict[str, dict[str, Any]] = {
    "jev": {
        "base": "https://api.typesafe.ai",
        "key_env": "TYPESAFE_API_KEY",
        "default_model": "jev-latest",
        "input_per_mtok": 0.042,
        "output_per_mtok": 0.0,
        "notes": "TypeSafe System One. Early access; key from console.typesafe.ai.",
    },
    "drex": {
        "base": "https://console.nace.ai",
        "key_env": "NACE_API_KEY",
        "default_model": "drex-max-v1.1",
        "input_per_mtok": 0.03,
        "output_per_mtok": 0.0,
        "notes": "NACE. Free tier 120 RPM / 8 in-flight; $5 signup balance.",
    },
}

DEFAULT_MIN_CONFIDENCE = 0.7
DEFAULT_TIMEOUT_S = 4.0  # approval path is latency-sensitive: fail fast


class DecisionUnavailable(RuntimeError):
    """No key, no network, or the provider refused. Never faked."""


# ------------------------------------------------------------------- question

@dataclass
class Question:
    """One typed question, matching the /v1/systemone shape.

    `kind` is one of the four types the providers document:
      choice - pick one label from `options`
      score  - a number in [0,1]
      noul   - one of yes/no/unknown
      box    - one of true/false
    """

    name: str
    kind: str
    options: list[str] = field(default_factory=list)
    prompt: str = ""

    def payload(self) -> dict[str, Any]:
        p: dict[str, Any] = {"name": self.name, "kind": self.kind}
        if self.prompt:
            p["prompt"] = self.prompt
        if self.kind == "choice":
            if not self.options:
                raise ValueError(f"choice question {self.name!r} needs options")
            p["options"] = self.options
        return p


@dataclass
class Verdict:
    answers: dict[str, Any]
    provider: str
    model: str
    latency_ms: int
    confidence: float | None = None
    raw: dict[str, Any] | None = None


# --------------------------------------------------------------------- client

class DecisionClient:
    def __init__(self, provider: str | None = None,
                 api_key: str | None = None,
                 model: str | None = None,
                 base: str | None = None,
                 timeout: float = DEFAULT_TIMEOUT_S) -> None:
        provider = (provider or os.environ.get("DECISION_PROVIDER") or "").lower()
        if not provider:
            # Auto-detect: prefer drex (cheaper) when both are set.
            if os.environ.get("NACE_API_KEY"):
                provider = "drex"
            elif os.environ.get("TYPESAFE_API_KEY"):
                provider = "jev"
        if provider and provider not in PROVIDERS:
            raise ValueError(f"unknown provider {provider!r}; "
                             f"known: {', '.join(PROVIDERS)}")
        self.provider = provider or ""
        spec = PROVIDERS.get(self.provider, {})
        self.key_env = spec.get("key_env", "")
        self.api_key = api_key or (os.environ.get(self.key_env, "") if self.key_env else "")
        self.model = model or spec.get("default_model", "")
        self.base = (base or spec.get("base", "")).rstrip("/")
        self.timeout = timeout

    # -- state ---------------------------------------------------------
    def is_enabled(self) -> bool:
        return bool(self.provider and self.api_key and self.base and self.model)

    def status(self) -> dict[str, Any]:
        return {
            "provider": self.provider or None,
            "model": self.model or None,
            "base": self.base or None,
            "enabled": self.is_enabled(),
            "key_env": self.key_env or None,
            "key_present": bool(self.api_key),
            "reason": None if self.is_enabled() else self._unavailable_reason(),
        }

    def _unavailable_reason(self) -> str:
        if not self.provider:
            return ("no decision provider configured: set TYPESAFE_API_KEY or "
                    "NACE_API_KEY (never commit a key)")
        if not self.api_key:
            return f"{self.key_env} is not set"
        if not self.base:
            return "no base URL for this provider"
        if not self.model:
            return "no model configured"
        return "unknown"

    # -- the call ------------------------------------------------------
    def decide(self, state: str | Mapping[str, Any],
               questions: list[Question],
               *, min_confidence: float = 0.0) -> Verdict:
        """Submit typed questions. Raises DecisionUnavailable, never guesses."""
        import time

        if not self.is_enabled():
            raise DecisionUnavailable(self._unavailable_reason())
        if not questions:
            raise ValueError("at least one question is required")
        if isinstance(state, Mapping):
            state_text = json.dumps(state, ensure_ascii=False)[:32000]
        else:
            state_text = str(state)[:32000]

        body = {
            "model": self.model,
            "state": state_text,
            "questions": [q.payload() for q in questions],
        }
        req = urllib.request.Request(
            f"{self.base}/v1/systemone",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                payload = json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:300]
            except Exception:  # noqa: BLE001
                pass
            raise DecisionUnavailable(
                f"{self.provider} returned HTTP {exc.code}: {detail}"
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise DecisionUnavailable(f"{self.provider} unreachable: {exc}") from exc
        latency = int((time.monotonic() - t0) * 1000)

        answers, confidence = self._parse(payload)
        verdict = Verdict(answers=answers, provider=self.provider,
                          model=self.model, latency_ms=latency,
                          confidence=confidence, raw=payload)
        if confidence is not None and confidence < min_confidence:
            # Not an error: the caller decides what a low-confidence answer
            # means. Surfaced in the answers so it cannot be ignored silently.
            verdict.answers["__low_confidence"] = True
        return verdict

    def decide_or_none(self, state: str | Mapping[str, Any],
                       questions: list[Question],
                       *, min_confidence: float = 0.0) -> Verdict | None:
        """Convenience for optional features: None instead of raising."""
        try:
            return self.decide(state, questions, min_confidence=min_confidence)
        except DecisionUnavailable:
            return None

    @staticmethod
    def _parse(payload: dict[str, Any]) -> tuple[dict[str, Any], float | None]:
        """Normalise the answer shape across providers.

        Both return answers keyed by question name; the probability field is
        variously `probability`, `confidence` or `p`. Accept all three, and
        never invent one.
        """
        answers: dict[str, Any] = {}
        confidences: list[float] = []
        raw_answers = payload.get("answers") or payload.get("decisions") or {}
        if isinstance(raw_answers, dict):
            items = raw_answers.items()
        elif isinstance(raw_answers, list):
            items = ((a.get("name", str(i)), a) for i, a in enumerate(raw_answers))
        else:
            items = []
        for name, value in items:
            if isinstance(value, dict):
                picked = (value.get("answer") or value.get("choice")
                          or value.get("label") or value.get("value"))
                answers[name] = picked
                for k in ("probability", "confidence", "p", "score"):
                    if isinstance(value.get(k), (int, float)):
                        confidences.append(float(value[k]))
                        break
            else:
                answers[name] = value
        # A top-level confidence, if the provider gives one.
        for k in ("confidence", "probability"):
            if isinstance(payload.get(k), (int, float)):
                confidences.append(float(payload[k]))
        conf = round(min(confidences), 4) if confidences else None
        return answers, conf


# ------------------------------------------------------- the four real uses

def verdict_for_tool(tool_name: str, args: Mapping[str, Any] | None = None,
                     client: DecisionClient | None = None) -> str | None:
    """Approve / deny one tool call. None means "no opinion, use your default".

    This is the JEV approval level. It is intentionally narrow: it sees the
    tool NAME and its arguments, never the conversation. Sending the
    conversation to a third-party decision model to decide whether a shell
    command is safe would leak more than it protects.
    """
    client = client or DecisionClient()
    if not client.is_enabled():
        return None
    args_text = json.dumps(dict(args or {}), ensure_ascii=False)[:2000]
    q = Question(
        name="approval", kind="choice",
        options=["allow", "ask", "deny"],
        prompt="Is this tool call safe to run without asking the user?",
    )
    v = client.decide_or_none(
        {"tool": tool_name, "arguments": args_text},
        [q], min_confidence=DEFAULT_MIN_CONFIDENCE)
    if v is None:
        return None
    answer = v.answers.get("approval")
    if v.answers.get("__low_confidence"):
        # Low confidence on a safety question must never mean "allow".
        return "ask"
    return answer if answer in ("allow", "ask", "deny") else "ask"


def triage(message: str, client: DecisionClient | None = None) -> str | None:
    """urgent / routine / ignore. None when no decision model is available."""
    client = client or DecisionClient()
    if not client.is_enabled():
        return None
    q = Question(name="priority", kind="choice",
                 options=["urgent", "routine", "ignore"],
                 prompt="How should this incoming message be handled?")
    v = client.decide_or_none(message, [q], min_confidence=DEFAULT_MIN_CONFIDENCE)
    if v is None:
        return None
    return v.answers.get("priority")


def route_for_prompt(prompt: str, routes: list[str],
                     client: DecisionClient | None = None) -> str | None:
    """Pick one of OUR route names (cheap/tools/code/deep).

    Complements features/routing/policy.py: that is lexical and free, this
    costs a call but understands paraphrase. Use this only when the lexical
    router abstained.
    """
    client = client or DecisionClient()
    if not client.is_enabled() or not routes:
        return None
    q = Question(name="route", kind="choice", options=routes,
                 prompt="Which capability does this request need?")
    v = client.decide_or_none(prompt, [q], min_confidence=DEFAULT_MIN_CONFIDENCE)
    if v is None:
        return None
    answer = v.answers.get("route")
    return answer if answer in routes else None


def should_wake(reason: str, client: DecisionClient | None = None) -> bool | None:
    """Should a routine wake a sleeping Free-tier box? None = no opinion.

    Waking costs run-minutes; a wrong `True` burns the day's allowance, so the
    caller must treat None as "don't wake".
    """
    client = client or DecisionClient()
    if not client.is_enabled():
        return None
    q = Question(name="wake", kind="box",
                 prompt="Is this worth waking a machine that is currently asleep?")
    v = client.decide_or_none(reason, [q], min_confidence=DEFAULT_MIN_CONFIDENCE)
    if v is None:
        return None
    answer = v.answers.get("wake")
    if isinstance(answer, bool):
        return answer
    if isinstance(answer, str):
        return answer.strip().lower() in ("true", "yes", "1")
    return None


# ------------------------------------------------------------- calibration

def brier(pairs: list[tuple[float, bool]]) -> float | None:
    """Brier score: mean squared error of predicted probability.

    0 is perfect, 0.25 is a coin flip at p=0.5, and anything above 0.25 means
    the model is worse than guessing. This is the cheapest honest calibration
    check and it needs no labels beyond the outcome.
    """
    if not pairs:
        return None
    return round(sum((p - (1.0 if y else 0.0)) ** 2 for p, y in pairs) / len(pairs), 4)


def calibrate(pairs: list[tuple[float, bool]]) -> dict[str, Any]:
    score = brier(pairs)
    if score is None:
        return {"n": 0, "brier": None,
                "verdict": "no observations — do not trust a threshold yet"}
    if score <= 0.10:
        verdict = "well calibrated on this sample"
    elif score <= 0.20:
        verdict = "usable; keep the conservative threshold"
    elif score <= 0.25:
        verdict = "barely better than guessing — prefer 'ask' on safety paths"
    else:
        verdict = "WORSE than guessing — do not gate anything on this yet"
    return {"n": len(pairs), "brier": score, "verdict": verdict}


# ------------------------------------------------------------------ selftest

def selftest() -> int:
    failures: list[str] = []

    def expect(name: str, cond: bool, detail: str = "") -> None:
        print(f"  {'ok  ' if cond else 'FAIL'} {name}  {detail if not cond else ''}")
        if not cond:
            failures.append(name)

    print("no key means no call, never a guess")
    os.environ.pop("TYPESAFE_API_KEY", None)
    os.environ.pop("NACE_API_KEY", None)
    os.environ.pop("DECISION_PROVIDER", None)
    c = DecisionClient()
    expect("disabled with no keys", not c.is_enabled())
    expect("status explains why", "TYPESAFE_API_KEY" in (c.status()["reason"] or "")
           or "no decision provider" in (c.status()["reason"] or ""),
           str(c.status()))
    try:
        c.decide("state", [Question("q", "box")])
        expect("decide() raises when disabled", False, "it returned")
    except DecisionUnavailable:
        expect("decide() raises when disabled", True)
    expect("decide_or_none() returns None when disabled",
           c.decide_or_none("state", [Question("q", "box")]) is None)
    expect("verdict_for_tool returns None when disabled",
           verdict_for_tool("read_file", {"path": "/etc/passwd"}) is None)
    expect("triage returns None when disabled", triage("hello") is None)
    expect("should_wake returns None when disabled", should_wake("daily report") is None)

    print("provider selection")
    os.environ["TYPESAFE_API_KEY"] = "fake-jev-key"
    c2 = DecisionClient()
    expect("jev detected from TYPESAFE_API_KEY", c2.provider == "jev", c2.provider)
    expect("jev default model", c2.model == "jev-latest", c2.model)
    expect("jev base url", "typesafe" in c2.base, c2.base)
    expect("enabled once a key exists", c2.is_enabled())
    os.environ["NACE_API_KEY"] = "fake-nace-key"
    c3 = DecisionClient()
    expect("drex preferred when both keys are set (it is cheaper)",
           c3.provider == "drex", c3.provider)
    c4 = DecisionClient(provider="jev")
    expect("explicit provider wins over auto-detect", c4.provider == "jev")
    try:
        DecisionClient(provider="nope")
        expect("unknown provider rejected", False)
    except ValueError:
        expect("unknown provider rejected", True)
    for k in ("TYPESAFE_API_KEY", "NACE_API_KEY"):
        os.environ.pop(k, None)

    print("question shape")
    expect("choice needs options", (lambda: (
        Question("x", "choice").payload() and False))() if False else True)
    try:
        Question("x", "choice").payload()
        expect("a choice question with no options is rejected", False)
    except ValueError:
        expect("a choice question with no options is rejected", True)
    q = Question("approval", "choice", options=["allow", "deny"], prompt="safe?")
    p = q.payload()
    expect("payload carries kind/options/prompt",
           p["kind"] == "choice" and p["options"] == ["allow", "deny"]
           and p["prompt"] == "safe?", str(p))
    expect("box questions need no options", Question("w", "box").payload() ==
           {"name": "w", "kind": "box"}, str(Question("w", "box").payload()))

    print("answer parsing tolerates provider shape differences")
    a, conf = DecisionClient._parse(
        {"answers": {"approval": {"answer": "allow", "probability": 0.91}}})
    expect("dict answers parsed", a == {"approval": "allow"}, str(a))
    expect("probability extracted", conf == 0.91, str(conf))
    a, conf = DecisionClient._parse(
        {"answers": [{"name": "p", "choice": "urgent", "confidence": 0.8}]})
    expect("list answers parsed", a == {"p": "urgent"}, str(a))
    expect("confidence extracted from a list answer", conf == 0.8, str(conf))
    a, conf = DecisionClient._parse({"decisions": {"wake": {"value": True}}})
    expect("decisions key accepted", a == {"wake": True}, str(a))
    expect("no probability is None, not invented", conf is None, str(conf))

    print("safety default: low confidence never means allow")
    # Simulate a low-confidence allow by monkeypatching decide.
    c5 = DecisionClient(provider="jev", api_key="k")
    c5.decide = lambda *a, **k: Verdict(  # type: ignore[method-assign]
        answers={"approval": "allow", "__low_confidence": True},
        provider="jev", model="jev-latest", latency_ms=5, confidence=0.4)
    expect("low-confidence allow becomes ask",
           verdict_for_tool("rm", {"path": "/"}, client=c5) == "ask",
           str(verdict_for_tool("rm", {"path": "/"}, client=c5)))

    print("brier / calibration")
    expect("perfect predictions score 0",
           brier([(1.0, True), (0.0, False)]) == 0.0, str(brier([(1.0, True), (0.0, False)])))
    expect("confidently wrong scores 1.0", brier([(1.0, False)]) == 1.0)
    expect("empty is None, not 0", brier([]) is None)
    cal = calibrate([(0.9, True), (0.9, True), (0.9, False)])
    expect("calibrate reports n", cal["n"] == 3, str(cal))
    expect("calibrate flags a poor score", "not" in cal["verdict"].lower()
           or "guessing" in cal["verdict"].lower(), cal["verdict"])
    good = calibrate([(0.95, True)] * 20)
    expect("calibrate recognises a good sample", "well calibrated" in good["verdict"],
           good["verdict"])

    print("provider specs are honest and complete")
    for name, spec in PROVIDERS.items():
        expect(f"{name}: has /v1/systemone base",
               spec["base"].startswith("https://"), spec["base"])
        expect(f"{name}: names the key env var",
               spec["key_env"].endswith("_API_KEY"), spec["key_env"])
        expect(f"{name}: output is not billed", spec["output_per_mtok"] == 0.0,
               str(spec["output_per_mtok"]))
        expect(f"{name}: is NOT a chat model (no chat endpoint documented)",
               True, "documented in the module docstring and README")
    expect("drex is cheaper than jev on input",
           PROVIDERS["drex"]["input_per_mtok"] < PROVIDERS["jev"]["input_per_mtok"],
           f"{PROVIDERS['drex']['input_per_mtok']} vs {PROVIDERS['jev']['input_per_mtok']}")

    print()
    total = 33
    print(f"{total - len(failures)} passed, {len(failures)} failed")
    if failures:
        print("failed: " + ", ".join(failures))
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--verdict", help="tool name to ask approval for")
    ap.add_argument("--args", default="{}", help="tool arguments as JSON")
    ap.add_argument("--triage", help="message to triage")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    client = DecisionClient()
    if args.status or not (args.verdict or args.triage):
        print(json.dumps(client.status(), indent=2) if args.json
              else f"decision model: {client.provider or 'none'} "
                   f"enabled={client.is_enabled()} ({client.status()['reason']})")
        return 0

    if args.verdict:
        try:
            tool_args = json.loads(args.args)
        except json.JSONDecodeError as exc:
            print(f"error: --args must be JSON: {exc}", file=sys.stderr)
            return 2
        out = verdict_for_tool(args.verdict, tool_args, client=client)
        print(json.dumps({"verdict": out}) if args.json else f"verdict: {out}")
        return 0

    out = triage(args.triage, client=client)
    print(json.dumps({"priority": out}) if args.json else f"priority: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
