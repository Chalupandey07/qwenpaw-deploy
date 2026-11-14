#!/usr/bin/env python3
"""Group-chat relay: poll the qwenpaw-groupchat Worker thread and deliver
each turn to the right QwenPaw agent on this machine.

Why a relay, and why it runs HERE (not in the Worker):
  QwenPaw's injection endpoint POST /api/console/chat requires a user Bearer
  token from the public internet. Only loopback (127.0.0.1) bypasses auth
  (verified: working/config.json security.allow_no_auth_hosts =
  ["127.0.0.1", "::1"]; qwenpaw/app/auth.py AuthMiddleware). The Worker
  therefore cannot inject messages itself, and must never hold a user
  credential. This relay runs on the InstaBox host, polls the Worker's
  GET /thread over HTTPS, and delivers turns via the in-container CLI
  `qwenpaw agents chat` (default base URL http://127.0.0.1:8088, loopback,
  no token needed — verified live 2026-11-15: `qwenpaw agents list` works
  inside the container with no auth).

Turn-taking (the Worker enforces it too; this relay also honours it):
  * Only the Worker's state.next_agent may speak next. A relay bug can never
    break ordering: a wrong-agent post gets HTTP 409 not_your_turn.
  * A user message starts a discussion of DISCUSS_ROUNDS full rounds
    (default 1: each agent replies once, then the relay waits for the next
    user message). Agent-to-agent turns only happen inside those rounds —
    the relay never lets the two agents ping-pong forever on their own.
  * One stable console session per (thread, agent) so each agent keeps the
    group context: session id `groupchat-relay:to:<agent>:<thread-short-id>`.

Install (coordinator decision — NOT installed by the build):
  1. Copy this file to the machine, e.g. /data/home/qwenpaw/groupchat-relay.py
  2. Set env: GROUPCHAT_URL (default below), GROUPCHAT_TOKEN (if the Worker
     has the secret set — required then), DISCUSS_ROUNDS (default 1),
     POLL_SECONDS (default 20).
  3. Run it in the background while the machine is up, e.g.
       nohup python3 /data/home/qwenpaw/groupchat-relay.py >> /data/home/qwenpaw/groupchat-relay.log 2>&1 &
     or as a systemd user service. It stops delivering while the machine is
     paused (InstaBox Free) and resumes on wake; nothing is lost because
     the thread lives in the Worker's Durable Object.
  4. Stop it with: pkill -f groupchat-relay.py

State: relay-state.json next to this file (last seen seq, per-agent
delivered seq, discussion round limit). Delete it to re-deliver from scratch
(it only affects what the relay has already delivered, never the Worker's thread).

Requires: python3 (stdlib only), docker, the qwenpaw container running.
No secrets in this file. The token, if set, comes from the environment.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

GROUPCHAT_URL = os.environ.get(
    "GROUPCHAT_URL", "https://qwenpaw-groupchat.qwenpaw-rohan.workers.dev"
).rstrip("/")
GROUPCHAT_TOKEN = os.environ.get("GROUPCHAT_TOKEN", "")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "20"))
DISCUSS_ROUNDS = int(os.environ.get("DISCUSS_ROUNDS", "1"))
CLI_TIMEOUT = int(os.environ.get("CLI_TIMEOUT", "300"))
STATE_PATH = os.environ.get(
    "GROUPCHAT_RELAY_STATE",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "relay-state.json"),
)
PARTICIPANTS = ["default", "QwenPaw_QA_Agent_0.2"]


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"thread_id": None, "seen_seq": 0, "delivered": {}, "discuss_until_round": 0}


def save_state(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)


def worker_call(method, path, body=None):
    url = GROUPCHAT_URL + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if GROUPCHAT_TOKEN:
        req.add_header("X-Groupchat-Token", GROUPCHAT_TOKEN)
    try:
        with urllib.request.build_opener().open(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {"error": "http_error"}
    except Exception as e:  # machine waking, DNS, Worker down, ...
        return 0, {"error": str(e)}


def get_thread():
    # Full thread every poll (capped at 200 messages, small). Delivery
    # decisions use state["delivered"], NOT a since-cursor: if a delivery
    # fails, the next poll must still see the undelivered message.
    return worker_call("GET", "/thread")


def post_agent_reply(agent, text):
    return worker_call("POST", "/thread/message", {"author": agent, "role": "agent", "text": text})


def build_digest(thread, agent):
    lines = [
        f"[Group chat thread {thread['id']} — topic: {thread.get('topic') or '(none)'}]",
        f"Round {thread['round']} of {thread['max_rounds']}. You are agent '{agent}'.",
        "Reply ONCE, in English, as your part of this group discussion.",
        "Do not call the other agent yourself — the relay delivers your reply to them.",
        "--- thread so far (latest last) ---",
    ]
    for m in thread["messages"][-12:]:
        lines.append(f"[{m['role']}:{m['author']}] {m['text']}")
    lines.append("--- your turn: reply to the thread above ---")
    return "\n".join(lines)


def deliver_to_agent(agent, thread):
    session_id = f"groupchat-relay:to:{agent}:{thread['id'][-8:]}"
    digest = build_digest(thread, agent)
    cmd = [
        "docker", "exec", "qwenpaw", "qwenpaw", "agents", "chat",
        "--from-agent", "groupchat-relay",
        "--to-agent", agent,
        "--session-id", session_id,
        "--text", digest,
    ]
    log(f"delivering round {thread['round']} to {agent} (session {session_id})")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=CLI_TIMEOUT)
    except subprocess.TimeoutExpired:
        log(f"TIMEOUT delivering to {agent} after {CLI_TIMEOUT}s — will retry next poll")
        return None
    out = (proc.stdout or "").strip()
    if proc.returncode != 0:
        log(f"CLI failed for {agent} rc={proc.returncode}: {(proc.stderr or '')[-500:]}")
        return None
    # CLI prints "[SESSION: ...]" as the first line, then the reply text.
    reply_lines = [ln for ln in out.splitlines() if not ln.startswith("[SESSION:")]
    reply = "\n".join(reply_lines).strip()
    if not reply:
        log(f"empty reply from {agent} — not posting")
        return None
    return reply


def one_poll(state):
    status, thread = get_thread()
    if status != 200:
        log(f"GET /thread failed: http={status} {str(thread)[:200]}")
        return
    if thread.get("id") != state.get("thread_id"):
        # New thread started (or first run): reset delivery tracking.
        state.update({"thread_id": thread.get("id"), "seen_seq": 0, "delivered": {}, "discuss_until_round": 0, "discuss_until_round_seen": 0})
    messages = thread.get("messages", [])
    if thread.get("status") != "open":
        save_state(state)
        return
    if not messages:
        save_state(state)
        return

    last = messages[-1]
    # A fresh user message opens a discussion window of DISCUSS_ROUNDS rounds.
    if last["role"] == "user" and last["seq"] > state.get("discuss_until_round_seen", 0):
        state["discuss_until_round"] = thread["round"] + DISCUSS_ROUNDS - 1
        state["discuss_until_round_seen"] = last["seq"]

    next_agent = thread.get("next_agent")
    if not next_agent or next_agent not in PARTICIPANTS:
        save_state(state)
        return
    # Deliver only if there is something new for this agent AND we are
    # inside the discussion window (or the trigger was a user message).
    delivered_upto = state.get("delivered", {}).get(next_agent, 0)
    if last["seq"] <= delivered_upto:
        save_state(state)
        return
    if last["role"] == "agent" and thread["round"] > state.get("discuss_until_round", 0):
        # Discussion window over — wait for the next user message.
        save_state(state)
        return

    reply = deliver_to_agent(next_agent, thread)
    if reply is None:
        save_state(state)
        return
    state.setdefault("delivered", {})[next_agent] = last["seq"]
    save_state(state)
    status2, res = post_agent_reply(next_agent, reply)
    if status2 != 200:
        log(f"POST reply as {next_agent} failed: http={status2} {str(res)[:300]}")
    else:
        log(f"posted {next_agent} reply (round {thread['round']}, seq {res.get('seq')})")


def main():
    log(f"groupchat relay starting: url={GROUPCHAT_URL} poll={POLL_SECONDS}s discuss_rounds={DISCUSS_ROUNDS}")
    if not GROUPCHAT_TOKEN:
        log("WARNING: GROUPCHAT_TOKEN is not set — Worker posts are unauthenticated until the secret is set")
    state = load_state()
    while True:
        try:
            one_poll(state)
        except Exception as e:  # never die on one bad poll
            log(f"poll error: {e}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
