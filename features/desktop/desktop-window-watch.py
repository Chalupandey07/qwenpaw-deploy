#!/usr/bin/env python3
"""Re-map the desktop Chromium windows if they go unmapped.

Root cause (2026-11-15, fix round for the 4 browser defects): the :1
Chromium frame (the browser window the user watches) was found
IsUnMapped twice — once correlating with MCP global clicks, once right
after the parent's live-browser session ended. When the frame is
unmapped, the VNC framebuffer shows a bare/black desktop even though
Chromium is alive, so the user sees "no screen" and thinks the desktop
died. The trigger is unproven; this watcher makes the desktop
self-healing instead: every 10 s it re-maps any large (>= 800 px wide)
Chromium window that is IsUnMapped, and logs the event (with the window
id) so the trigger can be found from the journal later.

Watches both displays: :1 (Team / shared) and :2 (Private / QA).
Only large windows are re-mapped — Chromium also owns a 10x10 helper
window ("chromium", no title) that is meant to stay unmapped.
"""
import os
import re
import subprocess
import sys
import time

DISPLAYS = (":1", ":2")
MIN_WIDTH = 800
INTERVAL_S = 10


def run(cmd, display):
    env = dict(os.environ)
    env["DISPLAY"] = display
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=10, env=env
        ).stdout
    except Exception as exc:  # noqa: BLE001 - log and keep watching
        print(f"[{display}] {cmd[0]} failed: {exc}", flush=True)
        return ""


def chromium_windows(display):
    out = run(["xdotool", "search", "--class", "Chromium"], display)
    return [w.strip() for w in out.splitlines() if w.strip()]


def window_info(display, wid):
    out = run(["xwininfo", "-id", wid], display)
    m = re.search(r"Map State:\s*(\S+)", out)
    w = re.search(r"Width:\s*(\d+)", out)
    h = re.search(r"Height:\s*(\d+)", out)
    return {
        "map": m.group(1) if m else "?",
        "width": int(w.group(1)) if w else 0,
        "height": int(h.group(1)) if h else 0,
    }


def check_display(display):
    for wid in chromium_windows(display):
        info = window_info(display, wid)
        if info["map"] == "IsUnMapped" and info["width"] >= MIN_WIDTH:
            print(
                f"[{display}] Chromium window {wid} ({info['width']}x{info['height']}) "
                f"is IsUnMapped — re-mapping",
                flush=True,
            )
            run(["xdotool", "windowmap", wid], display)
            run(["xdotool", "windowactivate", wid], display)
            time.sleep(1)
            after = window_info(display, wid)
            print(
                f"[{display}] window {wid} now {after['map']}",
                flush=True,
            )


def main():
    print("desktop-window-watch: watching :1 + :2 for unmapped Chromium windows", flush=True)
    while True:
        for display in DISPLAYS:
            try:
                check_display(display)
            except Exception as exc:  # noqa: BLE001 - never die on one display
                print(f"[{display}] check failed: {exc}", flush=True)
        time.sleep(INTERVAL_S)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
