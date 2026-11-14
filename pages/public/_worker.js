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
  async fetch(request, env) {
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
      return desktop(request, url, env);
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

async function desktop(request, url, env) {
  if (!env.DESKTOP_ORIGIN_TOKEN) {
    return new Response("Desktop is not configured yet.", {
      status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  const path = url.pathname;
  if (path === "/desktop/__verify") {
    return desktopVerify(request, env);
  }

  // Session gate: a valid HMAC desktop cookie (minted by __verify after a
  // real QwenPaw login) is the only proof accepted here — see the note at
  // the top of this section for why a Cookie->healthz probe cannot work.
  if (!(await desktopCookieValid(request, env))) {
    return gatePage();
  }

  if (path === "/desktop" || path === "/desktop/") {
    return Response.redirect(
      url.origin + "/desktop/vnc.html?autoconnect=true&resize=scale&reconnect=true", 302,
    );
  }

  // Strip the /desktop prefix; the origin token is added server-side only
  // (query param on the server-to-server fetch — never in the browser URL).
  const stripped = path.slice("/desktop".length) || "/";
  const originUrl = new URL(DESKTOP_ORIGIN + stripped + url.search);
  originUrl.searchParams.set("_token", env.DESKTOP_ORIGIN_TOKEN);

  let res;
  try {
    const req = new Request(originUrl, request);
    req.headers.delete("host");
    req.headers.delete("cf-connecting-ip");
    req.headers.delete("cf-ipcountry");
    req.headers.delete("cf-ray");
    req.headers.delete("cf-visitor");
    req.headers.set("X-Forwarded-Host", url.host);
    req.headers.set("X-Forwarded-Proto", "https");
    res = await fetch(req);
  } catch {
    return new Response("Desktop origin unreachable. Try again in a moment.", {
      status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  // The machine is waking (503 from the InstaBox proxy): show the waking
  // page rather than a bare error.
  if (res.status === 503) {
    return wakingPage(null);
  }

  // The private port answers 401 when its token is wrong — that is a server
  // misconfiguration, never the visitor's fault; say so plainly.
  if (res.status === 401) {
    return new Response("Desktop is temporarily unavailable (origin auth). Try again in a moment.", {
      status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  const headers = new Headers(res.headers);
  // Keep the desktop on our own domain: rewrite redirects that point at the
  // desktop origin to /desktop/*, drop foreign redirects entirely.
  const loc = headers.get("Location");
  if (loc) {
    if (loc.startsWith(DESKTOP_ORIGIN)) {
      headers.set("Location", url.origin + "/desktop" + loc.slice(DESKTOP_ORIGIN.length));
    } else if (loc.startsWith("//")) {
      try {
        const u = new URL("https:" + loc);
        if (u.origin === DESKTOP_ORIGIN) {
          headers.set("Location", url.origin + "/desktop" + u.pathname + u.search + u.hash);
        } else {
          headers.delete("Location");
        }
      } catch {
        headers.delete("Location");
      }
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(loc)) {
      headers.delete("Location");
    }
  }
  // Strip any Domain= on cookies so they become host-only for our domain.
  const setCookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (headers.get("Set-Cookie") ? [headers.get("Set-Cookie")] : []);
  if (setCookies.length) {
    headers.delete("Set-Cookie");
    for (const c of setCookies) {
      headers.append("Set-Cookie", c.replace(/;\s*domain=[^;]+/gi, ""));
    }
  }
  // Desktop HTML may be embedded in the console (same origin) later; allow
  // same-origin framing, block everyone else.
  const contentType = headers.get("Content-Type") || "";
  if (contentType.includes("text/html")) {
    headers.set("X-Frame-Options", "SAMEORIGIN");
    headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  }
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");

  if (res.status === 101 && res.webSocket) {
    return new Response(null, { status: 101, headers, webSocket: res.webSocket });
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
