// D1-backed store with a KV-shaped interface.
//
// createStore(env, kv) returns { get, put, delete, list } with the same
// shapes the Workers already use against a KVNamespace, so call sites
// change only the binding source (env.DESKTOP_KV / env.STATUS ->
// store(env)) and no handler logic changes.
//
// Backend selection: D1 when env.USE_D1 === "1" AND env.QWENPAW_DB is
// bound; otherwise the KV namespace passed in (the fallback). The
// routing table is features/storage/SCHEMA.md.
//
// Notes:
// - Previews are base64 strings at this interface (call sites
//   unchanged); the store decodes to raw bytes for the D1 BLOB column
//   and encodes back on read.
// - routines:history put is a DIFF, not a full replace: the caller
//   only ever appends one tick, so the store inserts the entries
//   newer than the stored max `at` and prunes to 50 rows. A full
//   replace would be 51 statements for a 50-entry history and would
//   exceed D1's 50-queries-per-invocation free limit.
// - routines:pending reads enforce expiry (D1 has no TTL): rows with
//   expires_at <= now are treated as missing and deleted lazily.
// - Unknown keys fall through to the `meta` table (plain text), so a
//   future key works without a schema change.
// - The budget counter is a plain upsert of the value the guard
//   computed (the guard already bounds flushes); an atomic SQL
//   increment is a follow-up (see SCHEMA.md).

export function createStore(env, kv) {
  const useD1 = env && env.USE_D1 === "1" && env.QWENPAW_DB;
  if (!useD1) {
    // No store at all (KV unbound and no D1): return null so callers
    // that check for a bound store keep their 503 path.
    if (!kv) return null;
    return kvStore(kv);
  }
  return d1Store(env.QWENPAW_DB);
}

function kvStore(kv) {
  return {
    get: async (key, type) => {
      const v = await kv.get(key);
      if (type === "json") {
        if (v === null || v === undefined) return null;
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    put: (key, value, opts) => kv.put(key, value, opts),
    delete: (key) => kv.delete(key),
    list: (opts) => kv.list(opts),
  };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function splitKey(key) {
  const i = key.indexOf(":");
  return i === -1 ? [key, ""] : [key.slice(0, i), key.slice(i + 1)];
}

function d1Store(db) {
  const q = (sql, ...params) => db.prepare(sql).bind(...params);
  async function get(key, type) {
    const v = await getText(key);
    if (type === "json") {
      if (v === null || v === undefined) return null;
      try { return JSON.parse(v); } catch { return null; }
    }
    return v;
  }

  async function getText(key) {
    const [head, rest] = splitKey(key);
    if (head === "lease") {
      const row = await q("SELECT lease_id, holder, granted_at, expires_at, fence FROM leases WHERE computer = ?", rest).first();
      return row ? JSON.stringify({ leaseId: row.lease_id, holder: row.holder, grantedAt: row.granted_at, expiresAt: row.expires_at, fence: row.fence }) : null;
    }
    if (head === "generation") {
      const row = await q("SELECT gen FROM generations WHERE computer = ?", rest).first();
      return row ? String(row.gen) : null;
    }
    if (head === "needsyou") {
      const computer = rest || "default";
      const row = await q("SELECT text, at, run_id FROM needs_you WHERE computer = ?", computer).first();
      return row ? JSON.stringify({ text: row.text, at: row.at, runId: row.run_id }) : null;
    }
    if (head === "preview") {
      const row = await q("SELECT png FROM previews WHERE computer = ?", rest).first();
      return row && row.png ? bytesToB64(row.png) : null;
    }
    if (head === "teach-skill") {
      const row = await q("SELECT payload FROM teach_skills WHERE id = ?", rest).first();
      return row ? row.payload : null;
    }
    if (head === "computerMode") {
      const row = await q("SELECT mode FROM modes WHERE agent = ?", rest).first();
      return row ? row.mode : null;
    }
    if (head === "budget") {
      const row = await q("SELECT count FROM write_budget WHERE day = ?", rest).first();
      return row ? String(row.count) : null;
    }
    if (key === "lastWake" || key === "routines:last-trigger-at") {
      const row = await q("SELECT value FROM meta WHERE key = ?", key).first();
      return row ? row.value : null;
    }
    if (key === "qwenpaw:status") {
      const row = await q("SELECT value FROM status WHERE key = ?", key).first();
      return row ? row.value : null;
    }
    if (key === "routines:history") {
      const res = await q("SELECT raw FROM routines_history ORDER BY id ASC").all();
      const entries = (res.results || []).map((r) => {
        try { return JSON.parse(r.raw); } catch { return null; }
      }).filter(Boolean);
      return JSON.stringify(entries);
    }
    if (key === "routines:definitions") {
      const res = await q("SELECT payload FROM routines_definitions").all();
      const defs = (res.results || []).map((r) => {
        try { return JSON.parse(r.payload); } catch { return null; }
      }).filter(Boolean);
      return JSON.stringify(defs);
    }
    if (head === "routines" && rest.startsWith("pending:")) {
      const id = rest.slice("pending:".length);
      const now = Math.floor(Date.now() / 1000);
      const row = await q("SELECT payload FROM routines_pending WHERE id = ? AND expires_at > ?", id, now).first();
      if (!row) {
        // Lazily drop the expired row (D1 has no TTL).
        await q("DELETE FROM routines_pending WHERE id = ? AND expires_at <= ?", id, now).run();
        return null;
      }
      return row.payload;
    }
    // Unknown key: generic text fallback in meta.
    const row = await q("SELECT value FROM meta WHERE key = ?", key).first();
    return row ? row.value : null;
  }

  async function put(key, value, opts) {
    const [head, rest] = splitKey(key);
    if (head === "lease") {
      const v = typeof value === "string" ? JSON.parse(value) : value;
      await q("INSERT INTO leases (computer, lease_id, holder, granted_at, expires_at, fence) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(computer) DO UPDATE SET lease_id=excluded.lease_id, holder=excluded.holder, granted_at=excluded.granted_at, expires_at=excluded.expires_at, fence=excluded.fence",
        rest, v.leaseId, v.holder, v.grantedAt, v.expiresAt, v.fence || 0).run();
      return;
    }
    if (head === "generation") {
      await q("INSERT INTO generations (computer, gen) VALUES (?, ?) ON CONFLICT(computer) DO UPDATE SET gen=excluded.gen", rest, parseInt(value, 10) || 0).run();
      return;
    }
    if (head === "needsyou") {
      const computer = rest || "default";
      const v = typeof value === "string" ? JSON.parse(value) : value;
      await q("INSERT INTO needs_you (computer, text, at, run_id) VALUES (?, ?, ?, ?) ON CONFLICT(computer) DO UPDATE SET text=excluded.text, at=excluded.at, run_id=excluded.run_id",
        computer, v.text, v.at, v.runId || null).run();
      return;
    }
    if (head === "preview") {
      // value is a base64 string at this interface; store raw bytes.
      const bytes = b64ToBytes(value);
      await q("INSERT INTO previews (computer, png, updated_at) VALUES (?, ?, ?) ON CONFLICT(computer) DO UPDATE SET png=excluded.png, updated_at=excluded.updated_at",
        rest, bytes, new Date().toISOString()).run();
      return;
    }
    if (head === "teach-skill") {
      const v = typeof value === "string" ? JSON.parse(value) : value;
      await q("INSERT INTO teach_skills (id, payload, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at",
        rest, typeof value === "string" ? value : JSON.stringify(value), v.at || new Date().toISOString()).run();
      return;
    }
    if (head === "computerMode") {
      await q("INSERT INTO modes (agent, mode) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET mode=excluded.mode", rest, String(value)).run();
      return;
    }
    if (head === "budget") {
      await q("INSERT INTO write_budget (day, count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET count=excluded.count", rest, parseInt(value, 10) || 0).run();
      return;
    }
    if (key === "lastWake" || key === "routines:last-trigger-at") {
      await q("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(value)).run();
      return;
    }
    if (key === "qwenpaw:status") {
      await q("INSERT INTO status (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, typeof value === "string" ? value : JSON.stringify(value)).run();
      return;
    }
    if (key === "routines:history") {
      const entries = typeof value === "string" ? JSON.parse(value) : value;
      // Diff, not full replace (see the header note): insert only the
      // entries newer than the stored max `at`, then prune to 50.
      const latest = await q("SELECT MAX(at) AS m FROM routines_history").first();
      const maxAt = latest && latest.m ? latest.m : "";
      const fresh = entries.filter((e) => e && e.at && e.at > maxAt);
      if (fresh.length) {
        const stmts = fresh.map((e) => q(
          "INSERT INTO routines_history (at, kind, qwenpaw, http_status, note, active_routines, raw) VALUES (?, ?, ?, ?, ?, ?, ?)",
          e.at, e.kind, e.qwenpaw, e.httpStatus ?? null, e.note ?? null, JSON.stringify(e.activeRoutines || []), JSON.stringify(e)));
        await db.batch(stmts);
      }
      await q("DELETE FROM routines_history WHERE id NOT IN (SELECT id FROM routines_history ORDER BY id DESC LIMIT 50)").run();
      return;
    }
    if (key === "routines:definitions") {
      const defs = typeof value === "string" ? JSON.parse(value) : value;
      const stmts = [q("DELETE FROM routines_definitions")];
      for (const r of defs) stmts.push(q("INSERT INTO routines_definitions (id, payload) VALUES (?, ?)", r.id, JSON.stringify(r)));
      await db.batch(stmts);
      return;
    }
    if (head === "routines" && rest.startsWith("pending:")) {
      const id = rest.slice("pending:".length);
      const ttl = (opts && opts.expirationTtl) || 7 * 86400;
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      await q("INSERT INTO routines_pending (id, payload, expires_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at",
        id, typeof value === "string" ? value : JSON.stringify(value), expiresAt).run();
      return;
    }
    // Unknown key: generic text fallback in meta.
    await q("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(value)).run();
  }

  async function del(key) {
    const [head, rest] = splitKey(key);
    if (head === "lease") { await q("DELETE FROM leases WHERE computer = ?", rest).run(); return; }
    if (head === "generation") { await q("DELETE FROM generations WHERE computer = ?", rest).run(); return; }
    if (head === "needsyou") { await q("DELETE FROM needs_you WHERE computer = ?", rest || "default").run(); return; }
    if (head === "preview") { await q("DELETE FROM previews WHERE computer = ?", rest).run(); return; }
    if (head === "teach-skill") { await q("DELETE FROM teach_skills WHERE id = ?", rest).run(); return; }
    if (head === "computerMode") { await q("DELETE FROM modes WHERE agent = ?", rest).run(); return; }
    if (head === "budget") { await q("DELETE FROM write_budget WHERE day = ?", rest).run(); return; }
    if (key === "lastWake" || key === "routines:last-trigger-at") { await q("DELETE FROM meta WHERE key = ?", key).run(); return; }
    if (key === "qwenpaw:status") { await q("DELETE FROM status WHERE key = ?", key).run(); return; }
    if (key === "routines:history") { await q("DELETE FROM routines_history").run(); return; }
    if (key === "routines:definitions") { await q("DELETE FROM routines_definitions").run(); return; }
    if (head === "routines" && rest.startsWith("pending:")) { await q("DELETE FROM routines_pending WHERE id = ?", rest.slice("pending:".length)).run(); return; }
    await q("DELETE FROM meta WHERE key = ?", key).run();
  }

  async function list(opts) {
    const prefix = (opts && opts.prefix) || "";
    if (prefix === "teach-skill:") {
      const res = await q("SELECT id FROM teach_skills").all();
      return { keys: (res.results || []).map((r) => ({ name: "teach-skill:" + r.id })) };
    }
    if (prefix === "routines:pending:") {
      const now = Math.floor(Date.now() / 1000);
      const res = await q("SELECT id FROM routines_pending WHERE expires_at > ?", now).all();
      return { keys: (res.results || []).map((r) => ({ name: "routines:pending:" + r.id })) };
    }
    const res = await q("SELECT key FROM meta WHERE key LIKE ? || '%'", prefix).all();
    return { keys: (res.results || []).map((r) => ({ name: r.key })) };
  }

  return { get, put, delete: del, list };
}
