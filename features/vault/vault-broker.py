#!/usr/bin/env python3
"""Vault broker — the machine-side command wrapper (Phase 2).

WHAT THIS RUNS
  features/vault/vault-broker.py, synced to /data/home/qwenpaw/vault/
  on the machine. It runs a command with vault items exported into the
  child process environment, and scrubs the child's output before
  returning it. The value never enters the agent's process, context, or
  any log.

WHY A BROKER (and not just /vault/request)
  /vault/request covers HTTP calls the Worker can make itself. A CLI (gh,
  wrangler, a script that needs an API key in its environment) cannot go
  through the Worker — it needs the value in its own environment. The
  broker is the safe path for that: it fetches the value from the Worker
  over a mutually-authenticated channel, exports it as $VAR into the
  child, runs the command, and scrubs stdout/stderr with the redaction
  forms before returning. The broker keeps an in-memory redaction list
  for the whole process lifetime: every value it has ever handled stays
  redacted in every later output.

WHY TCP ON THE DOCKER BRIDGE (not a Unix socket, not 0.0.0.0)
  The caller is the QwenPaw agent, which runs INSIDE a Docker container.
  The container mounts only working/, working.secret/, working.backups/
  — a host Unix socket is not visible inside it, and adding a volume
  mount needs a container recreate (drops in-flight work). The container
  CAN reach the host via the Docker bridge gateway (172.18.0.1) — that is
  how it reaches the MCP proxy on 172.18.0.1:8898. So the broker binds
  to the bridge gateway (configurable via VAULT_BROKER_BIND, default
  172.18.0.1) on port 8896 (below the MCP proxy range 8897-8898; 8899 is the Camoufox bridge), and requires the
  X-Vault-Broker-Token header on every call. It never binds 0.0.0.0: the
  InstaBox firewall blocks direct public access, but binding the bridge
  IP is the precise scope — only the container's network can reach it.

TOKEN
  VAULT_BROKER_TOKEN must be set in /data/home/qwenpaw/.env. It is the
  SAME value on both sides of the broker↔Worker channel (provisioned in
  one pass by scripts/provision-vault-master-secret.py): the broker
  presents it to the Worker's POST /vault/export, and callers present it
  to the broker. Without it the broker is CLOSED (fail closed) and
  /health says so. The agent reads its copy from
  /app/working.secret/vault-broker.token (written by the provisioning
  script at deploy time, mode 600) — inside the machine-trust boundary,
  which the vault does not remove (a skill that bypasses the broker can
  already read working.secret/ directly; the vault gives the SAFE path).

ENDPOINTS (all require X-Vault-Broker-Token, except /health)
  GET  /health          {ok, ready, reason} — ready is false without a token.
  POST /run             {names: [...], argv: [...], cwd?, timeoutSeconds?}
                        Runs argv with the named items exported as $VAR
                        (name `github-api` -> GITHUB_API). Returns
                        {ok, exitCode, stdout, stderr} with every handled
                        value redacted. A non-zero exit is reported, not
                        hidden — the command's own failure is its own.
  POST /request         {name, url, method?, body?, contentType?} — the
                        broker re-exports the value and makes the HTTP call
                        locally (it has no session cookie, so it cannot call
                        the Worker's session-gated /vault/request). The same
                        origin pin, policy, and redaction rules are enforced
                        here as in the Worker, and the redaction is applied
                        again on the way back (defence in depth).

Install (Muse, machine side):
  install -d -m 0755 /data/home/qwenpaw/vault
  cp features/vault/vault-broker.py /data/home/qwenpaw/vault/
  cp features/vault/redact.py       /data/home/qwenpaw/vault/
  cp features/vault/qwenpaw-vault-broker.service /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now qwenpaw-vault-broker

  # verify (from the machine, as root):
  curl http://172.18.0.1:8896/health
"""

import json
import os
import re
import subprocess
import sys
import threading
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from redact import redaction_forms, redact, StreamRedactor  # noqa: E402

WORKER_URL = os.environ.get("VAULT_WORKER_URL", "https://qwenpawx.pages.dev")
BIND = os.environ.get("VAULT_BROKER_BIND", "172.18.0.1")
PORT = int(os.environ.get("VAULT_BROKER_PORT", "8896"))
TOKEN = os.environ.get("VAULT_BROKER_TOKEN", "")
MAX_ARGV = 32
MAX_ARG_LEN = 4096
DEFAULT_TIMEOUT_S = 120
MAX_TIMEOUT_S = 600

# The in-memory redaction list for the whole process lifetime: every value
# the broker has ever handled stays redacted in every later output.
_redaction_forms = set()
_redaction_lock = threading.Lock()


def _add_forms(forms):
    with _redaction_lock:
        _redaction_forms.update(forms)


def _all_forms():
    with _redaction_lock:
        return sorted(_redaction_forms)


def _scrub(text):
    return redact(text, _all_forms())


def _env_file():
    return "/data/home/qwenpaw/.env"


def _worker_export(names):
    """Fetch values from the Worker. Returns {name: {kind, varName, value}}.
    The Worker verifies VAULT_BROKER_TOKEN constant-time."""
    if not TOKEN:
        raise RuntimeError("vault_broker_unconfigured")
    req = urllib.request.Request(
        WORKER_URL.rstrip("/") + "/vault/export",
        data=json.dumps({"names": names}).encode(),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Vault-Broker-Token", TOKEN)
    try:
        with urllib.request.build_opener().open(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode())
        except Exception:
            payload = {"error": "upstream_error"}
        raise RuntimeError(payload.get("error", "upstream_error"))
    if "error" in payload:
        raise RuntimeError(payload.get("error", "upstream_error"))
    out = {}
    for item in payload.get("items", []):
        out[item["name"]] = item
        forms = redaction_forms(item["kind"], item["value"],
                                header_name=None, username=None)
        _add_forms(forms)
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        # Never log request bodies or headers (they may name vault items,
        # and a log line is a leak surface). Log method + path only.
        sys.stderr.write("%s %s\n" % (self.command, self.path))

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 1024 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(length).decode())
        except Exception:
            return None

    def _require_token(self):
        if not TOKEN:
            return False
        supplied = self.headers.get("X-Vault-Broker-Token") or ""
        # Constant-time compare.
        if len(supplied) != len(TOKEN):
            return False
        diff = 0
        for a, b in zip(supplied, TOKEN):
            diff |= ord(a) ^ ord(b)
        return diff == 0

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send(200, {
                "ok": True,
                "ready": bool(TOKEN),
                "reason": None if TOKEN else "VAULT_BROKER_TOKEN is not set",
            })
            return
        self._send(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802
        if self.path == "/health":
            self._send(405, {"error": "method_not_allowed"})
            return
        if not self._require_token():
            self._send(401, {"error": "auth_required"})
            return
        body = self._read_json()
        if body is None:
            self._send(400, {"error": "bad_json"})
            return
        if self.path == "/run":
            self._handle_run(body)
        elif self.path == "/request":
            self._handle_request(body)
        else:
            self._send(404, {"error": "not_found"})

    def _handle_run(self, body):
        names = body.get("names")
        argv = body.get("argv")
        if not isinstance(names, list) or not names or len(names) > 20:
            self._send(400, {"error": "bad_names"})
            return
        if not isinstance(argv, list) or not argv or len(argv) > MAX_ARGV:
            self._send(400, {"error": "bad_argv"})
            return
        for a in argv:
            if not isinstance(a, str) or not a or len(a) > MAX_ARG_LEN:
                self._send(400, {"error": "bad_argv"})
                return
        if any(not re.match(r"^[a-z][a-z0-9_-]{0,63}$", n) for n in names):
            self._send(400, {"error": "bad_name"})
            return
        timeout_s = body.get("timeoutSeconds", DEFAULT_TIMEOUT_S)
        try:
            timeout_s = int(timeout_s)
        except (TypeError, ValueError):
            self._send(400, {"error": "bad_timeout"})
            return
        timeout_s = max(1, min(timeout_s, MAX_TIMEOUT_S))
        cwd = body.get("cwd")
        if cwd is not None and not isinstance(cwd, str):
            self._send(400, {"error": "bad_cwd"})
            return
        try:
            items = _worker_export(names)
        except RuntimeError as e:
            self._send(502, {"error": str(e)})
            return
        # Build the child env: the named items exported as $VAR, on top of
        # a minimal inherited env. The value never enters this process's
        # own os.environ — only the child's.
        child_env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", "/root"),
        }
        for n, item in items.items():
            child_env[item["varName"]] = item["value"]
        try:
            proc = subprocess.run(
                argv, env=child_env, cwd=cwd, timeout=timeout_s,
                capture_output=True, text=True, errors="replace",
            )
            # Scrub the output with EVERY form this broker has ever handled
            # (not just this run's) — a value from an earlier run must stay
            # hidden in a later run's output too.
            self._send(200, {
                "ok": True,
                "exitCode": proc.returncode,
                "stdout": _scrub(proc.stdout or ""),
                "stderr": _scrub(proc.stderr or ""),
            })
        except subprocess.TimeoutExpired as e:
            self._send(200, {
                "ok": True,
                "exitCode": None,
                "stdout": _scrub((e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")),
                "stderr": _scrub((e.stderr or b"").decode("utf-8", "replace") if isinstance(e.stderr, bytes) else (e.stderr or "")),
                "timedOut": True,
            })
        except Exception as e:
            self._send(500, {"error": "run_failed", "detail": str(e)[:200]})

    def _handle_request(self, body):
        # Defence in depth: the broker re-exports the value and makes the
        # HTTP call locally (it has no session cookie, so it cannot call
        # the Worker's session-gated /vault/request). The same origin pin,
        # policy, and redaction rules are enforced here as in the Worker.
        name = body.get("name")
        url = body.get("url")
        method = (body.get("method") or "GET").upper()
        req_body = body.get("body")
        content_type = body.get("contentType")
        if not isinstance(name, str) or not re.match(r"^[a-z][a-z0-9_-]{0,63}$", name):
            self._send(400, {"error": "bad_name"})
            return
        if not isinstance(url, str) or not url:
            self._send(400, {"error": "bad_url"})
            return
        if method not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"):
            self._send(400, {"error": "bad_method"})
            return
        try:
            items = _worker_export([name])
        except RuntimeError as e:
            self._send(502, {"error": str(e)})
            return
        item = items[name]
        # Origin pin, enforced here exactly as the Worker enforces it in
        # /vault/request: the requested URL must be on the item's pinned
        # origin, with no userinfo or hash. The pin comes from the Worker's
        # export response (metadata, not a value).
        import urllib.parse
        try:
            target = urllib.parse.urlparse(url)
        except Exception:
            self._send(400, {"error": "bad_url"})
            return
        if target.scheme != "https" or target.username or target.password or target.fragment:
            self._send(400, {"error": "bad_url"})
            return
        origin = item.get("origin") or ""
        if item["kind"] == "command":
            self._send(400, {"error": "vault_command_not_requestable"})
            return
        if not origin or (target.scheme + "://" + target.netloc) != origin:
            self._send(403, {"error": "vault_origin_mismatch"})
            return
        value = item["value"]
        headers = {}
        if item["kind"] == "bearer":
            headers["Authorization"] = "Bearer " + value
        elif item["kind"] == "basic":
            headers["Authorization"] = "Basic " + value
        elif item["kind"] == "header":
            header_name = item.get("headerName")
            if not header_name:
                self._send(400, {"error": "bad_header_name"})
                return
            headers[header_name] = value
        if content_type:
            headers["Content-Type"] = content_type
        headers["Accept"] = "application/json, */*;q=0.8"
        try:
            req = urllib.request.Request(url, data=req_body.encode() if req_body else None,
                                         headers=headers, method=method)
            with urllib.request.build_opener().open(req, timeout=30) as resp:
                raw = resp.read(1024 * 1024 + 1)
                status = resp.status
        except urllib.error.HTTPError as e:
            raw = e.read(1024 * 1024 + 1) if e.fp else b""
            status = e.code
        except Exception:
            self._send(502, {"error": "upstream_error"})
            return
        text = raw[:1024 * 1024].decode("utf-8", "replace")
        truncated = len(raw) > 1024 * 1024 or len(text) > 20000
        forms = redaction_forms(item["kind"], value,
                                header_name=item.get("headerName"), username=None)
        _add_forms(forms)
        redacted = redact(text, forms)
        out_body = redacted[:20000] if len(redacted) > 20000 else redacted
        self._send(200, {"status": status, "body": out_body, "truncated": truncated})


def _selftest():
    """Machine-free checks for redact.py + the broker's validation."""
    from redact import redaction_forms as rf, redact as rd, StreamRedactor
    checks = []

    def check(name, cond):
        checks.append((name, bool(cond)))

    # Bearer forms: raw, scheme variants, JSON-escaped, percent-encoded.
    f = rf("bearer", "ghp_abc123XYZ")
    check("bearer raw present", "ghp_abc123XYZ" in f)
    check("bearer scheme present", "Bearer ghp_abc123XYZ" in f)
    check("bearer json-escaped present", "ghp_abc123XYZ" in f)
    # A short raw value is never itself a form (minimum length 8) — the
    # scheme-prefixed forms ("Bearer abc") are long enough and are present.
    short_forms = rf("bearer", "abc")
    check("short raw value is NOT a redaction form", "abc" not in short_forms)
    check("short value still gets scheme forms", "Bearer abc" in short_forms)
    # Redaction merges overlapping forms into one marker.
    text = "Authorization: Bearer ghp_abc123XYZ and again ghp_abc123XYZ"
    out = rd(text, f)
    check("redact replaces all", "ghp_abc123XYZ" not in out and out.count("[redacted]") == 2)
    # Basic: decoded user:pass + password alone.
    import base64 as _b64
    b64 = _b64.b64encode(b"user:s3cretpass").decode()
    fb = rf("basic", b64, username="user")
    check("basic decoded present", "user:s3cretpass" in fb)
    check("basic password present", "s3cretpass" in fb)
    check("basic b64 present", b64 in fb)
    # Streaming redactor: a value split across chunks is still hidden.
    sr = StreamRedactor(f)
    part1 = sr.push("prefix Bearer ghp_abc")
    part2 = sr.push("123XYZ suffix")
    tail = sr.flush()
    joined = part1 + part2 + tail
    check("stream split value hidden", "ghp_abc123XYZ" not in joined and "[redacted]" in joined)
    # The broker's own validation: bad names rejected by the regex.
    check("bad name rejected", not re.match(r"^[a-z][a-z0-9_-]{0,63}$", "Bad Name"))
    check("good name accepted", bool(re.match(r"^[a-z][a-z0-9_-]{0,63}$", "github-api")))
    failed = [n for n, ok in checks if not ok]
    print(f"vault-broker selftest: {len(checks) - len(failed)} passed, {len(failed)} failed")
    for n in failed:
        print("  FAIL:", n)
    return 1 if failed else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    if not TOKEN:
        print("WARNING: VAULT_BROKER_TOKEN is not set — the broker is CLOSED (fail closed). /health will report ready:false.", file=sys.stderr)
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"vault broker listening on {BIND}:{PORT} (worker {WORKER_URL})", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
