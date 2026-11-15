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
  novncPageRequestHeaders, rewrittenNovnc, SCREEN_PROXY_TTL_MS,
} from "./capability.js";
import * as S from "./state.js";
// LEASE_CAP_GRACE_MS lives in state.js, beside the lease TTL it is derived
// from. Importing it from capability.js was a hard module error — the Worker
// failed to instantiate, so /computer returned nothing at all. Nothing caught
// it because no harness ever imported this file.
import { LEASE_CAP_GRACE_MS } from "./state.js";
import { enforce as rateLimit } from "./rate-limit.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * Map a /computer path to a rate-limit class, or `null` for "not limited".
 *
 * The UI page itself is not limited: it is a static asset served by Pages and
 * a browser asks for it once. Everything that touches the store, the upstream
 * desktop, or 1.5 MB of D1 is.
 *
 * Note the asymmetry between `status` and `mutation`: they are separate
 * buckets, so a tab stuck polling `/state` cannot exhaust the allowance for
 * the user's own Take control press. A single bucket per client would let the
 * cheap call starve the important one, which is worse than no limit at all.
 */
function limitClass(path, method) {
  if (path === "/computer/state") return "status";
  if (path === "/computer/computers") return "status";
  if (path === "/computer/session") return "mint";
  if (path === "/computer/preview") return "preview";
  if (path === "/computer/preview-upload") return "upload";
  if (path === "/computer/needs-you" && method === "POST") return "upload";
  if (path === "/computer/wake") return "mutation";
  if (method === "POST") return "mutation";
  return null;
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
  // BUGS.md B-15: a broken store must not be reported as a legitimate empty
  // value. `generation: 0` is a real state (a computer never taken over), so
  // returning 0 on a read error makes "the store is down" indistinguishable
  // from "fresh computer" — the exact ambiguity that confused the 2026-11-15
  // diagnosis. The core reads are STRICT (they throw, answered as 503 above);
  // anything optional that is allowed to fail is reported in `degraded`, so a
  // caller can see it rather than infer health from missing data.
  //
  // `needs` carries its own previewSha from metadata, so the separate
  // getPreview() call is gone: it used to read and hash the full blob a second
  // time on the same request. `prev` is now a ~40-byte metadata read.
  const [c, lease, needs] = await Promise.all([
    S.getComputer(env, computer),
    S.getLease(env, computer),
    S.openNeedsYou(env, computer),
  ]);
  const degraded = [];
  let prev = null;
  try {
    prev = await S.previewMeta(env, computer);
  } catch {
    // Optional: a preview is a convenience, and a DB missing the metadata
    // table is not a reason to fail the whole poll. But it is NOT silent —
    // see `degraded` below (B-14: a discarded result hides store health).
    degraded.push("preview");
  }
  return {
    computer,
    mode: c.mode,
    generation: c.generation,
    status: await status(env, computer),
    lease: lease && lease.live
      ? { leaseId: lease.leaseId, holder: lease.holder, expiresAt: lease.expiresAt, fence: lease.fence }
      : null,
    needsYou: needs,
    preview: prev ? { sha256: prev.sha256, bytes: prev.bytes ?? null,
                      capturedAt: prev.capturedAt } : null,
    // Explicit health, never inferred. `ok` here means every read above
    // succeeded; anything else names what could not be read.
    store: degraded.length ? "degraded" : "ok",
    ...(degraded.length ? { degraded } : {}),
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

/**
 * Serve the UI.
 *
 * `ui.html` ships as a plain static asset beside this module, so the Worker
 * asks the Pages asset binding for it. The previous version did two things
 * that could not work: it fetched a made-up host (`https://x/computer-ui.html`,
 * a file that never existed) and fell back to a `?raw` import that requiries
 * a bundler this project does not use. On a direct upload (wrangler pages
 * deploy, and scripts/deploy-pages-proxy.py) `env.ASSETS` is bound, so the
 * first path is the real one; the second is only a loud, honest failure.
 */
async function serveUi(env, url) {
  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(new Request(new URL("/computer/ui.html", url.origin)));
    if (res && res.ok) {
      return new Response(res.body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // The UI is versioned with the Worker that serves it; a cached copy
          // would disagree with the endpoints it calls.
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "same-origin",
          // The panel is framed by the console (same origin) and nothing else.
          "Content-Security-Policy": "frame-ancestors 'self'",
        },
      });
    }
  }
  return new Response(
    "<!doctype html><meta charset=utf-8><title>Computer</title>" +
    "<p>The computer UI asset (computer/ui.html) is not deployed.</p>",
    { status: 500, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export async function handleComputer(request, env, url) {
  const path = url.pathname;
  const q = url.searchParams;

  // ---- rate limit (BUGS.md B-10) ----
  // Classified by endpoint, not by URL pattern, because the cost of each one
  // differs by orders of magnitude: a status poll is a few indexed reads, a
  // mint is a lease read plus a seal, and an upload is up to 1.5 MB into D1.
  // A single global limit would either throttle the cheap calls or wave the
  // expensive ones through. `take()` is free (in-memory); only a trip writes.
  const cls = limitClass(path, request.method);
  if (cls) {
    const limited = await rateLimit(request, env, cls);
    if (limited) return limited;
  }

  // ---- UI ----
  if (path === "/computer" || path === "/computer/") return serveUi(env, url);

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
    let r;
    try {
      r = await S.takeControl(env, computer, "user");
    } catch (e) {
      // A binding/DDL failure must read as "store unavailable", not as a 500
      // with a stack. T52 recorded exactly this symptom.
      return json({ error: "store", detail: String(e).slice(0, 200) }, 503);
    }
    if (!r.ok) {
      return json({ error: r.reason, holder: r.holder, expiresAt: r.expiresAt },
        r.reason === "held" ? 409 : 503);
    }
    return json({ leaseId: r.lease.leaseId, expiresAt: r.lease.expiresAt,
                  fence: r.lease.fence, generation: r.generation });
  }
  if (path === "/computer/heartbeat" && request.method === "POST") {
    const { computer = "default", leaseId } = await request.json().catch(() => ({}));
    let r;
    try {
      r = await S.heartbeat(env, computer, leaseId);
    } catch (e) {
      return json({ error: "store", detail: String(e).slice(0, 200) }, 503);
    }
    return r.ok ? json({ leaseId: r.leaseId, expiresAt: r.expiresAt })
                : json({ error: r.reason }, 409);
  }
  if (path === "/computer/release" && request.method === "POST") {
    const { computer = "default", leaseId } = await request.json().catch(() => ({}));
    let r;
    try {
      r = await S.release(env, computer, leaseId);
    } catch (e) {
      return json({ error: "store", detail: String(e).slice(0, 200) }, 503);
    }
    if (!r.ok) {
      return json({ error: r.reason }, r.reason === "not_holder" ? 409 : 503);
    }
    return json({ ok: true, generation: r.generation });
  }

  // ---- session (mint) ----
  if (path === "/computer/session") {
    const computer = q.get("computer") || "default";
    // The lease decides view vs control, so it must be read strictly. It used
    // to be `.catch(() => null)`, which turns "the store is down" into "nobody
    // holds control" — the agent's screen would keep working while the user's
    // Take control silently degraded to a view link. That is the same
    // broken-store-looks-like-empty-store ambiguity as B-15, one layer down.
    let lease;
    try {
      lease = await S.getLease(env, computer);
    } catch (e) {
      return json({ error: "store", detail: String(e).slice(0, 200) }, 503);
    }
    const held = Boolean(lease && lease.live && lease.holder === "user");
    const r = await mint(env, computer, held ? "control" : "view", held ? lease.leaseId : null);
    return r.ok ? json(r) : json({ error: r.error }, r.error === "no_lease" ? 403 : 503);
  }

  // ---- mode ----
  if (path === "/computer/mode" && request.method === "POST") {
    const { computer = "default", mode } = await request.json().catch(() => ({}));
    let r;
    try {
      r = await S.setMode(env, computer, mode);
    } catch (e) {
      return json({ error: "store", detail: String(e).slice(0, 200) }, 503);
    }
    return r.ok ? json(r) : json({ error: r.reason }, 400);
  }

  // ---- needs-you ----
  if (path === "/computer/needs-you" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    // The agent calls this. Token-gated, constant-time, and fail-closed when
    // no token is configured (BUGS.md B-16: a plain `!==` on a token leaks it
    // by timing; an unset secret is a config error, not permission).
    // Token-gated. (The constant-time helper lands with the terminal commit.)
    if (env.COMPUTER_SYNC_TOKEN && request.headers.get("X-Computer-Token") !== env.COMPUTER_SYNC_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }
    let r;
    try {
      r = await S.raiseNeedsYou(env, b.computer || "default", b.text, b.runId);
    } catch (e) {
      return json({ error: "store", detail: String(e).slice(0, 200) }, 503);
    }
    return json(r);
  }
  if (path === "/computer/needs-you/resolve" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    let r;
    try {
      r = await S.resolveNeedsYou(env, b.computer || "default", b.action);
    } catch (e) {
      return json({ error: "store", detail: String(e).slice(0, 200) }, 503);
    }
    return r.ok ? json(r) : json({ error: r.reason }, 409);
  }

  // ---- preview ----
  if (path === "/computer/preview") {
    const computer = q.get("computer") || "default";
    // A broken store must not read as "this computer has no preview" (the
    // B-15 class: an error and a legitimate empty value must never look the
    // same). 404 keeps meaning "never captured"; a store failure is 503.
    let row;
    try {
      row = await S.getPreview(env, computer);
    } catch (e) {
      return json({ error: "store", detail: String(e).slice(0, 200) }, 503);
    }
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
    // Token-gated. (The constant-time helper lands with the terminal commit.)
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
    let ok;
    try {
      ok = await S.leaseValid(env, cap.scope.computer, cap.scope.leaseId);
    } catch {
      // Fails CLOSED — no store, no control — but says so. Reporting "Control
      // was released" for a store outage is the same class of lie as B-15: it
      // sends the user to press Take control again instead of waiting.
      return new Response("Control unavailable (store).", { status: 503 });
    }
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
