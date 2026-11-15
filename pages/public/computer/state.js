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
// D1 gives us the one thing KV could not: a single atomic UPDATE ... WHERE, so
// two tabs racing for control cannot both win.

export const LEASE_TTL_MS = 90_000;
export const LEASE_HEARTBEAT_MS = 15_000;
/** A capability may outlive its lease by this much, for a heartbeat in flight. */
export const LEASE_CAP_GRACE_MS = 30_000;

export const COMPUTERS = ["default", "qa"];

function sql(env) {
  return env.COMPUTER_DB;
}

async function ensureSchema(env) {
  // Idempotent. The migration also creates these; doing it here means a fresh
  // database works without a separate migrate step, which is one less thing
  // for a deploy to forget.
  const db = sql(env);
  if (!db) throw new Error("COMPUTER_DB binding is missing");
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS computer (
      name TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'team',
      updated_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS computer_lease (
      computer TEXT PRIMARY KEY, lease_id TEXT NOT NULL, holder TEXT NOT NULL,
      granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, fence INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS computer_needs_you (
      id INTEGER PRIMARY KEY AUTOINCREMENT, computer TEXT NOT NULL, text TEXT NOT NULL,
      run_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT, action TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS computer_preview (
      computer TEXT PRIMARY KEY, png BLOB, sha256 TEXT, bytes INTEGER, captured_at TEXT NOT NULL)`),
  ]);
  for (const name of COMPUTERS) {
    await db.prepare(
      `INSERT INTO computer (name, generation, mode, updated_at) VALUES (?, 0, 'team', ?)
       ON CONFLICT(name) DO NOTHING`,
    ).bind(name, new Date().toISOString()).run();
  }
}

export async function getComputer(env, name) {
  await ensureSchema(env);
  const row = await sql(env).prepare(`SELECT name, generation, mode FROM computer WHERE name = ?`)
    .bind(name).first();
  return row || { name, generation: 0, mode: "team" };
}

export async function getLease(env, name) {
  await ensureSchema(env);
  const row = await sql(env).prepare(
    `SELECT computer, lease_id, holder, granted_at, expires_at, fence
     FROM computer_lease WHERE computer = ?`,
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
  await ensureSchema(env);
  const db = sql(env);
  const now = Date.now();
  const leaseId = crypto.randomUUID();
  const expiresAt = now + LEASE_TTL_MS;

  const res = await db.prepare(
    `INSERT INTO computer_lease (computer, lease_id, holder, granted_at, expires_at, fence)
     VALUES (?1, ?2, ?3, ?4, ?5, 1)
     ON CONFLICT(computer) DO UPDATE SET
       lease_id = excluded.lease_id, holder = excluded.holder,
       granted_at = excluded.granted_at, expires_at = excluded.expires_at,
       fence = computer_lease.fence + 1
     WHERE computer_lease.expires_at <= ?4
     RETURNING lease_id, expires_at, fence`,
  ).bind(name, leaseId, holder, now, expiresAt).first();

  if (!res) {
    const held = await getLease(env, name);
    return { ok: false, reason: "held", holder: held?.holder, expiresAt: held?.expiresAt };
  }

  // The generation bump is part of the grant. If it fails the grant failed —
  // see the note at the top of this file.
  const gen = await db.prepare(
    `UPDATE computer SET generation = generation + 1, updated_at = ? WHERE name = ? RETURNING generation`,
  ).bind(new Date().toISOString(), name).first();
  if (!gen) return { ok: false, reason: "store" };

  return {
    ok: true,
    generation: gen.generation,
    lease: { computer: name, leaseId: res.lease_id, holder, grantedAt: now,
             expiresAt: res.expires_at, fence: res.fence, live: true },
  };
}

export async function heartbeat(env, name, leaseId) {
  await ensureSchema(env);
  const now = Date.now();
  const res = await sql(env).prepare(
    `UPDATE computer_lease SET expires_at = ?
     WHERE computer = ? AND lease_id = ? AND expires_at > ?
     RETURNING lease_id, expires_at`,
  ).bind(now + LEASE_TTL_MS, name, leaseId, now).first();
  if (!res) return { ok: false, reason: "not_held" };
  return { ok: true, leaseId: res.lease_id, expiresAt: res.expires_at };
}

export async function release(env, name, leaseId) {
  await ensureSchema(env);
  const db = sql(env);
  // Naming the lease is what stops a late release from an old page ending
  // newer control.
  const res = await db.prepare(
    `DELETE FROM computer_lease WHERE computer = ? AND lease_id = ? RETURNING lease_id`,
  ).bind(name, leaseId).first();
  if (!res) return { ok: false, reason: "not_holder" };
  const gen = await db.prepare(
    `UPDATE computer SET generation = generation + 1, updated_at = ? WHERE name = ? RETURNING generation`,
  ).bind(new Date().toISOString(), name).first();
  if (!gen) return { ok: false, reason: "store" };
  return { ok: true, generation: gen.generation };
}

/** True when this exact lease is still the live holder. Used on every screen request. */
export async function leaseValid(env, name, leaseId) {
  if (!leaseId) return false;
  const lease = await getLease(env, name);
  return Boolean(lease && lease.live && lease.leaseId === leaseId);
}

export async function setMode(env, name, mode) {
  if (mode !== "team" && mode !== "private") return { ok: false, reason: "bad_mode" };
  await ensureSchema(env);
  await sql(env).prepare(`UPDATE computer SET mode = ?, updated_at = ? WHERE name = ?`)
    .bind(mode, new Date().toISOString(), name).run();
  return { ok: true, mode };
}

// ------------------------------------------------------------------ needs-you

export async function raiseNeedsYou(env, name, text, runId) {
  await ensureSchema(env);
  const db = sql(env);
  // Per computer: one global record meant a :2 request clobbered a :1 banner
  // and the preview showed the wrong screen (BUGS.md B-2).
  await db.prepare(
    `UPDATE computer_needs_you SET resolved_at = ? WHERE computer = ? AND resolved_at IS NULL`,
  ).bind(new Date().toISOString(), name).run();
  const row = await db.prepare(
    `INSERT INTO computer_needs_you (computer, text, run_id, created_at) VALUES (?, ?, ?, ?)
     RETURNING id, created_at`,
  ).bind(name, String(text || "").slice(0, 2000), runId || null, new Date().toISOString()).first();
  return { ok: true, id: row.id, createdAt: row.created_at };
}

export async function openNeedsYou(env, name) {
  await ensureSchema(env);
  const row = await sql(env).prepare(
    `SELECT id, computer, text, run_id, created_at FROM computer_needs_you
     WHERE computer = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1`,
  ).bind(name).first();
  if (!row) return null;
  const prev = await sql(env).prepare(`SELECT sha256 FROM computer_preview WHERE computer = ?`)
    .bind(name).first();
  return {
    id: row.id, computer: row.computer, text: row.text, runId: row.run_id,
    createdAt: row.created_at, previewSha: prev?.sha256 || null,
  };
}

export async function resolveNeedsYou(env, name, action) {
  await ensureSchema(env);
  const row = await sql(env).prepare(
    `UPDATE computer_needs_you SET resolved_at = ?, action = ?
     WHERE computer = ? AND resolved_at IS NULL RETURNING id`,
  ).bind(new Date().toISOString(), String(action || "done").slice(0, 40), name).first();
  return row ? { ok: true, id: row.id } : { ok: false, reason: "none_open" };
}

// ---------------------------------------------------------------- previews

/**
 * Store a preview. The bytes live in D1 as a BLOB because a preview is one
 * small row per computer, overwritten in place — the write amplification that
 * burned the KV quota came from uploading unconditionally, not from storing
 * the result. The row cap is 2 MB and the worker refuses above 1.5 MB.
 */
export async function putPreview(env, name, bytes, sha256) {
  await ensureSchema(env);
  await sql(env).prepare(
    `INSERT INTO computer_preview (computer, png, sha256, bytes, captured_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(computer) DO UPDATE SET
       png = excluded.png, sha256 = excluded.sha256, bytes = excluded.bytes, captured_at = excluded.captured_at
     WHERE computer_preview.sha256 IS NOT excluded.sha256`,
  ).bind(name, bytes, sha256, bytes.byteLength, new Date().toISOString()).run();
  return { ok: true, sha256, bytes: bytes.byteLength };
}

export async function getPreview(env, name) {
  await ensureSchema(env);
  return await sql(env).prepare(
    `SELECT png, sha256, bytes, captured_at FROM computer_preview WHERE computer = ?`,
  ).bind(name).first();
}
