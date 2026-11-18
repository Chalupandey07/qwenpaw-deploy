# Per-chat thinking selector

A visible Thinking selector in the chat UI, next to the composer
controls — **Default / Off / Low / Medium / High / XHigh** — stored per
chat. User request, 2026-11-18: "add thinking mode per chat enable
disable option xhigh hig,, low medium like i ncoding agent".

## The backend already had it

QwenPaw supports per-chat thinking end to end (verified against the
live container source, not a note):

- `qwenpaw/providers/thinking.py`: `ThinkingLevel` = inherit / off /
  minimal / low / medium / high / xhigh / max / budget.
  `ThinkingPreference` = `{level, budget_tokens?}` (budget_tokens is
  required iff level == "budget").
- `qwenpaw/app/chats/api.py`: `GET /chats/{chat_id}/thinking` and
  `PUT /chats/{chat_id}/thinking` (mounted under `/api`, so the full
  path is `/api/chats/{id}/thinking`). GET returns a view with
  `value.level` (the stored per-chat level), `effective`, `control`
  (kind/efforts/supports_off), `model_key` and `reason`. PUT takes a
  `ThinkingPreference` body, optional `?model_key=`; 409 when the model
  changed since the GET, 422 when the level is invalid for the current
  model. It persists for subsequent turns of THIS session only.
- `GET /api/chats/thinking-default` exposes the agent default for a
  not-yet-created session.

Nothing on the machine was changed. The selector is a pure UI surface
over this API, injected by the `thinking-selector` rule in
`pages/public/_worker.js`.

## How the rule works

- Anchor: the composer toolbar — the parent of the "Context usage"
  button (same anchor as `chat-input-fixes`), falling back to the chat
  input's grandparent. Only on `/chat*` pages.
- It appends (never moves) a "Thinking" label + a native `<select>`
  into the toolbar. React owns the toolbar, so the rule re-creates the
  select on every observer run if React removed it; the select is our
  own element, so re-creating it cannot break React reconciliation
  (the round-17 lesson: no moving text nodes, no wrapping).
- On a chat change it GETs `/api/chats/{id}/thinking` with
  `Authorization: Bearer <qwenpaw_auth_token>` (localStorage, same as
  the Your Keys fix) and shows `value.level`. A second run on the same
  chat fetches nothing.
- On change it PUTs `{level}` with the `model_key` from the last GET
  (the 409 guard). A 409 or 422 re-syncs from the server and reverts
  the select to the stored level. A GET 401 (no token) is a safe no-op.
- A level outside the offered set (minimal/max/budget) is shown by
  adding an option for it, so the select never displays a wrong value.
- Brand-new chat (no id yet): a pick is stored as pending in
  localStorage (`agentx_thinking_pending`) with no fetch, and PUT once
  the first message creates the chat and the URL gains an id. The
  first turn of a brand-new chat therefore still uses the default;
  the second turn uses the pick. (Injecting
  `request_context.session_thinking` into the SPA's first message
  would need hooking the SPA's own fetch — too invasive; the pending
  apply is the safe approach.)

## Quota

Cost is proportional to user action, never to wall clock (AGENTS.md
§6): one GET per chat change, one PUT per user pick. No polling, no
timer, no per-tick fetch. The rule runs on the existing
MutationObserver only.

## Test

`test_thinking_selector.mjs` — 22 checks (T142 in
`features/test-project/run-tests.py`): static checks on the real
`_worker.js` source (rule exists, observer wiring, GET/PUT paths,
Bearer from localStorage, the six options, model_key, no polling,
appendChild-only) + dynamic checks with a DOM mock and a fetch mock
(create/show, PUT on change, no duplicate GET/select, pending on a
new chat, 422 revert, out-of-set level shown truthfully, 401 no-op,
off-chat no-op). Fail-first proven: 20/22 fail against the
pre-feature `_worker.js` (the two passes are the vacuous no-polling
and off-chat no-op checks on an empty rule).

## NOT verified (live)

The browser half is blocked by the 2026-11-18 Workers 1027 outage
(Pages Functions down until the 00:00 UTC reset): after a Pages
deploy, a real browser must set XHigh on one chat and Low on another,
confirm GET reflects each, and confirm a reply still works. Do not
claim the selector works until that check passes.
