#!/bin/bash
# QA-agent computer-use server for display :2.
# mcp-proxy spawns its server with a MINIMAL environment (only HOME/LOGNAME/
# PATH/SHELL/USER), so the display/bus must be set HERE, not in the systemd
# service Environment= (those are lost). Mirrors /usr/local/bin/instabox-computer-use
# but for :2, and bypasses that wrapper's hardcoded DISPLAY=:1.
# Uses a dedicated session bus (unix:path=/run/user/1000/qa/bus) so the QA
# agent's AT-SPI registry sees ONLY :2 apps, and a dedicated runtime dir
# (/run/user/1000/qa) so its control lock (instabox-control) is separate
# from the :1 desktop's lock.
export DISPLAY=:2
export XDG_RUNTIME_DIR=/run/user/1000/qa
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/qa/bus
export GDK_BACKEND=x11 XDG_SESSION_TYPE=x11 NO_AT_BRIDGE=0
export OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS=1
unset WAYLAND_DISPLAY AT_SPI_BUS_ADDRESS
exec python3 -I /usr/local/bin/instabox-computer-use-proxy -- /usr/local/bin/open-computer-use mcp
