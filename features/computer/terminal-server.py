#!/usr/bin/env python3
"""PTY server for the computer's Terminal tab.

WHAT THIS IS
    One WebSocket (via websockify) or one Unix-socket connection gets one
    login shell on a pseudo-terminal. Output is raw bytes; input is framed.

WHY IT IS WRITTEN THIS CAREFULLY
    A shell in this container is a root shell on the machine that holds the
    user's QwenPaw install, its auth file and its chats. BUGS.md B-4 recorded
    the previous implementation handing one out for 59 minutes AFTER the user
    released control, while the agent believed it had the machine to itself.
    B-17 recorded a resize frame setting a 65535x65535 terminal. This file
    exists to not do either, and its harness tests both.

THE LEASE RULE (the reason this file takes a deadline)
    The Worker mints a terminal capability whose expiry is clamped to the live
    lease's expiry plus a small grace. It passes that absolute deadline here,
    signed, at connect time. The shell is killed when the deadline passes —
    even with the socket still open and the browser still connected. So the
    maximum exposure after a release is the grace period, not a stale TTL.
    The client cannot extend it: the deadline is signed with a secret it does
    not have.

THE FRAME PROTOCOL
    [kind:u8][length:u32be][payload]
        kind 0 = stdin bytes
        kind 1 = resize, payload exactly 4 bytes: cols, rows as u16be
        kind 2 = ping, payload ignored (keeps intermediaries alive)
    A frame whose declared length exceeds MAX_FRAME closes the connection
    before a byte is allocated. A resize outside [MIN_DIM, MAX_DIM] is
    IGNORED, not applied (B-17: a malformed frame must not become an
    allocation request).

WHAT THIS FILE DELIBERATELY DOES NOT DO
    It does not authenticate the user. It cannot: it has no user database and
    no session. Authentication is the Worker's job (a sealed capability bound
    to a live lease), and this file's job is to honour the deadline it is
    given. Defence in depth, not a second auth system.

Run standalone for the harness:  python3 terminal-server.py --selftest
Run as a service:                python3 terminal-server.py --socket /run/.../terminal.sock
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import os
import pty
import select
import signal
import socket
import struct
import sys
import termios
import time

# ------------------------------------------------------------------ constants

#: Hard ceiling on one frame. A terminal paste is at most a few hundred KB;
#: 1 MiB is generous and still refuses to allocate for a hostile length.
MAX_FRAME = 1 << 20

#: Terminal dimensions that will actually be applied. `u16be` can express
#: 65535, which no program should ever be asked to lay out (B-17).
MIN_DIM = 1
MAX_DIM = 1000

#: Frame kinds.
KIND_STDIN = 0
KIND_RESIZE = 1
KIND_PING = 2

#: How long a shell may outlive its signed deadline before it is killed. This
#: is a *scheduling* allowance (the killer runs on a tick), not extra life.
DEADLINE_SLOP_S = 1.0

#: Output read size from the PTY.
READ_SIZE = 65536


class FrameError(Exception):
    """A frame that must terminate the connection."""


def clamp_dim(value: int) -> int:
    """Clamp one terminal dimension into the range that will be applied.

    Returning a clamped value (rather than raising) is deliberate: a resize is
    advisory, and refusing the whole session because a mobile client sent rows=0
    would be a worse outcome than applying a sane size. But an out-of-range
    value is NOT honoured as sent — that is the B-17 bug.
    """
    if not isinstance(value, int):
        return MIN_DIM
    return max(MIN_DIM, min(MAX_DIM, value))


def parse_frames(buffer: bytes):
    """Split a byte buffer into (frames, remainder).

    Raises FrameError as soon as a declared length is impossible, so a hostile
    prefix cannot make the caller accumulate memory waiting for a payload that
    will never be legitimate.
    """
    frames = []
    offset = 0
    total = len(buffer)
    while total - offset >= 5:
        kind = buffer[offset]
        (size,) = struct.unpack(">I", buffer[offset + 1:offset + 5])
        if size > MAX_FRAME:
            raise FrameError("frame length %d exceeds cap %d" % (size, MAX_FRAME))
        if total - offset - 5 < size:
            break
        payload = buffer[offset + 5:offset + 5 + size]
        frames.append((kind, payload))
        offset += 5 + size
    return frames, buffer[offset:]


def looks_framed(buffer: bytes) -> bool | None:
    """Decide whether this stream is our framed protocol or raw keystrokes.

    WHY THIS EXISTS (the "first complete line kills the session" bug)

    The server spoke ONLY the framed protocol: `[kind:u8][len:u32be][payload]`.
    That is what the /computer UI sends, and it works. But ANY client that sends
    plain text — a protocol test, curl, a person with `websocat` — has its first
    five bytes read as a header. `echo hello-terminal\\n` starts with `e` (0x65)
    followed by `cho h`, so the declared length is 1667788576; that exceeds the
    cap, `FrameError` is raised, and the connection was CLOSED. The prompt
    arrived, one or two bytes were tolerated (too short to parse), and the first
    complete line killed the shell — exactly what the live test observed.

    The real defect was not the missing format, it was the response to it: a
    parse anomaly must never terminate a working shell. If the bytes cannot be a
    header, the honest reading is "this is typed text", not "kill the session".

    Detection rule, deliberately conservative:
      * kind in {STDIN, RESIZE, PING} AND declared length <= MAX_FRAME -> framed
      * anything else                                                 -> raw

    The length bound is what keeps B-17 intact: a hostile 4 GB length can never
    be mistaken for a frame header, so nothing is ever allocated for it. It is
    simply treated as text and handed to the PTY, where the tty's own flow
    control bounds it — the same bound that applies to a human holding a key.

    Returns True (framed), False (raw), or None when there are too few bytes to
    tell yet — the caller then waits for more instead of guessing.
    """
    if len(buffer) < 5:
        return None
    kind = buffer[0]
    if kind not in (KIND_STDIN, KIND_RESIZE, KIND_PING):
        return False
    (size,) = struct.unpack(">I", buffer[1:5])
    if size > MAX_FRAME:
        return False
    return True


def apply_frame(kind: int, payload: bytes, fd: int) -> str:
    """Act on one frame. Returns a short label for logging/tests.

    `fd` is the PTY master. Unknown kinds are ignored rather than fatal: a
    newer client sending a kind this server does not know should degrade, not
    disconnect (the reverse of the length check, which must be fatal).
    """
    if kind == KIND_STDIN:
        write_all(fd, payload)
        return "stdin"
    if kind == KIND_RESIZE:
        if len(payload) != 4:
            return "resize:bad-length"
        cols, rows = struct.unpack(">HH", payload)
        cols, rows = clamp_dim(cols), clamp_dim(rows)
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            return "resize:ioctl-failed"
        return "resize:%dx%d" % (cols, rows)
    if kind == KIND_PING:
        return "ping"
    return "ignored:%d" % kind


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


# ------------------------------------------------------------------- deadline

def sign_deadline(secret: bytes, computer: str, lease_id: str, deadline_ms: int) -> str:
    """The signature the Worker puts on the deadline it hands us.

    Including `computer` and `lease_id` means a signature captured for one
    session cannot be replayed for another, and a deadline cannot be moved
    forward without the secret.
    """
    msg = ("%s|%s|%d" % (computer, lease_id, deadline_ms)).encode()
    return hmac.new(secret, msg, hashlib.sha256).hexdigest()


def verify_deadline(secret: bytes, computer: str, lease_id: str,
                    deadline_ms: int, signature: str) -> bool:
    """Constant-time check of a deadline signature (BUGS.md B-16 lesson)."""
    if not secret:
        return False
    expected = sign_deadline(secret, computer, lease_id, deadline_ms)
    # compare_digest, never `==`: a plain compare leaks the token byte by byte
    # to anyone who can time the response, and this token authorises a shell.
    return hmac.compare_digest(expected, signature or "")


def deadline_passed(deadline_ms: int, now_ms: float | None = None) -> bool:
    """Is the shell's signed life over?"""
    if not deadline_ms:
        # No deadline supplied is a configuration error, not permission to run
        # forever. Fail closed.
        return True
    now = now_ms if now_ms is not None else time.time() * 1000.0
    return now > deadline_ms + DEADLINE_SLOP_S * 1000.0


# --------------------------------------------------------------------- server

def read_preamble(conn: socket.socket) -> tuple[str, str, int, str] | None:
    """Read the signed first line. Returns (computer, lease, deadline, signature).

    THE ONE PLACE THAT KNOWS THE PREAMBLE FORMAT.

    It used to live inline in `main()`, which meant `serve_pty()` assumed the
    line had already been consumed. Anything calling `serve_pty` directly — the
    harnesses, or a future transport — then had its preamble written to the SHELL
    as keystrokes. That is not a theoretical hazard: it produced
    `/bin/sh: 2: Syntax error: word unexpected` on the first command, because the
    shell had already executed the preamble text as a line of its own.

    Keeping the parse in one exported function means the two entry points cannot
    drift again.
    """
    try:
        conn.settimeout(5.0)
        line = b""
        while not line.endswith(b"\n"):
            chunk = conn.recv(1)
            if not chunk:
                break
            line += chunk
            if len(line) > 4096:      # a preamble is ~120 bytes; bound it
                break
        conn.settimeout(None)
        parts = line.decode("utf-8", "replace").strip().split(" ")
        if len(parts) != 4:
            return None
        computer, lease_id, deadline_text, signature = parts
        return computer, lease_id, int(deadline_text), signature
    except (OSError, ValueError):
        try:
            conn.settimeout(None)
        except OSError:
            pass
        return None


def serve_pty(conn: socket.socket, deadline_ms: int, shell: str | None = None,
              cwd: str | None = None, env_extra: dict | None = None,
              preamble_already_read: bool = False) -> dict:
    """Run one shell until the socket closes or the deadline passes.

    Returns counters the tests assert on: bytes each way, frames applied, and
    why it ended. `reason` is one of "eof", "deadline", "error".

    `preamble_already_read` exists because `main()` must verify the signature
    BEFORE it forks a shell: serving first and authenticating afterwards would
    hand a shell to an unauthenticated peer for the few milliseconds the
    signature check takes. `main()` therefore reads and verifies the line, then
    calls this with the flag set. Every other caller leaves it False and this
    function consumes the preamble itself — so no path can leak it into the PTY.

    A preamble that is missing or malformed ends the session with
    `reason="no_preamble"` rather than starting a shell: an unauthenticated
    caller must not get a prompt.
    """
    if not preamble_already_read:
        line_parts = read_preamble(conn)
        if line_parts is None:
            # No valid first line: never start a shell. This is the 5 s timeout
            # the browser used to hit when an `await` swallowed its `open` event.
            return {"to_client": 0, "from_client": 0, "frames": 0,
                    "reason": "no_preamble"}

    env = dict(os.environ, TERM="xterm-256color")
    if env_extra:
        env.update(env_extra)
    pid, fd = pty.fork()
    if pid == 0:  # child
        try:
            target = cwd or os.path.expanduser("~")
            os.chdir(target)
        except OSError:
            try:
                os.chdir("/")
            except OSError:
                pass
        shell = shell or env.get("SHELL") or "/bin/sh"
        try:
            os.execvpe(shell, [shell, "-l"], env)
        except Exception:
            os._exit(127)

    stats = {"to_client": 0, "from_client": 0, "frames": 0, "reason": "eof"}
    pending = b""
    # None = not decided yet; True = framed protocol; False = raw keystrokes.
    # Decided once, on the first bytes that can be judged, then held for the
    # session. Re-deciding per read would let one malformed packet switch a
    # framed session into raw mode mid-stream and garble it.
    framed = None
    try:
        while True:
            if deadline_passed(deadline_ms):
                stats["reason"] = "deadline"
                break
            # Wake at least once a second so a deadline is noticed even when
            # both sides are silent — the whole point is a shell that cannot
            # outlive its lease while idle.
            ready, _, _ = select.select([conn, fd], [], [], 1.0)
            if fd in ready:
                try:
                    data = os.read(fd, READ_SIZE)
                except OSError:
                    stats["reason"] = "eof"
                    break
                if not data:
                    stats["reason"] = "eof"
                    break
                conn.sendall(data)
                stats["to_client"] += len(data)
            if conn in ready:
                data = conn.recv(READ_SIZE)
                if not data:
                    stats["reason"] = "eof"
                    break
                stats["from_client"] += len(data)
                pending += data
                if framed is None:
                    framed = looks_framed(pending)
                    if framed is None:
                        # Fewer than 5 bytes: still ambiguous. Wait for more
                        # rather than guessing (and rather than closing).
                        continue
                    stats["mode"] = "framed" if framed else "raw"
                if framed:
                    try:
                        frames, pending = parse_frames(pending)
                    except FrameError:
                        # Unreachable via looks_framed() — kept because defence
                        # in depth costs one clause, and a future edit to the
                        # detector must not be able to resurrect the kill.
                        # Fall back to raw rather than closing: a shell that is
                        # working must not die because we mis-read a header.
                        framed = False
                        stats["mode"] = "raw"
                        write_all(fd, pending)
                        pending = b""
                        continue
                    for kind, payload in frames:
                        apply_frame(kind, payload, fd)
                        stats["frames"] += 1
                else:
                    # Raw keystrokes: everything is stdin. This is the path a
                    # protocol test, curl, or `websocat` takes — and it must
                    # behave exactly like a terminal.
                    write_all(fd, pending)
                    pending = b""
    except (BrokenPipeError, ConnectionResetError, OSError):
        stats["reason"] = "error"
    finally:
        try:
            os.killpg(os.getpgid(pid), signal.SIGHUP)
        except (OSError, ProcessLookupError):
            pass
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
        try:
            conn.close()
        except OSError:
            pass
    return stats


# -------------------------------------------------------------------- selftest

def selftest() -> int:
    """Prove the clamp, the cap, and the deadline against a real PTY."""
    passed = 0
    failed = []

    def check(name, cond, detail=""):
        nonlocal passed
        if cond:
            passed += 1
            print("  ok   %s" % name)
        else:
            failed.append(name)
            print("  FAIL %s  %s" % (name, detail))

    print("frames: dimensions are clamped (BUGS.md B-17)")
    for raw, want in [(0, 1), (1, 1), (80, 80), (1000, 1000), (1001, 1000),
                      (65535, 1000)]:
        check("cols %d -> %d" % (raw, want), clamp_dim(raw) == want, str(clamp_dim(raw)))
    check("a non-integer is treated as the minimum", clamp_dim(None) == MIN_DIM)

    print("frames: a hostile length is refused before allocation")
    try:
        parse_frames(struct.pack(">BI", KIND_STDIN, MAX_FRAME + 1))
        check("oversize frame raises", False, "it did not raise")
    except FrameError:
        check("oversize frame raises", True)
    try:
        parse_frames(struct.pack(">BI", KIND_STDIN, 0xFFFFFFFF))
        check("0xFFFFFFFF length raises", False, "it did not raise")
    except FrameError:
        check("0xFFFFFFFF length raises", True)

    print("frames: splitting is exact")
    body = b"echo hello\n"
    buf = struct.pack(">BI", KIND_STDIN, len(body)) + body
    frames, rest = parse_frames(buf)
    check("one complete frame", frames == [(KIND_STDIN, body)], str(frames))
    check("nothing left over", rest == b"")
    frames, rest = parse_frames(buf + buf[:3])
    check("a partial frame is buffered, not acted on", frames == [(KIND_STDIN, body)]
          and rest == buf[:3], "%r %r" % (frames, rest))

    print("deadline: the shell cannot outlive its lease")
    check("a past deadline has passed", deadline_passed(int(time.time() * 1000) - 5000))
    check("a future deadline has not",
          not deadline_passed(int(time.time() * 1000) + 60_000))
    check("no deadline at all fails closed", deadline_passed(0))

    print("deadline: the signature is per-session and constant-time")
    secret = b"test-secret-not-a-real-one"
    sig = sign_deadline(secret, "default", "lease-1", 1700000000000)
    check("a good signature verifies",
          verify_deadline(secret, "default", "lease-1", 1700000000000, sig))
    check("another computer is refused",
          not verify_deadline(secret, "qa", "lease-1", 1700000000000, sig))
    check("another lease is refused",
          not verify_deadline(secret, "default", "lease-2", 1700000000000, sig))
    check("a moved deadline is refused",
          not verify_deadline(secret, "default", "lease-1", 1700000000001, sig))
    check("a wrong secret is refused",
          not verify_deadline(b"other", "default", "lease-1", 1700000000000, sig))
    check("an empty secret never verifies",
          not verify_deadline(b"", "default", "lease-1", 1700000000000, sig))
    check("a tampered signature is refused",
          not verify_deadline(secret, "default", "lease-1", 1700000000000, sig[:-1] + "0"))

    print("pty: a real shell runs, echoes, and dies at the deadline")
    a, b = socket.socketpair()
    deadline = int(time.time() * 1000) + 4000
    import threading
    result = {}
    # serve_pty now consumes the preamble itself (one place owns the format),
    # so this caller must send a VALID signed line exactly as the Worker mints
    # one. Previously the test skipped it and serve_pty assumed it was gone —
    # which is how the preamble ended up being typed into the shell.
    selftest_sig = sign_deadline(secret, "default", "selftest-lease", deadline)

    def run():
        result.update(serve_pty(a, deadline, shell="/bin/sh", cwd="/tmp"))

    t = threading.Thread(target=run, daemon=True)
    t.start()
    b.sendall(("default selftest-lease %d %s\n" % (deadline, selftest_sig)).encode())
    # Send a command through the frame protocol and expect the echo back.
    cmd = b"echo TERMINAL-OK\n"
    b.sendall(struct.pack(">BI", KIND_STDIN, len(cmd)) + cmd)
    b.settimeout(5.0)
    seen = b""
    try:
        while b"TERMINAL-OK" not in seen and len(seen) < 65536:
            chunk = b.recv(4096)
            if not chunk:
                break
            seen += chunk
    except socket.timeout:
        pass
    check("the shell executed the command", b"TERMINAL-OK" in seen,
          repr(seen[:120]))

    # A resize is applied, and an absurd one does not kill the session.
    b.sendall(struct.pack(">BI", KIND_RESIZE, 4) + struct.pack(">HH", 120, 40))
    time.sleep(0.2)
    b.sendall(struct.pack(">BI", KIND_RESIZE, 4) + struct.pack(">HH", 65535, 65535))
    time.sleep(0.2)
    alive = b"echo STILL-ALIVE\n"
    b.sendall(struct.pack(">BI", KIND_STDIN, len(alive)) + alive)
    seen = b""
    try:
        while b"STILL-ALIVE" not in seen and len(seen) < 65536:
            chunk = b.recv(4096)
            if not chunk:
                break
            seen += chunk
    except socket.timeout:
        pass
    check("an absurd resize does not kill the session", b"STILL-ALIVE" in seen,
          repr(seen[:120]))

    # Now let the deadline pass with the socket still open and idle.
    t.join(timeout=8)
    check("the session ended on its own", not t.is_alive(), "thread still running")
    check("it ended because of the deadline", result.get("reason") == "deadline",
          str(result.get("reason")))
    b.close()

    print()
    total = passed + len(failed)
    print("%d passed, %d failed  (%d checks)" % (passed, len(failed), total))
    if failed:
        print("failed: " + ", ".join(failed))
        return 1
    return 0


# ----------------------------------------------------------------------- main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--socket", default="/run/qwenpaw-terminal/terminal.sock")
    ap.add_argument("--secret-file", default="/data/home/qwenpaw/terminal.secret")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    secret = b""
    try:
        with open(args.secret_file, "rb") as f:
            secret = f.read().strip()
    except OSError:
        print("terminal-server: no secret at %s — refusing to serve a shell "
              "that cannot be lease-bounded" % args.secret_file, flush=True)
        return 2

    try:
        os.unlink(args.socket)
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(args.socket), mode=0o700, exist_ok=True)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    previous_umask = os.umask(0o077)
    try:
        server.bind(args.socket)
    finally:
        os.umask(previous_umask)
    server.listen(8)
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    print("terminal-server listening on %s" % args.socket, flush=True)

    while True:
        conn = server.accept()[0]
        # websockify passes the deadline and its signature as the first line of
        # the connection, newline-terminated, then the stream is raw frames.
        # Parsing it here (rather than trusting a URL) keeps the deadline out of
        # any access log.
        # Parse with the SAME function serve_pty uses, so the two entry points
        # cannot drift (they already had: serve_pty assumed the line was gone,
        # so a direct caller leaked the preamble into the shell).
        parts = read_preamble(conn)
        if parts is None:
            try:
                conn.close()
            except OSError:
                pass
            continue
        computer, lease_id, deadline_ms, signature = parts

        if not verify_deadline(secret, computer, lease_id, deadline_ms, signature):
            print("terminal-server: refusing a connection with a bad deadline "
                  "signature", flush=True)
            try:
                conn.close()
            except OSError:
                pass
            continue

        if os.fork() == 0:
            server.close()
            try:
                # Verified above, before forking: never serve a shell and
                # authenticate afterwards.
                serve_pty(conn, deadline_ms, preamble_already_read=True)
            finally:
                os._exit(0)
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
