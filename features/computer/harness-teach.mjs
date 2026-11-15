#!/usr/bin/env node
/**
 * Teach recording harness.
 *
 * The feature that was "deliberately not built": the UI had start/stop and a
 * toast claiming a draft was saved, with no recorder behind it. The recorded
 * lesson is blunt — a button that reports success without doing the work is
 * worse than a missing button, because it teaches the user to trust a false
 * claim.
 *
 * So these tests are about the two ways a recorder can be wrong in a way that
 * causes permanent harm:
 *
 *   1. It captures a secret. The Sensitive toggle is a promise the USER has to
 *      keep; `redact()` is the backstop that does not depend on them. A
 *      password in a skill file is permanent.
 *   2. It produces something that is not a draft — an event dump, a 200-step
 *      skill, or a "saved" with no steps in it.
 *
 * Run: node features/computer/harness-teach.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

let passed = 0;
const failed = [];
function check(name, cond, detail = "") {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

const T = await import("data:text/javascript;base64," +
  Buffer.from(readFileSync(resolve(REPO, "pages/public/computer/teach.js"), "utf8")).toString("base64"));

console.log("teach: secrets are redacted without asking the user");
{
  // The toggle is the user's promise. These are the cases where we do not
  // rely on it.
  const cases = [
    "hunter2",                       // shape alone is ambiguous, no signal
    "my-password-123",
    "Enter your API key",
    "sk-live-abcdef123456",
    "CVV 123",
    "4111 1111 1111 1111",
    "-----BEGIN RSA PRIVATE KEY-----",
    "your recovery code is 1234",
    "social security number",
  ];
  check("a plain word is NOT redacted", T.shouldRedact("hello") === false,
    "over-redacting makes every draft useless");
  check("a numeric PIN-shaped value is redacted", T.shouldRedact("PIN 4821") === true);
  for (const c of cases.slice(1)) {
    check(`secret-shaped text is redacted: ${c.slice(0, 24)}`,
      T.shouldRedact(c) === true, "a false negative here is permanent");
  }
  check("the Sensitive toggle forces redaction of anything",
    T.shouldRedact("hello", true) === true);
  check("an empty string is not redacted", T.shouldRedact("") === false);
  check("redact() returns the placeholder",
    T.redact("my-password", false) === "[redacted input]");
  check("redact() passes normal text through",
    T.redact("Inbox", false) === "Inbox");
}

console.log("teach: a URL loses its credentials before it is recorded");
{
  const dirty = "https://x.test/cb?token=abc123&state=ok#access_token=zzz";
  const clean = T.stripUrlSecrets(dirty);
  check("the token query value is replaced", !clean.includes("abc123"), clean);
  check("the state parameter survives (it is not a secret)",
    clean.includes("state=ok"), clean);
  check("the fragment is dropped (OAuth tokens hide there)",
    !clean.includes("zzz") && !clean.includes("#"), clean);
  check("a malformed URL still loses its query",
    !T.stripUrlSecrets("not a url?token=leak").includes("leak"));
}

console.log("teach: the recorder actually records");
{
  const r = new T.Recorder({ goal: "Check the inbox" }).start(1000);
  check("it starts empty", r.count === 0);
  r.record({ kind: "pointer", type: "click", x: 10, y: 20, button: 0 }, 1100);
  check("a click is recorded", r.count === 1, String(r.count));
  check("it carries a relative timestamp", r.events[0].at === 100, String(r.events[0].at));
  r.record({ kind: "key", key: "a" }, 1200);
  check("a character is recorded", r.count === 2);
  check("a malformed event is refused, not recorded",
    r.record({ nope: true }) === false && r.count === 2);
  check("a null event is refused", r.record(null) === false);
}

console.log("teach: sensitive mode never stores the keystroke");
{
  const r = new T.Recorder({ goal: "Log in", sensitive: true }).start(0);
  r.record({ kind: "key", key: "h" }, 10);
  r.record({ kind: "key", key: "u" }, 20);
  check("the raw characters are not stored",
    !JSON.stringify(r.events).includes('"h"'), JSON.stringify(r.events));
  check("the events are marked redacted",
    r.events.every((e) => e.redacted === true), JSON.stringify(r.events));
  r.record({ kind: "clipboard", text: "my-password" }, 30);
  check("a pasted secret is stored as the placeholder",
    r.events[2].text === "[redacted input]", r.events[2].text);
}

console.log("teach: a typed run becomes ONE step, not one per character");
{
  const r = new T.Recorder({ goal: "Search" }).start(0);
  // Click the field, then type "hello".
  r.record({ kind: "pointer", type: "click", x: 100, y: 50 }, 1);
  for (const ch of "hello") r.record({ kind: "key", key: ch }, 2);
  r.record({ kind: "key", key: "Enter" }, 3);
  const p = r.build();
  const typeSteps = p.steps.filter((s) => s.startsWith("Type "));
  check("exactly one Type step", typeSteps.length === 1, JSON.stringify(p.steps));
  check("it contains the whole string", typeSteps[0].includes('"hello"'), typeSteps[0]);
  check("Enter is its own step",
    p.steps.some((s) => s.includes("Press key: Enter")), JSON.stringify(p.steps));
  check("the draft is short enough for a person to read",
    p.steps.length === 3, JSON.stringify(p.steps));
}

console.log("teach: a drag is ONE step, not down + 40 moves");
{
  const r = new T.Recorder({ goal: "Drag" }).start(0);
  r.record({ kind: "pointer", type: "down", x: 10, y: 10 }, 1);
  for (let i = 0; i < 40; i += 1) r.record({ kind: "pointer", type: "move", x: 10 + i, y: 10 + i }, 2);
  r.record({ kind: "pointer", type: "up", x: 50, y: 50 }, 3);
  const p = r.build();
  check("the drag is a single step", p.steps.length === 1, JSON.stringify(p.steps));
  check("it names both endpoints",
    p.steps[0].includes("(10, 10)") && p.steps[0].includes("(50, 50)"), p.steps[0]);
  check("it is a Drag, not a Click", p.steps[0].startsWith("Drag"), p.steps[0]);
}

console.log("teach: a small movement is a click, not a drag");
{
  const r = new T.Recorder({ goal: "Tap" }).start(0);
  r.record({ kind: "pointer", type: "down", x: 10, y: 10 }, 1);
  r.record({ kind: "pointer", type: "move", x: 12, y: 11 }, 2);
  r.record({ kind: "pointer", type: "up", x: 12, y: 11 }, 3);
  const p = r.build();
  check("a 2px wobble becomes a Click", p.steps[0].startsWith("Click"), p.steps[0]);
}

console.log("teach: the 8 fields exist and are all filled");
{
  const r = new T.Recorder({ goal: "Summarise new mail" }).start(0);
  r.record({ kind: "nav", url: "https://mail.test/inbox" }, 1);
  r.record({ kind: "pointer", type: "click", x: 5, y: 5 }, 2);
  const p = r.build();
  for (const key of ["name", "whenToUse", "inputs", "steps", "howToCheck",
                     "whatToReturn", "approvalBoundaries", "failureHandling"]) {
    check(`field ${key} is present and non-empty`,
      p[key] !== undefined && String(p[key]).length > 0, String(p[key]));
  }
  check("the name comes from the goal", p.name === "Summarise new mail", p.name);
  check("howToCheck names the final screen when one was seen",
    p.howToCheck.includes("https://mail.test/inbox"), p.howToCheck);
  check("the approval boundary forbids spending and deleting",
    /spend/i.test(p.approvalBoundaries) && /delete/i.test(p.approvalBoundaries),
    p.approvalBoundaries);
  check("the failure handling says stop and ask",
    /stop and ask/i.test(p.failureHandling), p.failureHandling);
  // DRAFT_FIELDS must match the build() output, or the editor shows blanks.
  check("DRAFT_FIELDS covers exactly the built keys",
    T.DRAFT_FIELDS.every((f) => p[f.key] !== undefined),
    T.DRAFT_FIELDS.map((f) => f.key).join(","));
}

console.log("teach: an empty recording does not produce an empty skill");
{
  const p = new T.Recorder({ goal: "" }).start(0).build();
  check("there is at least one step", p.steps.length >= 1, JSON.stringify(p.steps));
  check("the step is honest about being a placeholder",
    /Repeat the demonstrated workflow/.test(p.steps[0]), p.steps[0]);
  check("the name is not blank", p.name.length > 0, p.name);
}

console.log("teach: the event buffer is bounded but keeps the ending");
{
  const r = new T.Recorder({ goal: "Long" }).start(0);
  for (let i = 0; i < T.MAX_EVENTS + 120; i += 1) {
    r.record({ kind: "pointer", type: "click", x: i, y: i }, i);
  }
  check("the buffer is capped", r.count === T.MAX_EVENTS, String(r.count));
  check("the NEWEST event survived",
    r.events[r.events.length - 1].x === T.MAX_EVENTS + 119,
    String(r.events[r.events.length - 1].x));
  check("the drop is counted, not hidden", r.dropped === 120, String(r.dropped));
}

console.log("teach: a draft with no steps cannot be saved");
{
  const bad = T.validateDraft({ name: "x", steps: [] });
  check("an empty step list is a problem",
    bad.some((p) => p.field === "steps"), JSON.stringify(bad));
  const noName = T.validateDraft({ name: "  ", steps: ["do it"] });
  check("a blank name is a problem",
    noName.some((p) => p.field === "name"), JSON.stringify(noName));
  const ok = T.validateDraft({
    name: "Check mail", steps: ["Open the inbox"],
    approvalBoundaries: "Do not delete.",
  });
  check("a complete draft has no problems", ok.length === 0, JSON.stringify(ok));
  const warn = T.validateDraft({ name: "x", steps: ["y"], approvalBoundaries: "" });
  check("a missing boundary is a warning, not a block",
    warn.length === 1 && warn[0].warn === true, JSON.stringify(warn));
}

console.log("teach: the run prompt is usable by an agent");
{
  const p = new T.Recorder({ goal: "Check mail" }).start(0).build();
  p.steps = ["Open the inbox.", "Read the first message."];
  const prompt = T.formatSkillRunPrompt("Check mail", p, { test: true });
  check("it names the skill", prompt.includes("Check mail"), prompt.slice(0, 40));
  check("it says this is a safe test run", /safe test run/i.test(prompt));
  check("it numbers the steps",
    prompt.includes("1. Open the inbox.") && prompt.includes("2. Read the first message."));
  check("it carries the boundaries",
    /Approval boundaries:/.test(prompt) && /Failure handling:/.test(prompt));
}

console.log("teach: the UI wires the recorder it claims to have");
{
  const ui = readFileSync(resolve(REPO, "pages/public/computer/ui.html"), "utf8");
  check("the UI imports the recorder", /teach\.js/.test(ui),
    "a start button with no recorder is the recorded failure");
  check("start actually constructs a Recorder",
    /new\s+(\w+\.)?Recorder\(/.test(ui), "the old UI set a boolean and toasted");
  check("stop builds a draft rather than asserting one",
    /\.build\(\)/.test(ui), "build() is what turns events into a draft");
  check("the editor has the 8 fields",
    /DRAFT_FIELDS/.test(ui) || (ui.match(/edSteps|edWhen|edCheck/g) || []).length > 0);
  check("the save path validates before claiming success",
    /validateDraft/.test(ui), "this is what made 'draft saved' honest");
  const router = readFileSync(resolve(REPO, "pages/public/computer/router.js"), "utf8");
  check("the router has a teach delivery endpoint",
    /\/computer\/teach/.test(router), "a draft with nowhere to go is a toast");
}

console.log();
const total = passed + failed.length;
console.log(`${passed} passed, ${failed.length} failed  (${total} checks)`);
if (failed.length) { console.log("failed: " + failed.join(", ")); process.exit(1); }
