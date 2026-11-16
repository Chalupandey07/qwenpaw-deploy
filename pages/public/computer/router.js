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
import {
  mintTerminal, authorizeTerminal, requireSyncToken,
} from "./terminal.js";
import { sessionFromRequest } from "../session.js";

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
  if (path === "/computer/teach") return "teach";
  if (path === "/computer/terminal/session") return "terminal";
  if (path === "/computer/terminal/recording") return "teach";
  if (path.startsWith("/computer/terminal/")) return "terminal";
  if (path === "/computer/wake") return "mutation";
  if (method === "POST") return "mutation";
  return null;
}

/**
 * Upstream targets. Each is a published InstaBox port; the token is a secret.
 *
 * TOKEN NAMES (fix 2026-11-16): the tokens are the OLD DESKTOP_*_TOKEN Worker
 * secrets, NOT the COMPUTER_*_TOKEN values. InstaBox's private-port edge only
 * accepts the token that was configured for the machine's ports (it is checked
 * as a `_token` query param, see fetchDesktopOrigin below); a fresh random
 * COMPUTER_*_TOKEN is answered 403 even when sent correctly, and a Bearer
 * header is answered 401 outright. The DESKTOP_*_TOKEN secrets are the ones
 * the working /desktop proxy used, and they are still set on both Pages
 * projects. Do not "rotate" them to fresh random values — that breaks the
 * desktop again. The COMPUTER_CAPABILITY_SECRET / COMPUTER_SYNC_TOKEN secrets
 * are separate (Worker-side sealing and machine-side auth) and are unaffected.
 */
function origins(env) {
  return {
    "default": {
      control: { url: env.COMPUTER_CONTROL_ORIGIN, token: env.DESKTOP_ORIGIN_TOKEN },
      view: { url: env.COMPUTER_VIEW_ORIGIN, token: env.DESKTOP_VIEW_TOKEN },
    },
    "qa": {
      control: { url: env.COMPUTER_QA_CONTROL_ORIGIN, token: env.DESKTOP_QA_ORIGIN_TOKEN },
      view: { url: env.COMPUTER_QA_VIEW_ORIGIN, token: env.DESKTOP_QA_VIEW_TOKEN },
    },
  };
}

function collectSetCookiePairs(res) {
  const list = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("Set-Cookie") ? [res.headers.get("Set-Cookie")] : []);
  return list.map((c) => c.split(";")[0]).filter(Boolean);
}

/**
 * Fetch one URL from an InstaBox private-port origin, the way the edge
 * expects it. Ported from the working /desktop proxy (pre-rebuild _worker.js
 * `fetchDesktopOrigin`), which is the only mechanism that has ever worked
 * against this edge — the Bearer-header approach the rebuild introduced is
 * answered 401 on every request, which made /computer report "stopped"
 * forever, hid Take control, and starved the preview uploader.
 *
 * How the edge authenticates:
 *   - No token at all -> 401.
 *   - A wrong `_token` -> 403.
 *   - The right `_token` (the DESKTOP_*_TOKEN secret) -> a 303 with a
 *     Set-Cookie (`__Host-instabox_port_auth`); follow the redirect with
 *     that cookie and the origin answers 200.
 * So: fetch plain; on 401 retry once with `?_token=<token>`; follow 3xx
 * redirects manually, collecting the proxy-auth cookies and deleting
 * `_token` from the followed URL. The browser's cookies are dropped
 * outright — a stale `__Host-instabox_port_auth` for another port would be
 * honored first by the proxy and 401 the fetch.
 * Returns `{ res }` (res may be null on a thrown subrequest).
 */
async function fetchDesktopOrigin(request, url, originUrl, origin, token) {
  const buildReq = (target, extraCookies) => {
    const req = new Request(target, request);
    req.headers.delete("host");
    req.headers.delete("cf-connecting-ip");
    req.headers.delete("cf-ipcountry");
    req.headers.delete("cf-ray");
    req.headers.delete("cf-visitor");
    req.headers.delete("Cookie");
    req.headers.set("X-Forwarded-Host", url.host);
    req.headers.set("X-Forwarded-Proto", "https");
    if (extraCookies && extraCookies.length) {
      req.headers.set("Cookie", extraCookies.join("; "));
    }
    return req;
  };

  let target = new URL(originUrl);
  let cookies = [];
  let usedToken = false;
  for (let hop = 0; hop < 4; hop++) {
    let res;
    let threw = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(buildReq(target, cookies), { redirect: "manual" });
        threw = false;
        break;
      } catch {
        // Immediate retry (no sleep: B-13 forbids latency padding on a
        // request path). A thrown fetch is a transient blip; the next
        // attempt is the last.
      }
    }
    if (threw) return { res: null };
    if (res.status === 401 && !usedToken && token) {
      usedToken = true;
      target = new URL(originUrl);
      target.searchParams.set("_token", token);
      continue;
    }
    const loc = res.headers.get("Location");
    if (res.status >= 300 && res.status < 400 && loc) {
      cookies = [...cookies, ...collectSetCookiePairs(res)];
      let next;
      try {
        next = new URL(loc, target);
      } catch {
        return { res };
      }
      if (next.origin !== origin) return { res };
      next.searchParams.delete("_token");
      target = next;
      continue;
    }
    return { res };
  }
  return { res: null };
}

async function status(env, computer) {
  // The desktop is "up" when the view-only origin answers. A short timeout:
  // this runs on a 10 s poll and a slow answer must not stack up.
  // The probe goes through fetchDesktopOrigin (the `_token` + cookie dance):
  // a Bearer header is answered 401 by the InstaBox edge, which used to make
  // this always return "stopped" even with the desktop up — and "stopped"
  // hides Take control and starves the preview uploader (the chicken-and-egg
  // that made /computer show "Asleep" forever).
  const o = origins(env)[computer];
  if (!o?.view?.url) return "unconfigured";
  if (!o.view.token) return "unconfigured";
  try {
    const probeUrl = new URL(o.view.url + "/vnc.html");
    const { res } = await fetchDesktopOrigin(
      new Request(probeUrl, { method: "HEAD", signal: AbortSignal.timeout(4000) }),
      new URL("https://qwenpawx.pages.dev/"),
      probeUrl.toString(),
      new URL(o.view.url).origin,
      o.view.token,
    );
    if (!res) return "stopped";
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

/**
 * Does this path require a console session cookie?
 *
 * Written as an explicit ALLOWLIST OF EXEMPTIONS, not as an allowlist of
 * gated paths: a new endpoint added later is therefore protected by default.
 * The opposite shape (a list of paths that need auth) is how the original hole
 * happened — `/computer/state` was written long after nobody was thinking
 * about auth, and nothing about adding it forced the question.
 *
 * The two exemption families are justified in handleComputer; in short, a
 * sealed capability is stronger than a session, and the machine's uploader is
 * authenticated by its own shared token.
 */
export function requiresSession(path, method = "GET") {
  // CORS preflight carries NO cookie by design (the browser sends it before the
  // real request, precisely so it can learn whether to send credentials at all).
  // Gating it would make every cross-origin module request fail as an opaque
  // CORS error — which is exactly the failure B-31 recorded, one layer down.
  // The preflight authorises nothing: it returns an allow list and no data. The
  // real request behind it still carries a cookie and is still checked.
  if (method === "OPTIONS") return false;

  // Static UI assets: no data, no secret.
  if (path === "/computer" || path === "/computer/") return true;
  // `/vendor/` is matched on the URL as received. A traversal attempt is NOT
  // normalised here on purpose: `/vendor/../computer/ui.html` must reach the
  // vendor allowlist and get its honest 404, not fall through to a route that
  // happens to serve the same bytes under a different rule. Deciding what a
  // hostile path means is the router's job, not the gate's.
  if (path.startsWith("/vendor/")) return false;
  if (path === "/computer/teach.js" || path === "/computer/terminal.js") return false;
  // Any other STATIC asset under /computer (the UI html, a stylesheet, a module)
  // is bytes on disk, not state. Matching on a known extension rather than on a
  // path list means a new endpoint — which never has an extension — is gated by
  // default, while a traversal that normalises into a static path still gets the
  // router's 404 instead of a misleading 401.
  if (/^\/computer\/[A-Za-z0-9_.-]+\.(html|css|js|map|svg|png|ico|woff2?)$/.test(path)) return false;

  // Capability-authorised surfaces. The capability is minted only for a
  // session-holding caller, is unforgeable, and re-checks the live lease on
  // every request — so it is strictly stronger evidence than the cookie.
  if (path.startsWith("/computer/session/")) return false;
  if (path.startsWith("/computer/terminal/")) return false;

  // Machine-facing (uploader, agent relay): shared-token authenticated.
  if (path === "/computer/preview-upload" && method === "POST") return false;
  if (path === "/computer/needs-you" && method === "POST") return false;
  if (path === "/computer/teach/pending" && method === "GET") return false;
  if (path === "/computer/teach/ack" && method === "POST") return false;

  // Everything else under /computer is user-facing state and MUST be gated.
  return true;
}

export async function handleComputer(request, env, url) {
  const path = url.pathname;
  const q = url.searchParams;

  // ---- authentication gate (P0, 2026-11-16) ----
  //
  // THIS ROUTE HAD NO AUTH OF ANY KIND. Verified live before this line
  // existed: an anonymous curl got a 1920x1080 screenshot of the user's
  // desktop, created a live control lease, minted a `policy:"control"` screen
  // capability, and minted a terminal capability — a pre-authentication
  // remote ROOT SHELL, since minting one needs only a live lease and a lease
  // needed only a POST.
  //
  // The check runs BEFORE any store access so an unauthenticated caller can
  // never consume a lease, a generation, a preview read, or an HMAC mint.
  //
  // Three surfaces are deliberately exempt, and each has its own proof:
  //   * `/computer/session/*` and `/computer/terminal/*` — the sealed
  //     capability IS the authorization (unforgeable, scoped, expiring), and
  //     the framing iframes are opaque-origin so a cookie would not survive
  //     there anyway. Re-checking a session here would break the screen
  //     without adding a guarantee the capability does not already give.
  //   * agent/machine endpoints — authenticated by COMPUTER_SYNC_TOKEN
  //     (constant-time, fail-closed when unset) because the caller is the
  //     machine's uploader, not a browser.
  //   * static assets — `/vendor/*`, `teach.js`, `terminal.js` contain no
  //     data and no secret; gating them only shifts a 404 into a login page.
  if (requiresSession(path, request.method)) {
    const session = await sessionFromRequest(env, request);
    if (!session.ok) {
      // A missing secret is a DEPLOY error, not a visitor problem. Answering
      // 401 "please sign in" for it sends the user round a login loop that can
      // never succeed, and hides a broken deploy behind a plausible page.
      if (session.reason === "unconfigured") {
        return json({
          error: "session_unconfigured",
          reason: "unconfigured",
          detail: "COMPUTER_SESSION_SECRET (or COMPUTER_CAPABILITY_SECRET) is not set on "
            + "this Pages project, so no session can be verified.",
        }, 503);
      }
      return json({
        error: "auth_required",
        reason: session.reason,
        detail: "Open the QwenPaw console and sign in, then reload this page.",
      }, 401);
    }
  }

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
  // Static UI modules. ui.html dynamically imports teach.js (the recorder)
  // and the terminal code; the _worker.js routes ALL /computer/* here, so
  // these must be served from the Pages asset binding or the imports 404
  // and the Teach/Terminal tabs are dead. (Fix 2026-11-16: both returned
  // 404, which is why the browser's Teach/Terminal never loaded.)
  // `/vendor/*` — xterm.js and its stylesheet (BUGS.md B-35).
  //
  // THESE WERE NEVER ROUTED. Every other path falls through to the console
  // proxy, so `/vendor/xterm.js` was answered by the QWENPAW CONSOLE with its
  // SPA index page — 200, text/html, 45 KB. A `<script src>` served as HTML
  // parses as nothing, so `window.Terminal` stayed undefined, xterm never
  // existed, and the terminal pane was black. Worse, it failed SILENTLY: the
  // script "loaded" (200), so no onerror fired and nothing logged.
  //
  // Proven live before the fix:
  //   GET /vendor/xterm.js -> 200  text/html  45989  (the console SPA)
  //   GET /vendor/xterm.css -> 200  text/html  45989  (the same SPA)
  //
  // The MIME type is set explicitly rather than trusted from the asset store:
  // a JS file served as text/plain is refused by strict module loaders, and a
  // stylesheet served as anything else is ignored silently.
  if (path.startsWith("/vendor/")) {
    const name = path.slice("/vendor/".length);
    // Exact allowlist: no traversal, no wildcards, no unknown ext.
    const types = { "xterm.js": "application/javascript; charset=utf-8",
                    "xterm.css": "text/css; charset=utf-8" };
    const type = types[name];
    if (!type || !env.ASSETS) return new Response("not found", { status: 404 });
    const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
    if (!res || !res.ok) return new Response("not found", { status: 404 });
    return new Response(res.body, {
      headers: {
        "Content-Type": type,
        // Vendored third-party files are immutable for a given path; a short
        // cache is safe and stops a re-download on every tab switch.
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (path === "/computer/teach.js" || path === "/computer/terminal.js") {
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
      if (res && res.ok) {
        return new Response(res.body, {
          headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }

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
    const denied = await requireSyncToken(request, env);
    if (denied) return denied;
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
    // getPreview returns a real Uint8Array (decoded from hex); send it with
    // an explicit length so the edge cannot truncate it to an empty body.
    return new Response(row.png, {
      headers: {
        "Content-Type": "image/png", ETag: etag,
        "Content-Length": String(row.png.byteLength),
        "Cache-Control": "private, max-age=120",
      },
    });
  }
  if (path === "/computer/preview-upload" && request.method === "POST") {
    const denied = await requireSyncToken(request, env);
    if (denied) return denied;
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

  // ---- teach ----
  // Saving a draft. Deliberately NOT token-gated for the browser: the caller
  // is the authenticated UI acting on the user's own demonstration. Reading
  // the pending list IS token-gated, because that is the agent-facing side.
  if (path === "/computer/teach" && request.method === "POST") {
    const b = await request.json().catch(() => null);
    if (!b || !b.name || !b.playbook || !Array.isArray(b.playbook.steps) || b.playbook.steps.length === 0) {
      // The endpoint refuses what the editor refuses. A skill with no steps
      // reaching the store is how "Saved" became a lie in the old UI.
      return json({ error: "invalid_skill", detail: "needs a name and at least one step" }, 400);
    }
    try {
      return json(await S.putTaughtSkill(env, b.computer || "default", b));
    } catch (e) {
      return json({ error: "store", detail: String(e).slice(0, 200) }, 503);
    }
  }
  if (path === "/computer/teach/pending" && request.method === "GET") {
    const denied = await requireSyncToken(request, env);
    if (denied) return denied;
    const computer = q.get("computer") || "default";
    try {
      return json({ skills: await S.listTaughtSkills(env, computer) });
    } catch (e) {
      return json({ error: "store", detail: String(e).slice(0, 200) }, 503);
    }
  }
  if (path === "/computer/teach/ack" && request.method === "POST") {
    const denied = await requireSyncToken(request, env);
    if (denied) return denied;
    const b = await request.json().catch(() => ({}));
    if (!b.id) return json({ error: "bad_request" }, 400);
    try {
      return json(await S.deleteTaughtSkill(env, b.id));
    } catch (e) {
      return json({ error: "store", detail: String(e).slice(0, 200) }, 503);
    }
  }

  // ---- terminal (the highest-risk surface: a shell) ----
  // Minting requires the caller to name a lease they actually hold; opening
  // the socket re-checks the LIVE lease and the generation. There is no
  // view-only terminal and no fallback: a read-only shell is still a shell.
  if (path === "/computer/terminal/session" && request.method === "POST") {
    const { computer = "default", leaseId } = await request.json().catch(() => ({}));
    if (!leaseId) return json({ error: "no_lease" }, 403);
    let r;
    try {
      r = await mintTerminal(env, computer, leaseId);
    } catch (e) {
      return json({ error: "store", detail: String(e).slice(0, 200) }, 503);
    }
    if (!r.ok) {
      // `not_holder` is a 409 (someone else has it); `no_lease` a 403 (take
      // control first); `unconfigured` a 503 (a deploy error, not a refusal).
      const status = r.error === "not_holder" ? 409 : r.error === "unconfigured" ? 503 : 403;
      return json({ error: r.error }, status);
    }
    // `deadlineMs` is the wall clock at which the PTY server kills the shell.
    // The browser shows it as a countdown so a user is never surprised.
    // `preamble` is the signed first line the PTY server requires; see
    // mintTerminal for why the browser has to send it (a tunnelled WebSocket
    // cannot be written to by the Worker).
    return json({ url: r.url, deadlineMs: r.deadlineMs, expiresAt: r.expiresAt,
                  preamble: r.preamble });
  }

  // The websocket upgrade itself. websockify terminates the browser's WS and
  // dials the PTY server on the machine.
  //
  // THIS USED TO RETURN JSON. It authorised correctly and then answered
  // `{ok:true, computer, deadlineMs, maxDim}` — never proxying, never
  // tunnelling. The browser opened a WebSocket, received a JSON body where a
  // 101 belonged, and its close handler fired: "The shell closed. Take control
  // again to reopen it." That is why the failure looked like a ~10-15 s
  // timeout while the lease was still held. The ~10 s was the client giving up,
  // not a server deadline. BUGS.md B-29.
  if (path.startsWith("/computer/terminal/")) {
    return proxyTerminal(request, env, url);
  }

  // ---- the stream + assets ----
  if (path.startsWith("/computer/session/")) return proxyScreen(request, env, url);

  return json({ error: "not_found" }, 404);
}

/**
 * CORS for the screen capability surface.
 *
 * WHY THIS IS REQUIRED, AND WHY `*` IS CORRECT HERE
 *
 * The screen is embedded in iframes with `sandbox="allow-scripts
 * allow-pointer-lock"` and deliberately WITHOUT `allow-same-origin` — that
 * omission is a security property: it keeps the remote desktop in an opaque
 * origin so it cannot reach this page's DOM or storage. The consequence is
 * that every request the frame makes is cross-origin to us.
 *
 * noVNC loads as ES modules: `<script type="module" crossorigin="anonymous">`
 * plus an inline module importing `./app/ui.js` and
 * `./core/util/logging.js`. Module scripts are ALWAYS fetched in CORS mode, so
 * without `Access-Control-Allow-Origin` the browser refuses them and noVNC
 * never initializes — it never opens its WebSocket, and the frame sits on
 * "The screen did not respond" while the socket itself works perfectly.
 *
 * That is why every curl/Node probe passed and every browser failed: curl and
 * Node do not enforce CORS. The 101 tunnel fix was real and stayed live; the
 * browser simply never got far enough to use it.
 *
 * `*` rather than an origin allowlist: the URL IS the authorization. A
 * capability is a sealed, expiring, scoped token and is unguessable; anyone
 * holding it is already entitled to that one screen. Echoing a specific Origin
 * would add nothing (an attacker's page cannot forge the token) and would break
 * the opaque-origin case, where the browser sends `Origin: null`.
 *
 * `*` does NOT expose credentials: `Access-Control-Allow-Credentials` is never
 * set, and the upstream provider token travels inside the seal, server-side. So
 * this grants read access to bytes the caller already had to be authorised to
 * request.
 */
function withCors(headers) {
  const out = new Headers(headers);
  out.set("Access-Control-Allow-Origin", "*");
  // No `Vary: Origin`: the response is identical for every Origin, so varying
  // on it would only fragment caches.
  return out;
}

/** Preflight: 204, no body. The frame asks; the browser reads the allow list. */
function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Proxy one TERMINAL request — the shell's WebSocket.
 *
 * Same enforcement order as the screen, and the same tunnel, because a shell is
 * the higher-risk surface and must not have a weaker path:
 *
 *   1. OPTIONS preflight (the terminal frame is cross-origin too)
 *   2. the capability opens (signature + expiry + policy from the AAD)
 *   3. the generation still matches (a takeover invalidates old links)
 *   4. the sealed lease is STILL the live lease — checked on every request, so
 *      releasing control kills the ability to open a new socket immediately
 *   5. proxy to the terminal origin and tunnel the 101
 *
 * It does NOT return JSON any more. It used to, and that was B-29: the browser
 * received a JSON body where a 101 belonged, so its socket closed and the UI
 * reported "The shell closed" while the lease was still held. The ~10 s was the
 * client giving up, never a server deadline.
 *
 * The live-lease check here is the second of THREE independent expiry
 * mechanisms, and all three are needed because each covers a hole the others
 * cannot:
 *   - this check refuses a NEW socket after release;
 *   - the capability's own expiry bounds a socket that was never opened;
 *   - the signed preamble deadline makes the PTY SERVER kill an ALREADY-OPEN
 *     shell, which the Worker cannot do — it is not in the loop for a
 *     tunnelled socket. (BUGS.md B-4's 59-minute shell.)
 */
async function proxyTerminal(request, env, url) {
  if (request.method === "OPTIONS") return corsPreflight();

  const auth = await authorizeTerminal(env, url.pathname, url.searchParams.get("computer"));
  if (!auth.ok) {
    const body = auth.error === "store" ? "Terminal unavailable (store)."
      : auth.error === "released" ? "Control was released."
      : "Terminal link expired.";
    return new Response(body, {
      status: auth.status,
      headers: withCors({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }),
    });
  }

  const upstream = new URL(auth.target.url);
  // websockify serves the WS on /websockify; the capability's own `rest` was the
  // path noVNC appended, but for the terminal we always want that endpoint.
  upstream.pathname = upstream.pathname.replace(/\/+$/, "") + "/websockify";

  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("host");
  headers.delete("authorization");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");

  // The terminal port is private, so the edge needs its token. This goes
  // server-side only — the browser never sees it (same rule as the screen's
  // provider token).
  let res;
  try {
    res = await fetchDesktopOrigin(
      new Request(upstream.toString(), { method: request.method, headers }),
      url, upstream.toString(), auth.target.url, auth.target.token || "",
    ).then((r) => r.res);
  } catch {
    res = null;
  }
  if (!res) {
    return new Response("Terminal unavailable (upstream_timeout).", {
      status: 502,
      headers: withCors({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }),
    });
  }

  // The whole point: tunnel the upgrade, exactly as the screen does. Without
  // this the runtime refuses to construct a 101 and the socket never opens.
  if (res.status === 101 && res.webSocket) {
    const upgradeHeaders = new Headers(res.headers);
    upgradeHeaders.delete("set-cookie");
    upgradeHeaders.delete("content-length");
    upgradeHeaders.delete("content-type");
    return new Response(null, { status: 101, headers: upgradeHeaders, webSocket: res.webSocket });
  }

  // A non-upgrade response is a real refusal from the terminal origin (401 from
  // the edge, 503 waking, ...). Pass the status through so the browser's close
  // handler can say something true, and never fabricate a socket.
  const out = new Headers(res.headers);
  out.delete("set-cookie");
  return new Response(res.body, { status: res.status, headers: withCors(out) });
}

/** Proxy one screen request, after all four checks. */
async function proxyScreen(request, env, url) {
  // Preflight first: an OPTIONS request carries no capability semantics and
  // should not consume the store reads below.
  if (request.method === "OPTIONS") return corsPreflight();

  const cap = await openCapability(env.COMPUTER_CAPABILITY_SECRET, url.pathname);
  if (!cap) {
    return new Response("Screen link expired or invalid.", {
      status: 403,
      headers: withCors({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }),
    });
  }

  // 2. generation must still match — a takeover or release invalidated it.
  let computer;
  try {
    computer = await S.getComputer(env, cap.scope.computer);
  } catch {
    return new Response("Screen unavailable (store).", {
      status: 503,
      headers: withCors({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }),
    });
  }
  if (!computer || computer.generation !== cap.scope.generation) {
    return new Response("Screen link expired.", {
      status: 403,
      headers: withCors({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }),
    });
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
      return new Response("Control unavailable (store).", {
        status: 503,
        headers: withCors({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }),
      });
    }
    if (!ok) {
      return new Response("Control was released.", {
        status: 403,
        headers: withCors({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }),
      });
    }
  }

  // 4. proxy. The provider token rides in the sealed target and never reaches
  // the browser; the browser's own Cookie header is dropped so a stale
  // per-port cookie cannot 401 this one. The upstream fetch goes through
  // fetchDesktopOrigin (the `_token` + cookie dance): a Bearer header is
  // answered 401 by the InstaBox edge, which used to make every screen
  // request fail and the desktop show an endless "Opening the computer…"
  // spinner. The token is the DESKTOP_*_TOKEN secret (see origins()).
  const upstream = new URL(cap.rest || "/", cap.target.url);
  const headers = novncPageRequestHeaders(request.headers);
  headers.delete("cookie");
  headers.delete("host");
  headers.delete("Authorization");
  const upstreamReq = new Request(upstream.toString(), {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
  });
  const { res } = await fetchDesktopOrigin(
    upstreamReq, url, upstream.toString(), cap.target.url, cap.target.token || "",
  );
  if (!res) {
    return new Response("Screen unavailable (upstream_timeout)", {
      status: 502,
      headers: withCors({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }),
    });
  }

  // WebSocket upgrade. THIS IS THE LINE THE SCREEN DEPENDED ON AND DID NOT HAVE.
  //
  // A noVNC frame opens a WebSocket to <capability path>/websockify. `fetch()`
  // in Workers CAN carry that upgrade — it returns status 101 with a
  // `webSocket` property — but only if the caller tunnels it back with
  // `new Response(null, {status: 101, webSocket})`. Without this branch the
  // Response is constructed with status 101 and no tunnel, which the runtime
  // rejects (status must be 200-599) or drops, so the browser's WebSocket
  // never completes. Every symptom followed from that one omission:
  // the page HTML loads (200), the shim reports "connecting", noVNC waits for
  // an RFB banner that only travels over the socket, and the UI times out with
  // "The screen did not respond."
  //
  // The retired implementation had exactly this branch twice (the console
  // proxy and the desktop session proxy); the Rakazo rebuild dropped it. The
  // existing harness could not see it because it only ever asserted TEXT in
  // this file, never that a 101 is tunnelled.
  if (res.status === 101 && res.webSocket) {
    // Minimal headers on an upgrade: the handshake already happened upstream,
    // and forwarding page-level headers (CSP, no-store, accept-encoding) onto
    // a 101 invites the runtime to reject the tunnel.
    const upgradeHeaders = new Headers(res.headers);
    upgradeHeaders.delete("set-cookie");
    upgradeHeaders.delete("content-length");
    upgradeHeaders.delete("content-type");
    return new Response(null, { status: 101, headers: upgradeHeaders, webSocket: res.webSocket });
  }

  // noVNC pages get the shim; everything else streams through untouched.
  if (isNovncPage(upstream.pathname) && (res.headers.get("content-type") || "").includes("text/html")) {
    const text = await res.text();
    if (text.length > 1024 * 1024) return new Response("Screen page too large.", { status: 502 });
    return new Response(injectShim(text, cap.policy === "view"), {
      status: res.status,
      headers: withCors(rewrittenNovnc(res.headers)),
    });
  }

  const out = new Headers(res.headers);
  out.delete("set-cookie");
  // This is the line that unblocks noVNC: app.js, core/rfb.js, the CSS, the
  // fonts — every module and asset the page imports — must carry ACAO or the
  // opaque-origin iframe refuses them.
  return new Response(res.body, { status: res.status, headers: withCors(out) });
}
