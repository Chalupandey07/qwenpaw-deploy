---
name: tinyfish
description: "Search the live web and fetch pages with TinyFish THROUGH Monid (the two free endpoints /free/search and /free/fetch only, never the paid /search or /fetch), combined with DuckDuckGo. Reads the Monid key from the TINYFISH_API_KEY environment variable. When no key or no monid CLI is present, use the built-in web_search and web_fetch tools exactly as now — never error, never claim TinyFish was used."
version: "3.0"
metadata:
  qwenpaw:
    emoji: "🐟"
    requires:
      bins: ["python3"]
---

# TinyFish web search + fetch, through Monid (free endpoints only)

TinyFish is reached **only through the Monid CLI**, on Monid's two
**free** endpoints. This is the whole route:

```bash
monid run -p tinyfish -e /free/search     # web search   (free)
monid run -p tinyfish -e /free/fetch      # page fetch   (free)
```

## The hard block: never call the paid endpoints

Monid's TinyFish provider also exposes **paid** endpoints with the same
names minus `/free`. They are **forbidden**. Never call them, never
"just this once", never as a retry, never as a fallback:

| Endpoint | Price (verified 2026-11-22 via `monid inspect`) | Allowed |
|---|---|---|
| `/free/search` | `$0.00` PER_CALL — free tier, 30/min, 500/hour per workspace | **YES** |
| `/free/fetch` | `$0.00` PER_RESULT — free tier, 150 URLs/min, 1,000 URLs/day | **YES** |
| `/search` | `$0.00175` PER_CALL | **NO — hard-blocked** |
| `/fetch` | `$0.001` PER_RESULT | **NO — hard-blocked** |

Only `-e /free/search` and `-e /free/fetch` may ever appear after
`-p tinyfish`. If a request would need a paid endpoint, stop and use the
DuckDuckGo / built-in fallback instead, and say so. A paid call costs the
user real money on a wallet they did not authorise for this skill.

## The key (read this first)

The key is an environment variable, **`TINYFISH_API_KEY`**. Despite the
name it holds a **Monid** key (prefix `moni`/`monid_live`), NOT a TinyFish
key. Do not "fix" it by getting a TinyFish key — a TinyFish key cannot be
used here, and the direct TinyFish API is not part of this skill at all.

The user sets it in Console → **Settings → Environments** ("+ Add
Variable", name `TINYFISH_API_KEY`, paste the Monid key from
app.monid.ai, then Save). The console backend writes it, encrypted, to
`working.secret/envs.json` (mode 600) and syncs it into the running
process environment at once — no restart. You read it from your own
process environment at runtime. **The vault is NOT used for this key.**

### Why the key is NOT declared in require_envs

Do NOT add `TINYFISH_API_KEY` (or the feature flags below) to this
skill's `requires.env` frontmatter. QwenPaw skips a skill whose declared
`require_envs` are unmet, so declaring the key required would disable
this skill whenever no key is set — and this skill must keep working
without a key (built-in fallback). The key and the flags are OPTIONAL
env vars, read from `os.environ` with safe defaults. The frontmatter
declares only `bins: ["python3"]`. This is deliberate, not an omission.

### How the key reaches the CLI (and why it never hits argv)

The Monid CLI has **no environment variable for the key** — it reads
`~/.config/monid/credentials.yaml` plus `active_key` in
`~/.config/monid/config.yaml`. So the skill **bootstraps a private
credential store** and points the CLI at it with `XDG_CONFIG_HOME`
(verified: the CLI honours `XDG_CONFIG_HOME`; it is the one supported
redirect). The key is written to a fresh `0700` temp directory with
`0600` files, used for that one call, and removed afterwards.

The key therefore **never appears in a command string, an argv, or a
log**: `monid run ...` is invoked with no key argument at all. Do NOT
replace this with `monid keys add -k "$TINYFISH_API_KEY"` — that would
put the expanded key in the process argument list, readable by any
process on the box. The python bootstrap below is the only approved way.

```python
import json, os, shutil, subprocess, tempfile

KEY_ENV = "TINYFISH_API_KEY"

def _monid_env():
    """Private XDG dir holding the key; caller must delete it."""
    key = os.environ.get(KEY_ENV, "").strip()
    if not key:
        return None, None
    root = tempfile.mkdtemp(prefix="monid-")
    os.chmod(root, 0o700)
    d = os.path.join(root, "monid")
    os.makedirs(d, mode=0o700)
    prefix = key[:10]
    with open(os.path.join(d, "credentials.yaml"), "w") as fh:
        fh.write("keys:\n  main:\n    key: %s\n    prefix: %s\n"
                 "    added_at: 2026-01-01T00:00:00.000Z\n" % (key, prefix))
    with open(os.path.join(d, "config.yaml"), "w") as fh:
        fh.write("version: 0.1.9\nactive_key: main\n")
    for name in ("credentials.yaml", "config.yaml"):
        os.chmod(os.path.join(d, name), 0o600)
    env = dict(os.environ)
    env["XDG_CONFIG_HOME"] = root
    return root, env

def _run(args, timeout=120):
    root, env = _monid_env()
    if root is None:
        return {"error": "no_key"}
    try:
        p = subprocess.run(["monid"] + args, env=env, timeout=timeout,
                           capture_output=True, text=True)
        if p.returncode != 0:
            return {"error": "monid_failed", "detail": p.stderr.strip()[:500]}
        return json.loads(p.stdout)
    finally:
        shutil.rmtree(root, ignore_errors=True)
```

If `monid` is not installed (`FileNotFoundError`), fall back — do not try
to install it mid-conversation.

**Never print, log, echo, or write the key value.** Never put it in a
chat message, a ticket, a file, or a tool result. If a tool result ever
contains a value-shaped string, do NOT quote it — report "the response
contained a credential-shaped string and it was redacted."

## The exact input schemas (from `monid inspect`, 2026-11-22)

These were read from `monid inspect -p tinyfish -e /free/search` and
`monid inspect -p tinyfish -e /free/fetch` — **not guessed**. Do not
invent parameters; anything not listed here is rejected
(`additionalProperties: false`).

### `/free/search` — `GET`, query params (`--query`, JSON object)

Required: `query` (string, minLength 1).

| Param | Type | Notes |
|---|---|---|
| `query` | string | Required. Natural language; honours `site:`/`-site:` but `include_domains`/`exclude_domains` are preferred. |
| `purpose` | string | ≤2000 chars. The goal behind the request — an extra ranking signal. |
| `location` | string | Country code, e.g. `US`, `GB`, `DE`. Auto-resolves from `language`; defaults `US`. |
| `language` | string | e.g. `en`, `fr`, `de`. Auto-resolves from `location`; defaults `en`. |
| `include_domains` | string | Comma-separated, e.g. `github.com,arxiv.org`. |
| `exclude_domains` | string | Comma-separated, e.g. `pinterest.com,quora.com`. |
| `recency_minutes` | integer | 1–5256000. Freshness window relative to now. Cannot combine with `after_date`/`before_date`; not supported for `research_paper`. |
| `after_date` | string | `YYYY-MM-DD`. Cannot combine with `recency_minutes`. |
| `before_date` | string | `YYYY-MM-DD`. Cannot combine with `recency_minutes`. |
| `domain_type` | enum | `web` (default) / `news` (adds publisher+date) / `research_paper` (adds authors, venue, year, cited_by_count, pdf_url). |
| `pub_year_min` | integer | 0–9999. Only for `domain_type=research_paper`. |
| `pub_year_max` | integer | 0–9999. Only for `domain_type=research_paper`. |
| `page` | integer | 0–10, zero-indexed. |

Response: `{query, results: [{position, title, url, site_name, snippet,
date?}], total_results, page}`. **Snippets only** — no page content. Pipe
the URLs into `/free/fetch` when you need the full text.

### `/free/fetch` — `POST`, JSON body (`-i`, JSON object)

Required: `urls` (array of 1–10 absolute http(s) URIs).

| Param | Type | Notes |
|---|---|---|
| `urls` | string[] | Required, 1–10, fetched in parallel. Private IPs, localhost and cloud metadata are rejected. |
| `purpose` | string | ≤2000 chars. Ranking signal. |
| `format` | enum | `markdown` (default, best for LLM use) / `html` (clean semantic HTML) / `json` (structured document tree). |
| `links` | boolean | Include every `<a href>` as absolute URLs. Default `false`. |
| `image_links` | boolean | Include every `<img src>` as absolute URLs. Default `false`. |
| `ttl` | integer | ≥0. Omit = any cached copy; `0` = force live fetch; N = accept entries younger than N seconds. |
| `per_url_timeout_ms` | integer | 1–110000. A slow URL lands in `errors[]`; the batch still completes. |
| `if_none_match` | string | ETag from a prior fetch, sent as `If-None-Match`. **Single URL only.** |
| `if_modified_since` | string | `Last-Modified` from a prior fetch. **Single URL only.** |
| `include_etag_and_last_modified` | boolean | Return `etag`/`last_modified` for replay. Pair with `ttl: 0` (validators come from the origin, so a cache hit returns none). |
| `include_selectors` | string[] | 1–20 CSS selectors; keeps only matching regions, in document order. A total miss fails that URL with `selector_not_matched` + `candidate_selectors`. |
| `exclude_selectors` | string[] | 1–20 CSS selectors pruned **before** extraction. |

Response: `{results: [{url, final_url, title, description, language,
format, text, author, published_date, links?, image_links?, latency_ms}],
errors: [{url, error, status}]}`. A per-URL failure never fails the
batch — report `errors[]` and use what succeeded. Use `text` as the page
content.

**Note:** `/free/fetch` has **no anti-bot bypass** — protected pages come
back as `bot_blocked`. Report that plainly; do not retry in a loop.

## Search (with a key): Monid `/free/search` + DuckDuckGo

```python
query = {"query": "<the search query>", "language": "en"}
print(json.dumps(_run(["run", "-p", "tinyfish", "-e", "/free/search",
                       "--query", json.dumps(query), "-w", "90", "-j"])))
```

Note the shape: `/free/search` is a **GET with query params**, so its
input goes in `--query` (a JSON object), never `-i`. Passing `-i` to it,
or `--query` to `/free/fetch`, is the wrong shape and the CLI rejects it.
`-w 90` waits up to 90 s; `-j` prints machine-readable JSON (the plain
output is a pretty report, harder to parse).

Useful combinations: `domain_type: "news"` for current events (adds
publisher + date), `"research_paper"` with `pub_year_min`/`pub_year_max`
for academic work, `recency_minutes: 60` for the last hour,
`include_domains`/`exclude_domains` to steer sources, `page` 0–10 to page.

Present results with title + URL + snippet, and cite the URL for every
fact you use. Snippets are short by design — fetch the promising URLs
with `/free/fetch` when the answer needs detail.

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
replaces Monid or the built-in search.

**Do NOT scrape `html.duckduckgo.com` or `lite.duckduckgo.com`.** Both
return an anomaly/bot-detection page from this machine (verified
2026-11-18: 0 results, 67 "anomaly" matches). The Instant Answer API is
the only DuckDuckGo surface that works reliably here.

## Fetch (with a key): Monid `/free/fetch`

`/free/fetch` is a **POST with a JSON body**, so its input goes in `-i`:

```python
body = {"urls": ["<url1>", "<url2>"], "format": "markdown"}
print(json.dumps(_run(["run", "-p", "tinyfish", "-e", "/free/fetch",
                       "-i", json.dumps(body), "-w", "150", "-j"])))
```

1–10 URLs per call; anything beyond 10 must be split into batches. Use
`format: "markdown"` unless you specifically need `html` or the `json`
document tree. Add `exclude_selectors: ["nav", "footer", "aside"]` to
prune boilerplate, or `include_selectors` to keep only the article body.

## Feature selection (the Search section)

The user picks which search features are on in the **Search section** of
Settings (injected into the Settings page): a key field, and three
checkboxes — TinyFish search, TinyFish fetch, DuckDuckGo Instant Answer.
The section saves them as environment variables through the console's own
endpoint, `PATCH /api/envs` (merge — it only touches the variables it
sends, never the others; never PUT, which would replace ALL environment
variables). The variables are:

| Env var | Meaning | Default when absent |
|---|---|---|
| `TINYFISH_API_KEY` | the **Monid** API key | (none — no key) |
| `TINYFISH_SEARCH` | use Monid for search | `1` (on) |
| `TINYFISH_FETCH` | use Monid for fetch | `1` (on) |
| `TINYFISH_DDG_IA` | complement with DuckDuckGo Instant Answer | `1` (on) |

A flag is off only when its value is `0`, `false`, `no`, or `off` (any
case). Absent or empty means on. **The built-in search is NOT a flag and
can never be turned off** — it is the fallback, and the fallback must
always exist.

- If the key is set, `monid` is installed, and `TINYFISH_SEARCH` is on,
  search with Monid `/free/search`. Otherwise search with the built-in
  `web_search` — even when a key is set.
- If the key is set, `monid` is installed, and `TINYFISH_FETCH` is on,
  fetch with Monid `/free/fetch`. Otherwise fetch with the built-in
  `web_fetch`.
- If `TINYFISH_DDG_IA` is on, complement a search with the DuckDuckGo
  Instant Answer API. If it is off, skip it.

To remove the key, the Search section calls
`DELETE /api/envs/TINYFISH_API_KEY`. The section never displays the key
value — it shows only whether a key is saved.

## Search and fetch WITHOUT a key: the built-in tools, exactly as now

If `TINYFISH_API_KEY` is not set (or is empty), or the `monid` CLI is not
installed, do NOT call Monid. Use:

- Search: the built-in `web_search` tool (AnySearch by default; works
  without a key). Use it exactly as you would without this skill. You may
  add the DuckDuckGo Instant Answer call above as a complement when
  `TINYFISH_DDG_IA` is on.
- Fetch: the built-in `web_fetch` tool (direct HTTP GET + HTML-to-
  Markdown). Use it exactly as you would without this skill.

Say which path you used when you report results ("searched with TinyFish
via Monid" vs "searched with the built-in search").

## Errors — handle honestly, fall back, do not loop

Read the error before using anything. `monid` exits non-zero and prints
`{"error": {"code": ..., "message": ...}}` on failure.

- `AUTH_FAILED` / "No active API key" — the key is missing, malformed, or
  not a Monid key. Tell the user the Monid key looks invalid and to
  check/re-enter it in Settings → Environments. Fall back for this
  request. Do NOT retry.
- `401` / `403` — same: key rejected. Fall back, do not retry.
- `402` / `402 PAYMENT_REQUIRED` / balance exhausted — the free tier or
  wallet is used up. **Do NOT switch to the paid endpoint to "make it
  work".** Tell the user the free allowance is exhausted, and fall back.
- `429` — rate limit (search: 30/min, 500/hour; fetch: 150 URLs/min,
  1,000 URLs/day per workspace). At most one retry after 60 s, then fall
  back.
- `COMMAND_NOT_FOUND` / `FileNotFoundError` for `monid` — the CLI is not
  installed on this machine. Fall back and say so; do not install it
  mid-conversation.
- `VALIDATION_ERROR` / schema rejection — you sent a parameter the
  endpoint does not accept. Re-read the schema table above, fix the
  shape (`--query` vs `-i`), retry **once**, then fall back.
- `5xx` / timeout — Monid or TinyFish is having trouble. One retry at
  most, then fall back.

Never present an error as a successful search. Never fabricate results
when the call fails. Never "solve" an error by calling a paid endpoint.

## What is NOT in this skill

- **No direct TinyFish API.** `https://api.search.tinyfish.ai` and
  `https://api.fetch.tinyfish.ai` with `X-API-Key` are REMOVED. That
  route returns `401 INVALID_API_KEY` because the saved key is a Monid
  key, not a TinyFish key. Do not reintroduce it, and do not ask the user
  for a TinyFish key.
- **No paid Monid endpoints.** `/search` ($0.00175/call) and `/fetch`
  ($0.001/result) are hard-blocked. Free endpoints only.
- No vault. The vault holds only connectors. This key lives in Settings
  (an environment variable), and the skill never calls the vault broker.
- No key storage. The key lives only in `envs.json` and, for the
  duration of one call, in a `0600` temp file that is deleted afterwards.
  Never write a key value to a repo file, a ticket, a chat message, or a
  skill. Never print, log, or repeat a value. If a tool result ever
  contains a value-shaped string, do NOT quote it — report "the response
  contained a credential-shaped string and it was redacted."
- No chat-model use. TinyFish search/fetch are tools, not a chat model.
  Never put a key or endpoint in `active_model` or `fallback_models`.
