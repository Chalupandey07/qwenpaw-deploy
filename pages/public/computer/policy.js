// needs-you policy — the machine-readable form of the T56 fix.
//
// The rule: when the next step is blocked by something only a human can do,
// the agent raises needs-you and STOPS. It never works around the wall.
//
// This module exists because the recorded T56 failure was not a missing
// capability — the banner existed — it was the agent choosing to improvise
// instead. A rule that lives only in a system prompt can be forgotten under
// pressure, so it is also expressed here, where the decision can be checked
// before an action rather than described after one.

/**
 * The blocker classes. Each one is a thing the agent cannot do for the human.
 * `payment` and `passkey` are included because Rakazo treats them the same
 * way, and because both were observed to cause the agent to keep going.
 */
export const BLOCKERS = Object.freeze({
  login: ["sign in", "sign-in", "log in", "login", "password", "username or email"],
  captcha: ["captcha", "i'm not a robot", "verify you are human", "recaptcha", "hcaptcha"],
  twoFactor: ["2fa", "two-factor", "verification code", "authenticator", "one-time code"],
  passkey: ["passkey", "security key", "touch your device"],
  payment: ["card number", "cvv", "billing", "payment method", "purchase"],
  consent: ["accept all cookies", "agree to continue", "age verification"],
});

/** Words that mean "this is a wall", not "this is a form the agent may fill". */
const STRONG = ["required", "sign in to continue", "please log in", "you must"];

/**
 * Classify a screen description.
 *
 * Returns `{ blocked: true, kind, reason }` or `{ blocked: false }`.
 *
 * Deliberately conservative in one direction only: a false positive costs a
 * question the human can answer in seconds, while a false negative costs 31
 * steps of an agent improvising (the recorded failure). So when a blocker
 * pattern and a strong marker both appear, it says blocked even if the context
 * is ambiguous.
 */
export function classifyBlocked(screenText) {
  const text = String(screenText || "").toLowerCase();
  if (!text.trim()) return { blocked: false };

  for (const [kind, patterns] of Object.entries(BLOCKERS)) {
    const hits = patterns.filter((p) => text.includes(p));
    if (!hits.length) continue;
    const strong = STRONG.some((s) => text.includes(s));

    // An entry field is a wall regardless of other wording: "Enter your
    // password" and "6-digit verification code" carry no strong marker and
    // only one pattern, yet they are exactly the steps the agent must not
    // attempt. The first version of this function returned "not blocked" for
    // both — i.e. it would have let the agent try to type a password, which
    // is the recorded T56 failure. Field-shaped blockers are decisive.
    const FIELD_SHAPED = new Set(["login", "twoFactor", "payment"]);
    // "enter your password" is a wall; "change your password" is a settings
    // page the agent may legitimately be asked to visit. Distinguish by verb.
    const MANAGING = /\b(change|update|reset|forgot|manage|settings|edit)\b/.test(text);
    const fieldish = FIELD_SHAPED.has(kind)
      && /\b(enter|type|confirm|provide)\b/.test(text)
      && !MANAGING;

    if (strong || hits.length > 1 || fieldish
        || kind === "captcha" || kind === "passkey") {
      return { blocked: true, kind, reason: `matched "${hits[0]}"` };
    }
  }
  return { blocked: false };
}

/**
 * The action list the agent is forbidden to try once blocked. Naming them
 * makes the failure auditable: a log line saying "attempted alternate_browser
 * while blocked:login" is a test failure, not a judgement call.
 */
export const FORBIDDEN_WHILE_BLOCKED = Object.freeze([
  "alternate_browser",
  "alternate_route",
  "retry_same_step",
  "enter_credentials",
  "continue_after_handback",
]);

/**
 * Decide what the agent should do next.
 *
 * Returns `{ action: "raise", text }` when the wall is real, or
 * `{ action: "proceed" }` when it is not. The caller must honour "raise" by
 * stopping: the whole point is that the HTTP call and the stop are one action.
 */
export function nextAction(screenText, { computer = "default" } = {}) {
  const verdict = classifyBlocked(screenText);
  if (!verdict.blocked) return { action: "proceed" };
  return {
    action: "raise",
    text: `Blocked by a ${verdict.kind} step that only you can complete (${verdict.reason}).`,
    request: {
      method: "POST",
      path: "/computer/needs-you",
      body: {
        computer,
        text: `Blocked by a ${verdict.kind} step that only you can complete (${verdict.reason}).`,
      },
    },
    then: "stop",
  };
}

/**
 * Was an action taken while blocked? Used by the harness and by the log check
 * to turn the policy from advice into an assertion.
 */
export function violation(actionName, wasBlocked) {
  return Boolean(wasBlocked) && FORBIDDEN_WHILE_BLOCKED.includes(actionName);
}
