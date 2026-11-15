// Screen capability — AES-256-GCM sealed, scoped, short-lived.
//
// PORTED FROM Rakazo (packages/core/src/node/screen-capability.ts) with two
// deliberate differences, both forced by the platform:
//
//   1. WebCrypto instead of node:crypto. Workers has no `createCipheriv`, and
//      a bundler polyfill would add hundreds of KB for one call.
//   2. No loopback-only target allowlist. Rakazo's screens are provider URLs it
//      validates against private ranges; ours are fixed published InstaBox
//      ports, so the target is sealed at mint time and never user-supplied.
//      The sealed URL is the authorization — there is no path in the request
//      that can redirect it.
//
// What is preserved exactly, because each part prevents a specific failure:
//
//   * the policy (`view` | `control`) is in the AAD, so a token minted for
//     view cannot be replayed as control even with the same expiry;
//   * the scope carries computer + generations + leaseId, so a takeover or a
//     screen replace invalidates every outstanding link;
//   * the upstream socket token rides INSIDE the seal and never reaches the
//     browser — the previous implementation put it in a cookie and in a
//     redirect, which is how stale per-port cookies 401'd every other port;
//   * the seal is derived deterministically for a repeatable link, so two
//     concurrent mints for the same scope produce the same URL and do not
//     race each other's handshake.
//
// TTL is minutes, not Rakazo's 60. A screen link here is minted immediately
// before a frame loads it, and a 10-minute cap means a leaked link dies long
// before it can be useful, while still surviving a slow wake.

export const SCREEN_PROXY_TTL_MS = 10 * 60_000;
export const SCREEN_RECHECK_MS = 1_000;
export const SCREEN_UNCONFIRMED_MAX_MS = 6_000;

const te = new TextEncoder();
const td = new TextDecoder();

function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text) {
  const pad = text.length % 4 ? "=".repeat(4 - (text.length % 4)) : "";
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

async function keyFor(secret) {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function hmacBytes(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(text));
  return new Uint8Array(sig);
}

/**
 * Seal a screen target.
 *
 * `target` is the upstream URL including its provider token, plus the headers
 * the origin needs. None of it is visible to the browser after this call.
 */
export async function sealCapability(secret, { policy, expiresAt, target, scope }) {
  if (policy !== "view" && policy !== "control") throw new Error("bad policy");
  const key = await keyFor(secret);
  const aad = te.encode(`${policy}:${expiresAt}`);
  const plaintext = te.encode(JSON.stringify({ target, scope }));
  // Deterministic IV: equal (policy, expiry, target, scope) produces one link,
  // so two tabs that mint at the same instant do not invalidate each other.
  const ivSrc = await hmacBytes(secret, `${policy}:${expiresAt}:${JSON.stringify({ target, scope })}`);
  const iv = ivSrc.subarray(0, 12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plaintext);
  // The token MUST carry the IV: it is random per seal (or HMAC-derived), so
  // without it the opener has nothing to decrypt with. Writing only the
  // ciphertext produced links that looked well-formed and never opened.
  const token = b64url(new Uint8Array([...iv, ...new Uint8Array(ct)]));
  return `/computer/session/${policy}/${expiresAt}.${token}`;
}

/**
 * Open a capability path. Returns null for anything malformed, expired, or
 * sealed with a different secret — never throws, because this runs on every
 * screen request and a throw would be a 500 where a 403 belongs.
 */
export async function openCapability(secret, pathname) {
  const match = /^\/computer\/session\/(view|control)\/(\d+)\.([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const [, policy, expText, token] = match;
  const expiresAt = Number(expText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= Date.now()) return null;
  try {
    const key = await keyFor(secret);
    const raw = unb64url(token);
    const iv = raw.subarray(0, 12);
    // WebCrypto's AES-GCM ENCRYPT returns ciphertext||tag as one buffer, so
    // decrypt takes the whole tail — unlike node:crypto, which takes the tag
    // separately. Splitting the tag off here silently fails every open, which
    // is exactly what the harness caught.
    const ct = raw.subarray(12);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: te.encode(`${policy}:${expiresAt}`) }, key, ct,
    );
    const { target, scope } = JSON.parse(td.decode(pt));
    if (!target || typeof target.url !== "string") return null;
    if (!scope || typeof scope.computer !== "string") return null;
    // A control capability is only valid while its lease is the current one;
    // the caller checks that against live state, because the seal cannot know
    // whether the lease has since been released.
    return { policy, expiresAt, target, scope, rest: match[4] || "" };
  } catch {
    return null;
  }
}

/**
 * Rewrite a noVNC page request. Rakazo asks for the page uncompressed and
 * without validators so the upstream cannot answer 304 with a page cached
 * before the shim existed; strip them the same way.
 */
export function novncPageRequestHeaders(headers) {
  const out = new Headers(headers);
  out.delete("if-modified-since");
  out.delete("if-none-match");
  out.set("accept-encoding", "identity");
  return out;
}

/** A rewritten noVNC page is never stored and never transformed by a CDN. */
export function rewrittenNovnc(headers) {
  const out = new Headers(headers);
  out.delete("content-length");
  out.delete("etag");
  out.delete("last-modified");
  out.delete("expires");
  out.set("cache-control", "no-store, no-transform");
  return out;
}

const NOVNC_PAGES = new Set(["vnc.html", "vnc_lite.html", "embed.html"]);

export function isNovncPage(pathname) {
  const name = pathname.slice(pathname.lastIndexOf("/") + 1);
  return NOVNC_PAGES.has(name);
}

/**
 * The shim injected into noVNC pages.
 *
 * Four jobs, each fixing something concrete:
 *   1. in-memory storage (the iframe is sandboxed without same-origin, so
 *      noVNC's localStorage reads throw and the page never starts);
 *   2. hide #noVNC_status (it prints the upstream host) and, in view-only
 *      mode, the control bar;
 *   3. report the screen state to the parent, because the parent cannot look
 *      into a cross-origin sandboxed frame — this is what makes
 *      "connected / failed / disconnected" possible at all;
 *   4. accept exactly one message back (focus), so the iframe cannot be
 *      driven by anything but a refocus request.
 */
export function novncShim(viewOnly) {
  const chrome = `<style>#noVNC_status{display:none!important}${
    viewOnly ? "#noVNC_control_bar_anchor{display:none!important}" : ""
  }</style>`;
  return `${chrome}<script>
(() => {
  const mem = () => {
    const items = new Map();
    return {
      getItem(k) { return items.has(String(k)) ? items.get(String(k)) : null; },
      setItem(k, v) { items.set(String(k), String(v)); },
      removeItem(k) { items.delete(String(k)); },
      clear() { items.clear(); },
      get length() { return items.size; },
      key(i) { return Array.from(items.keys())[i] ?? null; },
    };
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    try { Object.defineProperty(window, name, { configurable: true, value: mem() }); } catch {}
  }
  window.addEventListener("error", (e) => {
    if (/^[a-z-]+-extension:/.test(String(e.filename))) e.stopImmediatePropagation();
  }, true);
  // noVNC probes WebCodecs H.264 on load; on some devices flush() never
  // returns and the page never starts. Screens never use H.264.
  try { delete window.VideoDecoder; } catch {}
  const report = (state, detail) => {
    try { window.parent.postMessage(detail ? { screen: state, detail } : { screen: state }, "*"); } catch {}
  };
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window.parent || !d || typeof d !== "object") return;
    if (Object.keys(d).length !== 1 || d.screenFocus !== true) return;
    try { document.querySelector("#screen canvas, #noVNC_container canvas, canvas")?.focus(); } catch {}
  });
  let last = "";
  let classed = false;
  const sync = () => {
    const root = document.documentElement;
    const status = document.getElementById("noVNC_status");
    const err = root.getAttribute("data-screen-error");
    const statusError = status && status.classList.contains("noVNC_open")
      && status.classList.contains("noVNC_status_error");
    const connecting = root.classList.contains("noVNC_connecting")
      || root.classList.contains("noVNC_reconnecting");
    const connected = root.classList.contains("noVNC_connected");
    if (connecting || connected) classed = true;
    const state = connected ? "connected"
      : (err !== null || statusError) ? "failed"
      : connecting ? "connecting"
      : classed ? (last === "connected" || last === "connecting" ? "disconnected" : "")
      : document.querySelector("#screen canvas") ? "connecting" : "";
    if (!state || state === last) return;
    last = state;
    report(state, state === "failed" ? (err || String(status?.textContent || "")) : undefined);
  };
  const observe = () => {
    sync();
    new MutationObserver(sync).observe(document.documentElement, {
      attributes: true, attributeFilter: ["class", "data-screen-error"], childList: true, subtree: true,
    });
  };
  report("loading");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observe);
  else observe();
})();
</script>`;
}

export function injectShim(html, viewOnly) {
  const shim = novncShim(viewOnly);
  return html.includes("<head>")
    ? html.replace("<head>", `<head>${shim}`)
    : html.replace(/<script\b/i, `${shim}<script`);
}
