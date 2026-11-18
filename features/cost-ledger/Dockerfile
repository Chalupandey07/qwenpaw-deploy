# Derived QwenPaw image with the cost ledger + hard kill switch
# (features/cost-ledger).
#
# Base is the live bloatwinwin1 image (which itself layers the loop-gate
# fix from gatefix3 and the telemetry removal onto pinned upstream
# agentscope/qwenpaw:v2.3.0). The only change here is the cost ledger:
# a new token_usage/cost_ledger.py (static price table, daily budget,
# alert at 80% / hard stop at 100% with a pre-call reserve in the model
# wrapper), the pre-call hook in TokenRecordingModelWrapper, and a new
# /cost router (GET /api/cost, POST /api/cost/budget, POST /api/cost/reset).
# The loop-gate fix and the telemetry removal are untouched and survive.
# Tag: qwenpaw-agentx:2.3.0-costledger1.
#
# The patch touches only files neither gatefix3 nor bloatwinwin1 changed
# (model_wrapper.py, app/routers/__init__.py) plus two NEW files, so it
# applies cleanly on this base. The build FAILS if it does not.
FROM qwenpaw-agentx:2.3.0-bloatwinwin1

COPY qwenpaw-cost-ledger.patch /tmp/qwenpaw-cost-ledger.patch

# Apply the patch in BOTH places the code lives. The package is installed
# in site-packages (that is what Python imports at runtime); /app/src is
# the source tree the install was built from. Both copies are byte-identical
# upstream, so the same patch applies to both: -p1 from /app patches
# src/qwenpaw/..., -p2 from site-packages patches qwenpaw/....
# Then byte-compile all patched/added modules so a stale .pyc can never win.
# The build FAILS here if the patch does not apply cleanly to either copy.
RUN cd /app \
    && patch -p1 < /tmp/qwenpaw-cost-ledger.patch \
    && cd /app/venv/lib/python3.11/site-packages \
    && patch -p2 < /tmp/qwenpaw-cost-ledger.patch \
    && rm /tmp/qwenpaw-cost-ledger.patch \
    && python3 -m py_compile \
        /app/src/qwenpaw/token_usage/cost_ledger.py \
        /app/src/qwenpaw/token_usage/model_wrapper.py \
        /app/src/qwenpaw/app/routers/cost.py \
        /app/src/qwenpaw/app/routers/__init__.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/token_usage/cost_ledger.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/token_usage/model_wrapper.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/app/routers/cost.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/app/routers/__init__.py
