# Derived QwenPaw image with the serving-model identity note + switch log
# (features/model-identity, provisional T134, gap #17).
#
# Base is the cost-ledger image (which itself layers the loop-gate fix
# from gatefix3, the telemetry removal, and the cost ledger onto pinned
# upstream agentscope/qwenpaw:v2.3.0). The only change here is model
# identity: the note stamped onto every model call (dispatch boundary:
# TokenRecordingModelWrapper.__call__) naming the model actually serving
# the attempt, the recorded switch reason from the fallback sink, and
# the {from, to, reason} switch log inside PATCH
# /api/agents/{agentId}/model-settings. Tag:
# qwenpaw-agentx:2.3.0-modelidentity1.
#
# The patch touches model_wrapper.py, which the cost-ledger patch ALSO
# touched — verified to apply cleanly onto the costledger1 file (hunk #1
# with fuzz 2, offset 7 lines; hunk #2 cleanly), and the merged file was
# checked: the identity stamp runs FIRST so the cost-ledger budget check
# measures the messages as actually sent, note included. The build
# FAILS if the patch does not apply cleanly to either copy. If the
# coordinator re-bases the image chain (e.g. onto gatefix4), re-verify
# the patch against the new base before building: model_wrapper.py is
# shared with the cost ledger, so a re-base can break this hunk.
FROM qwenpaw-agentx:2.3.0-costledger1

COPY qwenpaw-model-identity.patch /tmp/qwenpaw-model-identity.patch

# Apply the patch in BOTH places the code lives. The package is installed
# in site-packages (that is what Python imports at runtime); /app/src is
# the source tree the install was built from. Both copies are byte-identical
# upstream, so the same patch applies to both: -p1 from /app patches
# src/qwenpaw/..., -p2 from site-packages patches qwenpaw/....
# Then byte-compile all patched/added modules so a stale .pyc can never win.
# The build FAILS here if the patch does not apply cleanly to either copy.
RUN cd /app \
    && patch -p1 < /tmp/qwenpaw-model-identity.patch \
    && cd /app/venv/lib/python3.11/site-packages \
    && patch -p2 < /tmp/qwenpaw-model-identity.patch \
    && rm /tmp/qwenpaw-model-identity.patch \
    && python3 -m py_compile \
        /app/src/qwenpaw/model_identity.py \
        /app/src/qwenpaw/token_usage/model_wrapper.py \
        /app/src/qwenpaw/app/routers/agents.py \
        /app/src/qwenpaw/providers/fallback_chat_model.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/model_identity.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/token_usage/model_wrapper.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/app/routers/agents.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/providers/fallback_chat_model.py
