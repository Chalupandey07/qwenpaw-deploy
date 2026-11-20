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
// oxlint-disable prefer-template, no-nested-ternary
// The waking/cooldown pages below build their HTML with string
// concatenation ON PURPOSE — wakingPage() documents the constraint as
// "string concatenation only, no backticks, no interpolation, no external
// assets" (Smart Sleep/Wake card rebuild, 2026-11-19). prefer-template
// would push every one of those toward template literals, directly
// contradicting that decision, so it is suppressed file-wide here rather
// than rewriting a dozen deliberate concatenations. The one nested
// ternary is in the cookie-header normalisation, kept for the same
// reason: it is a flat, readable guard, not a style problem worth a
// helper.
import { handleComputer } from "./computer/router.js";
import { handleVault } from "./vault/router.js";
import { handleReset } from "./reset/router.js";
import { restMachine, sleepMachine, machineState, authenticate } from "./machine-control.js";
import {
  mintSession, sessionFromRequest, sessionSetCookie, sessionClearCookie, SESSION_TTL_MS,
} from "./session.js";

const ORIGIN = "https://8088-agq5wqqo2fvypym7rjlpvngc2m.instabox.tech";
const WAKE_WAIT_MS = 45_000;
// KEEPALIVE_URL and MACHINE_ID were declared here and never referenced:
// the Vault/Rest/Computer UI lives in the console source itself and
// reaches the keep-alive Worker from the browser, not from this module. Removed
// rather than underscore-prefixed — an unused constant that looks like a
// wiring point is worse than no constant, because the next reader assumes
// the proxy calls the keep-alive Worker somewhere it does not.

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

function fmtCooldownRemaining(seconds) {
  // One shared formatter for the cooldown page: whole minutes, rounded up,
  // so 90 s reads as 2 minutes, never as a false-precise 1.5. Null, zero or
  // non-numeric input means the cooldown length is unknown, so no time
  // text is rendered at all (inventing one would be worse than none).
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0) { return ""; }
  var mins = Math.ceil(seconds / 60);
  if (mins <= 1) { return "about 1 minute"; }
  return "about " + mins + " minutes";
}

function wakingPage(retryAfter) {
  // Live progress, not a blank wait (sleep/wake fix, 2026-11-17): the old
  // page was static text + a 30 s meta-refresh, so a cold wake looked like
  // a hung "Loading..." screen. This page shows an elapsed timer, a
  // determinate bar (transform scaleX, never width), and a status line, and
  // polls the console every 5 s, reloading the moment the console answers
  // instead of waiting for the next refresh. The meta-refresh stays as a
  // no-JS fallback. Rebuilt 2026-11-19 as one centred card (Smart
  // Sleep/Wake Part 2): string concatenation only, no backticks, no
  // interpolation, no external assets. Titles keep the project-wide
  // AgentX dash separator, which the rebrand harness requires verbatim;
  // sloplint gate 19 flags that dash in <title>, never in body copy.
  var usual = 60;
  if (typeof retryAfter === "number" && isFinite(retryAfter) && retryAfter > 0) { usual = retryAfter; }
  var usualText = "Usually ready in about a minute.";
  if (usual !== 60) { usualText = "Usually ready in about " + usual + " seconds."; }
  return new Response(
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta http-equiv=\"refresh\" content=\"60\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>AgentX: Waking up</title>" +
    "<meta name=\"description\" content=\"AgentX is waking up. The console opens when the machine answers.\">" +
    "<style>" +
    "/* Hallmark · v2.0.0 · theme: AgentX status (custom) · genre modern-minimal · shape: one card */" +
    "/* Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V4 · weakest: S, led with the live state */" +
    ":root{color-scheme:dark;--color-bg:oklch(0.23 0.012 260);--color-surface:oklch(0.28 0.014 260);--color-track:oklch(0.35 0.012 260);--color-ink:oklch(0.93 0.008 250);--color-muted:oklch(0.74 0.01 250);--color-line:oklch(0.40 0.012 260);--color-accent:oklch(0.75 0.13 155);--color-accent-ink:oklch(0.24 0.03 160);--font-display:Georgia,\"Times New Roman\",serif;--font-body:system-ui,-apple-system,\"Segoe UI\",sans-serif;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:32px;--radius-card:16px;--radius-control:10px;--text-title:1.75rem;--text-body:1rem;--text-small:0.875rem;--width-card:38rem;}" +
    "*{box-sizing:border-box;}::selection{background:var(--color-accent);color:var(--color-accent-ink);}html{scrollbar-color:var(--color-line) var(--color-bg);}" +
    "html,body{overflow-x:clip;}" +
    "body{margin:0;min-height:100svh;display:grid;place-items:center;padding:var(--space-6) var(--space-4);background:var(--color-bg);color:var(--color-ink);font-family:var(--font-body);font-size:var(--text-body);line-height:1.55;}" +
    "main{width:100%;max-width:var(--width-card);background:var(--color-surface);border:1px solid var(--color-line);border-radius:var(--radius-card);padding:var(--space-6);}" +
    "h1{font-family:var(--font-display);font-size:var(--text-title);line-height:1.15;margin:0 0 var(--space-3);overflow-wrap:break-word;min-width:0;text-wrap:balance;}" +
    "p{margin:0 0 var(--space-4);}" +
    "p:last-child{margin-bottom:0;}" +
    ".fine{color:var(--color-muted);font-size:var(--text-small);}" +
    ".bar{background:var(--color-track);border-radius:var(--radius-control);height:8px;overflow:hidden;margin:var(--space-4) 0;}" +
    ".bar-fill{background:var(--color-accent);height:100%;border-radius:var(--radius-control);transform:scaleX(0.08);transform-origin:left center;transition:transform 1s linear;}" +
    "a{color:var(--color-accent);}a:active{opacity:0.8;}" +
    "a:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px;}" +
    "@media (prefers-reduced-motion:reduce){.bar-fill{transition:none;}}" +
    "</style></head>" +
    "<body><main id=\"wakeCard\" data-usual=\"" + usual + "\">" +
    "<h1>AgentX is waking up</h1>" +
    "<p id=\"status\">The machine was paused and is starting now.</p>" +
    "<div class=\"bar\"><div class=\"bar-fill\" id=\"barFill\"></div></div>" +
    "<p>Elapsed <span id=\"elapsed\">0s</span>. " + usualText + "</p>" +
    "<p><a href=\"/status\">Status page</a></p>" +
    "</main>" +
    "<script>(function(){/* UI-TIMER-ALLOWLIST: waking page progress tick, 1s elapsed and bar update while the user watches the machine wake */var t0=Date.now();var el=document.getElementById(\"elapsed\");var bar=document.getElementById(\"barFill\");var st=document.getElementById(\"status\");var usual=Number(document.getElementById(\"wakeCard\").dataset.usual)||60;var tries=0;function paint(){var s=Math.floor((Date.now()-t0)/1000);el.textContent=s+\"s\";var frac=Math.min(0.08+s/usual*0.88,0.96);bar.style.transform=\"scaleX(\"+frac+\")\";}setInterval(paint,1000);paint();function schedule(){setTimeout(poll,5000);}function poll(){tries++;fetch(location.pathname+location.search,{cache:\"no-store\",headers:{Accept:\"text/html\"}}).then(function(r){if(r.status!==200){schedule();return;}return r.text().then(function(t){if(t.indexOf(\'id=\"root\"\')!==-1){st.textContent=\"Machine is up. Loading the console.\";bar.style.transform=\"scaleX(1)\";location.reload();return;}if(tries<3){st.textContent=\"The machine was paused and is starting now.\";}else{st.textContent=\"Still waking. The machine usually takes about a minute. Keeping watch.\";}schedule();});}).catch(function(){schedule();});}setTimeout(poll,3000);})();</script>" +
    "</body></html>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Retry-After": "30", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" } },
  );
}

/**
 * The cooldown page.
 *
 * retryAfter is seconds; untilText is the human wall-clock ("2026-11-16
 * 07:53 UTC") parsed from InstaBox's own message. Showing the time is the
 * difference between "wait" and "come back at 13:23" — the second is actionable,
 * and it is what Rohan asked for. Rebuilt 2026-11-19 as one centred card
 * (Smart Sleep/Wake Part 2): the bar is determinate from data-start and
 * data-end and hidden when data-start is absent; the page reloads once at
 * cooldown end, guarded to at most one auto-reload per 30 s per tab.
 */
function cooldownPage(retryAfter, untilText) {
  var mins = null;
  if (typeof retryAfter === "number" && isFinite(retryAfter) && retryAfter > 0) { mins = Math.ceil(retryAfter / 60); }
  var remain = fmtCooldownRemaining(retryAfter);
  var start = 0;
  var end = 0;
  if (mins !== null) { start = Date.now(); end = start + retryAfter * 1000; }
  var barAttrs = "";
  var barHidden = " hidden";
  if (mins !== null) { barAttrs = " data-start=\"" + start + "\" data-end=\"" + end + "\""; barHidden = ""; }
  var remainHtml = "";
  if (remain) {
    remainHtml = "<p><span id=\"remainingText\">" + remain + " left.</span>";
    if (untilText) { remainHtml = remainHtml + " Come back at " + untilText + "."; }
    remainHtml = remainHtml + "</p>";
  }
  return new Response(
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    // Auto-refresh exactly when the cooldown is due to end, so the visitor does
    // not have to guess — and so we do not poll early (every early request is
    // refused and teaches the user the page is broken).
    (retryAfter ? "<meta http-equiv=\"refresh\" content=\"" + Math.max(5, mins * 60) + "\">" : "") +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>AgentX: Cooldown</title>" +
    "<meta name=\"description\" content=\"AgentX is in max-run cooldown. This page reloads when the cooldown ends.\">" +
    "<style>" +
    "/* Hallmark · v2.0.0 · theme: AgentX status (custom) · genre modern-minimal · shape: one card */" +
    "/* Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V4 · weakest: S, led with the live state */" +
    ":root{color-scheme:dark;--color-bg:oklch(0.23 0.012 260);--color-surface:oklch(0.28 0.014 260);--color-track:oklch(0.35 0.012 260);--color-ink:oklch(0.93 0.008 250);--color-muted:oklch(0.74 0.01 250);--color-line:oklch(0.40 0.012 260);--color-accent:oklch(0.75 0.13 155);--color-accent-ink:oklch(0.24 0.03 160);--font-display:Georgia,\"Times New Roman\",serif;--font-body:system-ui,-apple-system,\"Segoe UI\",sans-serif;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:32px;--radius-card:16px;--radius-control:10px;--text-title:1.75rem;--text-body:1rem;--text-small:0.875rem;--width-card:38rem;}" +
    "*{box-sizing:border-box;}::selection{background:var(--color-accent);color:var(--color-accent-ink);}html{scrollbar-color:var(--color-line) var(--color-bg);}" +
    "html,body{overflow-x:clip;}" +
    "body{margin:0;min-height:100svh;display:grid;place-items:center;padding:var(--space-6) var(--space-4);background:var(--color-bg);color:var(--color-ink);font-family:var(--font-body);font-size:var(--text-body);line-height:1.55;}" +
    "main{width:100%;max-width:var(--width-card);background:var(--color-surface);border:1px solid var(--color-line);border-radius:var(--radius-card);padding:var(--space-6);}" +
    "h1{font-family:var(--font-display);font-size:var(--text-title);line-height:1.15;margin:0 0 var(--space-3);overflow-wrap:break-word;min-width:0;text-wrap:balance;}" +
    "p{margin:0 0 var(--space-4);}" +
    "p:last-child{margin-bottom:0;}" +
    ".fine{color:var(--color-muted);font-size:var(--text-small);}" +
    ".bar{background:var(--color-track);border-radius:var(--radius-control);height:8px;overflow:hidden;margin:var(--space-4) 0;}" +
    ".bar-fill{background:var(--color-accent);height:100%;border-radius:var(--radius-control);transform:scaleX(0);transform-origin:left center;transition:transform 1s linear;}" +
    "a{color:var(--color-accent);}a:active{opacity:0.8;}" +
    "a:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px;}" +
    "@media (prefers-reduced-motion:reduce){.bar-fill{transition:none;}}" +
    "</style></head>" +
    "<body><main>" +
    "<h1>AgentX is in max-run cooldown</h1>" +
    "<p>The machine hit its maximum run length and is cooling down. Nothing can wake it until the cooldown ends.</p>" +
    "<div class=\"bar\" id=\"barWrap\"" + barAttrs + barHidden + "><div class=\"bar-fill\" id=\"barFill\"></div></div>" +
    remainHtml +
    "<p>The keep-alive Worker brings it back once the cooldown ends.</p>" +
    "<p><a href=\"/status\">Status page</a></p>" +
    "</main>" +
    "<script>(function(){/* UI-TIMER-ALLOWLIST: cooldown bar and countdown tick, 1s update while the user watches the cooldown end */var wrap=document.getElementById(\"barWrap\");var fill=document.getElementById(\"barFill\");var rem=document.getElementById(\"remainingText\");var start=Number(wrap.dataset.start)||0;var end=Number(wrap.dataset.end)||0;var KEY=\"agentxCooldownReloadAt\";var reloadTried=false;if(!start||!end){wrap.hidden=true;return;}function fmtLeft(ms){var mins=Math.ceil(ms/60000);if(mins<=1){return \"about 1 minute left.\";}return \"about \"+mins+\" minutes left.\";}function tryReload(){var last=0;try{last=Number(sessionStorage.getItem(KEY))||0;}catch(e){last=0;}var now=Date.now();if(now-last<30000){setTimeout(tryReload,30000);return;}try{sessionStorage.setItem(KEY,String(now));}catch(e){}location.reload();}function tick(){var now=Date.now();var total=end-start;var done=now-start;var frac=done/total;if(frac<0){frac=0;}if(frac>1){frac=1;}fill.style.transform=\"scaleX(\"+frac+\")\";if(now>=end){if(rem){rem.textContent=\"Cooldown over. Loading.\";}if(!reloadTried){reloadTried=true;tryReload();}return;}if(rem){rem.textContent=fmtLeft(end-now);}}setInterval(tick,1000);tick();})();</script>" +
    "</body></html>",
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

async function proxy(request, url, env, ctx) {
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

  const buildRequest = (targetUrl) => {
    const req = new Request(targetUrl || originUrl, request);
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
  } catch {
    // Deliberately generic: fetch error text can contain the origin URL
    // or stack fragments — never reflect it to the visitor. Optional catch
    // binding (the error is unused on purpose, not by oversight).
    return new Response("AgentX origin unreachable. Try again in a moment.", {
      status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }

  // Renamed-chunk fallback (P0 /chat render error, 2026-11-20).
  // The takeover2 cache-bust renamed one content-hashed console chunk
  // (index-opcB8AGu.js -> index-opcB8AGu-tk2.js) and rewrote the entry
  // chunk's dynamic import to the new name. The entry chunk is served
  // under the versioned URL and edge-cached, so a browser keeps asking
  // for the RENAMED chunk even after the machine's console has reverted
  // to a build that only has the ORIGINAL filename (container recreate,
  // console re-sync, snapshot restore all do this). The renamed chunk
  // then 404s at the origin, the /chat lazy import rejects, and React
  // renders the "Something went wrong" error boundary — exactly the
  // reported P0 (shell + sidebar fine, main chat panel fails after
  // "Loading...").
  //
  // Fix: on a 404 for a hashed asset whose name carries the takeover
  // version marker (-tk<N>), retry once against the original filename,
  // which the origin still has. Self-healing in both directions: when the
  // origin is re-patched the first fetch returns 200 and this never runs;
  // while it is not, the console still loads instead of erroring. Scoped
  // to a 404 on a -tk<N> hashed asset so it can never mask a genuine
  // missing-route 404 or an API error.
  let assetFallback = false;
  if (res.status === 404 && isSafeMethod) {
    const renamed = /^\/assets\/([A-Za-z0-9._-]+?)-tk[0-9]+\.(js|css|woff2?|png|svg|jpe?g|webp|ico|map)$/i.exec(fwdUrl.pathname);
    if (renamed) {
      const fallbackPath = "/assets/" + renamed[1] + "." + renamed[2] + fwdUrl.search;
      try {
        const alt = await fetch(buildRequest(ORIGIN + fallbackPath));
        if (alt.status === 200) {
          res = alt;
          assetFallback = true;
        } else if (alt && alt.body) {
          try { await alt.body.cancel(); } catch { /* already consumed */ }
        }
      } catch { /* origin unreachable for the fallback too — keep the 404 */ }
    }
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
    let untilText = null;
    try {
      const bodyText = await res.text();
      retryAfter = parseRetryAfter(res, bodyText);
      // InstaBox's own message carries the wall-clock instant:
      //   "machine is cooling down until 2026-11-16T07:53:20Z"
      // Quoting it back turns "wait" into "come back at 13:23", which is what
      // Rohan asked for and what a person can act on.
      const m = /until\s+([0-9T:.\-]+Z)/i.exec(bodyText || "");
      if (m) {
        const t = Date.parse(m[1]);
        if (Number.isFinite(t)) {
          untilText = new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
          // Trust the timestamp over the seconds field when both exist: the
          // seconds are relative to the response and drift if it is cached.
          const derived = Math.max(1, Math.round((t - Date.now()) / 1000));
          if (Number.isFinite(derived)) retryAfter = Math.min(retryAfter ?? derived, derived);
        }
      }
      code = JSON.parse(bodyText || "{}")?.error?.code ?? null;
    } catch { /* ignore */ }
    if (code === "machine_cooldown") return cooldownPage(retryAfter, untilText);
    return new Response(
      `AgentX is busy with another operation (409 ${code || ""}). Retry in a moment.`,
      { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    );
  }

  const headers = rewriteHeaders(res, pagesOrigin);

  // WebSocket upgrade: return the upgrade response (with its webSocket) as-is.
  if (res.status === 101 && res.webSocket) {
    return new Response(null, { status: 101, headers, webSocket: res.webSocket });
  }

  // Page-load visit signal (intelligent sleep/wake, 2026-11-17): a console
  // page load is a visit — the user is here, so the keep-alive must keep
  // the machine awake. Recorded in D1 meta (sleepwake:last-visit),
  // throttled to one write per 5 minutes inside recordLastVisit().
  // Fire-and-forget via ctx.waitUntil so the write never delays the page.
  // No body is read and nothing is rewritten: the origin HTML passes
  // through untouched. The injection that used to live here (AgentX
  // rebrand shim, Computer/Vault/Rest pills, search-settings UI) was
  // removed 2026-11-21 — the AgentX look and features now ship in the
  // console source itself, and the Worker only forwards.
  if (isSafeMethod && res.status === 200 && (headers.get("Content-Type") || "").includes("text/html")) {
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(recordLastVisit(env));
  }

  // Hashed-asset caching (sleep/wake + slow-open fix, 2026-11-17): the
  // console SPA is a 1 MB JS bundle whose filename carries a content hash
  // (e.g. /assets/index-DZrIuh3B.js). It is re-downloaded fresh on EVERY
  // load today because the proxy (and/or the origin) marks it no-store —
  // a big part of the slow open. A content-hashed filename can never go
  // stale (a rebuild produces a NEW filename, and the HTML references the
  // new one), so it is safe to cache for a year. HTML and API responses
  // keep no-store. The hash test is deliberately strict: a bare
  // /assets/foo.js (no hash) stays no-store.
  if (/^\/assets\/[^/]*-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/.test(url.pathname)) {
    // A fallback-served asset is the origin's content for a DIFFERENT
    // filename, so it must not be pinned for a year — a re-patched origin
    // could never win. Revalidate quickly instead.
    headers.set("Cache-Control", assetFallback ? "public, max-age=60" : "public, max-age=31536000, immutable");
    headers.delete("ETag");
    headers.delete("Last-Modified");
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
    // `/vendor/*` is routed to the computer surface too. The UI loads xterm
    // from `/vendor/xterm.js`, and without this the request fell through to the
    // CONSOLE PROXY — which answered it with the QwenPaw SPA: 200, text/html,
    // 45,989 bytes. A `<script src>` served as HTML parses as nothing, so
    // `window.Terminal` was never defined and the terminal pane stayed black
    // while the session still showed "connected" (BUGS.md B-35).
    //
    // A 200 with the wrong body type is the worst failure shape there is: no
    // onerror, no console message, nothing to grep. Serving it from the Pages
    // asset binding with the right MIME is the fix.
    if (path === "/computer" || path.startsWith("/computer/") || path.startsWith("/vendor/")) {
      try {
        return await handleComputer(request, env, url);
      } catch (err) {
        return new Response(JSON.stringify({ error: "computer_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Vault (Rakazo-style API-key vault, 2026-11-17). Everything under /vault
    // is its own surface; the console proxy below is untouched. The page
    // itself is exempt from the session gate (B-39 lesson — the page is
    // static bytes, the way in); every endpoint it calls is gated by the
    // vault router's own requiresSession(). ORIGIN is passed through so
    // /vault/reveal can verify the console bearer token against
    // /api/cron/jobs (the same probe /api/session/mint uses).
    if (path === "/vault" || path.startsWith("/vault/")) {
      try {
        return await handleVault(request, env, url, ORIGIN);
      } catch (err) {
        return new Response(JSON.stringify({ error: "vault_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Settings Reset (2026-11-18). Everything under /reset is its own
    // surface; the page itself is exempt from the session gate (B-39 lesson),
    // every API call is verified live against the console by the reset
    // router's authenticate() and forwarded to the machine-side reset
    // broker. See features/reset/README.md.
    if (path === "/reset" || path.startsWith("/reset/")) {
      try {
        return await handleReset(request, env, url, ORIGIN);
      } catch (err) {
        return new Response(JSON.stringify({ error: "reset_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    // ---- session for the /computer surface (see pages/public/session.js) ----
    //
    // This is the ONLY place a DESKTOP_SESSION cookie is minted. It requires a
    // bearer token the console actually accepts, so the cookie inherits the
    // console's own revocation behaviour: revoke the token upstream and the
    // next mint fails. The cookie carries no console credential — it is only
    // proof that this browser passed that check within the TTL.
    //
    // POST only: a GET would be mintable by any <img src>, which turns every
    // page that can embed a URL into a session factory.
    if (path === "/api/session/mint") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "method_not_allowed" }), {
          status: 405, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const auth = await authenticate(request, env, ORIGIN);
      if (!auth.ok) {
        return new Response(JSON.stringify({
          error: auth.error,
          detail: auth.detail || null,
        }), {
          status: auth.status || 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const secret = env.COMPUTER_SESSION_SECRET || env.COMPUTER_CAPABILITY_SECRET;
      const value = await mintSession(secret, { ttlMs: SESSION_TTL_MS });
      if (!value) {
        // Fail closed and NAME the missing secret. Minting an unsigned or
        // default-keyed session would be worse than minting none.
        return new Response(JSON.stringify({
          error: "unconfigured",
          detail: "COMPUTER_SESSION_SECRET (or COMPUTER_CAPABILITY_SECRET) is not set, "
            + "so no session can be minted.",
        }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      return new Response(JSON.stringify({ ok: true, expiresInMs: SESSION_TTL_MS }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": sessionSetCookie(value),
        },
      });
    }

    // Honest status read: the /computer page asks this on load so it can tell
    // "you are not signed in" apart from "the store is broken". No cookie is
    // returned by this endpoint, so it is safe to answer anonymously.
    if (path === "/api/session/state") {
      const s = await sessionFromRequest(env, request);
      return new Response(JSON.stringify({ ok: s.ok, reason: s.ok ? null : s.reason }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // Clearing is a POST for the same reason minting is: a logout reachable by
    // GET is a logout a third-party <img> can trigger.
    if (path === "/api/session/clear") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "method_not_allowed" }), {
          status: 405, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": sessionClearCookie(),
        },
      });
    }

    // ---- machine rest / state (Rohan's manual-rest feature) ----
    // The Rest button lives in the console header (injected below) so it is
    // always reachable; these are the endpoints behind it.
    if (path === "/api/machine/rest") {
      try {
        return await restMachine(request, env, ORIGIN);
      } catch (err) {
        return new Response(JSON.stringify({ error: "machine_rest_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }
    // Intelligent sleep/wake (2026-11-17): the keep-alive Worker calls this
    // when its decision function says SLEEP. Auth is the shared SLEEP_TOKEN
    // (machine-control.js), not a console session — the keep-alive Worker
    // has no console session. Pages holds INSTABOX_API_KEY and suspends.
    if (path === "/api/machine/sleep") {
      try {
        return await sleepMachine(request, env);
      } catch (err) {
        return new Response(JSON.stringify({ error: "machine_sleep_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }
    if (path === "/api/machine/state") {
      try {
        return await machineState(env);
      } catch (err) {
        return new Response(JSON.stringify({ error: "machine_state_error", detail: String(err).slice(0, 200) }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }

    return proxy(request, url, env, ctx);
  },
};

// --- Intelligent sleep/wake: last-visit recording (2026-11-17) ----------
// A console page load is a visit: the user is here, so the keep-alive
// must keep the machine awake. Recorded in D1 meta (sleepwake:last-visit),
// throttled to one write per 5 minutes so a page reload storm cannot
// burn the D1 write budget. Fire-and-forget via ctx.waitUntil so the
// write never delays the console. Never throws (a failed write must not
// break the page). Only page loads count — /api/* polling is excluded
// (the SPA polls constantly; counting it would keep the machine awake
// forever). The call site is the HTML pass-through in proxy(), which fires
// for HTML page loads (Content-Type text/html, safe method, 200).
async function recordLastVisit(env) {
  const db = env.COMPUTER_DB || env.QWENPAW_DB;
  if (!db) return;
  try {
    const now = Date.now();
    const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind("sleepwake:last-visit").first();
    const prev = row && row.value ? Number(row.value) : NaN;
    if (Number.isFinite(prev) && now - prev < 5 * 60_000) return;
    await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind("sleepwake:last-visit", String(now)).run();
  } catch { /* never break the console */ }
}
