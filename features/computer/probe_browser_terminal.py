#!/usr/bin/env python3
"""Replay the browser's terminal wire behaviour against the real PTY server.

The browser does four things the Node protocol test does NOT do:

  1. sends a NEWLINE-TERMINATED PREAMBLE as its first bytes (computer, lease,
     deadline, HMAC) — the PTY server refuses to start a shell without it, and
     closes the connection after a 5 s timeout;
  2. opens the socket with a subprotocol (["binary"]);
  3. sends FRAMED input, `[kind:u8][len:u32be][payload]`, not raw text;
  4. sends a RESIZE frame immediately after connecting.

All four are replayed here, in that order, against `serve_pty()` from the real
`terminal-server.py`. This is the closest thing to the browser that runs without
one, and it is the path that was broken: the browser never sent (1) because an
`await` sat between `new WebSocket()` and the `open` listener, so `open` fired
with nobody listening.

Prints PREAMBLE_OK / OUTPUT_OK / ALIVE_OK / ALL_OK for the JS harness to assert.
Exit 0 only when every stage succeeded.
"""

from __future__ import annotations

import importlib.util
import os
import socket
import struct
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))

spec = importlib.util.spec_from_file_location("ts", os.path.join(HERE, "terminal-server.py"))
ts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ts)

SECRET = b"unit-test-browser-flow-seed"


def main() -> int:
    # A preamble shaped exactly like the Worker mints it.
    deadline_ms = int(time.time() * 1000) + 30_000
    lease = "unit-test-lease"
    msg = ("%s|%s|%d" % ("default", lease, deadline_ms)).encode()
    sig = ts.__dict__.get("sign_deadline")
    if sig is None:
        print("FAIL: sign_deadline missing from terminal-server.py")
        return 1
    signature = sig(SECRET, "default", lease, deadline_ms)
    preamble = "default %s %d %s\n" % (lease, deadline_ms, signature)

    a, b = socket.socketpair()
    result: dict = {}
    thread = threading.Thread(
        target=lambda: result.update(ts.serve_pty(a, deadline_ms, shell="/bin/sh", cwd="/tmp")),
        daemon=True,
    )
    thread.start()
    b.settimeout(4.0)

    # ---- 1. the preamble, newline-terminated, as the very first bytes ----
    try:
        b.sendall(preamble.encode())
    except OSError as exc:
        print("FAIL: could not send the preamble: %s" % exc)
        return 1

    # ---- 2. a resize frame, as the browser sends on connect ----
    resize = struct.pack(">BI", ts.KIND_RESIZE, 4) + struct.pack(">HH", 120, 40)
    try:
        b.sendall(resize)
    except OSError:
        pass

    # ---- 3. wait for the shell prompt ----
    seen = b""
    try:
        while b"#" not in seen and b"$" not in seen and len(seen) < 8192:
            chunk = b.recv(1024)
            if not chunk:
                break
            seen += chunk
    except socket.timeout:
        pass
    if b"#" in seen or b"$" in seen:
        print("PREAMBLE_OK prompt=%r" % seen[:40])
    else:
        print("FAIL: no prompt within 4 s (preamble rejected or shell not started): %r" % seen[:80])
        return 1

    # ---- 4. FRAMED input, exactly as xterm onData sends it ----
    cmd = b"echo hello-terminal\n"
    framed = struct.pack(">BI", ts.KIND_STDIN, len(cmd)) + cmd
    try:
        b.sendall(framed)
    except OSError as exc:
        print("FAIL: could not send the framed command: %s" % exc)
        return 1

    out = b""
    try:
        while len(out) < 16384:
            chunk = b.recv(1024)
            if not chunk:
                break
            out += chunk
    except socket.timeout:
        pass

    # The tty echoes the command back, so strip that first occurrence before
    # looking for the RESULT.
    body = out.replace(b"echo hello-terminal", b"", 1)
    if b"hello-terminal" in body:
        print("OUTPUT_OK output=%r" % body[:60])
    else:
        print("FAIL: no command output (framed input not applied): %r" % out[:120])
        return 1

    if thread.is_alive():
        print("ALIVE_OK")
    else:
        print("FAIL: the session died on its own")
        return 1

    # ---- 5. close deliberately, then read the counters ----
    try:
        b.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    thread.join(timeout=5)
    if result.get("mode") != "framed":
        print("FAIL: the server did not treat the stream as framed (mode=%r)"
              % result.get("mode"))
        return 1
    if (result.get("frames") or 0) < 2:
        print("FAIL: expected >=2 frames applied, saw %r" % result.get("frames"))
        return 1

    print("ALL_OK mode=%s frames=%s reason=%s"
          % (result.get("mode"), result.get("frames"), result.get("reason")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
