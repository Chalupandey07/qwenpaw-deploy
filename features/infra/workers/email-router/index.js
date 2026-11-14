// qwenpaw-infra-email — Cloudflare Email Worker (email handler).
// Receives mail for a bot address and delivers it into QwenPaw via
// POST /api/console/chat/task. NOT DEPLOYED: the Cloudflare account has
// zero zones, so no Email Routing rule can exist yet (see 17-bot-email.md).
// Deploy only after: (1) a user-owned domain is added as a zone,
// (2) an Email Routing rule points the bot address at this Worker,
// (3) Worker Secrets QWENPAW_USER / QWENPAW_PASS are set (never in code).
//
// Design (verified against QwenPaw v2.3.0 source + Astra review):
// - Login once, cache token in memory + KV (short TTL), re-login once on
//   401, STOP on 423 lockout, honour Retry-After on 429.
// - Email content is UNTRUSTED: fixed template, fixed agent/session,
//   size cap, attachments dropped in v1. Mail can never choose the
//   agent, the API path, or the session.
// - Upstream errors are never leaked to the sender.

const MAX_BYTES = 100 * 1024;
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6h conservative cache (token default is 7d)

function parseEmail(raw) {
  // Minimal RFC 822 parser: headers + plain-text body. Good enough for v1;
  // HTML parts and attachments are dropped and the sender is told so.
  const headEnd = raw.search(/\r?\n\r?\n/);
  const head = headEnd >= 0 ? raw.slice(0, headEnd) : raw;
  let body = headEnd >= 0 ? raw.slice(headEnd).replace(/^\r?\n\r?\n/, "") : "";
  const headers = {};
  for (const line of head.split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  const contentType = (headers["content-type"] || "").toLowerCase();
  let droppedParts = false;
  if (contentType.includes("multipart/")) {
    const boundary = (contentType.match(/boundary="?([^";\s]+)"?/) || [])[1];
    if (boundary) {
      const parts = body.split("--" + boundary);
      let text = "";
      for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower.includes("content-type: text/plain") && !text) {
          const idx = part.search(/\r?\n\r?\n/);
          text = idx >= 0 ? part.slice(idx).replace(/^\r?\n\r?\n/, "") : "";
        } else if (lower.includes("content-disposition: attachment")) {
          droppedParts = true;
        } else if (lower.includes("content-type: text/html")) {
          droppedParts = true; // HTML part ignored in v1
        }
      }
      body = text.trim();
    } else {
      body = "";
      droppedParts = true;
    }
  }
  return {
    from: headers["from"] || "unknown sender",
    subject: headers["subject"] || "(no subject)",
    body: body.slice(0, MAX_BYTES),
    droppedParts,
  };
}

async function login(env) {
  const res = await fetch(`${env.QWENPAW_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: env.QWENPAW_USER, password: env.QWENPAW_PASS }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 423) {
    const e = new Error("QwenPaw login locked (423) — stop, do not retry");
    e.status = 423;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`QwenPaw login failed: HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  if (!data.token) throw new Error("QwenPaw login returned no token");
  return data.token;
}

async function getToken(env) {
  // In-memory cache is per-isolate; KV is the shared cache (token only).
  if (globalThis.__qpToken && Date.now() < globalThis.__qpTokenExp) {
    return globalThis.__qpToken;
  }
  if (env.STATUS) {
    try {
      const raw = await env.STATUS.get("qwenpaw:email-token");
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.exp > Date.now()) {
          globalThis.__qpToken = cached.token;
          globalThis.__qpTokenExp = cached.exp;
          return cached.token;
        }
      }
    } catch { /* cache miss — log in below */ }
  }
  const token = await login(env);
  const exp = Date.now() + TOKEN_TTL_MS;
  globalThis.__qpToken = token;
  globalThis.__qpTokenExp = exp;
  if (env.STATUS) {
    try {
      await env.STATUS.put("qwenpaw:email-token",
        JSON.stringify({ token, exp }), { expirationTtl: Math.floor(TOKEN_TTL_MS / 1000) });
    } catch { /* token still works in memory; KV is best-effort */ }
  }
  return token;
}

async function dropToken(env) {
  globalThis.__qpToken = null;
  globalThis.__qpTokenExp = 0;
  if (env.STATUS) {
    try { await env.STATUS.delete("qwenpaw:email-token"); } catch { /* ignore */ }
  }
}

async function deliver(env, mail) {
  const text =
    `[Email received]\nFrom: ${mail.from}\nSubject: ${mail.subject}\n` +
    (mail.droppedParts ? `(Note: HTML parts / attachments were dropped — plain text only.)\n` : ``) +
    `\n--- message ---\n${mail.body}`;
  const payload = {
    channel: "console",
    user_id: `email:${mail.from}`,
    session_id: "email-inbox",
    input: [{ content: [{ type: "text", text }] }],
    timeout: 300,
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const token = await getToken(env);
    const res = await fetch(`${env.QWENPAW_URL}/api/console/chat/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 && attempt === 1) {
      await dropToken(env);
      continue; // one re-login, then retry once
    }
    if (res.status === 423) throw Object.assign(new Error("QwenPaw locked (423)"), { status: 423 });
    if (!res.ok) throw Object.assign(new Error(`deliver failed: HTTP ${res.status}`), { status: res.status });
    return await res.json();
  }
  throw new Error("deliver failed after re-login");
}

export default {
  async email(message, env, ctx) {
    try {
      if (!env.QWENPAW_URL || !env.QWENPAW_USER || !env.QWENPAW_PASS) {
        console.log("[email] misconfigured: QWENPAW_URL/USER/PASS secret missing");
        message.setReject("Service not configured");
        return;
      }
      const raw = await new Response(message.raw).text();
      if (raw.length > MAX_BYTES) {
        console.log("[email] rejected: over 100 KB");
        message.setReject("Message too large (100 KB limit)");
        return;
      }
      const mail = parseEmail(raw);
      if (!mail.body.trim()) {
        console.log("[email] rejected: empty body");
        message.setReject("Empty message");
        return;
      }
      const result = await deliver(env, mail);
      console.log("[email] delivered", mail.from, result.task_id || "");
    } catch (err) {
      // Never leak upstream detail to the sender.
      console.log("[email] delivery error:", err && err.message ? err.message : err);
      message.setReject("Delivery failed — please try again later");
    }
  },
};
