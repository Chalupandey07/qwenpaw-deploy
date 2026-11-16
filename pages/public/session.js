// Session gate for the /computer surface — the control the README already
// documented and the code never had.
//
// THE BUG THIS EXISTS FOR
//
// `/computer/*` had NO authentication of any kind. Every endpoint under it was
// reachable by anyone on the internet, and verified live on 2026-11-16:
//
//   GET  /computer/preview?computer=default  -> 200, image/png, 381,490 bytes
//       (a real 1920x1080 screenshot of the user's desktop)
//   POST /computer/takeover {computer:"qa"}  -> 200 + a live leaseId
//   GET  /computer/session?computer=qa       -> {"ok":true,"policy":"control"}
//   POST /computer/terminal/session          -> 200 + a terminal capability URL
//
// That last line is a pre-authentication remote ROOT SHELL: minting a terminal
// capability needs only a live lease, and a lease needed only a POST. The
// machine holds the user's auth file, chat history and workspace.
//
// WHY A COOKIE, AND WHY THIS SHAPE
//
// The console's own credential is a bearer token held in localStorage by the
// SPA. It cannot be read by the Worker on a page load, and it must never be
// put in a URL (B-18). So the Worker mints its OWN session cookie, which the
// browser attaches automatically to same-origin `/computer/*` requests —
// including the `<img>` preview fetch, which no header-only scheme can cover.
//
// What the cookie is NOT:
//   * it does NOT contain or wrap the QwenPaw bearer token. A cookie that
//     carries a console credential is a credential leak with extra steps.
//   * it is not a general proxy credential. It authorises `/computer/*` only.
//
// It is minted ONLY after the console has accepted the caller's bearer token
// (see /api/session/mint in _worker.js), so revocation on the console side is
// what ends it — the Worker does not invent a second identity system.
//
// TERMINAL
//
// The cookie is HttpOnly + Secure + SameSite=Lax: no script needs to read it,
// and it must not ride along on a cross-site request. `Path=/` is required
// because the surface spans `/computer/*`, and `SameSite=Lax` still sends it on
// a top-level navigation to `/computer`, which is the direct-visit case.

export const SESSION_COOKIE = "DESKTOP_SESSION";

/** How long a minted session lives. Short enough to bound a stolen cookie. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const te = new TextEncoder();

function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text) {
  const pad = text.length % 4 ? "=".repeat(4 - (text.length % 4)) : "";
  const s = atob(String(text).replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(text));
  return new Uint8Array(sig);
}

/**
 * Constant-time compare, on digests.
 *
 * Comparing raw strings with `===` leaks length and prefix through timing;
 * comparing SHA-256 digests removes the length oracle because both sides are
 * always 32 bytes. Same rule the terminal token follows (BUGS.md B-16).
 */
async function sameDigest(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", te.encode(a)),
    crypto.subtle.digest("SHA-256", te.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = va.length ^ vb.length;
  for (let i = 0; i < va.length; i += 1) diff |= va[i] ^ (vb[i] ?? 0);
  return diff === 0;
}

/**
 * The signed text.
 *
 * The `v1:` prefix and the `session:` domain tag are load-bearing: the same
 * secret also seals screen capabilities, and a signature that is valid in two
 * different protocols is a signature that can be replayed across them.
 */
function payloadFor(exp, sub) {
  return `session:v1:${exp}:${sub}`;
}

/**
 * Mint a session cookie VALUE (not the Set-Cookie header).
 *
 * Returns null when there is no secret — a missing secret must mean "no
 * session", never "an unsigned session everyone can forge".
 */
export async function mintSession(secret, { sub = "console", now = Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
  if (!secret || String(secret).length < 16) return null;
  const exp = now + ttlMs;
  const sig = await hmac(secret, payloadFor(exp, sub));
  return `v1.${exp}.${b64url(sig)}`;
}

/**
 * Verify a session cookie value.
 *
 * Returns `{ok:true, exp}` or `{ok:false, reason}`. Every rejection names its
 * reason so a diagnostic can distinguish "expired" from "forged" — the two
 * demand different responses and conflating them hides attacks.
 */
export async function verifySession(secret, value, now = Date.now()) {
  if (!secret) return { ok: false, reason: "unconfigured" };
  if (!value || typeof value !== "string") return { ok: false, reason: "absent" };
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "malformed" };
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp)) return { ok: false, reason: "malformed" };
  const expected = b64url(await hmac(secret, payloadFor(exp, "console")));
  if (!(await sameDigest(expected, parts[2]))) return { ok: false, reason: "bad_signature" };
  // Signature is checked BEFORE expiry on purpose: an expired-but-forged value
  // must read as forged, or an attacker learns which guesses were close.
  if (exp <= now) return { ok: false, reason: "expired", exp };
  return { ok: true, exp };
}

/** Parse a Cookie header into a plain object. Duplicate names: first wins. */
export function parseCookies(header) {
  const out = {};
  const raw = String(header || "");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    out[name] = part.slice(i + 1).trim();
  }
  return out;
}

/** The Set-Cookie header for a freshly minted session. */
export function sessionSetCookie(value, { maxAgeS = Math.floor(SESSION_TTL_MS / 1000) } = {}) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeS}`;
}

/** The Set-Cookie header that clears it. */
export function sessionClearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * Read and verify the session off a request.
 *
 * Returns `{ok:true, exp}` / `{ok:false, reason}`. Used by the router as a hard
 * gate and by /api/session/state as an honest status read.
 */
export async function sessionFromRequest(env, request, now = Date.now()) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  return verifySession(env.COMPUTER_SESSION_SECRET || env.COMPUTER_CAPABILITY_SECRET,
                       cookies[SESSION_COOKIE], now);
}
