# Re-test plan — QwenPaw on InstaBox Free (retest-2026-11-15)

Method: replica-test (plan → cases → bugs) + security-audit coverage-led
hunting + BugHunter triage gate. Live probes only against the user's own
systems. Cases: R01-H* happy path, R01-E* edge, R01-N* negative.

## Cases run (all executed 2026-11-15 02:32–02:50 IST unless marked blocked)

- R01-H1 Pages root both projects → 200, 38,125 B. PASS
- R01-H2 Pages /status → 200; /api/auth/status → 200 enabled/has_users. PASS
- R01-H3 Pages framing headers on HTML. PASS
- R01-H4 Pages proxy harness: 503→retry→200, 503→503 waking page, 409
  cooldown/other, Location rewrite/drop, origin-down 502. 9/9 PASS
- R01-N1 /api/cron/jobs unauthenticated → 401 (Pages + direct). PASS
- R02-H1 Keepalive /status cron advancing (21:00→21:05→21:15Z), up, 0 failures. PASS
- R02-H2 Keepalive /ping public → 200. PASS (by design)
- R02-N1 POST /wake no token / wrong token → 401. PASS
- R02-E1 Keepalive secrets list: only WAKE_TOKEN; INSTABOX_API_KEY unset. PASS
- R03-H1 Routines schedules intact (*/30, 30 1); /api/history notes only. PASS
- R03-N1 POST /trigger no token → 401. PASS
- R03-N2 Routines public GETs leak prompt text → FOUND RT-001 (LOW), fixed,
  harness 11/11 + live re-test PASS
- R04-H1 Groupchat GET / auth_required:true + rate limit advertised. PASS
- R04-N1 Groupchat /thread no/wrong/?token= token → 401; POST no token → 401. PASS
- R04-E1 Groupchat harness: fail-closed unset token, header-only, turn-taking,
  31st write → 429, reads unlimited, reset guard. 15/15 PASS
- R04-N2 Groupchat checkToken fails open when unset → FOUND RT-002 (LOW),
  fixed, harness + live re-test PASS
- R05-H1 Board / 200 (no ticket data in shell); /health GET 200 / POST 405. PASS
- R05-N1 Board /api/tickets no/wrong key → 401; %FF → 401 (gate precedes decode). PASS
- R05-E1 Board harness (FIX-5): strict follow_up, column honored (201),
  empty/unknown PATCH 400, mark-sent idempotent, %FF 400 generic. 18/18 PASS
- R05-B1 Board authenticated CRUD live → BLOCKED (needs board-key holder)
- R06-H1 Bot Pages root 200; unknown path 404 custom page; /skills/ 200. PASS
- R06-E1 Bot Pages /cost.html → 404 (repo snapshots only, not deployed). OBSERVED
- R07-H1 Activity feed /api/live → 200 up; Wake button calls /ping (source). PASS
- R08-H1 Skills installed (18); skips logged: build-page 14×, github 14×,
  mailbox 18× (token gaps, expected). PASS
- R09-H1 Heartbeat disabled in live config; channels: console only. PASS
- R10-H1 refresh-cost.py + refresh-open-work.py live → exit 0, fresh data. PASS
- R11-H1 token_usage.json present, 2026-11-14/15 kilo entries. PASS
- R12-H1 run-evals.py --dry-run → 5 cases, exit 0. PASS
- R12-B1 run-evals.py live → BLOCKED (needs QWENPAW_USER/QWENPAW_PASS)
- R13-H1 fleet.py list (read-only) → PASS
- R14-H1 workspace-export.py on a COPY → export + verify PASS; import
  overwrite guard PASS; guard refuses copy without agent.json. PASS
- R15-H1 audit-report.py live → 13 rows, log tail, manual log. PASS
- R16-H1 Approvals still AUTO, decision_model null (patch not applied). NOTED
- R17-H1 Email router not in Workers list; metadata DRAFT. PASS (undeployed)
- R18-H1 Relay: no files, no process on machine. PASS (not installed)
- R19-H1 CJK re-grep workspace .md → 0 matches. PASS
- R20-H1 Log: Astra stalls 2 unhandled (30s + 120s), none after 02:13:06 IST;
  mosicn success 02:22:04 IST. OPEN (known)
- R21-H1 Log: sandbox-unavailable warning at container start. OPEN (known)
- R22-H1 Astra chat via astra.py: no response within 100s (×2). OPEN (known)
- R23-B1 Console login + live chat reply → BLOCKED (no browser, no credentials)
- R24-X1 x.com via console browser → NOT RE-TESTED (sibling agent owns it)

## Bugs

- RT-001 (LOW, fixed + live-verified): routines public GETs returned prompt text.
- RT-002 (LOW, fixed + live-verified): groupchat checkToken failed open when unset.
- No S1/S2. Rejected candidates: 7 (see REPORT.md §4).

## Harnesses (in harnesses/)

- routines-harness.mjs 11/11 · groupchat-harness.mjs 15/15 ·
  board-harness.mjs 18/18 · pages-harness.mjs 9/9. Run with `node <file>`.
  All use fake KV/DO storage and marker secrets — no real credentials.
