// QwenPaw reverse proxy — Cloudflare Pages Advanced Mode (_worker.js).
// Root / and everything else is proxied to the QwenPaw console on InstaBox.
// /status (and /status.html) serves the status / wake page from static assets.
// Every proxied visit hits the InstaBox public URL, which counts as activity
// and wakes an auto-paused box; the 5-minute Worker cron is the other keeper.
//
// COMPUTER REMOVED 2026-11-15. This Worker used to carry the whole /desktop
// surface (gate page, noVNC proxy, lease, capabilities, previews, needs-you,
// teach, modes). It was removed deliberately so the computer could be rebuilt
// from Rakazo's design rather than patched further; see features/computer/.
// What remains is exactly the console proxy plus the wake/cooldown handling,
// and that is the entire responsibility of this file.
import { handleComputer } from "./computer/router.js";

const ORIGIN = "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const WAKE_WAIT_MS = 45_000;
const KEEPALIVE_URL = "https://qwenpaw-keepalive.qwenpaw-rohan.workers.dev";
const MACHINE_ID = "m_" + new URL(ORIGIN).hostname.split(".")[0].split("-").slice(1).join("-");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rewrite response headers for the Pages origin.
 *
 * This function was written on 2026-11-15 to close audit finding
 * `proxy-open-redirect-rewrite-gap` (A-6) and to carry the Referrer-Policy
 * half of the `qwenpaw-query-token-leak` fix. The 8,399-line computer
 * removal deleted it as collateral while leaving its call site in `proxy()`,
 * which made this Worker throw a ReferenceError on *every* proxied request —
 * the whole console, not just the computer. Restored here verbatim; the
 * reasoning below is the original.
 */
function rewriteHeaders(res, pagesOrigin) {
  const headers = new Headers(res.headers);
  // Rewrite redirects that point at the origin so the browser stays on Pages.
  // Hardened: the old code only rewrote absolute ORIGIN URLs. A
  // protocol-relative Location (//evil.example/x) or a foreign absolute URL
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
  //
  // Referrer-Policy is part of the qwenpaw-query-token-leak fix: a user can
  // land on a `?token=...` URL (old bookmark, pasted link) and any outbound
  // link click would otherwise send it in the Referer header to a third
  // party. `same-origin` keeps same-origin navigation working and sends
  // nothing cross-origin.
  headers.set("Referrer-Policy", "same-origin");
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

/**
 * The floating "Computer" launcher injected into the console SPA.
 *
 * History, because it explains the shape: the previous version of this script
 * mounted a preview iframe and called `/desktop/__mode`, `/desktop/__status`
 * and `/desktop/__screen` — endpoints that went away with the computer
 * rebuild. It was deleted along with them, leaving `proxy()` calling a
 * function that no longer existed. That is the second ReferenceError this
 * file had, and neither was caught because nothing ever *loaded* the Worker.
 *
 * This version does one small thing: a button that opens the rebuilt
 * `/computer` surface in a 316 px rail beside the chat, which is what the
 * new UI is designed for (`?embed=1` hides its own stage and overlay).
 * Nothing here reaches into the SPA beyond appending a sibling of #root, so
 * React re-renders cannot remove it. Every failure is swallowed: an
 * injection bug must never break the console.
 */
function computerPanelScript() {
  return `<script>
(function () {
  try {
    if (!document.getElementById("root")) return;
    if (document.getElementById("qwenpawComputerBtn")) return;
    var btn = document.createElement("button");
    btn.id = "qwenpawComputerBtn";
    btn.type = "button";
    btn.textContent = "Computer";
    btn.title = "QwenPaw's computer — watch and drive the live desktop";
    btn.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 16px;border-radius:999px;border:1px solid #343945;background:#171a21;color:#e8eaf0;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45);";

    var panel = document.createElement("div");
    panel.id = "qwenpawComputerPanel";
    panel.style.cssText = "position:fixed;top:0;right:0;bottom:0;width:316px;max-width:100vw;z-index:2147483646;background:#0f1115;border-left:1px solid #262a33;display:none;flex-direction:column;box-shadow:-12px 0 32px rgba(0,0,0,.4);";

    var bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:8px;height:44px;padding:0 10px;background:#171a21;border-bottom:1px solid #262a33;color:#e8eaf0;font:600 13px system-ui,sans-serif;flex:none;";
    bar.innerHTML = "<span style='flex:1'>Computer</span>" +
      "<a href='/computer' target='_blank' rel='noopener' style='color:#86efac;text-decoration:none'>Open full</a>" +
      "<button id='qwenpawComputerClose' type='button' aria-label='Close computer' style='background:none;border:none;color:#e8eaf0;font-size:18px;cursor:pointer;padding:4px 8px'>&times;</button>";

    var frame = document.createElement("iframe");
    frame.id = "qwenpawComputerFrame";
    frame.title = "Computer";
    frame.setAttribute("sandbox", "allow-scripts allow-pointer-lock allow-popups allow-same-origin");
    frame.setAttribute("allow", "clipboard-read; clipboard-write");
    frame.style.cssText = "flex:1;width:100%;border:0;background:#000;";
    // Loaded lazily: an iframe created on every console page view would open a
    // screen session nobody asked for, and every one of those is a request.
    panel.appendChild(bar);
    panel.appendChild(frame);
    document.body.appendChild(panel);
    document.body.appendChild(btn);

    var open = false;
    try { open = sessionStorage.getItem("qwenpawComputerOpen") === "1"; } catch (e) {}

    function setOpen(v) {
      open = !!v;
      panel.style.display = open ? "flex" : "none";
      if (open && !frame.getAttribute("src")) frame.setAttribute("src", "/computer?embed=1");
      try { sessionStorage.setItem("qwenpawComputerOpen", open ? "1" : "0"); } catch (e) {}
    }
    btn.addEventListener("click", function () { setOpen(!open); });
    document.getElementById("qwenpawComputerClose").addEventListener("click", function () { setOpen(false); });
    setOpen(open);
  } catch (e) { /* never break the console */ }
})();
</script>`;
}

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

async function proxy(request, url) {
  // --- qwenpaw-query-token-leak mitigation (audit item, fixed 2026-11-15) ---
  // QwenPaw's console accepts the bearer token as `?token=` on EVERY request
  // (`app/auth.py::_extract_token` falls through to the query param; the SPA
  // itself emits `?token=` URLs for file previews). We cannot patch the
  // upstream container, and the SPA depends on the behaviour — so the fix
  // belongs here, at the only hop we control:
  //
  //   1. lift `?token=` into an `Authorization: Bearer` header, and
  //   2. DELETE it from the forwarded URL.
  //
  // The origin still authorizes (it checks the header FIRST), but the token
  // never reaches the InstaBox edge access log, and never appears in a
  // proxied redirect Location or an upstream error body.
  const fwdUrl = new URL(request.url);
  const queryToken = fwdUrl.searchParams.get("token");
  if (queryToken) {
    fwdUrl.searchParams.delete("token");
  }
  const originUrl = ORIGIN + fwdUrl.pathname + fwdUrl.search;
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
    // Apply the lifted token only when the caller did not already send a
    // bearer credential — an explicit header always wins.
    if (queryToken && !req.headers.get("Authorization")) {
      req.headers.set("Authorization", "Bearer " + queryToken);
    }
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

  // Side-panel injection (Rakazo's right bot sidebar, worker-injection
  // way): the QwenPaw console is a React SPA whose HTML the proxy serves.
  // Its CSP is only `frame-ancestors 'self'` — no script-src — so an
  // injected same-origin <script> runs. The script appends a floating
  // "Computer" button + a 316px right sidebar panel (iframe to /desktop)
  // to document.body, OUTSIDE React's #root, so React re-renders can
  // never remove it. Only the SPA index is injected (marker
  // `<div id="root"`); API JSON, SSE streams and assets are untouched.
  // The injection is defensive (try/catch, feature-detect) so a failure
  // can never break the console.
  if (isSafeMethod && res.status === 200 && (headers.get("Content-Type") || "").includes("text/html")) {
    try {
      const html = await res.text();
      if (html.includes('<div id="root"') && html.includes("</body>")) {
        const injected = html.replace("</body>", computerPanelScript() + "</body>");
        headers.set("Cache-Control", "no-store, no-transform");
        headers.delete("ETag");
        headers.delete("Last-Modified");
        headers.delete("Content-Length");
        return new Response(injected, { status: res.status, statusText: res.statusText, headers });
      }
      return new Response(html, { status: res.status, statusText: res.statusText, headers });
    } catch {
      // The origin body could not be read (it may now be consumed) —
      // do not return a broken stream.
      return new Response("QwenPaw console temporarily unavailable. Try again in a moment.", {
        status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
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

    // Computer (rebuilt from Rakazo's design, 2026-11-15). Everything under
    // /computer is its own surface; the console proxy below is untouched.
    if (path === "/computer" || path.startsWith("/computer/")) {
      try {
        return await handleComputer(request, env, url);
      } catch (err) {
        return new Response(JSON.stringify({ error: "computer_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    return proxy(request, url);
  },
};
