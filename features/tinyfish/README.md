# TinyFish free web search + fetch, through Monid (v3.0, 2026-11-22)

**Status: rewritten 2026-11-22 (v3.0) to route through Monid. Both free
endpoints live-tested from this box with a real Monid key — search and
fetch both returned results and both billed $0.0000. The paid endpoints
are hard-blocked. The direct TinyFish API is gone.**

## What this is

A QwenPaw skill (`tinyfish`) that gives the agent two free TinyFish
endpoints — Web Search and Fetch — **reached only through the Monid
CLI**, combined with DuckDuckGo, with the user's key design:

- **One route, two free endpoints.** `monid run -p tinyfish -e
  /free/search` for search, `monid run -p tinyfish -e /free/fetch` for
  fetch. Nothing else.
- **User enters the key in Settings.** The Monid API key is an
  environment variable, `TINYFISH_API_KEY`, set by the user in Console
  → Settings → Environments. It is never auto-provisioned, never
  hardcoded, never invented.
- **No key = normal search like now.** When no `TINYFISH_API_KEY` is
  set (or `monid` is not installed), the agent uses the built-in
  `web_search` (AnySearch by default) and `web_fetch` (direct HTTP GET
  + HTML-to-Markdown) exactly as before.

## Why v3.0 replaced v2.0 (the 401 this fixes)

v2.0 called TinyFish **directly**:

```text
GET  https://api.search.tinyfish.ai/?query=...      X-API-Key: <key>
POST https://api.fetch.tinyfish.ai/                 X-API-Key: <key>
```

That returns **401 `INVALID_API_KEY`**, and the reason is structural,
not a typo: **the saved key is a Monid key (35 chars, `moni` prefix),
not a TinyFish key.** A Monid key is issued by Monid and is only valid
against Monid's gateway. No amount of retrying, path-tweaking, or
re-entering the same value fixes a direct TinyFish call with it.

The fix is to route through Monid — which is what the user added the
Monid key for. v3.0 removes the direct route entirely: no
`api.search.tinyfish.ai`, no `api.fetch.tinyfish.ai`, no `X-API-Key`
header anywhere in the skill.

## The hard block: paid endpoints are never called

Monid's TinyFish provider exposes paid endpoints alongside the free
ones. They are **forbidden** in this skill — not on retry, not on
error, not "just once".

| Endpoint | Price (verified 2026-11-22 via `monid inspect`) | Allowed |
|---|---|---|
| `/free/search` | `$0.00` PER_CALL — 30/min, 500/hour per workspace | **YES** |
| `/free/fetch` | `$0.00` PER_RESULT — 150 URLs/min, 1,000 URLs/day | **YES** |
| `/search` | `$0.00175` PER_CALL | **NO — hard-blocked** |
| `/fetch` | `$0.001` PER_RESULT | **NO — hard-blocked** |

Enforced three ways: the SKILL.md rule, the selftest's blocklist checks
(`test_tinyfish.py` fails if a paid endpoint appears in the reference
implementation or in SKILL.md), and the fact that the code path is a
single constant pair that only ever names `/free/*`.

## The exact input schemas (read from `monid inspect`, never guessed)

Both were captured from the live CLI on 2026-11-22:
`monid inspect -p tinyfish -e /free/search` and
`monid inspect -p tinyfish -e /free/fetch`.

### `/free/search` — `GET`, input goes in `--query` (JSON object)

Required: `query` (string, minLength 1). `additionalProperties: false`.

| Param | Type | Notes |
|---|---|---|
| `query` | string | Required, minLength 1. Honours `site:`/`-site:`, but `include_domains`/`exclude_domains` are preferred. |
| `purpose` | string | ≤2000 chars. The goal behind the request — extra ranking signal. |
| `location` | string | Country code (`US`, `GB`, `DE`). Auto-resolves from `language`; defaults `US`. |
| `language` | string | `en`, `fr`, `de`. Auto-resolves from `location`; defaults `en`. |
| `include_domains` | string | Comma-separated, e.g. `github.com,arxiv.org`. |
| `exclude_domains` | string | Comma-separated, e.g. `pinterest.com,quora.com`. |
| `recency_minutes` | integer | 1–5256000. Cannot combine with `after_date`/`before_date`; not for `research_paper`. |
| `after_date` | string | `YYYY-MM-DD`. Cannot combine with `recency_minutes`. |
| `before_date` | string | `YYYY-MM-DD`. Cannot combine with `recency_minutes`. |
| `domain_type` | enum | `web` (default) / `news` (adds publisher+date) / `research_paper` (adds authors, venue, year, cited_by_count, pdf_url). |
| `pub_year_min` | integer | 0–9999. Only for `domain_type=research_paper`. |
| `pub_year_max` | integer | 0–9999. Only for `domain_type=research_paper`. |
| `page` | integer | 0–10, zero-indexed. |

Response: `{query, results: [{position, title, url, site_name, snippet,
date?}], total_results, page}`. **Snippets only** — pipe the URLs into
`/free/fetch` when you need full page text.

### `/free/fetch` — `POST`, input goes in `-i` (JSON body)

Required: `urls` (array, 1–10 absolute http(s) URIs).
`additionalProperties: false`.

| Param | Type | Notes |
|---|---|---|
| `urls` | string[] | Required, 1–10, parallel. Private IPs, localhost, cloud metadata rejected. |
| `purpose` | string | ≤2000 chars. Ranking signal. |
| `format` | enum | `markdown` (default) / `html` (clean semantic HTML) / `json` (structured document tree). |
| `links` | boolean | Every `<a href>` as absolute URLs. Default `false`. |
| `image_links` | boolean | Every `<img src>` as absolute URLs. Default `false`. |
| `ttl` | integer | ≥0. Omit = any cached copy; `0` = force live; N = younger than N seconds. |
| `per_url_timeout_ms` | integer | 1–110000. A slow URL goes to `errors[]`; batch still completes. |
| `if_none_match` | string | ETag from a prior fetch. **Single URL only.** |
| `if_modified_since` | string | `Last-Modified` from a prior fetch. **Single URL only.** |
| `include_etag_and_last_modified` | boolean | Return `etag`/`last_modified`. Pair with `ttl: 0` (a cache hit returns none). |
| `include_selectors` | string[] | 1–20 CSS selectors, keep only matching regions. Total miss → `selector_not_matched` + `candidate_selectors`. |
| `exclude_selectors` | string[] | 1–20 CSS selectors pruned **before** extraction. |

Response: `{results: [{url, final_url, title, description, language,
format, text, author, published_date, links?, image_links?,
latency_ms}], errors: [{url, error, status}]}`. A per-URL failure never
fails the batch.

**No anti-bot bypass** — protected pages return `bot_blocked`. Report it;
do not loop.

### The `--query` vs `-i` trap

`/free/search` is a **GET with query params**; `/free/fetch` is a
**POST with a JSON body**. Passing `-i` to search, or `--query` to
fetch, is rejected. Also note `--query` must be **valid JSON**
(`'{"query":"x"}'`), not `query=x` — the CLI errors with `Invalid JSON
for --query`.

## The key: how it gets from the environment into the CLI

The Monid CLI has **no key environment variable** — verified by reading
the published bundle: it resolves `~/.config/monid/credentials.yaml`
plus `active_key` in `~/.config/monid/config.yaml`, and the only env
vars it reads are `MONID_API_BASE_URL`, `MONID_WEB_BASE_URL`,
`MONID_SETUP_CLIENT`, `MONID_SETUP_EMAIL`, `XDG_CONFIG_HOME`,
`LOG_STREAM`, `LOG_TOKENS`, `NODE_DEBUG`, `TERM`.

So the skill **bootstraps a private credential store** and redirects the
CLI with `XDG_CONFIG_HOME` (verified working live):

1. Read `TINYFISH_API_KEY` from `os.environ` inside the python process.
2. `tempfile.mkdtemp()` → `chmod 0700`; write `monid/credentials.yaml`
   and `monid/config.yaml` with `chmod 0600`.
3. Run `monid ...` with `XDG_CONFIG_HOME` pointed at that dir.
4. `shutil.rmtree()` in a `finally` block.

**Why not `monid keys add -k "$TINYFISH_API_KEY"`:** that expands the key
into the process argument list, where any process on the box can read it
from `/proc`. The skill must never do this. Why not plain `python3`
+ `urllib` as v2.0 did: the direct API is the 401 route, and the task is
to call Monid **via the CLI**, not to re-implement its HTTP surface.

## The Search section (Settings)

A "Search" section is injected into the console Settings page. It has a
key field (password input, never displays the value — only whether a key
is saved) and three checkboxes: TinyFish search, TinyFish fetch,
DuckDuckGo Instant Answer. It saves through the console's own env
endpoint:

- **Load:** `GET /api/envs` (used only for key presence and flag values
  — it never renders the key value).
- **Save:** `PATCH /api/envs` with a JSON body of the variables to set
  (`TINYFISH_API_KEY`, `TINYFISH_SEARCH`, `TINYFISH_FETCH`,
  `TINYFISH_DDG_IA`). PATCH merges — it only touches the variables it
  sends. Never PUT, which would replace ALL environment variables.
- **Remove the key:** `DELETE /api/envs/TINYFISH_API_KEY`.
- The endpoint paths are verified in the upstream v2.3.0.post1 source
  (`src/qwenpaw/app/routers/envs.py`, mounted under `/api` in
  `src/qwenpaw/app/_app.py`). The section calls the console backend
  through the Pages proxy — the same path the console's own
  Environments page uses, so no new broker and no new Pages route are
  needed.

### Feature flags

| Env var | Meaning | Default when absent |
|---|---|---|
| `TINYFISH_API_KEY` | the **Monid** API key | (none — no key) |
| `TINYFISH_SEARCH` | use Monid for search | `1` (on) |
| `TINYFISH_FETCH` | use Monid for fetch | `1` (on) |
| `TINYFISH_DDG_IA` | complement with DuckDuckGo Instant Answer | `1` (on) |

A flag is off only when its value is `0`, `false`, `no`, or `off` (any
case). Absent or empty means on. **The built-in search is NOT a flag and
can never be turned off** — it is the fallback, and the fallback must
always exist. The skill respects the flags even when a key is set:
`TINYFISH_SEARCH=0` means built-in search despite a key.

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
  a complement, never a replacement for Monid or the built-in search.
- The `ddgs` Python package is NOT installed in the container and would
  hit the same anomaly block (it uses the same DDG endpoints), so it was
  not installed.

## Error handling (in the skill)

- `AUTH_FAILED` / "No active API key" — key missing, malformed, or not a
  Monid key; tell the user to check/re-enter it in Settings →
  Environments; fall back; do NOT retry.
- `401` / `403` — key rejected; fall back; do not retry.
- `402` / balance exhausted — free tier or wallet used up. **Never
  switch to a paid endpoint to make it work.** Tell the user; fall back.
- `429` — rate limit (search 30/min, 500/hour; fetch 150 URLs/min,
  1,000 URLs/day). At most one retry after 60 s.
- `monid` not found (`FileNotFoundError` / `COMMAND_NOT_FOUND`) — the
  CLI is not installed; fall back; do not install mid-conversation.
- `VALIDATION_ERROR` — wrong shape (`--query` vs `-i`) or a param the
  endpoint does not accept; re-read the schema, retry once, then fall
  back.
- `5xx` / timeout — one retry at most, then fall back.
- Never present an error as a successful search. Never fabricate
  results.

## Installing Monid on the machine

The skill calls `monid`, so the CLI must exist on the InstaBox machine
(T2.1 in `TASKS.md`). It is **not** bundled by this skill and not
auto-installed at runtime:

```bash
npm install -g @monid-ai/cli@latest     # provides `monid` (v0.1.9 verified)
monid --version                          # must match the skill's version note
```

The key itself is already on the machine: `working.secret/envs.json`
under `TINYFISH_API_KEY` — that value **is** the Monid key. The skill
reads it from the process environment at runtime; nothing else needs
configuring, and no TinyFish key is needed anywhere.

## Files

| File | What it is |
|---|---|
| `features/tinyfish/SKILL.md` | The skill (v3.0, Monid route, free endpoints only, exact schemas). |
| `features/tinyfish/README.md` | This file. |
| `features/tinyfish/test_tinyfish.py` | Machine-free selftest: Monid argv building, endpoint blocklist (paid endpoints can never be constructed), env-based fallback decision, feature flags, error mapping, schema-shape checks, SKILL.md doc checks. Never touches the network. |
| `pages/public/search-settings-ui.js` | The injected Search section (Settings page): key field + 3 checkboxes, loads via `GET /api/envs`, saves via `PATCH /api/envs`, removes the key via `DELETE /api/envs/TINYFISH_API_KEY`. |
| `features/tinyfish/test_search_settings_ui.mjs` | Node harness for the Search section. Run: `node features/tinyfish/test_search_settings_ui.mjs`. |

Machine paths: skill installed at
`/data/home/qwenpaw/working/workspaces/default/skills/tinyfish/SKILL.md`,
enabled via `docker exec qwenpaw qwenpaw skills enable tinyfish`.
(The v3.0 skill doc must be re-synced to the machine after this commit;
the parent does that. The skill name and enablement are unchanged.)

## What was verified live, and what was not

Verified from this box on 2026-11-22 with a real Monid key:

- `monid --version` → `0.1.9`; `monid whoami` → authenticated.
- `monid inspect -p tinyfish -e /free/search` → full input schema
  captured (GET, `queryParams`, required `query`, 13 params,
  `additionalProperties: false`), `price.amount.value = 0`, offer
  "Free tier", limits "30/min, 500/hour per workspace", `regularEndpoint:
  /search`.
- `monid inspect -p tinyfish -e /free/fetch` → full input schema captured
  (POST, `body`, required `urls` 1–10, 12 params,
  `additionalProperties: false`), `price.amount.value = 0`, limits
  "150 URLs/min, 1,000 URLs/day", `regularEndpoint: /fetch`.
- `monid run -p tinyfish -e /free/search --query '{"query":"..."}' -w -j`
  → `COMPLETED`, `output.results[]` with position/title/url/site_name/
  snippet, `price` $0, `billing.reportedCost.value` 0 (MICRO_DOLLAR).
- `monid run -p tinyfish -e /free/fetch -i '{"urls":[...]}' -w -j` →
  `COMPLETED`, clean Markdown in `output.results[0].text`, `errors: []`,
  `price` $0, `billing.reportedCost.value` 0.
- `XDG_CONFIG_HOME` redirect works: a bootstrapped `0700` dir with
  `0600` credentials + `active_key: main` authenticates and runs.
- Paid endpoints, inspected but **never run**: `/search`
  `$0.00175` PER_CALL, `/fetch` `$0.001` PER_RESULT.

NOT verified (needs the machine / Muse):
- **The skill running inside the QwenPaw agent container** with the
  machine's real `TINYFISH_API_KEY` from `working.secret/envs.json`, and
  `monid` on that machine's PATH. The CLI logic is proven here; the
  container wiring is not.
- **A live agent conversation** using the skill end-to-end, and the
  Settings Search section in a real browser.
- The machine-free selftest passes, but it builds argv and checks the
  blocklist — it does not call the live API.

## Deliberately not done

- **No direct TinyFish API.** `api.search.tinyfish.ai` /
  `api.fetch.tinyfish.ai` + `X-API-Key` removed — that route 401s
  because the key is a Monid key.
- **No paid Monid endpoints.** `/search` and `/fetch` are hard-blocked
  by rule and by test.
- **No TinyFish key requested.** None is needed; asking for one would
  repeat the original mistake.
- **No vault use.** The vault holds only connectors. This key lives in
  Settings (an env var).
- **No new broker.** The Search section uses the console's own
  `/api/envs` endpoint through the Pages proxy.
- **No `ddgs` install.** It would hit the same DDG anomaly block.
- **No change to the built-in `web_search` / `web_fetch` tools.** The
  fallback is the existing tools, untouched.
