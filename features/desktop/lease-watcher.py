#!/usr/bin/env python3
"""desktop-lease-watcher: mirror the Cloudflare Worker control lease into
the InstaBox desktop control file the computer-use MCP proxy honors.

Polls GET https://qwenpawx.pages.dev/desktop/__lease every 5 s.
- lease holder == "user" (unexpired): write "human worker-lease <epoch>"
  to /run/user/1000/instabox-control (renewed each poll; the proxy treats
  entries older than 30 s as stale, so a dead watcher auto-clears).
- no lease: remove the file ONLY if its owner word is "worker-lease".
  A dashboard takeover writes a different owner word, so this can never
  clear a dashboard hold; no desktop-controller check is needed (the
  owner word is the guard — the desktop status call flaked and added
  nothing here).
- Worker unreachable: leave state unchanged (fail-open for the agent).
- KV is eventually consistent: after a release, a stale read can keep
  refreshing the file for up to ~60 s; the 30 s staleness bound caps the
  agent's wait.
Diagnostics to stderr (journalctl -u desktop-lease-watcher).

NOTE: Python urllib's default User-Agent is 403'd by Cloudflare on the
Pages domain — this script sends a Mozilla browser UA. If the UA is
changed, re-check the journal for 403s.
"""
import json
import sys
import time
import urllib.request

LEASE_URL = "https://qwenpawx.pages.dev/desktop/__lease"
CONTROL_FILE = "/run/user/1000/instabox-control"
POLL_S = 5


def log(msg):
    sys.stderr.write("lease-watcher: %s\n" % msg)
    sys.stderr.flush()


UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"


def get_lease():
    try:
        req = urllib.request.Request(LEASE_URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        log("lease fetch failed: %s" % e)
        return None


def read_control():
    try:
        with open(CONTROL_FILE, "r") as f:
            return f.read().strip().split()
    except OSError:
        return []


def main():
    log("started, polling %s" % LEASE_URL)
    while True:
        try:
            lease = get_lease()
            if lease and lease.get("holder") == "user":
                exp = lease.get("expiresAt", 0)
                if exp > int(time.time() * 1000):  # expiresAt is epoch ms
                    with open(CONTROL_FILE, "w") as f:
                        f.write("human worker-lease %d\n" % int(time.time()))
                else:
                    log("lease expired at %s" % exp)
            elif lease is not None:
                # Only ever remove OUR OWN entry (owner word worker-lease).
                words = read_control()
                if len(words) >= 2 and words[0] == "human" and words[1] == "worker-lease":
                    try:
                        import os
                        os.unlink(CONTROL_FILE)
                        log("lease ended, control file cleared")
                    except OSError:
                        pass
        except Exception as e:
            log("poll error: %s" % e)
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
