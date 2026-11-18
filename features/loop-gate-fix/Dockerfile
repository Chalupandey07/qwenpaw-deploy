# Derived QwenPaw image with the loop-gate fix (features/loop-gate-fix).
#
# Base is the pinned upstream image (same digest as the live deploy).
# The only change is the loop-gate patch: it fixes ToolCallBudgetGate
# counting (round 1) and expands workflow/batch sub-calls so the batch
# runner cannot bypass the budget (round 2), wires the gate into
# the default loop chain so the cap applies to every chat, enforces
# the budget at execution time (round 3) so a single response carrying
# 200 direct parallel calls cannot execute them all before the gate's
# deferred stop applies, adds a per-task cap with a structured
# stop audit (round 4) so a task cannot creep across turns by resuming,
# and persists the task budget through the session-state round-trip
# (round 5) so the per-task cap survives the runtime rebuilding the
# agent object for every user turn. Nothing else is changed.
# Tag: qwenpaw-agentx:2.3.0-gatefix5.
FROM agentscope/qwenpaw:v2.3.0@sha256:46a782f4b39b673eac399c90294244e348e71a01bdf032f8e78b00776be3c87d

COPY qwenpaw-loop-gate-fix.patch /tmp/qwenpaw-loop-gate-fix.patch

# Apply the patch in BOTH places the code lives. The package is installed
# in site-packages (that is what Python imports at runtime); /app/src is
# the source tree the install was built from. Both copies are byte-identical
# upstream, so the same patch applies to both: -p1 from /app patches
# src/qwenpaw/..., -p2 from site-packages patches qwenpaw/....
# Then byte-compile all eight patched modules so a stale .pyc can never win.
# The build FAILS here if the patch does not apply cleanly to either copy.
RUN cd /app \
    && patch -p1 < /tmp/qwenpaw-loop-gate-fix.patch \
    && cd /app/venv/lib/python3.11/site-packages \
    && patch -p2 < /tmp/qwenpaw-loop-gate-fix.patch \
    && rm /tmp/qwenpaw-loop-gate-fix.patch \
    && python3 -m py_compile \
        /app/src/qwenpaw/loop/gates/limits.py \
        /app/src/qwenpaw/modes/default/mode.py \
        /app/src/qwenpaw/config/config.py \
        /app/src/qwenpaw/agents/react_agent.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/loop/gates/limits.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/modes/default/mode.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/config/config.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/agents/react_agent.py
