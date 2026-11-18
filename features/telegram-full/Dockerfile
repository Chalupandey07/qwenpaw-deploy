# Derived QwenPaw image with the full-featured Telegram bot
# (features/telegram-full).
#
# Base is the live bloatwinwin1 image (which itself layers the loop-gate
# fix from gatefix3 and the telemetry removal onto pinned upstream
# agentscope/qwenpaw:v2.3.0). The only change here is the Telegram menu
# patch: the patched driver routes menu taps to the agent as
# "/tgmenu <payload>" and threads an optional reply_markup through
# send_parts/_send_text, plus the new cards/menu.py (the callback
# grammar + menu tree). The loop-gate fix and the telemetry removal
# are untouched and survive.
# Tag: qwenpaw-agentx:2.3.0-telegram1.
#
# The patch touches only the Telegram plugin driver, which neither
# gatefix3 nor bloatwinwin1 changed, so it applies cleanly on this
# base. The build FAILS if it does not.
#
# Build on the machine (no Docker daemon on this VM), from the repo
# root, with this directory as the build context:
#   docker build -f features/telegram-full/Dockerfile \
#     -t qwenpaw-agentx:2.3.0-telegram1 features/telegram-full/
# Docker images are 5 of 5 — delete an old image first.
FROM qwenpaw-agentx:2.3.0-bloatwinwin1

COPY qwenpaw-telegram-menu.patch /tmp/qwenpaw-telegram-menu.patch
COPY menu.py /tmp/menu.py

# The Telegram plugin is loaded from /app/plugins/channel/telegram/
# (it is a plugin, not part of the qwenpaw package, so there is no
# site-packages copy to patch — but the conditional below patches one
# if it ever appears). The patch labels are
# a/qwenpaw_channel_telegram/platform.py, so -p1 from the plugin dir
# lands on qwenpaw_channel_telegram/platform.py. Then byte-compile
# all patched/added modules so a stale .pyc can never win. The build
# FAILS here if the patch does not apply cleanly.
RUN cd /app/plugins/channel/telegram \
    && patch -p1 < /tmp/qwenpaw-telegram-menu.patch \
    && cp /tmp/menu.py qwenpaw_channel_telegram/cards/menu.py \
    && python3 -m py_compile \
        qwenpaw_channel_telegram/platform.py \
        qwenpaw_channel_telegram/cards/menu.py \
    && if [ -d /app/venv/lib/python3.11/site-packages/qwenpaw_channel_telegram ]; then \
         cd /app/venv/lib/python3.11/site-packages \
         && patch -p2 < /tmp/qwenpaw-telegram-menu.patch \
         && cp /tmp/menu.py qwenpaw_channel_telegram/cards/menu.py \
         && python3 -m py_compile \
             qwenpaw_channel_telegram/platform.py \
             qwenpaw_channel_telegram/cards/menu.py; \
       fi \
    && rm /tmp/qwenpaw-telegram-menu.patch /tmp/menu.py
