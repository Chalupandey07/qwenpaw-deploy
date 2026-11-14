#!/usr/bin/env python3
"""PTY server for the /desktop terminal tab (Rakazo's terminal-server.ts,
adapted: stdlib-only Python). Binds a Unix socket; websockify relays each
WebSocket to one socket connection, which gets its own login shell.
Frame protocol (see contracts/terminal): input arrives as
[kind:u8][length:u32be][payload] — kind 0 = stdin, kind 1 = resize
(cols, rows as u16be). Output is raw bytes. One connection = one shell;
the shell dies when the connection closes."""
import fcntl
import os
import pty
import select
import signal
import socket
import struct
import sys
import termios

SOCK = "/run/user/1000/terminal.sock"
CWD = "/data/home"
MAX_FRAME = 1 << 20


def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]


def serve(conn):
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    env = dict(os.environ, TERM="xterm-256color")
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(CWD)
        except OSError:
            os.chdir(os.path.expanduser("~"))
        shell = env.get("SHELL") or "/bin/bash"
        os.execvpe(shell, [shell, "-l"], env)
    pending = b""
    try:
        while True:
            ready = select.select([conn, fd], [], [])[0]
            if fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                conn.sendall(data)
            if conn in ready:
                data = conn.recv(65536)
                if not data:
                    break
                pending += data
                while len(pending) >= 5:
                    kind = pending[0]
                    size = struct.unpack(">I", pending[1:5])[0]
                    if size > MAX_FRAME:
                        return
                    if len(pending) < 5 + size:
                        break
                    payload, pending = pending[5:5 + size], pending[5 + size:]
                    if kind == 0:
                        write_all(fd, payload)
                    elif kind == 1 and len(payload) == 4:
                        cols, rows = struct.unpack(">HH", payload)
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    finally:
        try:
            os.killpg(pid, signal.SIGHUP)
        except OSError:
            pass
        os.close(fd)
        conn.close()
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass


try:
    os.unlink(SOCK)
except FileNotFoundError:
    pass
os.makedirs("/run/user/1000", mode=0o700, exist_ok=True)
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
prev = os.umask(0o077)
server.bind(SOCK)
os.umask(prev)
server.listen(8)
signal.signal(signal.SIGCHLD, signal.SIG_IGN)
print("pty-server listening on %s" % SOCK, flush=True)
while True:
    conn = server.accept()[0]
    if os.fork() == 0:
        server.close()
        try:
            serve(conn)
        finally:
            os._exit(0)
    conn.close()
