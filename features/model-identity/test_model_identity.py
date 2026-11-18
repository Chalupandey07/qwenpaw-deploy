#!/usr/bin/env python3
"""Machine-free tests for the serving-model identity note (provisional T134).

Proves, against the real repo files and the stdlib-only module
``model_identity.py`` (same directory):

(a) Part 1 — the active-model discrepancy verdict is DERIVED from the repo
    files, not hardcoded: config-patch.md says one thing, cost-data.json +
    the audit retest say another, and the verdict function reads all of
    them, counts corroboration, and names the stale value;
(b) the resolver precedence is per-agent active_model if non-null, else
    the global active_model.json value, else None (never an invented
    model);
(c) the identity note carries the resolved serving model, with the fork
    PR #37/#44 wording rules: plain when serving == configured,
    "unavailable" only with a recorded fallback reason, neutral otherwise,
    and plain for the same model on another key;
(d) stamping puts exactly one note on a COPY of the messages (input never
    mutated, never stacks, works with str or block-list system content,
    synthesizes a system message when there is none);
(e) the fallback sink is read for the RECORDED switch reason, and a stale
    event targeting another model is ignored;
(f) a model switch appends exactly one {from, to, reason} JSONL line to
    the switch log, and a switch with no change logs nothing;
(g) the note's token estimate (chars / 3.6, the repo convention) is
    positive, bounded, and monotonic — the #44 budget reserve;
(h) the wrapper entry point stamps the plain serving note when no
    fallback sink is available (the fail-open the deployed wrapper
    relies on), without mutating its input.

Fail-first: run BEFORE model_identity.py exists and the import fails;
run after and the suite passes:

    python3 test_model_identity.py --selftest   # must PASS (48 checks)

Everything runs against temporary files plus read-only reads of the repo
files that carry the discrepancy evidence; no repo file, no machine, and
no network is touched. Stdlib only.
"""

from __future__ import annotations

import copy
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))

from model_identity import (  # noqa: E402
    append_switch_log,
    build_identity_note,
    discrepancy_verdict,
    estimate_note_tokens,
    fallback_state_from_sink,
    resolve_serving_model,
    stamp_note,
    stamp_serving_note_for_call,
)

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(
        f"  {'PASS' if ok else 'FAIL'}  {name}"
        + (f"  ({detail})" if detail and not ok else "")
    )


MOSICN = {"provider_id": "mosicn", "model": "nex-n2.6"}
ASTRA = {"provider_id": "xingchiapi", "model": "gpt-6-astra"}
KILO = {"provider_id": "kilo", "model": "kilo-auto/free"}


def run_suite() -> int:
    # -- (a) Part 1: verdict derived from the actual repo files --------
    verdict = discrepancy_verdict(REPO_ROOT)
    check(
        "A1 config-patch.md §2 reads xingchiapi/gpt-6-astra",
        verdict["evidence"]["config_patch_value"] == ASTRA,
        f"got {verdict['evidence']['config_patch_value']}",
    )
    check(
        "A2 cost-data.json active_model is mosicn/nex-n2.6",
        verdict["evidence"]["cost_data_value"] == MOSICN,
        f"got {verdict['evidence']['cost_data_value']}",
    )
    check(
        "A3 retest REPORT confirms mosicn in active_model.json",
        verdict["evidence"]["retest_confirms_cost_data"] is True,
    )
    check(
        "A4 'no active chat model configured' exists in reme_doctor.py",
        verdict["evidence"]["phrase_in_reme_doctor"] is True,
    )
    check(
        "A5 phrase is a diagnostic string, not a live-state claim",
        verdict["evidence"]["phrase_is_diagnostic"] is True,
    )
    check(
        "A6 both agents' agent.json active_model is null",
        verdict["evidence"]["agent_active_models"]
        == {"default": None, "QwenPaw_QA_Agent_0.2": None},
        f"got {verdict['evidence']['agent_active_models']}",
    )
    check(
        "A7 verdict: effective is mosicn, stale is xingchiapi",
        verdict["effective"] == MOSICN and verdict["stale"] == ASTRA,
        f"got effective={verdict['effective']} stale={verdict['stale']}",
    )
    check(
        "A8 2026-11-15 usage shows both models used (switch that day)",
        verdict["evidence"]["both_models_used_2026_11_15"] is True,
    )

    # -- (b) resolver precedence ---------------------------------------
    check(
        "B1 per-agent slot wins over the global file",
        resolve_serving_model(ASTRA, MOSICN) == ASTRA,
    )
    check(
        "B2 per-agent null falls back to the global file",
        resolve_serving_model(None, MOSICN) == MOSICN,
    )
    check(
        "B3 both missing resolves to None (never invented)",
        resolve_serving_model(None, None) is None,
    )
    check(
        "B4 slot is normalized to provider_id/model only",
        resolve_serving_model(
            {"provider_id": "mosicn", "model": "nex-n2.6", "extra": 1},
            None,
        )
        == MOSICN,
    )
    check(
        "B5 malformed slot (no model) is treated as missing",
        resolve_serving_model({"provider_id": "mosicn"}, MOSICN) == MOSICN
        and resolve_serving_model({"provider_id": "mosicn"}, None) is None,
    )

    # -- (c) note wording (fork #37/#44 rules) -------------------------
    plain = build_identity_note(MOSICN, MOSICN)
    check(
        "C1 plain note names the serving model",
        plain is not None
        and "mosicn/nex-n2.6" in plain
        and "You are currently being served by mosicn/nex-n2.6" in plain,
        f"got {plain!r}",
    )
    check(
        "C2 plain note never says 'unavailable'",
        plain is not None and "unavailable" not in plain,
    )
    switched = build_identity_note(KILO, MOSICN, reason_kind="transient")
    check(
        "C3 switched + recorded reason says 'unavailable' + names both",
        switched is not None
        and "was unavailable" in switched
        and "mosicn/nex-n2.6" in switched
        and "kilo/kilo-auto/free" in switched
        and "mention the switch" in switched,
        f"got {switched!r}",
    )
    neutral = build_identity_note(KILO, MOSICN, reason_kind=None)
    check(
        "C4 switched + no reason is neutral (no invented cause)",
        neutral is not None
        and "unavailable" not in neutral
        and "mosicn/nex-n2.6" in neutral
        and "kilo/kilo-auto/free" in neutral,
        f"got {neutral!r}",
    )
    check(
        "C5 same model on another key keeps plain wording",
        build_identity_note(MOSICN, MOSICN, reason_kind="transient")
        == plain,
    )
    check(
        "C6 no serving model means no note (never invented)",
        build_identity_note(None, MOSICN) is None,
    )
    check(
        "C7 configured unknown + serving known is plain wording",
        build_identity_note(MOSICN, None) == plain,
    )

    # -- (d) stamping ---------------------------------------------------
    note = build_identity_note(MOSICN, MOSICN)
    assert note is not None
    msgs = [
        {"role": "system", "content": "You are AgentX."},
        {"role": "user", "content": "hello"},
    ]
    original = copy.deepcopy(msgs)
    stamped = stamp_note(msgs, note)
    check(
        "D1 stamp carries the serving model in the system message",
        stamped[0]["content"].endswith(note)
        and "mosicn/nex-n2.6" in stamped[0]["content"],
    )
    check("D2 input messages are never mutated", msgs == original)
    restamped = stamp_note(stamped, build_identity_note(ASTRA, ASTRA))
    check(
        "D3 re-stamp replaces: exactly one note, new model only",
        restamped[0]["content"].count("[serving-model]") == 1
        and "xingchiapi/gpt-6-astra" in restamped[0]["content"]
        and "mosicn/nex-n2.6" not in restamped[0]["content"],
        f"got {restamped[0]['content']!r}",
    )
    no_sys = [{"role": "user", "content": "hi"}]
    stamped2 = stamp_note(no_sys, note)
    check(
        "D4 no system message: one is synthesized first, order kept",
        len(stamped2) == 2
        and stamped2[0]["role"] == "system"
        and note in stamped2[0]["content"]
        and stamped2[1] == {"role": "user", "content": "hi"},
    )
    blocks = [
        {
            "role": "system",
            "content": [{"type": "text", "text": "You are AgentX."}],
        },
        {"role": "user", "content": "hi"},
    ]
    blocks_copy = copy.deepcopy(blocks)
    stamped3 = stamp_note(blocks, note)
    check(
        "D5 block-list system content gains a text block",
        isinstance(stamped3[0]["content"], list)
        and stamped3[0]["content"][-1] == {"type": "text", "text": note}
        and stamped3[0]["content"][0] == {"type": "text", "text": "You are AgentX."},
    )
    check("D5b block-list input is never mutated", blocks == blocks_copy)
    check("D6 empty messages stay empty", stamp_note([], note) == [])
    check(
        "D7 no note means messages come back unchanged",
        stamp_note(msgs, None) == msgs
        and stamp_note(msgs, None) is not msgs,
    )
    stale = stamp_note(msgs, build_identity_note(ASTRA, ASTRA))
    check(
        "D8 stamping over a stale note never stacks",
        stamp_note(stale, note)[0]["content"].count("[serving-model]") == 1,
    )

    # -- (e) fallback sink ----------------------------------------------
    event = {
        "type": "model_fallback",
        "from_provider_id": "mosicn",
        "from_model_id": "nex-n2.6",
        "to_provider_id": "kilo",
        "to_model_id": "kilo-auto/free",
        "reason_kind": "transient",
    }
    sink = {"events": [event], "actual_model": {"provider_id": "kilo"}}
    configured, reason = fallback_state_from_sink(sink, KILO)
    check(
        "E1 sink event gives configured model + recorded reason",
        configured == MOSICN and reason == "transient",
        f"got {configured} {reason}",
    )
    check(
        "E2 empty sink gives no switch",
        fallback_state_from_sink({"events": [], "actual_model": None}, KILO)
        == (None, None),
    )
    check(
        "E3 no sink gives no switch",
        fallback_state_from_sink(None, KILO) == (None, None),
    )
    check(
        "E4 event targeting another model is ignored (stale)",
        fallback_state_from_sink(sink, ASTRA) == (None, None),
    )
    chained = {
        "events": [
            event,
            {
                "type": "model_fallback",
                "from_provider_id": "kilo",
                "from_model_id": "kilo-auto/free",
                "to_provider_id": "openrouter",
                "to_model_id": "some-model",
                "reason_kind": "rate_limited",
            },
        ],
        "actual_model": None,
    }
    configured2, reason2 = fallback_state_from_sink(
        chained, {"provider_id": "openrouter", "model": "some-model"}
    )
    check(
        "E5 chained fallbacks: configured is the first from, reason latched",
        configured2 == MOSICN and reason2 == "transient",
        f"got {configured2} {reason2}",
    )
    check(
        "E6 malformed sink never crashes",
        fallback_state_from_sink({"events": [{"type": "model_fallback"}]},
                                   KILO)
        == (None, None)
        and fallback_state_from_sink({"events": "not-a-list"}, KILO)
        == (None, None),
    )

    # -- (f) switch log --------------------------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        log = Path(tmp) / "model-switch-log.jsonl"
        ok = append_switch_log(
            log, agent_id="default", from_slot=MOSICN, to_slot=ASTRA,
            reason="user switched in console",
        )
        lines = log.read_text(encoding="utf-8").strip().splitlines()
        entry = json.loads(lines[0]) if lines else {}
        check(
            "F1 switch appends one {from, to, reason} line",
            ok is True
            and len(lines) == 1
            and entry.get("from") == MOSICN
            and entry.get("to") == ASTRA
            and entry.get("reason") == "user switched in console"
            and entry.get("agent_id") == "default"
            and isinstance(entry.get("at"), str),
            f"got {entry}",
        )
        before = log.read_text(encoding="utf-8")
        ok2 = append_switch_log(
            log, agent_id="default", from_slot=ASTRA, to_slot=ASTRA,
            reason="no-op",
        )
        check(
            "F2 switch with no change logs nothing",
            ok2 is False and log.read_text(encoding="utf-8") == before,
        )
        log2 = Path(tmp) / "log2.jsonl"
        ok3 = append_switch_log(
            log2, agent_id="default", from_slot=MOSICN, to_slot=KILO,
            reason="bad\nreason\rwith newlines",
        )
        entry3 = json.loads(log2.read_text(encoding="utf-8").strip())
        check(
            "F3 reason is sanitized to one line",
            ok3 is True
            and "\n" not in entry3["reason"]
            and "\r" not in entry3["reason"],
            f"got {entry3['reason']!r}",
        )
        long_reason = "x" * 2000
        append_switch_log(
            log2, agent_id="default", from_slot=KILO, to_slot=MOSICN,
            reason=long_reason,
        )
        entries = [
            json.loads(line)
            for line in log2.read_text(encoding="utf-8").splitlines()
        ]
        check(
            "F4 second switch appends a second valid line; long reason capped",
            len(entries) == 2
            and entries[1]["from"] == KILO
            and entries[1]["to"] == MOSICN
            and len(entries[1]["reason"]) <= 500,
        )
        log3 = Path(tmp) / "log3.jsonl"
        ok5 = append_switch_log(
            log3, agent_id="default", from_slot=None, to_slot=MOSICN,
            reason="first model set",
        )
        entry5 = json.loads(log3.read_text(encoding="utf-8").strip())
        check(
            "F5 from None is stored as null, not dropped",
            ok5 is True and entry5["from"] is None
            and entry5["to"] == MOSICN,
        )
        check(
            "F5b both None is a no-change (nothing logged)",
            append_switch_log(
                log3, agent_id="default", from_slot=None, to_slot=None,
                reason="nothing",
            )
            is False,
        )
        log4 = Path(tmp) / "log4.jsonl"
        log4.write_text("this is not json\n", encoding="utf-8")
        ok6 = append_switch_log(
            log4, agent_id="default", from_slot=MOSICN, to_slot=ASTRA,
            reason="after garbage",
        )
        lines4 = log4.read_text(encoding="utf-8").splitlines()
        check(
            "F6 append is append-only: prior garbage line survives, new "
            "line is valid JSON",
            ok6 is True
            and len(lines4) == 2
            and json.loads(lines4[1])["to"] == ASTRA,
        )

    # -- (g) budget reserve ----------------------------------------------
    check(
        "G1 estimate is chars / 3.6 (36 chars -> 10 tokens)",
        estimate_note_tokens("x" * 36) == 10,
    )
    real_note = build_identity_note(MOSICN, MOSICN)
    assert real_note is not None
    est = estimate_note_tokens(real_note)
    check(
        "G2 real note estimate is positive and bounded (<= 120 tokens)",
        0 < est <= 120,
        f"got {est}",
    )
    check(
        "G3 longer note estimates larger",
        estimate_note_tokens(real_note + " " + real_note) > est,
    )
    check(
        "G4 empty note estimates zero",
        estimate_note_tokens("") == 0,
    )

    # -- (h) wrapper entry point (sink absent on this VM) ----------------
    # The qwenpaw package is not installed here, so the deferred sink
    # import fails by design and the entry degrades to the plain note.
    # That is the exact fail-open the deployed wrapper relies on.
    call_msgs = [
        {"role": "system", "content": "You are AgentX."},
        {"role": "user", "content": "hello"},
    ]
    call_original = copy.deepcopy(call_msgs)
    call_stamped = stamp_serving_note_for_call(
        "mosicn", "nex-n2.6", call_msgs
    )
    check(
        "H1 wrapper entry stamps the plain serving note without a sink",
        "[serving-model]" in call_stamped[0]["content"]
        and "mosicn/nex-n2.6" in call_stamped[0]["content"]
        and "unavailable" not in call_stamped[0]["content"],
    )
    check(
        "H2 wrapper entry never mutates its input",
        call_msgs == call_original,
    )

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    failed = len(CHECKS) - passed
    print(f"\n{passed} passed, {failed} failed")
    return failed


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true",
                        help="run the suite (same as no flags)")
    parser.parse_args()
    return 0 if run_suite() == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
