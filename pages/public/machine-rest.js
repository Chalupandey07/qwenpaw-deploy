// Machine rest — the shared store semantics for manual rest + auto-wake.
//
// WHY THIS EXISTS
//
// The keep-alive Worker pings the public URL every 5 minutes, which is what
// keeps the InstaBox machine awake. On a Free plan the machine has a maximum
// run length, so holding it awake for 8 straight hours ends in a 2-hour
// cooldown — exactly when the user might want it. Rohan's ask: let the user
// REST the machine when they are done, and have it wake itself when they come
// back to the site.
//
// THE THREE PIECES AND HOW THEY SHARE STATE
//
//   POST /api/machine/rest   writes a rest marker, then suspends the machine
//   GET  /  (auto-wake)      clears the marker when a wake attempt succeeds
//   keep-alive cron          reads the marker and does NOT wake while set
//
// The marker is the only shared state, and every reader must agree on one rule:
//
//   **While a manual rest is in effect, do not wake.** A missed wake is a
//   nuisance the user fixes by opening the site. Undoing their rest is a
//   betrayal of an explicit instruction, and it costs them a cooldown.
//
// FAIL SAFE, IN BOTH DIRECTIONS
//
// - keep-alive: if the marker CANNOT BE READ, do not wake. A read failure must
//   never be interpreted as "no rest in effect" — that would resume the very
//   behaviour the user switched off. This is the opposite of the usual
//   fail-open default, and it is deliberate.
// - auto-wake: if the marker cannot be read, a visit still attempts the wake,
//   because a human is present and asking. The asymmetry is the point: a human
//   action is evidence of intent; a cron tick is not.
//
// EXPIRY
//
// A marker without an expiry would make a rest permanent if the user never came
// back — the machine would sleep forever and the keep-alive would look broken.
// `REST_MAX_MS` bounds it (24 h). Past that the marker stops counting and the
// keep-alive resumes, which is the same behaviour as before this feature.

/** How long a manual rest can suppress the keep-alive, at most. */
export const REST_MAX_MS = 24 * 60 * 60 * 1000;

/** The single D1 row this feature owns. Cheap: one row, read rarely. */
export const REST_KEY = "machine:rest";

/**
 * Sanity bounds for a cooldown we were told about.
 *
 * InstaBox returns `retryAfterSeconds` AND a human "cooling down until" string.
 * We prefer the number (it is unambiguous) and clamp it: an absurd value from a
 * broken response must not park the UI for a week, and a zero must not make us
 * hammer the machine.
 */
export const COOLDOWN_MIN_S = 30;
export const COOLDOWN_MAX_S = 3 * 60 * 60;

export function clampCooldown(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(COOLDOWN_MIN_S, Math.min(COOLDOWN_MAX_S, Math.round(n)));
}

/**
 * Shape of the rest marker stored as JSON.
 *
 * `until` is epoch ms. `reason` distinguishes a manual rest from anything else
 * that might set this later, so the keep-alive can log WHY it skipped.
 */
export function makeRestMarker({ by = "user", now = Date.now(), ttlMs = REST_MAX_MS } = {}) {
  return { by, at: now, until: now + ttlMs };
}

/** Is a marker currently in effect? A malformed marker counts as "no rest". */
export function restActive(marker, now = Date.now()) {
  if (!marker || typeof marker !== "object") return false;
  const until = Number(marker.until);
  if (!Number.isFinite(until)) return false;
  return until > now;
}

/**
 * Parse the marker defensively.
 *
 * Stored as JSON text in the store's generic `meta` table. Anything unparseable
 * returns null, which means "no rest" — safe here because the marker only ever
 * SUPPRESSES a wake, and a corrupt marker that suppressed wakes forever would
 * be worse than one that lets a wake through.
 */
export function parseRestMarker(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Pull the cooldown detail out of an InstaBox 409 body.
 *
 * The live shape (verified 2026-11-16) is:
 *   {"error":{"code":"machine_cooldown",
 *             "message":"machine is cooling down until 2026-11-16T07:53:20Z",
 *             "retryAfterSeconds":3038}}
 *
 * We return the seconds AND the wall-clock instant when we can parse it, because
 * "Cooling down until 14:53" is what a person needs; a number of seconds
 * requires them to do arithmetic.
 */
export function parseCooldown(bodyText, retryAfterHeader) {
  let seconds = null;
  let until = null;
  let code = null;

  const header = String(retryAfterHeader || "").trim();
  if (/^\d+$/.test(header)) seconds = Number(header);

  try {
    const j = JSON.parse(bodyText || "{}");
    const err = j?.error || {};
    code = err.code || j?.code || null;
    const n = err.retryAfterSeconds ?? j?.retryAfterSeconds;
    if (seconds === null && typeof n === "number") seconds = n;
    const msg = String(err.message || "");
    const m = /until\s+([0-9T:.\-]+Z)/i.exec(msg);
    if (m) {
      const t = Date.parse(m[1]);
      if (Number.isFinite(t)) until = t;
    }
  } catch {
    // A non-JSON 409 is still a 409; fall back to the header only.
  }

  const clamped = clampCooldown(seconds);
  if (until === null && clamped !== null) until = Date.now() + clamped * 1000;
  return { code, seconds: clamped, until, isCooldown: code === "machine_cooldown" || clamped !== null };
}

/** "14:53" in the viewer's locale, for the cooldown page. */
export function formatUntil(epochMs) {
  if (!Number.isFinite(epochMs)) return null;
  try {
    return new Date(epochMs).toISOString().replace("T", " ").replace(/:\d\d\.\d+Z$/, " UTC");
  } catch {
    return null;
  }
}
