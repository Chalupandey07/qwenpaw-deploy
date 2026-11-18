// qwenpaw-infra-activity — live activity feed for QwenPaw on InstaBox Free.
// Reads the STATUS KV namespace written every 5 min by qwenpaw-keepalive
// (key qwenpaw:status) and shows it as a page + JSON. No secrets, no chat
// content, no auth: status only. This is NOT a live desktop — see
// 01-live-computer.md for why no desktop path exists.
// Env vars: QWENPAW_URL (console origin), CONSOLE_URL (Pages console link),
// KEEPALIVE_URL (keepalive Worker; the Wake button calls its public GET
// /ping, which wakes a paused box by probing the public console URL.
// POST /wake is token-gated and is never called from this page.)
// KV binding: STATUS (same namespace as keepalive; this Worker only reads
// qwenpaw:status and writes its own qwenpaw:activity key, never the
// keepalive's key).

const CORS = { "Access-Control-Allow-Origin": "*" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function statusLabel(s) {
  return { up: "UP", waking: "WAKING", cooldown: "COOLDOWN", offline: "OFFLINE",
    degraded: "DEGRADED", unknown: "UNKNOWN", misconfigured: "MISCONFIGURED" }[s] || "UNKNOWN";
}

async function loadStatus(env) {
  if (!env.STATUS) return null;
  try {
    const raw = await env.STATUS.get("qwenpaw:status");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function probe(env) {
  const url = env.QWENPAW_URL;
  if (!url) return { status: "misconfigured", httpStatus: 0, note: "QWENPAW_URL not set" };
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "qwenpaw-infra-activity/1.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status === 503) return { status: "waking", httpStatus: 503, note: "InstaBox is waking the machine" };
    if (res.status === 409) return { status: "cooldown", httpStatus: 409, note: "Max-run cooldown — wakes refused" };
    if ((res.status >= 200 && res.status < 400) || res.status === 401) {
      return { status: "up", httpStatus: res.status, note: "AgentX console answered" };
    }
    return { status: "degraded", httpStatus: res.status, note: `Unexpected HTTP ${res.status}` };
  } catch (err) {
    return { status: "offline", httpStatus: 0, note: `fetch failed: ${err?.name || "error"}` };
  }
}

function page(data, env) {
  const s = data || {};
  const label = statusLabel(s.status);
  const color = { UP: "#22c55e", WAKING: "#eab308", COOLDOWN: "#f97316",
    OFFLINE: "#ef4444", DEGRADED: "#eab308" }[label] || "#9ca3af";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>AgentX — Live activity</title></head>
<body style="font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaf0;padding:2rem;max-width:640px;margin:auto">
<h1>AgentX — live activity</h1>
<p>Status: <strong style="color:${color}">${esc(label)}</strong>
${s.httpStatus ? `(HTTP ${esc(s.httpStatus)})` : ""}</p>
<p>${esc(s.note || "")}</p>
<table style="border-collapse:collapse">
<tr><td style="padding:4px 12px 4px 0;color:#9ca3af">Last check</td><td>${esc(s.checkedAt || s.lastPingAt || "—")}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#9ca3af">Last up</td><td>${esc(s.lastUpAt || "—")}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#9ca3af">Consecutive failures</td><td>${esc(s.consecutiveFailures ?? "—")}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#9ca3af">Checked by</td><td>${esc(s.source || "—")}</td></tr>
${s.retryAfterSeconds ? `<tr><td style="padding:4px 12px 4px 0;color:#9ca3af">Retry after</td><td>${esc(s.retryAfterSeconds)}s</td></tr>` : ""}
</table>
<p><a style="color:#22c55e" href="${esc(env.CONSOLE_URL || "https://qwenpawx.pages.dev/")}">Open the console — take over here</a></p>
<p><button onclick="fetch('/api/live').then(()=>location.reload())" style="padding:8px 14px;cursor:pointer">Probe now</button>
<button onclick="fetch('${esc(env.KEEPALIVE_URL || "")}/ping').then(r=>r.json()).then(j=>alert(JSON.stringify(j.status||j))).catch(()=>alert('wake call failed'))" style="padding:8px 14px;cursor:pointer">Wake</button></p>
<p style="color:#9ca3af;font-size:0.9em">This page shows keep-alive status only — it is not a live desktop and cannot show what the agent is doing inside a session. That lives in the console. Refreshes every 60s. Status source: keep-alive Worker, every 5 min.</p>
<p style="color:#9ca3af;font-size:0.9em"><a style="color:#9ca3af" href="/api/status">JSON</a> · <a style="color:#9ca3af" href="/api/live">Live probe (JSON)</a></p>
</body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/api/status") {
      const cached = await loadStatus(env);
      return json({ ...(cached || { status: "unknown", note: "No ping has run yet." }),
        consoleUrl: env.CONSOLE_URL || null, keepaliveUrl: env.KEEPALIVE_URL || null });
    }

    if (path === "/api/live") {
      const live = await probe(env);
      return json({ ...live, consoleUrl: env.CONSOLE_URL || null });
    }

    if (path === "/") {
      const cached = await loadStatus(env);
      return new Response(page(cached, env), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return json({ error: "not found", endpoints: ["/", "/api/status", "/api/live"] }, 404);
  },
};
