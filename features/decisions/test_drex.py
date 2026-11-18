#!/usr/bin/env python3
"""Machine-free tests for the Drex wiring (T130).

What this proves, without a NACE key and without the machine:
  (a) decide.py fails closed with no key (no call, never a guess);
  (b) the NACE endpoint is configurable: NACE_BASE_URL changes the base URL
      the client would call, verified against a local mock server that
      implements POST /v1/systemone -- and it does NOT retarget Jev
      (a stray NACE var must never ship the TypeSafe key to NACE);
  (c) the decision_model slot fragment (decision_model_drex.json) is valid
      JSON with the right shape (provider/model/endpoint, no key, no chat
      endpoint);
  (d) the live-test script (test_drex_live.py) refuses to run without a
      key (exit 2, "blocked on NACE key"), and succeeds against the mock
      with a fake key -- proving the live path works end to end except for
      the real NACE call itself;
  (e) the machine-apply script (apply_decision_model_drex.py) dry-runs
      cleanly, refuses to apply without a key, and with a key sets the
      slot on both agents without touching approval_level.

Fail-first: run this BEFORE the decide.py env-override change and before
the fragment / scripts exist -- checks 4, 6-18 fail. After the change:
21/21 pass.

Usage:
    python3 features/decisions/test_drex.py
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV_VARS = ("NACE_API_KEY", "TYPESAFE_API_KEY", "DECISION_PROVIDER",
            "NACE_BASE_URL", "TYPESAFE_BASE_URL")

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


@contextlib.contextmanager
def scrubbed_env(**overrides: str):
    """Run with the decision env vars removed, then apply overrides."""
    saved = {k: os.environ.get(k) for k in ENV_VARS}
    for k in ENV_VARS:
        os.environ.pop(k, None)
    os.environ.update(overrides)
    try:
        yield
    finally:
        for k in ENV_VARS:
            os.environ.pop(k, None)
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v


def load_decide():
    spec = importlib.util.spec_from_file_location(
        "decide_under_test", HERE / "decide.py")
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["decide_under_test"] = mod  # dataclasses look the module up
    spec.loader.exec_module(mod)
    return mod


class MockSystemOne(BaseHTTPRequestHandler):
    """A conforming /v1/systemone server. Records the request, never the key."""
    last: dict = {}

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler name
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001 - a bad body is itself a finding
            body = {"_unparsable": raw[:200].decode("utf-8", "replace")}
        MockSystemOne.last = {
            "path": self.path,
            "body": body,
            "had_auth": bool(self.headers.get("Authorization")),
        }
        payload = {"answers": {"priority": {"answer": "urgent",
                                             "probability": 0.93}},
                   "model": "drex-max-v1.1"}
        data = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args) -> None:  # silence the server
        pass


@contextlib.contextmanager
def mock_server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), MockSystemOne)
    MockSystemOne.last = {}
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()


def run_script(script: str, args: list[str], env_extra: dict[str, str] | None = None,
               timeout: int = 60) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k not in ENV_VARS}
    if env_extra:
        env.update(env_extra)
    return subprocess.run([sys.executable, str(HERE / script), *args],
                          capture_output=True, text=True, timeout=timeout, env=env)


def main() -> int:
    decide = load_decide()
    DecisionClient = decide.DecisionClient
    Question = decide.Question
    DecisionUnavailable = decide.DecisionUnavailable

    print("(a) fail-closed with no key")
    with scrubbed_env():
        c = DecisionClient()
        check("no key: client disabled", not c.is_enabled())
        try:
            c.decide("state", [Question("q", "box")])
            check("no key: decide() raises DecisionUnavailable", False, "it returned")
        except DecisionUnavailable:
            check("no key: decide() raises DecisionUnavailable", True)
        check("no key: all four integrations return None",
              decide.verdict_for_tool("read_file", {"path": "/etc/passwd"}) is None
              and decide.triage("server is down") is None
              and decide.route_for_prompt("do it", ["cheap", "deep"]) is None
              and decide.should_wake("daily report") is None)

    print("(b) endpoint is configurable via env")
    with mock_server() as mock_base, scrubbed_env():
        c = DecisionClient(provider="drex", api_key="fake-key",
                           base=mock_base)  # explicit arg, pre-change path
        check("explicit base arg is honoured", c.base == mock_base, c.base)
    with mock_server() as mock_base:
        with scrubbed_env(NACE_API_KEY="fake-key", NACE_BASE_URL=mock_base):
            c = DecisionClient(provider="drex")
            check("NACE_BASE_URL overrides the Drex base",
                  c.base == mock_base, c.base)
            check("base_source reports env when the env var wins",
                  c.status().get("base_source") == "env",
                  str(c.status()))
        with scrubbed_env(NACE_API_KEY="fake-key"):
            c = DecisionClient(provider="drex")
            check("without env: Drex base is the NACE default",
                  c.base == "https://console.nace.ai", c.base)
        with scrubbed_env(NACE_API_KEY="fake-key", NACE_BASE_URL=mock_base):
            c = DecisionClient(provider="drex", base="https://console.nace.ai")
            check("explicit base arg wins over NACE_BASE_URL",
                  c.base == "https://console.nace.ai", c.base)
        with scrubbed_env(TYPESAFE_API_KEY="fake-key", NACE_BASE_URL=mock_base):
            c = DecisionClient(provider="jev")
            check("NACE_BASE_URL does NOT retarget Jev (no cross-provider leak)",
                  c.base == "https://api.typesafe.ai", c.base)
        with scrubbed_env(TYPESAFE_API_KEY="fake-key",
                          TYPESAFE_BASE_URL=mock_base):
            c = DecisionClient(provider="jev")
            check("TYPESAFE_BASE_URL retargets Jev",
                  c.base == mock_base, c.base)
        with scrubbed_env(NACE_API_KEY="fake-key",
                          NACE_BASE_URL="http://example.com"):
            c = DecisionClient(provider="drex")
            check("non-loopback http base is rejected (fail-closed, not silent)",
                  not c.is_enabled()
                  and "base" in (c.status().get("reason") or "").lower(),
                  str(c.status()))

    print("(c) mock /v1/systemone round trip proves the wire format")
    with mock_server() as mock_base:
        with scrubbed_env(NACE_API_KEY="fake-key", NACE_BASE_URL=mock_base):
            c = DecisionClient(provider="drex", timeout=5)
            v = c.decide_or_none(
                "A user reports the production server is down.",
                [Question("priority", "choice",
                          options=["urgent", "routine", "ignore"])])
            check("mock: typed answer + probability come back",
                  v is not None and v.answers.get("priority") == "urgent"
                  and v.confidence == 0.93,
                  str(v.answers if v else None))
            last = MockSystemOne.last
            check("mock: POST /v1/systemone with model drex-max-v1.1",
                  last.get("path") == "/v1/systemone"
                  and last.get("body", {}).get("model") == "drex-max-v1.1"
                  and last.get("had_auth") is True,
                  str(last))

    print("(d) decision_model slot fragment")
    frag_path = HERE / "decision_model_drex.json"
    try:
        frag = json.loads(frag_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - the failure IS the check
        frag = {}
        check("fragment is valid JSON", False, f"{type(exc).__name__}: {exc}")
    if frag:
        slot = frag.get("agent_json", {}).get("decision_model", {})
        check("fragment: slot is {provider_id: nace, model: drex-max-v1.1}",
              slot == {"provider_id": "nace", "model": "drex-max-v1.1"},
              str(slot))
        ep = frag.get("endpoint", {})
        blob = json.dumps(frag)
        check("fragment: endpoint is NACE /v1/systemone, no key value, no chat endpoint",
              ep.get("base_url") == "https://console.nace.ai"
              and ep.get("path") == "/v1/systemone"
              and ep.get("key_env") == "NACE_API_KEY"
              and "chat" not in ep.get("base_url", "") + ep.get("path", "")
              # the env-var NAME may appear as key_env and in the note
              # (both name the var, neither holds a value); a key VALUE
              # must never appear. The note deliberately names
              # /v1/chat/completions as the thing NOT to use.
              and blob.count("NACE_API_KEY") == 2
              and "sk-" not in blob,
              str(ep))

    print("(e) live-test script")
    r = run_script("test_drex_live.py", [])
    check("live-test without a key: exit 2, 'blocked on NACE key'",
          r.returncode == 2 and "blocked on NACE key" in (r.stdout + r.stderr),
          f"exit={r.returncode} out={r.stdout[:200]!r} err={r.stderr[:200]!r}")
    with mock_server() as mock_base:
        r = run_script("test_drex_live.py", [],
                       env_extra={"NACE_API_KEY": "fake-test-key",
                                  "NACE_BASE_URL": mock_base,
                                  "DREX_LIVE_TIMEOUT_S": "10"})
        out = r.stdout + r.stderr
        check("live-test with a fake key against the mock: exit 0, 'transport OK'",
              r.returncode == 0 and "transport OK" in out,
              f"exit={r.returncode} out={out[:300]!r}")
        check("live-test never prints the key",
              "fake-test-key" not in out, out[:300])

    print("(f) machine-apply script")
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        default_agent = td / "default-agent.json"
        qa_agent = td / "qa-agent.json"
        env_file = td / ".env"
        for p in (default_agent, qa_agent):
            p.write_text(json.dumps({"approval_level": "AUTO",
                                     "decision_model": None,
                                     "name": p.stem}, indent=2),
                         encoding="utf-8")
        env_file.write_text("OTHER=1\n", encoding="utf-8")
        args = ["--default-agent", str(default_agent),
                "--qa-agent", str(qa_agent), "--env-file", str(env_file)]
        r = run_script("apply_decision_model_drex.py", args)
        check("apply dry-run (default): exit 0, files unchanged, fragment named",
              r.returncode == 0
              and json.loads(default_agent.read_text())["decision_model"] is None
              and "drex-max-v1.1" in r.stdout,
              f"exit={r.returncode} out={r.stdout[:300]!r}")
        r = run_script("apply_decision_model_drex.py", [*args, "--apply"])
        check("apply without a key: exit 2, 'blocked on NACE key', files unchanged",
              r.returncode == 2
              and "blocked on NACE key" in (r.stdout + r.stderr)
              and json.loads(default_agent.read_text())["decision_model"] is None,
              f"exit={r.returncode} out={r.stdout[:300]!r}")
        env_file.write_text("OTHER=1\nNACE_API_KEY=fake-test-key\n",
                            encoding="utf-8")
        r = run_script("apply_decision_model_drex.py", [*args, "--apply"])
        after_default = json.loads(default_agent.read_text())
        after_qa = json.loads(qa_agent.read_text())
        backups = list(td.glob("*.bak-*"))
        env_after = env_file.read_text(encoding="utf-8")
        check("apply with a key: slot set on both agents, approval_level untouched,"
              " backups made, NACE_BASE_URL added to .env",
              r.returncode == 0
              and after_default["decision_model"]
              == {"provider_id": "nace", "model": "drex-max-v1.1"}
              and after_qa["decision_model"]
              == {"provider_id": "nace", "model": "drex-max-v1.1"}
              and after_default["approval_level"] == "AUTO"
              and after_qa["approval_level"] == "AUTO"
              and len(backups) == 2
              and "NACE_BASE_URL=https://console.nace.ai" in env_after
              and env_after.count("NACE_API_KEY=") == 1,
              f"exit={r.returncode} out={r.stdout[:300]!r}")

    passed = sum(1 for _, ok, _ in CHECKS if ok)
    failed = len(CHECKS) - passed
    print()
    print(f"{passed} passed, {failed} failed")
    if failed:
        print("failed: " + ", ".join(n for n, ok, _ in CHECKS if not ok))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
