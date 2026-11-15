// Computer router — the whole /computer surface.
//
// PORTED FROM Rakazo's screen proxy + API surface. Two things are deliberately
// simpler than Rakazo and one is deliberately stricter:
//
//   SIMPLER: no separate API service. Rakazo splits "resolve the capability"
//   (API, bearer secret) from "proxy the stream" (web server) because they run
//   as different services. Here both are the same Worker, so the capability is
//   opened in-process. That removes an entire network hop and the
//   screen-target endpoint that existed only to join those two halves.
//
//   SIMPLER: no Postgres. D1 is the store; the lease is one atomic UPDATE.
//
//   STRICTER: a control capability is re-validated against the LIVE lease on
//   every request, not just at mint. Rakazo rechecks every second through its
//   API; here the check is free (same isolate, same DB call) so it happens on
//   every HTTP request and on the WebSocket upgrade. The previous
//   implementation checked only at connect and left a terminal usable for an
//   hour after release (BUGS.md B-4).
//
// Order of enforcement on every screen request, and the order matters:
//   1. capability opens (signature + expiry + policy from the AAD)
//   2. generation still matches (a takeover/release invalidates old links)
//   3. for control: the sealed leaseId is still the live lease
//   4. only then proxy upstream, with the provider token attached server-side

import {
  openCapability, sealCapability, injectShim, isNovncPage,
  novncPageRequestHeaders, rewrittenNovnc, SCREEN_PROXY_TTL_MS, LEASE_CAP_GRACE_MS,
} from "./capability.js";
import * as S from "./state.js";

const UI_HTML = () => import("./ui.html?raw").then((m) => m.default).catch(() => null);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Upstream targets. Each is a published InstaBox port; the token is a secret. */
function origins(env) {
  return {
    "default": {
      control: { url: env.COMPUTER_CONTROL_ORIGIN, token: env.COMPUTER_CONTROL_TOKEN },
      view: { url: env.COMPUTER_VIEW_ORIGIN, token: env.COMPUTER_VIEW_TOKEN },
    },
    "qa": {
      control: { url: env.COMPUTER_QA_CONTROL_ORIGIN, token: env.COMPUTER_QA_CONTROL_TOKEN },
      view: { url: env.COMPUTER_QA_VIEW_ORIGIN, token: env.COMPUTER_QA_VIEW_TOKEN },
    },
  };
}

async function status(env, computer) {
  // The desktop is "up" when the view-only origin answers. A short timeout:
  // this runs on a 10 s poll and a slow answer must not stack up.
  const o = origins(env)[computer];
  if (!o?.view?.url) return "unconfigured";
  try {
    const res = await fetch(o.view.url + "/vnc.html", {
      method: "HEAD",
      signal: AbortSignal.timeout(4000),
      headers: o.view.token ? { Authorization: "Bearer " + o.view.token } : {},
    });
    return res.ok || res.status === 405 || res.status === 404 ? "running" : "stopped";
  } catch {
    return "stopped";
  }
}

async function stateFor(env, computer) {
  const [c, lease, needs] = await Promise.all([
    S.getComputer(env, computer),
    S.getLease(env, computer),
    S.openNeedsYou(env, computer),
  ]);
  const prev = await S.getPreview(env, computer).catch(() => null);
  return {
    computer,
    mode: c.mode,
    generation: c.generation,
    status: await status(env, computer),
    lease: lease && lease.live
      ? { leaseId: lease.leaseId, holder: lease.holder, expiresAt: lease.expiresAt, fence: lease.fence }
      : null,
    needsYou: needs,
    preview: prev ? { sha256: prev.sha256, bytes: prev.bytes, capturedAt: prev.captured_at } : null,
  };
}

/** Mint a screen URL for this computer and current policy. */
async function mint(env, computer, policy, leaseId) {
  const o = origins(env)[computer];
  const target = policy === "control" ? o?.control : o?.view;
  if (!target?.url) return { ok: false, error: "unconfigured" };

  let exp = Math.floor((Date.now() + SCREEN_PROXY_TTL_MS) / 1000);
  if (policy === "control") {
    const lease = await S.getLease(env, computer);
    if (!lease || !lease.live || lease.leaseId !== leaseId) return { ok: false, error: "no_lease" };
    // A control link must not outlive the control it was minted under.
    exp = Math.min(exp, Math.ceil((lease.expiresAt + LEASE_CAP_GRACE_MS) / 1000));
  }
  const url = await sealCapability(env.COMPUTER_CAPABILITY_SECRET, {
    policy,
    expiresAt: exp,
    target: { url: target.url, token: target.token || null },
    scope: { computer, generation: (await S.getComputer(env, computer)).generation, leaseId: policy === "control" ? leaseId : null },
  });
  return { ok: true, url, expiresAt: exp * 1000, policy };
}

async function serveUi(env) {
  // One file, served from the Worker itself: no separate asset to drift.
  const res = await env.ASSETS?.fetch(new URL("https://x/computer-ui.html"));
  if (res && res.ok) return res;
  return new Response(UI_HTML_TEXT, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// The UI is imported as text at build time; when the bundler cannot inline it
// this fallback keeps /computer from being a 500.
let UI_HTML_TEXT = "<!doctype html><meta charset=utf-8><title>Computer</title><p>Computer UI asset missing.</p>";

export async function handleComputer(request, env, url) {
  const path = url.pathname;
  const q = url.searchParams;

  // ---- UI ----
  if (path === "/computer" || path === "/computer/") return serveUi(env);

  // ---- state ----
  if (path === "/computer/computers") return json({ computers: S.COMPUTERS });
  if (path === "/computer/state") {
    const computer = q.get("computer") || "default";
    if (!S.COMPUTERS.includes(computer)) return json({ error: "unknown_computer" }, 400);
    try {
      return json(await stateFor(env, computer));
    } catch (e) {
      return json({ error: "store", detail: String(e).slice(0, 200) }, 503);
    }
  }

  // ---- lease ----
  if (path === "/computer/takeover" && request.method === "POST") {
    const { computer = "default" } = await request.json().catch(() => ({}));
    const r = await S.takeControl(env, computer, "user");
    if (!r.ok) {
      return json({ error: r.reason, holder: r.holder, expiresAt: r.expiresAt },
        r.reason === "held" ? 409 : 503);
    }
    return json({ leaseId: r.lease.leaseId, expiresAt: r.lease.expiresAt,
                  fence: r.lease.fence, generation: r.generation });
  }
  if (path === "/computer/heartbeat" && request.method === "POST") {
    const { computer = "default", leaseId } = await request.json().catch(() => ({}));
    const r = await S.heartbeat(env, computer, leaseId);
    return r.ok ? json({ leaseId: r.leaseId, expiresAt: r.expiresAt })
                : json({ error: r.reason }, 409);
  }
  if (path === "/computer/release" && request.method === "POST") {
    const { computer = "default", leaseId } = await request.json().catch(() => ({}));
    const r = await S.release(env, computer, leaseId);
    if (!r.ok) {
      return json({ error: r.reason }, r.reason === "not_holder" ? 409 : 503);
    }
    return json({ ok: true, generation: r.generation });
  }

  // ---- session (mint) ----
  if (path === "/computer/session") {
    const computer = q.get("computer") || "default";
    const lease = await S.getLease(env, computer).catch(() => null);
    const held = Boolean(lease && lease.live && lease.holder === "user");
    const r = await mint(env, computer, held ? "control" : "view", held ? lease.leaseId : null);
    return r.ok ? json(r) : json({ error: r.error }, r.error === "no_lease" ? 403 : 503);
  }

  // ---- mode ----
  if (path === "/computer/mode" && request.method === "POST") {
    const { computer = "default", mode } = await request.json().catch(() => ({}));
    const r = await S.setMode(env, computer, mode);
    return r.ok ? json(r) : json({ error: r.reason }, 400);
  }

  // ---- needs-you ----
  if (path === "/computer/needs-you" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    // The agent calls this. It is token-gated the same way the old bridge was.
    if (env.COMPUTER_SYNC_TOKEN && request.headers.get("X-Computer-Token") !== env.COMPUTER_SYNC_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }
    const r = await S.raiseNeedsYou(env, b.computer || "default", b.text, b.runId);
    return json(r);
  }
  if (path === "/computer/needs-you/resolve" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const r = await S.resolveNeedsYou(env, b.computer || "default", b.action);
    return r.ok ? json(r) : json({ error: r.reason }, 409);
  }

  // ---- preview ----
  if (path === "/computer/preview") {
    const computer = q.get("computer") || "default";
    const row = await S.getPreview(env, computer).catch(() => null);
    if (!row?.png) return new Response("no preview", { status: 404 });
    const etag = `"${row.sha256}"`;
    if (request.headers.get("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(row.png, {
      headers: {
        "Content-Type": "image/png", ETag: etag,
        "Cache-Control": "private, max-age=120",
      },
    });
  }
  if (path === "/computer/preview-upload" && request.method === "POST") {
    if (env.COMPUTER_SYNC_TOKEN && request.headers.get("X-Computer-Token") !== env.COMPUTER_SYNC_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }
    const computer = q.get("computer") || "default";
    const buf = await request.arrayBuffer().catch(() => null);
    // D1's row cap is 2,000,000 bytes for the WHOLE row; leave headroom.
    if (!buf || buf.byteLength === 0 || buf.byteLength > 1_500_000) {
      return json({ error: "bad_image", limit: 1_500_000 }, 400);
    }
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const sha = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const r = await S.putPreview(env, computer, new Uint8Array(buf), sha);
    return json(r);
  }

  // ---- wake ----
  if (path === "/computer/wake" && request.method === "POST") {
    // Reuse the keep-alive Worker's public wake path; do not duplicate it.
    const target = env.KEEPALIVE_URL || "https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev";
    try {
      const res = await fetch(target + "/ping", { signal: AbortSignal.timeout(30000) });
      return json({ ok: res.ok, status: res.status });
    } catch {
      return json({ ok: false, error: "wake_failed" }, 503);
    }
  }

  // ---- the stream + assets ----
  if (path.startsWith("/computer/session/")) return proxyScreen(request, env, url);

  return json({ error: "not_found" }, 404);
}

/** Proxy one screen request, after all four checks. */
async function proxyScreen(request, env, url) {
  const cap = await openCapability(env.COMPUTER_CAPABILITY_SECRET, url.pathname);
  if (!cap) return new Response("Screen link expired or invalid.", { status: 403 });

  // 2. generation must still match — a takeover or release invalidated it.
  let computer;
  try {
    computer = await S.getComputer(env, cap.scope.computer);
  } catch {
    return new Response("Screen unavailable (store).", { status: 503 });
  }
  if (!computer || computer.generation !== cap.scope.generation) {
    return new Response("Screen link expired.", { status: 403 });
  }

  // 3. control requires the live lease, checked on EVERY request.
  if (cap.policy === "control") {
    const ok = await S.leaseValid(env, cap.scope.computer, cap.scope.leaseId).catch(() => false);
    if (!ok) return new Response("Control was released.", { status: 403 });
  }

  // 4. proxy. The provider token rides in the sealed target and never reaches
  // the browser; the browser's own Cookie header is dropped so a stale
  // per-port cookie cannot 401 this one.
  const upstream = new URL(cap.rest || "/", cap.target.url);
  const headers = novncPageRequestHeaders(request.headers);
  headers.delete("cookie");
  headers.delete("host");
  if (cap.target.token) headers.set("Authorization", "Bearer " + cap.target.token);

  let res;
  try {
    res = await fetch(upstream.toString(), {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",   // the origin's own 303 must not be followed blind
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    return new Response("Screen unavailable (upstream_timeout)", { status: 502 });
  }

  // noVNC pages get the shim; everything else streams through untouched.
  if (isNovncPage(upstream.pathname) && (res.headers.get("content-type") || "").includes("text/html")) {
    const text = await res.text();
    if (text.length > 1024 * 1024) return new Response("Screen page too large.", { status: 502 });
    return new Response(injectShim(text, cap.policy === "view"), {
      status: res.status,
      headers: rewrittenNovnc(res.headers),
    });
  }

  const out = new Headers(res.headers);
  out.delete("set-cookie");
  return new Response(res.body, { status: res.status, headers: out });
}
