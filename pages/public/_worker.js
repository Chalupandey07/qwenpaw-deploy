// QwenPaw reverse proxy — Cloudflare Pages Advanced Mode (_worker.js).
// Root / and everything else is proxied to the QwenPaw console on InstaBox.
// /status (and /status.html) serves the status / wake page from static assets.
// Every proxied visit hits the InstaBox public URL, which counts as activity
// and wakes an auto-paused box; the 5-minute Worker cron is the other keeper.
const ORIGIN = "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const WAKE_WAIT_MS = 45_000;

// Built-in desktop (:1, Xfce + Chromium) served via noVNC on port 6081.
// The origin is the PRIVATE published port; its token lives in the Worker
// secret DESKTOP_ORIGIN_TOKEN (never in git). The page is gated on a valid
// QwenPaw session (same satwik login as the console): the worker probes
// /api/healthz with the visitor's cookies — 200 = logged in, 401 = log in
// first. This is the Rakazo-style embedded desktop: the user watches and
// drives the desktop from the console's own domain, no separate link.
const DESKTOP_ORIGIN = "https://6081-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
// View-only desktop: a second, view-only x11vnc server on :1 (RFB 5902)
// served by websockify on port 6082 (private publish). Its token is the
// Worker secret DESKTOP_VIEW_TOKEN. The default /desktop view is this
// view-only stream; driving it requires holding the control lease (P0).
const DESKTOP_VIEW_ORIGIN = "https://6082-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
// Keep-alive Worker: GET /ping is the public wake path (probing the public
// console URL wakes a paused box); GET /status is its cached status.
const KEEPALIVE_URL = "https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev";
// Machine id, derived from ORIGIN (8088-<id-without-m_>.instabox.tech).
const MACHINE_ID = "m_" + new URL(ORIGIN).hostname.split(".")[0].split("-").slice(1).join("-");
// Rakazo-style control lease: 90 s lifetime, 15 s heartbeat (client-side,
// only while the page is visible), release names the lease id.
const LEASE_TTL_MS = 90_000;
// Sealed screen capability (AES-256-GCM): 60-min TTL, scoped to the
// generation + (for control) the lease id. See desktopCapability* below.
const CAPABILITY_TTL_S = 3600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wakingPage(retryAfter) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="refresh" content="30">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>QwenPaw — Waking up</title></head><body style="font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaf0;padding:2rem">` +
    `<h1>QwenPaw is waking up</h1>` +
    `<p>The InstaBox machine was paused and is starting now. This page refreshes automatically — the console will load on its own in about a minute.</p>` +
    (retryAfter ? `<p>Retry after about ${retryAfter} seconds.</p>` : ``) +
    `<p><a style="color:#22c55e" href="/status">Status page</a></p>` +
    `</body></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Retry-After": "30", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" } },
  );
}

function cooldownPage(retryAfter) {
  const mins = retryAfter ? Math.ceil(retryAfter / 60) : null;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>QwenPaw — Cooldown</title></head><body style="font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaf0;padding:2rem">` +
    `<h1>QwenPaw is in max-run cooldown</h1>` +
    `<p>The InstaBox Free machine hit its maximum run length and is cooling down. ` +
    `Nothing can wake it until the cooldown ends${mins ? ` — about ${mins} minutes` : ``}. ` +
    `The 5-minute keep-alive Worker will bring it back automatically when the cooldown ends.</p>` +
    `<p><a style="color:#22c55e" href="/status">Status page</a></p>` +
    `</body></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'", ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) } },
  );
}

function parseRetryAfter(res, bodyText) {
  const h = res.headers.get("Retry-After");
  if (h && /^\d+$/.test(h.trim())) return Number(h.trim());
  try {
    const j = JSON.parse(bodyText || "{}");
    const s = j?.error?.retryAfterSeconds ?? j?.retryAfterSeconds;
    if (typeof s === "number") return s;
  } catch { /* not JSON */ }
  return null;
}

function rewriteHeaders(res, pagesOrigin) {
  const headers = new Headers(res.headers);
  // Rewrite redirects that point at the origin so the browser stays on Pages.
  // Hardened (fix 2026-11-15, audit finding proxy-open-redirect-rewrite-gap):
  // the old code only rewrote absolute ORIGIN URLs. A protocol-relative
  // Location (//evil.example/x) or a foreign absolute URL
  // (https://evil.example/x) passed through unrewritten, so our Pages
  // domain could redirect visitors elsewhere. QwenPaw emits no Location
  // headers at all today (verified in source), so any Location is
  // hypothetical — but a foreign redirect must never leave here intact.
  const loc = headers.get("Location");
  if (loc) {
    if (loc.startsWith(ORIGIN)) {
      headers.set("Location", pagesOrigin + loc.slice(ORIGIN.length));
    } else if (loc.startsWith("//")) {
      try {
        const u = new URL("https:" + loc);
        if (u.origin === ORIGIN) {
          headers.set("Location", pagesOrigin + u.pathname + u.search + u.hash);
        } else {
          headers.delete("Location");
        }
      } catch {
        headers.delete("Location");
      }
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(loc)) {
      headers.delete("Location"); // absolute URL to a foreign host
    }
    // A relative Location ("/path") passes through — it stays on Pages.
  }
  // Framing guard on proxied HTML: the console must not be embeddable in
  // another site's iframe (clickjacking). SAMEORIGIN is safe here — nothing
  // in our setup embeds the console cross-origin.
  const contentType = headers.get("Content-Type") || "";
  if (contentType.includes("text/html")) {
    headers.set("X-Frame-Options", "SAMEORIGIN");
    headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  }
  // If the origin ever sets a Domain on a cookie, strip it so the cookie
  // becomes host-only for the Pages domain instead of the InstaBox host.
  const setCookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (headers.get("Set-Cookie") ? [headers.get("Set-Cookie")] : []);
  if (setCookies.length) {
    headers.delete("Set-Cookie");
    for (const c of setCookies) {
      headers.append("Set-Cookie", c.replace(/;\s*domain=[^;]+/gi, ""));
    }
  }
  return headers;
}

async function proxy(request, url) {
  const originUrl = ORIGIN + url.pathname + url.search;
  const pagesOrigin = url.origin;
  const isSafeMethod = request.method === "GET" || request.method === "HEAD";

  const buildRequest = () => {
    const req = new Request(originUrl, request);
    req.headers.delete("host");
    req.headers.delete("cf-connecting-ip");
    req.headers.delete("cf-ipcountry");
    req.headers.delete("cf-ray");
    req.headers.delete("cf-visitor");
    req.headers.set("X-Forwarded-Host", url.host);
    req.headers.set("X-Forwarded-Proto", "https");
    return req;
  };

  let res;
  try {
    res = await fetch(buildRequest());
  } catch (err) {
    // Deliberately generic: fetch error text can contain the origin URL
    // or stack fragments — never reflect it to the visitor.
    return new Response("QwenPaw origin unreachable. Try again in a moment.", {
      status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  // 503 = InstaBox is waking the machine. Wait, then retry once (safe methods
  // only — a streamed request body cannot be sent twice). Still waking after
  // that: return the auto-refreshing waking page.
  if (res.status === 503 && isSafeMethod) {
    let retryAfter = null;
    try {
      const bodyText = await res.text();
      retryAfter = parseRetryAfter(res, bodyText);
    } catch { /* ignore */ }
    try {
      await sleep(WAKE_WAIT_MS);
      res = await fetch(buildRequest());
    } catch {
      return wakingPage(retryAfter);
    }
    if (res.status === 503) {
      try {
        const bodyText = await res.text();
        retryAfter = parseRetryAfter(res, bodyText) ?? retryAfter;
      } catch { /* ignore */ }
      return wakingPage(retryAfter);
    }
  } else if (res.status === 503) {
    return wakingPage(null);
  }

  // 409 = max-run cooldown (or another operation conflict). Surface it plainly.
  if (res.status === 409) {
    let retryAfter = null;
    let code = null;
    try {
      const bodyText = await res.text();
      retryAfter = parseRetryAfter(res, bodyText);
      code = JSON.parse(bodyText || "{}")?.error?.code ?? null;
    } catch { /* ignore */ }
    if (code === "machine_cooldown") return cooldownPage(retryAfter);
    return new Response(
      `QwenPaw is busy with another operation (409 ${code || ""}). Retry in a moment.`,
      { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    );
  }

  const headers = rewriteHeaders(res, pagesOrigin);

  // WebSocket upgrade: return the upgrade response (with its webSocket) as-is.
  if (res.status === 101 && res.webSocket) {
    return new Response(null, { status: 101, headers, webSocket: res.webSocket });
  }

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Status / wake page — served from static assets, not proxied.
    if (path === "/status" || path === "/status.html") {
      if (!env.ASSETS) {
        return new Response("Status page assets are not bound.", { status: 500 });
      }
      // NOTE: fetch "status-page.html", not "status.html" — Pages redirects
      // a request for /status.html to the clean URL /status (308), which
      // would loop back here. The differently-named asset is served as-is.
      return env.ASSETS.fetch(new Request(url.origin + "/status-page.html"));
    }

    // Embedded desktop — /desktop/* proxied to the noVNC origin, gated on
    // a valid QwenPaw session (see desktop() below).
    if (path === "/desktop" || path.startsWith("/desktop/")) {
      return desktop(request, url, env, ctx);
    }

    return proxy(request, url);
  },
};

// --- Embedded desktop -----------------------------------------------------
// GET /desktop            -> gate page (first visit) or redirect to noVNC
// GET /desktop/<asset>    -> proxied to the noVNC origin (prefix stripped)
// WS  /desktop/websockify -> proxied WebSocket upgrade to the VNC server
// POST /desktop/__verify  -> mint a desktop session cookie (see below)
//
// WHY A GATE PAGE (fixed 2026-11-15): QwenPaw auth is header-based — the
// console SPA keeps its token in browser storage and sends it as
// `Authorization: Bearer <token>` (or `?token=`) on API calls. There is NO
// session cookie anywhere in QwenPaw (verified in
// /app/src/qwenpaw/app/auth.py `_extract_token`). A plain browser
// navigation to /desktop therefore carries no credential at all, so the
// old server-side probe (forward the visitor's Cookie to /api/healthz)
// could never pass for a logged-in user: it always got 401, bounced them
// to /, and the console SPA then sent them on to /chat. The gate below
// fixes that without touching QwenPaw:
//   * A visit without a valid desktop cookie gets a small gate page. It
//     runs in the browser on the same origin as the console, so it can
//     read the console's stored token, POSTs candidate tokens to
//     /desktop/__verify, and reloads once one verifies.
//   * /desktop/__verify checks the token against the origin
//     (/api/healthz with Authorization: Bearer) and, on 200, mints a
//     short-lived HMAC-signed cookie scoped to /desktop. The token is
//     never logged or stored anywhere.
//   * /desktop/* with a valid cookie is proxied to the noVNC origin as
//     before. The cookie is also sent on the noVNC WebSocket handshake,
//     so the live view works after the one-time check.
// The :1 VNC server runs with -SecurityTypes None, so noVNC never asks
// the user for a VNC password; access control is the QwenPaw session
// (this gate) plus the private-port token (server-side only, never in
// the browser URL). The :99 Camoufox VNC is likewise passwordless now.
const DESKTOP_COOKIE = "qwenpaw_desktop";
const DESKTOP_COOKIE_MAX_AGE_S = 12 * 3600;

function gatePage() {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>QwenPaw — Desktop</title></head><body style="font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaf0;padding:2rem">` +
    `<h1>Opening the desktop…</h1><p id="msg">Checking your QwenPaw login…</p>` +
    `<p><a style="color:#22c55e" href="/">Back to the console</a></p>` +
    `<script>
    (function () {
      var msg = document.getElementById('msg');
      function candidates() {
        var out = [];
        [window.localStorage, window.sessionStorage].forEach(function (store) {
          try {
            for (var i = 0; i < store.length; i++) {
              var v = store.getItem(store.key(i));
              if (typeof v === 'string' && v.length >= 20 && /^[A-Za-z0-9._\\-+/=]+$/.test(v) && out.indexOf(v) === -1) out.push(v);
            }
          } catch (e) { /* storage unavailable */ }
        });
        return out.slice(0, 10);
      }
      async function tryToken(t) {
        var r = await fetch('/desktop/__verify', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: t }) });
        return r.status === 200;
      }
      (async function () {
        var list = candidates();
        for (var i = 0; i < list.length; i++) {
          try { if (await tryToken(list[i])) { location.reload(); return; } } catch (e) { /* try the next candidate */ }
        }
        msg.textContent = 'Could not verify your QwenPaw login. Please log in to the console first, then come back here.';
        var p = document.createElement('p');
        var link = document.createElement('a');
        link.href = '/'; link.style.color = '#22c55e'; link.textContent = 'Go to the console to log in';
        p.appendChild(link); msg.after(p);
      })();
    })();
    </script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Content-Security-Policy": "frame-ancestors 'self'",
    },
  });
}

async function hmacHex(keyMaterial, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseDesktopCookie(request) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === DESKTOP_COOKIE) return rest.join("=");
  }
  return null;
}

async function desktopCookieValid(request, env) {
  const value = parseDesktopCookie(request);
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 < Date.now()) return false;
  const expect = await hmacHex(env.DESKTOP_ORIGIN_TOKEN, "desktop:" + exp);
  return sig.length === expect.length && sig === expect;
}

async function mintDesktopCookie(env) {
  const exp = Math.floor(Date.now() / 1000) + DESKTOP_COOKIE_MAX_AGE_S;
  const sig = await hmacHex(env.DESKTOP_ORIGIN_TOKEN, "desktop:" + exp);
  return `${DESKTOP_COOKIE}=${exp}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/desktop; Max-Age=${DESKTOP_COOKIE_MAX_AGE_S}`;
}

// POST /desktop/__verify {token} -> 200 + Set-Cookie when the token is a
// valid QwenPaw session, 401 when it is not. The token is checked against
// the origin and never logged or stored.
async function desktopVerify(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }
  let token = "";
  try {
    const body = await request.json();
    if (typeof body?.token === "string") token = body.token;
  } catch { /* bad JSON -> 400 below */ }
  if (!token || token.length > 4096) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  let res;
  try {
    res = await fetch(ORIGIN + "/api/healthz", {
      method: "GET",
      headers: { Authorization: "Bearer " + token },
    });
  } catch {
    return new Response(JSON.stringify({ ok: false }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  if (res.status === 401) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  if (res.status !== 200) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Set-Cookie": await mintDesktopCookie(env),
    },
  });
}

// Fetch from the desktop origin the way the InstaBox private-port proxy
// requires (fixed 2026-11-15, BUG 1 — the /desktop fallback-to-chat bug):
// the proxy answers ANY request carrying ?_token= with `303 + Set-Cookie:
// __Host-instabox_port_auth` and a relative Location with the token
// stripped. The old code passed that relative Location straight to the
// browser, so the browser left /desktop/* for /vnc.html on the Pages root
// — which the worker proxies to the CONSOLE, whose SPA then shows the chat
// view. Instead this helper:
//   (1) first tries WITHOUT _token, forwarding the browser's cookies (a
//       returning visitor already holds __Host-instabox_port_auth);
//   (2) on 401, retries WITH _token and follows the proxy's 303
//       server-side, re-fetching the clean URL with the 303's Set-Cookie
//       and no _token (max 3 hops);
//   (3) returns the collected proxy-auth cookies so the caller can pass
//       them through to the browser (Set-Cookie) for later visits.
// A surviving redirect is never handed to the browser as a root-relative
// Location — see the rewrite in desktop() below.
function collectSetCookiePairs(res) {
  const list = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("Set-Cookie") ? [res.headers.get("Set-Cookie")] : []);
  return list.map((c) => c.split(";")[0]).filter(Boolean);
}

async function fetchDesktopOrigin(request, url, env, originUrl, origin, token) {
  const setCookies = [];
  const buildReq = (target, extraCookies) => {
    const req = new Request(target, request);
    req.headers.delete("host");
    req.headers.delete("cf-connecting-ip");
    req.headers.delete("cf-ipcountry");
    req.headers.delete("cf-ray");
    req.headers.delete("cf-visitor");
    req.headers.set("X-Forwarded-Host", url.host);
    req.headers.set("X-Forwarded-Proto", "https");
    if (extraCookies && extraCookies.length) {
      const prev = req.headers.get("Cookie");
      req.headers.set("Cookie", [...(prev ? [prev] : []), ...extraCookies].join("; "));
    }
    return req;
  };

  let target = new URL(originUrl);
  let cookies = [];
  let usedToken = false;
  for (let hop = 0; hop < 4; hop++) {
    let res;
    try {
      res = await fetch(buildReq(target, cookies));
    } catch {
      return { res: null, setCookies };
    }
    if (res.status === 401 && !usedToken) {
      // No usable proxy cookie: retry once with the server-side token.
      usedToken = true;
      target = new URL(originUrl);
      target.searchParams.set("_token", token);
      continue;
    }
    const loc = res.headers.get("Location");
    if (res.status >= 300 && res.status < 400 && loc) {
      cookies = [...cookies, ...collectSetCookiePairs(res)];
      setCookies.push(...collectSetCookiePairs(res));
      let next;
      try {
        next = new URL(loc, target);
      } catch {
        return { res, setCookies };
      }
      if (next.origin !== origin) return { res, setCookies };
      next.searchParams.delete("_token");
      target = next;
      continue;
    }
    return { res, setCookies };
  }
  return { res: null, setCookies };
}

async function desktop(request, url, env, ctx) {
  if (!env.DESKTOP_ORIGIN_TOKEN) {
    return new Response("Desktop is not configured yet.", {
      status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  const path = url.pathname;
  if (path === "/desktop/__verify") {
    return desktopVerify(request, env);
  }

  // Public lease read (no secrets in the answer — the machine-side
  // lease-watcher polls this to mirror the lease into the desktop control
  // file the computer-use MCP proxy honors).
  if (path === "/desktop/__lease") {
    return desktopLeaseRead(env);
  }

  // Sealed screen sessions: the capability in the path IS the auth
  // (scoped, 60-min TTL, generation-checked). No desktop cookie needed.
  if (path.startsWith("/desktop/session/")) {
    return desktopSession(request, url, env, ctx);
  }

  // Everything below needs the desktop session cookie (minted by __verify
  // after a real QwenPaw login) — see the note at the top of this section.
  if (!(await desktopCookieValid(request, env))) {
    return gatePage();
  }

  if (path === "/desktop/__takeover") return desktopTakeover(request, env);
  if (path === "/desktop/__heartbeat") return desktopHeartbeat(request, env);
  if (path === "/desktop/__release") return desktopRelease(request, env);
  if (path === "/desktop/__screen") return desktopScreen(request, env);
  if (path === "/desktop/__status") return desktopStatus(request, url, env);
  if (path === "/desktop/__wake") return desktopWake(request, env);
  if (path === "/desktop/__action") return desktopAction(request, env);

  // The Rakazo-style overlay chrome (desktop-chrome.html, a static asset):
  // header + Take control / Release / "…" menu / Close above the screen
  // iframe. The iframe's source is a sealed session capability URL, never
  // a bare /desktop/vnc.html — the chrome is the only entry point.
  if (path === "/desktop" || path === "/desktop/") {
    if (!env.ASSETS) {
      return new Response("Desktop assets are not bound.", { status: 500 });
    }
    return env.ASSETS.fetch(new Request(url.origin + "/desktop-chrome.html"));
  }

  // Legacy direct /desktop/* asset paths (bare vnc.html etc.) are closed:
  // they bypassed the view/control split (anyone with a cookie could
  // drive). Everything goes through the chrome + session capabilities now.
  return Response.redirect(url.origin + "/desktop", 302);
}

// --- Rakazo-style control lease + sealed screen capability (P0) ---------
// State lives in the DESKTOP_KV binding (bound to both Pages projects):
//   "lease"      -> {leaseId, holder:"user", grantedAt, expiresAt, fence}
//   "generation" -> integer, bumped on every takeover/release so old
//                   capabilities die (Rakazo's bot/computer generations).
// The machine-side lease-watcher (desktop-lease-watcher.service) mirrors
// the lease into /run/user/1000/instabox-control, the file the
// computer-use MCP proxy already honors: while a user holds the lease the
// agent's input tools are refused; on handback they pass again and the
// agent re-reads the screen.
const KV_LEASE_KEY = "lease";
const KV_GENERATION_KEY = "generation";
const KV_LAST_WAKE_KEY = "lastWake";

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function kvRequired(env) {
  if (!env.DESKTOP_KV) {
    return new Response(JSON.stringify({ ok: false, error: "desktop_store_unbound" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return null;
}

async function getLease(env) {
  try {
    return await env.DESKTOP_KV.get(KV_LEASE_KEY, "json");
  } catch {
    return null;
  }
}

function leaseActive(lease) {
  return !!lease && lease.holder === "user" && typeof lease.expiresAt === "number" && lease.expiresAt > Date.now();
}

async function getGeneration(env) {
  try {
    const v = await env.DESKTOP_KV.get(KV_GENERATION_KEY);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function bumpGeneration(env) {
  const gen = (await getGeneration(env)) + 1;
  try {
    await env.DESKTOP_KV.put(KV_GENERATION_KEY, String(gen));
  } catch { /* best effort */ }
  return gen;
}

async function readJsonBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

// GET /desktop/__lease (public) — {holder, leaseId, expiresAt, generation}.
// No secrets: the lease id is a random UUID and only names the holder.
async function desktopLeaseRead(env) {
  const missing = kvRequired(env);
  if (missing) return missing;
  const lease = await getLease(env);
  const gen = await getGeneration(env);
  if (leaseActive(lease)) {
    return jsonResp({ holder: "user", leaseId: lease.leaseId, expiresAt: lease.expiresAt, fence: lease.fence, generation: gen });
  }
  return jsonResp({ holder: "agent", leaseId: null, expiresAt: null, fence: lease?.fence ?? 0, generation: gen });
}

// POST /desktop/__takeover — grant the 90 s lease (atomic-ish: KV has no
// CAS, so read-then-write with an active-lease check; a single user means
// the only race is two of their own tabs, and the 90 s expiry bounds it).
async function desktopTakeover(request, env) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  const missing = kvRequired(env);
  if (missing) return missing;
  const lease = await getLease(env);
  if (leaseActive(lease)) {
    return jsonResp({ ok: false, error: "held", leaseId: lease.leaseId, expiresAt: lease.expiresAt }, 409);
  }
  const now = Date.now();
  const next = {
    leaseId: crypto.randomUUID(),
    holder: "user",
    grantedAt: now,
    expiresAt: now + LEASE_TTL_MS,
    fence: (typeof lease?.fence === "number" ? lease.fence : 0) + 1,
  };
  await env.DESKTOP_KV.put(KV_LEASE_KEY, JSON.stringify(next));
  const gen = await bumpGeneration(env);
  return jsonResp({ ok: true, leaseId: next.leaseId, expiresAt: next.expiresAt, fence: next.fence, generation: gen });
}

// POST /desktop/__heartbeat {leaseId} — extend the lease by 90 s. Only
// the visible page heartbeats (client-side); a hidden tab lapses control
// ~90 s after it was hidden, exactly like Rakazo.
async function desktopHeartbeat(request, env) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  const missing = kvRequired(env);
  if (missing) return missing;
  const body = await readJsonBody(request);
  const lease = await getLease(env);
  if (!leaseActive(lease) || body.leaseId !== lease.leaseId) {
    return jsonResp({ ok: false, error: "no_lease" }, 410);
  }
  lease.expiresAt = Date.now() + LEASE_TTL_MS;
  await env.DESKTOP_KV.put(KV_LEASE_KEY, JSON.stringify(lease));
  return jsonResp({ ok: true, expiresAt: lease.expiresAt });
}

// POST /desktop/__release {leaseId} — end control. The release NAMES the
// lease, so a late release from an old page can never end newer control.
async function desktopRelease(request, env) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  const missing = kvRequired(env);
  if (missing) return missing;
  const body = await readJsonBody(request);
  const lease = await getLease(env);
  if (!lease || body.leaseId !== lease.leaseId) {
    return jsonResp({ ok: false, error: "stale" });
  }
  await env.DESKTOP_KV.delete(KV_LEASE_KEY);
  const gen = await bumpGeneration(env);
  return jsonResp({ ok: true, released: true, generation: gen });
}

// --- Sealed screen capability (AES-256-GCM, WebCrypto) ------------------
// Key: SHA-256 of the desktop origin token (deterministic, no new secret).
// Token: base64url(iv || ciphertext) of JSON {mode, exp, gen, leaseId}.
// Path: /desktop/session/{view|control}/{exp}.{token}
function b64urlEncode(bytes) {
  let s = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function capabilityKey(env) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("capability:" + env.DESKTOP_ORIGIN_TOKEN));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function sealCapability(env, payload) {
  const key = await capabilityKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), 12);
  return b64urlEncode(combined);
}

async function openCapability(env, token) {
  try {
    const key = await capabilityKey(env);
    const combined = b64urlDecode(token);
    if (combined.length < 13) return null;
    const iv = combined.slice(0, 12);
    const ct = combined.slice(12);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    const payload = JSON.parse(new TextDecoder().decode(pt));
    if (!payload || typeof payload !== "object") return null;
    return payload;
  } catch {
    return null;
  }
}

// Full capability check: expiry, mode, generation, and (for control) a
// live lease with the same id. Used on every session request and by the
// WebSocket recheck loop.
async function verifyCapability(env, mode, exp, token) {
  if (!exp || !/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return null;
  if (mode !== "view" && mode !== "control") return null;
  const payload = await openCapability(env, token);
  if (!payload) return null;
  if (payload.mode !== mode || payload.exp !== Number(exp)) return null;
  if (payload.gen !== (await getGeneration(env))) return null;
  if (mode === "control") {
    const lease = await getLease(env);
    if (!leaseActive(lease) || lease.leaseId !== payload.leaseId) return null;
  }
  return payload;
}

// POST /desktop/__screen {mode:"view"|"control", leaseId?} — mint a
// 60-min capability URL for the chrome iframe. Control requires holding
// the lease; view needs only the session cookie.
async function desktopScreen(request, env) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  const missing = kvRequired(env);
  if (missing) return missing;
  const body = await readJsonBody(request);
  const mode = body.mode === "control" ? "control" : "view";
  const gen = await getGeneration(env);
  const exp = Math.floor(Date.now() / 1000) + CAPABILITY_TTL_S;
  if (mode === "control") {
    const lease = await getLease(env);
    if (!leaseActive(lease) || body.leaseId !== lease.leaseId) {
      return jsonResp({ ok: false, error: "no_lease" }, 403);
    }
    const token = await sealCapability(env, { mode, exp, gen, leaseId: lease.leaseId });
    return jsonResp({ ok: true, url: `/desktop/session/control/${exp}.${token}`, expiresAt: exp * 1000 });
  }
  const token = await sealCapability(env, { mode, exp, gen, leaseId: null });
  return jsonResp({ ok: true, url: `/desktop/session/view/${exp}.${token}`, expiresAt: exp * 1000 });
}

// Re-check a live WebSocket's capability every second (Rakazo's
// watchScreenAuthorization): a revoked/expired capability or a lost lease
// closes the socket at once. Best-effort — the 60-min TTL bounds the
// damage if the isolate is evicted. `serverSocket` is the upstream socket.
async function watchCapability(env, mode, exp, token, serverSocket) {
  for (;;) {
    await sleep(1000);
    try {
      if (serverSocket.readyState !== 1) return;
    } catch {
      return;
    }
    const ok = await verifyCapability(env, mode, exp, token);
    if (!ok) {
      try {
        serverSocket.close(1011, "screen capability revoked");
      } catch { /* already closed */ }
      return;
    }
  }
}

// The noVNC shim (Rakazo's injectNovncStorageShim, adapted): injected
// into the proxied vnc.html before it reaches the browser. The iframe is
// same-origin here, but the shim is kept for parity and robustness:
//  - in-memory storage fallback if localStorage/sessionStorage throws;
//  - hide #noVNC_status (it names the origin host) and, in view-only
//    mode, the control bar;
//  - report screen state to the parent via postMessage
//    ({type:"qwenpawScreen", state, detail}) by watching noVNC's status
//    text; accept one parent message ({qwenpawScreenFocus:true}) to focus
//    the canvas after a reconnect;
//  - delete window.VideoDecoder (Android H.264 probe hang), swallow
//    extension script errors.
function novncShimScript(mode) {
  return `<script>
window.__QWENPAW_DESKTOP_MODE = ${JSON.stringify(mode)};
(function () {
  try {
    var probe = window.localStorage.getItem("__qwenpaw_probe__");
  } catch (e) {
    var mem = {};
    var memStore = {
      getItem: function (k) { return k in mem ? mem[k] : null; },
      setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { delete mem[k]; },
      clear: function () { mem = {}; },
      key: function (i) { return Object.keys(mem)[i] || null; },
      get length() { return Object.keys(mem).length; },
    };
    try { Object.defineProperty(window, "localStorage", { value: memStore }); } catch (e2) {}
    try { Object.defineProperty(window, "sessionStorage", { value: memStore }); } catch (e2) {}
  }
  try { delete window.VideoDecoder; } catch (e) {}
  window.addEventListener("error", function (ev) {
    if (ev && ev.filename && ev.filename.indexOf("chrome-extension://") === 0) ev.preventDefault();
  }, true);
  var style = document.createElement("style");
  style.textContent = "#noVNC_status{display:none!important}";
  (document.head || document.documentElement).appendChild(style);
  var lastState = "";
  function stateFromText(t) {
    t = (t || "").toLowerCase();
    if (t.indexOf("connected") !== -1) return "connected";
    if (t.indexOf("connecting") !== -1) return "connecting";
    if (t.indexOf("failed") !== -1 || t.indexOf("error") !== -1) return "failed";
    if (t.indexOf("disconnected") !== -1) return "disconnected";
    return "loading";
  }
  function report() {
    var el = document.getElementById("noVNC_status");
    var text = el ? (el.textContent || "") : "";
    var state = stateFromText(text);
    if (state !== lastState) {
      lastState = state;
      try { window.parent.postMessage({ type: "qwenpawScreen", state: state, detail: text.slice(0, 200) }, window.location.origin); } catch (e) {}
    }
  }
  window.addEventListener("message", function (ev) {
    if (ev.origin !== window.location.origin) return;
    if (ev.data && ev.data.qwenpawScreenFocus) {
      var c = document.getElementById("noVNC_canvas");
      if (c) { try { c.focus(); } catch (e) {} }
    }
  });
  setInterval(report, 500);
  report();
})();
</script>`;
}

// GET /desktop/session/{mode}/{exp}.{token}/... — capability-verified
// proxy to the view-only (6082) or interactive (6081) noVNC origin.
// Verifies the capability on EVERY request; WebSocket upgrades get a
// 1 s recheck loop that closes the socket on revocation.
async function desktopSession(request, url, env, ctx) {
  const missing = kvRequired(env);
  if (missing) return missing;
  const parts = url.pathname.split("/").filter(Boolean);
  // ["desktop","session",mode,"exp.token",...rest]
  if (parts.length < 4) return new Response("Screen link expired.", { status: 403 });
  const mode = parts[2];
  const [exp, token] = (parts[3] || "").split(".");
  const payload = await verifyCapability(env, mode, exp, token);
  if (!payload) {
    return new Response("Screen link expired — open /desktop again for a fresh one.", {
      status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  const isView = mode === "view";
  const origin = isView ? DESKTOP_VIEW_ORIGIN : DESKTOP_ORIGIN;
  const originToken = isView ? env.DESKTOP_VIEW_TOKEN : env.DESKTOP_ORIGIN_TOKEN;
  if (!originToken) {
    return new Response("Desktop is not configured yet.", {
      status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  const rest = parts.slice(4).join("/");
  const originUrl = new URL(origin + "/" + rest + url.search);
  const isVncHtml = rest === "" || rest === "vnc.html" || rest.endsWith("/vnc.html");
  let fetchReq = request;
  if (isVncHtml) {
    // Force an uncompressed fetch so the shim can be injected below.
    fetchReq = new Request(request);
    fetchReq.headers.set("Accept-Encoding", "identity");
  }
  const { res, setCookies } = await fetchDesktopOrigin(fetchReq, url, env, originUrl, origin, originToken);
  if (!res) {
    return new Response("Desktop origin unreachable. Try again in a moment.", {
      status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  if (res.status === 503) return wakingPage(null);
  if (res.status === 401) {
    return new Response("Desktop is temporarily unavailable (origin auth). Try again in a moment.", {
      status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  const headers = new Headers(res.headers);
  // Re-scope any surviving redirect under this session path (never let a
  // root-relative Location escape to the console SPA).
  const loc = headers.get("Location");
  if (loc) {
    let resolved = null;
    try {
      resolved = new URL(loc, origin);
    } catch {
      resolved = null;
    }
    if (resolved && resolved.origin === origin) {
      headers.set("Location", url.origin + "/desktop/session/" + mode + "/" + exp + "." + token + resolved.pathname + resolved.search + resolved.hash);
    } else {
      headers.delete("Location");
    }
  }
  const resSetCookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (headers.get("Set-Cookie") ? [headers.get("Set-Cookie")] : []);
  const allCookies = [...resSetCookies, ...setCookies];
  if (allCookies.length) {
    headers.delete("Set-Cookie");
    const seen = new Set();
    for (const c of allCookies) {
      const clean = c.replace(/;\s*domain=[^;]+/gi, "");
      const name = clean.split("=")[0];
      if (seen.has(name)) continue;
      seen.add(name);
      headers.append("Set-Cookie", clean);
    }
  }
  const contentType = headers.get("Content-Type") || "";
  if (contentType.includes("text/html")) {
    headers.set("X-Frame-Options", "SAMEORIGIN");
    headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  }
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");

  if (res.status === 101 && res.webSocket) {
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(watchCapability(env, mode, exp, token, res.webSocket));
    }
    return new Response(null, { status: 101, headers, webSocket: res.webSocket });
  }

  // Shim injection for the noVNC page (uncompressed fetch above).
  if (isVncHtml && contentType.includes("text/html")) {
    let html = "";
    try {
      html = await res.text();
    } catch {
      html = "";
    }
    if (html) {
      const shim = novncShimScript(mode);
      // In view-only mode the noVNC control bar is hidden by an extra
      // <style> (kept out of the JS shim so the two modes are visibly
      // different in the served HTML).
      const viewStyle = isView ? `<style>#noVNC_control_bar_anchor{display:none!important}</style>` : "";
      const withShim = html.includes("<head>")
        ? html.replace("<head>", "<head>" + shim + viewStyle)
        : html.includes("</head>")
          ? html.replace("</head>", shim + viewStyle + "</head>")
          : shim + viewStyle + html;
      headers.set("Cache-Control", "no-store, no-transform");
      headers.delete("ETag");
      headers.delete("Last-Modified");
      return new Response(withShim, { status: res.status, statusText: res.statusText, headers });
    }
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// GET /desktop/__status — desktop + machine state for the chrome page.
// Probes the view origin directly (200 = live desktop, 503 = waking,
// fetch error = asleep/down) and reads the keep-alive Worker's cached
// machine status for the machine side.
async function desktopStatus(request, url, env) {
  if (request.method !== "GET") return jsonResp({ ok: false, error: "method" }, 405);
  let desktop = "unknown";
  try {
    const probeUrl = new URL(DESKTOP_VIEW_ORIGIN + "/");
    const { res } = await fetchDesktopOrigin(
      new Request(probeUrl, { method: "GET", headers: { "Accept-Encoding": "identity" } }),
      url, env, probeUrl, DESKTOP_VIEW_ORIGIN, env.DESKTOP_VIEW_TOKEN || "",
    );
    if (res) {
      if (res.status === 200) desktop = "up";
      else if (res.status === 503) desktop = "waking";
      else if (res.status === 401) desktop = "origin_auth";
      else desktop = "down";
      try { await res.body?.cancel().catch(() => {}); } catch { /* ignore */ }
    } else {
      desktop = "asleep";
    }
  } catch {
    desktop = "asleep";
  }
  let machine = "unknown";
  try {
    const r = await fetch(KEEPALIVE_URL + "/status", { signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null);
    if (j && typeof j.status === "string") machine = j.status;
  } catch { /* keep unknown */ }
  const lease = await getLease(env).catch(() => null);
  const gen = await getGeneration(env);
  return jsonResp({
    desktop,
    machine,
    lease: leaseActive(lease) ? { holder: "user", leaseId: lease.leaseId, expiresAt: lease.expiresAt } : { holder: "agent", leaseId: null, expiresAt: null },
    generation: gen,
  });
}

// POST /desktop/__wake — wake a paused machine via the keep-alive
// Worker's public /ping (probing the public console URL wakes a paused
// box by InstaBox design). Throttled to one call per 60 s in KV.
async function desktopWake(request, env) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  const missing = kvRequired(env);
  if (missing) return missing;
  let lastWake = 0;
  try {
    lastWake = Number((await env.DESKTOP_KV.get(KV_LAST_WAKE_KEY)) || 0);
  } catch { /* ignore */ }
  const now = Date.now();
  if (now - lastWake < 60_000) {
    return jsonResp({ ok: false, error: "throttled", retryAfter: Math.ceil((60_000 - (now - lastWake)) / 1000) });
  }
  try {
    await env.DESKTOP_KV.put(KV_LAST_WAKE_KEY, String(now));
  } catch { /* best effort */ }
  try {
    const r = await fetch(KEEPALIVE_URL + "/ping", { signal: AbortSignal.timeout(15000) });
    await r.body?.cancel().catch(() => {});
    return jsonResp({ ok: true, pingStatus: r.status });
  } catch {
    return jsonResp({ ok: false, error: "wake_failed" }, 502);
  }
}

// POST /desktop/__action {action} — maintenance actions from the "…"
// menu. Stop calls the InstaBox desktop API; Recover/Reset/Update have
// no matching InstaBox desktop API action and are reported honestly.
// Requires INSTABOX_API_KEY as a Worker secret — currently UNSET, so
// this returns 503 until the parent sets it (see the report).
async function desktopAction(request, env) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  const body = await readJsonBody(request);
  const action = body.action;
  if (!["stop", "recover", "reset", "update"].includes(action)) {
    return jsonResp({ ok: false, error: "bad_action" }, 400);
  }
  if (!env.INSTABOX_API_KEY) {
    return jsonResp({
      ok: false,
      error: "instabox_api_key_unset",
      note: "Set INSTABOX_API_KEY as a Worker secret on both Pages projects (then redeploy) to enable maintenance actions.",
    }, 503);
  }
  if (action !== "stop") {
    return jsonResp({
      ok: false,
      error: "unsupported",
      note: `The InstaBox desktop API has no "${action}" action (known: status/install/start/takeover/handback/stop).`,
    }, 501);
  }
  let res;
  try {
    res = await fetch(`https://api.instabox.sh/v1/machines/${MACHINE_ID}/desktop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": env.INSTABOX_API_KEY },
      body: JSON.stringify({ action: "stop" }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    return jsonResp({ ok: false, error: "api_unreachable" }, 502);
  }
  const text = await res.text().catch(() => "");
  if (res.status >= 200 && res.status < 300) {
    await bumpGeneration(env).catch(() => {});
    return jsonResp({ ok: true, action: "stop" });
  }
  return jsonResp({ ok: false, error: "api_rejected", httpStatus: res.status, detail: text.slice(0, 200) }, 502);
}
