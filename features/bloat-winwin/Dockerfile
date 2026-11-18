# Derived QwenPaw image with the bloat-winwin telemetry removal
# (features/bloat-winwin).
#
# Base is the live gatefix3 image (which itself layers the loop-gate
# fix onto pinned upstream agentscope/qwenpaw:v2.3.0). The only change
# here is replacing the two telemetry modules with no-op stubs:
# the Alibaba Cloud phone-home endpoint and the daily sender thread
# are gone, while every name the rest of the codebase imports keeps
# working. The gatefix3 patch is untouched and survives.
# Tag: qwenpaw-agentx:2.3.0-bloatwinwin1.
FROM qwenpaw-agentx:2.3.0-gatefix3

COPY qwenpaw-bloat-winwin.patch /tmp/qwenpaw-bloat-winwin.patch

# Apply the patch in BOTH places the code lives. The package is installed
# in site-packages (that is what Python imports at runtime); /app/src is
# the source tree the install was built from. Both copies are byte-identical
# upstream, so the same patch applies to both: -p1 from /app patches
# src/qwenpaw/..., -p2 from site-packages patches qwenpaw/....
# Then byte-compile both patched modules so a stale .pyc can never win.
# The build FAILS here if the patch does not apply cleanly to either copy.
RUN cd /app \
    && patch -p1 < /tmp/qwenpaw-bloat-winwin.patch \
    && cd /app/venv/lib/python3.11/site-packages \
    && patch -p2 < /tmp/qwenpaw-bloat-winwin.patch \
    && rm /tmp/qwenpaw-bloat-winwin.patch \
    && python3 -m py_compile \
        /app/src/qwenpaw/utils/telemetry.py \
        /app/src/qwenpaw/utils/daily_telemetry.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/utils/telemetry.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/utils/daily_telemetry.py
