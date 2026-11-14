# #9 — Spaces / Access

Status: **Partial (design only — NOT enforced).** Nothing in this item
changes who can reach QwenPaw today. It prepares the design so enforcement
is a small, reviewed step once the prerequisites exist.

## What was checked live (2026-11-15)

1. **Cloudflare account has zero zones** (`GET /client/v4/zones` → `[]`).
   Cloudflare Access (Zero Trust) policies attach to applications on a
   zone or a custom domain. The console is reached via
   `qwenpawx.pages.dev` (Cloudflare's zone, not the user's) and the raw
   InstaBox URL — neither can take an Access policy from this account.
   Enforcement is impossible until a custom domain exists.
2. **QwenPaw has single-user auth, no per-user RBAC.** Verified:
   `POST /api/auth/login` takes one username/password; the account is
   `satwik`. There is a channel-level allow-list mechanism
   (`allow_from`, `access_control_dm/group` per channel in `agent.json`),
   and an `access_control.py` router, but no concept of "person A sees
   space X, person B sees space Y".
3. **Multi-agent exists, multi-person does not.** `config.json` has two
   agent profiles (`default`, `QwenPaw_QA_Agent_0.2`), both enabled.
   Workspaces are per-agent, not per-person.

## What is built

### 1. Access policy design (draft only)

`access-policy-draft.json` — a Cloudflare Access application + policy
draft for the future custom domain. **Not applied.** Design:

- Application: the console on the custom domain (e.g.
  `qwenpaw.<user-domain>`), covering the Pages proxy.
- Policy 1 (allow): the user's email (the one the user will confirm),
  session 24 h, no service token.
- Policy 2 (deny): everyone else.
- Explicitly **not** included: device posture checks, Warp requirement,
  or Service Auth — too easy to lock the user out.
- Rule (hard): never enable enforcement without the user testing the
  login path first on a separate application (e.g. the `/status` page),
  and never apply it to the raw InstaBox URL (Access cannot cover it).

### 2. Per-space workspace mapping (draft)

A "space" here means one agent workspace with its own prompts, memory,
and channels. Mapping today:

| Space | Workspace | Who | Status |
|-------|-----------|-----|--------|
| Personal | `default` | Rohan | Live |
| QA / setup help | `QwenPaw_QA_Agent_0.2` | Rohan | Live |
| Research | `research-assistant` (template) | Rohan | Template only, not installed |
| Household | `household-manager` (template) | Rohan | Template only, not installed |
| Code | `code-helper` (template) | Rohan | Template only, not installed |

All spaces belong to one person. That is the honest scope of "spaces" in
QwenPaw: **one user, many agents**. True per-person spaces (family
members, teammates, each with private memory) need a different app —
QwenPaw cannot do it, and no Access policy can add it: Access controls
who reaches the front door, not what they see inside.

## What is blocked, exactly

1. **Custom domain on Cloudflare** (user-owned domain added as a zone,
   free) + Pages custom domain pointing at `qwenpawx.pages.dev`.
   Until then, no Access application can exist.
2. **User's email address** for the allow policy (to be confirmed by the
   user — not guessed).
3. **A tested login path**: apply Access to a throwaway path first, log in
   as the user, then move it to the console. Never enforce blind.
4. **Per-person spaces**: needs a different application. Do not promise it.

## What NOT to do

- Do not enable Cloudflare Access on any URL the user currently uses
  without a tested rollback (removing the policy). Lockout risk is real
  and this build does not take it.
- Do not use the raw InstaBox URL as the "private" path: it is public,
  and QwenPaw auth is the only gate there.
