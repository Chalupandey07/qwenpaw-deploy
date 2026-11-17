// Machine rest + auto-wake — the Worker half.
//
// Three behaviours share one marker (see machine-rest.js for the semantics):
//
//   POST /api/machine/rest  -> mark a manual rest, then suspend the machine
//   GET  /api/machine/state -> what the UI polls to render the Rest button
//   auto-wake on visit      -> if the machine is down, attempt one wake
//
// WHY THE AUTH IS VERIFIED AGAINST THE CONSOLE, NOT GUESSED
//
// Suspending the machine is a destructive, user-visible action: an anonymous
// visitor who could call it would take the site down for the owner. So the
// endpoint refuses unless it can prove the caller holds a live QwenPaw session.
//
// It proves that by ASKING THE CONSOLE: it forwards the caller's bearer token to
// the console's own authenticated endpoint and trusts only a 200. That is the
// real auth system answering, not a second one we invented — and it means a
// revoked or expired token stops working here at the same moment it stops
// working there.
//
// Consequences, stated because they are deliberate:
//   * if the console is unreachable we cannot verify, so we REFUSE. Resting an
//     already-down machine is pointless anyway.
//   * `MACHINE_CONTROL_TOKEN` (a Worker secret) is accepted as an alternative
//     for server-to-server use: it is a credential only a deployer holds, so it
//     cannot be obtained by a visitor.
//   * neither path is a URL parameter: a token in a query string lands in logs
//     and `Referer` (BUGS.md B-16/B-18).

import {
  REST_KEY, REST_MAX_MS, makeRestMarker, restActive, parseRestMarker, parseCooldown,
} from "./machine-rest.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Constant-time string compare (BUGS.md B-16): this token suspends the machine.
 * Hashed so the comparison has no length oracle either.
 */
async function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < va.length; i += 1) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** The rest marker, through the D1 `meta` table (one row, no migration). */
async function readRest(env) {
  const db = env.COMPUTER_DB || env.QWENPAW_DB;
  if (!db) return { ok: false, reason: "no_store", marker: null };
  try {
    const row = await db.prepare(`SELECT value FROM meta WHERE key = ?`).bind(REST_KEY).first();
    return { ok: true, marker: parseRestMarker(row && row.value) };
  } catch {
    // The caller decides what a failed read means; this module does not guess.
    return { ok: false, reason: "store_error", marker: null };
  }
}

async function writeRest(env, marker) {
  const db = env.COMPUTER_DB || env.QWENPAW_DB;
  if (!db) return { ok: false, reason: "no_store" };
  try {
    await db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(REST_KEY, JSON.stringify(marker)).run();
    return { ok: true };
  } catch {
    return { ok: false, reason: "store_error" };
  }
}

async function clearRest(env) {
  const db = env.COMPUTER_DB || env.QWENPAW_DB;
  if (!db) return { ok: false, reason: "no_store" };
  try {
    await db.prepare(`DELETE FROM meta WHERE key = ?`).bind(REST_KEY).run();
    return { ok: true };
  } catch {
    return { ok: false, reason: "store_error" };
  }
}

/** Exported for the keep-alive Worker and the tests. */
export const _internals = { readRest, writeRest, clearRest };

/**
 * Verify the caller holds a live QwenPaw session.
 *
 * Returns `{ok:true, via}` or `{ok:false, status, error}`. `via` names the
 * mechanism so a log line can distinguish a user click from automation.
 */
export async function authenticate(request, env, origin) {
  // 1. Server-to-server token. Only a deployer holds this.
  const machineToken = env.MACHINE_CONTROL_TOKEN;
  if (machineToken) {
    const supplied = request.headers.get("X-Machine-Token") || "";
    if (supplied && await safeEqual(supplied, machineToken)) {
      return { ok: true, via: "machine_token" };
    }
  }

  // 2. A console session. Forward the caller's bearer token to an endpoint the
  //    console ACTUALLY PROTECTS, and trust only its answer.
  //
  //    THIS USED TO FORWARD TO `/api/auth/status`, WHICH IS PUBLIC BY DESIGN.
  //    It answers 200 `{"enabled":true,"has_users":true}` to any caller —
  //    that is how the login screen learns whether to show a sign-in form, so
  //    it cannot require a session. Verifying a credential against an endpoint
  //    that answers everyone verifies NOTHING: any non-empty string passed.
  //    Verified live 2026-11-16 — `Authorization: Bearer bogus-token-…` was
  //    accepted, and the only reason the request then failed was that the
  //    machine happened to be in cooldown. On a running machine that is an
  //    anonymous caller suspending the user's box.
  //
  //    `/api/cron/jobs` is the endpoint the 2026-11-15 audit used for exactly
  //    this check: it answers 401 without a valid session and 200 with one
  //    (recorded in the retest: "/api/cron/jobs 401 on Pages and direct URL").
  //    It is read-only, so using it as a probe cannot change state.
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m || !origin) {
    return { ok: false, status: 401, error: "auth_required",
             detail: "Send Authorization: Bearer <console session token>." };
  }
  const token = m[1];
  // Refuse a token that is obviously not a session (empty/absurd) without a
  // round trip; this is a cheap guard, not the verification.
  if (token.length < 8 || token.length > 4096) {
    return { ok: false, status: 401, error: "auth_required" };
  }
  try {
    const res = await fetch(origin + "/api/cron/jobs", {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      // Read the body: a live console answers a JSON array. A 200 with a
      // non-JSON body is not the console (a captive portal, say), so do not
      // accept it.
      const text = await res.text();
      try {
        const body = JSON.parse(text);
        if (body && typeof body === "object") return { ok: true, via: "console_session" };
      } catch { /* fall through to refusal */ }
      return { ok: false, status: 401, error: "auth_unverified" };
    }
    // 409 = cooldown, 503 = asleep: the console is real but cannot answer.
    // We cannot verify a session against a machine that is not running, and a
    // currently-paused machine does not need resting.
    if (res.status === 409 || res.status === 503) {
      return { ok: false, status: 409, error: "machine_not_running",
               detail: "The machine is already paused or cooling down, so there is nothing to rest." };
    }
    return { ok: false, status: 401, error: "auth_invalid" };
  } catch {
    return { ok: false, status: 502, error: "auth_unreachable" };
  }
}

/**
 * POST /api/machine/rest
 *
 * Suspend the machine and record why, so the keep-alive leaves it alone.
 * Order matters: the MARKER IS WRITTEN FIRST. If we suspended first and the
 * marker write failed, the keep-alive would wake the machine within five
 * minutes and the user's explicit instruction would be silently undone. A
 * marker with no suspension is harmless; a suspension with no marker is not.
 */
export async function restMachine(request, env, origin) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = await authenticate(request, env, origin);
  if (!auth.ok) {
    return json({ error: auth.error, detail: auth.detail || null }, auth.status);
  }

  if (!env.INSTABOX_API_KEY) {
    // Fail closed and name the missing secret. Never invent one.
    return json({
      error: "instabox_api_key_unset",
      detail: "machine rest needs INSTABOX_API_KEY (a Worker secret on both Pages projects). "
        + "Until it is set, rest is unavailable; the keep-alive continues as before.",
    }, 503);
  }
  if (!env.INSTABOX_MACHINE_ID) {
    return json({
      error: "instabox_machine_unset",
      detail: "machine rest needs INSTABOX_MACHINE_ID (a Worker var).",
    }, 503);
  }

  const marker = makeRestMarker({ by: auth.via, ttlMs: REST_MAX_MS });
  const wrote = await writeRest(env, marker);
  if (!wrote.ok) {
    // No marker means the keep-alive would undo the rest, so do not suspend.
    return json({
      error: "store_unavailable",
      detail: "Could not record the rest, so the machine was NOT suspended — the keep-alive "
        + "would have woken it within five minutes.",
    }, 503);
  }

  // Suspend. InstaBox takes `desiredState`; the API wake path uses the same
  // base URL, so this follows the deployed pattern rather than inventing one.
  let res;
  try {
    res = await fetch(
      `https://api.instabox.sh/v1/machines/${encodeURIComponent(env.INSTABOX_MACHINE_ID)}`,
      {
        method: "PATCH",
        headers: {
          "X-API-Key": env.INSTABOX_API_KEY,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ desiredState: "suspended" }),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch (e) {
    // The marker stays: the user asked for rest, and a failed API call does not
    // cancel that. The keep-alive will now leave the machine alone, which is
    // the outcome the user wanted anyway.
    return json({
      error: "suspend_failed",
      detail: "The rest was recorded but the suspend call failed; the keep-alive will not wake it.",
      detail_raw: String(e).slice(0, 200),
      resting: true,
    }, 502);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return json({
      error: "suspend_failed",
      status: res.status,
      detail: "The rest was recorded but InstaBox refused the suspend; the keep-alive will not wake it.",
      detail_raw: text.slice(0, 300),
      resting: true,
    }, 502);
  }

  return json({
    ok: true,
    resting: true,
    by: auth.via,
    until: marker.until,
    message: "Machine resting — open the site again to wake it.",
  });
}

// --- Intelligent sleep/wake: the suspend executor (2026-11-17) ----------
// POST /api/machine/sleep — the keep-alive Worker calls this when its
// decision function says SLEEP. It is NOT console-authenticated (the
// keep-alive Worker has no console session); it is authenticated by a
// shared SLEEP_TOKEN secret, set on both the keep-alive Worker and these
// Pages projects. The token is the ONLY credential that can suspend the
// machine from the server side, so it is compared constant-time and the
// endpoint fails closed (503) when the secret is unset on either side.
//
// This reuses the exact suspend call restMachine uses (PATCH desiredState
// "suspended" + INSTABOX_API_KEY, which Pages already holds). The
// keep-alive Worker holds no InstaBox key and must never invent one —
// Pages is the single place that can suspend. The keep-alive Worker
// writes the sleep state in D1 BEFORE calling here and updates it from
// this response, so this endpoint only suspends and reports; it writes
// no state itself.
export async function sleepMachine(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!env.SLEEP_TOKEN) {
    return json({
      error: "sleep_token_unset",
      detail: "machine sleep needs SLEEP_TOKEN (a Worker secret on the keep-alive Worker and both Pages projects).",
    }, 503);
  }
  const supplied = request.headers.get("X-Sleep-Token") || "";
  if (!(await safeEqual(supplied, env.SLEEP_TOKEN))) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env.INSTABOX_API_KEY) {
    return json({
      error: "instabox_api_key_unset",
      detail: "machine sleep needs INSTABOX_API_KEY (a Worker secret on both Pages projects).",
    }, 503);
  }
  if (!env.INSTABOX_MACHINE_ID) {
    return json({
      error: "instabox_machine_unset",
      detail: "machine sleep needs INSTABOX_MACHINE_ID (a Worker var).",
    }, 503);
  }
  let res;
  try {
    res = await fetch(
      `https://api.instabox.sh/v1/machines/${encodeURIComponent(env.INSTABOX_MACHINE_ID)}`,
      {
        method: "PATCH",
        headers: {
          "X-API-Key": env.INSTABOX_API_KEY,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ desiredState: "suspended" }),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch (e) {
    return json({
      error: "suspend_failed",
      detail: "The suspend call failed; the machine was NOT suspended.",
      detail_raw: String(e).slice(0, 200),
    }, 502);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return json({
      error: "suspend_failed",
      status: res.status,
      detail: "InstaBox refused the suspend; the machine was NOT suspended.",
      detail_raw: text.slice(0, 300),
    }, 502);
  }
  return json({
    ok: true,
    sleeping: true,
    message: "Machine sleeping — it will wake 5 minutes before the next routine, or when you open the site.",
  });
}

/**
 * GET /api/machine/state — what the UI needs to render the Rest button honestly.
 *
 * Deliberately cheap: one indexed row. It does NOT probe the machine (the
 * console proxy already does that on every page load), so this can be polled.
 */
export async function machineState(env) {
  const rest = await readRest(env);
  return json({
    ok: true,
    resting: rest.ok ? restActive(rest.marker) : false,
    // A withheld answer is stated, not silently reported as "not resting".
    store: rest.ok ? "ok" : "degraded",
    until: rest.ok && restActive(rest.marker) ? rest.marker.until : null,
    rest_configured: Boolean(env.INSTABOX_API_KEY),
  });
}
