// Computer state: lease, generations, modes, needs-you, previews.
//
// PORTED FROM Rakazo's lease model (apps/api/src/computer-control.ts,
// packages/core/src/screen-reconnect.ts) with the storage swapped from
// Postgres to D1. The behaviour that matters is identical:
//
//   * a grant is atomic — one conditional write, not read-then-write;
//   * the lease has a 90 s life and is renewed by a heartbeat every 15 s,
//     and only a VISIBLE page heartbeats, so a forgotten tab lapses;
//   * a release names the lease id, so a late release from an old page
//     cannot end newer control;
//   * every grant bumps a generation, which is what actually invalidates old
//     screen links and old capabilities;
//   * a failed generation bump means the grant FAILED. Reporting success here
//     was BUGS.md B-1 and it left old screens live while the UI said "you have
//     control".
//
// SCHEMA: this module deliberately uses the tables that are ALREADY LIVE in
// the qwenpaw-state database (`leases`, `generations`, `needs_you`, `previews`,
// `modes`) rather than defining its own. An earlier version of this file
// invented `computer_lease` and `computer_preview`, which would have created a
// second, empty copy of the same data beside the real one — a defect that
// looks like "working" and loses every existing lease and preview. The live
// definitions are in `features/storage/migrate-kv-to-d1.py` and
// `features/storage/SCHEMA.md`.

export const LEASE_TTL_MS = 90_000;
export const LEASE_HEARTBEAT_MS = 15_000;
/** A capability may outlive its lease by this much, for a heartbeat in flight. */
export const LEASE_CAP_GRACE_MS = 30_000;

export const COMPUTERS = ["default", "qa"];

function db(env) {
  return env.COMPUTER_DB;
}

/** Fail loudly and specifically: a missing binding is a deploy error, not a bug. */
function requireDb(env) {
  const d = db(env);
  if (!d) throw new Error("COMPUTER_DB binding is missing (expected qwenpaw-state)");
  return d;
}

export async function getComputer(env, name) {
  const d = requireDb(env);
  const gen = await d.prepare(`SELECT gen FROM generations WHERE computer = ?`).bind(name).first();
  const mode = await d.prepare(`SELECT mode FROM modes WHERE agent = ?`).bind(name).first();
  return {
    name,
    generation: gen?.gen ?? 0,
    mode: mode?.mode === "private" ? "private" : "team",
  };
}

export async function getLease(env, name) {
  const d = requireDb(env);
  const row = await d.prepare(
    `SELECT computer, lease_id, holder, granted_at, expires_at, fence FROM leases WHERE computer = ?`,
  ).bind(name).first();
  if (!row) return null;
  return {
    computer: row.computer,
    leaseId: row.lease_id,
    holder: row.holder,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    fence: row.fence,
    live: row.expires_at > Date.now(),
  };
}

/**
 * Grant control atomically.
 *
 * Returns `{ ok: true, lease, generation }` or `{ ok: false, reason }`.
 * The WHERE clause is the whole guarantee: a row is only replaced when the
 * existing lease has lapsed, so two simultaneous takeovers cannot both win.
 */
export async function takeControl(env, name, holder = "user") {
  const d = requireDb(env);
  const now = Date.now();
  const leaseId = crypto.randomUUID();
  const expiresAt = now + LEASE_TTL_MS;

  const res = await d.prepare(
    `INSERT INTO leases (computer, lease_id, holder, granted_at, expires_at, fence)
     VALUES (?1, ?2, ?3, ?4, ?5, 1)
     ON CONFLICT(computer) DO UPDATE SET
       lease_id = excluded.lease_id, holder = excluded.holder,
       granted_at = excluded.granted_at, expires_at = excluded.expires_at,
       fence = leases.fence + 1
     WHERE leases.expires_at <= ?4
     RETURNING lease_id, expires_at, fence`,
  ).bind(name, leaseId, holder, now, expiresAt).first();

  if (!res) {
    const held = await getLease(env, name);
    return { ok: false, reason: "held", holder: held?.holder, expiresAt: held?.expiresAt };
  }

  // The generation bump is part of the grant. If it fails the grant failed —
  // see the note at the top of this file.
  const genRow = await d.prepare(
    `INSERT INTO generations (computer, gen) VALUES (?1, 1)
     ON CONFLICT(computer) DO UPDATE SET gen = generations.gen + 1
     RETURNING gen`,
  ).bind(name).first();
  if (!genRow) return { ok: false, reason: "store" };

  return {
    ok: true,
    generation: genRow.gen,
    lease: { computer: name, leaseId: res.lease_id, holder, grantedAt: now,
             expiresAt: res.expires_at, fence: res.fence, live: true },
  };
}

export async function heartbeat(env, name, leaseId) {
  const d = requireDb(env);
  const now = Date.now();
  const res = await d.prepare(
    `UPDATE leases SET expires_at = ?
     WHERE computer = ? AND lease_id = ? AND expires_at > ?
     RETURNING lease_id, expires_at`,
  ).bind(now + LEASE_TTL_MS, name, leaseId, now).first();
  if (!res) return { ok: false, reason: "not_held" };
  return { ok: true, leaseId: res.lease_id, expiresAt: res.expires_at };
}

export async function release(env, name, leaseId) {
  const d = requireDb(env);
  // Naming the lease is what stops a late release from an old page ending
  // newer control.
  const res = await d.prepare(
    `DELETE FROM leases WHERE computer = ? AND lease_id = ? RETURNING lease_id`,
  ).bind(name, leaseId).first();
  if (!res) return { ok: false, reason: "not_holder" };
  const genRow = await d.prepare(
    `INSERT INTO generations (computer, gen) VALUES (?1, 1)
     ON CONFLICT(computer) DO UPDATE SET gen = generations.gen + 1
     RETURNING gen`,
  ).bind(name).first();
  if (!genRow) return { ok: false, reason: "store" };
  return { ok: true, generation: genRow.gen };
}

/** True when this exact lease is still the live holder. Used on every screen request. */
export async function leaseValid(env, name, leaseId) {
  if (!leaseId) return false;
  const lease = await getLease(env, name);
  return Boolean(lease && lease.live && lease.leaseId === leaseId);
}

export async function setMode(env, name, mode) {
  if (mode !== "team" && mode !== "private") return { ok: false, reason: "bad_mode" };
  const d = requireDb(env);
  await d.prepare(
    `INSERT INTO modes (agent, mode) VALUES (?, ?)
     ON CONFLICT(agent) DO UPDATE SET mode = excluded.mode`,
  ).bind(name, mode).run();
  return { ok: true, mode };
}

// ------------------------------------------------------------------ needs-you
// Live shape: `needs_you(computer PRIMARY KEY, text, at, run_id)` — ONE row per
// computer, replaced on raise and deleted on resolve. That is per-computer
// (which was the B-2 fix) without an unbounded history table.

export async function raiseNeedsYou(env, name, text, runId) {
  const d = requireDb(env);
  await d.prepare(
    `INSERT INTO needs_you (computer, text, at, run_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(computer) DO UPDATE SET
       text = excluded.text, at = excluded.at, run_id = excluded.run_id`,
  ).bind(name, String(text || "").slice(0, 2000), new Date().toISOString(), runId || null).run();
  return { ok: true, computer: name };
}

export async function openNeedsYou(env, name) {
  const d = requireDb(env);
  const row = await d.prepare(
    `SELECT computer, text, at, run_id FROM needs_you WHERE computer = ?`,
  ).bind(name).first();
  if (!row) return null;
  // The hash comes from the metadata read, NOT from the blob. The previous
  // version loaded the whole 243-707 KB PNG here and hashed it, and
  // `stateFor()` then loaded and hashed it AGAIN for its own `preview` field —
  // ~1.4 MB of D1 row read and two SHA-256 passes on every 10 s poll, per
  // open tab. That is the server-side form of B-5 (the image "refetched every
  // 10 s"): the bytes never left the Worker but the cost was the same.
  const meta = await previewMeta(env, name);
  return {
    computer: row.computer, text: row.text, runId: row.run_id,
    createdAt: row.at, previewSha: meta?.sha256 ?? null,
  };
}

export async function resolveNeedsYou(env, name, action) {
  const d = requireDb(env);
  const existing = await d.prepare(`SELECT computer FROM needs_you WHERE computer = ?`)
    .bind(name).first();
  if (!existing) return { ok: false, reason: "none_open" };
  await d.prepare(`DELETE FROM needs_you WHERE computer = ?`).bind(name).run();
  // The action is recorded in the response only; there is no history column in
  // the live table, and adding one would mean a migration for a field nothing
  // reads yet.
  return { ok: true, computer: name, action: String(action || "done").slice(0, 40) };
}

// ---------------------------------------------------------------- previews
// Live shape: `previews(computer PRIMARY KEY, png BLOB, updated_at)`.
//
// The hash is ALSO stored, in `preview_meta` (see ensureSchema below), for a
// specific reason: deriving it means reading and hashing the blob, and the
// state poll runs every 10 s per open tab. Storing it turns a 700 KB read plus
// a SHA-256 into a ~40-byte read. The blob is read only when a client actually
// fetches the image, and only re-sent when its hash changed (ETag/304).

/**
 * Create the one additive table this module needs, idempotently.
 *
 * `previews` itself is LIVE and must not be redefined (B-23: a parallel schema
 * passes every test written against itself and silently orphans real data).
 * This is an additional table keyed by the same computer name, so the live
 * blob table keeps working untouched if this one is ever dropped.
 */
export async function ensureSchema(env) {
  const d = requireDb(env);
  await d.prepare(
    `CREATE TABLE IF NOT EXISTS preview_meta (
       computer   TEXT PRIMARY KEY,
       sha256     TEXT NOT NULL,
       bytes      INTEGER NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  ).run();
  return true;
}

/** Hash + size for a computer's current preview, without reading the blob. */
let schemaReady = false;

/**
 * Run `ensureSchema` once per isolate.
 *
 * Blue-path cost: a boolean check. The DDL runs once per cold isolate — a few
 * times a day on this traffic — and `IF NOT EXISTS` makes it a no-op after the
 * first. It must still be called: an `ensureSchema` that nothing invokes is
 * dead code, and shipping one is how the `preview_meta` table would silently
 * never exist and previews would fall back to hashing the blob forever.
 */
async function ready(env) {
  if (schemaReady) return;
  await ensureSchema(env);
  schemaReady = true;
}

export async function previewMeta(env, name) {
  const d = requireDb(env);
  await ready(env);
  try {
    const row = await d.prepare(
      `SELECT sha256, bytes, updated_at FROM preview_meta WHERE computer = ?`,
    ).bind(name).first();
    return row ? { sha256: row.sha256, bytes: row.bytes, capturedAt: row.updated_at } : null;
  } catch {
    // The table may not exist yet on a database that has never had an upload.
    return null;
  }
}

async function sha256Hex(bytes) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer ?? bytes;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Store a preview, but ONLY when the bytes changed.
 *
 * This conditional is the actual fix for the quota burn. The previous
 * implementation uploaded unconditionally every 15 s, which is 11,500 writes a
 * day against a 1,000 budget; a longer interval only makes the burn slower.
 * Here an unchanged screen writes nothing at all.
 */
export async function putPreview(env, name, bytes, sha256) {
  const d = requireDb(env);
  await ready(env);
  // Compare hashes, never bytes: the metadata row is ~40 bytes, the blob is
  // up to 1.5 MB. The old code loaded the whole previous PNG to decide whether
  // anything had changed, which made the change-only rule cost as much as the
  // unconditional write it replaced.
  const meta = await previewMeta(env, name);
  if (meta && meta.sha256 === sha256) return { ok: true, unchanged: true, sha256 };
  const now = new Date().toISOString();
  // One batch: the blob and its metadata must never disagree, or the ETag
  // would describe an image the browser does not have.
  await d.batch([
    d.prepare(
      `INSERT INTO previews (computer, png, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(computer) DO UPDATE SET png = excluded.png, updated_at = excluded.updated_at`,
    ).bind(name, bytes, now),
    d.prepare(
      `INSERT INTO preview_meta (computer, sha256, bytes, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(computer) DO UPDATE SET sha256 = excluded.sha256,
         bytes = excluded.bytes, updated_at = excluded.updated_at`,
    ).bind(name, sha256, bytes.byteLength, now),
  ]);
  return { ok: true, unchanged: false, sha256, bytes: bytes.byteLength };
}

export async function getPreview(env, name) {
  const d = requireDb(env);
  // Read the blob as hex: D1's JS driver hands a BLOB back in a form that
  // `new Response()` renders as an empty body (the /computer/preview endpoint
  // answered 200 image/png with 0 bytes until this change, even though the
  // row held 500 KB). Hex is a plain string; decoding it here gives real
  // bytes the Response can carry.
  const row = await d.prepare(
    `SELECT hex(png) AS png_hex, updated_at FROM previews WHERE computer = ?`,
  ).bind(name).first();
  if (!row?.png_hex) return null;
  const hex = row.png_hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  // The hash is read from metadata. Hashing 700 KB on every image request is
  // wasted CPU on the hottest byte path in the system; the fallback exists
  // only for rows written before preview_meta was introduced.
  const meta = await previewMeta(env, name);
  const sha = meta?.sha256 ?? await sha256Hex(bytes);
  return { png: bytes, sha256: sha, capturedAt: row.updated_at };
}

// ------------------------------------------------------------------- teach
// Taught skills. Live shape: `teach_skills(id PRIMARY KEY, payload TEXT,
// created_at TEXT)` — the payload is the whole skill as JSON, opaque to the
// store. Pending delivery is "the agent has not acked it yet", which the
// lease-watcher's `/computer/teach/pending` read decides.
//
// Deliberately per-computer in the payload rather than in a column: the live
// table has no computer column, and adding one means redefining a table that
// already holds data (the B-23 class of mistake). The payload carries it.

/** Save one taught skill. Returns the id. */
export async function putTaughtSkill(env, computer, skill) {
  const d = requireDb(env);
  const id = skill.id || `taught-${crypto.randomUUID().slice(0, 8)}`;
  const payload = JSON.stringify({
    id,
    computer,
    name: String(skill.name || "Taught skill").slice(0, 120),
    goal: String(skill.goal || "").slice(0, 500),
    playbook: skill.playbook || {},
    events: Array.isArray(skill.events) ? skill.events.slice(0, 500) : [],
    at: new Date().toISOString(),
    // The delivery rule (B-6): an undelivered skill must expire rather than
    // accumulate forever. A week is long enough for a watcher restart.
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  });
  await d.prepare(
    `INSERT INTO teach_skills (id, payload, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
  ).bind(id, payload, new Date().toISOString()).run();
  return { ok: true, id };
}

/**
 * Undelivered skills for a computer, newest first.
 *
 * Bounded on purpose (B-6): the old `__pending-skills` was an N+1 KV read loop
 * with no TTL that grew without bound. This is one indexed SELECT with a LIMIT
 * and an expiry filter, so a dead watcher cannot pile up work it will never
 * drain.
 */
export async function listTaughtSkills(env, computer, limit = 20) {
  const d = requireDb(env);
  const res = await d.prepare(
    `SELECT id, payload, created_at FROM teach_skills ORDER BY created_at DESC LIMIT ?`,
  ).bind(Math.max(1, Math.min(100, limit))).all();
  const now = Date.now();
  const out = [];
  for (const row of res.results || []) {
    let parsed = null;
    try { parsed = JSON.parse(row.payload); } catch { continue; }
    if (!parsed) continue;
    if (parsed.computer && parsed.computer !== computer) continue;
    if (parsed.expiresAt && Date.parse(parsed.expiresAt) < now) continue;
    out.push(parsed);
  }
  return out;
}

/** Delete a taught skill (used by the ack path and by cleanup). */
export async function deleteTaughtSkill(env, id) {
  const d = requireDb(env);
  await d.prepare(`DELETE FROM teach_skills WHERE id = ?`).bind(id).run();
  return { ok: true };
}
