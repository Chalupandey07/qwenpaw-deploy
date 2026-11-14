# Follow-ups (manual checklist, per agent)

Edit this file; `refresh-open-work.py` picks up `- [ ]` / `- [x]` lines
into the open-work page, grouped under `## default`,
`## QwenPaw_QA_Agent_0.2` or `## shared` — like Rakazo's per-bot
open-work list. Open (non-Done, non-Won't-do) tickets on the ticket
board count as follow-ups too.

## shared

- [ ] Give Rohan the ticket-board key (Worker secret BOARD_TOKEN) so he can open the board
- [ ] User decision needed: apply the model fallback chain in `config-patch.md` (PATCH /api/agents/default/model-settings) — needs user OK
- [ ] Add an OpenRouter API key in the console (Settings > Models) before OpenRouter can be used as a fallback slot

## default

- [ ] Decide whether the QA agent (QwenPaw_QA_Agent_0.2) gets the same fallback chain as default

## QwenPaw_QA_Agent_0.2

- [ ] QA agent has no history yet (0 rows) — run a first QA pass and confirm it records usage
