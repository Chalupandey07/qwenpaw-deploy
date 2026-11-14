// qwenpaw-keepalive — Cloudflare Worker (Free): cron keep-alive + status API
// for QwenPaw on InstaBox Free. No secrets in this file.
// Env vars: QWENPAW_URL, INSTABOX_MACHINE_ID
// Secrets (optional): PORT_TOKEN (private port only), INSTABOX_API_KEY (API-wake fallback)
// KV binding: STATUS

const PING_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 60_000;
const WAKE_MIN_GAP_MS = 10 * 60_000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Wake-Token",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function pingHeaders(env) {
  const h = { "User-Agent": "qwenpaw-keepalive/1.0 (+cloudflare-worker-cron)" };
  if (env.PORT_TOKEN) h["Authorization"] = `Bearer ${env.PORT_TOKEN}`;
  return h;
}

async function readSmallText(res, max = 2048) {
  try {
    const t = await res.text();
    return t.slice(0, max);
  } catch {
    return "";
  }
}

function parseRetryAfter(res, bodyText) {
  const header = res.headers.get("Retry-After");
  if (header && /^\d+$/.test(header.trim())) return Number(header.trim());
  try {
    const j = JSON.parse(bodyText || "{}");
    const s = j?.error?.retryAfterSeconds ?? j?.retryAfterSeconds;
    if (typeof s === "number") return s;
  } catch { /* not JSON */ }
  return null;
}

function parseErrorCode(bodyText) {
  try {
    return JSON.parse(bodyText || "{}")?.error?.code ?? null;
  } catch {
    return null;
  }
}

async function probeQwenPaw(env, { allowRetry = true } = {}) {
  const url = env.QWENPAW_URL;
  if (!url) return { status: "misconfigured", httpStatus: 0, note: "QWENPAW_URL is not set" };

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: pingHeaders(env),
        redirect: "manual",
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
    } catch (err) {
      return { status: "offline", httpStatus: 0, note: `fetch failed (attempt ${attempt}): ${err?.name || "error"}` };
    }

    const httpStatus = res.status;
    if ((httpStatus >= 200 && httpStatus < 400) || httpStatus === 401) {
      await res.body?.cancel().catch(() => {});
      return { status: "up", httpStatus, note: "QwenPaw console answered" };
    }
    if (httpStatus === 503) {
      const body = await readSmallText(res);
      const retryAfter = parseRetryAfter(res, body);
      if (allowRetry && attempt === 1) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return { status: "waking", httpStatus, retryAfterSeconds: retryAfter, note: "InstaBox is waking the machine (503 Sandbox is waking up)" };
    }
    if (httpStatus === 409) {
      const body = await readSmallText(res);
      const code = parseErrorCode(body);
      const retryAfter = parseRetryAfter(res, body);
      return {
        status: code === "machine_cooldown" ? "cooldown" : "conflict",
        httpStatus, errorCode: code, retryAfterSeconds: retryAfter,
        note: code === "machine_cooldown"
          ? "Max-run cooldown — every wake is refused until it ends. Wait."
          : "Another operation is running (409 operation_conflict). Retry later.",
      };
    }
    const body = await readSmallText(res);
    return { status: "degraded", httpStatus, note: body || `Unexpected HTTP ${httpStatus}` };
  }
  return { status: "unknown", httpStatus: 0, note: "probe exhausted" };
}

async function loadStatus(env) {
  if (!env.STATUS) return null;
  try {
    const raw = await env.STATUS.get("qwenpaw:status");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function saveStatus(env, patch) {
  if (!env.STATUS) return null;
  const prev = (await loadStatus(env)) || {};
  const now = new Date().toISOString();
  const next = {
    ...prev,
    ...patch,
    checkedAt: now,
    lastPingAt: now,
    lastUpAt: patch.status === "up" ? now : prev.lastUpAt || null,
    consecutiveFailures: patch.status === "up" ? 0 : (prev.consecutiveFailures || 0) + 1,
  };
  try {
    await env.STATUS.put("qwenpaw:status", JSON.stringify(next));
  } catch (e) {
    console.log("KV put failed (status still returned live):", e?.message);
  }
  return next;
}

async function callInstaBoxWake(env) {
  const id = env.INSTABOX_MACHINE_ID;
  try {
    const res = await fetch(`https://api.instabox.sh/v1/machines/${encodeURIComponent(id)}/wake`, {
      method: "POST",
      headers: { "X-API-Key": env.INSTABOX_API_KEY, "Idempotency-Key": crypto.randomUUID() },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await readSmallText(res);
    return { httpStatus: res.status, body: body || null };
  } catch (err) {
    return { httpStatus: 0, error: err?.name || "fetch failed" };
  }
}

async function keepAliveTick(env, source) {
  const result = await probeQwenPaw(env, { allowRetry: true });
  const saved = await saveStatus(env, { ...result, source });
  console.log(`[keepalive:${source}]`, result.status, result.httpStatus, result.note || "");
  if ((result.status === "offline" || result.status === "waking") && env.INSTABOX_API_KEY && env.INSTABOX_MACHINE_ID) {
    const lastWake = saved?.lastWakeAt ? Date.parse(saved.lastWakeAt) : 0;
    if (Date.now() - lastWake >= WAKE_MIN_GAP_MS) {
      const wake = await callInstaBoxWake(env);
      console.log("[keepalive:wake-fallback]", wake);
      await saveStatus(env, { lastWakeAt: new Date().toISOString(), lastWakeResult: wake });
    }
  }
  return saved || result;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/") {
      return json({ service: "qwenpaw-keepalive", endpoints: ["/status", "/ping", "/wake"], qwenpawUrl: env.QWENPAW_URL || null });
    }

    if (path === "/status" && request.method === "GET") {
      if (url.searchParams.get("live") === "1") {
        const live = await probeQwenPaw(env, { allowRetry: false });
        const saved = await saveStatus(env, { ...live, source: "status-live" });
        return json({ ...saved, consoleUrl: env.QWENPAW_URL || null });
      }
      const cached = await loadStatus(env);
      if (!cached) return json({ status: "unknown", note: "No ping has run yet — wait for the next cron tick, or call /ping.", consoleUrl: env.QWENPAW_URL || null });
      return json({ ...cached, consoleUrl: env.QWENPAW_URL || null });
    }

    if (path === "/ping") {
      const result = await probeQwenPaw(env, { allowRetry: true });
      const saved = await saveStatus(env, { ...result, source: "manual-ping" });
      return json(saved || result);
    }

    if (path === "/wake" && request.method === "POST") {
      if (env.WAKE_TOKEN) {
        const token = request.headers.get("X-Wake-Token") || url.searchParams.get("token");
        if (token !== env.WAKE_TOKEN) return json({ error: "unauthorized" }, 401);
      }
      const result = await probeQwenPaw(env, { allowRetry: true });
      let wake = null;
      if ((result.status === "offline" || result.status === "waking") && env.INSTABOX_API_KEY && env.INSTABOX_MACHINE_ID) {
        const cached = await loadStatus(env);
        const lastWake = cached?.lastWakeAt ? Date.parse(cached.lastWakeAt) : 0;
        if (Date.now() - lastWake >= WAKE_MIN_GAP_MS) {
          wake = await callInstaBoxWake(env);
        } else {
          wake = { skipped: "rate-limited — last API wake was <10 min ago" };
        }
      }
      const saved = await saveStatus(env, { ...result, source: "manual-wake", lastWakeAt: wake && !wake.skipped ? new Date().toISOString() : undefined, lastWakeResult: wake });
      return json({ ...(saved || result), wake });
    }

    return json({ error: "not found", endpoints: ["/status", "/ping", "/wake"] }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(keepAliveTick(env, `cron:${event.cron}`));
  },
};
