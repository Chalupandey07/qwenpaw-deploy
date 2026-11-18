# Derived QwenPaw image with the loop-gate fix (features/loop-gate-fix).
#
# Base is the pinned upstream image (same digest as the live deploy).
# The only change is the loop-gate patch: it fixes ToolCallBudgetGate
# counting and wires the gate into the default loop chain so the cap
# applies to every chat. Nothing else is changed.
FROM agentscope/qwenpaw:v2.3.0@sha256:46a782f4b39b673eac399c90294244e348e71a01bdf032f8e78b00776be3c87d

COPY qwenpaw-loop-gate-fix.patch /tmp/qwenpaw-loop-gate-fix.patch

# Apply the patch from /app (patch paths are src/qwenpaw/...), then
# byte-compile the three patched modules so a stale .pyc can never win.
# The build FAILS here if the patch does not apply cleanly.
RUN cd /app \
    && patch -p1 < /tmp/qwenpaw-loop-gate-fix.patch \
    && rm /tmp/qwenpaw-loop-gate-fix.patch \
    && python3 -m py_compile \
        src/qwenpaw/loop/gates/limits.py \
        src/qwenpaw/modes/default/mode.py \
        src/qwenpaw/config/config.py
