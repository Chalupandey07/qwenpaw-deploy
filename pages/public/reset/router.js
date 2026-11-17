// Reset router — the whole /reset surface.
//
// A Settings page where the user picks categories to wipe, sees exactly what
// will be deleted, and confirms with a typed DELETE plus a checkbox. See
// features/reset/README.md for the design (allowlist-only, fail-closed).
//
// Auth (this is a destructive surface, so it uses the strongest check):
//   * The /reset page itself is static bytes and exempt (B-39 lesson).
//   * /reset/api/preview and /reset/api/execute require a LIVE console
//     session: authenticate() from machine-control.js forwards the caller's
//     Bearer token to the console's own /api/cron/jobs and trusts only a 200
//     with a JSON body. A revoked token stops working here at the same moment
//     it stops working in the console. Never /api/auth/status (public).
//   * The broker call adds the shared RESET_TOKEN (X-Reset-Token). The token
//     is a Worker secret; without it the route fails closed with 503.
//   * The broker accepts ONLY a category enum + confirm/ack/plan_id — this
//     router never forwards client-supplied paths (there are none to forward).
//
// The broker is the only thing that deletes. This router previews, forwards,
// and maps status codes. It never touches the filesystem.

import { authenticate } from "../machine-control.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** The page and its static assets are exempt; every API call is gated. */
export function requiresSession(path, method = "GET") {
  if (method === "OPTIONS") return false;
  if (path === "/reset" || path === "/reset/") return false;
  if (/^\/reset\/[A-Za-z0-9_.-]+\.(html|css|js|map|svg|png|ico)$/.test(path)) return false;
  return true;
}

function brokerUrl(env) {
  return (env.RESET_BROKER_URL || "http://172.18.0.1:8895").replace(/\/+$/, "");
}

async function serveStatic(env, url, path, contentType) {
  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
    if (res && res.ok) {
      return new Response(res.body, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  }
  return new Response("not found", { status: 404 });
}

async function forwardToBroker(request, env, brokerPath) {
  const token = env.RESET_TOKEN;
  if (!token) {
    return json({
      error: "reset_unconfigured",
      detail: "RESET_TOKEN is not set on this Pages project, so Reset is unavailable.",
    }, 503);
  }
  const body = await request.text().catch(() => "");
  let res;
  try {
    res = await fetch(brokerUrl(env) + brokerPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Reset-Token": token,
        "X-Request-Id": request.headers.get("X-Request-Id") || crypto.randomUUID(),
        "User-Agent": "qwenpaw-reset/1",
      },
      body,
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    return json({
      error: "reset_broker_unreachable",
      detail: "The reset service on the machine did not answer.",
      detail_raw: String(e).slice(0, 200),
    }, 502);
  }
  const text = await res.text().catch(() => "");
  // Pass the broker's status and body through unchanged (it already speaks
  // the 200/207/400/401/409/503 contract). Never invent a body here.
  return new Response(text, {
    status: res.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleReset(request, env, url, origin) {
  const path = url.pathname;

  // ---- UI ----
  if (path === "/reset" || path === "/reset/") {
    return serveStatic(env, url, "/reset/index.html", "text/html; charset=utf-8");
  }
  if (path === "/reset/ui.js") {
    return serveStatic(env, url, "/reset/ui.js", "application/javascript; charset=utf-8");
  }

  // ---- API (gated) ----
  if (path === "/reset/api/preview" || path === "/reset/api/execute") {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    // Live console-session verification (see header). A 409/503 from the
    // console means the machine is not running; we cannot verify a session
    // against a machine that is not running, so refuse.
    const auth = await authenticate(request, env, origin);
    if (!auth.ok) {
      return json({ error: auth.error, detail: auth.detail || null }, auth.status || 401);
    }
    return forwardToBroker(request, env, path === "/reset/api/preview" ? "/preview" : "/execute");
  }

  return json({ error: "not_found" }, 404);
}
