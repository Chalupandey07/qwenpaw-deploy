# TinyFish free web search + fetch (with DuckDuckGo, vault key, built-in fallback)

**Status: skill complete and installed on the machine, enabled.
TinyFish path NOT live-tested — no TinyFish API key has been entered yet.
Fallback path (built-in search/fetch) verified by construction, not by a
live agent run.**

## What this is

A QwenPaw skill (`tinyfish`) that gives the agent two free TinyFish
endpoints — Web Search and Fetch — combined with DuckDuckGo, with the
user's key design:

- **User enters the key.** The TinyFish API key is entered by the user in
  the vault (one item, named `tinyfish`). It is never auto-provisioned,
  never hardcoded, never invented.
- **No key = normal search like now.** When no `tinyfish` item is in the
  vault, the agent uses the built-in `web_search` (AnySearch by default)
  and `web_fetch` (direct HTTP GET + HTML-to-Markdown) exactly as before.
  Nothing about the current behaviour changes.

## The two endpoints (free tier)

| | Search | Fetch |
|---|---|---|
| Host | `https://api.search.tinyfish.ai` | `https://api.fetch.tinyfish.ai` |
| Method | `GET /` (root, query params) | `POST /` (root, JSON body) |
| Auth | `X-API-Key` header | `X-API-Key` header |
| Free allowance | 12,000 requests/day, resets 00:00 UTC | free within its allowance |
| Rate limit | 30 requests/minute (personal) | per-URL timeout, 10 URLs/request max |

Search params (SDK names): `query` (required), `purpose`, `location`,
`language`, `include_domains`, `exclude_domains`, `after_date`,
`before_date`, `recency_minutes`, `domain_type` (`web` / `news` /
`research_paper`), `pub_year_min`, `pub_year_max`, `page` (0–10).
Fetch body: `urls` (1–10, required), `purpose`, `format` (`markdown` /
`html` / `json`, default `markdown`), `links`, `image_links`, `ttl`,
`per_url_timeout_ms`.

### The `/free/...` path question

The user described the endpoints as `/free/search` and `/free/fetch`.
The official TinyFish SDK (v0.11.0, read from the published wheel) calls
the ROOT path `/` on each product host — `product_url("search")` returns
`https://api.search.tinyfish.ai/` and `product_url("fetch")` returns
`https://api.fetch.tinyfish.ai/` — and the official fetch reference shows
`POST https://api.fetch.tinyfish.ai/`. A no-key probe cannot distinguish
paths (the auth gate returns 401 before routing; a bogus path also
returns 401). So the skill uses the SDK root paths first, and tells the
agent: if a call with a real key returns 404, retry once at
`/free/search` / `/free/fetch` on `https://api.search.tinyfish.ai` and
report which path worked. The README will be corrected when a live key
proves the path.

## What "normal search like now" is (verified in source)

- **Search:** the built-in `web_search` tool
  (`qwenpaw/agents/tools/web_search.py`) delegates to a pluggable
  provider (`websearch/factory.py`). Default is **AnySearch**
  (`https://api.anysearch.com/v1/search`), which works without a key
  (it auto-registers on 402). Tavily or Firecrawl only when the console
  tool config selects them (both need keys).
- **Fetch:** the built-in `web_fetch` tool does a direct HTTP GET with
  httpx + a stdlib HTML-to-Markdown converter. No external API.

## DuckDuckGo (verified live 2026-11-18 from the container)

- `html.duckduckgo.com` and `lite.duckduckgo.com` are **anomaly-blocked**
  from this machine: a real query returns 0 results and 67 "anomaly"
  matches. Do NOT scrape them.
- The **Instant Answer API** (`https://api.duckduckgo.com/?q=...&
  format=json&no_html=1`) **works** (returns an `Abstract`). It gives a
  quick abstract for factual topics but NOT ranked web results, so it is
  a complement, never a replacement for TinyFish or the built-in search.
- The `ddgs` Python package is NOT installed in the container and would
  hit the same anomaly block (it uses the same DDG endpoints), so it was
  not installed.

## Key design (vault)

- ONE vault item, named `tinyfish`. The user pastes the TinyFish API key
  once (from agent.tinyfish.ai, the API Keys page). The same key works
  for both hosts, which is why the skill calls both through the broker's
  `/run` endpoint (one item, both hosts) instead of `/request` (which
  pins one origin per item — that would need the key pasted twice).
- The skill calls the broker's `/run` with `argv: ["sh", "-c", "curl
  ..."]` so the shell expands `$TINYFISH` (a bare argv list does NOT
  expand environment variables). The broker exports the key as
  `$TINYFISH`, runs curl on the host, and redacts the key from the
  output. The agent never sees the value.
- Vault item setup (user, via `/vault` or the in-chat popup): pick
  **Custom**, name `tinyfish`, kind `header`, header name `X-API-Key`,
  origin `https://api.search.tinyfish.ai`, paste the key.
- The vault provider presets do NOT include TinyFish yet (the list is
  Cloudflare, DeepSeek, GitHub, Google Gemini, Groq, Hugging Face,
  Mistral, OpenAI, OpenRouter, Slack, xAI, Custom). Adding a TinyFish
  preset to `_worker.js` + `vault.js` is a small follow-up, not done here.

## Error handling (in the skill)

- `401` — key invalid; tell the user to check/re-enter it; fall back.
- `402` — daily free allowance used (resets 00:00 UTC); tell the user;
  fall back; do NOT retry.
- `429` — per-minute limit or allowance exhausted; fall back; at most
  one retry after 60s.
- `404` — path note above: retry once at `/free/...`, then fall back.
- `5xx` — fall back, one retry at most.
- Never present an error as a successful search. Never fabricate results.

## Files

| File | What it is |
|---|---|
| `features/tinyfish/SKILL.md` | The skill (installed on the machine). |
| `features/tinyfish/README.md` | This file. |
| `features/tinyfish/test_tinyfish.py` | Machine-free selftest (T85): request-building, URL/param encoding, fallback decision, error mapping. Mocks the HTTP layer — never calls the live API. |

Machine paths: skill installed at
`/data/home/qwenpaw/working/workspaces/default/skills/tinyfish/SKILL.md`,
enabled via `docker exec qwenpaw qwenpaw skills enable tinyfish`.

## What was verified, and what was not

Verified live (2026-11-18):
- TinyFish `/free/search` and `/free/fetch` on `api.search.tinyfish.ai`
  return 401 `MISSING_API_KEY` without a key (a key IS required even
  for the free tier). A bogus path also returns 401, so this proves the
  auth gate, not the path.
- DuckDuckGo Instant Answer API works from the container (returns an
  `Abstract`). DDG HTML/lite are anomaly-blocked (0 results).
- Vault broker `/list` shows only the `github` item — no `tinyfish`
  item exists yet, so the TinyFish path cannot be live-tested until the
  user enters a key.
- The broker's `/run` exports a named vault item as `$VAR` and runs the
  command (verified with the `github` item: the key length is visible to
  the child, the value is redacted from the output).
- The built-in `web_search` default is AnySearch and `web_fetch` is a
  direct GET (read from the container source).
- The official TinyFish SDK (v0.11.0) uses root `/` on each product
  host with `X-API-Key` (read from the published wheel).

NOT verified:
- **The TinyFish path with a real key.** No key has been entered. The
  search/fetch calls, the response parsing, and the root-vs-`/free/`
  path question are unproven until the user enters a `tinyfish` key and
  the agent runs a real search + fetch.
- **A live agent run using the skill.** The skill is installed and
  enabled, but no agent conversation has used it yet. That needs a
  browser test (parent) after the key is entered.
- The machine-free selftest (T85) passes, but it mocks HTTP — it proves
  the request-building and fallback logic, not the live API.

## Deliberately not done

- **No Monid gateway.** Monid routes the same endpoints as PAID calls
  ($0.0050/search, $0.0010/fetch result). This skill uses the DIRECT
  TinyFish free endpoints only.
- **No TinyFish preset in the vault UI.** Custom covers it; a preset is
  a follow-up.
- **No `ddgs` install.** It would hit the same DDG anomaly block.
- **No change to the built-in `web_search` / `web_fetch` tools.** The
  fallback is the existing tools, untouched.
- **No claim that TinyFish works.** It has never run against the real
  API with a key.
