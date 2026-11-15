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
  const prev = await d.prepare(`SELECT png FROM previews WHERE computer = ?`).bind(name).first();
  // The preview hash is derived, not stored: the live `previews` table holds
  // only the bytes. Hashing here keeps the record self-describing and costs
  // nothing on a row that is already loaded.
  let sha = null;
  if (prev?.png) sha = await sha256Hex(prev.png);
  return {
    computer: row.computer, text: row.text, runId: row.run_id,
    createdAt: row.at, previewSha: sha,
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
  const prev = await d.prepare(`SELECT png FROM previews WHERE computer = ?`).bind(name).first();
  if (prev?.png) {
    const prevSha = await sha256Hex(prev.png);
    if (prevSha === sha256) return { ok: true, unchanged: true, sha256 };
  }
  await d.prepare(
    `INSERT INTO previews (computer, png, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(computer) DO UPDATE SET png = excluded.png, updated_at = excluded.updated_at`,
  ).bind(name, bytes, new Date().toISOString()).run();
  return { ok: true, unchanged: false, sha256, bytes: bytes.byteLength };
}

export async function getPreview(env, name) {
  const d = requireDb(env);
  const row = await d.prepare(
    `SELECT png, updated_at FROM previews WHERE computer = ?`,
  ).bind(name).first();
  if (!row?.png) return null;
  const sha = await sha256Hex(row.png);
  return { png: row.png, sha256: sha, capturedAt: row.updated_at };
}
