"""Test the agent-side needs-you path from INSIDE the QwenPaw container.
Run as: docker exec qwenpaw python3 /app/working/testneedsyou.py
Uses $CAMOUFOX_BRIDGE_TOKEN exactly as the DriverCard instructs the agent to.
Never prints the token (only its length). The empty-text call proves auth
passed (400 empty_text) WITHOUT creating a real needs-you banner.
"""
import json
import os
import urllib.error
import urllib.request

TOKEN = os.environ.get("CAMOUFOX_BRIDGE_TOKEN", "")
print("token_len:", len(TOKEN))
URL = "http://172.18.0.1:8899/needs-you"


def post(headers, data):
    req = urllib.request.Request(
        URL,
        data=json.dumps(data).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


# 1. No token at all -> must be 401 (bridge gate works).
print("no-token:", post({"Content-Type": "application/json"}, {"text": "x"}))
# 2. Token from env + empty text -> must be 400 empty_text (auth passed,
#    validation rejected before any forward, so no banner is created).
print(
    "env-token-empty-text:",
    post(
        {
            "Authorization": "Bearer " + TOKEN,
            "Content-Type": "application/json",
        },
        {"text": ""},
    ),
)
print("DONE")
