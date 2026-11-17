# Vault skill

Use the vault when you need to call an external API or run a command that
needs an API key — GitHub, Cloudflare, or any custom key the user has
stored. The vault lets you USE a key without ever SEEING its value.

## The rule

**Names, never values.** You send the key NAME and what you want done. The
server builds the request with the real key itself, and every byte coming
back to you passes a redactor. You never see the header or the value.

- Never ask the user for a key value in chat. If a key is missing, tell
  them to click the Vault button (bottom-right of the console, or Vault in
  the account menu) — a secure popup opens right in the chat where they can
  add the key without leaving the page. Say which name you need. The full
  Vault page (`/vault` on the console) is linked from the popup for
  managing existing keys.
- Never print, log, or repeat a value. Never write a value to a file, a
  ticket, a chat message, or a skill.
- Never guess a key value, and never use a placeholder as if it were real.
  If you do not have a key, say so.
- If a tool result ever contains a value-shaped string, do NOT quote it.
  Report: "the response contained a credential-shaped string and it was
  redacted."
- If a command you run needs a key, run it THROUGH the broker
  (`vault_run`), never by reading the key from a file yourself. A skill
  that shells out on its own and reads `working.secret/` directly bypasses
  the vault and breaks the guarantee — that path exists on the machine, and
  the vault exists so you never need it.

## How you reach the vault (read this first)

You run inside the QwenPaw container. You have NO browser session cookie,
so you can NOT call the Worker's `/vault/list` or `/vault/request` — those
are session-gated for the user's browser and will answer 401. Do not try
them, and do not conclude "no key exists" from a 401 there.

Everything below goes through the **vault broker** on the machine, at
`http://172.18.0.1:8896`. It is the agent-facing side of the vault: it
fetches values from the Worker over a mutually-authenticated channel,
uses them, and scrubs every byte before returning it to you.

Your broker credential is a file, not a value you may repeat:
read it into a shell variable and use it only as a header. Never print
it, never `echo` it, never write it to a file, a ticket, or a message.

```
TOKEN=$(cat /app/working.secret/vault-broker.token)
```

If that file is missing or empty, the broker is not configured — say so
and stop. Do not invent a token.

## Tools

All three are plain `curl` calls to the broker. `Content-Type:
application/json` on every POST.

### vault_list — names only
`GET http://172.18.0.1:8896/list` with header
`X-Vault-Broker-Token: $TOKEN`. Returns `{items: [{name, kind, origin,
title, policy, scope}]}` — metadata only: never a value, never a
ciphertext, never a row id. Use it FIRST whenever you need to know
whether a key exists and what it is called.

```
curl -s http://172.18.0.1:8896/list -H "X-Vault-Broker-Token: $TOKEN"
```

### vault_request — call an API with a stored key
`POST http://172.18.0.1:8896/request` with the broker token header and a
JSON body `{name, url, method?, body?, contentType?}`. The broker checks
the item's policy and origin pin, decrypts the key server-side, builds
the Authorization header itself, and returns `{status, headers?, body,
truncated}` with the key redacted from every byte.

- The URL MUST be on the item's pinned origin (e.g. a `github-api` item
  pinned to `https://api.github.com` can only call that origin). A
  different origin is refused, and no use is recorded.
- `command` items cannot be used here — they are env-only, use
  `vault_run`.
- An item whose policy is `off` is refused.

```
curl -s -X POST http://172.18.0.1:8896/request \
  -H "X-Vault-Broker-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"github-api","url":"https://api.github.com/user/repos","method":"GET"}'
```

### vault_run — run a command with keys in its environment
`POST http://172.18.0.1:8896/run` with the broker token header and a JSON
body `{names, argv, cwd?, timeoutSeconds?}`. The broker fetches each
named value from the Worker over a mutually-authenticated channel, exports
it as `$VAR` into the child process environment (name `github-api` →
`GITHUB_API`), runs the command, and scrubs the output before returning
it. The value never enters your process, context, or any log.

```
curl -s -X POST http://172.18.0.1:8896/run \
  -H "X-Vault-Broker-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"names":["github-api"],"argv":["gh","repo","list"]}'
```

## Answering "do you have access to my account?"

Do NOT answer from `/app/working.secret/` — that directory holds
QwenPaw's own auth data, the Camoufox bridge token, and QwenPaw's LLM
provider keys. A GitHub/Cloudflare key is NOT supposed to be there; its
absence there proves nothing.

1. Call `vault_list` first. That is the only true answer to whether a
   key exists.
2. If a key for that service exists (e.g. `github-api` pinned to
   `https://api.github.com`), say yes — and prove it by calling the
   service's own identity endpoint through `vault_request` (GitHub:
   `GET https://api.github.com/user`), which tells you whose account
   the key belongs to. Report the username the API returns.
3. If no key for that service exists, say so plainly: "No GitHub key is
   in the vault." Then tell the user to add one — Vault button, pick the
   provider from the dropdown (GitHub, Cloudflare, … or Custom), name
   it, paste the key. Do NOT tell them to export a token into the
   environment or to put it in `envs.json` — the vault is where keys go.

## Provider presets — the agent can prepare

The add-key form (popup and `/vault` page) has a Provider dropdown:
GitHub, Cloudflare, OpenAI, Google Gemini, DeepSeek, Groq, Mistral, xAI,
OpenRouter, Hugging Face, Slack, and Custom. Picking a provider fills in
the kind, the origin and the header name itself, and suggests a name and
a title when those are empty — so the user only types a name and pastes
the key. Custom leaves every field for the user to fill in. Pasting an
API origin that matches a preset picks that provider by itself.

When the user tells you the site — "my GitHub key", "add a key for
example.com" — prepare it for them: name the provider they should pick
from the dropdown (or Custom when it is not listed), and the name to use.
You never need the value, and you never ask for it. If the site is not
in the list, say Custom and tell them the origin to type (the bare
`https://` origin of the API they will call).

## What is NOT in the vault

- QwenPaw provider keys live in `working.secret/providers/` — QwenPaw owns
  that format. Do not move them. The vault is for keys the AGENT uses
  (GitHub, Cloudflare, custom).
- No login/card kinds in v1. Browser-fill is a separate design.
- The vault does not remove the machine-trust boundary: a skill that
  bypasses the broker can still read files on the machine. The vault gives
  you the SAFE path. Use it.
