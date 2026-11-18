# TinyFish free web search + fetch (with DuckDuckGo, Settings key, built-in fallback)

**Status: skill rewritten 2026-11-18 (v2.0) for a Settings-based key.
TinyFish path NOT live-tested — no TinyFish API key has been entered yet.
Fallback path (built-in search/fetch) verified by construction, not by a
live agent run.**

## What this is

A QwenPaw skill (`tinyfish`) that gives the agent two free TinyFish
endpoints — Web Search and Fetch — combined with DuckDuckGo, with the
user's key design:

- **User enters the key in Settings.** The TinyFish API key is an
  environment variable, `TINYFISH_API_KEY`, set by the user in Console
  → Settings → Environments. It is never auto-provisioned, never
  hardcoded, never invented.
- **No key = normal search like now.** When no `TINYFISH_API_KEY` is
  set, the agent uses the built-in `web_search` (AnySearch by default)
  and `web_fetch` (direct HTTP GET + HTML-to-Markdown) exactly as before.
  Nothing about the current behaviour changes.

## The key design (Settings env var — v2.0, 2026-11-18)

This replaced the v1.0 vault design. The vault holds ONLY connectors
now (user rule, 2026-11-18 ~14:35 IST), so a provider/service key like
this one belongs in Settings, not the vault.

- **The mechanism is QwenPaw's own skill-env pipeline** (verified in
  the upstream v2.3.0.post1 source): a skill declares env vars in its
  `SKILL.md` frontmatter (`metadata.requires.env` → `require_envs`);
  the engine looks them up in `QWENPAW_SECRET_DIR/envs.json` and
  injects them into the skill's execution environment. The console's
  Settings → Environments page (and `PATCH /api/envs`) writes
  `envs.json` — values encrypted, file mode 600 — and syncs the
  running process environment at once, so no restart is needed after
  the user saves a key.
- **The key is deliberately NOT declared in `require_envs`.**
  `resolve_effective_skills` SKIPS a skill whose declared
  `require_envs` are unmet, so declaring `TINYFISH_API_KEY` required
  would disable this skill whenever no key is set — and the skill must
  keep working without a key (built-in fallback). The key and the
  feature flags are OPTIONAL env vars, read from `os.environ` with
  safe defaults. The frontmatter declares only `bins: ["python3"]`.
- **The skill calls TinyFish with python3 (stdlib urllib), not curl.**
  A curl header built from a shell variable would put the expanded key
  in curl's argument list (visible in `/proc`). Python reads the key
  from `os.environ` inside the python process, so the key never appears
  in any command string, argument list, or log.
- **The key is never printed, logged, or echoed.** Only the name
  (`TINYFISH_API_KEY`) may be mentioned, never the value, a prefix, or
  a length.

## The Search section (Settings)

A "Search" section is injected into the console Settings page. It has
a key field (password input, never displays the value — only whether a
key is saved) and three checkboxes: TinyFish search, TinyFish fetch,
DuckDuckGo Instant Answer. It saves through the console's own env
endpoint:

- **Load:** `GET /api/envs` (returns the vars; the section uses it only
  for presence of the key and the flag values — it never renders the
  key value).
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
  needed. (A Pages Worker cannot reach the machine's private broker
  addresses; the reset feature's Pages→broker path is unproven for
  exactly this reason. This design does not repeat that mistake.)

### Feature flags

| Env var | Meaning | Default when absent |
|---|---|---|
| `TINYFISH_API_KEY` | the TinyFish API key | (none — no key) |
| `TINYFISH_SEARCH` | use TinyFish for search | `1` (on) |
| `TINYFISH_FETCH` | use TinyFish for fetch | `1` (on) |
| `TINYFISH_DDG_IA` | complement with DuckDuckGo Instant Answer | `1` (on) |

A flag is off only when its value is `0`, `false`, `no`, or `off`
(any case). Absent or empty means on. **The built-in search is NOT a
flag and can never be turned off** — it is the fallback, and the
fallback must always exist. The skill respects the flags even when a
key is set: `TINYFISH_SEARCH=0` means built-in search despite a key.

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

## Error handling (in the skill)

- `401` — key invalid; tell the user to check/re-enter it in Settings →
  Environments; fall back.
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
| `features/tinyfish/SKILL.md` | The skill (v2.0, Settings-based key). |
| `features/tinyfish/README.md` | This file. |
| `features/tinyfish/test_tinyfish.py` | Machine-free selftest (T116): request-building, python request construction, env-based fallback decision, feature flags, error mapping, SKILL.md doc checks. Mocks the HTTP layer — never calls the live API. |
| `pages/public/search-settings-ui.js` | The injected Search section (Settings page): key field + 3 checkboxes, loads via `GET /api/envs`, saves via `PATCH /api/envs`, removes the key via `DELETE /api/envs/TINYFISH_API_KEY`, self-mounts with a throttled MutationObserver. Served as a Pages static asset (routed explicitly in `pages/public/_worker.js` — an unrouted `<script src>` would fall through to the console proxy and parse as nothing, B-35). |
| `features/tinyfish/test_search_settings_ui.mjs` | Node harness for the Search section (27 checks): pure functions, mount behaviour with a DOM mock + fetch mock, self-mount + throttling, and the `_worker.js` wiring (asset route + script injection). Run: `node features/tinyfish/test_search_settings_ui.mjs`. |

Machine paths: skill installed at
`/data/home/qwenpaw/working/workspaces/default/skills/tinyfish/SKILL.md`,
enabled via `docker exec qwenpaw qwenpaw skills enable tinyfish`.
(The v2.0 skill doc must be re-synced to the machine after this commit;
the parent does that. The skill name and enablement are unchanged.)

## What was verified, and what was not

Verified (2026-11-18, from the upstream v2.3.0.post1 source + the repo):
- The env-var mechanism: `metadata.requires.env` → `require_envs`
  (`src/qwenpaw/agents/skill_system/store.py: parse_skill_requirements`);
  envs.json values are encrypted, mode 600, loaded into `os.environ`
  at startup and synced at once on save
  (`src/qwenpaw/envs/store.py: load_envs_into_environ, _save_envs_unlocked,
  _sync_environ`); the console env endpoints are `GET/PATCH/PUT/DELETE
  /api/envs` (`src/qwenpaw/app/routers/envs.py`, mounted under `/api`).
- The gating rule that forces the key to stay OUT of `require_envs`:
  `resolve_effective_skills` skips a skill whose `require_envs` are
  unmet (`src/qwenpaw/agents/skill_system/registry.py`).
- Env key names (`TINYFISH_API_KEY`, `TINYFISH_SEARCH`,
  `TINYFISH_FETCH`, `TINYFISH_DDG_IA`) all match QwenPaw's key rule
  `^[A-Za-z_][A-Za-z0-9_]*$` and are not protected/internal keys
  (`src/qwenpaw/envs/registry.py`).
- TinyFish `/free/search` and `/free/fetch` on `api.search.tinyfish.ai`
  return 401 `MISSING_API_KEY` without a key (a key IS required even
  for the free tier). A bogus path also returns 401, so this proves the
  auth gate, not the path.
- DuckDuckGo Instant Answer API works from the container (returns an
  `Abstract`). DDG HTML/lite are anomaly-blocked (0 results).
- The built-in `web_search` default is AnySearch and `web_fetch` is a
  direct GET (read from the container source).
- The official TinyFish SDK (v0.11.0) uses root `/` on each product
  host with `X-API-Key` (read from the published wheel).

NOT verified:
- **The TinyFish path with a real key.** No key has been entered. The
  search/fetch calls, the response parsing, and the root-vs-`/free/`
  path question are unproven until the user enters a `TINYFISH_API_KEY`
  in Settings and the agent runs a real search + fetch.
- **A live agent run using the skill.** The skill is installed and
  enabled, but no agent conversation has used it yet. That needs a
  browser test (parent) after the key is entered.
- **The Search section in a real browser.** The injection + the
  `PATCH /api/envs` save path are tested against mocks only; the live
  Settings page DOM and the real endpoint need a browser check (parent).
- The machine-free selftest (T116) passes, but it mocks HTTP — it proves
  the request-building and fallback logic, not the live API.

## Deliberately not done

- **No Monid gateway.** Monid routes the same endpoints as PAID calls
  ($0.0050/search, $0.0010/fetch result). This skill uses the DIRECT
  TinyFish free endpoints only.
- **No vault use.** The vault holds only connectors. This key lives in
  Settings (an env var). No TinyFish vault preset, no vault item.
- **No new broker.** The Search section uses the console's own
  `/api/envs` endpoint through the Pages proxy — the same path the
  console's Environments page uses. A Pages Worker cannot reach a
  machine-side broker at a private address, so no broker was built.
- **No `ddgs` install.** It would hit the same DDG anomaly block.
- **No change to the built-in `web_search` / `web_fetch` tools.** The
  fallback is the existing tools, untouched.
- **No claim that TinyFish works.** It has never run against the real
  API with a key.
