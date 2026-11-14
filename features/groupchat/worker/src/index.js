// qwenpaw-groupchat — Cloudflare Worker (Free): one shared group-chat thread
// for QwenPaw's agents (default + QwenPaw_QA_Agent_0.2), stored in a
// SQLite-backed Durable Object.
//
// What this Worker IS: the shared thread of record + turn-taking referee.
//   POST /thread/message  — append a message (user or agent)
//   GET  /thread          — whole thread + turn state (supports ?since=<seq>)
//   POST /thread/start    — start a new round on a topic
//   POST /thread/reset    — clear the thread (confirm: true)
//   GET  /                — service info
//
// What this Worker is NOT: it cannot inject messages into QwenPaw by itself.
// QwenPaw's injection endpoint POST /api/console/chat requires a user Bearer
// token from the public internet, and only loopback (127.0.0.1) bypasses auth
// (verified: config.json security.allow_no_auth_hosts = ["127.0.0.1", "::1"],
// qwenpaw/app/auth.py AuthMiddleware). So the relay runs ON the InstaBox
// machine (see ../relay/relay.py): it polls GET /thread?since=N and delivers
// each turn to the right agent via the loopback API / CLI. No QwenPaw
// credential is ever stored in this Worker.
//
// WHY A DURABLE OBJECT (fixed 2026-11-15 — see README "KV race" section):
//   The first version kept the thread in one Workers KV key and did
//   read-modify-write on every POST. Live-tested 2026-11-15, that loses
//   messages: 5 sequential posts <1s apart ended with the user message
//   GONE (overwritten by a stale read) and next_agent flapping between
//   two KV replicas (a QA-agent post got 409 "it is default's turn" while
//   a parallel read said next_agent was the QA agent). KV is eventually
//   consistent across edge locations, so a single-key thread can never
//   enforce turn-taking. A Durable Object is single-threaded and strongly
//   consistent: every request to the one "main" object runs in order, so
//   no message can be lost and no out-of-turn post can slip through a
//   stale read. SQLite-backed Durable Objects are the only kind the
//   Workers Free plan can create (verified against Cloudflare's pricing
//   docs 2026-11-14): 100,000 requests/day, 13,000 GB-s/day duration,
//   5M SQLite rows read/day, 100k rows written/day. This thread is a few
//   hundred requests/day, no WebSockets, no alarms, no pending I/O, so
//   the object hibernates between requests and duration stays tiny.
//   The old GROUPCHAT KV namespace is retired (kept in the account,
//   unused) — do not point anything at it again.
//
// Turn-taking rule (enforced here, in the Durable Object):
//   participants, in order: ["default", "QwenPaw_QA_Agent_0.2"]
//   state.next_agent names the only agent allowed to post next. A user
//   message does not consume a turn and does not change next_agent. An agent
//   message from anyone other than next_agent is rejected 409. After an
//   agent posts, next_agent advances; when both agents have replied in a
//   round, round++ and next_agent resets to the first agent. After
//   max_rounds (default 6) agent turns are rejected until /thread/reset or
//   /thread/start. This makes loops impossible: at most one agent reply per
//   turn, at most max_rounds rounds per thread.
//
// Free-tier safety: no cron trigger (the keepalive Worker owns the 1 cron
// used), no subrequests to QwenPaw, tiny stored values (thread capped at
// 200 messages, each text capped at 4000 chars). Expected use is a few
// hundred requests/day of the 100,000/day free quota.
//
// Auth: if the GROUPCHAT_TOKEN secret is set (wrangler secret put
// GROUPCHAT_TOKEN), every endpoint except GET / requires header
// X-Groupchat-Token with that value. If it is NOT set, the thread is open
// to anyone who knows the URL — set the token before sharing the URL.
// No secrets in this file.

const PARTICIPANTS = ["default", "QwenPaw_QA_Agent_0.2"];
const THREAD_KEY = "thread";
const MAX_MESSAGES = 200;
const MAX_TEXT_CHARS = 4000;
const DEFAULT_MAX_ROUNDS = 6;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Groupchat-Token",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function newThread(topic) {
  const now = new Date().toISOString();
  return {
    id: `groupchat-${Date.now().toString(36)}`,
    topic: topic || "",
    created_at: now,
    updated_at: now,
    status: "open",
    max_rounds: DEFAULT_MAX_ROUNDS,
    round: 1,
    next_agent: PARTICIPANTS[0],
    messages: [],
    seq: 0,
  };
}

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_TEXT_CHARS);
}

function publicThread(thread, since) {
  const messages = Number.isFinite(since)
    ? thread.messages.filter((m) => m.seq > since)
    : thread.messages;
  return {
    id: thread.id,
    topic: thread.topic,
    status: thread.status,
    round: thread.round,
    max_rounds: thread.max_rounds,
    next_agent: thread.next_agent,
    participants: PARTICIPANTS,
    seq: thread.seq,
    updated_at: thread.updated_at,
    messages,
  };
}

// The single strongly-consistent owner of the thread. One object, named
// "main", holds the whole thread under one storage key. Durable Objects
// run one request at a time per object, so load -> check -> append ->
// save can never interleave with another request: no lost updates.
export class GroupChatThread {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  checkToken(request) {
    if (!this.env.GROUPCHAT_TOKEN) return true;
    const supplied =
      request.headers.get("X-Groupchat-Token") ||
      new URL(request.url).searchParams.get("token") ||
      "";
    return supplied === this.env.GROUPCHAT_TOKEN;
  }

  async loadThread() {
    const stored = await this.ctx.storage.get(THREAD_KEY);
    if (!stored || !Array.isArray(stored.messages)) return newThread("");
    return stored;
  }

  async saveThread(thread) {
    thread.updated_at = new Date().toISOString();
    await this.ctx.storage.put(THREAD_KEY, thread);
    return thread;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/") {
      return json({
        service: "qwenpaw-groupchat",
        thread: "one shared thread for QwenPaw agents default + QwenPaw_QA_Agent_0.2",
        store: "durable-object (sqlite)",
        auth_required: Boolean(this.env.GROUPCHAT_TOKEN),
        endpoints: [
          "GET /thread[?since=<seq>]",
          "POST /thread/start {topic?, first_agent?, max_rounds?}",
          "POST /thread/message {author, role: user|agent, text}",
          "POST /thread/reset {confirm: true}",
        ],
        turn_taking: {
          participants: PARTICIPANTS,
          rule: "only state.next_agent may post as role=agent; user messages never consume a turn",
        },
      });
    }

    if (path === "/thread" && request.method === "GET") {
      if (!this.checkToken(request)) return json({ error: "unauthorized" }, 401);
      const thread = await this.loadThread();
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw === null ? null : Number(sinceRaw);
      return json(publicThread(thread, Number.isFinite(since) ? since : null));
    }

    if (path === "/thread/start" && request.method === "POST") {
      if (!this.checkToken(request)) return json({ error: "unauthorized" }, 401);
      let body = {};
      try { body = await request.json(); } catch { /* empty body is fine */ }
      const thread = newThread(cleanText(body.topic));
      if (Number.isInteger(body.max_rounds) && body.max_rounds >= 1 && body.max_rounds <= 20) {
        thread.max_rounds = body.max_rounds;
      }
      if (typeof body.first_agent === "string" && PARTICIPANTS.includes(body.first_agent)) {
        thread.next_agent = body.first_agent;
      }
      await this.saveThread(thread);
      return json(publicThread(thread, null));
    }

    if (path === "/thread/message" && request.method === "POST") {
      if (!this.checkToken(request)) return json({ error: "unauthorized" }, 401);
      let body = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_request", note: "body must be JSON" }, 400);
      }
      const text = cleanText(body.text);
      const author = cleanText(body.author).slice(0, 120) || "unknown";
      const role = body.role === "agent" ? "agent" : body.role === "user" ? "user" : "";
      if (!text || !role) {
        return json({ error: "bad_request", note: "need {author, role: user|agent, text}" }, 400);
      }
      const thread = await this.loadThread();
      if (thread.status !== "open") {
        return json({ error: "thread_closed", note: `thread is ${thread.status}; POST /thread/start to open a new one`, thread: publicThread(thread, null) }, 409);
      }
      if (role === "agent") {
        if (!PARTICIPANTS.includes(author)) {
          return json({ error: "unknown_agent", note: `agent must be one of ${PARTICIPANTS.join(", ")}`, next_agent: thread.next_agent }, 400);
        }
        if (author !== thread.next_agent) {
          return json({ error: "not_your_turn", note: `it is ${thread.next_agent}'s turn, not ${author}'s`, next_agent: thread.next_agent, round: thread.round }, 409);
        }
      }
      thread.seq += 1;
      thread.messages.push({
        seq: thread.seq,
        ts: new Date().toISOString(),
        author,
        role,
        text,
      });
      if (thread.messages.length > MAX_MESSAGES) {
        thread.messages = thread.messages.slice(-MAX_MESSAGES);
      }
      if (role === "agent") {
        const idx = PARTICIPANTS.indexOf(author);
        if (idx === PARTICIPANTS.length - 1) {
          thread.round += 1;
          thread.next_agent = PARTICIPANTS[0];
          if (thread.round > thread.max_rounds) {
            thread.status = "complete";
            thread.next_agent = null;
          }
        } else {
          thread.next_agent = PARTICIPANTS[idx + 1];
        }
      }
      await this.saveThread(thread);
      return json(publicThread(thread, null));
    }

    if (path === "/thread/reset" && request.method === "POST") {
      if (!this.checkToken(request)) return json({ error: "unauthorized" }, 401);
      let body = {};
      try { body = await request.json(); } catch { /* empty body is fine */ }
      if (body.confirm !== true) {
        return json({ error: "bad_request", note: "send {confirm: true} to clear the thread" }, 400);
      }
      const thread = newThread("");
      await this.saveThread(thread);
      return json({ reset: true, thread: publicThread(thread, null) });
    }

    return json({ error: "not_found", endpoints: ["/", "/thread", "/thread/start", "/thread/message", "/thread/reset"] }, 404);
  }
}

export default {
  async fetch(request, env, ctx) {
    // Every request goes to the one "main" object, so all thread reads
    // and writes are serialized in a single strongly-consistent actor.
    const id = env.GROUPCHAT_THREAD.idFromName("main");
    const stub = env.GROUPCHAT_THREAD.get(id);
    return stub.fetch(request);
  },
};
