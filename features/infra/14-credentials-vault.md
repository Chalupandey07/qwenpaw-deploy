# #14 — Credentials vault

Status: **Partial (approximation).** There is no protected-card flow in
QwenPaw, and this build does not pretend otherwise. What is built is the
best approximation the platform allows: secrets stay in `working.secret`,
a server-side-only read convention for skills, and a names-only inventory.

## The honest limit

Rakazo-style vaults show a secret as a protected card the agent can use
without the user (or the chat) ever seeing the value. QwenPaw v2.3.0 has
no such mechanism:

- Provider credentials are JSON files under `working.secret/providers/`.
- There is no per-secret access policy, no scoped token, no UI that
  redacts a value while letting a skill use it.
- Any skill code running on the machine can read any file the container
  can read. That is the trust boundary: **the machine is the vault**.
- The `.master_key` file in `working.secret/` is QwenPaw's encryption key
  for credentials it stores encrypted (e.g. mailbox `auth_code`). Name
  only — never copy, share, or print it.

## What is built

### 1. Inventory — `vault-inventory.md` (names only, verified live)

Every secret's **name and location, never its value**. Verified
2026-11-15 by listing directories only.

### 2. Server-side-only read convention (for skills)

This is a rule, not a feature — but it is the rule that keeps secrets out
of chat:

1. A skill that needs a credential reads it **from the file** at run time
   (e.g. `working.secret/providers/custom/xingchiapi.json`), inside the
   container, in code — never by asking the user to paste it into chat,
   and never by echoing it into a reply, a log, or a tool result.
2. The credential value must never appear in: chat text, tool-call
   arguments shown to the user, `qwenpaw.log`, `agent.json`, `config.json`,
   git, or any file under `working/` (as opposed to `working.secret/`).
3. Only the **name** of a credential may be mentioned to the user
   ("using the Kilo key"), never the value, a prefix, or a length.
4. If a skill needs a credential that does not exist yet, it asks the user
   to add it in Console → Settings → Models/Providers (the console writes
   it to `working.secret/`). It does not ask for the value in chat.
5. Rotation: edit/replace the file on the machine (coordinator step),
   then restart the container for the provider manager to pick it up
   (restart requirement assumed, not verified — provider restore runs at
   startup per the log line `Background local model restore completed`).

### 3. What already follows this convention

- The mailbox skill: `agent.json` holds only public mailbox config;
  `auth_code`/`password`/`phone_number` are absent from `agent.json` and
  redacted from API responses; the encrypted credential is resolved into
  a DriverCard only at runtime (per the skill's own SKILL.md).
- LLM provider keys: kept as separate files under
  `working.secret/providers/`; `config.json` `providers` is empty by
  design (verified: `providers` key is absent/`None` in `config.json`).

## What is NOT built (and why)

- No encryption UI, no secret rotation automation, no per-skill scoping.
  All three need changes inside QwenPaw itself (or a sidecar vault
  service, which InstaBox Free cannot run alongside QwenPaw on 1 machine
  without risking the 8 GB RAM budget).
- No backup of `working.secret/` into git or Cloudflare — that would be a
  leak, not a feature. `working.secret/` is covered by machine snapshots
  (`qwenpaw-ready`, `qwenpaw-before-rakazo-build`) and by
  `scripts/backup.sh`; verify snapshot coverage with the coordinator.
