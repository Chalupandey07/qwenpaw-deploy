#!/usr/bin/env python3
"""TinyFish free search + fetch THROUGH MONID: argv building + fallbacks.

Route (2026-11-22, v3.0): the ONLY way to reach TinyFish is the Monid CLI
on Monid's two FREE endpoints:

    monid run -p tinyfish -e /free/search     # search  ($0.00/call)
    monid run -p tinyfish -e /free/fetch      # fetch   ($0.00/result)

The PAID endpoints /search ($0.00175/call) and /fetch ($0.001/result)
are HARD-BLOCKED. They are never called — not on retry, not on error,
not "just once". build_run_argv() refuses them, and the selftest proves
no argv can be constructed that names a paid endpoint.

Why the direct TinyFish API is gone: v2.0 called
https://api.search.tinyfish.ai / https://api.fetch.tinyfish.ai with an
X-API-Key header and got 401 INVALID_API_KEY. The saved key is a MONID
key (35 chars, "moni" prefix), not a TinyFish key — it is only valid
against Monid's gateway. Routing through Monid is the fix.

Key source: TINYFISH_API_KEY in the environment (the Monid key; the name
is historical — TASKS.md T2.2 keeps it as the alias). The Monid CLI has
NO key environment variable: it reads ~/.config/monid/credentials.yaml
plus active_key in ~/.config/monid/config.yaml, and honours
XDG_CONFIG_HOME. So the skill bootstraps a 0700 temp dir with 0600 files
and points XDG_CONFIG_HOME at it — the key never enters argv. Do NOT use
`monid keys add -k "$KEY"`: that expands the key into the process
argument list, readable in /proc.

Why the key is NOT in require_envs: QwenPaw's resolve_effective_skills
SKIPS a skill whose declared require_envs are unmet, so declaring
TINYFISH_API_KEY required would disable the skill whenever no key is
set — and the skill must keep working without a key (built-in fallback).
The key and the feature flags are OPTIONAL env vars read from
os.environ with safe defaults. The frontmatter declares only bins.

This is the reference implementation of the rules in SKILL.md, kept as
pure stdlib functions so the machine-free suite can check them without
calling the live API (which needs a real key). It never touches the
network: it only builds the argv the skill runs, and decides which path
to take.

Run: python3 features/tinyfish/test_tinyfish.py --selftest
Prints "N passed, M failed" (the T116 harness greps for that tally).
"""
import json
import os
import re
import sys

# --- The Monid route -------------------------------------------------------
MONID_BIN = "monid"
PROVIDER = "tinyfish"
FREE_SEARCH = "/free/search"
FREE_FETCH = "/free/fetch"
# Paid endpoints. Never callable — build_run_argv() rejects them.
PAID_ENDPOINTS = ("/search", "/fetch")
ALLOWED_ENDPOINTS = (FREE_SEARCH, FREE_FETCH)

# Verified 2026-11-22 via `monid inspect` — NOT guessed.
PRICE_FREE_SEARCH = {"type": "PER_CALL", "value": 0.0}
PRICE_FREE_FETCH = {"type": "PER_RESULT", "value": 0.0}
PRICE_PAID_SEARCH = {"type": "PER_CALL", "value": 0.00175}
PRICE_PAID_FETCH = {"type": "PER_RESULT", "value": 0.001}
SEARCH_LIMITS = "30/min, 500/hour per workspace"
FETCH_LIMITS = "150 URLs/min, 1,000 URLs/day per workspace"

# The retired direct route — must never appear in the skill again.
FORBIDDEN_HOSTS = ("api.search.tinyfish.ai", "api.fetch.tinyfish.ai")
FORBIDDEN_HEADER = "X-API-Key"

# /free/search is GET (query params -> --query); /free/fetch is POST
# (JSON body -> -i). Passing the wrong flag is rejected by the CLI.
SEARCH_METHOD = "GET"
FETCH_METHOD = "POST"

DDG_IA = "https://api.duckduckgo.com/"
MAX_FETCH_URLS = 10
SEARCH_PAGE_MAX = 10

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
FAKE_KEY = "monid_test_key_fixture"


# --- /free/search: exact schema (GET, queryParams) -------------------------
SEARCH_PARAMS = {
    "query": {"type": "string", "minLength": 1, "required": True},
    "purpose": {"type": "string", "maxLength": 2000},
    "location": {"type": "string", "minLength": 1},
    "language": {"type": "string", "minLength": 1},
    "include_domains": {"type": "string", "minLength": 1},
    "exclude_domains": {"type": "string", "minLength": 1},
    "recency_minutes": {"type": "integer", "minimum": 1,
                        "maximum": 5256000},
    "after_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
    "before_date": {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"},
    "domain_type": {"type": "string", "enum": ["web", "news",
                                               "research_paper"]},
    "pub_year_min": {"type": "integer", "minimum": 0, "maximum": 9999},
    "pub_year_max": {"type": "integer", "minimum": 0, "maximum": 9999},
    "page": {"type": "integer", "minimum": 0, "maximum": SEARCH_PAGE_MAX},
}

# --- /free/fetch: exact schema (POST, body) -------------------------------
FETCH_PARAMS = {
    "urls": {"type": "array", "minItems": 1, "maxItems": MAX_FETCH_URLS,
             "required": True},
    "purpose": {"type": "string", "maxLength": 2000},
    "format": {"type": "string", "enum": ["markdown", "html", "json"]},
    "links": {"type": "boolean"},
    "image_links": {"type": "boolean"},
    "ttl": {"type": "integer", "minimum": 0},
    "per_url_timeout_ms": {"type": "integer", "minimum": 1,
                           "maximum": 110000},
    "if_none_match": {"type": "string", "minLength": 1},
    "if_modified_since": {"type": "string", "minLength": 1},
    "include_etag_and_last_modified": {"type": "boolean"},
    "include_selectors": {"type": "array", "minItems": 1, "maxItems": 20},
    "exclude_selectors": {"type": "array", "minItems": 1, "maxItems": 20},
}


def _validate(params, schema, where):
    """Reject anything not in the endpoint's real schema."""
    if not isinstance(params, dict):
        raise ValueError(f"{where} params must be a dict")
    unknown = set(params) - set(schema)
    if unknown:
        raise ValueError(f"{where} got unknown params: {sorted(unknown)}")
    for name, value in params.items():
        rule = schema[name]
        if rule.get("required") and value in (None, ""):
            raise ValueError(f"{where} param {name!r} is required")
        kind = rule["type"]
        if kind == "integer":
            if not isinstance(value, int) or isinstance(value, bool):
                raise ValueError(f"{where} {name!r} must be an integer")
            if "minimum" in rule and value < rule["minimum"]:
                raise ValueError(f"{where} {name!r} below minimum")
            if "maximum" in rule and value > rule["maximum"]:
                raise ValueError(f"{where} {name!r} above maximum")
        elif kind == "boolean":
            if not isinstance(value, bool):
                raise ValueError(f"{where} {name!r} must be a boolean")
        elif kind == "array":
            if not isinstance(value, list):
                raise ValueError(f"{where} {name!r} must be a list")
            if "minItems" in rule and len(value) < rule["minItems"]:
                raise ValueError(f"{where} {name!r} has too few items")
            if "maxItems" in rule and len(value) > rule["maxItems"]:
                raise ValueError(f"{where} {name!r} has too many items")
        else:  # string
            if not isinstance(value, str):
                raise ValueError(f"{where} {name!r} must be a string")
            if "minLength" in rule and len(value) < rule["minLength"]:
                raise ValueError(f"{where} {name!r} too short")
            if "maxLength" in rule and len(value) > rule["maxLength"]:
                raise ValueError(f"{where} {name!r} too long")
            if "enum" in rule and value not in rule["enum"]:
                raise ValueError(f"{where} {name!r} not in enum")
            if "pattern" in rule and not re.fullmatch(rule["pattern"], value):
                raise ValueError(f"{where} {name!r} fails pattern")


def build_search_params(query, **kwargs):
    """Validated query-params object for /free/search (--query)."""
    params = {"query": query}
    params.update({k: v for k, v in kwargs.items() if v is not None})
    _validate(params, SEARCH_PARAMS, "search")
    return params


def build_fetch_body(urls, **kwargs):
    """Validated JSON body for /free/fetch (-i). 1-10 urls."""
    body = {"urls": list(urls)}
    body.update({k: v for k, v in kwargs.items() if v is not None})
    _validate(body, FETCH_PARAMS, "fetch")
    return body


def assert_free_endpoint(endpoint):
    """HARD BLOCK: only /free/search and /free/fetch may be used."""
    if endpoint in PAID_ENDPOINTS:
        raise ValueError(
            f"refusing paid endpoint {endpoint!r}: this skill uses only "
            f"{FREE_SEARCH} and {FREE_FETCH}")
    if endpoint not in ALLOWED_ENDPOINTS:
        raise ValueError(
            f"unknown endpoint {endpoint!r}: allowed are "
            f"{FREE_SEARCH} and {FREE_FETCH}")
    return endpoint


def build_run_argv(endpoint, search_params=None, fetch_body=None,
                   wait=90):
    """The exact `monid run ...` argv the skill executes.

    No key is ever an argument — the key reaches the CLI through
    XDG_CONFIG_HOME (see module docstring). Refuses paid endpoints.
    """
    assert_free_endpoint(endpoint)
    argv = [MONID_BIN, "run", "-p", PROVIDER, "-e", endpoint]
    if endpoint == FREE_SEARCH:
        if fetch_body is not None:
            raise ValueError("/free/search takes --query, not -i")
        params = build_search_params(**(search_params or {"query": ""}))
        argv += ["--query", json.dumps(params, separators=(",", ":"))]
    else:
        if search_params is not None:
            raise ValueError("/free/fetch takes -i, not --query")
        body = build_fetch_body(**(fetch_body or {"urls": []}))
        argv += ["-i", json.dumps(body, separators=(",", ":"))]
    argv += ["-w", str(wait), "-j"]
    return argv


def parse_run_output(stdout):
    """`monid run -j` JSON -> (output, is_free).

    Raises ValueError on a CLI error envelope so the caller falls back.
    """
    data = json.loads(stdout)
    if isinstance(data, dict) and "error" in data:
        err = data["error"]
        code = err.get("code") if isinstance(err, dict) else "ERROR"
        raise ValueError(f"monid error {code}")
    if data.get("status") != "COMPLETED":
        raise ValueError(f"run status {data.get('status')!r}")
    amount = (data.get("price") or {}).get("amount") or {}
    is_free = amount.get("value") == 0
    return data.get("output") or {}, is_free


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


def decide_search(env, monid_available=True):
    """Which search path to take, from the process environment.

    Returns "monid" only when a key is present, the CLI is installed,
    and the search flag is enabled; else "builtin" (the built-in
    web_search, exactly as now). Never errors on a missing key.
    """
    if has_key(env) and monid_available and flag_enabled(env, FLAG_SEARCH_ENV):
        return "monid"
    return "builtin"


def decide_fetch(env, monid_available=True):
    """Which fetch path to take, from the process environment."""
    if has_key(env) and monid_available and flag_enabled(env, FLAG_FETCH_ENV):
        return "monid"
    return "builtin"


def ddg_enabled(env):
    """DuckDuckGo Instant Answer complement. Default on."""
    return flag_enabled(env, FLAG_DDG_ENV)


def build_ddg_ia_url(query):
    """DuckDuckGo Instant Answer API url (keyless, works from the box)."""
    if not query or not query.strip():
        raise ValueError("query must be a non-empty string")
    params = {"q": query.strip(), "format": "json", "no_html": "1",
              "skip_disambig": "1"}
    import urllib.parse
    return DDG_IA + "?" + urllib.parse.urlencode(params)


def error_action(code):
    """What the skill does for a Monid/HTTP error.

    Returns (action, user_message). 'fallback' means use the built-in
    tools for this request. 'retry_once' is the single retry.
    """
    text = str(code or "").upper()
    if "AUTH_FAILED" in text or text in ("401", "403"):
        return ("fallback",
                "The Monid key looks invalid; check/re-enter it in "
                "Settings -> Environments.")
    if "PAYMENT" in text or text == "402":
        return ("fallback",
                "The Monid free allowance is used up. Not switching to a "
                "paid endpoint.")
    if text == "429" or "RATE_LIMIT" in text:
        return ("fallback", "Monid rate limit hit; fell back to built-in.")
    if "VALIDATION" in text:
        return ("retry_once",
                "Monid rejected the request shape; retry once with the "
                "documented schema.")
    if "COMMAND_NOT_FOUND" in text or "FILE_NOT_FOUND" in text:
        return ("fallback", "The monid CLI is not installed on this machine.")
    if text[:1] == "5" and len(text) == 3:
        return ("fallback", "Monid is having trouble; fell back.")
    return ("ok", "")


def _strip_code_fences(text):
    """Drop fenced code blocks: a host inside a fence is an instruction
    to call it, which is exactly what must never happen."""
    out, in_fence = [], False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(line)
    return "\n".join(out)


def _only_mentioned_as_retired(text, needle):
    """True when every mention of `needle` sits in a sentence that says
    it is gone/forbidden. Naming a retired route to explain the 401 is
    fine; instructing anyone to call it is not."""
    retired = ("removed", "removes", "remove", "not a", "no direct",
               "never", "retired", "forbidden", "gone", "401", "do not",
               "hard-block", "without", "not part of")
    prose = _strip_code_fences(text)
    if needle not in prose:
        return True
    for para in prose.split("\n\n"):
        if needle not in para:
            continue
        low = para.lower()
        if not any(word in low for word in retired):
            return False
    return True


def _check(name, cond, results):
    results.append((name, bool(cond)))
    if not cond:
        print(f"  FAIL: {name}")


def selftest():
    results = []

    def c(name, ok):
        _check(name, ok, results)

    # --- the route: exactly two endpoints, both free ---
    c("provider is tinyfish", PROVIDER == "tinyfish")
    c("allowed endpoints are the two free ones",
      set(ALLOWED_ENDPOINTS) == {"/free/search", "/free/fetch"})
    c("paid endpoints are named in the blocklist",
      set(PAID_ENDPOINTS) == {"/search", "/fetch"})
    for ep in PAID_ENDPOINTS:
        try:
            build_run_argv(ep, search_params={"query": "x"})
            c(f"paid endpoint {ep} REFUSED", False)
        except ValueError:
            c(f"paid endpoint {ep} REFUSED", True)
    try:
        build_run_argv("/free/scrape", search_params={"query": "x"})
        c("unknown endpoint refused", False)
    except ValueError:
        c("unknown endpoint refused", True)
    for ep in ALLOWED_ENDPOINTS:
        assert_free_endpoint(ep)
    c("free endpoints accepted", True)

    # --- search argv shape (GET -> --query) ---
    argv = build_run_argv(FREE_SEARCH, search_params={"query": "rust lang"})
    c("search argv starts with monid run",
      argv[:2] == ["monid", "run"])
    c("search argv names provider",
      argv[argv.index("-p") + 1] == "tinyfish")
    c("search argv uses /free/search",
      argv[argv.index("-e") + 1] == FREE_SEARCH)
    c("search argv uses --query not -i",
      "--query" in argv and "-i" not in argv)
    c("search argv waits and emits json",
      "-w" in argv and "-j" in argv)
    c("search argv carries no key value",
      all(FAKE_KEY not in str(a) for a in argv))
    q = json.loads(argv[argv.index("--query") + 1])
    c("search query param present", q["query"] == "rust lang")
    argv2 = build_run_argv(FREE_SEARCH, search_params={
        "query": "news", "domain_type": "news", "recency_minutes": 60,
        "location": "US", "page": 2, "include_domains": "github.com"})
    q2 = json.loads(argv2[argv2.index("--query") + 1])
    c("search domain_type", q2["domain_type"] == "news")
    c("search recency_minutes", q2["recency_minutes"] == 60)
    c("search location", q2["location"] == "US")
    c("search page", q2["page"] == 2)
    c("search include_domains", q2["include_domains"] == "github.com")
    try:
        build_run_argv(FREE_SEARCH, fetch_body={"urls": ["https://a.b"]})
        c("search refuses -i (body)", False)
    except ValueError:
        c("search refuses -i (body)", True)

    # --- fetch argv shape (POST -> -i) ---
    fargv = build_run_argv(FREE_FETCH,
                           fetch_body={"urls": ["https://example.com"]})
    c("fetch argv uses /free/fetch",
      fargv[fargv.index("-e") + 1] == FREE_FETCH)
    c("fetch argv uses -i not --query",
      "-i" in fargv and "--query" not in fargv)
    c("fetch argv carries no key value",
      all(FAKE_KEY not in str(a) for a in fargv))
    fb = json.loads(fargv[fargv.index("-i") + 1])
    c("fetch urls kept", fb["urls"] == ["https://example.com"])
    try:
        build_run_argv(FREE_FETCH, search_params={"query": "x"})
        c("fetch refuses --query", False)
    except ValueError:
        c("fetch refuses --query", True)

    # --- schema validation (exact, from monid inspect) ---
    c("search schema has 13 params", len(SEARCH_PARAMS) == 13)
    c("fetch schema has 12 params", len(FETCH_PARAMS) == 12)
    c("search requires query",
      SEARCH_PARAMS["query"].get("required") is True)
    c("fetch requires urls",
      FETCH_PARAMS["urls"].get("required") is True)
    c("fetch urls max 10", FETCH_PARAMS["urls"]["maxItems"] == 10)
    c("search page max 10", SEARCH_PARAMS["page"]["maximum"] == 10)
    c("search domain_type enum",
      SEARCH_PARAMS["domain_type"]["enum"]
      == ["web", "news", "research_paper"])
    c("fetch format enum",
      FETCH_PARAMS["format"]["enum"] == ["markdown", "html", "json"])
    for bad, name in [
        ({"query": ""}, "empty query rejected"),
        ({"query": "x", "domain_type": "bogus"}, "bad domain_type rejected"),
        ({"query": "x", "recency_minutes": 0}, "recency 0 rejected"),
        ({"query": "x", "recency_minutes": 5256001}, "recency too big rejected"),
        ({"query": "x", "page": 11}, "page 11 rejected"),
        ({"query": "x", "after_date": "2026-6-1"}, "bad after_date rejected"),
        ({"query": "x", "purpose": "x" * 2001}, "long purpose rejected"),
        ({"query": "x", "bogus_param": 1}, "unknown search param rejected"),
    ]:
        try:
            build_search_params(**bad)
            c(name, False)
        except ValueError:
            c(name, True)
    for bad, name in [
        ({"urls": []}, "fetch 0 urls rejected"),
        ({"urls": [f"https://x{i}.example" for i in range(11)]},
         "fetch 11 urls rejected"),
        ({"urls": ["https://a.b"], "format": "pdf"}, "bad format rejected"),
        ({"urls": ["https://a.b"], "purpose": "x" * 2001},
         "long fetch purpose rejected"),
        ({"urls": ["https://a.b"], "per_url_timeout_ms": 110001},
         "per_url_timeout too big rejected"),
        ({"urls": ["https://a.b"], "bogus_param": 1},
         "unknown fetch param rejected"),
    ]:
        try:
            build_fetch_body(**bad)
            c(name, False)
        except ValueError:
            c(name, True)
    ok_body = build_fetch_body(
        ["https://a.example", "https://b.example"], format="json",
        purpose="compare", links=True, ttl=0,
        exclude_selectors=["nav", "footer"])
    c("fetch body keeps options",
      ok_body["format"] == "json" and ok_body["links"] is True
      and ok_body["ttl"] == 0 and ok_body["exclude_selectors"] == ["nav", "footer"])

    # --- prices / limits (verified via monid inspect) ---
    c("free search price is 0", PRICE_FREE_SEARCH["value"] == 0)
    c("free fetch price is 0", PRICE_FREE_FETCH["value"] == 0)
    c("paid search price > 0", PRICE_PAID_SEARCH["value"] > 0)
    c("paid fetch price > 0", PRICE_PAID_FETCH["value"] > 0)
    c("search limits documented", "30/min" in SEARCH_LIMITS)
    c("fetch limits documented", "1,000 URLs/day" in FETCH_LIMITS)
    c("search is GET", SEARCH_METHOD == "GET")
    c("fetch is POST", FETCH_METHOD == "POST")

    # --- parse_run_output ---
    good = json.dumps({"runId": "r1", "status": "COMPLETED",
                       "output": {"results": [{"url": "u"}]},
                       "price": {"type": "PER_CALL",
                                 "amount": {"value": 0, "currency": "USD"}}})
    out, is_free = parse_run_output(good)
    c("parse completed output", out["results"][0]["url"] == "u")
    c("parse detects free price", is_free is True)
    paid = json.dumps({"status": "COMPLETED", "output": {},
                       "price": {"type": "PER_CALL",
                                 "amount": {"value": 0.00175}}})
    c("parse flags a paid price", parse_run_output(paid)[1] is False)
    try:
        parse_run_output(json.dumps({"error": {"code": "AUTH_FAILED"}}))
        c("parse raises on error envelope", False)
    except ValueError:
        c("parse raises on error envelope", True)
    try:
        parse_run_output(json.dumps({"status": "FAILED"}))
        c("parse raises on non-completed", False)
    except ValueError:
        c("parse raises on non-completed", True)

    # --- env decision: key + flags + CLI presence ---
    key_env = {KEY_ENV: FAKE_KEY}
    c("has_key true when set", has_key(key_env))
    c("has_key false when absent", not has_key({}))
    c("has_key false when None env", not has_key(None))
    c("has_key false when blank", not has_key({KEY_ENV: "   "}))
    c("decide_search monid with key", decide_search(key_env) == "monid")
    c("decide_search builtin without key", decide_search({}) == "builtin")
    c("decide_search builtin when CLI missing",
      decide_search(key_env, monid_available=False) == "builtin")
    c("decide_search builtin when flag 0",
      decide_search({KEY_ENV: FAKE_KEY, FLAG_SEARCH_ENV: "0"}) == "builtin")
    c("decide_search monid when flag 1",
      decide_search({KEY_ENV: FAKE_KEY, FLAG_SEARCH_ENV: "1"}) == "monid")
    c("decide_fetch monid with key", decide_fetch(key_env) == "monid")
    c("decide_fetch builtin without key", decide_fetch({}) == "builtin")
    c("decide_fetch builtin when CLI missing",
      decide_fetch(key_env, monid_available=False) == "builtin")
    c("decide_fetch builtin when flag 0",
      decide_fetch({KEY_ENV: FAKE_KEY, FLAG_FETCH_ENV: "0"}) == "builtin")
    c("search and fetch flags are independent",
      decide_search({KEY_ENV: FAKE_KEY, FLAG_SEARCH_ENV: "0"}) == "builtin"
      and decide_fetch({KEY_ENV: FAKE_KEY, FLAG_SEARCH_ENV: "0"}) == "monid")
    c("ddg enabled by default", ddg_enabled({}))
    c("ddg disabled when flag 0", not ddg_enabled({FLAG_DDG_ENV: "0"}))
    for val in ("false", "FALSE", "no", "NO", "off", "OFF", " 0 "):
        c(f"flag {val!r} disables",
          not flag_enabled({FLAG_SEARCH_ENV: val}, FLAG_SEARCH_ENV))
    for val in ("1", "true", "yes", "on", " 1 "):
        c(f"flag {val!r} enables",
          flag_enabled({FLAG_SEARCH_ENV: val}, FLAG_SEARCH_ENV))
    c("flag absent enables", flag_enabled({}, FLAG_SEARCH_ENV))
    c("flag empty enables", flag_enabled({FLAG_SEARCH_ENV: ""}, FLAG_SEARCH_ENV))

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

    # --- error mapping ---
    c("AUTH_FAILED -> fallback + Settings",
      error_action("AUTH_FAILED")[0] == "fallback"
      and "Settings" in error_action("AUTH_FAILED")[1])
    c("401 -> fallback", error_action(401)[0] == "fallback")
    c("402 -> fallback, never paid",
      error_action(402)[0] == "fallback"
      and "paid" in error_action(402)[1].lower())
    c("429 -> fallback", error_action(429)[0] == "fallback")
    c("VALIDATION_ERROR -> retry once",
      error_action("VALIDATION_ERROR")[0] == "retry_once")
    c("COMMAND_NOT_FOUND -> fallback",
      error_action("COMMAND_NOT_FOUND")[0] == "fallback")
    c("500 -> fallback", error_action(500)[0] == "fallback")
    c("503 -> fallback", error_action(503)[0] == "fallback")

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
      not any("BUILTIN" in n for n in FEATURE_ENVS))

    # --- SKILL.md matches the Monid design ---
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "SKILL.md")) as fh:
        doc = fh.read()
    with open(os.path.join(here, "README.md")) as fh:
        readme = fh.read()

    c("doc names the key env var", KEY_ENV in doc)
    c("doc names the monid CLI", "monid run" in doc)
    c("doc names both free endpoints",
      FREE_SEARCH in doc and FREE_FETCH in doc)
    c("doc hard-blocks the paid endpoints",
      "/search" in doc and "/fetch" in doc
      and ("hard-block" in doc.lower() or "never call" in doc.lower()))
    c("doc states the paid prices",
      "0.00175" in doc and "0.001" in doc)
    c("doc says the key is a Monid key",
      "Monid" in doc and "not a TinyFish key" in doc)
    c("doc explains the XDG bootstrap", "XDG_CONFIG_HOME" in doc)
    c("doc warns against keys add -k", "monid keys add" in doc)
    c("doc names Settings -> Environments",
      "Settings" in doc and "Environment" in doc)
    c("doc names PATCH /api/envs", "PATCH" in doc and "/api/envs" in doc)
    c("doc reads the key from os.environ", "os.environ" in doc)
    c("doc documents the schemas (query + urls required)",
      "query" in doc and "urls" in doc)
    c("doc states the fallback (no key = built-in)",
      "built-in" in doc and "fallback" in doc.lower())
    c("doc names the three feature flags",
      all(n in doc for n in FEATURE_ENVS))
    # The retired direct route must not come back as an instruction. It
    # may still be NAMED in prose that says it is gone (that is how the
    # 401 root cause is explained) — but never inside a code fence, and
    # never in a paragraph that does not say it is retired/forbidden.
    for forbidden in FORBIDDEN_HOSTS:
        c(f"doc never instructs direct host {forbidden}",
          _only_mentioned_as_retired(doc, forbidden))
        c(f"readme never instructs direct host {forbidden}",
          _only_mentioned_as_retired(readme, forbidden))
    c("doc has no X-API-Key header in a command",
      _only_mentioned_as_retired(doc, FORBIDDEN_HEADER))
    c("readme has no X-API-Key header in a command",
      _only_mentioned_as_retired(readme, FORBIDDEN_HEADER))
    # The frontmatter (between the first two --- lines) must NOT declare
    # an env: list under requires — declaring the key required would make
    # QwenPaw skip the skill whenever no key is set, breaking the fallback.
    parts = doc.split("---")
    frontmatter = parts[1] if len(parts) >= 3 else ""
    c("frontmatter declares no require envs (key stays optional)",
      "env:" not in frontmatter)
    c("frontmatter version is 3.0", 'version: "3.0"' in frontmatter)
    c("doc has no vault broker mechanism",
      "vault_run" not in doc and "vault_list" not in doc
      and "8896" not in doc and "172.18.0.1" not in doc)
    c("readme documents both free endpoints",
      FREE_SEARCH in readme and FREE_FETCH in readme)
    c("readme documents the paid block",
      "hard-blocked" in readme.lower() or "never called" in readme.lower())
    c("readme documents the 401 root cause",
      "401" in readme and "Monid key" in readme)

    passed = sum(1 for _, ok in results if ok)
    failed = len(results) - passed
    print(f"{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    print("usage: test_tinyfish.py --selftest")
    sys.exit(2)
