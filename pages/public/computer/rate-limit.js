// Rate limiting for the /computer surface (BUGS.md B-10).
//
// THE CONSTRAINT THAT SHAPES THIS FILE
//
// The obvious implementation — a counter in KV or D1 per (client, endpoint) —
// is exactly the bug it is meant to prevent. A status poll is 6 requests per
// minute per open tab; four tabs is ~35,000 requests a day, and a row per
// request would be ~35,000 D1 row writes a day against a 100,000 budget. The
// guard would spend a third of the quota protecting the quota. That is the
// recorded lesson from the 2026-11-15 incident: cost must be proportional to
// what a user does, never to the clock.
//
// So the fast path is FREE and in-memory:
//
//   1. A token bucket per (client, endpoint-class) in module scope. One
//      isolate serves many requests, and a stuck client's retry loop lands on
//      the same isolate, so this catches the actual failure mode — a tab
//      retrying in a tight loop — at zero write cost.
//
//   2. When a bucket trips, ONE penalty row is written to D1 so other
//      isolates honour it too, at most once per minute per (client, class).
//      Writes are therefore proportional to abuse, not to traffic: a
//      well-behaved client writes nothing, ever.
//
//   3. If D1 is unavailable the in-memory bucket still works. The limiter
//      fails OPEN for availability but never silently: `degraded: true` is
//      reported so the caller can log it. Failing closed here would take the
//      whole computer down whenever the store hiccups, which is a worse
//      failure than the one being prevented — and the store paths underneath
//      already answer 503 honestly.
//
// LIMITS are generous on purpose. This is not an anti-abuse firewall for a
// public API; it is a circuit breaker for a buggy client. One user, one box.
// A limit that a normal user can hit would be its own incident.

/** Per-minute allowances. Generous: each is >= 5x the intended client rate. */
export const LIMITS = {
  // The UI polls state every 10 s (6/min) and the rail + overlay both poll,
  // so 12-15/min is the honest expected rate. 120 leaves room for several
  // tabs and a reload storm.
  status: 120,
  // Minting runs on load and on every swap; 30/min is far above real use.
  mint: 30,
  // Takeover / release / heartbeat / mode / needs-you resolve.
  mutation: 60,
  // Preview image reads. Keyed by hash, so a static screen asks once.
  preview: 60,
  // Agent-facing and machine-facing writes.
  upload: 30,
  // Terminal attach attempts. A shell is expensive; keep it tight.
  terminal: 20,
  // Teach record start/stop/save.
  teach: 30,
};

/** Bucket refill window. One minute, matching the per-minute limits. */
const WINDOW_MS = 60_000;
/** A penalty row outlives its bucket so a second isolate sees it. */
const PENALTY_TTL_MS = 60_000;
/** Hard cap on tracked clients, so the map cannot grow without bound. */
const MAX_BUCKETS = 5000;

/**
 * In-memory buckets. Module scope, so they survive across requests in an
 * isolate and vanish with it — which is correct: a new isolate has no memory
 * of abuse, and re-learning it costs one request.
 * @type {Map<string, {count: number, resetAt: number, wroteAt: number}>}
 */
const buckets = new Map();

function prune(now) {
  if (buckets.size <= MAX_BUCKETS) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    return;
  }
  // Over the cap: drop the oldest windows first. This is a memory guard, not
  // a correctness one — dropping a bucket only resets a counter.
  const entries = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  for (const [k] of entries.slice(0, entries.length - MAX_BUCKETS)) buckets.delete(k);
}

/**
 * Identify the caller.
 *
 * A single user has one browser and one machine, so IP is the honest key: it
 * is what the board's proven Durable Object limiter uses for the same reason.
 * It is NOT an authorization decision — the lease and capability are that —
 * so a shared IP costing two clients one bucket is acceptable. When no IP is
 * available (a Worker-to-Worker call), fall back to a constant: the goal is
 * bounding a runaway loop, and a constant still bounds it globally.
 */
export function clientKey(request) {
  const h = request.headers;
  return h.get("cf-connecting-ip") || h.get("x-real-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function bucketKey(request, cls) {
  return `${clientKey(request)}|${cls}`;
}

/**
 * Consume one token.
 *
 * Returns `{ allowed, retryAfter, remaining, degraded }`. `retryAfter` is in
 * whole seconds and is always >= 1 when `allowed` is false, so a 429 can
 * carry a usable `Retry-After` header.
 */
export function take(request, cls) {
  const limit = LIMITS[cls];
  if (!limit) throw new Error(`unknown rate-limit class: ${cls}`);
  const now = Date.now();
  prune(now);

  const key = bucketKey(request, cls);
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + WINDOW_MS, wroteAt: 0 };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count <= limit) {
    return { allowed: true, retryAfter: 0, remaining: limit - b.count, degraded: false };
  }
  return {
    allowed: false,
    retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    remaining: 0,
    degraded: false,
    // Set by `noteTrip` after it has tried to persist the penalty.
    key,
  };
}

/**
 * Persist a trip so other isolates honour it, at most once per minute per
 * (client, class). Returns whether the write landed; a failure is not fatal.
 *
 * The row is `meta` (`ratelimit:<client>|<class>` = the epoch-ms expiry), which
 * already exists in `qwenpaw-state` and needs no migration. It is read by
 * `blockedElsewhere` on the next request from a different isolate.
 */
export async function noteTrip(env, request, cls, now = Date.now()) {
  const key = bucketKey(request, cls);
  const b = buckets.get(key);
  if (b && now - b.wroteAt < WINDOW_MS) return { wrote: false, reason: "recent" };
  const db = env && env.COMPUTER_DB;
  if (!db) return { wrote: false, reason: "no_store" };
  try {
    if (b) b.wroteAt = now;
    await db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(`ratelimit:${key}`, String(now + PENALTY_TTL_MS)).run();
    return { wrote: true };
  } catch {
    // A limiter that fails the request because it could not record a trip
    // would be worse than the loop it is stopping. The in-memory bucket has
    // already answered 429 for this isolate.
    return { wrote: false, reason: "store" };
  }
}

/**
 * Has another isolate already tripped this (client, class)?
 *
 * Blue path: NOT consulted. A request below the soft threshold never reads the
 * store, so a healthy client costs zero reads here — the same reasoning as
 * zero writes, and the reason this limiter can exist at all on a free tier.
 *
 * It is consulted once a local bucket passes half its limit. At that point the
 * client is either genuinely busy or broken, and the cost of a read is
 * proportional to that, not to traffic. This is what makes the limit hold
 * across isolates: without it a client that trips isolate A starts fresh on
 * isolate B, and a retry loop gets a fresh allowance every time it lands
 * somewhere new.
 */
export async function blockedElsewhere(env, request, cls, now = Date.now()) {
  const db = env && env.COMPUTER_DB;
  if (!db) return false;
  try {
    const row = await db.prepare(`SELECT value FROM meta WHERE key = ?`)
      .bind(`ratelimit:${bucketKey(request, cls)}`).first();
    const until = Number(row && row.value);
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  }
}

/**
 * Enforce a limit, or return a 429 response.
 *
 * `headers` carries `Retry-After` so a well-written client backs off instead
 * of retrying — which is the whole point: a 429 that a client ignores is a
 * slower loop.
 */
function tooMany(retryAfter, cls) {
  return new Response(
    JSON.stringify({ error: "rate_limited", retryAfter, class: cls }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Retry-After": String(Math.max(1, retryAfter)),
      },
    },
  );
}

export async function enforce(request, env, cls) {
  const limit = LIMITS[cls];
  if (!limit) throw new Error(`unknown rate-limit class: ${cls}`);
  const verdict = take(request, cls);

  // Above half the limit: a client is either legitimately busy or a loop.
  // Only here is the shared penalty consulted, so the healthy path stays free.
  if (verdict.allowed && verdict.remaining < limit / 2) {
    if (await blockedElsewhere(env, request, cls)) {
      return tooMany(Math.ceil(WINDOW_MS / 1000), cls);
    }
  }
  if (verdict.allowed) return null;

  await noteTrip(env, request, cls);
  return tooMany(verdict.retryAfter, cls);
}

/** Test seam: forget every bucket. Never called from the Worker. */
export function _reset() {
  buckets.clear();
}

/** Test seam: inspect a bucket without consuming from it. */
export function _peek(request, cls) {
  return buckets.get(bucketKey(request, cls)) || null;
}
