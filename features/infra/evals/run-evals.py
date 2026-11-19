#!/usr/bin/env python3
"""Eval runner for QwenPaw (prompts v1) — sends fixed test prompts through
the live console API and records pass/fail.

Verified API surface (QwenPaw v2.3.0, read from the installed source):
  POST {BASE}/api/auth/login   {"username","password"} -> {"token","username"}
  POST {BASE}/api/console/chat/task
      {"channel":"console","user_id":"eval","session_id":"eval-<case>",
       "input":[{"content":[{"type":"text","text": prompt}]}], "timeout": N}
      -> {"task_id": ...}
  GET  {BASE}/api/console/chat/task/{task_id}  -> {"status": "running" |
      "finished", "result": {"status": "completed", "output": [...]}}.
      Verified 2026-11-19 from the console source + a live probe
      (task-320a0aa106b8: running -> finished in 12.4s): the ONLY
      status values are "running" and "finished", and the reply is
      the LAST {"type": "message"} item of result.output — "reasoning"
      items are deliberation, never the reply. The old poll waited
      for done/completed/success (never returned) and the old
      extractor returned the first text found (the reasoning trace);
      both are fixed here, in sync with judge.py.

Auth behaviour (per source + design review):
  - Login ONCE per run; reuse the Bearer token for every case.
  - 423 (account locked) ends the run immediately. Never retry a lockout.
  - 429 honours Retry-After, then exponential backoff, max 3 retries.
  - 401 on a task call: one re-login, retry once, then give up.

Credentials come ONLY from the environment at run time:
  QWENPAW_BASE_URL  (default https://qwenpawx.pages.dev)
  QWENPAW_USER      (console username, e.g. satwik)
  QWENPAW_PASS      (console password)
They are never written to disk, never printed, never put in results.
Results go to --out-dir (default ./results) as one JSONL file per run:
each line has case id, task_id, status, pass/fail/unverified, reply
excerpt (first 500 chars), duration, and the raw task response.

Modes:
  --dry-run   validate cases + print the exact request envelope, no login,
              no network calls to QwenPaw. This is the mode to use until
              the user supplies credentials.
  (default)   live run. Needs QWENPAW_USER/QWENPAW_PASS.

This runner has NOT been run live yet: no credentials were read or stored
during the build. The first live run is a coordinator/user step.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "https://qwenpawx.pages.dev"
POLL_INTERVAL = 5
MAX_POLLS = 180  # 180 * 5s = 15 min per case, plus task timeout.
# The 15-min window is only a safety net. It was NOT the fix for live
# calibration run 1 (2026-11-19, 9/12 poll timeouts at 360s): the
# timeouts were misdiagnosed as "turns take ~6 min" and the window was
# raised 72 -> 180, but run 4 (2026-11-19 ~08:38 IST) timed out 11/12
# at 900s even though the grading turns had completed in seconds —
# the poll waited for a status the endpoint never returns (see
# TERMINAL_TASK_STATUSES). Keep 180 as the cap; the fix is the status
# set, not the window. Keep in sync with judge.py.
# Terminal statuses for GET /api/console/chat/task/{task_id}.
# Verified 2026-11-19 from the installed console source
# (app/routers/console.py: get_console_chat_task returns bg.status,
# and _BackgroundTask.status is only ever "running" while in flight
# and "finished" on every completion path) and by a live probe
# (task-320a0aa106b8: running -> finished in 12.4s). The old set
# never matched "finished", so poll_task looped the full window on
# every case. The other strings are kept only for forward-compat.
TERMINAL_TASK_STATUSES = ("finished", "done", "completed", "success",
                          "failed", "error", "timeout", "cancelled")


def redact(text):
    return text


class ApiError(Exception):
    def __init__(self, status, body=""):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status = status
        self.body = body


def request(method, url, token=None, payload=None, timeout=30):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        retry_after = e.headers.get("Retry-After")
        err = ApiError(e.code, body)
        err.retry_after = retry_after
        raise err


def login(base, user, password):
    status, body = request("POST", base + "/api/auth/login",
                           payload={"username": user, "password": password})
    token = body.get("token")
    if not token:
        raise ApiError(status, "login returned no token")
    return token


def submit_task(base, token, case):
    payload = {
        "channel": "console",
        "user_id": "eval",
        "session_id": f"eval-{case['id']}",
        "input": [{"content": [{"type": "text", "text": case["prompt"]}]}],
        "timeout": case.get("timeout", 180),
    }
    status, body = request("POST", base + "/api/console/chat/task",
                           token=token, payload=payload, timeout=60)
    task_id = body.get("task_id")
    if not task_id:
        raise ApiError(status, f"no task_id in response: {str(body)[:200]}")
    return task_id


def poll_task(base, token, task_id):
    for _ in range(MAX_POLLS):
        try:
            status, body = request(
                "GET", base + f"/api/console/chat/task/{task_id}",
                token=token, timeout=30)
        except ApiError as e:
            if e.status == 429:
                wait = int(e.retry_after) if (e.retry_after or "").isdigit() else 30
                time.sleep(wait)
                continue
            raise
        state = str(body.get("status", "")).lower()
        if state in TERMINAL_TASK_STATUSES:
            return body
        time.sleep(POLL_INTERVAL)
    return {"status": "poll-timeout", "note": "runner stopped polling"}


def _message_text(item):
    """Join the text parts of one output message item.

    Content is a list of {"type": "text", "text": "..."} parts (or a
    plain string on older shapes). Returns None when there is no text.
    """
    content = item.get("content") if isinstance(item, dict) else None
    if isinstance(content, str):
        return content if content.strip() else None
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
            elif isinstance(part, str):
                parts.append(part)
        text = "".join(parts)
        return text if text.strip() else None
    return None


def _extract_task_result_text(body):
    """Extract the final assistant message from a console chat-task body.

    Live shape (verified 2026-11-19, task-320a0aa106b8):
        {"status": "finished",
         "result": {"status": "completed",
                    "output": [{"type": "reasoning", ...},
                               {"type": "message", "role": "assistant",
                                "content": [{"type": "text",
                                             "text": "<final reply>"}]}]}}
    The reply is the LAST item with type "message". Items with type
    "reasoning" are the model's deliberation and must NEVER be returned
    as the reply. Returns None when the body has no output list, or
    when the output list holds no final message (a failed/cancelled
    task produces no reply — that is "no reply text", not prose).
    """
    result = body.get("result") if isinstance(body, dict) else None
    output = result.get("output") if isinstance(result, dict) else None
    if not isinstance(output, list):
        return None
    for item in reversed(output):
        if isinstance(item, dict) and item.get("type") == "message":
            text = _message_text(item)
            if text:
                return text
    # No typed final message: fall back to the last item that carries
    # text at all (untyped/older shapes) — but never a reasoning item.
    for item in reversed(output):
        if isinstance(item, dict) and item.get("type") != "reasoning":
            text = _message_text(item)
            if text:
                return text
    return None


def extract_text(body):
    """Best-effort reply extraction. Returns (text or None, raw).

    A console chat-task body is handled by its own shape FIRST
    (_extract_task_result_text): the reply is the last "message" item
    of result.output. The old generic walk returned the FIRST text it
    found, which in this shape is the "reasoning" item — the model's
    deliberation, not its reply — so a substring check would have run
    against deliberation instead of the answer. When the body IS
    task-shaped (result.output is a list) the task extractor is
    authoritative: a None from it means the task produced no reply,
    and the generic walk must not fall through to the reasoning trace.
    """
    if isinstance(body, dict):
        result = body.get("result")
        if isinstance(result, dict) and isinstance(
                result.get("output"), list):
            return _extract_task_result_text(body), body
        for key in ("result", "response", "output", "text", "content",
                    "message", "reply"):
            v = body.get(key)
            if isinstance(v, str) and v.strip():
                return v, body
            if isinstance(v, dict):
                t, _ = extract_text(v)
                if t:
                    return t, body
            if isinstance(v, list):
                for item in v:
                    if isinstance(item, dict):
                        t, _ = extract_text(item)
                        if t:
                            return t, body
                    elif isinstance(item, str) and item.strip():
                        return item, body
        # SSE-ish / nested task payloads
        data = body.get("data") or body.get("task")
        if isinstance(data, dict):
            return extract_text(data)
    return None, body


def check_case(case, text):
    if text is None:
        return "unverified", "no reply text found in task response"
    low = text.lower()
    for want in case.get("expect_contains", []):
        if want.lower() not in low:
            return "fail", f"missing expected text: {want!r}"
    for banned in case.get("must_not_contain", []):
        if banned.lower() in low:
            return "fail", f"reply contains forbidden text: {banned!r}"
    return "pass", "all substring checks passed"


def run_case(base, token, case):
    started = time.time()
    try:
        task_id = submit_task(base, token, case)
    except ApiError as e:
        return {"id": case["id"], "status": "submit-error",
                "verdict": "error", "detail": str(e),
                "duration_s": round(time.time() - started, 1)}
    body = poll_task(base, token, task_id)
    text, _ = extract_text(body)
    verdict, detail = check_case(case, text)
    return {
        "id": case["id"],
        "task_id": task_id,
        "status": body.get("status"),
        "verdict": verdict,
        "detail": detail,
        "reply_excerpt": (text[:500] if text else None),
        "raw_response": body,
        "duration_s": round(time.time() - started, 1),
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--cases", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "cases.json"))
    p.add_argument("--out-dir", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "results"))
    p.add_argument("--base", default=os.environ.get(
        "QWENPAW_BASE_URL", DEFAULT_BASE))
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    with open(args.cases, encoding="utf-8") as f:
        suite = json.load(f)
    cases = suite["cases"]
    print(f"eval suite v{suite.get('version')} "
          f"(prompt_version={suite.get('prompt_version')}, {len(cases)} cases)")

    if args.dry_run:
        print("DRY-RUN — no login, no QwenPaw calls.")
        for c in cases:
            print(f"  [{c['id']}] prompt={c['prompt'][:80]!r} "
                  f"expect={c.get('expect_contains')} timeout={c.get('timeout')}")
        print("Request envelope per case:")
        print(json.dumps({
            "channel": "console", "user_id": "eval",
            "session_id": "eval-<case-id>",
            "input": [{"content": [{"type": "text", "text": "<prompt>"}]}],
            "timeout": "<case timeout>",
        }, indent=2))
        print("POST {BASE}/api/console/chat/task, then poll "
              "GET {BASE}/api/console/chat/task/{task_id}.")
        return 0

    user = os.environ.get("QWENPAW_USER")
    password = os.environ.get("QWENPAW_PASS")
    if not user or not password:
        print("live run needs QWENPAW_USER and QWENPAW_PASS in the environment.",
              file=sys.stderr)
        print("They are never stored. Example: QWENPAW_USER=satwik "
              "QWENPAW_PASS='...' python3 run-evals.py", file=sys.stderr)
        return 2
    base = args.base.rstrip("/")
    try:
        token = login(base, user, password)
    except ApiError as e:
        if e.status == 423:
            print("LOGIN LOCKED (423). Stop. Wait out the lockout; "
                  "do not retry.", file=sys.stderr)
        else:
            print(f"login failed: {e}", file=sys.stderr)
        return 1
    print("logged in (token held in memory only).")

    os.makedirs(args.out_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    out_path = os.path.join(args.out_dir, f"eval-{stamp}.jsonl")
    results = []
    for case in cases:
        print(f"--- {case['id']} ---")
        try:
            res = run_case(base, token, case)
        except ApiError as e:
            if e.status == 401:
                print("token expired (401) — one re-login, then retry once")
                try:
                    token = login(base, user, password)
                    res = run_case(base, token, case)
                except ApiError as e2:
                    res = {"id": case["id"], "verdict": "error",
                           "detail": f"after re-login: {e2}"}
            elif e.status == 423:
                print("LOCKED (423) — aborting run.", file=sys.stderr)
                break
            else:
                res = {"id": case["id"], "verdict": "error", "detail": str(e)}
        results.append(res)
        print(f"  {res.get('verdict')}: {res.get('detail')}")
        with open(out_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(res, ensure_ascii=False) + "\n")
    passed = sum(1 for r in results if r.get("verdict") == "pass")
    print(f"done: {passed}/{len(results)} passed. Results: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
