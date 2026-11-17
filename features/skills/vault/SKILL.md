# Vault skill

Use the vault when you need to call an external API or run a command that
needs an API key — GitHub, Cloudflare, or any custom key the user has
stored. The vault lets you USE a key without ever SEEING its value.

## The rule

**Names, never values.** You send the key NAME and what you want done. The
server builds the request with the real key itself, and every byte coming
back to you passes a redactor. You never see the header or the value.

- Never ask the user for a key value in chat. If a key is missing, send
  them to the Vault page (`/vault` on the console) and say which name you
  need.
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

## Tools

### vault_list — names only
Lists the vault items by name, kind, origin, title, and policy. Returns
metadata only: never a value, never a ciphertext, never a row id. Use it
to find the name of the key you need.

### vault_request — call an API with a stored key
`POST /vault/request` {name, url, method?, body?, contentType?}. The
server checks the item's policy and origin pin, decrypts the key
server-side, builds the Authorization header itself, and returns
{status, headers?, body, truncated} with the key redacted from every byte.

- The URL MUST be on the item's pinned origin (e.g. a `github-api` item
  pinned to `https://api.github.com` can only call that origin). A
  different origin is refused, and no use is recorded.
- `command` items cannot be used here — they are env-only, use
  `vault_run`.
- An item whose policy is `off` is refused.

Example: to list the user's repositories with the stored GitHub key:
`vault_request {name: "github-api", url: "https://api.github.com/user/repos", method: "GET"}`.

### vault_run — run a command with keys in its environment
`POST /run` {names, argv} to the machine broker. The broker fetches each
named value from the Worker over a mutually-authenticated channel, exports
it as `$VAR` into the child process environment (name `github-api` →
`GITHUB_API`), runs the command, and scrubs the output before returning
it. The value never enters your process, context, or any log.

Example: `vault_run {names: ["github-api"], argv: ["gh", "repo", "list"]}`.

## What is NOT in the vault

- QwenPaw provider keys live in `working.secret/providers/` — QwenPaw owns
  that format. Do not move them. The vault is for keys the AGENT uses
  (GitHub, Cloudflare, custom).
- No login/card kinds in v1. Browser-fill is a separate design.
- The vault does not remove the machine-trust boundary: a skill that
  bypasses the broker can still read files on the machine. The vault gives
  you the SAFE path. Use it.
