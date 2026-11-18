#!/usr/bin/env python3
"""TinyFish free search + fetch: request-building and fallback logic.

This is the reference implementation of the rules in SKILL.md, kept as
pure stdlib functions so the machine-free suite can check them without
calling the live API (which needs a real key). It mocks nothing because
it never touches the network: it only builds the request the skill
tells the agent to send, and decides which path to take.

Run: python3 features/tinyfish/test_tinyfish.py --selftest
Prints "N passed, M failed" (the T85 harness greps for that tally).
"""
import json
import sys
import urllib.parse

SEARCH_HOST = "https://api.search.tinyfish.ai"
FETCH_HOST = "https://api.fetch.tinyfish.ai"
DDG_IA = "https://api.duckduckgo.com/"
VAULT_BROKER = "http://172.18.0.1:8896"
VAULT_ITEM = "tinyfish"
SEARCH_DAILY_LIMIT = 12000
SEARCH_RATE_PER_MIN = 30
MAX_FETCH_URLS = 10


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


def build_vault_run_argv(curl_cmd):
    """Broker /run argv for a curl call that needs $TINYFISH.

    A bare argv list does NOT expand environment variables, so the curl
    must run through `sh -c`. Returns the full /run request body.
    """
    return {"names": [VAULT_ITEM],
            "argv": ["sh", "-c", curl_cmd]}


def decide_path(vault_items):
    """Which search/fetch path to take, from a vault /list result.

    Returns "tinyfish" when a `tinyfish` item exists, else "builtin"
    (the built-in web_search / web_fetch, exactly as now). Never errors
    on a missing key — the fallback is the normal path.
    """
    names = {i.get("name") for i in (vault_items or [])}
    return "tinyfish" if VAULT_ITEM in names else "builtin"


def error_action(status):
    """What the skill does for a TinyFish HTTP status.

    Returns (action, user_message). 'fallback' means use the built-in
    tools for this request. 'retry_free_path' is the one 404 retry.
    """
    if status == 401:
        return ("fallback",
                "TinyFish key looks invalid; check/re-enter it in the vault.")
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

    # --- vault_run argv (the sh -c expansion rule) ---
    r = build_vault_run_argv('curl -s "https://api.search.tinyfish.ai/?query=x" -H "X-API-Key: $TINYFISH"')
    c("vault_run names tinyfish", r["names"] == ["tinyfish"])
    c("vault_run uses sh -c", r["argv"][0] == "sh" and r["argv"][1] == "-c")
    c("vault_run curl references $TINYFISH", "$TINYFISH" in r["argv"][2])
    c("vault_run curl sends X-API-Key", "X-API-Key" in r["argv"][2])
    c("vault_run does not embed a key value",
      "TINYFISH_API_KEY" not in r["argv"][2] or "$TINYFISH" in r["argv"][2])

    # --- fallback decision ---
    c("decide tinyfish when item present",
      decide_path([{"name": "github"}, {"name": "tinyfish"}]) == "tinyfish")
    c("decide builtin when only github",
      decide_path([{"name": "github"}]) == "builtin")
    c("decide builtin when vault empty", decide_path([]) == "builtin")
    c("decide builtin when list is None", decide_path(None) == "builtin")

    # --- error mapping ---
    c("401 -> fallback + invalid key",
      error_action(401)[0] == "fallback" and "invalid" in error_action(401)[1])
    c("402 -> fallback + allowance",
      error_action(402)[0] == "fallback" and "allowance" in error_action(402)[1])
    c("429 -> fallback + rate limit",
      error_action(429)[0] == "fallback" and "rate limit" in error_action(429)[1].lower())
    c("404 -> retry free path", error_action(404)[0] == "retry_free_path")
    c("500 -> fallback", error_action(500)[0] == "fallback")
    c("503 -> fallback", error_action(503)[0] == "fallback")
    c("200 -> ok", error_action(200)[0] == "ok")

    # --- constants match the docs ---
    c("daily limit 12000", SEARCH_DAILY_LIMIT == 12000)
    c("rate limit 30/min", SEARCH_RATE_PER_MIN == 30)
    c("max fetch urls 10", MAX_FETCH_URLS == 10)
    c("vault item is tinyfish", VAULT_ITEM == "tinyfish")
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
