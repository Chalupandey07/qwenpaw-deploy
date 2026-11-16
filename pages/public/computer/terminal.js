// Terminal tab — the lease rules for a root shell.
//
// WHY THIS IS SEPARATE FROM THE SCREEN PATH
//
// A screen capability is a URL a browser loads. A terminal capability is a
// shell on the machine that holds the user's auth file and chat history. They
// are the same shape of token and need different rules, so they get their own
// module rather than a flag on the screen one:
//
//   1. A terminal capability is minted ONLY while the caller holds the live
//      lease, and it dies with that lease. BUGS.md B-4 recorded a terminal
//      outliving its lease by 59 minutes; here the expiry is
//      min(now + TERMINAL_TTL_MS, lease.expiresAt + grace), and the PTY server
//      is additionally given a signed absolute deadline so an idle but open
//      socket is killed too — the Worker is not in the loop for an established
//      WebSocket.
//
//   2. The TTL is seconds, not an hour. A terminal is opened deliberately and
//      used immediately; 60 s is enough for the upgrade to land, after which
//      the signed deadline is what governs. A leaked URL is worthless in a
//      minute and worthless immediately after a release.
//
//   3. Every request re-checks the live lease. A terminal capability presented
//      after a release gets 403, whatever its own expiry says.
//
//   4. The token is a path segment of a sealed, scoped, expiring capability —
//      never a query parameter, never a cookie, never in `Referer`. The
//      upstream provider token (if any) stays inside the seal.
//
// WHY THE SIGNATURE FOR THE PTY SERVER IS SEPARATE FROM THE SCREEN SEAL
//
// The screen seal is opened by this Worker, so AES-GCM with a shared secret is
// right. The PTY server needs to verify a deadline on its own, without this
// Worker in the loop, so it needs an HMAC it can check with a secret it holds.
// Same secret material, different operation — and the PTY side uses
// `hmac.compare_digest`, because B-16 recorded a plain string compare on a
// token that authorised code execution.

import { openCapability, sealCapability } from "./capability.js";
import * as S from "./state.js";

/** How long a terminal capability URL stays useful. Seconds, on purpose. */
export const TERMINAL_TTL_MS = 60_000;

/** The terminal dies this long after its lease at the latest. */
export const TERMINAL_GRACE_MS = 15_000;

/** Resize frames bigger than this are refused (B-17). Mirrors the PTY server. */
export const MAX_TERM_DIM = 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time string comparison for secrets (BUGS.md B-16).
 *
 * `===` on a token leaks its length and prefix through timing. WebCrypto has
 * no compare_digest, so the standard trick applies: compare hashes of equal
 * length and fold every byte's difference into one accumulator. Comparing
 * SHA-256 digests also removes the length oracle, because the digests are
 * always 32 bytes.
 */
export async function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i += 1) diff |= va[i] ^ vb[i];
  // Also fold in the raw length difference so two distinct strings that
  // somehow collide on the digest prefix cannot compare equal.
  diff |= (a.length === b.length ? 0 : 1);
  return diff === 0;
}

/**
 * Mint a terminal capability. Returns `{ok, url, deadlineMs, leaseId}` or
 * `{ok:false, error}`.
 *
 * Deliberately NOT tolerant: without a live lease this returns `no_lease` and
 * nothing is minted. There is no "view-only terminal" — a read-only shell is
 * still a shell.
 */
export async function mintTerminal(env, computer, leaseId) {
  if (!env.COMPUTER_CAPABILITY_SECRET) return { ok: false, error: "unconfigured" };
  const target = env.COMPUTER_TERMINAL_ORIGIN;
  if (!target) return { ok: false, error: "unconfigured" };

  const lease = await S.getLease(env, computer);
  if (!lease || !lease.live) return { ok: false, error: "no_lease" };
  // The lease id must match the caller's. A stale tab cannot open a shell
  // against a lease someone else now holds.
  if (lease.leaseId !== leaseId) return { ok: false, error: "not_holder" };

  const leaseDeadline = lease.expiresAt + TERMINAL_GRACE_MS;
  const ownDeadline = Date.now() + TERMINAL_TTL_MS;
  // Both, whichever is sooner: the URL cannot outlive its lease, and cannot
  // outlive its own short TTL either.
  const deadlineMs = Math.min(ownDeadline, leaseDeadline);
  const expiresAt = Math.floor(deadlineMs / 1000);

  const signature = await hmacHex(
    env.COMPUTER_CAPABILITY_SECRET,
    `${computer}|${lease.leaseId}|${deadlineMs}`,
  );

  const url = await sealCapability(env.COMPUTER_CAPABILITY_SECRET, {
    policy: "control",
    expiresAt,
    target: {
      url: target,
      // The terminal port is a PRIVATE InstaBox port, so the edge answers 401
      // without its `_token`. It used to be `null`, which meant the proxy had
      // no credential to present and the upgrade could never have reached
      // websockify even with a correct route.
      token: env.COMPUTER_TERMINAL_TOKEN || null,
      // The PTY server reads this line before the frame stream: computer,
      // lease, absolute deadline, signature. Space-separated, newline-ended.
      // Its own copy of the deadline is what stops an idle open socket.
      preamble: `${computer} ${lease.leaseId} ${deadlineMs} ${signature}`,
      // The browser gets the deadline for its countdown; it is also the exact
      // moment the PTY server kills the shell.
      deadlineMs,
    },
    scope: { computer, generation: await currentGeneration(env, computer), leaseId: lease.leaseId },
    prefix: "/computer/terminal",
  });

  // `preamble` is returned to the caller because the WORKER CANNOT INJECT IT.
  //
  // A proxied WebSocket is tunnelled socket-to-socket: the runtime splices the
  // two ends and the Worker never gets to write a byte. So the first message
  // must come from the browser, and this is the only place it can learn what to
  // send.
  //
  // Handing it over is safe, and the reason is specific: it contains an HMAC
  // over (computer, leaseId, deadline), NOT the secret. A client holding it can
  // open the shell it already had the lease for, until the deadline that was
  // already agreed — it cannot forge a later deadline, cannot move the session
  // to another lease, and cannot reach another computer. The authority it
  // confers is exactly the authority the lease already granted.
  return { ok: true, url, deadlineMs, leaseId: lease.leaseId, expiresAt,
           preamble: `${computer} ${lease.leaseId} ${deadlineMs} ${signature}` };
}

async function currentGeneration(env, computer) {
  const c = await S.getComputer(env, computer);
  return c.generation;
}

/**
 * Authorise a terminal request.
 *
 * Order matters and is the same as the screen path: open the seal, then check
 * the generation, then check the LIVE lease. Every step is a refusal, not a
 * fallback — there is no degraded mode for a shell.
 */
export async function authorizeTerminal(env, pathname, computerHint) {
  const cap = await openCapability(env.COMPUTER_CAPABILITY_SECRET, pathname);
  if (!cap) return { ok: false, status: 403, error: "expired" };
  if (cap.policy !== "control") return { ok: false, status: 403, error: "bad_policy" };

  const computer = cap.scope.computer;
  if (computerHint && computerHint !== computer) {
    return { ok: false, status: 403, error: "computer_mismatch" };
  }
  let current;
  try {
    current = await S.getComputer(env, computer);
  } catch {
    return { ok: false, status: 503, error: "store" };
  }
  if (current.generation !== cap.scope.generation) {
    return { ok: false, status: 403, error: "stale" };
  }
  let live;
  try {
    live = await S.leaseValid(env, computer, cap.scope.leaseId);
  } catch {
    // No store, no shell. Fails closed and says so rather than claiming the
    // lease was released.
    return { ok: false, status: 503, error: "store" };
  }
  if (!live) return { ok: false, status: 403, error: "released" };

  return { ok: true, computer, leaseId: cap.scope.leaseId, target: cap.target };
}

/**
 * The `X-Computer-Token` check used by agent/machine-facing endpoints
 * (needs-you raise, preview upload, teach delivery), now constant-time.
 *
 * Returns `null` when the request may proceed, or a 401 Response. When no
 * token is configured it FAILS CLOSED for these write endpoints: an
 * unauthenticated endpoint that can raise a needs-you banner or replace a
 * preview is not acceptable, and an unset secret is a configuration error,
 * not permission.
 */
export async function requireSyncToken(request, env) {
  const expected = env.COMPUTER_SYNC_TOKEN;
  if (!expected) {
    return json({ error: "unconfigured", detail: "COMPUTER_SYNC_TOKEN is not set" }, 503);
  }
  const supplied = request.headers.get("X-Computer-Token") || "";
  if (!(await constantTimeEqual(supplied, expected))) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}
