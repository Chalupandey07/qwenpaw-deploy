# #17 — Bot email

Status: **Partial.** Worker code is written and syntax-checked. The receive
path is **not verified and cannot be verified yet** — see blockers.

## What was checked live (2026-11-15)

1. **Cloudflare account has zero zones.**
   `GET /client/v4/zones` returned `[]` (account
   `ca85fe3692c3f378200950999df9a35e`). Email Routing and Email Workers both
   require a zone (a domain on Cloudflare). There is no domain to attach a
   route to, and no existing mail to break.
2. **The mailbox skill is currently broken/skipped.** Log line:
   `Skipping skill 'mailbox' in workspace /app/working/workspaces/default:
   MCP server not configured: qwenpawmail`. `config.json` `mcp.clients`
   contains only a disabled `anysearch` client. The mailbox skill is
   Gmail-only via `qwenpawmail-mcp` (16-character Gmail app password after
   2-Step Verification; Chinese providers explicitly unsupported by the
   skill). No Gmail mailbox is connected.
3. **A delivery endpoint into QwenPaw exists and was verified in source:**
   `POST /api/console/chat/task` (Agent API envelope, returns `task_id`),
   auth `POST /api/auth/login` → Bearer token. The Email Worker in
   `workers/email-router/index.js` uses exactly this path.

## What is built

`workers/email-router/index.js` (+ `metadata.json`) — a Cloudflare Email
Worker (email handler, not fetch):

- Parses the incoming RFC 822 message (plain-text body; HTML parts and
  attachments are dropped in v1 and the sender is told so in the delivered
  note — attachments are never executed or stored).
- Rejects mail over 100 KB.
- Treats email content as **untrusted input**: a fixed delivery template
  wraps the sender/subject/body, and the mail can never choose the agent,
  the API path, or the session.
- Delivers via `POST {QWENPAW_URL}/api/console/chat/task` with envelope
  `{channel: "console", user_id: "email:<sender>", session_id: "email-inbox",
  input: [{content: [{type: "text", text: <templated message>}]}], timeout: 300}`.
- Auth (per GPT Astra design review + source verification): logs in **once**,
  caches the token in memory and in KV with a short TTL, re-logs in once on
  401, **stops immediately on 423 lockout** (never retries a lockout),
  honours `Retry-After` on 429. Credentials live only as Worker Secrets
  (`QWENPAW_USER`, `QWENPAW_PASS`) — never in KV, never in code, never
  logged.
- Replies to the sender only with a generic accept/fail note; upstream
  errors are never leaked to the sender.

Syntax-checked with `node --check`. **Not deployed**: deploying it now
would create a Worker with an email handler that can never fire (no zone,
no route), so deployment is deliberately left for the unblock step.

## What is blocked, exactly, and what the user must supply

1. **A domain the user owns, added to this Cloudflare account as a zone**
   (free). Steps: add the domain in Cloudflare dashboard → change the
   domain's nameservers at the registrar to Cloudflare's → wait for the zone
   to become active. No domain = no Email Routing, no Email Worker route.
2. **An Email Routing rule** (free): route `bot@<domain>` (or
   `*@<domain>`) → the `qwenpaw-infra-email` Worker. Created in
   Cloudflare dashboard → Email → Email Routing, or via API once a zone
   exists.
3. **Worker Secrets** (set by the coordinator, never in chat or git):
   `QWENPAW_USER`, `QWENPAW_PASS` (the QwenPaw console login), plus vars
   `QWENPAW_URL` (public console URL) and `STATUS` KV binding for the
   token cache.
4. **A send test**: email the route address from a personal mailbox and
   confirm a task appears in the QwenPaw console (session `email-inbox`).
   Until that test passes, the receive path is unverified — this doc will
   say so until then.

## Alternative that already exists (also needs the user)

Connect Gmail in the QwenPaw console (Settings → mailbox skill →
`qwenpawmail-mcp`): Gmail only, needs a Google account with 2-Step
Verification + a 16-character app password. That gives the agent a mailbox
skill; it does **not** give a bot email address that anyone can mail.
That is a different feature from this one and is the user's call.
