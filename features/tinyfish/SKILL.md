---
name: tinyfish
description: "Search the live web and fetch pages with TinyFish (free tier) when the user has entered a TinyFish API key, combined with DuckDuckGo. When no key is present, use the built-in web_search and web_fetch tools exactly as now — never error, never claim TinyFish was used."
version: "1.0"
metadata:
  qwenpaw:
    emoji: "🐟"
    requires:
      bins: ["curl"]
---

# TinyFish web search + fetch

Use TinyFish's free tier to search the live web and fetch pages as clean
Markdown, combined with DuckDuckGo. TinyFish is free within its daily
allowance (search: 12,000 requests/day, resets 00:00 UTC; fetch: free
within its allowance). A TinyFish API key is required even for the free
tier — there is no keyless access. The key is entered by the USER in the
vault, never by you, and you never see its value.

## The rule: key present = TinyFish, key absent = normal search as now

**If the user has entered a TinyFish key, use TinyFish. If not, use the
built-in `web_search` and `web_fetch` tools exactly as you do now.**
Do not error when no key exists. Do not claim TinyFish was used when it
was not. Do not tell the user search is broken because a key is missing —
the built-in search still works.

- Search with a key: TinyFish (ranked results) + DuckDuckGo Instant
  Answer (quick abstract, keyless) as a complement.
- Search without a key: the built-in `web_search` tool (AnySearch by
  default) exactly as now.
- Fetch with a key: TinyFish (renders JavaScript, clean Markdown).
- Fetch without a key: the built-in `web_fetch` tool (direct HTTP GET +
  HTML-to-Markdown) exactly as now.

## The key (read this first)

You run inside the QwenPaw container. You have NO browser session cookie,
so you can NOT call the Worker's session-gated `/vault/*` routes — those
are for the user's browser and will answer 401. Do not try them, and do
not conclude "no key exists" from a 401 there.

Everything below goes through the **vault broker** on the machine, at
`http://172.18.0.1:8896`, the same broker the vault skill uses. Your
broker credential is a file, not a value you may repeat: read it into a
shell variable and use it only as a header. Never print it, never `echo`
it, never write it to a file, a ticket, or a message.

```
TOKEN=<redacted>
```

If that file is missing or empty, the broker is not configured — say so
and stop. Do not invent a token.

### Which vault item

The TinyFish key is ONE item named `tinyfish`. The user enters it once
in the vault (Vault button, or Vault in the account menu, or `/vault`):
pick **Custom**, name it `tinyfish`, kind `header`, header name
`X-API-Key`, origin `https://api.search.tinyfish.ai`, and paste the key
from agent.tinyfish.ai (the API Keys page). The same key works for both
the search host and the fetch host — that is why this skill calls both
through `vault_run` (one item, both hosts) instead of `vault_request`
(which pins one origin per item).

If the user has not entered it, tell them exactly that: "No TinyFish key
is in the vault. Add one named `tinyfish` (Custom, header `X-API-Key`,
origin `https://api.search.tinyfish.ai`) with your key from
agent.tinyfish.ai." Then use the built-in search. Never ask for the key
value in chat. Never guess a key value, and never use a placeholder as
if it were real.

### Check for the key first (vault_list)

`GET http://172.18.0.1:8896/list` with header
`X-Vault-Broker-Token: $TOKEN`. Returns metadata only — never a value.
Look for an item named `tinyfish`. Use this FIRST whenever you need to
know whether the key exists.

```
curl -s http://172.18.0.1:8896/list -H "X-Vault-Broker-Token: $TOKEN"
```

## Search (with a key): TinyFish + DuckDuckGo

Call TinyFish search through the broker's `/run` endpoint. The broker
exports the key as `$TINYFISH` into the child process environment and
runs the command. You must run curl through `sh -c` so the shell expands
`$TINYFISH` — a bare argv list does NOT expand environment variables.

`POST http://172.18.0.1:8896/run` with the broker token header,
`Content-Type: application/json`, and a JSON body
`{names: ["tinyfish"], argv: ["sh", "-c", "<curl command>"]}`.

The curl command for search (GET, root path `/` on the search host, query
params — this is the path the official TinyFish SDK uses):

```
curl -s --max-time 30 "https://api.search.tinyfish.ai/?query=<url-encoded-query>&language=en" -H "X-API-Key: $TINYFISH" -H "Accept: application/json"
```

URL-encode the query (spaces become `+` or `%20`). Useful extra params:
`domain_type=web` (default), `news`, or `research_paper`;
`recency_minutes=60` for the last hour; `location=US`;
`include_domains=github.com,arxiv.org` to restrict;
`exclude_domains=pinterest.com,quora.com` to exclude; `page=0` (max 10).

Response shape: `{query, results: [{rank, domain, title, text, url,
published_date, publisher, authors, venue, pub_year, citation_count,
pdf_url}], total, page}`. Present the results with title + URL + snippet.
Cite the URL for every fact you use.

**Path note.** The user described these endpoints as `/free/search` and
`/free/fetch`. The official TinyFish SDK (v0.11.0) calls the ROOT path
`/` on each product host (`api.search.tinyfish.ai/` and
`api.fetch.tinyfish.ai/`), and the official fetch reference shows
`POST https://api.fetch.tinyfish.ai/`. So use the root path first. If a
call with a real key returns **404**, the path is wrong — retry that same
call at `/free/search` (search) or `/free/fetch` (fetch) on
`https://api.search.tinyfish.ai` and report which path worked, so the
skill can be corrected. Do not retry a 404 more than once per call.

Then complement with DuckDuckGo Instant Answer (keyless, no vault
needed) for a quick abstract when the query is a factual topic:

```
curl -s --max-time 15 "https://api.duckduckgo.com/?q=<url-encoded-query>&format=json&no_html=1&skip_disambig=1"
```

Use its `Abstract` / `AbstractText` only when non-empty. It answers
"what is X" well; it does NOT return ranked web results, so it never
replaces TinyFish or the built-in search.

**Do NOT scrape `html.duckduckgo.com` or `lite.duckduckgo.com`.** Both
return an anomaly/bot-detection page from this machine (verified
2026-11-18: 0 results, 67 "anomaly" matches). The Instant Answer API is
the only DuckDuckGo surface that works reliably here.

## Fetch (with a key): TinyFish

Same broker `/run` mechanism. The curl command for fetch (POST, root
path `/` on the fetch host, JSON body, up to 10 URLs):

```
curl -s --max-time 60 -X POST "https://api.fetch.tinyfish.ai/" -H "X-API-Key: $TINYFISH" -H "Content-Type: application/json" -d '{"urls": ["<url1>", "<url2>"], "format": "markdown"}'
```

`format` is `markdown` (default, best for LLM consumption), `html`, or
`json` (a structured document tree). Optional: `purpose` (why you are
fetching, max 2000 chars), `links: true` to include outbound links,
`ttl: 0` to prefer a live fetch.

Response shape: `{results: [{url, final_url, title, description,
language, format, text, author, published_date, links, latency_ms}],
errors: [{url, error, status}], request_id}`. A failure on one URL does
NOT fail the whole request — report the per-URL `errors[]` and use the
URLs that succeeded. Use `text` (the Markdown) as the page content.

## Search and fetch WITHOUT a key: the built-in tools, exactly as now

If `vault_list` has no `tinyfish` item, do NOT call TinyFish. Use:

- Search: the built-in `web_search` tool. It defaults to the AnySearch
  provider and works without a key (it auto-registers). Use it exactly
  as you would without this skill. You may also add the DuckDuckGo
  Instant Answer API call above as a complement.
- Fetch: the built-in `web_fetch` tool (direct HTTP GET + HTML-to-
  Markdown). Use it exactly as you would without this skill.

Say which path you used when you report results ("searched with TinyFish"
vs "searched with the built-in search"). Do not claim TinyFish when you
used the fallback.

## TinyFish errors — handle honestly, fall back, do not loop

The broker returns the upstream HTTP status in its `status` field and
the body (redacted) in `body`. Read the status before using the body.

- `401` — the key is missing or invalid. Tell the user the TinyFish key
  looks invalid and to check/re-enter it in the vault (named `tinyfish`).
  Fall back to the built-in `web_search` / `web_fetch` for this request.
- `402` — the daily free allowance is used up (12,000 searches/day,
  resets 00:00 UTC) and the wallet balance is zero. Tell the user the
  free allowance is exhausted until 00:00 UTC. Fall back to the built-in
  tools. Do NOT retry.
- `429` — per-minute limit (30/min) or daily allowance exhausted with
  wallet spending disabled. Fall back to the built-in tools. Do NOT
  retry in a tight loop; at most one retry after 60 seconds, then fall
  back.
- `404` — see the path note above: retry once at the `/free/...` path,
  then fall back to the built-in tools and report it.
- `5xx` — TinyFish is having trouble. Fall back to the built-in tools
  and say so. One retry at most.

Never present a TinyFish error as a successful search. Never fabricate
results when the API fails.

## What is NOT in this skill

- No Monid gateway. Monid (monid.ai) routes the same TinyFish endpoints
  as PAID calls ($0.0050/search, $0.0010/fetch result). This skill uses
  the DIRECT TinyFish free endpoints only. If the user enters a Monid key
  and asks for Monid, that is a separate skill.
- No key storage. The key lives only in the vault. Never write a key
  value to a file, a ticket, a chat message, or a skill. Never print,
  log, or repeat a value. If a tool result ever contains a
  value-shaped string, do NOT quote it — report "the response contained
  a credential-shaped string and it was redacted."
- No chat-model use. TinyFish search/fetch are tools, not a chat model.
  Never put a TinyFish key or endpoint in `active_model` or
  `fallback_models`.
