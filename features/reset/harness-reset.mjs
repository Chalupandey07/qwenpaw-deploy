#!/usr/bin/env node
// Settings Reset harness — machine-free test of features/reset/reset-broker.py.
//
// Starts the REAL broker (stdlib Python) on 127.0.0.1:18995 with
// RESET_ROOT=<tmpdir> over a fake tree (fake chats.json, a REAL sqlite
// history.db, screenshots, auth.json, .env, kilo.json, a symlink to /etc),
// then drives it over HTTP. No machine, no Docker, no network.
//
// Usage: node features/reset/harness-reset.mjs [--check <group>]
// Groups: auth, preview, confirm, idempotency, partial, concurrency, happy.
// No --check runs all groups. Prints "reset: N passed, 0 failed" and exits 0
// on pass, 1 on any failure. Fail-first: each check must fail against a
// broker that deletes without confirmation, and pass against the real one.
//
// The allowlist/never-delete guard (auth.json, .env, kilo.json, escaping
// symlink, ../../etc/passwd) is covered by the broker's own --selftest
// (reset-broker.py), which runs the pure guard + categories functions
// against a fake tree — see T-RESET-2.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const BROKER = path.join(__dirname, "reset-broker.py");
const PORT = 18995;
const TOKEN = "test-reset-token-1234567890abcdef";
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? " — " + detail : ""}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function req(p, { token = TOKEN, method = "POST", body = null, headers = {} } = {}) {
  const h = { "Content-Type": "application/json", ...headers };
  if (token) h["X-Reset-Token"] = token;
  const res = await fetch(BASE + p, {
    method,
    headers: h,
    body: body === null ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

// --- fake tree ---
function buildTree(root) {
  const W = path.join(root, "working", "workspaces", "default");
  const QA = path.join(root, "working", "workspaces", "QwenPaw_QA_Agent_0.2");
  const secret = path.join(root, "working.secret");
  const providers = path.join(secret, "providers");
  for (const d of [W, QA, path.join(secret, "providers", "builtin"),
    path.join(secret, "providers", "custom"), path.join(root, "working.backups"),
    path.join(root, "working", "skill_pool"), path.join(W, "skills", "vault"),
    path.join(W, "sessions", "console"), path.join(W, "memory"),
    path.join(W, "mem_agent"), path.join(W, "mem_session"),
    path.join(W, "mem_metadata", "file_catalog"),
    path.join(root, "working", "channel_state"),
    path.join(root, "working", "governance"),
    path.join(root, "working", "logs"),
    path.join(root, "working", "profile")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // Protected files (must survive every category).
  fs.writeFileSync(path.join(secret, "auth.json"), '{"user":"satwik"}');
  fs.writeFileSync(path.join(secret, "vault-broker.token"), "x".repeat(64));
  fs.writeFileSync(path.join(secret, "reset-broker.token"), "y".repeat(64));
  fs.writeFileSync(path.join(providers, "builtin", "kilo.json"),
    JSON.stringify({ id: "kilo", enabled: true, models: [{ id: "kilo-auto/free" }] }));
  fs.writeFileSync(path.join(providers, "active_model.json"),
    JSON.stringify({ provider_id: "mosicn", model: "nex-n2.6" }));
  fs.writeFileSync(path.join(providers, "custom", "mosicn.json"),
    JSON.stringify({ id: "mosicn", enabled: true }));
  fs.writeFileSync(path.join(providers, "custom", "xingchiapi.json"),
    JSON.stringify({ id: "xingchiapi", enabled: true }));
  fs.writeFileSync(path.join(root, ".env"), "RESET_TOKEN=real\n");
  fs.writeFileSync(path.join(root, "working", "governance", "audit.db"), "audit");
  fs.writeFileSync(path.join(root, "working", "logs", "reset.log"), "");
  // Deletable content.
  fs.writeFileSync(path.join(W, "MEMORY.md"),
    "# Memory\n\n## Facts\n\n- x\n\n## Important decisions and lessons\n\n- lesson one\n- lesson two\n");
  fs.writeFileSync(path.join(W, "memory", "note.md"), "memory");
  fs.writeFileSync(path.join(W, "mem_agent", "a.json"), "{}");
  fs.writeFileSync(path.join(W, "mem_session", "s.json"), "{}");
  fs.writeFileSync(path.join(W, "mem_metadata", "file_catalog", "c.json"), "{}");
  fs.writeFileSync(path.join(W, "skill.json"), '{"skills":[]}');
  fs.writeFileSync(path.join(W, "skills", "vault", "SKILL.md"), "# vault");
  fs.writeFileSync(path.join(root, "working", "skill_pool", "skill.json"), "{}");
  fs.writeFileSync(path.join(W, "chats.json"),
    JSON.stringify({ chats: [{ id: "c1", name: "hello" }] }));
  fs.writeFileSync(path.join(W, "sessions", "console", "s1.json"), "{}");
  fs.writeFileSync(path.join(root, "working", "channel_state", "c.json"), "{}");
  fs.writeFileSync(path.join(root, "working", "qwenpaw.log"), "log line\n".repeat(10));
  fs.writeFileSync(path.join(root, "working.backups", "old.txt"), "backup");
  fs.writeFileSync(path.join(W, "agent.json"), "{}");
  fs.writeFileSync(path.join(W, "screenshot.png"), "png");
  fs.writeFileSync(path.join(root, "working", "jobs.json"), "{}");
  fs.writeFileSync(path.join(root, "working", "HEARTBEAT.md"), "# hb");
  // A real sqlite history.db with rows.
  const dbPath = path.join(W, "history.db");
  fs.writeFileSync(dbPath, "");
  // Use python to create a real sqlite DB (node has no sqlite stdlib).
  // Done by the runner before starting the broker (see main).
  // An escaping symlink (must never be followed/deleted).
  try {
    fs.symlinkSync("/etc", path.join(W, "evil-link"));
  } catch {
    // symlink creation may fail on some filesystems; the guard selftest covers it.
  }
  return { W, QA, secret, providers };
}

function treeHash(root) {
  // A cheap content hash of the protected set (names + sizes), for the
  // "nothing changed" assertions. Excludes the broker's own lockfile
  // (working/.reset.lock), which an execute legitimately creates.
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d).sort()) {
      if (name === ".reset.lock") continue;
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(`${p}:${st.size}`);
      else out.push(`${p}:link`);
    }
  };
  walk(root);
  return out.join("|");
}

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(BASE + "/health");
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  return false;
}

async function main() {
  const only = process.argv.includes("--check")
    ? process.argv[process.argv.indexOf("--check") + 1]
    : null;
  const run = (group) => !only || only === group;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reset-harness-"));
  const { W, QA } = buildTree(root);

  // Create a real sqlite history.db with rows (python stdlib).
  const { execFileSync } = await import("node:child_process");
  execFileSync("python3", ["-c",
    "import sqlite3; c=sqlite3.connect(%s); c.execute('CREATE TABLE conversation_history (id INTEGER PRIMARY KEY, text TEXT)'); c.execute(\"INSERT INTO conversation_history (text) VALUES ('hello'), ('world')\"); c.commit(); c.close()"
      .replace("%s", JSON.stringify(path.join(W, "history.db"))),
  ], { stdio: "ignore" });

  const env = {
    ...process.env,
    RESET_TOKEN: TOKEN,
    RESET_BIND: "127.0.0.1",
    RESET_PORT: String(PORT),
    RESET_ROOT: root,
  };
  const broker = spawn("python3", [BROKER], { env, stdio: "ignore" });
  try {
    if (!(await waitHealth())) {
      console.log("reset: broker did not come up");
      process.exit(1);
    }

    const preview = async (cats) => req("/preview", { body: { categories: cats } });
    const execute = async (cats, planId, extra = {}) =>
      req("/execute", {
        body: { categories: cats, confirm: "DELETE", ack: true, plan_id: planId, ...extra },
        headers: { "X-Request-Id": extra.requestId || `req-${Date.now()}-${Math.random()}` },
      });

    // --- auth ---
    if (run("auth")) {
      const anon = await req("/preview", { token: null, body: { categories: [] } });
      check("auth: anon preview -> 401", anon.status === 401, `got ${anon.status}`);
      const wrong = await req("/preview", { token: "wrong-token", body: { categories: [] } });
      check("auth: wrong token preview -> 401", wrong.status === 401, `got ${wrong.status}`);
      const anonEx = await req("/execute", { token: null, body: { categories: [], confirm: "DELETE", ack: true, plan_id: "x" } });
      check("auth: anon execute -> 401", anonEx.status === 401, `got ${anonEx.status}`);
      const bad = await preview(["no-such-category"]);
      check("auth: unknown category -> 400", bad.status === 400, `got ${bad.status}`);
    }

    // --- preview + plan_id ---
    if (run("preview")) {
      const p1 = await preview(["logs", "backups"]);
      check("preview: 200", p1.status === 200, `got ${p1.status}`);
      check("preview: two categories", p1.data && p1.data.categories && p1.data.categories.length === 2);
      check("preview: plan_id present", !!(p1.data && p1.data.plan_id));
      check("preview: logs bytes > 0", p1.data.categories.find((c) => c.id === "logs").bytes > 0);
      const p2 = await preview(["logs", "backups"]);
      check("preview: plan_id stable", p2.data.plan_id === p1.data.plan_id);
      fs.appendFileSync(path.join(root, "working", "qwenpaw.log"), "more\n");
      const p3 = await preview(["logs", "backups"]);
      check("preview: plan_id changes after touching a file", p3.data.plan_id !== p1.data.plan_id);
      const empty = await preview([]);
      check("preview: zero categories -> 200, zero bytes", empty.status === 200 && empty.data.totals.bytes === 0);
      const models = await preview(["models"]);
      check("preview: models excludes the active provider (mosicn)",
        models.data.categories[0].paths.every((p) => !p.endsWith("mosicn.json")) &&
        models.data.categories[0].paths.some((p) => p.endsWith("xingchiapi.json")),
        JSON.stringify(models.data.categories[0].paths));
    }

    // --- confirmation required ---
    if (run("confirm")) {
      const before = treeHash(root);
      const noConfirm = await req("/execute", { body: { categories: ["logs"] } });
      check("confirm: execute without confirm/ack/plan_id -> 400", noConfirm.status === 400, `got ${noConfirm.status}`);
      check("confirm: nothing deleted without confirmation", treeHash(root) === before);
      const p = await preview(["logs"]);
      const stale = await execute(["logs"], "0".repeat(64));
      check("confirm: stale plan_id -> 409 plan_changed", stale.status === 409 && stale.data.error === "plan_changed", `got ${stale.status} ${JSON.stringify(stale.data)}`);
      check("confirm: nothing deleted on stale plan", treeHash(root) === before);
      const wrongConfirm = await req("/execute", { body: { categories: ["logs"], confirm: "delete", ack: true, plan_id: p.data.plan_id } });
      check("confirm: lowercase confirm -> 400", wrongConfirm.status === 400, `got ${wrongConfirm.status}`);
    }

    // --- idempotency ---
    if (run("idempotency")) {
      const p = await preview(["logs"]);
      const rid = `idem-${Date.now()}`;
      const r1 = await execute(["logs"], p.data.plan_id, { requestId: rid });
      check("idempotency: first execute ok", r1.status === 200, `got ${r1.status} ${JSON.stringify(r1.data)}`);
      check("idempotency: log file gone", !fs.existsSync(path.join(root, "working", "qwenpaw.log")));
      const r2 = await execute(["logs"], p.data.plan_id, { requestId: rid });
      check("idempotency: same request id returns cached report", r2.status === 200 && r2.data.request_id === rid, `got ${r2.status}`);
      check("idempotency: cached report deletes nothing new", r2.data.totals.bytes_freed === r1.data.totals.bytes_freed);
      const p2 = await preview(["logs"]);
      const r3 = await execute(["logs"], p2.data.plan_id, { requestId: `idem2-${Date.now()}` });
      check("idempotency: re-run is ok with nothing to delete", r3.status === 200 && r3.data.totals.bytes_freed === 0, `got ${r3.status} ${JSON.stringify(r3.data)}`);
    }

    // --- partial failure ---
    // A history.db that is a DIRECTORY (not a file) makes sqlite3.connect
    // raise inside _do_db_clear. That target errors, the others in the same
    // category still run, the category reports "partial" and the run is 207.
    // (chmod tricks do not work: the harness runs as root, which bypasses
    // permission bits.) The QA workspace is otherwise untouched by the other
    // groups, so this failure stays contained here.
    if (run("partial")) {
      const qaDb = path.join(QA, "history.db");
      // Replace the QA history.db file with a directory containing a file.
      try { fs.rmSync(qaDb, { force: true }); } catch { /* already a dir */ }
      fs.mkdirSync(qaDb, { recursive: true });
      fs.writeFileSync(path.join(qaDb, "junk.txt"), "not a database");
      fs.writeFileSync(path.join(QA, "chats.json"), JSON.stringify({ chats: [{ id: "q1" }] }));
      const p = await preview(["chats"]);
      const r = await execute(["chats"], p.data.plan_id, { requestId: `partial-${Date.now()}` });
      const chats = r.data.per_category.find((c) => c.id === "chats");
      check("partial: run is 207", r.status === 207, `got ${r.status} ${JSON.stringify(r.data)}`);
      check("partial: chats category is partial", chats && chats.status === "partial", JSON.stringify(chats));
      check("partial: error is recorded", chats && Array.isArray(chats.errors) && chats.errors.length >= 1, JSON.stringify(chats));
      check("partial: default chats.json still truncated", fs.readFileSync(path.join(W, "chats.json"), "utf8").trim() === "{}");
      check("partial: QA chats.json still truncated", fs.readFileSync(path.join(QA, "chats.json"), "utf8").trim() === "{}");
    }

    // --- concurrency ---
    if (run("concurrency")) {
      // Chats holds the lock through the 5 s idle gate, giving a real window.
      const p = await preview(["chats"]);
      const [a, b] = await Promise.all([
        execute(["chats"], p.data.plan_id, { requestId: `conc-a-${Date.now()}` }),
        execute(["chats"], p.data.plan_id, { requestId: `conc-b-${Date.now()}` }),
      ]);
      const statuses = [a.status, b.status].sort();
      check("concurrency: one succeeds, one gets 409 busy",
        statuses[0] === 200 || statuses[0] === 207 ? statuses[1] === 409 : false,
        `got ${a.status} and ${b.status}`);
    }

    // --- happy path (all safe categories on the fake tree) ---
    if (run("happy")) {
      const cats = ["memories", "skills", "lessons", "models", "logs", "sessions", "backups"];
      const p = await preview(cats);
      check("happy: preview 200", p.status === 200, `got ${p.status}`);
      const r = await execute(cats, p.data.plan_id, { requestId: `happy-${Date.now()}` });
      check("happy: execute 200", r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);
      check("happy: bytes_freed equals preview", r.data.totals.bytes_freed === p.data.totals.bytes, `${r.data.totals.bytes_freed} vs ${p.data.totals.bytes}`);
      check("happy: MEMORY.md gone", !fs.existsSync(path.join(W, "MEMORY.md")));
      check("happy: skills gone", !fs.existsSync(path.join(W, "skills")));
      check("happy: skill_pool gone", !fs.existsSync(path.join(root, "working", "skill_pool")));
      check("happy: xingchiapi gone (non-active custom provider)", !fs.existsSync(path.join(root, "working.secret", "providers", "custom", "xingchiapi.json")));
      check("happy: mosicn stays (active provider)", fs.existsSync(path.join(root, "working.secret", "providers", "custom", "mosicn.json")));
      check("happy: active_model.json untouched", fs.existsSync(path.join(root, "working.secret", "providers", "active_model.json")));
      check("happy: auth.json survives", fs.existsSync(path.join(root, "working.secret", "auth.json")));
      check("happy: .env survives", fs.existsSync(path.join(root, ".env")));
      check("happy: kilo.json survives", fs.existsSync(path.join(root, "working.secret", "providers", "builtin", "kilo.json")));
      check("happy: audit.db survives", fs.existsSync(path.join(root, "working", "governance", "audit.db")));
      check("happy: reset.log survives", fs.existsSync(path.join(root, "working", "logs", "reset.log")));
      check("happy: evil symlink untouched and /etc intact", fs.existsSync(path.join(W, "evil-link")) && fs.existsSync("/etc/hostname"));
    }
  } finally {
    broker.kill("SIGTERM");
    await sleep(300);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }

  console.log(`reset: ${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  FAIL: ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.log(`reset: harness error: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
