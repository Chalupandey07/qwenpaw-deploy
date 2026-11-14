// QwenPaw reverse proxy — Cloudflare Pages Advanced Mode (_worker.js).
// Root / and everything else is proxied to the QwenPaw console on InstaBox.
// /status (and /status.html) serves the status / wake page from static assets.
// Every proxied visit hits the InstaBox public URL, which counts as activity
// and wakes an auto-paused box; the 5-minute Worker cron is the other keeper.
const ORIGIN = "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const WAKE_WAIT_MS = 45_000;

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

    return proxy(request, url);
  },
};
