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
// Terminal: websockify on port 6083 (private publish) relaying to the
// Python PTY server on the machine. Its token is the Worker secret
// DESKTOP_TERMINAL_TOKEN. The terminal is control-only: it is only ever
// served behind a "terminal" capability, which requires holding the
// control lease (see verifyCapability).
const DESKTOP_TERMINAL_ORIGIN = "https://6083-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
// Private (per-agent) second display :2 for the QA agent. 6084 = view-only
// noVNC, 6085 = interactive noVNC. Tokens: DESKTOP_QA_VIEW_TOKEN /
// DESKTOP_QA_ORIGIN_TOKEN (Worker secrets, both projects).
const DESKTOP_QA_VIEW_ORIGIN = "https://6084-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const DESKTOP_QA_ORIGIN = "https://6085-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
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
// How long a control/terminal capability may outlive its lease. The lease is
// renewed every 15 s and lives 90 s, so +30 s covers a heartbeat that lands a
// moment late without ever letting a capability survive a real release
// (BUGS.md B-4: a terminal capability used to keep a root shell alive for a
// full hour after control was handed back).
const LEASE_CAP_GRACE_S = 30;

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
  //
  // Referrer-Policy is part of the qwenpaw-query-token-leak fix: a user can
  // land on a `?token=*** URL (old bookmark, pasted link) and any outbound link
  // click would otherwise send it in the Referer header to a third party.
  // `same-origin` keeps same-origin navigation working and sends nothing
  // cross-origin.
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
        const injected = html.replace("</body>", consolePanelScript() + "</body>");
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

// --- Console side panel (injected into the SPA HTML by proxy()) ---------
// Floating "Computer" button (bottom-right) + a 316px right sidebar panel
// with the /desktop chrome in an iframe. Same origin as the console, so
// the panel iframe is allowed by frame-ancestors 'self'. The panel is
// collapsed by default; its open/closed state lives in sessionStorage.
// Everything is DOM-level (document.body), outside React's #root.
function consolePanelScript() {
  // Rakazo-style side-panel preview (port of ComputerPreview in
  // apps/web/src/pages/shell/computer-panel.tsx): a 16:10 preview iframe
  // (view-only, pointerEvents none) with an "Open in full window" pill on
  // hover — NOT the whole /desktop chrome squeezed into 316 px (the old
  // panel mounted a second full screen session alongside the overlay).
  // Idle computers show "Asleep" + Wake (a click on the preview never
  // boots — a boot costs run time, so only the button wakes). Errors show
  // text + Retry; the preview iframe is only re-minted on Retry/Wake, so
  // it never flickers.
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
    panel.style.cssText = "position:fixed;top:0;right:0;bottom:0;width:316px;z-index:2147483646;background:#0f1115;border-left:1px solid #262a33;display:none;flex-direction:column;box-shadow:-12px 0 32px rgba(0,0,0,.4);";
    var bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:8px;height:44px;padding:0 10px;background:#171a21;border-bottom:1px solid #262a33;color:#e8eaf0;font:600 13px system-ui,sans-serif;flex:none;";
    bar.innerHTML = "<span style='flex:1'>Computer</span><a href='/desktop' target='_blank' style='color:#86efac;text-decoration:none'>Open full</a><button id='qwenpawComputerClose' type='button' style='background:none;border:none;color:#e8eaf0;font-size:18px;cursor:pointer;padding:4px 8px'>&times;</button>";
    var body = document.createElement("div");
    body.style.cssText = "padding:12px;overflow:auto;flex:1;color:#e8eaf0;font:13px system-ui,sans-serif;";
    // 16:10 preview area (Rakazo's ComputerPreview): the frame fills it;
    // the status text only shows while there is no frame to show.
    var preview = document.createElement("div");
    preview.id = "qwenpawComputerPreview";
    preview.style.cssText = "position:relative;aspect-ratio:16/10;border-radius:14px;overflow:hidden;background:#000;border:1px solid #262a33;";
    var status = document.createElement("div");
    status.id = "qwenpawComputerPreviewStatus";
    status.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;text-align:center;padding:12px;color:#9aa3b2;background:#000;";
    var openPill = document.createElement("button");
    openPill.id = "qwenpawComputerOpenPill";
    openPill.type = "button";
    openPill.textContent = "Open in full window";
    openPill.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(15,17,21,.4);opacity:0;transition:opacity .15s;border:0;cursor:pointer;";
    openPill.innerHTML = "<span style='display:inline-flex;gap:8px;align-items:center;border-radius:999px;background:#171a21;color:#e8eaf0;padding:8px 14px;font:600 13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5)'>Open in full window</span>";
    preview.appendChild(status);
    preview.appendChild(openPill);
    var note = document.createElement("div");
    note.style.cssText = "margin-top:10px;color:#9aa3b2;";
    note.textContent = "Bot screen preview — watch only. Take control from the full computer view.";
    body.appendChild(preview);
    body.appendChild(note);
    panel.appendChild(bar);
    panel.appendChild(body);
    document.body.appendChild(panel);
    document.body.appendChild(btn);
    var open = sessionStorage.getItem("qwenpawComputerOpen") === "1";
    function setOpen(v) {
      panel.style.display = v ? "flex" : "none";
      try { sessionStorage.setItem("qwenpawComputerOpen", v ? "1" : "0"); } catch (e) {}
      if (v) loadPreview();
    }
    btn.addEventListener("click", function () { setOpen(true); });
    document.getElementById("qwenpawComputerClose").addEventListener("click", function () { setOpen(false); });
    openPill.addEventListener("click", function () { window.open("/desktop", "_blank"); });
    preview.addEventListener("mouseenter", function () { openPill.style.opacity = "1"; });
    preview.addEventListener("mouseleave", function () { openPill.style.opacity = "0"; });
    openPill.addEventListener("focus", function () { openPill.style.opacity = "1"; });
    openPill.addEventListener("blur", function () { openPill.style.opacity = "0"; });
    var frame = null, computer = "default", loading = false;
    function setStatus(html) {
      status.innerHTML = html;
      status.style.display = "flex";
      openPill.style.display = "none";
    }
    function showFrame() {
      status.style.display = "none";
      openPill.style.display = "flex";
    }
    function vncUrl(capPath) {
      var path = capPath.replace(/^\\//, "") + "/websockify";
      return capPath + "/vnc.html?autoconnect=true&resize=scale&view_only=true&path=" + encodeURIComponent(path);
    }
    async function api(path, method, body) {
      var r = await fetch(path, { method: method || "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      var j = null;
      try { j = await r.json(); } catch (e) {}
      return { status: r.status, json: j || {} };
    }
    async function loadPreview() {
      if (loading) return;
      loading = true;
      try {
        var m = await api("/desktop/__mode?agent=default", "GET");
        if (m.status === 200 && m.json.mode) computer = m.json.mode === "private" ? "qa" : "default";
        var s = await api("/desktop/__status?computer=" + computer, "GET");
        if (s.status !== 200) { setStatus("Could not reach the desktop.<br><br><button data-act='retry' style='padding:7px 12px;border-radius:8px;border:1px solid #343945;background:#23272f;color:#e8eaf0;cursor:pointer'>Retry</button>"); return; }
        if (s.json.desktop === "waking") { setStatus("Booting live desktop…"); setTimeout(loadPreview, 5000); return; }
        if (s.json.desktop !== "up") {
          setStatus("Computer is asleep.<br><br><button data-act='wake' style='padding:7px 12px;border-radius:8px;border:1px solid #22c55e;background:#22c55e;color:#06210f;font-weight:650;cursor:pointer'>Wake</button>");
          return;
        }
        var mint = await api("/desktop/__screen", "POST", { mode: "view", computer: computer });
        if (mint.status !== 200 || !mint.json.url) {
          if (mint.status === 401 || mint.status === 403) { setStatus("Open the computer once to watch it — <a href='/desktop' target='_blank' style='color:#86efac'>/desktop</a>."); return; }
          setStatus("Screen not connected.<br><br><button data-act='retry' style='padding:7px 12px;border-radius:8px;border:1px solid #343945;background:#23272f;color:#e8eaf0;cursor:pointer'>Retry screen</button>");
          return;
        }
        if (frame) { try { frame.remove(); } catch (e) {} frame = null; }
        frame = document.createElement("iframe");
        frame.title = "Bot screen preview";
        frame.src = vncUrl(mint.json.url);
        frame.setAttribute("sandbox", "allow-scripts allow-pointer-lock");
        frame.setAttribute("allow", "clipboard-read; clipboard-write");
        frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;pointer-events:none;";
        preview.insertBefore(frame, status);
        // "Connecting…" stays visible until the frame reports connected —
        // the pill only appears once there is a live screen to open.
        setStatus("Connecting…");
      } finally {
        loading = false;
      }
    }
    status.addEventListener("click", async function (ev) {
      var act = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-act");
      if (act === "retry") loadPreview();
      if (act === "wake") {
        setStatus("Booting live desktop…");
        await api("/desktop/__wake", "POST", { computer: computer });
        setTimeout(loadPreview, 5000);
      }
    });
    window.addEventListener("message", function (ev) {
      if (!frame || ev.source !== frame.contentWindow) return;
      var d = ev.data || {};
      if (d.type === "qwenpawScreen" && d.state === "connected") {
        showFrame();
      } else if (d.type === "qwenpawScreen" && (d.state === "failed" || d.state === "disconnected")) {
        setStatus("Screen not connected.<br><br><button data-act='retry' style='padding:7px 12px;border-radius:8px;border:1px solid #343945;background:#23272f;color:#e8eaf0;cursor:pointer'>Retry screen</button>");
      }
    });
    setOpen(open);
  } catch (e) { /* never break the console */ }
})();
</script>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    env = { ...env, DESKTOP_KV: createStore(env, env.DESKTOP_KV) };
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
//   (1) NEVER forwards the browser's Cookie header (fixed 2026-11-15,
//       fix round 2 — the stream 502s). The origin needs no browser
//       cookies, and the browser holds exactly ONE __Host-instabox_port_auth
//       value — the one minted for whichever origin was fetched first
//       (view 6082, control 6081, terminal 6083, qa 6084/6085). The proxy
//       honors the FIRST such cookie it sees, so a stale per-port cookie
//       forwarded first made every later fetch to a DIFFERENT origin 401:
//       the stream 502'd right after the first successful control session
//       and Private (:2) never rendered. The proxy-auth cookie is managed
//       by the Worker, per origin, and never leaves the Worker (see (3)).
//   (2) fetches with `redirect: "manual"` (fixed 2026-11-15, fix round
//       2). Workers fetch() follows redirects by default, so the proxy's
//       303 was auto-followed and this code NEVER saw it — the
//       auto-followed follow-up carried no cookie (Workers fetch has no
//       cookie jar), so it 401'd and the caller reported "origin_auth"
//       while the desktop was in fact up. With manual redirect handling
//       the code sees the 303, takes its Set-Cookie, and re-fetches the
//       clean URL with that cookie (max 3 hops). On 401 (no usable
//       cookie) it retries once WITH _token.
//   (3) the collected proxy-auth cookies are kept server-side only —
//       they are NOT passed through to the browser. The browser never
//       talks to the origin directly (every origin request goes through
//       this Worker), so a browser-held __Host-instabox_port_auth value
//       could only poison later fetches (see (1)).
// A surviving redirect is never handed to the browser as a root-relative
// Location — see the rewrite in desktop() below.
function collectSetCookiePairs(res) {
  const list = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("Set-Cookie") ? [res.headers.get("Set-Cookie")] : []);
  return list.map((c) => c.split(";")[0]).filter(Boolean);
}

async function fetchDesktopOrigin(request, url, env, originUrl, origin, token) {
  const buildReq = (target, extraCookies) => {
    const req = new Request(target, request);
    req.headers.delete("host");
    req.headers.delete("cf-connecting-ip");
    req.headers.delete("cf-ipcountry");
    req.headers.delete("cf-ray");
    req.headers.delete("cf-visitor");
    // Drop the browser's cookies outright (see (1) above): the origin
    // needs none of them, and a stale __Host-instabox_port_auth for
    // another port would be honored first by the proxy and 401 the fetch.
    req.headers.delete("Cookie");
    req.headers.set("X-Forwarded-Host", url.host);
    req.headers.set("X-Forwarded-Proto", "https");
    if (extraCookies && extraCookies.length) {
      // Only the Worker's own collected proxy-auth cookies, for THIS
      // origin — never the browser's jar.
      req.headers.set("Cookie", extraCookies.join("; "));
    }
    return req;
  };

  let target = new URL(originUrl);
  let cookies = [];
  let usedToken = false;
  for (let hop = 0; hop < 4; hop++) {
    // One retry per hop on a thrown subrequest (transient proxy / Worker /
    // network blip). Without this, a single blip made the desktop look
    // "asleep" and the screen probe 502 — the parent saw exactly that.
    // All callers are GETs / WS upgrades (no request body to re-send).
    let res;
    let threw = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // redirect: "manual" (see (2) above): the proxy's 303 must reach
        // this code, not be auto-followed without its Set-Cookie.
        res = await fetch(buildReq(target, cookies), { redirect: "manual" });
        threw = false;
        break;
      } catch {
        await sleep(150);
      }
    }
    if (threw) return { res: null };
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
    return desktopLeaseRead(request, env);
  }

  // Sealed screen sessions: the capability in the path IS the auth
  // (scoped, 60-min TTL, generation-checked). No desktop cookie needed.
  if (path.startsWith("/desktop/session/")) {
    return desktopSession(request, url, env, ctx);
  }

  // Vendored terminal client (xterm.js + xterm.css, public library files
  // in pages/public/vendor/). Served from the ASSETS binding — no cookie
  // needed, they are just a JS library.
  if (path === "/desktop/vendor/xterm.js" || path === "/desktop/vendor/xterm.css") {
    if (!env.ASSETS) return new Response("Desktop assets are not bound.", { status: 500 });
    const assetPath = path.replace("/desktop/vendor/", "/vendor/");
    const res = await env.ASSETS.fetch(new Request(url.origin + assetPath));
    if (res.status === 404) return new Response("Not found.", { status: 404 });
    return new Response(res.body, {
      status: res.status,
      headers: {
        "Content-Type": path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // Machine-side sync-token routes (no desktop cookie — the bridge and
  // the lease-watcher call these with X-Desktop-Sync, not a cookie).
  // The sync token is checked inside each handler; without it they 401.
  if (path === "/desktop/__needs-you" && request.method === "POST") return desktopNeedsYou(request, env);
  if (path === "/desktop/__preview-upload") return desktopPreviewUpload(request, env);
  if (path === "/desktop/__pending-skills") return desktopPendingSkills(request, env);
  if (path === "/desktop/__pending-skills/ack") return desktopPendingSkillsAck(request, env);

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
  if (path === "/desktop/__needs-you") return desktopNeedsYou(request, env);
  if (path === "/desktop/__needs-you/resolve") return desktopNeedsYouResolve(request, env);
  if (path === "/desktop/__preview") return desktopPreview(request, env);
  if (path === "/desktop/__teach") return desktopTeach(request, env);
  if (path === "/desktop/__mode") return desktopMode(request, env);

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

// --- D1 store (inlined from features/storage/store.js) ----------------
// Canonical copy: features/storage/store.js (harness-tested there).
// Pages _worker.js and the API-uploaded standalone Workers are single
// files with no bundler, so the store is inlined here; keep the two in
// sync. D1 when env.USE_D1 === "1" and env.QWENPAW_DB is bound,
// otherwise the KV binding — same get/put/delete/list interface.
// D1-backed store with a KV-shaped interface.
//
// createStore(env, kv) returns { get, put, delete, list } with the same
// shapes the Workers already use against a KVNamespace, so call sites
// change only the binding source (env.DESKTOP_KV / env.STATUS ->
// store(env)) and no handler logic changes.
//
// Backend selection: D1 when env.USE_D1 === "1" AND env.QWENPAW_DB is
// bound; otherwise the KV namespace passed in (the fallback). The
// routing table is features/storage/SCHEMA.md.
//
// Notes:
// - Previews are base64 strings at this interface (call sites
//   unchanged); the store decodes to raw bytes for the D1 BLOB column
//   and encodes back on read.
// - routines:history put is a DIFF, not a full replace: the caller
//   only ever appends one tick, so the store inserts the entries
//   newer than the stored max `at` and prunes to 50 rows. A full
//   replace would be 51 statements for a 50-entry history and would
//   exceed D1's 50-queries-per-invocation free limit.
// - routines:pending reads enforce expiry (D1 has no TTL): rows with
//   expires_at <= now are treated as missing and deleted lazily.
// - Unknown keys fall through to the `meta` table (plain text), so a
//   future key works without a schema change.
// - The budget counter is a plain upsert of the value the guard
//   computed (the guard already bounds flushes); an atomic SQL
//   increment is a follow-up (see SCHEMA.md).

function createStore(env, kv) {
  const useD1 = env && env.USE_D1 === "1" && env.QWENPAW_DB;
  if (!useD1) {
    // No store at all (KV unbound and no D1): return null so callers
    // that check for a bound store keep their 503 path.
    if (!kv) return null;
    return kvStore(kv);
  }
  return d1Store(env.QWENPAW_DB);
}

function kvStore(kv) {
  return {
    get: async (key, type) => {
      const v = await kv.get(key);
      if (type === "json") {
        if (v === null || v === undefined) return null;
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    put: (key, value, opts) => kv.put(key, value, opts),
    delete: (key) => kv.delete(key),
    list: (opts) => kv.list(opts),
  };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function splitKey(key) {
  const i = key.indexOf(":");
  return i === -1 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
}

function d1Store(db) {
  const q = (sql, ...params) => db.prepare(sql).bind(...params);
  async function get(key, type) {
    const v = await getText(key);
    if (type === "json") {
      if (v === null || v === undefined) return null;
      try { return JSON.parse(v); } catch { return null; }
    }
    return v;
  }

  async function getText(key) {
    const [head, rest] = splitKey(key);
    if (head === "lease") {
      const row = await q("SELECT lease_id, holder, granted_at, expires_at, fence FROM leases WHERE computer = ?", rest).first();
      return row ? JSON.stringify({ leaseId: row.lease_id, holder: row.holder, grantedAt: row.granted_at, expiresAt: row.expires_at, fence: row.fence }) : null;
    }
    if (head === "generation") {
      const row = await q("SELECT gen FROM generations WHERE computer = ?", rest).first();
      return row ? String(row.gen) : null;
    }
    if (head === "needsyou") {
      const computer = rest || "default";
      const row = await q("SELECT text, at, run_id FROM needs_you WHERE computer = ?", computer).first();
      return row ? JSON.stringify({ text: row.text, at: row.at, runId: row.run_id }) : null;
    }
    if (head === "preview") {
      const row = await q("SELECT png FROM previews WHERE computer = ?", rest).first();
      return row && row.png ? bytesToB64(row.png) : null;
    }
    if (head === "teach-skill") {
      const row = await q("SELECT payload FROM teach_skills WHERE id = ?", rest).first();
      return row ? row.payload : null;
    }
    if (head === "computerMode") {
      const row = await q("SELECT mode FROM modes WHERE agent = ?", rest).first();
      return row ? row.mode : null;
    }
    if (head === "budget") {
      const row = await q("SELECT count FROM write_budget WHERE day = ?", rest).first();
      return row ? String(row.count) : null;
    }
    if (key === "lastWake" || key === "routines:last-trigger-at") {
      const row = await q("SELECT value FROM meta WHERE key = ?", key).first();
      return row ? row.value : null;
    }
    if (key === "qwenpaw:status") {
      const row = await q("SELECT value FROM status WHERE key = ?", key).first();
      return row ? row.value : null;
    }
    if (key === "routines:history") {
      const res = await q("SELECT raw FROM routines_history ORDER BY id ASC").all();
      const entries = (res.results || []).map((r) => {
        try { return JSON.parse(r.raw); } catch { return null; }
      }).filter(Boolean);
      return JSON.stringify(entries);
    }
    if (key === "routines:definitions") {
      const res = await q("SELECT payload FROM routines_definitions").all();
      const defs = (res.results || []).map((r) => {
        try { return JSON.parse(r.payload); } catch { return null; }
      }).filter(Boolean);
      return JSON.stringify(defs);
    }
    if (head === "routines" && rest.startsWith("pending:")) {
      const id = rest.slice("pending:".length);
      const now = Math.floor(Date.now() / 1000);
      const row = await q("SELECT payload FROM routines_pending WHERE id = ? AND expires_at > ?", id, now).first();
      if (!row) {
        // Lazily drop the expired row (D1 has no TTL).
        await q("DELETE FROM routines_pending WHERE id = ? AND expires_at <= ?", id, now).run();
        return null;
      }
      return row.payload;
    }
    // Unknown key: generic text fallback in meta.
    const row = await q("SELECT value FROM meta WHERE key = ?", key).first();
    return row ? row.value : null;
  }

  async function put(key, value, opts) {
    const [head, rest] = splitKey(key);
    if (head === "lease") {
      const v = typeof value === "string" ? JSON.parse(value) : value;
      await q("INSERT INTO leases (computer, lease_id, holder, granted_at, expires_at, fence) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(computer) DO UPDATE SET lease_id=excluded.lease_id, holder=excluded.holder, granted_at=excluded.granted_at, expires_at=excluded.expires_at, fence=excluded.fence",
        rest, v.leaseId, v.holder, v.grantedAt, v.expiresAt, v.fence || 0).run();
      return;
    }
    if (head === "generation") {
      await q("INSERT INTO generations (computer, gen) VALUES (?, ?) ON CONFLICT(computer) DO UPDATE SET gen=excluded.gen", rest, parseInt(value, 10) || 0).run();
      return;
    }
    if (head === "needsyou") {
      const computer = rest || "default";
      const v = typeof value === "string" ? JSON.parse(value) : value;
      await q("INSERT INTO needs_you (computer, text, at, run_id) VALUES (?, ?, ?, ?) ON CONFLICT(computer) DO UPDATE SET text=excluded.text, at=excluded.at, run_id=excluded.run_id",
        computer, v.text, v.at, v.runId || null).run();
      return;
    }
    if (head === "preview") {
      // value is a base64 string at this interface; store raw bytes.
      const bytes = b64ToBytes(value);
      await q("INSERT INTO previews (computer, png, updated_at) VALUES (?, ?, ?) ON CONFLICT(computer) DO UPDATE SET png=excluded.png, updated_at=excluded.updated_at",
        rest, bytes, new Date().toISOString()).run();
      return;
    }
    if (head === "teach-skill") {
      const v = typeof value === "string" ? JSON.parse(value) : value;
      await q("INSERT INTO teach_skills (id, payload, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at",
        rest, typeof value === "string" ? value : JSON.stringify(value), v.at || new Date().toISOString()).run();
      return;
    }
    if (head === "computerMode") {
      await q("INSERT INTO modes (agent, mode) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET mode=excluded.mode", rest, String(value)).run();
      return;
    }
    if (head === "budget") {
      await q("INSERT INTO write_budget (day, count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET count=excluded.count", rest, parseInt(value, 10) || 0).run();
      return;
    }
    if (key === "lastWake" || key === "routines:last-trigger-at") {
      await q("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(value)).run();
      return;
    }
    if (key === "qwenpaw:status") {
      await q("INSERT INTO status (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, typeof value === "string" ? value : JSON.stringify(value)).run();
      return;
    }
    if (key === "routines:history") {
      const entries = typeof value === "string" ? JSON.parse(value) : value;
      // Diff, not full replace (see the header note): insert only the
      // entries newer than the stored max `at`, then prune to 50.
      const latest = await q("SELECT MAX(at) AS m FROM routines_history").first();
      const maxAt = latest && latest.m ? latest.m : "";
      const fresh = entries.filter((e) => e && e.at && e.at > maxAt);
      if (fresh.length) {
        const stmts = fresh.map((e) => q(
          "INSERT INTO routines_history (at, kind, qwenpaw, http_status, note, active_routines, raw) VALUES (?, ?, ?, ?, ?, ?, ?)",
          e.at, e.kind, e.qwenpaw, e.httpStatus ?? null, e.note ?? null, JSON.stringify(e.activeRoutines || []), JSON.stringify(e)));
        await db.batch(stmts);
      }
      await q("DELETE FROM routines_history WHERE id NOT IN (SELECT id FROM routines_history ORDER BY id DESC LIMIT 50)").run();
      return;
    }
    if (key === "routines:definitions") {
      const defs = typeof value === "string" ? JSON.parse(value) : value;
      const stmts = [q("DELETE FROM routines_definitions")];
      for (const r of defs) stmts.push(q("INSERT INTO routines_definitions (id, payload) VALUES (?, ?)", r.id, JSON.stringify(r)));
      await db.batch(stmts);
      return;
    }
    if (head === "routines" && rest.startsWith("pending:")) {
      const id = rest.slice("pending:".length);
      const ttl = (opts && opts.expirationTtl) || 7 * 86400;
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      await q("INSERT INTO routines_pending (id, payload, expires_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at",
        id, typeof value === "string" ? value : JSON.stringify(value), expiresAt).run();
      return;
    }
    // Unknown key: generic text fallback in meta.
    await q("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(value)).run();
  }

  async function del(key) {
    const [head, rest] = splitKey(key);
    if (head === "lease") { await q("DELETE FROM leases WHERE computer = ?", rest).run(); return; }
    if (head === "generation") { await q("DELETE FROM generations WHERE computer = ?", rest).run(); return; }
    if (head === "needsyou") { await q("DELETE FROM needs_you WHERE computer = ?", rest || "default").run(); return; }
    if (head === "preview") { await q("DELETE FROM previews WHERE computer = ?", rest).run(); return; }
    if (head === "teach-skill") { await q("DELETE FROM teach_skills WHERE id = ?", rest).run(); return; }
    if (head === "computerMode") { await q("DELETE FROM modes WHERE agent = ?", rest).run(); return; }
    if (head === "budget") { await q("DELETE FROM write_budget WHERE day = ?", rest).run(); return; }
    if (key === "lastWake" || key === "routines:last-trigger-at") { await q("DELETE FROM meta WHERE key = ?", key).run(); return; }
    if (key === "qwenpaw:status") { await q("DELETE FROM status WHERE key = ?", key).run(); return; }
    if (key === "routines:history") { await q("DELETE FROM routines_history").run(); return; }
    if (key === "routines:definitions") { await q("DELETE FROM routines_definitions").run(); return; }
    if (head === "routines" && rest.startsWith("pending:")) { await q("DELETE FROM routines_pending WHERE id = ?", rest.slice("pending:".length)).run(); return; }
    await q("DELETE FROM meta WHERE key = ?", key).run();
  }

  async function list(opts) {
    const prefix = (opts && opts.prefix) || "";
    if (prefix === "teach-skill:") {
      const res = await q("SELECT id FROM teach_skills").all();
      return { keys: (res.results || []).map((r) => ({ name: "teach-skill:" + r.id })) };
    }
    if (prefix === "routines:pending:") {
      const now = Math.floor(Date.now() / 1000);
      const res = await q("SELECT id FROM routines_pending WHERE expires_at > ?", now).all();
      return { keys: (res.results || []).map((r) => ({ name: "routines:pending:" + r.id })) };
    }
    const res = await q("SELECT key FROM meta WHERE key LIKE ? || '%'", prefix).all();
    return { keys: (res.results || []).map((r) => ({ name: r.key })) };
  }

  return { get, put, delete: del, list };
}

// --- Rakazo-style control lease + sealed screen capability (P0) ---------
// State lives in the DESKTOP_KV binding (bound to both Pages projects).
// The lease and the generation are PER COMPUTER ("default" = shared :1,
// "qa" = private :2) so a takeover of one computer never blocks the other:
//   "lease:<computer>"      -> {leaseId, holder:"user", grantedAt, expiresAt, fence}
//   "generation:<computer>" -> integer, bumped on every takeover/release so old
//                              capabilities die (Rakazo's bot/computer generations).
// The machine-side lease-watcher (desktop-lease-watcher.service) mirrors
// each lease into its computer's control file (/run/user/1000/instabox-control
// for :1, /run/user/1000/qa/instabox-control for :2), the file the matching
// computer-use MCP proxy already honors: while a user holds the lease the
// agent's input tools are refused; on handback they pass again and the
// agent re-reads the screen.
// (The un-suffixed "lease" / "generation" keys from P0 are legacy and are no
// longer written; they may be deleted from KV.)
const KV_LEASE_KEY = "lease";
const KV_GENERATION_KEY = "generation";
const KV_LAST_WAKE_KEY = "lastWake";

function leaseKey(computer) {
  return KV_LEASE_KEY + ":" + (computer === "qa" ? "qa" : "default");
}

function generationKey(computer) {
  return KV_GENERATION_KEY + ":" + (computer === "qa" ? "qa" : "default");
}

// Normalise a computer value from a request body / query param.
function computerOf(value) {
  return value === "qa" ? "qa" : "default";
}

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

// A KV WRITE that fails must never become a bare Worker 500. Cloudflare's
// free tier allows only 1,000 KV writes/day per account (error 10048:
// "your account has reached the free usage limit for this operation for
// today"), and the lease-watcher's old 15 s preview uploads burned that
// budget by mid-morning — which is why __takeover, __mode and the
// needs-you raise all answered 500 at once on 2026-11-15 while every
// READ (status, lease, frames) kept working. Every user-facing write
// goes through kvTry and answers 503 store_unavailable on failure, so
// the chrome can say so honestly instead of showing a bare "(500)".
// The durable fix for the burn itself is in the lease-watcher: preview
// uploads are change-only with a 180 s floor.
const STORE_UNAVAILABLE_NOTE = "The desktop store refused the write — the free tier's daily write budget is likely spent (it resets daily). Try again later.";
async function kvTry(fn) {
  try { await fn(); return true; } catch { return false; }
}
function storeUnavailable() {
  return jsonResp({ ok: false, error: "store_unavailable", note: STORE_UNAVAILABLE_NOTE }, 503);
}

// --- Daily write-budget guard (KV phase, 2026-11-15) --------------------
// Soft cap 700 writes/day across the account, split per namespace so the
// sum stays under Cloudflare's 1,000/day account cap (shared across ALL
// namespaces) with headroom: DESKTOP_KV 450 (this worker) + STATUS 250
// (keep-alive + routines share one counter key in STATUS). Non-essential
// writes are dropped with an honest 503 once the cap is hit; essential
// writes (user control actions) always proceed.
// Counting is approximate BY DESIGN: KV has no CAS and Worker isolates
// are per-edge, so the stored counter is a lower bound, not an exact
// total. The counter is flushed to KV only when this isolate's local
// count hits a multiple of 25 — never per write and never on a timer
// (a per-minute flush from many isolates would itself burn up to
// 1,440 writes/day and still would not be a global bound). The static
// throttles (60 s heartbeat, 120 s preview floor, change-only status /
// history) are what keep a normal day under budget; this guard is the
// circuit breaker for pathological bursts. In the D1 phase the counter
// becomes one exact SQL row, updated atomically with the write itself.
const BUDGET_CAP = 450;
const BUDGET_FLUSH_EVERY = 25;
const BUDGET_KEY_PREFIX = "budget:";

let budgetLocal = 0; // writes this isolate performed today
let budgetSeeded = 0; // counter value read from KV at isolate start
let budgetSeededForDay = "";

function budgetToday() { return new Date().toISOString().slice(0, 10); }

async function budgetSeed(env) {
  const day = budgetToday();
  if (budgetSeededForDay === day) return;
  budgetLocal = 0; budgetSeeded = 0; budgetSeededForDay = day;
  try {
    const v = await env.DESKTOP_KV.get(BUDGET_KEY_PREFIX + day);
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) budgetSeeded = n;
  } catch { /* ignore — guard degrades to the local count only */ }
}

async function budgetAllowed(env, essential) {
  if (essential) return true;
  await budgetSeed(env);
  return budgetSeeded + budgetLocal < BUDGET_CAP;
}

function budgetNoteWrite(env) {
  // Called after every successful write. Flushes the shared counter only
  // on every 25th local write, so counter writes stay <= total/25.
  // Fire-and-forget: a dropped flush only makes the stored counter
  // staler; the in-memory count still guards this isolate.
  budgetLocal++;
  if (budgetLocal % BUDGET_FLUSH_EVERY !== 0) return;
  const key = BUDGET_KEY_PREFIX + budgetToday();
  // Use the store's ATOMIC increment when available. The old code read the
  // counter, added the batch, and wrote it back — two isolates flushing at
  // once both read N, both wrote N+25, and 25 increments vanished, so the
  // guard under-counted and could let a burst through. On the KV fallback
  // there is no atomic op, so it stays advisory there.
  // Feature-detect: the binding is either the D1 store (has incr) or a raw
  // KV namespace (does not). Never assume the richer interface.
  if (typeof env.DESKTOP_KV.incr === "function") {
    env.DESKTOP_KV.incr(key, BUDGET_FLUSH_EVERY).catch(() => {});
  } else {
    env.DESKTOP_KV.get(key).then((cur) => {
      const n = Number(cur);
      const base = Number.isFinite(n) ? n : 0;
      return env.DESKTOP_KV.put(key, String(base + BUDGET_FLUSH_EVERY));
    }).catch(() => {});
  }
}

// A write through the budget guard. Returns true when the write landed.
// Non-essential writes are refused (false) once the soft cap is hit;
// the caller answers 503 store_unavailable. Essential writes always try.
async function guardedWrite(env, essential, fn) {
  if (!(await budgetAllowed(env, essential))) return false;
  const ok = await kvTry(fn);
  if (ok) budgetNoteWrite(env);
  return ok;
}

async function getLease(env, computer) {
  try {
    return await env.DESKTOP_KV.get(leaseKey(computer), "json");
  } catch {
    return null;
  }
}

function leaseActive(lease) {
  return !!lease && lease.holder === "user" && typeof lease.expiresAt === "number" && lease.expiresAt > Date.now();
}

async function getGeneration(env, computer) {
  try {
    const v = await env.DESKTOP_KV.get(generationKey(computer));
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

// Strict generation read: THROWS on a KV error instead of returning 0.
// Returning 0 on error is wrong for the capability check — a gen-0 cap
// (the private computer before its first takeover) would then verify
// against a dead store, and a gen-9 cap would fail with a false 403.
// Used only by the security-critical paths (mint + verify); the
// informational endpoints keep the lenient getGeneration above.
async function getGenerationStrict(env, computer) {
  const v = await env.DESKTOP_KV.get(generationKey(computer));
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Strict lease read: THROWS on a KV error instead of returning null, so a
// dead store is a retryable 502, never a false "no lease" 403.
async function getLeaseStrict(env, computer) {
  return env.DESKTOP_KV.get(leaseKey(computer), "json");
}

async function bumpGeneration(env, computer) {
  // THROWS unless the new generation was durably stored.
  //
  // History of this function, because it has been wrong three times:
  //   1. original: lenient read (0 on error) + swallowed put + returned gen+1,
  //      so it reported generations that were never written AND could jump
  //      BACKWARDS on a read blip, resurrecting old capabilities.
  //   2. D1 rebuild: strict read, but on a failed put it returned the OLD
  //      stored value. Honest about the number, but callers could not tell
  //      the difference between "bumped to 12" and "could not bump", so a
  //      takeover still answered 200 and old capabilities stayed valid.
  //   3. this version: throw. A caller that cannot bump has NOT completed a
  //      takeover or a release, and the honest answer is 503.
  const stored = await getGenerationStrict(env, computer);
  const gen = stored + 1;
  const ok = await guardedWrite(env, true, () => env.DESKTOP_KV.put(generationKey(computer), String(gen)));
  if (!ok) throw new Error("generation_write_failed");
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

// GET /desktop/__lease?computer=default|qa (public) — {holder, leaseId, expiresAt, generation}.
// No secrets: the lease id is a random UUID and only names the holder.
async function desktopLeaseRead(request, env) {
  const missing = kvRequired(env);
  if (missing) return missing;
  const computer = computerOf(new URL(request.url).searchParams.get("computer"));
  const lease = await getLease(env, computer);
  const gen = await getGeneration(env, computer);
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
  const body = await readJsonBody(request);
  const computer = computerOf(body.computer);
  let lease;
  try {
    lease = await getLeaseStrict(env, computer);
  } catch {
    // A KV read error must not grant a second lease over an existing one
    // (the lenient read returns null on error, which looked like "no
    // lease"). Answer 503; the chrome retries.
    return storeUnavailable();
  }
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
  if (!(await guardedWrite(env, true, () => env.DESKTOP_KV.put(leaseKey(computer), JSON.stringify(next))))) {
    return storeUnavailable();
  }
  // A failed bump must NOT be reported as a successful takeover.
  //
  // Re-applied 2026-11-15 (BUGS.md B-1) — the D1 rebuild had softened this to
  // "omit the generation", which is honest about the number but still answers
  // 200. That is wrong: the whole point of the generation is that a takeover
  // INVALIDATES old capabilities. If the bump did not persist, capabilities
  // minted before this takeover keep verifying — i.e. the old screen keeps
  // control while the chrome believes it just took over. The lease we already
  // wrote expires on its own within 90 s, so answering 503 and letting the
  // chrome retry is clean and truthful.
  let gen;
  try {
    gen = await bumpGeneration(env, computer);
  } catch {
    return storeUnavailable();
  }
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
  const computer = computerOf(body.computer);
  let lease;
  try {
    lease = await getLeaseStrict(env, computer);
  } catch {
    // A KV read error is not a lost lease: 503 keeps control (the chrome
    // retries next tick) instead of 410, which would drop it.
    return storeUnavailable();
  }
  if (!leaseActive(lease) || body.leaseId !== lease.leaseId) {
    return jsonResp({ ok: false, error: "no_lease" }, 410);
  }
  lease.expiresAt = Date.now() + LEASE_TTL_MS;
  // A failed heartbeat write is NOT a lost lease: the lease still exists
  // with its old expiry, so answer 503 (the chrome keeps control and
  // retries next cycle) instead of 410, which would drop control.
  if (!(await guardedWrite(env, true, () => env.DESKTOP_KV.put(leaseKey(computer), JSON.stringify(lease))))) {
    return storeUnavailable();
  }
  return jsonResp({ ok: true, expiresAt: lease.expiresAt });
}

// POST /desktop/__release {leaseId} — end control. The release NAMES the
// lease, so a late release from an old page can never end newer control.
async function desktopRelease(request, env) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  const missing = kvRequired(env);
  if (missing) return missing;
  const body = await readJsonBody(request);
  const computer = computerOf(body.computer);
  let lease;
  try {
    lease = await getLeaseStrict(env, computer);
  } catch {
    // A KV read error is not "already released": 503, so the caller
    // retries instead of assuming the release happened.
    return storeUnavailable();
  }
  if (!lease || body.leaseId !== lease.leaseId) {
    return jsonResp({ ok: false, error: "stale" });
  }
  // A failed delete is self-healing (the lease expires within 90 s), but
  // the release did not happen — say so honestly instead of claiming ok.
  if (!(await guardedWrite(env, true, () => env.DESKTOP_KV.delete(leaseKey(computer))))) {
    return jsonResp({ ok: false, error: "store_unavailable", note: STORE_UNAVAILABLE_NOTE + " The lease expires on its own within ~90 s." }, 503);
  }
  // Same rule as takeover (BUGS.md B-1): the release invalidates old
  // capabilities through the generation, so a release that cannot persist the
  // new generation has not really ended control. The lease row is already
  // gone, so the control file clears regardless — but say so honestly rather
  // than reporting ok for a generation that was never stored.
  let gen;
  try {
    gen = await bumpGeneration(env, computer);
  } catch {
    return jsonResp({
      ok: false,
      error: "store_unavailable",
      note: STORE_UNAVAILABLE_NOTE + " The lease is already released, but old screen links may stay valid for up to an hour — treat control as handed back.",
    }, 503);
  }
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

// Full capability check: expiry, mode, generation, and (for control and
// terminal) a live lease with the same id. Used on every session request
// and by the WebSocket recheck loop. The payload also carries `computer`
// ("default" = shared :1, "qa" = private :2); a capability minted for one
// computer can never open the other.
//
// Generation check (the fix for the parent's "Screen link expired" on
// Team→Private): KV is eventually consistent across edge POPs, so the
// verify read can lag the mint read by one generation. Accept the cap if
// its generation EQUALS the read one, or is exactly ONE NEWER (the read
// is stale by one). A cap OLDER than the current generation is still
// rejected — a release / takeover still kills old caps. On a mismatch,
// re-read once after 250 ms (replication usually lands in that window).
// A KV error THROWS (via the strict reads) so the caller can answer 502
// "try again" instead of a false 403 "link expired".
async function verifyCapability(env, mode, exp, token) {
  if (!exp || !/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return null;
  if (mode !== "view" && mode !== "control" && mode !== "terminal") return null;
  const payload = await openCapability(env, token);
  if (!payload) return null;
  if (payload.mode !== mode || payload.exp !== Number(exp)) return null;
  const computer = computerOf(payload.computer);
  let genOk = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let gen;
    try {
      gen = await getGenerationStrict(env, computer);
    } catch (err) {
      // A KV error is retried once, then propagated (the caller answers
      // 502 "try again", not 403 "link expired").
      if (attempt === 0) { await sleep(200); continue; }
      throw err;
    }
    if (payload.gen === gen || payload.gen === gen + 1) { genOk = true; break; }
    if (attempt === 0) await sleep(250);
  }
  if (!genOk) return null;
  if (mode === "control" || mode === "terminal") {
    let leaseOk = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let lease;
      try {
        lease = await getLeaseStrict(env, computer);
      } catch (err) {
        if (attempt === 0) { await sleep(200); continue; }
        throw err;
      }
      if (leaseActive(lease) && lease.leaseId === payload.leaseId) { leaseOk = true; break; }
      if (attempt === 0) await sleep(250);
    }
    if (!leaseOk) return null;
  }
  return payload;
}

// POST /desktop/__screen {mode:"view"|"control"|"terminal", computer?,
// leaseId?} — mint a 60-min capability URL for the chrome iframe.
// Control and terminal require holding the lease; view needs only the
// session cookie. `computer` is "default" (shared :1) or "qa" (private
// :2); the capability is scoped to it.
async function desktopScreen(request, env) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  const missing = kvRequired(env);
  if (missing) return missing;
  const body = await readJsonBody(request);
  const mode = body.mode === "control" ? "control" : body.mode === "terminal" ? "terminal" : "view";
  const computer = body.computer === "qa" ? "qa" : "default";
  // The generation is read strictly (a KV error is a 500, not a mint
  // with a wrong gen). The chrome may also send the generation it just
  // received from its __takeover / __release response (`gen`); if that is
  // NEWER than the KV read, the KV read is stale and the fresh value wins
  // (a mint right after a takeover must not be born dead). A stale lower
  // client value can never win — Math.max picks the KV value then.
  let gen;
  try {
    gen = await getGenerationStrict(env, computer);
  } catch {
    await sleep(200);
    try {
      gen = await getGenerationStrict(env, computer);
    } catch {
      return jsonResp({ ok: false, error: "kv_unavailable" }, 500);
    }
  }
  // B-9 fix (BUGS.md): accept the client's generation only when it does NOT
  // lead the stored one. The old Math.max let a client choose a FUTURE
  // generation — that self-DoSes every other open screen and, worse, masks a
  // lost bump by making one missing increment invisible. A stale LOWER client
  // value is harmless, so the rule is "may lag, never lead".
  const clientGen = Number(body.gen);
  if (Number.isFinite(clientGen) && clientGen >= 0 && clientGen <= gen) {
    gen = clientGen;
  }
  // B-4 fix (BUGS.md): a capability must never outlive the control it was
  // minted under. A flat 60-min TTL meant a terminal capability minted at
  // second 30 of a 90 s lease kept a ROOT SHELL alive for another 59 minutes
  // after control was handed back. watchCapability() re-checks every second
  // while a socket is open, which bounds the damage — but the URL itself must
  // also stop verifying, and a client that simply reconnects must not get a
  // fresh hour. Clamp to the lease deadline plus a small grace so a heartbeat
  // landing a moment late does not kill a live screen.
  let exp = Math.floor(Date.now() / 1000) + CAPABILITY_TTL_S;
  if (mode === "control" || mode === "terminal") {
    let lease;
    try {
      lease = await getLeaseStrict(env, computer);
    } catch {
      await sleep(200);
      try {
        lease = await getLeaseStrict(env, computer);
      } catch {
        return jsonResp({ ok: false, error: "kv_unavailable" }, 500);
      }
    }
    if (!leaseActive(lease) || body.leaseId !== lease.leaseId) {
      return jsonResp({ ok: false, error: "no_lease" }, 403);
    }
    exp = Math.min(exp, Math.ceil(lease.expiresAt / 1000) + LEASE_CAP_GRACE_S);
    const token = await sealCapability(env, { mode, exp, gen, leaseId: lease.leaseId, computer });
    return jsonResp({ ok: true, url: `/desktop/session/${mode}/${exp}.${token}`, expiresAt: exp * 1000 });
  }
  const token = await sealCapability(env, { mode, exp, gen, leaseId: null, computer });
  return jsonResp({ ok: true, url: `/desktop/session/view/${exp}.${token}`, expiresAt: exp * 1000 });
}

// Re-check a live WebSocket's capability every second (Rakazo's
// watchScreenAuthorization): a revoked/expired capability or a lost lease
// closes the socket. Best-effort — the 60-min TTL bounds the damage if
// the isolate is evicted. `serverSocket` is the upstream socket.
// Two CONSECUTIVE failures are required before closing: a single failed
// recheck is usually a KV blip / replication lag, and the parent watched
// live streams drop on exactly that. A genuine revocation still closes
// within ~2 s.
async function watchCapability(env, mode, exp, token, serverSocket) {
  let failures = 0;
  for (;;) {
    await sleep(1000);
    try {
      if (serverSocket.readyState !== 1) return;
    } catch {
      return;
    }
    let ok = false;
    try {
      ok = !!(await verifyCapability(env, mode, exp, token));
    } catch {
      ok = false; // KV error counts as a failure, not a crash
    }
    if (!ok) {
      failures++;
      if (failures < 2) continue;
      try {
        serverSocket.close(1011, "screen capability revoked");
      } catch { /* already closed */ }
      return;
    }
    failures = 0;
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
  // In-memory storage (port of Rakazo's injectNovncStorageShim in
  // apps/web/src/novnc-html.ts): the proxy sandboxes the screen document
  // without same-origin, so noVNC's settings reads from localStorage throw.
  // Replaced unconditionally, like Rakazo's (with the old probe as a
  // fallback if the define itself throws).
  function memoryStorage() {
    var items = new Map();
    return {
      getItem: function (k) { return items.has(String(k)) ? items.get(String(k)) : null; },
      setItem: function (k, v) { items.set(String(k), String(v)); },
      removeItem: function (k) { items.delete(String(k)); },
      clear: function () { items.clear(); },
    };
  }
  var storagesReplaced = false;
  try {
    Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: memoryStorage() });
    storagesReplaced = true;
  } catch (e) { /* fall through to the probe below */ }
  if (!storagesReplaced) {
    try {
      window.localStorage.getItem("__qwenpaw_probe__");
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
  }
  try { delete window.VideoDecoder; } catch (e) {}
  // Browser-extension script errors must not replace the screen: Rakazo
  // stops them at the source (stopImmediatePropagation) so noVNC's global
  // error handler never sees them. The old code only preventDefaulted,
  // which is weaker.
  window.addEventListener("error", function (ev) {
    if (ev && ev.filename && /^[a-z-]+-extension:/.test(String(ev.filename))) ev.stopImmediatePropagation();
  }, true);
  var style = document.createElement("style");
  style.textContent = "#noVNC_status{display:none!important}";
  (document.head || document.documentElement).appendChild(style);
  // The app cannot look into this sandboxed frame, so tell it how the
  // screen is doing. State comes from noVNC's own CSS classes on <html>
  // (port of Rakazo's sync() in injectNovncStorageShim), NOT from the
  // status bar's text: the text can be empty or stale while the classes
  // always track the connection. A MutationObserver follows them; the old
  // code polled the text every 500 ms and misread it.
  var lastState = "";
  var classed = false;
  function report(state, detail) {
    if (!state || state === lastState) return;
    lastState = state;
    try { window.parent.postMessage(detail ? { type: "qwenpawScreen", state: state, detail: detail } : { type: "qwenpawScreen", state: state }, window.location.origin); } catch (e) {}
  }
  function sync() {
    var root = document.documentElement;
    var status = document.getElementById("noVNC_status");
    // data-rakazo-screen-error is set by Rakazo's own embed page, never by
    // stock noVNC — kept for faithfulness; the status-error classes below
    // are the live path for us.
    var failure = root.getAttribute("data-rakazo-screen-error");
    var statusError = status && status.classList.contains("noVNC_open") && status.classList.contains("noVNC_status_error");
    var connecting = root.classList.contains("noVNC_connecting") || root.classList.contains("noVNC_reconnecting");
    var connected = root.classList.contains("noVNC_connected");
    if (connecting || connected) classed = true;
    var state = connected ? "connected"
      : failure !== null || statusError ? "failed"
      : connecting ? "connecting"
      : classed ? (lastState === "connected" || lastState === "connecting" ? "disconnected" : "")
      : document.querySelector("#screen canvas") ? "connecting" : "";
    report(state, state === "failed" ? (failure || String(status ? (status.textContent || "") : "")) : undefined);
  }
  function observe() {
    sync();
    new MutationObserver(sync).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-rakazo-screen-error"],
      childList: true,
      subtree: true,
    });
  }
  report("loading");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observe);
  else observe();
  window.addEventListener("message", function (ev) {
    if (ev.origin !== window.location.origin) return;
    var d = ev.data || {};
    // A reconnected screen takes the keyboard back when the app asks;
    // nothing else is accepted (Rakazo: exactly one key, from the parent).
    if (d && Object.keys(d).length === 1 && d.qwenpawScreenFocus === true) {
      var c = document.getElementById("noVNC_canvas");
      if (c) { try { c.focus(); } catch (e) {} }
      return;
    }
    // Teach-by-showing (Rakazo's recordTeachingInputEvent): the parent
    // (chrome) turns recording on while the user holds control and is
    // teaching. The shim forwards pointer/key/scroll/clipboard events to
    // the parent as {type:"qwenpawTeachEvent", event}. It never
    // preventDefaults — noVNC still receives every event. While the
    // "sensitive" flag is on, key/clipboard VALUES are never sent (only
    // {kind, sensitive:true}); the parent and the Worker strip them too
    // (see sanitizeTeachRecordingEvent in the Worker).
    if (d && typeof d.qwenpawTeach === "boolean") {
      teachOn = d.qwenpawTeach;
      teachSensitive = !!d.sensitive;
    }
    if (d && typeof d.qwenpawTeachSensitive === "boolean") {
      teachSensitive = d.qwenpawTeachSensitive;
    }
  });
  var teachOn = false, teachSensitive = false, lastMoveAt = 0;
  function teachSend(ev) {
    if (!teachOn) return;
    try { window.parent.postMessage({ type: "qwenpawTeachEvent", event: ev }, window.location.origin); } catch (e) {}
  }
  function teachPoint(kind, type, e) {
    var r = (document.getElementById("noVNC_canvas") || {}).getBoundingClientRect ? document.getElementById("noVNC_canvas").getBoundingClientRect() : null;
    var x = e.clientX, y = e.clientY;
    if (r) { x = Math.round(e.clientX - r.left); y = Math.round(e.clientY - r.top); }
    teachSend({ kind: kind, type: type, x: x, y: y, button: (e.button === 2 ? "right" : e.button === 1 ? "middle" : "left"), at: new Date().toISOString(), sensitive: teachSensitive });
  }
  document.addEventListener("pointerdown", function (e) { teachPoint("pointer", "down", e); }, true);
  document.addEventListener("pointerup", function (e) { teachPoint("pointer", "up", e); }, true);
  document.addEventListener("pointermove", function (e) {
    var now = Date.now();
    if (now - lastMoveAt < 500) return;
    lastMoveAt = now;
    teachPoint("pointer", "move", e);
  }, true);
  document.addEventListener("wheel", function (e) {
    if (!teachOn) return;
    var dir = e.deltaY < 0 ? "up" : "down";
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) dir = e.deltaX < 0 ? "left" : "right";
    teachSend({ kind: "scroll", type: dir, text: "3", at: new Date().toISOString(), sensitive: teachSensitive });
  }, true);
  document.addEventListener("keydown", function (e) {
    if (!teachOn) return;
    if (teachSensitive) { teachSend({ kind: "key", sensitive: true, at: new Date().toISOString() }); return; }
    var k = e.key || "";
    teachSend({ kind: "key", key: k.length > 1 ? k : k, at: new Date().toISOString() });
  }, true);
  document.addEventListener("paste", function (e) {
    if (!teachOn) return;
    if (teachSensitive) { teachSend({ kind: "clipboard", sensitive: true, at: new Date().toISOString() }); return; }
    var t = "";
    try { t = (e.clipboardData || window.clipboardData).getData("text") || ""; } catch (e2) {}
    teachSend({ kind: "clipboard", text: t.slice(0, 500), at: new Date().toISOString() });
  }, true);
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
  let payload;
  try {
    payload = await verifyCapability(env, mode, exp, token);
  } catch {
    // The store itself failed (not a bad link): tell the chrome to retry
    // instead of showing "Screen link expired".
    return new Response("Desktop is temporarily unavailable (capability check). Try again in a moment.", {
      status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  if (!payload) {
    return new Response("Screen link expired — open /desktop again for a fresh one.", {
      status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  const computer = payload.computer === "qa" ? "qa" : "default";
  const isTerminal = mode === "terminal";
  const isView = mode === "view";
  // Origin + token by (mode, computer). The terminal is its own origin
  // (websockify → PTY server) and is control-only by construction:
  // verifyCapability above already required a live lease for it.
  let origin, originToken;
  if (isTerminal) {
    origin = DESKTOP_TERMINAL_ORIGIN;
    originToken = env.DESKTOP_TERMINAL_TOKEN;
  } else if (computer === "qa") {
    origin = isView ? DESKTOP_QA_VIEW_ORIGIN : DESKTOP_QA_ORIGIN;
    originToken = isView ? env.DESKTOP_QA_VIEW_TOKEN : env.DESKTOP_QA_ORIGIN_TOKEN;
  } else {
    origin = isView ? DESKTOP_VIEW_ORIGIN : DESKTOP_ORIGIN;
    originToken = isView ? env.DESKTOP_VIEW_TOKEN : env.DESKTOP_ORIGIN_TOKEN;
  }
  if (!originToken) {
    return new Response("Desktop is not configured yet.", {
      status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  // Status-only probe (port of Rakazo's SCREEN_PROBE_PARAM in
  // packages/core/src/screen-reconnect.ts): the chrome asks whether the
  // screen page is reachable before framing it. Answered right here, after
  // the capability check — 204 when the capability is valid — and never
  // passed to the computer, so the answer can't be a redirect or anything
  // the computer wrote. The old pre-probe fetched the full vnc.html
  // through the proxy (303 dance + full page, then the frame fetched it
  // AGAIN), which is a large part of why first load sat on a black screen
  // for 60-90 s while the desktop stack itself answers in <1 s (measured
  // live: WS+RFB banner 125-731 ms on localhost). This probe is cheap.
  if (url.searchParams.get("qwenpaw_probe") === "1") {
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
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
  const { res } = await fetchDesktopOrigin(fetchReq, url, env, originUrl, origin, originToken);
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
  // Only the FINAL origin response's own Set-Cookie values are passed
  // through — never the proxy-auth cookies collected during the 303
  // dance (those stay server-side; see fetchDesktopOrigin). The
  // __Host-instabox_port_auth name is stripped outright: a browser-held
  // value for one port would poison later fetches to other ports.
  const resSetCookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (headers.get("Set-Cookie") ? [headers.get("Set-Cookie")] : []);
  const safeCookies = resSetCookies.filter(
    (c) => !c.split(";")[0].trim().toLowerCase().startsWith("__host-instabox_port_auth="),
  );
  headers.delete("Set-Cookie");
  for (const c of safeCookies) {
    headers.append("Set-Cookie", c.replace(/;\s*domain=[^;]+/gi, ""));
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

// GET /desktop/__status?computer=default|qa — desktop + machine state
// for the chrome page. Probes the view origin of the REQUESTED computer
// directly (200 = live desktop, 503 = waking, 401 = origin_auth, anything
// else / fetch error = down). A failed probe is "down", NOT "asleep": the
// machine may be perfectly up while the desktop/proxy path is broken, and
// calling that "asleep" told the user to Wake a machine that was already
// awake (the parent watched exactly that). "asleep" is only reported when
// the keep-alive says the machine itself is not up (waking/cooldown/
// conflict) — see the post-processing below. The old version probed only
// :1 and read only the default lease, so the Private view (and the /chat
// side panel, which is the same chrome in an iframe) reported :1's state
// while showing :2 — the parent watched Private say "asleep" minutes
// after waking it.
// `screen` is a best-effort WebSocket liveness probe: after the GET says
// up, upgrade to /websockify and wait for the VNC server's "RFB" banner.
// A 200 GET proves websockify answers; only the banner proves the VNC
// backend behind it is alive. `screen` never changes `desktop` (a flaky
// probe must not flip the page to "asleep"); it is a diagnostic hint.
async function desktopStatus(request, url, env) {
  if (request.method !== "GET") return jsonResp({ ok: false, error: "method" }, 405);
  const computer = computerOf(new URL(request.url).searchParams.get("computer"));
  const viewOrigin = computer === "qa" ? DESKTOP_QA_VIEW_ORIGIN : DESKTOP_VIEW_ORIGIN;
  const viewToken = computer === "qa" ? env.DESKTOP_QA_VIEW_TOKEN : env.DESKTOP_VIEW_TOKEN;
  let desktop = "unknown";
  try {
    const probeUrl = new URL(viewOrigin + "/");
    const { res } = await fetchDesktopOrigin(
      new Request(probeUrl, { method: "GET", headers: { "Accept-Encoding": "identity" } }),
      url, env, probeUrl, viewOrigin, viewToken || "",
    );
    if (res) {
      if (res.status === 200) desktop = "up";
      else if (res.status === 503) desktop = "waking";
      else if (res.status === 401) desktop = "origin_auth";
      else desktop = "down";
      try { await res.body?.cancel().catch(() => {}); } catch { /* ignore */ }
    } else {
      // The probe threw (origin unreachable, proxy down, Worker blip):
      // the desktop path is broken, not the machine — "down", never
      // "asleep" (see the header comment).
      desktop = "down";
    }
  } catch {
    desktop = "down";
  }
  let screen = "unknown";
  if (desktop === "up") {
    screen = await probeScreenRfb(viewOrigin, viewToken || "", url, env);
  }
  let machine = "unknown";
  try {
    const r = await fetch(KEEPALIVE_URL + "/status", { signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => null);
    if (j && typeof j.status === "string") machine = j.status;
  } catch { /* keep unknown */ }
  // Only when the keep-alive says the machine itself is not up does a
  // failed probe become the machine's problem: "waking" while it boots,
  // "asleep" while it is in cooldown/conflict (Wake is the path, and the
  // wake flow reports a refusal honestly). Otherwise the machine is up
  // and the desktop/proxy path is what is down.
  if (desktop === "down") {
    if (machine === "waking") desktop = "waking";
    else if (machine === "cooldown" || machine === "conflict") desktop = "asleep";
  }
  const lease = await getLease(env, computer).catch(() => null);
  const gen = await getGeneration(env, computer);
  return jsonResp({
    desktop,
    screen,
    computer,
    machine,
    lease: leaseActive(lease) ? { holder: "user", leaseId: lease.leaseId, expiresAt: lease.expiresAt } : { holder: "agent", leaseId: null, expiresAt: null },
    generation: gen,
  });
}

// Best-effort screen liveness: WebSocket-upgrade to the origin's
// /websockify and wait for the VNC server's "RFB 003.008" banner.
// Returns "live" only on the banner, "unreachable" otherwise. Never
// throws. The socket is closed immediately after the banner (or timeout).
// The banner wait is 10 s, not 3 s: the handshake rides the same
// InstaBox private-port proxy as the session (401 -> _token -> 303 ->
// cookie -> 101, several sequential round trips), and the live session
// proves that path can take seconds — a 3 s budget made the probe report
// "unreachable" while the real stream rendered fine (T50, 2026-11-15).
// The request also carries Sec-WebSocket-Protocol: binary, exactly like
// noVNC's own handshake, so the probe exercises the same path the frame
// uses.
async function probeScreenRfb(viewOrigin, viewToken, url, env) {
  try {
    const wsUrl = new URL(viewOrigin + "/websockify");
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const { res } = await fetchDesktopOrigin(
      new Request(wsUrl, {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Protocol": "binary",
          "Accept-Encoding": "identity",
        },
      }),
      url, env, wsUrl, viewOrigin, viewToken,
    );
    if (!res || res.status !== 101 || !res.webSocket) return "unreachable";
    const ws = res.webSocket;
    try {
      ws.accept();
    } catch {
      return "unreachable";
    }
    const banner = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 10000);
      const done = (v) => { clearTimeout(timer); resolve(v); };
      try {
        ws.addEventListener("message", (ev) => done(ev.data), { once: true });
        ws.addEventListener("close", () => done(null), { once: true });
        ws.addEventListener("error", () => done(null), { once: true });
      } catch {
        done(null);
      }
    });
    try { ws.close(); } catch { /* ignore */ }
    if (typeof banner === "string") return banner.startsWith("RFB") ? "live" : "unreachable";
    if (banner instanceof ArrayBuffer) {
      return new TextDecoder().decode(banner).startsWith("RFB") ? "live" : "unreachable";
    }
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

// POST /desktop/__wake {computer?} — wake a paused machine via the
// keep-alive Worker's public /ping (probing the public console URL wakes
// a paused box by InstaBox design), then start the desktop itself.
// Throttled to one call per 60 s in KV.
// The old version only pinged the machine: if the desktop process/stack
// was down, Wake could never bring it back — the parent watched "Booting…"
// for ~6 minutes with no screen. Now, when INSTABOX_API_KEY is set, the
// wake also calls the InstaBox desktop `start` API — but only if the :1
// view origin does not already answer (starting an already-running
// desktop is not something to do blindly). The response is honest about
// what happened: desktopStart is "already-running", "started", "failed",
// or "unavailable" (no API key — the Wake then only woke the machine).
// The private (:2) display is systemd-managed on the machine, not by the
// InstaBox desktop API, so for computer=qa the start step reports
// "unavailable" with a note instead of pretending.
async function desktopWake(request, env) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  const missing = kvRequired(env);
  if (missing) return missing;
  const body = await readJsonBody(request);
  const computer = computerOf(body.computer);
  let lastWake = 0;
  try {
    lastWake = Number((await env.DESKTOP_KV.get(KV_LAST_WAKE_KEY)) || 0);
  } catch { /* ignore */ }
  const now = Date.now();
  if (now - lastWake < 60_000) {
    return jsonResp({ ok: false, error: "throttled", retryAfter: Math.ceil((60_000 - (now - lastWake)) / 1000) });
  }
  // Non-essential: if the guard drops it, the wake still proceeds — the
  // 60 s throttle is just temporarily blind for one call.
  await guardedWrite(env, false, () => env.DESKTOP_KV.put(KV_LAST_WAKE_KEY, String(now)));
  let pingStatus = null;
  try {
    const r = await fetch(KEEPALIVE_URL + "/ping", { signal: AbortSignal.timeout(15000) });
    pingStatus = r.status;
    await r.body?.cancel().catch(() => {});
  } catch {
    return jsonResp({ ok: false, error: "wake_failed" }, 502);
  }
  let desktopStart = "unavailable";
  let desktopNote = "";
  if (computer === "qa") {
    desktopNote = "The private display (:2) is managed by systemd on the machine, not by the InstaBox desktop API.";
  } else if (!env.INSTABOX_API_KEY) {
    desktopNote = "INSTABOX_API_KEY is not set as a Worker secret, so Wake only woke the machine — it cannot start the desktop itself.";
  } else {
    // Is the :1 desktop already up? Only start it when it is not.
    let up = false;
    try {
      const probeUrl = new URL(DESKTOP_VIEW_ORIGIN + "/");
      const { res } = await fetchDesktopOrigin(
        new Request(probeUrl, { method: "GET", headers: { "Accept-Encoding": "identity" } }),
        new URL(request.url), env, probeUrl, DESKTOP_VIEW_ORIGIN, env.DESKTOP_VIEW_TOKEN || "",
      );
      up = !!res && res.status === 200;
      try { await res?.body?.cancel().catch(() => {}); } catch { /* ignore */ }
    } catch { up = false; }
    if (up) {
      desktopStart = "already-running";
    } else {
      try {
        const res = await fetch(`https://api.instabox.sh/v1/machines/${MACHINE_ID}/desktop`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": env.INSTABOX_API_KEY },
          body: JSON.stringify({ action: "start", width: 1920, height: 1080 }),
          signal: AbortSignal.timeout(30000),
        });
        await res.text().catch(() => "");
        desktopStart = res.status >= 200 && res.status < 300 ? "started" : "failed";
        if (desktopStart === "failed") desktopNote = `The InstaBox desktop start API answered HTTP ${res.status}.`;
      } catch {
        desktopStart = "failed";
        desktopNote = "The InstaBox desktop start API could not be reached.";
      }
    }
  }
  return jsonResp({ ok: true, pingStatus, desktopStart, desktopNote: desktopNote || undefined, computer });
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
    await bumpGeneration(env, "default").catch(() => {});
    return jsonResp({ ok: true, action: "stop" });
  }
  return jsonResp({ ok: false, error: "api_rejected", httpStatus: res.status, detail: text.slice(0, 200) }, 502);
}

// --- Extension: needs-you, preview, teach-by-showing, mode (P3) --------
// State lives in the same DESKTOP_KV binding:
//   "needsyou:<computer>" -> {text, at, runId?, computer} | null (one open
//                        request PER COMPUTER — the old global "needsyou"
//                        key let the QA agent's raise overwrite the
//                        default agent's, and resolving cleared both.
//                        The legacy global key is still read as a
//                        fallback on the default computer, and the D1
//                        migration copies it to needsyou:default.)
//   "preview:<computer>"  -> base64 PNG of the desktop (600 s TTL,
//                        refreshed by the machine-side lease-watcher
//                        via scrot)
//   "teach-skill:<id>"-> {id, name, goal, playbook, at} (pending delivery
//                        to the QwenPaw skill pool by the lease-watcher)
//   "computerMode:<agent>" -> "team" | "private"
// Machine-side callers (bridge, lease-watcher) authenticate with the
// DESKTOP_SYNC_TOKEN Worker secret (header X-Desktop-Sync). That token is
// generated for this channel (it is NOT an InstaBox or Cloudflare key) and
// is set as a Worker secret on both Pages projects + in the machine's
// /data/home/camoufox/.env and /data/home/mcp-proxy/.env (never in git).
const KV_NEEDSYOU_KEY = "needsyou";

function needsYouKey(computer) {
  return KV_NEEDSYOU_KEY + ":" + (computer === "qa" ? "qa" : "default");
}

const KV_PREVIEW_KEY = "preview";
// Previews are uploaded change-only (at most once per 120 s per
// computer) by the lease-watcher, so the TTL must outlast the upload
// floor — 600 s. The old 60 s TTL paired with unconditional 15 s
// uploads burned the free KV write budget (see the watcher docstring).
const KV_PREVIEW_TTL_S = 600;

function previewKey(computer) {
  return KV_PREVIEW_KEY + ":" + (computer === "qa" ? "qa" : "default");
}
const KV_TEACH_PREFIX = "teach-skill:";
const KV_MODE_PREFIX = "computerMode:";

function syncTokenValid(request, env) {
  if (!env.DESKTOP_SYNC_TOKEN) return false;
  const h = request.headers.get("X-Desktop-Sync");
  if (!h) return false;
  // Constant-time-ish compare (timing-safe compare is not available in
  // Workers; length check first, then a full scan without early exit).
  if (h.length !== env.DESKTOP_SYNC_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ env.DESKTOP_SYNC_TOKEN.charCodeAt(i);
  return diff === 0;
}

// GET /desktop/__needs-you (cookie-gated) — the open needs-you record or
// {record: null}. The chrome polls this and shows the ComputerCard-style
// banner (Rakazo's ComputerCard: "Needs you" + agent text + live preview
// + Skip / I'm done / Take control).
async function desktopNeedsYou(request, env) {
  if (request.method === "GET") {
    const missing = kvRequired(env);
    if (missing) return missing;
    const computer = computerOf(new URL(request.url).searchParams.get("computer"));
    let record = null;
    try { record = await env.DESKTOP_KV.get(needsYouKey(computer), "json"); } catch { /* ignore */ }
    // Legacy fallback: needs-you used to be one global key ("needsyou").
    // A banner raised before this fix still lives there; show it on the
    // default computer rather than dropping it.
    if (!record && computer === "default") {
      try { record = await env.DESKTOP_KV.get(KV_NEEDSYOU_KEY, "json"); } catch { /* ignore */ }
    }
    return jsonResp({ record: record || null });
  }
  // POST — raise/update. Only the machine-side bridge may raise (sync
  // token), because the agent cannot mint a desktop cookie. The bridge
  // endpoint POST /needs-you (Bearer BRIDGE_TOKEN, from inside the
  // container) forwards here.
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  if (!syncTokenValid(request, env)) return jsonResp({ ok: false, error: "unauthorized" }, 401);
  const missing = kvRequired(env);
  if (missing) return missing;
  const body = await readJsonBody(request);
  const computer = computerOf(body.computer);
  const text = typeof body.text === "string" ? body.text.slice(0, 1000) : "";
  if (!text.trim()) return jsonResp({ ok: false, error: "empty_text" }, 400);
  const record = { text: text.trim(), at: new Date().toISOString(), runId: typeof body.runId === "string" ? body.runId.slice(0, 100) : null, computer };
  if (!(await guardedWrite(env, true, () => env.DESKTOP_KV.put(needsYouKey(computer), JSON.stringify(record))))) {
    return storeUnavailable();
  }
  return jsonResp({ ok: true, record });
}

// POST /desktop/__needs-you/resolve {action:"skip"|"done"} (cookie-gated)
// — the user answers the needs-you request. This clears the banner. It
// cannot message the agent directly (the agent reads only the console),
// so the chrome tells the user to say "skip that step" / "done, continue"
// in the chat. Honest limitation, stated in the UI.
async function desktopNeedsYouResolve(request, env) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  const missing = kvRequired(env);
  if (missing) return missing;
  const body = await readJsonBody(request);
  if (body.action !== "skip" && body.action !== "done") {
    return jsonResp({ ok: false, error: "bad_action" }, 400);
  }
  const computer = computerOf(body.computer);
  await guardedWrite(env, true, () => env.DESKTOP_KV.delete(needsYouKey(computer)));
  // Also clear the legacy global key when resolving on default, so a
  // pre-fix banner does not linger after the user answered it.
  if (computer === "default") await guardedWrite(env, true, () => env.DESKTOP_KV.delete(KV_NEEDSYOU_KEY));
  return jsonResp({ ok: true, action: body.action });
}

// GET /desktop/__preview (cookie-gated) — the latest desktop screenshot
// PNG (from the lease-watcher's scrot, max 600 s old) or 404.
async function desktopPreview(request, env) {
  if (request.method !== "GET") return jsonResp({ ok: false, error: "method" }, 405);
  const missing = kvRequired(env);
  if (missing) return missing;
  const computer = computerOf(new URL(request.url).searchParams.get("computer"));
  let b64 = null;
  try { b64 = await env.DESKTOP_KV.get(previewKey(computer)); } catch { /* ignore */ }
  if (!b64) return new Response("No preview yet.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  let bytes;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return new Response("Preview is corrupt.", { status: 502 });
  }
  return new Response(bytes, { status: 200, headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

// POST /desktop/__preview-upload (sync-token gated) — the lease-watcher
// posts the scrot PNG as raw bytes. Stored base64 with a 600 s TTL.
async function desktopPreviewUpload(request, env) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  if (!syncTokenValid(request, env)) return jsonResp({ ok: false, error: "unauthorized" }, 401);
  const missing = kvRequired(env);
  if (missing) return missing;
  const ct = request.headers.get("Content-Type") || "";
  if (!ct.includes("image/png")) return jsonResp({ ok: false, error: "need_png" }, 400);
  const buf = await request.arrayBuffer().catch(() => null);
  // D1 row cap is 2,000,000 bytes for the WHOLE row, and the row also holds
  // `computer` + `updated_at`. The old limit was exactly 2,000,000, so a
  // legitimate 1.9 MB PNG could fail the write with an opaque D1 error
  // instead of a clean 400. Keep a margin: 1,500,000 bytes leaves ~500 KB for
  // the row overhead and matches what the live previews actually are
  // (243-707 KB). D1 also stores the BLOB raw, not base64, so there is no
  // 4/3 expansion to allow for.
  const MAX_PREVIEW_BYTES = 1_500_000;
  if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_PREVIEW_BYTES) {
    return jsonResp({
      ok: false,
      error: "bad_image",
      note: `previews must be a PNG between 1 and ${MAX_PREVIEW_BYTES} bytes (D1 row cap is 2 MB)`,
    }, 400);
  }
  // btoa on a huge string built byte-by-byte is the most allocation-heavy
  // code in this Worker (BUGS.md B-11). Chunked fromCharCode is ~10x faster
  // and keeps peak memory low.
  const bytes = new Uint8Array(buf);
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const computer = computerOf(new URL(request.url).searchParams.get("computer"));
  // Non-essential: a dropped preview just leaves the last frame stale;
  // the watcher retries on the next change (120 s floor).
  if (!(await guardedWrite(env, false, () => env.DESKTOP_KV.put(previewKey(computer), btoa(s), { expirationTtl: KV_PREVIEW_TTL_S })))) {
    return jsonResp({ ok: false, error: "store_unavailable", note: STORE_UNAVAILABLE_NOTE }, 503);
  }
  return jsonResp({ ok: true, bytes: buf.byteLength });
}

// Strip sensitive values from a taught recording (Rakazo's
// sanitizeTeachRecordingEvent): a sensitive event keeps its kind but
// loses its key/text. The chrome already strips them client-side; this
// is the server-side second pass.
function sanitizeTeachEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.slice(0, 500).map((e) => {
    if (!e || typeof e !== "object") return null;
    const out = { kind: typeof e.kind === "string" ? e.kind : "pointer", at: typeof e.at === "string" ? e.at : new Date().toISOString() };
    if (typeof e.x === "number") out.x = e.x;
    if (typeof e.y === "number") out.y = e.y;
    if (typeof e.button === "string") out.button = e.button.slice(0, 20);
    if (typeof e.type === "string") out.type = e.type.slice(0, 20);
    if (e.sensitive) { out.sensitive = true; return out; }
    if (typeof e.key === "string") out.key = e.key.slice(0, 50);
    if (typeof e.text === "string") out.text = e.text.slice(0, 500);
    return out;
  }).filter(Boolean);
}

// POST /desktop/__teach {name, goal, playbook, events?} (cookie-gated) —
// save a taught skill (Rakazo's taught-skills flow: record → draft
// playbook → save). Stored in KV as teach-skill:<id>; the machine-side
// lease-watcher delivers it to the QwenPaw skill pool (SKILL.md) and
// enables it, then acks. The playbook fields are Name / When to use /
// Inputs / Steps / How to check / What to return / Approval boundaries /
// Failure handling (see packages/core/src/teach-playbook.ts).
async function desktopTeach(request, env) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  const missing = kvRequired(env);
  if (missing) return missing;
  const body = await readJsonBody(request);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  const goal = typeof body.goal === "string" ? body.goal.trim().slice(0, 500) : "";
  const pb = body.playbook && typeof body.playbook === "object" ? body.playbook : null;
  if (!name || !pb || !Array.isArray(pb.steps) || pb.steps.length === 0) {
    return jsonResp({ ok: false, error: "bad_skill", note: "A taught skill needs a name and a playbook with at least one step." }, 400);
  }
  const id = "taught-" + crypto.randomUUID().slice(0, 8);
  const skill = {
    id,
    name,
    goal,
    playbook: {
      whenToUse: typeof pb.whenToUse === "string" ? pb.whenToUse.slice(0, 1000) : goal,
      inputs: Array.isArray(pb.inputs) ? pb.inputs.slice(0, 20).map((x) => String(x).slice(0, 200)) : [],
      steps: pb.steps.slice(0, 100).map((x) => String(x).slice(0, 500)),
      howToCheck: typeof pb.howToCheck === "string" ? pb.howToCheck.slice(0, 1000) : "",
      whatToReturn: typeof pb.whatToReturn === "string" ? pb.whatToReturn.slice(0, 1000) : "",
      approvalBoundaries: typeof pb.approvalBoundaries === "string" ? pb.approvalBoundaries.slice(0, 1000) : "",
      failureHandling: typeof pb.failureHandling === "string" ? pb.failureHandling.slice(0, 1000) : "",
    },
    events: sanitizeTeachEvents(body.events),
    at: new Date().toISOString(),
  };
  if (!(await guardedWrite(env, true, () => env.DESKTOP_KV.put(KV_TEACH_PREFIX + id, JSON.stringify(skill))))) {
    return storeUnavailable();
  }
  return jsonResp({ ok: true, id, name });
}

// GET /desktop/__pending-skills (sync-token gated) — list pending taught
// skills for the lease-watcher to deliver.
async function desktopPendingSkills(request, env) {
  if (request.method !== "GET") return jsonResp({ ok: false, error: "method" }, 405);
  if (!syncTokenValid(request, env)) return jsonResp({ ok: false, error: "unauthorized" }, 401);
  const missing = kvRequired(env);
  if (missing) return missing;
  const list = await env.DESKTOP_KV.list({ prefix: KV_TEACH_PREFIX }).catch(() => ({ keys: [] }));
  const skills = [];
  for (const k of list.keys || []) {
    const v = await env.DESKTOP_KV.get(k.name, "json").catch(() => null);
    if (v) skills.push(v);
  }
  return jsonResp({ skills });
}

// POST /desktop/__pending-skills/ack {id} (sync-token gated) — delete a
// delivered taught skill from KV.
async function desktopPendingSkillsAck(request, env) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  if (!syncTokenValid(request, env)) return jsonResp({ ok: false, error: "unauthorized" }, 401);
  const missing = kvRequired(env);
  if (missing) return missing;
  const body = await readJsonBody(request);
  const id = typeof body.id === "string" ? body.id : "";
  if (!id || !/^taught-[A-Za-z0-9-]+$/.test(id)) return jsonResp({ ok: false, error: "bad_id" }, 400);
  await guardedWrite(env, true, () => env.DESKTOP_KV.delete(KV_TEACH_PREFIX + id));
  return jsonResp({ ok: true });
}

// GET /desktop/__mode?agent=<name> and POST /desktop/__mode {agent, mode}
// (cookie-gated) — per-agent Team vs Private computer mode. "team" is the
// shared :1 desktop; "private" is the per-agent :2 display (QA agent).
// The mode is recorded per agent in KV; the chrome header shows it.
async function desktopMode(request, env) {
  const missing = kvRequired(env);
  if (missing) return missing;
  const url = new URL(request.url);
  // Read the body ONCE: Request.json() consumes the stream, so a second
  // readJsonBody() would return {} and the mode would always fall back to
  // "team" (harness 28b/28c caught this).
  const body = request.method === "POST" ? await readJsonBody(request) : {};
  const agent = (request.method === "POST" ? body.agent : url.searchParams.get("agent")) || "default";
  const agentSafe = String(agent).slice(0, 60).replace(/[^A-Za-z0-9._-]/g, "_");
  if (request.method === "GET") {
    const mode = (await env.DESKTOP_KV.get(KV_MODE_PREFIX + agentSafe).catch(() => null)) || "team";
    return jsonResp({ agent: agentSafe, mode: mode === "private" ? "private" : "team" });
  }
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405);
  const mode = body.mode === "private" ? "private" : "team";
  if (!(await guardedWrite(env, true, () => env.DESKTOP_KV.put(KV_MODE_PREFIX + agentSafe, mode)))) {
    return storeUnavailable();
  }
  return jsonResp({ ok: true, agent: agentSafe, mode });
}
