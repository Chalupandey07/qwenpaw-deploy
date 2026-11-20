// Tests for the multi-PC computer registry (E1) — features/computer/multi-pc/registry.js
//
// Rakazo's model, fitted to ONE InstaBox machine: one computer per bot, each
// bound to a noVNC port from the fixed 6080-6085 pool (6 PCs max). These tests
// pin the behaviours the router and the UI depend on: port allocation and the
// one-machine cap, one-PC-per-bot idempotency, active switching, status
// transitions, and port reuse after a delete.
//
// Run: node features/computer/multi-pc/test-registry.mjs

import { strict as assert } from "node:assert";
import {
  VNC_PORT_MIN,
  VNC_PORT_MAX,
  MAX_PCS,
  displayForPort,
  ensureSchema,
  listComputers,
  getComputer,
  getForBot,
  getActive,
  createComputer,
  obtainForBot,
  setActive,
  setStatus,
  deleteComputer,
} from "../../../pages/public/computer/registry.js";

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
    pass += 1;
  } catch (e) {
    console.log(`FAIL ${name} -- ${e.message}`);
    fail += 1;
  }
};

// ---------------------------------------------------------------------------
// Minimal in-memory D1 stub. It understands exactly the statements the
// registry issues; anything else throws so a typo in the SQL shows up as a
// test failure rather than as a silent no-op.
// ---------------------------------------------------------------------------
function makeD1() {
  const pcs = new Map(); // name -> row

  const exec = (sql, args = []) => {
    const s = sql.replace(/\s+/g, " ").trim();

    if (/^CREATE TABLE IF NOT EXISTS pcs/.test(s)) return { changes: 0 };

    if (/^SELECT \* FROM pcs ORDER BY active DESC/.test(s)) {
      const rows = [...pcs.values()].sort(
        (a, b) => b.active - a.active || a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name),
      );
      return { results: rows };
    }
    if (/^SELECT \* FROM pcs WHERE name = \?/.test(s)) {
      return { first: () => pcs.get(args[0]) ?? null };
    }
    if (/^SELECT \* FROM pcs WHERE bot_id = \?/.test(s)) {
      return { first: () => [...pcs.values()].find((r) => r.bot_id === args[0]) ?? null };
    }
    if (/^SELECT \* FROM pcs WHERE active = 1 LIMIT 1/.test(s)) {
      return { first: () => [...pcs.values()].find((r) => r.active === 1) ?? null };
    }
    if (/^SELECT COUNT\(\*\) AS n FROM pcs/.test(s)) {
      return { first: () => ({ n: pcs.size }) };
    }
    if (/^SELECT vnc_port FROM pcs/.test(s)) {
      return { results: [...pcs.values()].map((r) => ({ vnc_port: r.vnc_port })) };
    }
    if (/^INSERT INTO pcs/.test(s)) {
      const [name, bot_id, vnc_port, display, status, active, created_at] = args;
      if (pcs.has(name)) throw new Error("UNIQUE constraint failed: pcs.name");
      if ([...pcs.values()].some((r) => r.bot_id === bot_id))
        throw new Error("UNIQUE constraint failed: pcs.bot_id");
      if ([...pcs.values()].some((r) => r.vnc_port === vnc_port))
        throw new Error("UNIQUE constraint failed: pcs.vnc_port");
      pcs.set(name, { name, bot_id, vnc_port, display, status, active, created_at });
      return { changes: 1 };
    }
    if (/^UPDATE pcs SET active = 0 WHERE active = 1/.test(s)) {
      let n = 0;
      for (const r of pcs.values()) if (r.active === 1) { r.active = 0; n += 1; }
      return { changes: n };
    }
    if (/^UPDATE pcs SET active = 1 WHERE name = \?/.test(s)) {
      const r = pcs.get(args[0]);
      if (!r) return { changes: 0 };
      r.active = 1;
      return { changes: 1 };
    }
    if (/^UPDATE pcs SET status = \? WHERE name = \?/.test(s)) {
      const r = pcs.get(args[1]);
      if (!r) return { changes: 0 };
      r.status = args[0];
      return { changes: 1 };
    }
    if (/^DELETE FROM pcs WHERE name = \?/.test(s)) {
      return { changes: pcs.delete(args[0]) ? 1 : 0 };
    }
    throw new Error("mock D1 does not understand: " + sql);
  };

  return {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => exec(sql, args).first?.() ?? null,
        all: async () => exec(sql, args),
        run: async () => exec(sql, args),
      }),
      first: async () => exec(sql, []).first?.() ?? null,
      all: async () => exec(sql, []),
      run: async () => exec(sql, []),
    }),
  };
}

const freshEnv = () => ({ COMPUTER_DB: makeD1() });

// ---------------------------------------------------------------------------

check("port pool is 6080-6085 => 6 PCs on the one machine", () => {
  assert.equal(VNC_PORT_MIN, 6080);
  assert.equal(VNC_PORT_MAX, 6085);
  assert.equal(MAX_PCS, 6);
});

check("display maps from port (:1..:6)", () => {
  assert.equal(displayForPort(6080), ":1");
  assert.equal(displayForPort(6085), ":6");
});

check("create allocates the lowest free port and a matching display", async () => {
  const env = freshEnv();
  const r = await createComputer(env, { name: "alpha-pc", botId: "bot-a" });
  assert.ok(r.ok, "create should succeed");
  assert.equal(r.created, true);
  assert.equal(r.pc.vncPort, 6080);
  assert.equal(r.pc.display, ":1");
  assert.equal(r.pc.status, "asleep");
});

check("second create takes the next port", async () => {
  const env = freshEnv();
  await createComputer(env, { name: "alpha-pc", botId: "bot-a" });
  const r = await createComputer(env, { name: "beta-pc", botId: "bot-b" });
  assert.equal(r.pc.vncPort, 6081);
  assert.equal(r.pc.display, ":2");
});

check("create is idempotent for the same name+bot", async () => {
  const env = freshEnv();
  const a = await createComputer(env, { name: "alpha-pc", botId: "bot-a" });
  const b = await createComputer(env, { name: "alpha-pc", botId: "bot-a" });
  assert.equal(b.ok, true);
  assert.equal(b.created, false);
  assert.equal(b.pc.name, a.pc.name);
  assert.equal(b.pc.vncPort, a.pc.vncPort);
});

check("same name with a DIFFERENT bot is refused (exists_name)", async () => {
  const env = freshEnv();
  await createComputer(env, { name: "alpha-pc", botId: "bot-a" });
  const r = await createComputer(env, { name: "alpha-pc", botId: "bot-b" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "exists_name");
});

check("one PC per bot: a bot that already owns one gets it back, not a second", async () => {
  const env = freshEnv();
  const a = await createComputer(env, { name: "alpha-pc", botId: "bot-a" });
  const again = await obtainForBot(env, "bot-a");
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.pc.name, a.pc.name);
  const all = await listComputers(env);
  assert.equal(all.length, 1, "must not create a second PC for the same bot");
});

check("obtainForBot creates a slug-named PC for a new bot", async () => {
  const env = freshEnv();
  const r = await obtainForBot(env, "QwenPaw QA Agent");
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.pc.name, "qwenpaw-qa-agent-pc");
  assert.equal(r.pc.botId, "QwenPaw QA Agent");
});

check("hard cap: the 7th PC is refused (machine_full) — one machine, six ports", async () => {
  const env = freshEnv();
  for (let i = 0; i < MAX_PCS; i++) {
    const r = await createComputer(env, { name: `pc-${i}`, botId: `bot-${i}` });
    assert.ok(r.ok, `PC ${i} should allocate`);
  }
  const over = await createComputer(env, { name: "pc-6", botId: "bot-6" });
  assert.equal(over.ok, false);
  assert.equal(over.reason, "machine_full");
});

check("deleting a PC returns its port to the pool", async () => {
  const env = freshEnv();
  for (let i = 0; i < MAX_PCS; i++) await createComputer(env, { name: `pc-${i}`, botId: `bot-${i}` });
  assert.equal((await createComputer(env, { name: "pc-x", botId: "bot-x" })).reason, "machine_full");
  const del = await deleteComputer(env, "pc-3");
  assert.equal(del.ok, true);
  const reuse = await createComputer(env, { name: "pc-x", botId: "bot-x" });
  assert.equal(reuse.ok, true, "a freed port must be reusable");
  assert.equal(reuse.pc.vncPort, 6083, "the freed port (6080+3) is reused");
});

check("invalid names and bot ids are refused before touching the store", async () => {
  const env = freshEnv();
  assert.equal((await createComputer(env, { name: "Bad Name", botId: "b" })).reason, "invalid_name");
  assert.equal((await createComputer(env, { name: "-lead", botId: "b" })).reason, "invalid_name");
  assert.equal((await createComputer(env, { name: "ok-name", botId: "" })).reason, "invalid_bot");
  assert.equal((await createComputer(env, { name: "ok-name" })).reason, "invalid_bot");
});

check("first PC becomes active; setActive switches the active PC", async () => {
  const env = freshEnv();
  const a = await createComputer(env, { name: "alpha-pc", botId: "bot-a" });
  assert.equal((await getActive(env)).name, "alpha-pc", "first PC is active by default");
  await createComputer(env, { name: "beta-pc", botId: "bot-b" });
  assert.equal((await getActive(env)).name, "alpha-pc", "creating a second PC does not steal active");
  const sw = await setActive(env, "beta-pc");
  assert.equal(sw.ok, true);
  assert.equal((await getActive(env)).name, "beta-pc");
  assert.equal(a.pc.name, "alpha-pc");
});

check("setActive on an unknown PC is refused", async () => {
  const env = freshEnv();
  assert.equal((await setActive(env, "nope")).reason, "not_found");
});

check("setStatus transitions and validates", async () => {
  const env = freshEnv();
  await createComputer(env, { name: "alpha-pc", botId: "bot-a" });
  assert.equal((await setStatus(env, "alpha-pc", "booting")).pc.status, "booting");
  assert.equal((await setStatus(env, "alpha-pc", "running")).pc.status, "running");
  assert.equal((await setStatus(env, "alpha-pc", "asleep")).pc.status, "asleep");
  assert.equal((await setStatus(env, "alpha-pc", "flying")).reason, "invalid_status");
  assert.equal((await setStatus(env, "ghost", "running")).reason, "not_found");
});

check("listComputers puts the active PC first", async () => {
  const env = freshEnv();
  await createComputer(env, { name: "alpha-pc", botId: "bot-a" });
  await createComputer(env, { name: "beta-pc", botId: "bot-b" });
  await setActive(env, "beta-pc");
  const all = await listComputers(env);
  assert.equal(all[0].name, "beta-pc");
  assert.equal(all.length, 2);
});

check("getComputer / getForBot return null for unknowns", async () => {
  const env = freshEnv();
  assert.equal(await getComputer(env, "ghost"), null);
  assert.equal(await getForBot(env, "ghost"), null);
  assert.equal(await getActive(env), null);
});

check("schema is idempotent", async () => {
  const env = freshEnv();
  await ensureSchema(env);
  await ensureSchema(env);
  assert.ok(true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
