---
name: tinyfish
description: "Search the live web and fetch pages with TinyFish (free tier) when the user has entered a TinyFish API key in Settings, combined with DuckDuckGo. When no key is present, use the built-in web_search and web_fetch tools exactly as now — never error, never claim TinyFish was used."
version: "2.0"
metadata:
  qwenpaw:
    emoji: "🐟"
    requires:
      bins: ["python3"]
---

# TinyFish web search + fetch

Use TinyFish's free tier to search the live web and fetch pages as clean
Markdown, combined with DuckDuckGo. TinyFish is free within its daily
allowance (search: 12,000 requests/day, resets 00:00 UTC; fetch: free
within its allowance). A TinyFish API key is required even for the free
tier — there is no keyless access. The key is entered by the USER in
Settings, never by you, and you never see its value.

## The rule: key present = TinyFish, key absent = normal search as now

**If the user has entered a TinyFish key, use TinyFish. If not, use the
built-in `web_search` and `web_fetch` tools exactly as you do now.**
When no key exists, use the built-in tools and say so plainly — for
example: "No TinyFish key is in Settings, so I searched with the
built-in search." Always report which search you actually used. The
built-in search still works without a key.

- Search with a key: TinyFish (ranked results) + DuckDuckGo Instant
  Answer (quick abstract, keyless) as a complement.
- Search without a key: the built-in `web_search` tool (AnySearch by
  default) exactly as now.
- Fetch with a key: TinyFish (renders JavaScript, clean Markdown).
- Fetch without a key: the built-in `web_fetch` tool (direct HTTP GET +
  HTML-to-Markdown) exactly as now.

## The key (read this first)

The key is an environment variable, `TINYFISH_API_KEY`. The user sets
it in Console → **Settings → Environments** ("+ Add Variable", name
`TINYFISH_API_KEY`, paste the key from agent.tinyfish.ai, the API Keys
page, then Save). The console backend writes it, encrypted, to
`working.secret/envs.json` (mode 600) and syncs it into the running
process environment at once — no restart. You read it from your own
process environment at runtime. **The vault is NOT used for this key.**
The vault holds only connectors; a provider/service key like this one
belongs in Settings.

### Why the key is NOT declared in require_envs

Do NOT add `TINYFISH_API_KEY` (or the feature flags below) to this
skill's `requires.env` frontmatter. QwenPaw skips a skill whose
declared `require_envs` are unmet, so declaring the key required would
disable this skill whenever no key is set — and this skill must keep
working without a key (built-in fallback). The key and the flags are
OPTIONAL env vars, read from `os.environ` with safe defaults. The
frontmatter declares only `bins: ["python3"]`. This is deliberate, not
an omission.

### How you read the key

You run inside the QwenPaw container, and the key is already in your
process environment (loaded from `envs.json` at startup, and synced at
once whenever the user saves it in Settings). Read it from
`os.environ` inside the python process that makes the call:

```python
key = os.environ.get("TINYFISH_API_KEY", "").strip()
```

If `key` is empty, there is no TinyFish key — use the built-in tools
and say so. Never ask the user for the key value in chat. Never guess
a key value, and never use a placeholder as if it were real.

**Never print, log, echo, or write the key value.** Never put it in a
chat message, a ticket, a file, or a tool result. If a tool result ever
contains a value-shaped string, do NOT quote it — report "the response
contained a credential-shaped string and it was redacted."

### Never put the key in a shell command

Do NOT call TinyFish with curl and a header built from a shell
variable. The shell would expand the variable into curl's argument
list, and the key would sit in the process arguments where any process
listing could read it. Call TinyFish with **python3** (stdlib urllib)
and read the key from `os.environ` inside the python process, so the
key never appears in any command string, argument list, or log. The
templates below do exactly that.

## Feature selection (the Search section)

The user picks which search features are on in the **Search section**
of Settings (injected into the Settings page): a key field, and three
checkboxes — TinyFish search, TinyFish fetch, DuckDuckGo Instant
Answer. The section saves them as environment variables through the
console's own endpoint, `PATCH /api/envs` (merge — it only touches
the variables it sends, never the others; never PUT, which would
replace ALL environment variables). The variables are:

| Env var | Meaning | Default when absent |
|---|---|---|
| `TINYFISH_API_KEY` | the TinyFish API key | (none — no key) |
| `TINYFISH_SEARCH` | use TinyFish for search | `1` (on) |
| `TINYFISH_FETCH` | use TinyFish for fetch | `1` (on) |
| `TINYFISH_DDG_IA` | complement with DuckDuckGo Instant Answer | `1` (on) |

A flag is off only when its value is `0`, `false`, `no`, or `off`
(any case). Absent or empty means on. **The built-in search is NOT a
flag and can never be turned off** — it is the fallback, and the
fallback must always exist.

- If the key is set and `TINYFISH_SEARCH` is on, search with TinyFish.
  If the key is missing, or `TINYFISH_SEARCH` is off, search with the
  built-in `web_search` — even when a key is set.
- If the key is set and `TINYFISH_FETCH` is on, fetch with TinyFish.
  If the key is missing, or `TINYFISH_FETCH` is off, fetch with the
  built-in `web_fetch` — even when a key is set.
- If `TINYFISH_DDG_IA` is on, complement a search with the DuckDuckGo
  Instant Answer API (below). If it is off, skip it.

To remove the key, the Search section calls
`DELETE /api/envs/TINYFISH_API_KEY`. The section never displays the
key value — it shows only whether a key is saved.

## Search (with a key): TinyFish + DuckDuckGo

Call TinyFish with python3. The key comes from `os.environ` inside
the python process. Run the script through a heredoc (quoted
delimiter, so the shell does not expand anything inside it):

```python
python3 - <<'PYEOF'
import json, os, urllib.parse, urllib.request
key = os.environ.get("TINYFISH_API_KEY", "").strip()
if not key:
    print(json.dumps({"error": "no_key"}))
    raise SystemExit(0)
query = "<the search query>"
params = {"query": query, "language": "en"}
url = "https://api.search.tinyfish.ai/?" + urllib.parse.urlencode(params)
req = urllib.request.Request(url, headers={
    "X-API-Key": key, "Accept": "application/json"})
with urllib.request.urlopen(req, timeout=30) as resp:
    print(resp.read().decode())
PYEOF
```

Useful extra params: `domain_type=web` (default), `news`, or
`research_paper`; `recency_minutes=60` for the last hour;
`location=US`; `include_domains=github.com,arxiv.org` to restrict;
`exclude_domains=pinterest.com,quora.com` to exclude; `page=0`
(max 10).

Response shape: `{query, results: [{rank, domain, title, text, url,
published_date, publisher, authors, venue, pub_year, citation_count,
pdf_url}], total, page}`. Present the results with title + URL +
snippet. Cite the URL for every fact you use.

**Path note.** The user described these endpoints as `/free/search` and
`/free/fetch`. The official TinyFish SDK (v0.11.0) calls the ROOT path
`/` on each product host (`api.search.tinyfish.ai/` and
`api.fetch.tinyfish.ai/`), and the official fetch reference shows
`POST https://api.fetch.tinyfish.ai/`. So use the root path first. If a
call with a real key returns **404**, the path is wrong — retry that same
call at `/free/search` (search) or `/free/fetch` (fetch) on
`https://api.search.tinyfish.ai` and report which path worked, so the
skill can be corrected. Do not retry a 404 more than once per call.

Then complement with DuckDuckGo Instant Answer (keyless) for a quick
abstract when the query is a factual topic and `TINYFISH_DDG_IA` is on:

```python
python3 - <<'PYEOF'
import json, urllib.parse, urllib.request
query = "<the search query>"
params = {"q": query, "format": "json", "no_html": "1",
          "skip_disambig": "1"}
url = "https://api.duckduckgo.com/?" + urllib.parse.urlencode(params)
with urllib.request.urlopen(url, timeout=15) as resp:
    print(resp.read().decode())
PYEOF
```

Use its `Abstract` / `AbstractText` only when non-empty. It answers
"what is X" well; it does NOT return ranked web results, so it never
replaces TinyFish or the built-in search.

**Do NOT scrape `html.duckduckgo.com` or `lite.duckduckgo.com`.** Both
return an anomaly/bot-detection page from this machine (verified
2026-11-18: 0 results, 67 "anomaly" matches). The Instant Answer API is
the only DuckDuckGo surface that works reliably here.

## Fetch (with a key): TinyFish

Same python mechanism. The fetch call (POST, root path `/` on the
fetch host, JSON body, up to 10 URLs):

```python
python3 - <<'PYEOF'
import json, os, urllib.request
key = os.environ.get("TINYFISH_API_KEY", "").strip()
if not key:
    print(json.dumps({"error": "no_key"}))
    raise SystemExit(0)
body = json.dumps({"urls": ["<url1>", "<url2>"],
                   "format": "markdown"}).encode()
req = urllib.request.Request("https://api.fetch.tinyfish.ai/",
    data=body, headers={"X-API-Key": key,
                        "Content-Type": "application/json"},
    method="POST")
with urllib.request.urlopen(req, timeout=60) as resp:
    print(resp.read().decode())
PYEOF
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

If `TINYFISH_API_KEY` is not set (or is empty), do NOT call TinyFish. Use:

- Search: the built-in `web_search` tool. It defaults to the AnySearch
  provider and works without a key (it auto-registers). Use it exactly
  as you would without this skill. You may also add the DuckDuckGo
  Instant Answer API call above as a complement when `TINYFISH_DDG_IA`
  is on.
- Fetch: the built-in `web_fetch` tool (direct HTTP GET + HTML-to-
  Markdown). Use it exactly as you would without this skill.

Say which path you used when you report results ("searched with TinyFish"
vs "searched with the built-in search").

## TinyFish errors — handle honestly, fall back, do not loop

Read the HTTP status before using the body.

- `401` — the key is missing or invalid. Tell the user the TinyFish key
  looks invalid and to check/re-enter it in Settings → Environments.
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
- No vault. The vault holds only connectors. This key lives in Settings
  (an environment variable), and the skill never calls the vault broker.
- No key storage. The key lives only in `envs.json`, written by the
  console. Never write a key value to a file, a ticket, a chat message,
  or a skill. Never print, log, or repeat a value. If a tool result ever
  contains a value-shaped string, do NOT quote it — report "the response
  contained a credential-shaped string and it was redacted."
- No chat-model use. TinyFish search/fetch are tools, not a chat model.
  Never put a TinyFish key or endpoint in `active_model` or
  `fallback_models`.
