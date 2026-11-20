// Multi-PC computer registry — Rakazo-style "one computer per bot", fitted
// to QwenPaw's ONE InstaBox Free machine.
//
// Why this exists (E1): QwenPaw's Computer surface was a single shared
// desktop with a hardcoded two-name list (`state.js` COMPUTERS =
// ["default","qa"]). Rakazo's model is one computer PER BOT, created on
// demand, listed and switched in the UI. This module rebuilds that model
// under the hard constraint that InstaBox Free is ONE machine (4 vCPU /
// 8 GiB / 20 GiB): every PC is a display + noVNC port ON THAT MACHINE, drawn
// from the existing websockify port pool 6080-6085. No second machine, no
// paid plan.
//
// Mapping Rakazo -> here:
//   Rakazo                          QwenPaw (this module)
//   ------------------------------- --------------------------------------
//   Computer row per bot            `computers` row keyed by name, unique bot_id
//   provider.provision({botId})     obtainForBot(botId) -> existing row or create
//   sandbox port publish (6100)     vnc_port from the fixed pool 6080-6085
//   display index (20, 21, ...)     X display :1..:6 (port - 6079)
//   ComputerStatus                  status: asleep | running | booting
//   list/switch in the side panel   listComputers / setActive
//
// Storage is the same D1 database the rest of the Computer surface uses
// (`env.COMPUTER_DB`), so no new infrastructure is introduced.
//
// Port maths: 6080 maps to display :1, 6081 to :2, ... 6085 to :6. The
// existing machine already runs websockify on 6080-6085 and Xvfb on :1/:2,
// so a PC's `vnc_port` + `display` are directly usable by the machine-side
// provisioner without renumbering anything.

/** The fixed noVNC port pool on the single InstaBox machine. */
export const VNC_PORT_MIN = 6080;
export const VNC_PORT_MAX = 6085;
/** Hard cap: one machine, six noVNC ports. This is the whole reason the
 *  registry refuses to over-allocate rather than erroring downstream. */
export const MAX_PCS = VNC_PORT_MAX - VNC_PORT_MIN + 1;

/** Valid PC statuses (mirrors Rakazo's ComputerStatus, trimmed to what the
 *  one-machine model can actually be in). */
export const STATUSES = ["asleep", "booting", "running"];

const D1_BUSY = " SQLITE_BUSY ";

function db(env) {
  const d = env && env.COMPUTER_DB;
  if (!d) throw new Error("COMPUTER_DB binding is missing (expected qwenpaw-state)");
  return d;
}

export function displayForPort(port) {
  return ":" + (port - VNC_PORT_MIN + 1);
}

/** Create the registry tables if missing. Idempotent. */
export async function ensureSchema(env) {
  const d = db(env);
  await d
    .prepare(
      `CREATE TABLE IF NOT EXISTS pcs (
         name       TEXT PRIMARY KEY,
         bot_id     TEXT NOT NULL UNIQUE,
         vnc_port   INTEGER NOT NULL UNIQUE,
         display    TEXT NOT NULL,
         status     TEXT NOT NULL DEFAULT 'asleep',
         active     INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL
       )`,
    )
    .run();
  return true;
}

let schemaReady = false;
async function ready(env) {
  if (schemaReady) return;
  await ensureSchema(env);
  schemaReady = true;
}

function rowToPc(row) {
  return {
    name: row.name,
    botId: row.bot_id,
    vncPort: row.vnc_port,
    display: row.display,
    status: row.status,
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

/** List every PC, active first then by creation order. */
export async function listComputers(env) {
  await ready(env);
  const d = db(env);
  const { results } = await d
    .prepare(`SELECT * FROM pcs ORDER BY active DESC, created_at ASC, name ASC`)
    .all();
  return (results ?? []).map(rowToPc);
}

/** One PC by name, or null. */
export async function getComputer(env, name) {
  await ready(env);
  const d = db(env);
  const row = await d.prepare(`SELECT * FROM pcs WHERE name = ?`).bind(name).first();
  return row ? rowToPc(row) : null;
}

/** The PC a bot owns, or null. One PC per bot is enforced by the schema. */
export async function getForBot(env, botId) {
  await ready(env);
  const d = db(env);
  const row = await d.prepare(`SELECT * FROM pcs WHERE bot_id = ?`).bind(botId).first();
  return row ? rowToPc(row) : null;
}

/** The currently active PC (for the switcher), or null. */
export async function getActive(env) {
  await ready(env);
  const d = db(env);
  const row = await d.prepare(`SELECT * FROM pcs WHERE active = 1 LIMIT 1`).first();
  return row ? rowToPc(row) : null;
}

/** Count of allocated ports — used to enforce the one-machine cap. */
async function countPcs(d) {
  const row = await d.prepare(`SELECT COUNT(*) AS n FROM pcs`).first();
  return row?.n ?? 0;
}

/** Pick a free port from the pool. Fails closed when the machine is full. */
async function allocatePort(d) {
  const taken = new Set();
  const { results } = await d.prepare(`SELECT vnc_port FROM pcs`).all();
  for (const r of results ?? []) taken.add(r.vnc_port);
  for (let p = VNC_PORT_MIN; p <= VNC_PORT_MAX; p++) {
    if (!taken.has(p)) return p;
  }
  return null;
}

/**
 * Create a PC. One per bot: a bot that already owns a PC gets that PC back
 * (Rakazo's provision is idempotent per bot), never a second one.
 *
 * Returns { ok: true, pc, created } or { ok: false, reason }.
 *   reasons: "invalid_name" | "invalid_bot" | "exists_name" | "machine_full"
 */
export async function createComputer(env, { name, botId, status = "asleep" } = {}) {
  await ready(env);
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
    return { ok: false, reason: "invalid_name" };
  }
  if (typeof botId !== "string" || botId.length === 0 || botId.length > 128) {
    return { ok: false, reason: "invalid_bot" };
  }
  const wantStatus = STATUSES.includes(status) ? status : "asleep";
  const d = db(env);

  const existingByName = await getComputer(env, name);
  if (existingByName) {
    // Idempotent per (name, bot): re-creating the same bot's PC is a no-op.
    if (existingByName.botId === botId) return { ok: true, pc: existingByName, created: false };
    return { ok: false, reason: "exists_name" };
  }
  const existingForBot = await getForBot(env, botId);
  if (existingForBot) return { ok: true, pc: existingForBot, created: false };

  // The one-machine cap. Checked before the insert so a full machine reads
  // as a clean refusal, not as a port-collision error.
  if ((await countPcs(d)) >= MAX_PCS) return { ok: false, reason: "machine_full" };

  const port = await allocatePort(d);
  if (port === null) return { ok: false, reason: "machine_full" };

  // Mark any previous active as inactive only when this is the first PC;
  // otherwise the newest PC becomes the active one (switch-on-create, which
  // is what the UI's create flow wants).
  const isFirst = (await countPcs(d)) === 0;
  const makeActive = isFirst ? 1 : 0;

  try {
    await d
      .prepare(
        `INSERT INTO pcs (name, bot_id, vnc_port, display, status, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(name, botId, port, displayForPort(port), wantStatus, makeActive, new Date().toISOString())
      .run();
  } catch (e) {
    // A concurrent create racing the UNIQUE(bot_id)/UNIQUE(vnc_port) is the
    // same outcome as the pre-checks: report it as a refusal, not a 500.
    if (String(e).includes(D1_BUSY) || /UNIQUE/i.test(String(e))) {
      return { ok: false, reason: "exists_name" };
    }
    throw e;
  }

  if (makeActive) await setActive(env, name);
  const pc = await getComputer(env, name);
  return { ok: true, pc, created: true };
}

/**
 * Rakazo's provision: return the bot's PC, creating it if the bot has none.
 * This is the single entry point the router's "open this bot's computer"
 * path should call.
 */
export async function obtainForBot(env, botId, opts = {}) {
  const existing = await getForBot(env, botId);
  if (existing) return { ok: true, pc: existing, created: false };
  // Derive a stable, URL-safe PC name from the bot id.
  const slug = String(botId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const name = (slug || "bot") + "-pc";
  return createComputer(env, { name, botId, status: opts.status });
}

/** Set the active PC (the one the switcher shows). */
export async function setActive(env, name) {
  await ready(env);
  const d = db(env);
  const pc = await getComputer(env, name);
  if (!pc) return { ok: false, reason: "not_found" };
  await d.prepare(`UPDATE pcs SET active = 0 WHERE active = 1`).run();
  await d.prepare(`UPDATE pcs SET active = 1 WHERE name = ?`).bind(name).run();
  return { ok: true, pc: await getComputer(env, name) };
}

/** Update a PC's status (asleep | booting | running). */
export async function setStatus(env, name, status) {
  await ready(env);
  if (!STATUSES.includes(status)) return { ok: false, reason: "invalid_status" };
  const d = db(env);
  const r = await d.prepare(`UPDATE pcs SET status = ? WHERE name = ?`).bind(status, name).run();
  if (!r.meta?.changes) return { ok: false, reason: "not_found" };
  return { ok: true, pc: await getComputer(env, name) };
}

/** Delete a PC and return its port to the pool. */
export async function deleteComputer(env, name) {
  await ready(env);
  const d = db(env);
  const r = await d.prepare(`DELETE FROM pcs WHERE name = ?`).bind(name).run();
  if (!r.meta?.changes) return { ok: false, reason: "not_found" };
  return { ok: true };
}
