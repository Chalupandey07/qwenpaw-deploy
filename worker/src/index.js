// qwenpaw-keepalive — Cloudflare Worker (Free): cron keep-alive + status API
// for QwenPaw on InstaBox Free. No secrets in this file.
// Env vars: QWENPAW_URL, INSTABOX_MACHINE_ID, PAGES_URL
// Secrets (optional): PORT_TOKEN (private port only), INSTABOX_API_KEY (API-wake fallback AND, since v3, the sleep path)
// Secrets (sleep/wake): REPORTER_TOKEN (POST /report auth)
// Secrets (v3 sleep): INSTABOX_API_KEY + INSTABOX_MACHINE_ID are REQUIRED for
//   the cron to suspend the machine itself (PATCH InstaBox). v2 asked Pages to
//   do it and failed seven times; see the note above suspendViaInstaBox.
//   SLEEP_TOKEN / PAGES_URL are still read by the v2 Pages path on Pages' side,
//   but the Worker no longer calls it.
// Secret (required for /wake): WAKE_TOKEN — POST /wake requires header
// X-Wake-Token to match; when unset, /wake returns 503 (fail closed).
// WAKE_TOKEN also gates POST /keepalive (Authorization: Bearer header).
// GET /ping stays the public wake path: it probes the public console URL,
// which wakes a paused box on request by InstaBox design — the Pages
// status page and the activity-feed Wake button use /ping, never /wake.
// KV binding: STATUS

const PING_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 60_000;

/**
 * The retry delay, overridable for tests.
 *
 * A 503 with `allowRetry` sleeps 60 s between the two attempts — correct in
 * production (a wake takes a minute) and untestable as a literal (a harness
 * would wait a minute per tick). Reading it per call keeps the production
 * default and lets the harness set `RETRY_DELAY_MS` in its env.
 */
function retryDelayMs(env) {
  const override = Number(env && env.RETRY_DELAY_MS);
  return Number.isFinite(override) && override >= 0 ? override : RETRY_DELAY_MS;
}
const WAKE_MIN_GAP_MS = 10 * 60_000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Wake-Token",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function pingHeaders(env) {
  const h = { "User-Agent": "qwenpaw-keepalive/1.0 (+cloudflare-worker-cron)" };
  if (env.PORT_TOKEN) h["Authorization"] = `Bearer ${env.PORT_TOKEN}`;
  return h;
}

async function readSmallText(res, max = 2048) {
  try {
    const t = await res.text();
    return t.slice(0, max);
  } catch {
    return "";
  }
}

function parseRetryAfter(res, bodyText) {
  const header = res.headers.get("Retry-After");
  if (header && /^\d+$/.test(header.trim())) return Number(header.trim());
  try {
    const j = JSON.parse(bodyText || "{}");
    const s = j?.error?.retryAfterSeconds ?? j?.retryAfterSeconds;
    if (typeof s === "number") return s;
  } catch { /* not JSON */ }
  return null;
}

function parseErrorCode(bodyText) {
  try {
    return JSON.parse(bodyText || "{}")?.error?.code ?? null;
  } catch {
    return null;
  }
}

async function probeQwenPaw(env, { allowRetry = true } = {}) {
  const url = env.QWENPAW_URL;
  if (!url) return { status: "misconfigured", httpStatus: 0, note: "QWENPAW_URL is not set" };

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: pingHeaders(env),
        redirect: "manual",
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
    } catch (err) {
      // Transient network error (DNS/TLS/reset on the way to InstaBox):
      // retry once like the 503 path does, so a single blip does not
      // flip the status to offline and does not trigger a needless
      // API wake. Live /status?live=1 passes allowRetry=false, so it
      // still answers fast without retrying.
      if (allowRetry && attempt === 1) {
        await sleep(retryDelayMs(env));
        continue;
      }
      return { status: "offline", httpStatus: 0, note: `fetch failed (attempt ${attempt}): ${err?.name || "error"}` };
    }

    const httpStatus = res.status;
    if ((httpStatus >= 200 && httpStatus < 400) || httpStatus === 401) {
      await res.body?.cancel().catch(() => {});
      return { status: "up", httpStatus, note: "AgentX console answered" };
    }
    if (httpStatus === 503) {
      const body = await readSmallText(res);
      const retryAfter = parseRetryAfter(res, body);
      if (allowRetry && attempt === 1) {
        await sleep(retryDelayMs(env));
        continue;
      }
      return { status: "waking", httpStatus, retryAfterSeconds: retryAfter, note: "InstaBox is waking the machine (503 Sandbox is waking up)" };
    }
    if (httpStatus === 409) {
      const body = await readSmallText(res);
      const code = parseErrorCode(body);
      const retryAfter = parseRetryAfter(res, body);
      return {
        status: code === "machine_cooldown" ? "cooldown" : "conflict",
        httpStatus, errorCode: code, retryAfterSeconds: retryAfter,
        note: code === "machine_cooldown"
          ? "Max-run cooldown — every wake is refused until it ends. Wait."
          : "Another operation is running (409 operation_conflict). Retry later.",
      };
    }
    const body = await readSmallText(res);
    return { status: "degraded", httpStatus, note: body || `Unexpected HTTP ${httpStatus}` };
  }
  return { status: "unknown", httpStatus: 0, note: "probe exhausted" };
}

async function loadStatus(env) {
  if (!env.STATUS) return null;
  try {
    const raw = await env.STATUS.get("qwenpaw:status");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// --- Daily write-budget guard (KV phase, 2026-11-15) --------------------
// STATUS cap 250/day, shared with qwenpaw-routines through the same
// counter key `budget:<YYYY-MM-DD>` (DESKTOP_KV gets 450; 250 + 450 =
// 700 of the 1,000/day account cap, leaving 300 headroom). Counting is
// approximate by design (per-isolate in-memory count, flushed to KV only
// on every 25th local write — never per write, never on a timer; KV has
// no CAS). See features/storage/QUOTA-BUDGET.md for the full audit.
const BUDGET_CAP = 250;
const BUDGET_FLUSH_EVERY = 25;

function makeDailyCounter(kv, prefix, flushEvery) {
  let local = 0, seeded = 0, seededDay = "";
  const today = () => new Date().toISOString().slice(0, 10);
  return {
    async count() {
      const day = today();
      if (seededDay !== day) {
        local = 0; seeded = 0; seededDay = day;
        try {
          const v = await kv.get(prefix + day);
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) seeded = n;
        } catch { /* ignore — guard degrades to the local count only */ }
      }
      return seeded + local;
    },
    note() {
      local++;
      if (local % flushEvery !== 0) return;
      const key = prefix + today();
      kv.get(key).then((cur) => {
        const n = Number(cur);
        const base = Number.isFinite(n) ? n : 0;
        return kv.put(key, String(base + flushEvery));
      }).catch(() => {});
    },
  };
}

let budgetCounter = null;
function getBudgetCounter(env) {
  if (!budgetCounter) budgetCounter = makeDailyCounter(env.STATUS, "budget:", BUDGET_FLUSH_EVERY);
  return budgetCounter;
}

// A KV put through the budget guard. Non-essential writes are refused
// (false) once the soft cap is hit; essential writes always try.
// Returns true when the write landed.
async function budgetGuardedPut(env, key, value, essential = false) {
  if (!env.STATUS) return false;
  if (!essential && (await getBudgetCounter(env).count()) >= BUDGET_CAP) return false;
  try {
    await env.STATUS.put(key, value);
  } catch (e) {
    console.log("KV put failed:", e?.message);
    return false;
  }
  getBudgetCounter(env).note();
  return true;
}

async function saveStatus(env, patch, essential = false) {
  if (!env.STATUS) return null;
  const prev = (await loadStatus(env)) || {};
  const now = new Date().toISOString();
  // patch.status === undefined means "no status change" (e.g. the
  // wake-marker save): keep the stored status and failure count instead
  // of incrementing consecutiveFailures — the old code bumped failures
  // on every wake-marker save, which was wrong.
  const next = {
    ...prev,
    ...patch,
    checkedAt: now,
    lastPingAt: patch.status !== undefined ? now : prev.lastPingAt || now,
    lastUpAt: patch.status === "up" ? now : prev.lastUpAt || null,
    consecutiveFailures: patch.status === undefined
      ? (prev.consecutiveFailures || 0)
      : patch.status === "up" ? 0 : (prev.consecutiveFailures || 0) + 1,
  };
  // Clear error fields the latest probe did not set (probe saves only —
  // a wake-marker save has no status and must not touch them): without
  // this, a cooldown's errorCode / retryAfterSeconds stayed in the stored
  // record forever (spread keeps prev's values), so /status kept reporting
  // "machine_cooldown" long after the machine was up again.
  if (patch.status !== undefined) {
    if (patch.errorCode === undefined) next.errorCode = null;
    if (patch.retryAfterSeconds === undefined) next.retryAfterSeconds = null;
  }
  // Write only when something a reader cares about changed. checkedAt /
  // lastPingAt are fresh in every RESPONSE but are not stored unless the
  // meaningful state changed — a steady "up" day writes once, not 288
  // times (the old code wrote on every 5-min cron tick). lastUpAt is
  // deliberately NOT in the list: it advances on every successful probe
  // by construction, so including it would write on every tick and
  // defeat the whole optimization. The stored lastUpAt is therefore the
  // last up-TRANSITION (or last write while up); the response always
  // carries a fresh checkedAt / lastPingAt for "seen just now".
  const meaningful = ["status", "consecutiveFailures", "lastWakeAt", "httpStatus", "note", "errorCode", "retryAfterSeconds", "lastWakeResult"];
  const changed = !prev.status || meaningful.some((k) => JSON.stringify(next[k]) !== JSON.stringify(prev[k]));
  if (changed) {
    const ok = await budgetGuardedPut(env, "qwenpaw:status", JSON.stringify(next), essential);
    if (!ok) console.log("status write dropped (KV failed or daily write-budget guard tripped; response still fresh)");
  }
  return next;
}

async function callInstaBoxWake(env) {
  const id = env.INSTABOX_MACHINE_ID;
  try {
    const res = await fetch(`https://api.instabox.sh/v1/machines/${encodeURIComponent(id)}/wake`, {
      method: "POST",
      headers: { "X-API-Key": env.INSTABOX_API_KEY, "Idempotency-Key": crypto.randomUUID() },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await readSmallText(res);
    return { httpStatus: res.status, body: body || null };
  } catch (err) {
    return { httpStatus: 0, error: err?.name || "fetch failed" };
  }
}

/**
 * Is a manual rest in effect?
 *
 * THE POINT OF THE WHOLE FEATURE: this cron runs every 5 minutes and its ping
 * WAKES the machine. Without this check, a user who rests the machine would
 * have it woken within five minutes and their explicit instruction would be
 * silently undone — which is worse than never offering the button.
 *
 * Returns `{resting: boolean, reason: string}`. THREE states, and the third is
 * the one that matters:
 *
 *   resting:true   a manual rest is in effect -> do not wake
 *   resting:false  no rest                    -> wake as before
 *   resting:true (reason "store_error"/"no_store")
 *                  WE COULD NOT TELL -> do not wake
 *
 * That last case is the deliberate inversion of the usual default. Everywhere
 * else in this Worker a failed read fails OPEN (keep trying, report honestly).
 * Here it must fail CLOSED: interpreting "I could not read the rest flag" as
 * "no rest" would resume the exact behaviour the user switched off, at the
 * exact moment something is already going wrong. A missed wake is a nuisance
 * the user fixes by opening the site; undoing their rest is a betrayal that
 * also costs them a cooldown.
 */
async function manualRestInEffect(env) {
  const db = env.QWENPAW_DB && env.USE_D1 === "1" ? env.QWENPAW_DB : null;
  if (!db) {
    // No D1 binding: we cannot know. Before this feature the keep-alive woke
    // unconditionally, but that was when nothing could set a rest. Now that a
    // rest can exist, "cannot tell" has to mean "leave it alone".
    return { resting: true, reason: "no_store" };
  }
  try {
    const row = await db.prepare(`SELECT value FROM meta WHERE key = ?`)
      .bind("machine:rest").first();
    if (!row || !row.value) return { resting: false, reason: "none" };
    let marker = null;
    try { marker = JSON.parse(row.value); } catch { marker = null; }
    if (!marker || typeof marker !== "object") {
      // A corrupt marker cannot be trusted to mean "rest", and cannot be
      // trusted to mean "no rest" either. Treat it as no rest but LOUDLY —
      // a marker we cannot read is a bug to fix, not a policy to keep.
      return { resting: false, reason: "corrupt_marker" };
    }
    const until = Number(marker.until);
    if (Number.isFinite(until) && until > Date.now()) {
      return { resting: true, reason: "manual_rest" };
    }
    return { resting: false, reason: "expired" };
  } catch (e) {
    return { resting: true, reason: "store_error" };
  }
}

// --- Intelligent sleep/wake (2026-11-17) ---------------------------------
// The keep-alive used to probe the public console URL every 5 minutes,
// which WAKES a paused machine — so the machine never idle-paused, ran
// its full 8-hour max run, then took a ~2-hour cooldown. The user asked
// for: sleep when idle (no schedule, no agent work), wake 5 minutes
// before a schedule, and keep-alive pings only when the AI is active or
// before a schedule.
//
// The rule that makes this safe: the cron tick DECIDES BEFORE IT PROBES.
// Probing wakes the machine, so a probe-first tick can never sleep.
// The decision is a pure function (decideSleepWake, exported for the
// harness) over D1 state; the tick only probes / suspends based on it.
//
// State lives in the D1 `meta` table (generic key/value, same as the
// rest marker):
//   sleepwake:report    machine reporter POST /report (next native run,
//                       agent activity, uptime; REPORTER_TOKEN auth)
//   sleepwake:state     {mode, since, reason, lastWakeAt, lastSleepAt}
//   sleepwake:last-visit  epoch ms of the last console visit (Pages writes)
//   routines:definitions  routine registry (cron + timezone per routine)
//   keepalive:enabled   '1' (ON) | '0' (OFF); absent = ON. POST /keepalive
//                       (Bearer WAKE_TOKEN) flips it; the cron tick reads
//                       it first and skips entirely when OFF. See
//                       features/smart-sleep/README.md.
// Max-run guard: decideSleepWake sleeps at 7h uptime even when the
// machine is busy — a busy machine otherwise runs the full ~8h max run
// and then takes a forced ~2h cooldown. See features/smart-sleep/README.md.
// Fail CLOSED throughout: an unknown next-routine, a stale reporter, or
// an unreadable store means HOLD (stay awake), never sleep. A machine
// that is asleep is woken only by a due routine or a real visit — the
// cron never probes a sleeping machine on its own.
//
// Suspend goes through the Pages Worker (POST /api/machine/sleep,
// SLEEP_TOKEN auth) because Pages already holds INSTABOX_API_KEY and the
// tested suspend call; the keep-alive Worker does not have that key and
// must never invent one.
const SW_MIN = 60_000;
const SW_WAKE_LOOKAHEAD_MS = 5 * SW_MIN;    // routine due within 5 min -> wake (user-set 2026-11-21: wake takes ~1-2 min, so the machine is ready ~3 min before the routine; the routines Worker's 15-min backup wake covers slow wakes)
const SW_OVERDUE_GRACE_MS = 15 * SW_MIN;    // a routine at most this far OVERDUE still counts as imminent (it just fired and nextRun has not advanced yet). Farther overdue = missed/stuck, NOT a reason to wake or to block sleep: waking for it every tick is the "constantly waking up" bug (2026-11-22), and a stuck routine would otherwise block sleep forever. 15 min covers a slow wake + the routines Worker's 15-min backup window; a routine hours overdue is not "just fired".
const SW_SLEEP_BLOCK_RETRY_MS = 60 * SW_MIN; // a PERMANENT suspend failure (bad key, wrong machine id) must not be retried every tick: that is the seven-failure loop. Retry once an hour so a fixed key recovers on its own.
const SW_VISIT_IDLE_MS = 20 * SW_MIN;       // no visitor for 20 min (user-set 2026-11-21: auto-sleep after 20 min idle)
const SW_AGENT_IDLE_MS = 10 * SW_MIN;       // no agent activity for 10 min
const SW_MIN_UPTIME_MS = 15 * SW_MIN;       // machine must have been up 15 min
const SW_MIN_AWAKE_AFTER_WAKE_MS = 20 * SW_MIN; // deadband > lookahead: kills sleep-wake-sleep flap
const SW_REPORTER_STALE_MS = 10 * SW_MIN;   // reporter older than this -> unknown
const SW_REPORTER_RECOVERY_MS = 5 * SW_MIN; // stuck-state recovery: a report this fresh proves the machine is up (the reporter posts every 2 min); deliberately tighter than the 10-min staleness threshold because the flip is taken on reporter evidence alone, without a probe
const SW_LAST_VISIT_WRITE_MS = 5 * SW_MIN;  // Pages throttles last-visit writes to this
const SW_MAX_RUN_MIN = 420;                 // max-run guard: sleep at 7h uptime, 1h before InstaBox's ~8h max run forces a ~2h cooldown

// --- cron next-run (no libraries; Asia/Kolkata has no DST, but this
// never assumes a constant offset — it asks Intl for local fields at
// each candidate UTC minute, so it stays correct on DST zones too).
const SW_MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SW_DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function swCronToken(s, names, base) {
  s = String(s).toLowerCase();
  const i = names ? names.indexOf(s) : -1;
  return i >= 0 ? i + base : Number(s);
}

function swParseCronField(expr, min, max, names, base) {
  const set = new Set();
  for (const part of String(expr).trim().split(",")) {
    const [spec, stepStr] = part.split("/");
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!(step >= 1)) throw new Error("bad step: " + part);
    let lo, hi;
    if (spec === "*") { lo = min; hi = max; }
    else if (spec.includes("-")) {
      const [a, b] = spec.split("-");
      lo = swCronToken(a, names, base); hi = swCronToken(b, names, base);
    } else {
      lo = swCronToken(spec, names, base);
      hi = stepStr === undefined ? lo : max;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
      throw new Error("bad cron field: " + part);
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

function nextRun(cronExpr, timezone, fromMs) {
  const f = String(cronExpr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error("5-field cron required");
  const [minF, hourF, domF, monF, dowF] = f;
  const minutes = swParseCronField(minF, 0, 59, null, 0);
  const hours = swParseCronField(hourF, 0, 23, null, 0);
  const doms = swParseCronField(domF, 1, 31, null, 0);
  const dows = swParseCronField(dowF, 0, 6, SW_DOW_NAMES, 0);
  const months = swParseCronField(monF, 1, 12, SW_MONTH_NAMES, 1);
  if (dows.has(7)) { dows.add(0); dows.delete(7); }
  // Vixie rule: if either day field starts with '*', AND them; else OR them.
  const domStar = domF.trim().startsWith("*");
  const dowStar = dowF.trim().startsWith("*");
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false,
    month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", weekday: "short",
  });
  const partsOf = (ms) => {
    const o = {};
    for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
    return o;
  };
  // Next whole minute strictly after fromMs.
  let t = Math.floor(fromMs / 60000) * 60000 + 60000;
  const limit = t + 366 * 24 * 60 * 60000; // 1-year safety cap
  while (t <= limit) {
    const p = partsOf(t);
    const minute = Number(p.minute);
    const hour = Number(p.hour) % 24; // some engines emit "24" at midnight
    const dom = Number(p.day);
    const mon = Number(p.month);
    const dow = SW_DOW_NAMES.indexOf(String(p.weekday).toLowerCase());
    const domOk = doms.has(dom);
    const dowOk = dows.has(dow);
    const dayOk = (domStar || dowStar) ? (domOk && dowOk) : (domOk || dowOk);
    if (months.has(mon) && dayOk && hours.has(hour) && minutes.has(minute)) return t;
    t += 60000;
  }
  throw new Error("no match within 1 year");
}

// --- sleep/wake decision (pure; exported for the harness) ----------------
// nextRoutineAt: epoch ms of the next routine, Infinity when there are
//   definitively NO routines, null when UNKNOWN (could not compute).
//   null -> fail-awake (hold). Infinity -> sleep allowed (no routine to miss).
//   A finite value in the past (overdue) counts as imminent ONLY within
//   SW_OVERDUE_GRACE_MS; farther overdue is missed/stuck, not imminent
//   (2026-11-22 fix for "constantly waking up").
function decideSleepWake(inp, now = Date.now()) {
  const {
    nextRoutineAt = null,
    lastVisitAt = null,
    lastAgentActivityAt = null,
    lastWakeAt = null,
    reporterStale = true,
    restActive = false,
    machineUp = false,
    uptimeMin = 0,
    sleepState = "unknown",
  } = inp;

  // Never issue a command while a transition is in flight.
  if (sleepState === "waking" || sleepState === "suspending") {
    return { action: "hold", reason: `transition:${sleepState}` };
  }

  // known = we have a value (finite or Infinity). null = unknown -> fail-awake.
  const known = nextRoutineAt !== null && nextRoutineAt !== undefined;
  const untilRoutine = known ? nextRoutineAt - now : Infinity;

  // IMMINENT = due within the 5-min lookahead ahead, or at most
  // SW_OVERDUE_GRACE_MS overdue (it just fired and nextRun has not
  // advanced yet). A routine farther overdue is MISSED/STUCK, not
  // imminent: it must neither wake the machine every tick (the
  // "constantly waking up" bug, 2026-11-22 — a stale report or a
  // timed-out job leaves nextRoutineAt hours in the past) nor block
  // sleep forever. The scheduler's misfire handling owns missed runs.
  const imminent = known && untilRoutine <= SW_WAKE_LOOKAHEAD_MS && untilRoutine >= -SW_OVERDUE_GRACE_MS;

  // WAKE wins, but only for an imminent routine. "<= lookahead" also
  // catches a just-fired routine (negative, within grace): the run
  // already fired but nextRun hasn't advanced yet -> stay up.
  if (imminent) {
    const down = !machineUp || sleepState === "suspended";
    if (down) return { action: "wake", reason: "routine due within lookahead" };
    return { action: "hold", reason: "routine window, already up" };
  }

  // FAIL-AWAKE: if we cannot prove no imminent routine, never sleep.
  if (!known) {
    return { action: "hold", reason: "nextRoutineAt unknown -> fail-awake" };
  }

  // MAX-RUN GUARD (2026-11-19): a machine that stays busy never passes
  // the idle guards (recent visit / agent activity), so it runs the full
  // ~8h max run and then takes a forced ~2h cooldown. At 7h uptime,
  // sleep anyway: the 1h buffer is before the 8h wall, a 7h sleep takes
  // a much shorter cooldown, and the user wakes the machine immediately
  // on visit. WAKE still wins (the branch above already returned) and a
  // manual rest still wins. Recent visit / agent activity deliberately
  // do NOT block this — that is the point. Reporter staleness does not
  // block it either: uptimeMin comes from the reporter (fresh) or the
  // run-start baseline, and unknown uptime is 0, which fails the 420
  // threshold (fail closed). The baseline is set at the down→up
  // transition and never refreshed while up, so a 420-min reading is a
  // reading about the CURRENT run.
  if (uptimeMin >= SW_MAX_RUN_MIN && machineUp === true && sleepState === "running" && restActive === false) {
    return { action: "sleep", reason: "max_run_guard" };
  }

  const sinceWake = lastWakeAt == null ? Infinity : now - lastWakeAt;
  const guards = {
    // Not imminent = either far in the future (beyond the lookahead) or
    // far overdue (missed/stuck, beyond the grace). A missed routine
    // must not block sleep: it is the scheduler's misfire to own, and
    // a stuck routine would otherwise hold the machine awake forever.
    routineBeyondWindow: !imminent,
    noRecentVisit: lastVisitAt == null || now - lastVisitAt >= SW_VISIT_IDLE_MS,
    noRecentAgent: lastAgentActivityAt == null || now - lastAgentActivityAt >= SW_AGENT_IDLE_MS,
    uptimeEnough: uptimeMin * SW_MIN >= SW_MIN_UPTIME_MS,
    noRest: restActive === false,
    reporterFresh: reporterStale === false,
    up: machineUp === true,
    running: sleepState === "running",
    awakeLongEnough: sinceWake >= SW_MIN_AWAKE_AFTER_WAKE_MS,
  };
  if (Object.values(guards).every(Boolean)) {
    return { action: "sleep", reason: "idle; all guards pass" };
  }
  return { action: "hold", reason: "guard failed", guards };
}

// --- sleep/wake D1 state (meta table; same pattern as machine:rest) -----
async function swMetaGet(db, key) {
  try {
    const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
    return row ? row.value : null;
  } catch { return null; }
}

async function swMetaPut(db, key, value) {
  try {
    await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(key, value).run();
    return true;
  } catch { return false; }
}

// --- keep-alive ON/OFF toggle (2026-11-19) ---------------------------
// D1 meta key `keepalive:enabled` = '1' (ON) | '0' (OFF). Absent = ON.
// Unlike swMetaGet (which swallows errors and returns null), this
// distinguishes absent / '0' / '1' / invalid / thrown error, because
// the tick gate must HOLD (fail closed) when the toggle is unreadable,
// never assume ON. Returns the raw stored value, or null when absent.
// THROWS on a read error; the caller maps that to HOLD. An invalid
// value is returned as-is so the caller can HOLD on it too.
async function readKeepAliveEnabled(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind("keepalive:enabled").first();
  return row ? row.value : null;
}

// Public display value for GET /status and GET /sleepwake/state.
// Absent = "on"; an unreadable store or an invalid value is "unknown"
// (never guessed). keepAliveUpdatedAt is the ISO timestamp of the last
// POST /keepalive flip, or null.
async function readKeepAlivePublic(db) {
  let raw = null;
  let updated = null;
  try {
    const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind("keepalive:enabled").first();
    raw = row ? row.value : null;
    const row2 = await db.prepare("SELECT value FROM meta WHERE key = ?").bind("keepalive:updated").first();
    updated = row2 ? row2.value : null;
  } catch {
    return { keepAlive: "unknown", keepAliveUpdatedAt: null };
  }
  let keepAlive = "unknown";
  if (raw === null || raw === "1") keepAlive = "on";
  else if (raw === "0") keepAlive = "off";
  const ts = updated && Number.isFinite(Date.parse(updated)) ? updated : null;
  return { keepAlive, keepAliveUpdatedAt: ts };
}

async function readSleepState(db) {
  const raw = await swMetaGet(db, "sleepwake:state");
  if (!raw) return { mode: "unknown", since: null, reason: "no_state", lastWakeAt: null, lastSleepAt: null };
  try {
    const s = JSON.parse(raw);
    if (!s || typeof s !== "object" || typeof s.mode !== "string") return { mode: "unknown", since: null, reason: "corrupt_state", lastWakeAt: null, lastSleepAt: null };
    return s;
  } catch { return { mode: "unknown", since: null, reason: "corrupt_state", lastWakeAt: null, lastSleepAt: null }; }
}

async function writeSleepState(db, patch) {
  const prev = await readSleepState(db);
  const next = { ...prev, ...patch, since: patch.since ?? Date.now() };
  return swMetaPut(db, "sleepwake:state", JSON.stringify(next));
}

async function readReport(db) {
  const raw = await swMetaGet(db, "sleepwake:report");
  if (!raw) return null;
  try {
    const r = JSON.parse(raw);
    if (!r || typeof r !== "object") return null;
    return r;
  } catch { return null; }
}

async function readLastVisit(db) {
  const raw = await swMetaGet(db, "sleepwake:last-visit");
  const n = raw === null ? null : Number(raw);
  return Number.isFinite(n) ? n : null;
}

// --- run-start baseline (2026-11-19, stale-baseline incident) ----------
// D1 meta key `sleepwake:run-start`: epoch ms the CURRENT run started.
// Set ONCE per run, at the observed down→up transition (the reporter_up
// flip, the baseline reconcile, or a probe that finds the machine up
// after it was recorded down). It is NEVER refreshed while the machine
// stays up, and it is NEVER derived from KV lastUpAt.
//
// Why not lastUpAt: lastUpAt is the last up-TRANSITION (or last
// meaningful status change — saveStatus is write-on-change, so a steady
// "up" day writes once). It goes stale whenever the machine stays up
// with no meaningful change, and — worse — it can PREDATE the current
// run: live 2026-11-19 it was frozen at 2026-11-18T14:30:29Z while the
// true run started ~07:45Z that day, so the guard fired every 5-min
// tick on 17.4h of a 10-minute-old run. lastUpAt is therefore NOT a
// lower bound on the current run's uptime across run boundaries, and
// the uptime computation must not fall back to it. When the baseline
// is absent and the reporter carries no uptime, uptime is UNKNOWN
// (null -> 0 in the tick), which fails the 420 threshold — fail closed,
// as the guard's own comment requires. The baseline is (re)created on
// the first tick with a fresh reporter (or a probe-confirmed up), so
// the unknown window is at most a few ticks.
async function readRunStart(db) {
  const raw = await swMetaGet(db, "sleepwake:run-start");
  const n = raw === null ? null : Number(raw);
  return Number.isFinite(n) ? n : null;
}
async function writeRunStart(db, ms) {
  return swMetaPut(db, "sleepwake:run-start", String(ms));
}
// The baseline implied by a fresh report: the reporter's own uptimeSec
// when it carries one (exact — the reporter measured it), else now.
// "Now" understates uptime by at most the reporter interval, because
// the report proves the machine was up at reportedAt and the run
// started at or before this tick.
function baselineFromReport(report, now) {
  if (report && Number.isFinite(report.uptimeSec)) return now - Math.max(0, report.uptimeSec) * 1000;
  return now;
}
// Uptime in seconds, or null when unknown. ONE precedence, shared by
// the tick and GET /sleepwake/state so the endpoint always shows the
// uptime the guard would use right now: reporter uptimeSec (fresh) >
// D1 run-start baseline > unknown. There is deliberately NO lastUpAt
// fallback (see readRunStart above).
function computeUptimeSec(report, reporterStale, runStart, now) {
  if (report && !reporterStale && Number.isFinite(report.uptimeSec)) return Math.max(0, report.uptimeSec);
  if (runStart) return Math.max(0, Math.round((now - runStart) / 1000));
  return null;
}

// Next routine = earliest of (a) D1 routine definitions with a parseable
// cron+timezone, (b) the reporter's next native run. Returns:
//   { at: <ms>, source }  a routine exists
//   { at: Infinity, source: "none" }  definitively no routines
//   { at: null, source: "unknown" }  could not determine (fail-awake)
async function computeNextRoutine(db, report, now = Date.now()) {
  let best = Infinity;
  let bestSource = "none";
  let unknown = false;
  try {
    const res = await db.prepare("SELECT id, payload FROM routines_definitions").all();
    for (const row of (res.results || [])) {
      let def = null;
      try { def = JSON.parse(row.payload); } catch { def = null; }
      if (!def || def.active === false) continue;
      if (!def.cron || typeof def.cron !== "string") {
        // A routine with no parseable schedule: we cannot prove when it
        // fires, so the next run is UNKNOWN (fail-awake), not "none".
        unknown = true;
        continue;
      }
      try {
        const at = nextRun(def.cron, def.timezone || "Asia/Kolkata", now);
        if (at < best) { best = at; bestSource = `d1:${def.id || row.id}`; }
      } catch { unknown = true; }
    }
  } catch { unknown = true; }
  if (report && Number.isFinite(report.nextNativeRun) && report.nextNativeRun < best) {
    // A STALE report's nextNativeRun must not force a wake (2026-11-22
    // "constantly waking up"): the report is a snapshot from when the
    // machine last ran, so its nextNativeRun can be hours in the past by
    // now, and decideSleepWake treats a past time as an overdue routine
    // -> wake, every tick. Only a fresh report (within the staleness
    // threshold) may contribute a native run.
    const reportFresh = Number.isFinite(report.reportedAt) && (now - report.reportedAt <= SW_REPORTER_STALE_MS);
    if (reportFresh) {
      best = report.nextNativeRun;
      bestSource = "native";
    }
  }
  if (unknown && best === Infinity) return { at: null, source: "unknown" };
  if (best === Infinity) {
    // No D1 routines and no native run. That is "none" ONLY if the
    // reporter has told us there are no native jobs; with no report at
    // all, native jobs are unknown (jobs.json is unreadable from here),
    // so the honest answer is null (fail-awake), not Infinity.
    // A STALE report is as untrustworthy as no report here: it cannot
    // prove there are no native jobs now, so it is also "unknown".
    const reportFresh = report && Number.isFinite(report.reportedAt) && (now - report.reportedAt <= SW_REPORTER_STALE_MS);
    if (!reportFresh) return { at: null, source: "unknown" };
    return { at: Infinity, source: "none" };
  }
  return { at: best, source: bestSource };
}

// --- v3 suspend: the Worker calls InstaBox DIRECTLY (2026-11-23) --------
// v2 suspended by asking Pages to do it (POST /api/machine/sleep ->
// sleepMachine in pages/public/machine-control.js -> PATCH InstaBox).
// That path failed SEVEN times live, always as `pages_sleep_failed`, and the
// root cause was never found: the Pages function returned 503
// `instabox_machine_unset` because INSTABOX_MACHINE_ID was absent from the
// Pages production env, and even after that var was set the failure moved
// rather than cleared. Seven failures of an indirection whose every step is
// invisible from here is enough: the Worker now suspends the machine itself.
//
// The auth and endpoint MIRROR the wake path that is already proven live
// (`callInstaBoxWake` above): same base URL, same `X-API-Key` header carrying
// INSTABOX_API_KEY, same `Idempotency-Key: crypto.randomUUID()`, same 30 s
// AbortSignal.timeout. The suspend is a lifecycle POST, mirroring wake:
// POST /v1/machines/{id}/suspend, no body.
//
// CORRECTION (2026-11-28): the original v3 call was PATCH
// /v1/machines/{id} with {"desiredState":"suspended"}. That PATCH returns
// 400 unknown_field — desiredState is not a valid PATCH field (known fields:
// name, rootDiskGiB, persistentDiskGiB, vcpus, memMiB, metadata,
// autoSuspendAfterSeconds, maxRunMinutes, vault, apply, cancelScheduled).
// So the v3 suspend as built could never work; it would 400, not suspend.
// The connector doc lists "suspend" among the lifecycle POST calls
// (create, start, stop, suspend, resume, delete — all POST with
// Idempotency-Key), and the wake path is POST /v1/machines/{id}/wake.
// POST /suspend is therefore the inferred correct endpoint — it is NOT
// proven live. Do not live-test it by suspending on purpose; the first live
// test is at a genuine suspend (end of run / guard sleep), watching for
// sleep_blocked vs a clean suspend in /sleepwake/state.
//
// The Worker already holds INSTABOX_API_KEY — it is the same secret the wake
// fallback has always read. Nothing new is invented here, no key moves, and
// no Pages deploy is needed for this to work.
//
// FAILURE SEMANTICS, and this is the part that matters:
//
//   A suspend that fails must NOT be retried in a loop. The old code reverted
//   the state to "running" and fell through to a probe, which kept the machine
//   awake and let the next tick try again five minutes later — forever. Seven
//   failures is what that looks like from the outside. v3 distinguishes:
//
//     - transient (network error, timeout, 5xx, 429): revert to running and
//       let the next tick retry. The machine stays up, which is safe.
//     - permanent (401/403 bad key, 404 machine gone, 400 bad request):
//       record a `sleep_blocked` state with the reason and STOP trying until
//       the reason changes. A wrong API key does not fix itself in five
//       minutes, and a tick that retries it every five minutes is a log
//       spammer, not a recovery mechanism.
//
function instaBoxSuspendConfigured(env) {
  return Boolean(env.INSTABOX_API_KEY && env.INSTABOX_MACHINE_ID);
}

/** Classify an InstaBox suspend attempt: is retrying it ever going to help? */
function classifySuspendFailure(status) {
  // No status = the request never completed (DNS, TLS, timeout, reset).
  // That is the transient case: the next tick may well succeed.
  if (!status) return "transient";
  if (status === 401 || status === 403) return "permanent"; // bad/expired key
  if (status === 404) return "permanent"; // machine id gone
  if (status === 400 || status === 422) return "permanent"; // we sent nonsense
  if (status === 409) return "transient"; // mid-transition; try again later
  if (status === 429) return "transient"; // rate limited
  if (status >= 500) return "transient";
  return "transient";
}

async function suspendViaInstaBox(env) {
  if (!env.INSTABOX_MACHINE_ID) {
    return { ok: false, error: "instabox_machine_unset", kind: "permanent" };
  }
  if (!env.INSTABOX_API_KEY) {
    return { ok: false, error: "instabox_api_key_unset", kind: "permanent" };
  }
  const id = encodeURIComponent(env.INSTABOX_MACHINE_ID);
  let res;
  try {
    res = await fetch(`https://api.instabox.sh/v1/machines/${id}/suspend`, {
      method: "POST",
      headers: {
        "X-API-Key": env.INSTABOX_API_KEY,
        "Idempotency-Key": crypto.randomUUID(),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return {
      ok: false,
      error: "suspend_fetch_failed",
      kind: classifySuspendFailure(0),
      detail: String(err?.name || err).slice(0, 200),
    };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return {
      ok: false,
      error: "suspend_failed",
      status: res.status,
      kind: classifySuspendFailure(res.status),
      detail: text.slice(0, 300),
    };
  }
  let body = null;
  try { body = JSON.parse(text); } catch { /* InstaBox may answer 204/empty */ }
  return { ok: true, status: res.status, body };
}

async function keepAliveTick(env, source) {
  const now = Date.now();
  const db = env.QWENPAW_DB && env.USE_D1 === "1" ? env.QWENPAW_DB : null;
  // No D1: we cannot read the rest marker, the reporter, or the routines,
  // so we cannot decide safely. Fall back to the old behaviour (probe):
  // the machine stays awake, which is the safe default.
  if (!db) {
    const result = await probeQwenPaw(env, { allowRetry: true });
    const saved = await saveStatus(env, { ...result, source });
    console.log(`[keepalive:${source}]`, result.status, result.httpStatus, result.note || "", "(no D1: legacy probe)");
    return saved || result;
  }

  // Keep-alive ON/OFF toggle (2026-11-19): gates ONLY this cron tick.
  // Read first, alongside the other decision inputs in the same D1
  // meta reads (0 extra Worker requests — D1 queries are not requests).
  // OFF -> skip with no probe, no wake, no sleep, no state write.
  // Unreadable or invalid -> HOLD, fail closed. Absent = ON.
  // The no-D1 legacy-probe branch above is unchanged: the toggle
  // requires D1, which is the deployed configuration (USE_D1=1).
  let ka;
  try {
    ka = await readKeepAliveEnabled(db);
  } catch {
    console.log(`[keepalive:${source}] hold (keep-alive toggle unreadable)`);
    return { action: "hold", reason: "keepalive-read-error" };
  }
  if (ka !== null && ka !== "0" && ka !== "1") {
    console.log(`[keepalive:${source}] hold (keep-alive toggle invalid: ${ka})`);
    return { action: "hold", reason: "keepalive-read-error" };
  }
  if (ka === "0") {
    console.log(`[keepalive:${source}] skip (keep-alive off)`);
    return { action: "skip", reason: "keepalive-off" };
  }

  // Read all decision inputs BEFORE probing (the probe itself wakes the machine).
  const rest = await manualRestInEffect(env);
  let state = await readSleepState(db);
  const report = await readReport(db);
  const lastVisit = await readLastVisit(db);
  const nextRoutine = await computeNextRoutine(db, report, now);
  const cached = await loadStatus(env);
  const machineUp = cached?.status === "up";
  const reporterStale = !report || !Number.isFinite(report.reportedAt) || (now - report.reportedAt > SW_REPORTER_STALE_MS);
  // Run-start baseline (2026-11-19 stale-baseline incident): the
  // guard's uptime must come from the CURRENT run. KV lastUpAt is the
  // last up-transition / last meaningful status change and freezes
  // under write-on-change, so it can predate the run by hours (live:
  // frozen 2026-11-18T14:30:29Z, true run ~07:45Z 2026-11-19 — the
  // guard fired every tick on 17.4h). The baseline is set once per run
  // at the observed down→up transition and never refreshed while up.
  let runStart = await readRunStart(db);
  const reporterFreshForRecovery = report && Number.isFinite(report.reportedAt) && (now - report.reportedAt <= SW_REPORTER_RECOVERY_MS);
  let recovered = false;
  if (state.mode === "sleeping" && reporterFreshForRecovery) {
    // STUCK-STATE RECOVERY (2026-11-19): the state can strand on
    // "sleeping" while the machine is up — the tick early-returns without
    // probing whenever the state is "sleeping", and the only flip back to
    // "running" on a live probe sits below that return, unreachable while
    // sleeping. The machine can be woken outside this Worker's wake path
    // (the routines Worker, a manual wake), so the Worker never records
    // the wake; the only exit was a routine coming due. The machine-side
    // reporter posts every 2 min from the machine itself, so a FRESH
    // report is proof the machine is up — no probe is needed to establish
    // that. If the state says "sleeping" but the reporter reported within
    // the last 5 min, flip the state to "running" (reason "reporter_up")
    // BEFORE the decision, so the max-run guard can fire in this same
    // tick. Reset the baseline FIRST: the machine just came back, so
    // any stored baseline predates the down period; the flip's recorded
    // uptimeSec is computed from the reset baseline below (the
    // reporter's uptimeSec when it carries one, else ~0 — the live
    // reporter posts null, it cannot know run start). A stale or
    // missing report never flips (fail closed). DEPLOY NOTE: do NOT
    // deploy this while a run is already past 7h uptime — the guard
    // fires on the next tick and sleeps the machine immediately.
    // Deploy only in a fresh run (uptime well under 7h); see
    // features/smart-sleep/README.md.
    runStart = baselineFromReport(report, now);
    await writeRunStart(db, runStart);
    recovered = true;
  }
  // RECONCILE (2026-11-19): the live state can ALREADY be "running"
  // with a stale or missing baseline — the flip already happened, or
  // the Worker was down during the transition — so a fix that only
  // resets the baseline on a future flip would never fire. A fresh
  // report (same 5-min bar as the flip: reporter evidence alone, no
  // probe) with no baseline initializes it from the report. A stale
  // report never initializes (fail closed — the machine may be down,
  // and a baseline of "now" would understate the next run).
  if (!runStart && reporterFreshForRecovery) {
    runStart = baselineFromReport(report, now);
    await writeRunStart(db, runStart);
    console.log(`[keepalive:${source}] initialized run-start baseline from fresh reporter`);
  }
  // Uptime: reporter uptimeSec (fresh) > run-start baseline > unknown
  // (0, which fails the uptime guards — fail closed). No lastUpAt
  // fallback: it can predate the run (see above).
  const uptimeSec = computeUptimeSec(report, reporterStale, runStart, now);
  const uptimeMin = uptimeSec === null ? 0 : uptimeSec / 60;
  if (recovered) {
    const recordedSec = Math.round(uptimeMin * 60);
    await writeSleepState(db, { mode: "running", reason: "reporter_up", uptimeSec: recordedSec });
    state = { ...state, mode: "running", reason: "reporter_up", uptimeSec: recordedSec, since: now };
    console.log(`[keepalive:${source}] recovered stuck sleeping state via fresh reporter (uptimeMin=${uptimeMin})`);
  }

  const decision = decideSleepWake({
    nextRoutineAt: nextRoutine.at,
    lastVisitAt: lastVisit,
    lastAgentActivityAt: report && Number.isFinite(report.agentLastActiveAt) ? report.agentLastActiveAt : null,
    lastWakeAt: state.lastWakeAt ?? null,
    reporterStale,
    restActive: rest.resting,
    machineUp,
    uptimeMin,
    sleepState: state.mode,
  }, now);
  console.log(`[keepalive:${source}] decision=${decision.action} reason=${decision.reason} nextRoutine=${nextRoutine.at === Infinity ? "none" : nextRoutine.at === null ? "unknown" : new Date(nextRoutine.at).toISOString()} (${nextRoutine.source}) state=${state.mode} up=${machineUp}`);

  // SLEEP (v3, 2026-11-23): marker first, then suspend the machine DIRECTLY
  // through InstaBox. v2 asked Pages to do this and failed seven times with
  // `pages_sleep_failed` for reasons invisible from here; see the long note on
  // suspendViaInstaBox above. The order is unchanged and still important: the
  // marker is written BEFORE the call, so a successful suspend can never leave
  // a state that says "running" and invite a wake.
  if (decision.action === "sleep") {
    await writeSleepState(db, { mode: "suspending", reason: decision.reason, lastSleepAt: now });
    // BACKOFF, not a permanent give-up (v3, 2026-11-23). A permanent failure
    // (401 bad key, 404 wrong machine id) does not fix itself five minutes
    // later — retrying it every tick is exactly the seven-failure loop this
    // version exists to end. But never retrying it means a fixed key is never
    // noticed, so the retry is spaced to once an hour: frequent enough to
    // recover unattended, sparse enough not to be a loop.
    const blockedFor = state.suspendBlockedAt ? now - Number(state.suspendBlockedAt) : null;
    if (Number.isFinite(blockedFor) && blockedFor >= 0 && blockedFor < SW_SLEEP_BLOCK_RETRY_MS) {
      // A config error that has since been fixed is worth retrying at once.
      const configNowPresent = instaBoxSuspendConfigured(env);
      const wasConfigError = /_unset/.test(String(state.reason || ""));
      if (!(wasConfigError && configNowPresent)) {
        console.log(`[keepalive:sleep] held (suspend blocked ${Math.round(blockedFor / 60000)} min ago: ${state.reason || "unknown"})`);
        return { ...(cached || { status: "up" }), sleepwake: { action: "hold", reason: `blocked:${state.reason || "unknown"}`, nextRoutineAt: nextRoutine.at, nextRoutineSource: nextRoutine.source } };
      }
      console.log("[keepalive:sleep] retrying suspend: the missing config is now present");
    }
    const susp = await suspendViaInstaBox(env);
    if (susp.ok) {
      await writeSleepState(db, { mode: "sleeping", reason: decision.reason, lastSleepAt: now, suspendBlockedAt: null });
      const saved = await saveStatus(env, { status: "sleeping", httpStatus: 0, note: `Intelligent sleep: ${decision.reason}. Next routine ${nextRoutine.at === Infinity ? "none" : new Date(nextRoutine.at).toISOString()}.`, source });
      console.log("[keepalive:sleep] suspended via InstaBox", JSON.stringify(susp.body || {}).slice(0, 200));
      return saved || { status: "sleeping" };
    }
    console.log("[keepalive:sleep] suspend FAILED, staying awake:", susp.error, susp.status || "", susp.detail || "");
    if (susp.kind === "permanent") {
      // Record the block IN THE REASON so /sleepwake/state explains why this
      // machine will not sleep, and stamp suspendBlockedAt so the next tick
      // backs off instead of repeating the same doomed call. The mode stays
      // "running": the machine is genuinely up.
      await writeSleepState(db, { mode: "running", reason: `sleep_blocked:${susp.error}${susp.status ? `:${susp.status}` : ""}`, suspendBlockedAt: now });
      console.log("[keepalive:sleep] blocking future suspends until the cause changes");
    } else {
      await writeSleepState(db, { mode: "running", reason: `sleep_failed:${susp.error}` });
    }
    // Fall through to the probe in BOTH cases (fail-awake): the machine is up,
    // and a probe keeps the status honest about that. Skipping it would leave
    // the last-known status frozen at whatever it said before the failed
    // suspend, which is how the Pages UI ends up lying about a machine that is
    // plainly awake.
  }

  // WAKE: the machine is down and a routine is due. Probe (wakes a paused
  // machine) and record the transition.
  if (decision.action === "wake") {
    await writeSleepState(db, { mode: "waking", reason: decision.reason, lastWakeAt: now });
    const result = await probeQwenPaw(env, { allowRetry: true });
    const saved = await saveStatus(env, { ...result, source });
    console.log(`[keepalive:${source}]`, result.status, result.httpStatus, result.note || "", "(wake for routine)");
    // Run-start baseline (2026-11-19): a probe that finds the machine
    // up after it was recorded down is a down→up transition — this is a
    // new run. Set the baseline once; never refresh while up.
    if (result.status === "up" && (cached?.status !== "up" || !runStart)) {
      runStart = Date.now();
      await writeRunStart(db, runStart);
    }
    if (result.status === "up") {
      await writeSleepState(db, { mode: "running", reason: "wake_ok", lastWakeAt: now });
    } else if (result.status === "offline" || result.status === "waking") {
      // API-wake fallback (only when INSTABOX_API_KEY is set; it is not on
      // this Worker today, so this is usually skipped) — still respects the
      // manual rest and the 10-min gap.
      if (!rest.resting && env.INSTABOX_API_KEY && env.INSTABOX_MACHINE_ID) {
        const lastWake = saved?.lastWakeAt ? Date.parse(saved.lastWakeAt) : 0;
        if (now - lastWake >= WAKE_MIN_GAP_MS) {
          const wake = await callInstaBoxWake(env);
          await saveStatus(env, { lastWakeAt: new Date().toISOString(), lastWakeResult: wake }, true);
        }
      }
    }
    return saved || result;
  }

  // HOLD: if the machine is intentionally sleeping, do NOT probe — probing
  // would wake it. Just report the cached state. If it is up (or unknown),
  // probe as before to keep the status fresh and the machine awake.
  if (state.mode === "sleeping") {
    console.log(`[keepalive:${source}] holding (machine intentionally asleep)`);
    return { ...(cached || { status: "sleeping" }), sleepwake: { action: "hold", reason: decision.reason, nextRoutineAt: nextRoutine.at, nextRoutineSource: nextRoutine.source } };
  }
  const result = await probeQwenPaw(env, { allowRetry: true });
  const saved = await saveStatus(env, { ...result, source });
  console.log(`[keepalive:${source}]`, result.status, result.httpStatus, result.note || "");
  // Run-start baseline (2026-11-19): same down→up transition as the
  // wake path — a probe that finds the machine up after it was recorded
  // down (or with no baseline at all) starts a new run. Steady state
  // (recorded up + baseline present) writes nothing.
  if (result.status === "up" && (cached?.status !== "up" || !runStart)) {
    runStart = Date.now();
    await writeRunStart(db, runStart);
  }
  if ((result.status === "offline" || result.status === "waking") && env.INSTABOX_API_KEY && env.INSTABOX_MACHINE_ID) {
    const rest2 = rest;
    if (rest2.resting) {
      console.log(`[keepalive:rest] skipping wake (${rest2.reason})`);
      return saved || result;
    }
    const lastWake = saved?.lastWakeAt ? Date.parse(saved.lastWakeAt) : 0;
    if (Date.now() - lastWake >= WAKE_MIN_GAP_MS) {
      const wake = await callInstaBoxWake(env);
      console.log("[keepalive:wake-fallback]", wake);
      await saveStatus(env, { lastWakeAt: new Date().toISOString(), lastWakeResult: wake }, true);
    }
  }
  // Keep the sleep state in sync with what the probe found.
  if (result.status === "up" && state.mode !== "running") {
    await writeSleepState(db, { mode: "running", reason: "probe_up" });
  } else if ((result.status === "offline" || result.status === "cooldown") && state.mode === "running") {
    await writeSleepState(db, { mode: "sleeping", reason: `probe_${result.status}` });
  }
  return saved || result;
}

// --- D1 store (inlined from features/storage/store.js) ----------------
// Canonical copy: features/storage/store.js (harness-tested there).
// Pages _worker.js and the API-uploaded standalone Workers are single
// files with no bundler, so the store is inlined here; keep the two in
// sync. D1 when env.USE_D1 === "1" and env.QWENPAW_DB is bound,
// otherwise the KV binding — same get/put/delete/list interface.
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

function createStore(env, kv) {
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

export default {
  async fetch(request, env, ctx) {
    env = { ...env, STATUS: createStore(env, env.STATUS) };
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/") {
      return json({ service: "qwenpaw-keepalive", endpoints: ["/status", "/ping", "/wake", "/report", "/keepalive", "/sleepwake/state"], qwenpawUrl: env.QWENPAW_URL || null });
    }

    if (path === "/status" && request.method === "GET") {
      // Keep-alive toggle state (2026-11-19): public read-only fields,
      // read from D1 in this handler (no extra client request). Omitted
      // when D1 is unavailable.
      const db = env.QWENPAW_DB && env.USE_D1 === "1" ? env.QWENPAW_DB : null;
      const kaFields = db ? await readKeepAlivePublic(db) : null;
      // Next scheduled run (2026-11-19): the status page shows it from
      // /status sleepwake.nextRoutineAt. Same computeNextRoutine the cron
      // tick uses — the stored status never carried a sleepwake field
      // (the tick's hold-sleeping branch returns it without saving), so
      // before this fix the page always showed "Not scheduled". /status
      // is user-paced (one GET on load + Refresh clicks), so the extra
      // D1 reads are proportional to user action. Omitted when D1 is
      // unavailable. Infinity (no routines) and null (unknown) both
      // serialize as null, which the page renders as "Not scheduled".
      let swFields = null;
      if (db) {
        try {
          const report = await readReport(db);
          const nextRoutine = await computeNextRoutine(db, report, Date.now());
          swFields = { sleepwake: { nextRoutineAt: Number.isFinite(nextRoutine.at) ? nextRoutine.at : null, nextRoutineSource: nextRoutine.source } };
        } catch { swFields = null; }
      }
      const withKa = (obj) => ({ ...obj, ...(kaFields || {}), ...(swFields || {}) });
      if (url.searchParams.get("live") === "1") {
        const live = await probeQwenPaw(env, { allowRetry: false });
        const saved = await saveStatus(env, { ...live, source: "status-live" });
        return json(withKa({ ...saved, consoleUrl: env.QWENPAW_URL || null }));
      }
      const cached = await loadStatus(env);
      if (!cached) return json(withKa({ status: "unknown", note: "No ping has run yet — wait for the next cron tick, or call /ping.", consoleUrl: env.QWENPAW_URL || null }));
      return json(withKa({ ...cached, consoleUrl: env.QWENPAW_URL || null }));
    }

    if (path === "/ping") {
      const result = await probeQwenPaw(env, { allowRetry: true });
      const saved = await saveStatus(env, { ...result, source: "manual-ping" });
      return json(saved || result);
    }

    if (path === "/wake" && request.method === "POST") {
      // Gated (fix 2026-11-15, audit finding workers-keepalive-unauth-wake):
      // unauthenticated POST /wake forced probes and, if INSTABOX_API_KEY
      // were ever set without a token, would trigger InstaBox API wakes.
      // Fail closed when WAKE_TOKEN is unset; header X-Wake-Token only
      // (never a ?token= query — tokens in URLs leak in logs/Referer).
      if (!env.WAKE_TOKEN) {
        return json({ error: "manual wake disabled: WAKE_TOKEN secret is not set. Use GET /ping (public wake path) instead." }, 503);
      }
      const token = request.headers.get("X-Wake-Token") || "";
      if (token !== env.WAKE_TOKEN) return json({ error: "unauthorized" }, 401);
      const result = await probeQwenPaw(env, { allowRetry: true });
      let wake = null;
      if ((result.status === "offline" || result.status === "waking") && env.INSTABOX_API_KEY && env.INSTABOX_MACHINE_ID) {
        const cached = await loadStatus(env);
        const lastWake = cached?.lastWakeAt ? Date.parse(cached.lastWakeAt) : 0;
        if (Date.now() - lastWake >= WAKE_MIN_GAP_MS) {
          wake = await callInstaBoxWake(env);
        } else {
          wake = { skipped: "rate-limited — last API wake was <10 min ago" };
        }
      }
      // Only include the wake marker when a wake actually fired: spreading
      // `lastWakeAt: undefined` would WIPE the stored marker (spread
      // copies undefined), losing the 10-min API-wake gap protection.
      const wakePatch = (wake && !wake.skipped)
        ? { lastWakeAt: new Date().toISOString(), lastWakeResult: wake }
        : {};
      const saved = await saveStatus(env, { ...result, source: "manual-wake", ...wakePatch }, !!(wake && !wake.skipped));
      return json({ ...(saved || result), wake });
    }

    // ---- intelligent sleep/wake: machine reporter + state read ----
    // POST /report: the machine-side reporter (systemd timer, every 2 min)
    // posts {nextNativeRun, agentActive, agentLastActiveAt, uptimeSec}.
    // Auth: X-Reporter-Token must match REPORTER_TOKEN; fail closed 503
    // when the secret is unset. The body is small, validated, and stored
    // verbatim in D1 meta (sleepwake:report) for the cron decision.
    if (path === "/report" && request.method === "POST") {
      if (!env.REPORTER_TOKEN) {
        return json({ error: "reporter_unconfigured", detail: "REPORTER_TOKEN secret is not set." }, 503);
      }
      const supplied = request.headers.get("X-Reporter-Token") || "";
      // Constant-time compare (the reporter token gates sleep decisions).
      let ok = supplied.length === env.REPORTER_TOKEN.length;
      if (ok) {
        for (let i = 0; i < supplied.length; i++) ok = ok && supplied.charCodeAt(i) === env.REPORTER_TOKEN.charCodeAt(i);
      }
      if (!ok) return json({ error: "unauthorized" }, 401);
      let body = null;
      try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
      if (!body || typeof body !== "object") return json({ error: "bad_body" }, 400);
      const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const report = {
        nextNativeRun: num(body.nextNativeRun),
        agentActive: body.agentActive === true,
        agentLastActiveAt: num(body.agentLastActiveAt),
        uptimeSec: num(body.uptimeSec),
        reportedAt: Date.now(),
      };
      const db = env.QWENPAW_DB && env.USE_D1 === "1" ? env.QWENPAW_DB : null;
      if (!db) return json({ error: "store_unavailable" }, 503);
      const wrote = await swMetaPut(db, "sleepwake:report", JSON.stringify(report));
      if (!wrote) return json({ error: "store_unavailable" }, 503);
      return json({ ok: true, stored: report });
    }

    // POST /keepalive: flip the keep-alive cron ON/OFF (2026-11-19).
    // Auth: header `Authorization: Bearer <WAKE_TOKEN>` ONLY (never a
    // ?token= query — tokens in URLs leak in logs/Referer). WAKE_TOKEN
    // is already a Worker secret; no new secret is invented. The token
    // comparison copies the /report handler's length + charCodeAt loop.
    // On success writes exactly two D1 meta rows (keepalive:enabled
    // '1'/'0' + keepalive:updated ISO timestamp). Does NOT sleep, wake,
    // or probe — it only flips the toggle the next cron tick reads.
    // Non-POST -> 405 with Allow: POST.
    if (path === "/keepalive") {
      if (request.method !== "POST") {
        return new Response(null, { status: 405, headers: { ...CORS, Allow: "POST" } });
      }
      if (!env.WAKE_TOKEN) {
        return json({ error: "keepalive_unconfigured", detail: "WAKE_TOKEN secret is not set." }, 503);
      }
      const auth = request.headers.get("Authorization") || "";
      const supplied = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
      let ok = supplied.length === env.WAKE_TOKEN.length;
      if (ok) {
        for (let i = 0; i < supplied.length; i++) ok = ok && supplied.charCodeAt(i) === env.WAKE_TOKEN.charCodeAt(i);
      }
      if (!ok) return json({ error: "unauthorized" }, 401);
      let body = null;
      try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.enabled !== "boolean") {
        return json({ error: "bad_body", detail: "body must be a JSON object with boolean `enabled`." }, 400);
      }
      const db = env.QWENPAW_DB && env.USE_D1 === "1" ? env.QWENPAW_DB : null;
      if (!db) return json({ error: "store_unavailable" }, 503);
      const updatedAt = new Date().toISOString();
      const w1 = await swMetaPut(db, "keepalive:enabled", body.enabled ? "1" : "0");
      const w2 = w1 ? await swMetaPut(db, "keepalive:updated", updatedAt) : false;
      if (!w1 || !w2) return json({ error: "store_unavailable" }, 503);
      return json({ ok: true, enabled: body.enabled, updatedAt });
    }

    // GET /sleepwake/state: public read of the sleep/wake decision inputs
    // (mode, next routine, last visit/activity, reporter freshness). No
    // secrets, no values — safe to expose for the status page / debugging.
    if (path === "/sleepwake/state" && request.method === "GET") {
      const db = env.QWENPAW_DB && env.USE_D1 === "1" ? env.QWENPAW_DB : null;
      if (!db) return json({ error: "store_unavailable" }, 503);
      const now = Date.now();
      const state = await readSleepState(db);
      const report = await readReport(db);
      const lastVisit = await readLastVisit(db);
      const nextRoutine = await computeNextRoutine(db, report, now);
      const rest = await manualRestInEffect(env);
      const cached = await loadStatus(env);
      // Live uptime (2026-11-19): the SAME precedence as the tick —
      // reporter uptimeSec (fresh) > run-start baseline > unknown —
      // so the endpoint shows the uptime the guard would use right
      // now, not the value a past reporter_up flip recorded (that
      // stale 62729 sat in this field for hours after the flip). The
      // flip's recorded value is still in the state row for audit.
      const runStart = await readRunStart(db);
      const reporterStale = !report || !Number.isFinite(report.reportedAt) || (now - report.reportedAt > SW_REPORTER_STALE_MS);
      return json({
        mode: state.mode,
        since: state.since || null,
        reason: state.reason || null,
        lastWakeAt: state.lastWakeAt || null,
        lastSleepAt: state.lastSleepAt || null,
        uptimeSec: computeUptimeSec(report, reporterStale, runStart, now),
        runStartAt: runStart ? new Date(runStart).toISOString() : null, // run-start baseline (null until the first fresh-reporter / probe-confirmed tick)
        keepAlive: (await readKeepAlivePublic(db)).keepAlive,
        nextRoutineAt: nextRoutine.at,
        nextRoutineSource: nextRoutine.source,
        lastVisitAt: lastVisit,
        lastAgentActivityAt: report?.agentLastActiveAt ?? null,
        reporterFresh: !!report && Number.isFinite(report.reportedAt) && (now - report.reportedAt <= SW_REPORTER_STALE_MS),
        reporterLastAt: report?.reportedAt ?? null,
        restActive: rest.resting,
        restReason: rest.reason,
        machineStatus: cached?.status ?? "unknown",
        checkedAt: new Date(now).toISOString(),
      });
    }

    return json({ error: "not found", endpoints: ["/status", "/ping", "/wake", "/report", "/keepalive", "/sleepwake/state"] }, 404);
  },

  async scheduled(event, env, ctx) {
    env = { ...env, STATUS: createStore(env, env.STATUS) };
    ctx.waitUntil(keepAliveTick(env, `cron:${event.cron}`));
  },
};

// Named exports for the harness (features/sleepwake/harness-sleepwake.mjs).
// The Worker runtime only uses the default export; these are inert there.
export { decideSleepWake, nextRun, readKeepAliveEnabled };
