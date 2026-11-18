# Derived QwenPaw image with the Approval TTL wiring (gap #18, T132).
#
# Base is the LIVE image qwenpaw-agentx:2.3.0-gatefix6 (upstream +
# gatefix4 + bloat-winwin + cost-ledger + Telegram + gatefix5 +
# gatefix6), so all of those layers survive. The only change is the
# approval-TTL delta: the approve/deny handlers in
# app/routers/approval.py call ttl.answer() first (a late answer is
# refused with 409 approval_expired and the waiting call is resolved
# as denied), GET /api/approval/list annotates expired cards via
# ttl.read(), and the approval service stamps each new card's expiry
# via ttl.issue() at creation. The TTL module itself lives on the
# working mount (/app/working/approval-ttl/ttl.py, synced from the
# repo) — never baked into the image — so the store survives
# recreates; if the module is absent the handlers behave exactly as
# before (TTL inert). Nothing else is changed.
# Tag: qwenpaw-agentx:2.3.0-approvalttl1.
FROM qwenpaw-agentx:2.3.0-gatefix6

COPY qwenpaw-approval-ttl.patch /tmp/qwenpaw-approval-ttl.patch

# Apply the TTL delta in BOTH places the code lives. The package is
# installed in site-packages (that is what Python imports at runtime);
# /app/src is the source tree the install was built from. Both copies
# are byte-identical, so the same patch applies to both: -p1 from /app
# patches src/qwenpaw/..., -p2 from site-packages patches qwenpaw/....
# Then byte-compile the patched modules so a stale .pyc can never win.
# The build FAILS here if the patch does not apply cleanly to either copy.
RUN cd /app \
    && patch -p1 < /tmp/qwenpaw-approval-ttl.patch \
    && cd /app/venv/lib/python3.11/site-packages \
    && patch -p2 < /tmp/qwenpaw-approval-ttl.patch \
    && rm /tmp/qwenpaw-approval-ttl.patch \
    && python3 -m py_compile \
        /app/src/qwenpaw/app/routers/approval.py \
        /app/src/qwenpaw/app/approvals/service.py \
        /app/src/qwenpaw/app/approvals/__init__.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/app/routers/approval.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/app/approvals/service.py \
        /app/venv/lib/python3.11/site-packages/qwenpaw/app/approvals/__init__.py
