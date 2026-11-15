/**
 * Teach recording — the input recorder, the playbook builder, and the draft.
 *
 * WHY THIS IS A MODULE AND NOT INLINE IN ui.html
 *
 * The brief's history matters here. The previous UI "recorded start/stop and
 * said a draft was saved" while no recorder existed — it was a button and a
 * toast, and the recorder was listed as deliberately not built. A feature that
 * reports success without doing the work is worse than a missing feature: it
 * teaches the user to trust a false claim.
 *
 * So the recorder is written to be testable without a browser, and its tests
 * assert the two things a recorder can get wrong in ways that hurt:
 *
 *   1. It must never capture a secret. There is a Sensitive toggle, but a
 *      toggle is a promise the user has to keep. `redact()` is the backstop:
 *      password-shaped text is replaced even when Sensitive is off, because
 *      the failure mode (a password in a skill file, in a D1 row, in a lesson)
 *      is permanent.
 *
 *   2. It must produce steps a person can read and an agent can follow. A raw
 *      event dump is not a draft; "Click left button at (412, 233)" is.
 *
 * The playbook shape is 8 fields, matching the recorded T55 acceptance
 * criterion: Name / When to use / Inputs / Steps / How to check / What to
 * return / Approval boundaries / Failure handling.
 */

/** Events a recorder may hold before it starts dropping the oldest. */
export const MAX_EVENTS = 500;

/**
 * Texts that must never be recorded verbatim.
 *
 * Deliberately broad. A false positive costs a redacted step in a skill draft;
 * a false negative costs a password in the repo. The asymmetry decides it.
 */
const SECRET_SHAPED = [
  /pass(word|phrase|code)?/i,
  /\bpin\b/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  // `api key`, `api_key`, `api-key`, `apikey` — the space form was missed by
  // the first version, so "Enter your API key" recorded as ordinary text.
  /\bapi[\s_-]?key\b/i,
  // Provider key prefixes. A test caught `sk-live-...` slipping through
  // because the word "key" appears nowhere in the string itself.
  /\b(sk|pk|rk|xox[baprs])[-_][A-Za-z0-9_-]{8,}/,
  /\bcvv\b|\bcvc\b|\bsecurity code\b/i,
  /\bssn\b|social security/i,
  /\bseed phrase\b|\brecovery code\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/, // card-shaped
  // A long alphanumeric run with no spaces: the shape of a token even when no
  // other clue is present. Deliberately NOT matching ordinary prose.
  /\b[A-Za-z0-9_-]{40,}\b/,
];

/** Inputs that look like credentials regardless of surrounding words. */
const SECRET_INPUT_TYPES = new Set(["password", "email", "tel", "number"]);

/**
 * Should this text be replaced with a placeholder?
 *
 * `sensitive` (the user's toggle) forces redaction. Without it, the shape
 * check still applies — that is the backstop.
 */
export function shouldRedact(text, sensitive = false) {
  if (sensitive) return Boolean(String(text || "").length);
  const t = String(text || "");
  if (!t) return false;
  return SECRET_SHAPED.some((re) => re.test(t));
}

export function redact(text, sensitive = false) {
  return shouldRedact(text, sensitive) ? "[redacted input]" : String(text || "");
}

/**
 * The recorder.
 *
 * Deliberately not an event listener wrapper: it takes already-normalised
 * events. Keeping the transport (postMessage, DOM listeners) out of this file
 * is what lets the harness exercise it in Node, and it is the difference
 * between "there is a recorder" and "there is a start button".
 */
export class Recorder {
  constructor({ goal = "", sensitive = false } = {}) {
    this.goal = goal;
    this.sensitive = sensitive;
    this.events = [];
    this.startedAt = null;
    this.dropped = 0;
  }

  start(now = Date.now()) {
    this.startedAt = now;
    this.events = [];
    this.dropped = 0;
    return this;
  }

  setSensitive(on) {
    this.sensitive = Boolean(on);
    return this;
  }

  /**
   * Record one normalised event.
   *
   * Shapes (all optional except `kind`):
   *   {kind:"pointer", type:"click"|"down"|"up"|"move", x, y, button}
   *   {kind:"key", key}                     — a single character or a named key
   *   {kind:"clipboard", text}              — a paste
   *   {kind:"scroll", type:"up"|"down"|"left"|"right", amount, x, y}
   *   {kind:"nav", url}                     — a navigation the recorder saw
   *
   * Pointer `move` is sampled by the caller (the shim throttles it); doing it
   * here would tie the module to a clock the tests cannot control.
   */
  record(ev, now = Date.now()) {
    if (!ev || typeof ev.kind !== "string") return false;
    // Clipboard and key text are the only fields that can carry a secret; they
    // are redacted at RECORD time, not at build time, so a raw event log never
    // exists on disk or in memory with the secret in it.
    const copy = { ...ev, at: now - (this.startedAt || now) };
    if (ev.kind === "key" && typeof ev.key === "string" && ev.key.length === 1) {
      copy.key = this.sensitive ? "" : ev.key;
      copy.redacted = this.sensitive;
    }
    if (ev.kind === "clipboard") {
      const value = redact(ev.text, this.sensitive);
      copy.text = value;
      copy.redacted = value !== ev.text;
    }
    if (ev.kind === "nav" && typeof ev.url === "string") {
      // A URL can carry a token in a query string. Keep the shape, drop the
      // credentials — this is the same rule the Worker applies to ?token=.
      copy.url = stripUrlSecrets(ev.url);
    }
    this.events.push(copy);
    if (this.events.length > MAX_EVENTS) {
      // Drop from the FRONT: the end of a demonstration is the part that
      // matters, and a bound that discards the outcome would be useless.
      this.events.splice(0, this.events.length - MAX_EVENTS);
      this.dropped += 1;
    }
    return true;
  }

  get count() {
    return this.events.length;
  }

  /** The draft playbook. This is what the editor opens with. */
  build() {
    return buildPlaybook(this.goal, this.events, { sensitive: this.sensitive });
  }
}

/** Remove query-string credentials from a recorded URL. */
export function stripUrlSecrets(raw) {
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) {
      if (/token|key|secret|password|code|auth|session/i.test(key)) {
        u.searchParams.set(key, "***");
      }
    }
    // Drop the fragment entirely: SPA routes can carry an OAuth access token
    // there (`#access_token=...`), which is easy to miss.
    u.hash = "";
    return u.toString();
  } catch {
    return String(raw || "").replace(/\?.*$/, "");
  }
}

/** Human-readable pointer description. */
function describePointer(ev) {
  const x = Number.isFinite(ev.x) ? ev.x : 0;
  const y = Number.isFinite(ev.y) ? ev.y : 0;
  const button = ev.button === 2 ? "right" : ev.button === 1 ? "middle" : "left";
  const action = ev.type || "click";
  if (action === "move") return null; // folded into drags; a lone move is noise
  if (action === "down") return { opens: { button, x, y } };
  if (action === "up") return { closes: { button, x, y } };
  return { text: `Click ${button} button at (${x}, ${y}).` };
}

/**
 * Turn events into the 8-field playbook.
 *
 * The interesting work is coalescing: a demonstration of typing produces one
 * keydown per character, and a drag produces down + N moves + up. Emitting
 * them raw makes a 200-step skill that no agent can follow and no person will
 * read. So consecutive characters become one "Type ..." step, and a
 * down/move/up with real displacement becomes one "Drag ..." step.
 */
export function buildPlaybook(goal, events, { sensitive = false } = {}) {
  const steps = [];
  let typed = "";
  let typedRedacted = false;
  let drag = null;

  const flushTyped = () => {
    if (!typed && !typedRedacted) return;
    steps.push(`Type ${JSON.stringify(typedRedacted ? "[redacted input]" : typed)}.`);
    typed = "";
    typedRedacted = false;
  };
  const flushDrag = () => {
    if (!drag) return;
    const dx = drag.toX - drag.fromX;
    const dy = drag.toY - drag.fromY;
    const moved = Math.hypot(dx, dy) >= 8;
    steps.push(moved
      ? `Drag ${drag.button} button from (${drag.fromX}, ${drag.fromY}) to (${drag.toX}, ${drag.toY}).`
      : `Click ${drag.button} button at (${drag.fromX}, ${drag.fromY}).`);
    drag = null;
  };
  const flushPending = () => { flushTyped(); flushDrag(); };

  for (const ev of events || []) {
    if (!ev) continue;

    if (ev.kind === "key") {
      flushDrag();
      if (ev.redacted) { typedRedacted = true; continue; }
      const k = ev.key;
      if (!k) continue;
      if (k.length === 1) { typed += k; continue; }
      // A named key (Enter, Tab, Escape) ends a text run and is its own step.
      flushTyped();
      steps.push(`Press key: ${k}.`);
      continue;
    }

    if (ev.kind === "pointer") {
      const described = describePointer(ev);
      if (described?.opens) {
        flushTyped();
        flushDrag();
        // fromX/fromY, not x/y: flushDrag reads the endpoints by those names,
        // and spreading `opens` directly produced `(undefined, undefined)` in
        // every drag step — a draft that looked fine and was unusable.
        drag = {
          button: described.opens.button,
          fromX: described.opens.x,
          fromY: described.opens.y,
          toX: described.opens.x,
          toY: described.opens.y,
        };
        continue;
      }
      if (ev.type === "move" && drag) {
        drag.toX = Number.isFinite(ev.x) ? ev.x : drag.toX;
        drag.toY = Number.isFinite(ev.y) ? ev.y : drag.toY;
        continue;
      }
      if (described?.closes && drag) {
        drag.toX = Number.isFinite(ev.x) ? ev.x : drag.toX;
        drag.toY = Number.isFinite(ev.y) ? ev.y : drag.toY;
        flushDrag();
        continue;
      }
      flushPending();
      if (described?.text) steps.push(described.text);
      continue;
    }

    flushPending();
    if (ev.kind === "clipboard") {
      const text = redact(ev.text, sensitive || ev.redacted);
      if (text) steps.push(`Paste or type: ${JSON.stringify(text)}.`);
      continue;
    }
    if (ev.kind === "scroll") {
      const dir = ["up", "down", "left", "right"].includes(ev.type) ? ev.type : "down";
      const amount = Number(ev.amount);
      const at = Number.isFinite(ev.x) && Number.isFinite(ev.y) ? ` at (${ev.x}, ${ev.y})` : "";
      steps.push(Number.isFinite(amount) && amount > 1
        ? `Scroll ${dir} ${amount} times${at}.`
        : `Scroll ${dir}${at}.`);
      continue;
    }
    if (ev.kind === "nav") {
      steps.push(`Open ${ev.url}.`);
      continue;
    }
    // Unknown kinds are skipped rather than fatal: a newer recorder emitting a
    // kind this build does not know should degrade to a shorter draft.
  }
  flushPending();

  if (steps.length === 0) {
    steps.push("Repeat the demonstrated workflow using the same navigation pattern.");
  }

  // The final screen, if the recorder captured one, is the check. Without it,
  // the honest thing is to say what cannot be verified — not to invent a
  // condition that will always pass.
  const lastNav = [...(events || [])].reverse().find((e) => e && e.kind === "nav");
  return {
    name: (goal || "").trim().slice(0, 80) || "Taught skill",
    whenToUse: (goal || "").trim() || "When the user asks to repeat the demonstrated task.",
    inputs: (goal || "").trim() ? [(goal || "").trim()] : [],
    steps,
    howToCheck: lastNav
      ? `The final screen should be ${lastNav.url}.`
      : "Confirm the outcome matches the user's goal before reporting success.",
    whatToReturn: "A short summary of what was completed and where outputs were saved.",
    approvalBoundaries:
      "Do not send messages, spend money, publish content, or delete data without explicit user approval.",
    failureHandling:
      "If a step fails or the expected screen is not visible, stop and ask the user before retrying.",
  };
}

/**
 * The prompt a "Test" button copies: the playbook rendered for an agent.
 *
 * Separate from the playbook because a skill file and a chat prompt have
 * different jobs — the file is the record, the prompt is the instruction.
 */
export function formatSkillRunPrompt(name, playbook, { test = false } = {}) {
  const lines = [`Run taught skill: ${name}`];
  if (test) lines.push("This is a safe test run. Do not send, spend, delete, or publish anything.");
  lines.push(`When to use: ${playbook.whenToUse}`);
  if (playbook.inputs?.length) lines.push(`Inputs: ${playbook.inputs.join("; ")}`);
  lines.push("Steps:");
  (playbook.steps || []).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push(`How to check: ${playbook.howToCheck}`);
  lines.push(`Return: ${playbook.whatToReturn}`);
  lines.push(`Approval boundaries: ${playbook.approvalBoundaries}`);
  lines.push(`Failure handling: ${playbook.failureHandling}`);
  return lines.join("\n");
}

/** The 8 editable fields, in the order the editor shows them. */
export const DRAFT_FIELDS = [
  { key: "name", label: "Name", kind: "line", required: true },
  { key: "whenToUse", label: "When to use", kind: "line", required: true },
  { key: "inputs", label: "Inputs", kind: "lines" },
  { key: "steps", label: "Steps", kind: "lines", required: true },
  { key: "howToCheck", label: "How to check", kind: "line", required: true },
  { key: "whatToReturn", label: "What to return", kind: "line" },
  { key: "approvalBoundaries", label: "Approval boundaries", kind: "line" },
  { key: "failureHandling", label: "Failure handling", kind: "line" },
];

/**
 * Validate a draft the user edited.
 *
 * Returns a list of problems; empty means it may be saved. The rule the old
 * UI lacked: a skill with no steps is not a skill, and saving one is how the
 * "draft was saved" toast became a lie.
 */
export function validateDraft(draft) {
  const problems = [];
  if (!draft) return [{ field: "name", problem: "no draft" }];
  if (!String(draft.name || "").trim()) problems.push({ field: "name", problem: "needs a name" });
  if (!Array.isArray(draft.steps) || draft.steps.filter((s) => String(s || "").trim()).length === 0) {
    problems.push({ field: "steps", problem: "needs at least one step" });
  }
  if (draft.approvalBoundaries === "" || draft.approvalBoundaries == null) {
    // Not fatal, but a skill that says nothing about boundaries is one an
    // agent will over-reach with. Surfaced, not enforced.
    problems.push({ field: "approvalBoundaries", problem: "empty — the agent gets no boundary", warn: true });
  }
  return problems;
}
