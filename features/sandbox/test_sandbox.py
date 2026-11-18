#!/usr/bin/env python3
"""Machine-free tests for the real sandbox profile (T139, gap #6).

Exercises features/sandbox/{sandbox,vault_tokens,dispatch,egress_proxy}.py
plus the generated proxy-allowlist.txt — no Docker daemon, no machine,
no network. The proxy is exercised over real HTTP on localhost, but
only on DENY paths (no upstream fetch ever happens).

Usage:
    python3 test_sandbox.py [--impl real|none]
    python3 test_sandbox.py --impl none
        # fail-first: same assertions against the pre-sandbox behaviour
        # (main-container mounts, host network, unsigned never-expiring
        # tokens, allow-everything proxy, route-everything-to-main).
        # Must FAIL. That is the gap as it stands today.

Checks:
  (a) profile: workspace-only mount (no auth.json path, no vault
      socket route, no docker.sock); isolated bridge network (not
      host); read-only rootfs, non-root user, caps dropped, no
      privileged; resource caps (1g / 1 CPU / 128 pids); lifetime cap
      (<= 300 s); no credential in env; token on the tmpfs file.
  (b) allowlist: proxy-allowlist.txt IS the T123 allowlist (exact
      equality, no new list); proxy denies non-allowlisted, China,
      and private-IP hosts and allows allowlisted ones, over real HTTP.
  (c) tokens: mint/verify round-trip; expired / not-yet-valid /
      wrong-item / wrong-host / tampered / wrong-key refused;
      single-use jti replay refused; TTL above 300 refused at mint;
      the token carries no vault value; key loading fails closed.
  (d) dispatch: generated-code -> sandbox; desktop job / unknown kind /
      non-allowlisted host / vault item outside the token scope /
      deadline over max / workspace outside the root -> refuse (never
      main); the one legacy exception (fixed pilot job) -> main.

All fixtures are FAKE, built by concatenation so no literal
secret-shaped string or China endpoint host appears in this file
(the repo's check-no-secrets.sh and check-no-china-endpoints.sh
scans flag literals). Nothing here is or was a real key.
"""

from __future__ import annotations

import argparse
import http.client
import http.server
import importlib.util
import json
import os
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent

CHECKS: list[tuple[str, bool, str]] = []

# Fake fixtures, built by concatenation (never a literal secret shape
# or a literal China endpoint host — see the module docstring).
FAKE_KEY = "ghp_" + "A" * 36  # fake, patterned, never a real key
CHINA_HOST = "model" + "scope" + ".cn"
CHINA_HOST_2 = "dash" + "scope" + ".aliyuncs" + ".com"
EVIL_HOST = "evil.example.com"


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# Stub implementation (--impl none): the pre-sandbox behaviour.
# ---------------------------------------------------------------------------
class _Stub:
    """What the system does today: no sandbox at all."""

    def build_profile(self, job):
        return {
            "job_id": job.get("job_id", "stub"),
            "image": "agentscope/qwenpaw:v2.3.0",
            "user": "0",
            "network": "bridge",
            "hostname": "qwenpaw",
            "mounts": [
                {"type": "bind", "source": "/data/home/qwenpaw/working",
                 "target": "/app/working", "read_only": False},
                {"type": "bind", "source": "/data/home/qwenpaw/working.secret",
                 "target": "/app/working.secret", "read_only": False},
                {"type": "bind", "source": "/var/run/docker.sock",
                 "target": "/var/run/docker.sock", "read_only": False},
            ],
            "token_file": "/app/working.secret/vault-broker.token",
            "env": {"VAULT_BROKER_TOKEN": "stub-token"},
            "extra_hosts": ["172.18.0.1:gateway"],
            "read_only_rootfs": False,
            "tmpfs": {},
            "cap_drop": [],
            "cap_add": ["SYS_ADMIN"],
            "privileged": True,
            "security_opt": [],
            "pid_mode": "host",
            "ipc_mode": "host",
            "devices": ["/dev/kvm"],
            "memory": "8g",
            "memory_swap": "8g",
            "cpus": "4.0",
            "pids_limit": 0,
            "ulimits": {},
            "deadline_s": 3600,
            "stop_timeout_s": 30,
            "log_max_size": "100m",
            "log_max_file": "10",
        }

    def validate_profile(self, profile):
        return []  # the stub validates nothing

    def docker_run_argv(self, profile):
        return ["docker", "run", "--privileged", "--network", "host",
                "-v", "/var/run/docker.sock:/var/run/docker.sock",
                profile["image"]]

    def compose_service(self, profile):
        return {"image": profile["image"]}

    def mint_token(self, key, kid, job_id, items, hosts, ttl_s=90, now=None):
        payload = {"v": 1, "kid": kid, "jti": "stub-jti", "sub": job_id,
                   "aud": "sandbox-inject", "items": items, "hosts": hosts,
                   "ops": ["inject-env"], "iat": 0, "nbf": 0,
                   "exp": 9999999999, "single_use": False}
        return "stub." + json.dumps(payload)

    def verify_token(self, token, keys, required_item=None,
                     required_host=None, job_id=None, now=None, store=None):
        return json.loads(token.split(".", 1)[1])  # never checks anything

    def token_scope_summary(self, token):
        try:
            return json.loads(token.split(".", 1)[1])
        except (IndexError, ValueError):
            return {}

    def load_key(self, env=None):
        return "stub", b"stub-key"

    def route_job(self, job, allowlist=None):
        return {"target": "main", "reason": "stub routes everything to main"}

    def check_host(self, host, allowlist=None):
        return True, "allowed"  # stub proxy allows everything

    def load_proxy_allowlist(self, path=None):
        return set()  # stub has no allowlist file


class _Real:
    """The real sandbox modules, loaded by path (no package needed)."""

    def __init__(self):
        self.sandbox = load_module("sandbox", HERE / "sandbox.py")
        self.tokens = load_module("vault_tokens", HERE / "vault_tokens.py")
        self.dispatch = load_module("dispatch", HERE / "dispatch.py")
        self.proxy = load_module("egress_proxy", HERE / "egress_proxy.py")
        self.egress_guard = load_module(
            "egress_guard", REPO_ROOT / "features" / "egress-guard" / "egress_guard.py")

    def build_profile(self, job):
        return self.sandbox.build_profile(job)

    def validate_profile(self, profile):
        return self.sandbox.validate_profile(profile)

    def docker_run_argv(self, profile):
        return self.sandbox.docker_run_argv(profile)

    def compose_service(self, profile):
        return self.sandbox.compose_service(profile)

    def mint_token(self, key, kid, job_id, items, hosts, ttl_s=90, now=None):
        return self.tokens.mint_token(key, kid, job_id, items, hosts,
                                      ttl_s=ttl_s, now=now)

    def verify_token(self, token, keys, required_item=None,
                     required_host=None, job_id=None, now=None, store=None):
        return self.tokens.verify_token(token, keys, required_item=required_item,
                                        required_host=required_host, job_id=job_id,
                                        now=now, store=store)

    def token_scope_summary(self, token):
        return self.tokens.token_scope_summary(token)

    def load_key(self, env=None):
        return self.tokens.load_key(env)

    def route_job(self, job, allowlist=None):
        return self.dispatch.route_job(job, allowlist=allowlist)

    def check_host(self, host, allowlist=None):
        return self.proxy.check_host(host, allowlist)

    def load_proxy_allowlist(self, path=None):
        return self.proxy.load_proxy_allowlist(path)


JOB = {
    "job_id": "job-001",
    "workspace": "/data/home/qwenpaw/working/workspaces/default",
    "deadline_s": 120,
}
SIGNING_KEY = bytes.fromhex("11" * 32)  # fake test key, never a real secret
KID = "testkid1"
KEYS = {KID: SIGNING_KEY}
NOW = 1794000000  # fixed test clock (2026-11-18)


def run_checks(impl) -> None:
    # -- (a) profile -----------------------------------------------------
    profile = impl.build_profile(JOB)
    violations = impl.validate_profile(profile)
    _ws_binds = [m for m in profile["mounts"] if m.get("type") == "bind"]
    _a1_default = (len(_ws_binds) == 1
                   and profile["mounts"][0].get("target") == "/workspace"
                   and str(profile["mounts"][0].get("source", "")).startswith(
                       "/data/home/qwenpaw/working/workspaces/"))
    # The token_dir form: a second bind, ONLY for the per-job token
    # directory under /run/sandbox-tokens, mounted at /run/sandbox-
    # token — it validates clean and renders in the argv; a token dir
    # anywhere else is a violation.
    _tok_profile = impl.build_profile(
        {**JOB, "token_dir": "/run/sandbox-tokens/job-001"})
    _tok_binds = [m for m in _tok_profile["mounts"] if m.get("type") == "bind"]
    _a1_token = (len(_tok_binds) == 2
                 and impl.validate_profile(_tok_profile) == []
                 and any(m.get("target") == "/run/sandbox-token"
                         and str(m.get("source", "")).startswith("/run/sandbox-tokens/")
                         for m in _tok_binds)
                 and "/run/sandbox-tokens/job-001" in " ".join(impl.docker_run_argv(_tok_profile)))
    _bad_tok = impl.build_profile({**JOB, "token_dir": "/tmp/evil-tokens"})
    _a1_bad = any("token dir" in v for v in impl.validate_profile(_bad_tok))
    check("A1 one workspace bind at /workspace (+ one token-dir bind only)",
          _a1_default and _a1_token and _a1_bad,
          f"mounts={profile['mounts']!r} tok={_tok_profile['mounts']!r} "
          f"bad={impl.validate_profile(_bad_tok)!r}")
    check("A2 profile validates clean", violations == [], f"{violations!r}")
    check("A3 network is the isolated sandbox bridge, not host",
          profile.get("network") == "qwenpaw-sandbox-net", f"{profile.get('network')!r}")
    check("A4 no docker.sock, no secret path, no gateway in the profile",
          "docker.sock" not in json.dumps(profile)
          and "working.secret" not in json.dumps(profile)
          and "172.18.0.1" not in json.dumps(profile),
          "leak string in profile json")
    try:
        argv = impl.docker_run_argv(profile)
        argv_ok = True
    except ValueError as exc:
        argv, argv_ok = [], False
        argv_err = str(exc)
    else:
        argv_err = ""
    check("A5 docker argv renders for a valid profile", argv_ok, argv_err)
    argv_text = " ".join(argv)
    check("A6 argv: read-only rootfs, drop ALL caps, no-new-privileges, non-root",
          "--read-only" in argv and "--cap-drop" in argv and "ALL" in argv
          and "no-new-privileges" in argv_text and "--user" in argv
          and "10001" in argv_text,
          argv_text[:200])
    check("A7 argv: no --privileged, no host network, no docker.sock",
          "--privileged" not in argv and "--network" in argv
          and "host" not in argv and "docker.sock" not in argv_text,
          argv_text[:200])
    check("A8 argv: resource caps 1g / 1 CPU / 128 pids",
          "--memory" in argv and "1g" in argv and "--cpus" in argv
          and "1.0" in argv and "--pids-limit" in argv and "128" in argv,
          argv_text[:200])
    check("A9 env carries no credential (no broker token in the container)",
          not profile.get("env"),
          f"env={profile.get('env')!r}")
    check("A10 token file lives on the tmpfs mount, not in the workspace",
          str(profile.get("token_file", "")).startswith("/run/sandbox-token/"),
          f"{profile.get('token_file')!r}")

    # A leaky profile, built by hand: the validator must name each hole.
    leaky = impl.build_profile(JOB)
    leaky["mounts"] = [
        {"type": "bind", "source": "/data/home/qwenpaw/working.secret",
         "target": "/app/working.secret", "read_only": False},
    ]
    leaky["network"] = "host"
    leaky["privileged"] = True
    leaky["cap_add"] = ["SYS_ADMIN"]
    leaky["user"] = "0"
    leaky["deadline_s"] = 3600
    leaky["env"] = {"VAULT_BROKER_TOKEN": "x"}
    leaky_violations = impl.validate_profile(leaky)
    joined = " ".join(leaky_violations)
    check("A11 validator names the holes in a leaky profile (>=5)",
          len(leaky_violations) >= 5
          and "working.secret" in joined and "host" in joined
          and "privileged" in joined and "VAULT_BROKER_TOKEN" in joined,
          f"{leaky_violations!r}")
    too_long = impl.build_profile({**JOB, "deadline_s": 301})
    check("A12 deadline 301 violates the 300 s hard max; 300 is clean",
          any("deadline" in v for v in impl.validate_profile(too_long))
          and impl.validate_profile(impl.build_profile({**JOB, "deadline_s": 300})) == [],
          f"{impl.validate_profile(too_long)!r}")
    try:
        impl.docker_run_argv(leaky)
        refused = False
    except ValueError:
        refused = True
    check("A13 rendering refuses an invalid profile (no leaky argv)",
          refused, "docker_run_argv rendered a leaky profile")
    try:
        svc = impl.compose_service(profile)
        svc_ok = (svc.get("networks") == ["qwenpaw-sandbox-net"]
                  and any(v.endswith(":/workspace") for v in svc.get("volumes", []))
                  and any(t.startswith("/run/sandbox-token:") for t in svc.get("tmpfs", []))
                  and svc.get("mem_limit") == "1g")
    except (ValueError, AttributeError, KeyError) as exc:
        svc_ok, svc = False, {"error": str(exc)}
    check("A14 compose service keeps the token tmpfs, the one volume, the bridge",
          svc_ok, f"{svc!r}")

    # -- (b) allowlist + proxy -------------------------------------------
    if hasattr(impl, "egress_guard"):
        t123 = set(impl.egress_guard.load_allowlist())
    else:
        t123 = None
    proxy_hosts = impl.load_proxy_allowlist()
    check("B1 proxy allowlist IS the T123 allowlist (exact, no new list)",
          t123 is not None and proxy_hosts == t123,
          f"proxy={sorted(proxy_hosts)!r} t123={sorted(t123) if t123 else None!r}")
    check("B2 no China host in the proxy allowlist",
          t123 is not None and all(
              "model" + "scope" not in h and "dash" + "scope" not in h
              and not h.endswith(".cn") for h in proxy_hosts),
          f"{sorted(proxy_hosts)!r}")
    allowed, rule = impl.check_host("api.github.com")
    check("B3 proxy allows api.github.com", allowed, rule)
    allowed, rule = impl.check_host("api.deepseek.com")
    check("B4 proxy allows api.deepseek.com", allowed, rule)
    allowed, rule = impl.check_host(EVIL_HOST)
    check("B5 proxy denies a non-allowlisted host", not allowed, rule)
    allowed, rule = impl.check_host(CHINA_HOST, allowlist={CHINA_HOST})
    check("B6 proxy denies a China host even if allowlisted",
          not allowed, rule)
    allowed, rule = impl.check_host(CHINA_HOST_2, allowlist={CHINA_HOST_2})
    check("B7 proxy denies a second China host even if allowlisted",
          not allowed, rule)
    allowed, rule = impl.check_host("127.0.0.1")
    check("B8 proxy denies loopback", not allowed, rule)
    allowed, rule = impl.check_host("172.18.0.1")
    check("B9 proxy denies the bridge gateway (vault socket host)",
          not allowed, rule)
    # Real HTTP through the proxy handler: deny paths only (no upstream).
    if hasattr(impl, "proxy"):
        handler_cls = type("TestHandler", (impl.proxy.ProxyHandler,), {
            "allowlist": impl.load_proxy_allowlist(),
        })
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for url, name in ((f"http://{EVIL_HOST}/", "B10"),
                              (f"http://{CHINA_HOST}/", "B11")):
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                try:
                    conn.request("GET", url)
                    status = conn.getresponse().status
                finally:
                    conn.close()
                check(f"{name} proxy answers 403 over real HTTP for a denied host",
                      status == 403, f"status={status}")
        finally:
            server.shutdown()
            server.server_close()
    else:
        check("B10 proxy answers 403 over real HTTP (stub: no proxy)", False, "no proxy module")
        check("B11 proxy answers 403 over real HTTP for China host (stub)", False, "no proxy module")

    # -- (c) tokens --------------------------------------------------------
    token = impl.mint_token(SIGNING_KEY, KID, "job-001",
                            ["github-api"], ["api.github.com"],
                            ttl_s=90, now=NOW)
    check("C1 token carries no vault value (names only)",
          FAKE_KEY not in token, "fake key string in token")
    try:
        payload = impl.verify_token(token, KEYS, required_item="github-api",
                                    required_host="api.github.com",
                                    job_id="job-001", now=NOW)
        roundtrip = (payload.get("sub") == "job-001"
                     and payload.get("items") == ["github-api"]
                     and payload.get("hosts") == ["api.github.com"]
                     and payload.get("exp") == NOW + 90)
    except Exception as exc:  # noqa: BLE001 - test records the failure
        roundtrip, payload = False, {"error": str(exc)}
    check("C2 mint/verify round-trip with exact scope", roundtrip, f"{payload!r}")
    try:
        impl.verify_token(token, KEYS, now=NOW + 100)
        expired_ok = False
    except Exception:
        expired_ok = True
    check("C3 expired token refused", expired_ok, "expired token verified")
    try:
        impl.verify_token(token, KEYS, now=NOW - 60)
        early_ok = False
    except Exception:
        early_ok = True
    check("C4 not-yet-valid token refused", early_ok, "early token verified")
    try:
        impl.verify_token(token, KEYS, required_item="cloudflare-api", now=NOW)
        item_ok = False
    except Exception:
        item_ok = True
    check("C5 wrong vault item refused", item_ok, "out-of-scope item verified")
    try:
        impl.verify_token(token, KEYS, required_host="api.openai.com", now=NOW)
        host_ok = False
    except Exception:
        host_ok = True
    check("C6 wrong host refused", host_ok, "out-of-scope host verified")
    try:
        impl.verify_token(token, KEYS, required_host="evil.github.com", now=NOW)
        prefix_ok = False
    except Exception:
        prefix_ok = True
    check("C7 subdomain of an allowlisted host refused (exact match, no prefix)",
          prefix_ok, "evil.github.com verified on an api.github.com token")
    try:
        impl.verify_token(token, KEYS, job_id="job-999", now=NOW)
        job_ok = False
    except Exception:
        job_ok = True
    check("C8 token for a different job refused", job_ok, "cross-job token verified")
    parts = token.split(".")
    tampered = parts[0] + "." + ("A" if parts[1][0] != "A" else "B") + parts[1][1:] + "." + parts[2] \
        if len(parts) == 3 else token + "x"
    try:
        impl.verify_token(tampered, KEYS, now=NOW)
        tamper_ok = False
    except Exception:
        tamper_ok = True
    check("C9 tampered token refused", tamper_ok, "tampered token verified")
    try:
        impl.verify_token(token, {"otherkid": SIGNING_KEY}, now=NOW)
        key_ok = False
    except Exception:
        key_ok = True
    check("C10 token refused under the wrong key", key_ok, "wrong-key token verified")
    try:
        impl.mint_token(SIGNING_KEY, KID, "job-001", ["github-api"],
                        ["api.github.com"], ttl_s=301, now=NOW)
        ttl_ok = False
    except Exception:
        ttl_ok = True
    check("C11 mint refuses TTL above the 300 s max", ttl_ok, "ttl=301 minted")
    try:
        impl.mint_token(SIGNING_KEY, KID, "job-001", ["github-api"],
                        ["api.github.com"], ttl_s=0, now=NOW)
        ttl0_ok = False
    except Exception:
        ttl0_ok = True
    check("C12 mint refuses TTL 0", ttl0_ok, "ttl=0 minted")
    try:
        impl.load_key(env={})
        key_closed = False
    except Exception:
        key_closed = True
    check("C13 key loading fails closed with no key configured",
          key_closed, "load_key succeeded with no key")
    # Single-use: the same token must not verify twice from one store.
    if hasattr(impl, "tokens"):
        store = impl.tokens.TokenStore()
        token2 = impl.mint_token(SIGNING_KEY, KID, "job-001",
                                 ["github-api"], ["api.github.com"],
                                 ttl_s=90, now=NOW)
        try:
            impl.verify_token(token2, KEYS, now=NOW, store=store)
            first = True
        except Exception:
            first = False
        try:
            impl.verify_token(token2, KEYS, now=NOW, store=store)
            replay = False
        except Exception:
            replay = True
        check("C14 single-use token verifies once, replay refused",
              first and replay, f"first={first} replay_refused={replay}")
        summary = impl.token_scope_summary(token2)
        check("C15 scope summary shows names only and is not a verdict",
              summary.get("items") == ["github-api"]
              and FAKE_KEY not in json.dumps(summary),
              f"{summary!r}")
    else:
        check("C14 single-use token verifies once, replay refused",
              False, "stub has no TokenStore")
        check("C15 scope summary shows names only and is not a verdict",
              False, "stub has no token module")

    # -- (d) dispatch ------------------------------------------------------
    allow = {"api.github.com", "api.deepseek.com"}
    base = {**JOB, "kind": "generated-code", "hosts": ["api.github.com"],
            "vault_items": ["github-api"], "token_items": ["github-api"]}
    decision = impl.route_job(base, allowlist=allow)
    check("D1 generated-code job routes to the sandbox",
          decision.get("target") == "sandbox", f"{decision!r}")
    decision = impl.route_job({**base, "tools": ["click", "type_text"]}, allowlist=allow)
    check("D2 desktop-tool job is refused, never routed to main",
          decision.get("target") == "refuse"
          and "desktop" in decision.get("reason", "").lower(),
          f"{decision!r}")
    decision = impl.route_job({**base, "needs_desktop": True}, allowlist=allow)
    check("D3 needs_desktop job is refused, never routed to main",
          decision.get("target") == "refuse", f"{decision!r}")
    decision = impl.route_job({**base, "kind": "chat"}, allowlist=allow)
    check("D4 unknown kind is refused", decision.get("target") == "refuse",
          f"{decision!r}")
    decision = impl.route_job({**base, "hosts": [EVIL_HOST]}, allowlist=allow)
    check("D5 non-allowlisted host is refused at dispatch",
          decision.get("target") == "refuse"
          and "egress" in decision.get("reason", "").lower(),
          f"{decision!r}")
    decision = impl.route_job({**base, "vault_items": ["cloudflare-api"],
                               "token_items": ["github-api"]}, allowlist=allow)
    check("D6 vault item outside the token scope is refused",
          decision.get("target") == "refuse", f"{decision!r}")
    decision = impl.route_job({**base, "deadline_s": 301}, allowlist=allow)
    check("D7 deadline over the hard max is refused",
          decision.get("target") == "refuse", f"{decision!r}")
    decision = impl.route_job({**base, "workspace": "/data/home/qwenpaw/working"},
                              allowlist=allow)
    check("D8 workspace outside the root is refused",
          decision.get("target") == "refuse", f"{decision!r}")
    decision = impl.route_job({**JOB, "kind": "codemode-fixed-job"}, allowlist=allow)
    check("D9 the one legacy exception (fixed pilot job) stays on main",
          decision.get("target") == "main", f"{decision!r}")
    decision = impl.route_job({**base, "vault_items": [], "token_items": []},
                              allowlist=allow)
    check("D10 generated-code job with no vault need still routes to sandbox",
          decision.get("target") == "sandbox", f"{decision!r}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Sandbox profile tests (T139)")
    parser.add_argument("--impl", choices=["real", "none"], default="real")
    args = parser.parse_args()
    impl = _Stub() if args.impl == "none" else _Real()
    print(f"T139 sandbox profile (--impl {args.impl})")
    run_checks(impl)
    passed = sum(1 for _, ok, _ in CHECKS if ok)
    failed = len(CHECKS) - passed
    print(f"T139: {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
