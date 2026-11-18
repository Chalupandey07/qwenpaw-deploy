#!/usr/bin/env python3
"""TinyFish free search + fetch: request-building and fallback logic.

Settings-based key source (2026-11-18, replaces the vault): the TinyFish
API key is an environment variable, TINYFISH_API_KEY, set by the user in
Console -> Settings -> Environments (the console backend writes it,
encrypted, to working.secret/envs.json and syncs it to os.environ at once
— no restart). The skill reads it from os.environ at runtime. The vault
holds ONLY connectors now and is NOT used for this key.

Why the key is NOT in require_envs: QwenPaw's resolve_effective_skills
SKIPS a skill whose declared require_envs are unmet, so declaring
TINYFISH_API_KEY required would disable the skill whenever no key is
set — and the skill must keep working without a key (built-in fallback).
The key and the feature flags are OPTIONAL env vars read from
os.environ with safe defaults. The frontmatter declares only bins.

Why python, not curl: a curl header `-H "X-API-Key: $VAR"` puts the
expanded key in curl's argv (visible in /proc). The skill calls
TinyFish with python3 (stdlib urllib), reading the key from os.environ
inside the python process, so the key never appears in any command
string, argv, or log.

This is the reference implementation of the rules in SKILL.md, kept as
pure stdlib functions so the machine-free suite can check them without
calling the live API (which needs a real key). It never touches the
network: it only builds the request the skill sends, and decides which
path to take.

Run: python3 features/tinyfish/test_tinyfish.py --selftest
Prints "N passed, M failed" (the T116 harness greps for that tally).
"""
import json
import os
import re
import sys
import urllib.parse

SEARCH_HOST = "https://api.search.tinyfish.ai"
FETCH_HOST = "https://api.fetch.tinyfish.ai"
DDG_IA = "https://api.duckduckgo.com/"
SEARCH_DAILY_LIMIT = 12000
SEARCH_RATE_PER_MIN = 30
MAX_FETCH_URLS = 10

# The Settings store: QwenPaw env vars (working.secret/envs.json), set in
# Console -> Settings -> Environments, saved by the console backend via
# PATCH /api/envs (merge — never PUT, which replaces ALL env vars).
KEY_ENV = "TINYFISH_API_KEY"
FLAG_SEARCH_ENV = "TINYFISH_SEARCH"
FLAG_FETCH_ENV = "TINYFISH_FETCH"
FLAG_DDG_ENV = "TINYFISH_DDG_IA"
FEATURE_ENVS = (FLAG_SEARCH_ENV, FLAG_FETCH_ENV, FLAG_DDG_ENV)
ENVS_API = "/api/envs"
ENVS_SAVE_METHOD = "PATCH"
# QwenPaw's env-key rule (src/qwenpaw/envs/registry.py): ^[A-Za-z_][A-Za-z0-9_]*$
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
FAKE_KEY = "tf_test_key_fixture"


def build_search_url(query, language="en", domain_type=None,
                     recency_minutes=None, location=None,
                     include_domains=None, exclude_domains=None,
                     page=None, use_free_path=False):
    """GET url for TinyFish search. Root path is the SDK path; the
    /free/search path is the alternate the user named."""
    if not query or not query.strip():
        raise ValueError("query must be a non-empty string")
    path = "/free/search" if use_free_path else "/"
    params = {"query": query.strip(), "language": language}
    if domain_type:
        if domain_type not in ("web", "news", "research_paper"):
            raise ValueError(f"bad domain_type: {domain_type!r}")
        params["domain_type"] = domain_type
    if recency_minutes is not None:
        if not (1 <= recency_minutes <= 5256000):
            raise ValueError("recency_minutes out of range 1..5256000")
        params["recency_minutes"] = str(recency_minutes)
    if location:
        params["location"] = location
    if include_domains:
        params["include_domains"] = include_domains
    if exclude_domains:
        params["exclude_domains"] = exclude_domains
    if page is not None:
        if not (0 <= page <= 10):
            raise ValueError("page out of range 0..10")
        params["page"] = str(page)
    return SEARCH_HOST + path + "?" + urllib.parse.urlencode(params)


def build_fetch_body(urls, fmt="markdown", purpose=None, links=False,
                     ttl=None):
    """POST body for TinyFish fetch. 1-10 urls, markdown/html/json."""
    if not urls or len(urls) > MAX_FETCH_URLS:
        raise ValueError(f"urls must be 1..{MAX_FETCH_URLS} items")
    if fmt not in ("markdown", "html", "json"):
        raise ValueError(f"bad format: {fmt!r}")
    if purpose is not None and (not purpose.strip() or len(purpose) > 2000):
        raise ValueError("purpose must be 1..2000 chars")
    if ttl is not None and (not isinstance(ttl, int) or ttl < 0):
        raise ValueError("ttl must be a non-negative integer")
    body = {"urls": list(urls), "format": fmt}
    if purpose:
        body["purpose"] = purpose
    if links:
        body["links"] = True
    if ttl is not None:
        body["ttl"] = ttl
    return body


def build_ddg_ia_url(query):
    """DuckDuckGo Instant Answer API url (keyless, works from the box)."""
    if not query or not query.strip():
        raise ValueError("query must be a non-empty string")
    params = {"q": query.strip(), "format": "json", "no_html": "1",
              "skip_disambig": "1"}
    return DDG_IA + "?" + urllib.parse.urlencode(params)


def build_search_request(query, api_key, **kwargs):
    """The python (urllib) request the skill sends for a TinyFish search.

    Returns {"method", "url", "headers", "body"}. The key goes ONLY in
    the headers dict — never in the URL, never in the body, never in a
    shell command string. The skill reads the key from os.environ inside
    the python process, so no argv ever carries it.
    """
    if not api_key or not str(api_key).strip():
        raise ValueError("api_key must be a non-empty string")
    return {
        "method": "GET",
        "url": build_search_url(query, **kwargs),
        "headers": {"X-API-Key": api_key, "Accept": "application/json"},
        "body": None,
    }


def build_fetch_request(urls, api_key, **kwargs):
    """The python (urllib) request the skill sends for a TinyFish fetch."""
    if not api_key or not str(api_key).strip():
        raise ValueError("api_key must be a non-empty string")
    return {
        "method": "POST",
        "url": FETCH_HOST + "/",
        "headers": {"X-API-Key": api_key,
                    "Content-Type": "application/json"},
        "body": json.dumps(build_fetch_body(urls, **kwargs)),
    }


def has_key(env):
    """True when a non-empty TINYFISH_API_KEY is in the environment."""
    value = (env or {}).get(KEY_ENV)
    return bool(value and str(value).strip())


def flag_enabled(env, name):
    """A feature flag env var. Absent or empty means ENABLED (the
    default preserves current behaviour until the user opens the Search
    section). "0", "false", "no", "off" (any case, stripped) disable."""
    value = (env or {}).get(name)
    if value is None or str(value).strip() == "":
        return True
    return str(value).strip().lower() not in ("0", "false", "no", "off")


def decide_search(env):
    """Which search path to take, from the process environment.

    Returns "tinyfish" only when a key is present AND the TinyFish
    search flag is enabled; else "builtin" (the built-in web_search,
    exactly as now). Never errors on a missing key.
    """
    if has_key(env) and flag_enabled(env, FLAG_SEARCH_ENV):
        return "tinyfish"
    return "builtin"


def decide_fetch(env):
    """Which fetch path to take, from the process environment."""
    if has_key(env) and flag_enabled(env, FLAG_FETCH_ENV):
        return "tinyfish"
    return "builtin"


def ddg_enabled(env):
    """DuckDuckGo Instant Answer complement. Default on."""
    return flag_enabled(env, FLAG_DDG_ENV)


def error_action(status):
    """What the skill does for a TinyFish HTTP status.

    Returns (action, user_message). 'fallback' means use the built-in
    tools for this request. 'retry_free_path' is the one 404 retry.
    """
    if status == 401:
        return ("fallback",
                "TinyFish key looks invalid; check/re-enter it in "
                "Settings -> Environments.")
    if status == 402:
        return ("fallback",
                "TinyFish daily free allowance is used up until 00:00 UTC.")
    if status == 429:
        return ("fallback",
                "TinyFish rate limit hit; fell back to built-in search.")
    if status == 404:
        return ("retry_free_path",
                "Root path 404; retry once at /free/search or /free/fetch.")
    if status is not None and status >= 500:
        return ("fallback", "TinyFish is having trouble; fell back.")
    return ("ok", "")


def _check(name, cond, results):
    results.append((name, bool(cond)))
    if not cond:
        print(f"  FAIL: {name}")


def selftest():
    results = []
    c = lambda n, ok: _check(n, ok, results)

    # --- search url ---
    u = build_search_url("python programming")
    c("search root path", u.startswith(SEARCH_HOST + "/?"))
    c("search query encoded", "query=python+programming" in u)
    c("search language default en", "language=en" in u)
    u2 = build_search_url("news today", domain_type="news",
                          recency_minutes=60, location="US", page=2)
    c("search domain_type news", "domain_type=news" in u2)
    c("search recency_minutes", "recency_minutes=60" in u2)
    c("search location", "location=US" in u2)
    c("search page", "page=2" in u2)
    u3 = build_search_url("x", use_free_path=True)
    c("search free path alternate", u3.startswith(SEARCH_HOST + "/free/search?"))
    try:
        build_search_url("  ")
        c("search empty query rejected", False)
    except ValueError:
        c("search empty query rejected", True)
    try:
        build_search_url("x", domain_type="bogus")
        c("search bad domain_type rejected", False)
    except ValueError:
        c("search bad domain_type rejected", True)
    try:
        build_search_url("x", recency_minutes=0)
        c("search recency 0 rejected", False)
    except ValueError:
        c("search recency 0 rejected", True)
    try:
        build_search_url("x", page=11)
        c("search page 11 rejected", False)
    except ValueError:
        c("search page 11 rejected", True)

    # --- fetch body ---
    b = build_fetch_body(["https://example.com"], fmt="markdown")
    c("fetch urls kept", b["urls"] == ["https://example.com"])
    c("fetch format markdown", b["format"] == "markdown")
    c("fetch body is json-serialisable", bool(json.dumps(b)))
    b2 = build_fetch_body(["https://a.example", "https://b.example"],
                          fmt="json", purpose="compare", links=True, ttl=0)
    c("fetch 2 urls", len(b2["urls"]) == 2)
    c("fetch format json", b2["format"] == "json")
    c("fetch purpose kept", b2["purpose"] == "compare")
    c("fetch links kept", b2["links"] is True)
    c("fetch ttl 0 kept", b2["ttl"] == 0)
    for bad, name in [
            ([], "fetch 0 urls rejected"),
            ([f"https://x{i}.example" for i in range(11)],
             "fetch 11 urls rejected"),
    ]:
        try:
            build_fetch_body(bad)
            c(name, False)
        except ValueError:
            c(name, True)
    try:
        build_fetch_body(["https://example.com"], fmt="pdf")
        c("fetch bad format rejected", False)
    except ValueError:
        c("fetch bad format rejected", True)
    try:
        build_fetch_body(["https://example.com"], purpose="x" * 2001)
        c("fetch purpose too long rejected", False)
    except ValueError:
        c("fetch purpose too long rejected", True)

    # --- ddg instant answer ---
    d = build_ddg_ia_url("python programming")
    c("ddg ia host", d.startswith(DDG_IA + "?"))
    c("ddg ia format json", "format=json" in d)
    c("ddg ia no_html", "no_html=1" in d)
    c("ddg ia query encoded", "q=python+programming" in d)
    try:
        build_ddg_ia_url(" ")
        c("ddg ia empty query rejected", False)
    except ValueError:
        c("ddg ia empty query rejected", True)

    # --- python request construction (no curl, no argv key) ---
    r = build_search_request("python programming", FAKE_KEY)
    c("search request method GET", r["method"] == "GET")
    c("search request url root path",
      r["url"].startswith(SEARCH_HOST + "/?"))
    c("search request header carries key",
      r["headers"].get("X-API-Key") == FAKE_KEY)
    c("search request url has no key", FAKE_KEY not in r["url"])
    c("search request Accept json",
      r["headers"].get("Accept") == "application/json")
    c("search request body is None", r["body"] is None)
    try:
        build_search_request("x", "")
        c("search request empty key rejected", False)
    except ValueError:
        c("search request empty key rejected", True)
    f = build_fetch_request(["https://example.com"], FAKE_KEY)
    c("fetch request method POST", f["method"] == "POST")
    c("fetch request url fetch root", f["url"] == FETCH_HOST + "/")
    c("fetch request header carries key",
      f["headers"].get("X-API-Key") == FAKE_KEY)
    c("fetch request Content-Type json",
      f["headers"].get("Content-Type") == "application/json")
    c("fetch request body is valid JSON with urls",
      json.loads(f["body"])["urls"] == ["https://example.com"])
    c("fetch request body has no key", FAKE_KEY not in f["body"])
    try:
        build_fetch_request(["https://example.com"], "   ")
        c("fetch request blank key rejected", False)
    except ValueError:
        c("fetch request blank key rejected", True)

    # --- env decision: key + flags ---
    key_env = {KEY_ENV: FAKE_KEY}
    c("has_key true when set", has_key(key_env))
    c("has_key false when absent", not has_key({}))
    c("has_key false when None env", not has_key(None))
    c("has_key false when blank", not has_key({KEY_ENV: "   "}))
    c("decide_search tinyfish with key",
      decide_search(key_env) == "tinyfish")
    c("decide_search builtin without key", decide_search({}) == "builtin")
    c("decide_search builtin when flag 0",
      decide_search({KEY_ENV: FAKE_KEY, FLAG_SEARCH_ENV: "0"}) == "builtin")
    c("decide_search tinyfish when flag absent (default on)",
      decide_search(key_env) == "tinyfish")
    c("decide_search tinyfish when flag 1",
      decide_search({KEY_ENV: FAKE_KEY, FLAG_SEARCH_ENV: "1"}) == "tinyfish")
    c("decide_fetch tinyfish with key",
      decide_fetch(key_env) == "tinyfish")
    c("decide_fetch builtin without key", decide_fetch({}) == "builtin")
    c("decide_fetch builtin when flag 0",
      decide_fetch({KEY_ENV: FAKE_KEY, FLAG_FETCH_ENV: "0"}) == "builtin")
    c("decide_fetch tinyfish when flag absent (default on)",
      decide_fetch(key_env) == "tinyfish")
    c("search and fetch flags are independent",
      decide_search({KEY_ENV: FAKE_KEY, FLAG_SEARCH_ENV: "0"}) == "builtin"
      and decide_fetch({KEY_ENV: FAKE_KEY, FLAG_SEARCH_ENV: "0"}) == "tinyfish")
    c("ddg enabled by default", ddg_enabled({}))
    c("ddg enabled with key", ddg_enabled(key_env))
    c("ddg disabled when flag 0",
      not ddg_enabled({FLAG_DDG_ENV: "0"}))
    for val in ("false", "FALSE", "False", "no", "NO", "off", "OFF", " 0 "):
        c(f"flag {val!r} disables",
          not flag_enabled({FLAG_SEARCH_ENV: val}, FLAG_SEARCH_ENV))
    for val in ("1", "true", "TRUE", "yes", "YES", "on", "ON", " 1 "):
        c(f"flag {val!r} enables",
          flag_enabled({FLAG_SEARCH_ENV: val}, FLAG_SEARCH_ENV))
    c("flag absent enables",
      flag_enabled({}, FLAG_SEARCH_ENV))
    c("flag empty enables",
      flag_enabled({FLAG_SEARCH_ENV: ""}, FLAG_SEARCH_ENV))

    # --- error mapping ---
    c("401 -> fallback + invalid key + Settings",
      error_action(401)[0] == "fallback"
      and "invalid" in error_action(401)[1]
      and "Settings" in error_action(401)[1])
    c("402 -> fallback + allowance",
      error_action(402)[0] == "fallback" and "allowance" in error_action(402)[1])
    c("429 -> fallback + rate limit",
      error_action(429)[0] == "fallback" and "rate limit" in error_action(429)[1].lower())
    c("404 -> retry free path", error_action(404)[0] == "retry_free_path")
    c("500 -> fallback", error_action(500)[0] == "fallback")
    c("503 -> fallback", error_action(503)[0] == "fallback")
    c("200 -> ok", error_action(200)[0] == "ok")

    # --- env var names + the console env endpoint ---
    for name in (KEY_ENV,) + FEATURE_ENVS:
        c(f"env name {name} matches QwenPaw key rule",
          bool(ENV_KEY_RE.fullmatch(name)))
    c("save endpoint is PATCH /api/envs",
      ENVS_API == "/api/envs" and ENVS_SAVE_METHOD == "PATCH")
    c("save is PATCH not PUT (PUT would wipe other vars)",
      ENVS_SAVE_METHOD != "PUT")
    c("feature flags are three env vars",
      FEATURE_ENVS == (FLAG_SEARCH_ENV, FLAG_FETCH_ENV, FLAG_DDG_ENV))
    c("built-in is not a flag (fallback is never disableable)",
      "TINYFISH_BUILTIN" not in FEATURE_ENVS
      and not any("BUILTIN" in n for n in FEATURE_ENVS))

    # --- SKILL.md matches the Settings-based design (fail-first: the old
    # vault-based SKILL.md fails these) ---
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "SKILL.md")) as fh:
        doc = fh.read()
    c("doc names the key env var", KEY_ENV in doc)
    c("doc names Settings -> Environments",
      "Settings" in doc and "Environment" in doc)
    c("doc names PATCH /api/envs",
      "PATCH" in doc and "/api/envs" in doc)
    c("doc reads the key from os.environ", "os.environ" in doc)
    c("doc uses python not curl-with-key",
      "python3" in doc and "X-API-Key: $" not in doc)
    # The doc may NAME the vault broker in a "we do NOT use it" sentence,
    # but it must not contain the vault MECHANISM (the /list + /run calls,
    # the broker port, the broker address) as the way to get the key.
    c("doc has no vault broker mechanism",
      "vault_run" not in doc
      and "vault_list" not in doc
      and "8896" not in doc
      and "172.18.0.1" not in doc)
    c("doc states the fallback (no key = built-in)",
      "built-in" in doc and "fallback" in doc.lower())
    c("doc names the three feature flags",
      all(n in doc for n in FEATURE_ENVS))
    # The frontmatter (between the first two --- lines) must NOT declare
    # an env: list under requires — declaring the key required would make
    # QwenPaw skip the skill whenever no key is set, breaking the fallback.
    # (The doc BODY explains this in prose; only the frontmatter is gated.)
    parts = doc.split("---")
    frontmatter = parts[1] if len(parts) >= 3 else ""
    c("frontmatter declares no require envs (key stays optional)",
      "env:" not in frontmatter)

    # --- constants match the docs ---
    c("daily limit 12000", SEARCH_DAILY_LIMIT == 12000)
    c("rate limit 30/min", SEARCH_RATE_PER_MIN == 30)
    c("max fetch urls 10", MAX_FETCH_URLS == 10)
    c("search host is tinyfish", "tinyfish.ai" in SEARCH_HOST)
    c("fetch host is tinyfish", "tinyfish.ai" in FETCH_HOST)
    c("no china host", "alibaba" not in SEARCH_HOST and "alibaba" not in FETCH_HOST)

    passed = sum(1 for _, ok in results if ok)
    failed = len(results) - passed
    print(f"{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    print("usage: test_tinyfish.py --selftest")
    sys.exit(2)
