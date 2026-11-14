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
// Auth: the GROUPCHAT_TOKEN secret MUST be set (wrangler secret put
// GROUPCHAT_TOKEN). Every endpoint except GET / requires header
// X-Groupchat-Token with that value — the token is NEVER accepted via
// ?token= (query tokens leak in logs/Referer/history). If the secret is
// NOT set, every gated endpoint returns 401 (fail closed, RT-002) — the
// thread is never silently open. Mutating writes are also rate-limited to 30/min per
// client IP (429 + Retry-After). No secrets in this file.

const PARTICIPANTS = ["default", "QwenPaw_QA_Agent_0.2"];
const THREAD_KEY = "thread";
const MAX_MESSAGES = 200;
const MAX_TEXT_CHARS = 4000;
const DEFAULT_MAX_ROUNDS = 6;
// Write rate limit (fix 2026-11-15, audit finding groupchat-no-rate-limit-flood):
// unauthenticated flooding posted 200 messages in ~27s and evicted the
// oldest legitimate messages. 30 mutating writes/min per client IP, 429
// with Retry-After beyond that. Reads (GET /thread) are never limited —
// the relay polls them. Counters MUST live in Durable Object storage, not
// in memory: SQLite-backed objects hibernate between requests and a fresh
// instance (empty Map) is constructed per wake-up, so an in-memory counter
// never fills. The token gate is the durable protection; this is the
// flood brake.
const WRITE_RATE_LIMIT = 30;
const WRITE_RATE_WINDOW_MS = 60_000;
const WRITE_RATE_KEY = "write-rate";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Groupchat-Token",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extraHeaders },
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

  // Header-only token (fix 2026-11-15, audit finding groupchat-token-in-query):
  // the ?token= query fallback is removed — tokens in URLs leak via
  // Referer, logs, shell history and copy/paste. The relay sends the
  // header only; no in-repo caller used ?token=.
  // Fail CLOSED when the secret is unset (re-test 2026-11-15, RT-002):
  // the old code returned true when GROUPCHAT_TOKEN was unset, so deleting
  // or mis-rotating the secret silently reopened the thread to anyone.
  // Routines and keepalive already fail closed the same way (503/401 when
  // their token is unset); this matches them. GET / stays public and
  // advertises auth_required so the state is visible.
  checkToken(request) {
    if (!this.env.GROUPCHAT_TOKEN) return false;
    const supplied = request.headers.get("X-Groupchat-Token") || "";
    return supplied === this.env.GROUPCHAT_TOKEN;
  }

  // Per-IP write brake (fix 2026-11-15, audit finding
  // groupchat-no-rate-limit-flood). Buckets persist in DO storage so the
  // count survives hibernation; stale buckets are pruned on every check.
  // Returns { limited, retryAfter }. DO requests run serialized, so the
  // load -> update -> save cannot interleave.
  async checkWriteRate(request) {
    const forwarded = request.headers.get("X-Forwarded-For") || "";
    const ip =
      request.headers.get("CF-Connecting-IP") ||
      forwarded.split(",")[0].trim() ||
      "unknown";
    const now = Date.now();
    const buckets = (await this.ctx.storage.get(WRITE_RATE_KEY)) || {};
    for (const [key, value] of Object.entries(buckets)) {
      if (!value || now - value.windowStart >= WRITE_RATE_WINDOW_MS) delete buckets[key];
    }
    if (Object.keys(buckets).length > 1000) {
      // Extremely defensive cap: drop the oldest windows first.
      const sorted = Object.entries(buckets).sort((a, b) => a[1].windowStart - b[1].windowStart);
      for (const [key] of sorted.slice(0, Object.keys(buckets).length - 1000)) delete buckets[key];
    }
    let bucket = buckets[ip];
    if (!bucket) {
      bucket = { count: 0, windowStart: now };
      buckets[ip] = bucket;
    }
    bucket.count += 1;
    await this.ctx.storage.put(WRITE_RATE_KEY, buckets);
    if (bucket.count > WRITE_RATE_LIMIT) {
      return {
        limited: true,
        retryAfter: Math.max(
          1,
          Math.ceil((bucket.windowStart + WRITE_RATE_WINDOW_MS - now) / 1000),
        ),
      };
    }
    return { limited: false, retryAfter: 0 };
  }

  rateLimitedResponse(retryAfter) {
    return json(
      { error: "rate_limited", note: "too many writes from this IP; slow down", retry_after_seconds: retryAfter },
      429,
      { "Retry-After": String(retryAfter) },
    );
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
        rate_limit: {
          writes_per_minute_per_ip: WRITE_RATE_LIMIT,
          applies_to: ["POST /thread/start", "POST /thread/message", "POST /thread/reset"],
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
      const rate = await this.checkWriteRate(request);
      if (rate.limited) return this.rateLimitedResponse(rate.retryAfter);
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
      const rate = await this.checkWriteRate(request);
      if (rate.limited) return this.rateLimitedResponse(rate.retryAfter);
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
      // Cap the thread, but say so instead of silently dropping the
      // oldest messages (audit finding groupchat-no-rate-limit-flood).
      let evicted = 0;
      if (thread.messages.length > MAX_MESSAGES) {
        evicted = thread.messages.length - MAX_MESSAGES;
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
      const out = publicThread(thread, null);
      if (evicted > 0) out.evicted_oldest = evicted;
      return json(out);
    }

    if (path === "/thread/reset" && request.method === "POST") {
      if (!this.checkToken(request)) return json({ error: "unauthorized" }, 401);
      const rate = await this.checkWriteRate(request);
      if (rate.limited) return this.rateLimitedResponse(rate.retryAfter);
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
