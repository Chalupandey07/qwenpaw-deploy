# DriverCard policy for the computer — restore after the rebuild

**Why this file exists.** The DriverCards (`computer-use.yaml`,
`computer-use-qa.yaml`) were deleted with `features/desktop/` in the removal
commit. They contained one rule that was *load-bearing* and is not part of the
Worker code, so it went with them:

> When the agent hits a sign-in, CAPTCHA, passkey, or payment wall, it must
> raise **needs-you first** and stop. It must never work around the wall.

That rule is the fix for T56, recorded 2026-11-15:

> T56 FAIL — agent hit Gmail sign-in, said "handing it back to you", worked
> around via desktop Chromium **31 steps with NO needs-you banner ever**.

Thirty-one steps of an agent improvising around an authentication wall is the
worst failure in this repo's log: it burns run-minutes, it may enter
credentials into the wrong field, and the user is never told. The banner existed
and the agent never used it.

Removing the cards without replacing the rule would have silently reintroduced
T56. This file is the rule, written down where the next person will find it, and
`pages/public/computer/policy.js` is the machine-readable form of it.

## The rule, in full

Before ANY click, type, or navigation, the agent asks itself one question:

> **Is the next step blocked by something only the human can do?**

If yes — a login form, a CAPTCHA, a 2FA prompt, a passkey, a payment
confirmation, an "accept cookies" wall that gates the task, an age check, or
anything asking for a credential — the agent MUST:

1. `POST /computer/needs-you` with a one-sentence description of what it needs
   (`{"computer":"default","text":"Gmail is asking for a password"}`);
2. **stop acting on that computer** — no further clicks, no typing, no
   navigation attempts;
3. wait for the human, and when control comes back, **re-read the screen**
   before doing anything else.

It MUST NOT:

- retry the same step in a different browser;
- open a second browser window to get around a sign-in;
- try a different route to the same page;
- type a username or password it found anywhere;
- "hand it back" in chat and then keep going.

The recorded T56 failure was exactly items 2 and 3 of the forbidden list.

## Why it needs to be in the card, not just the prompt

The DriverCard is what the computer-use MCP proxy enforces per tool call, and
it is hot-reloadable. A rule in a system prompt can be forgotten under
pressure; a rule in the driver is checked at the point of action. Both should
carry it — this file is the source of truth for the card text.

## Restoring the cards

Muse, when the rebuilt computer is deployed:

```yaml
# computer-use.yaml — the fragment that matters
policies:
  needs_you_first:
    trigger: |
      a login form, CAPTCHA, 2FA prompt, passkey, payment confirmation,
      age check, or any credential request
    action: |
      POST http://172.18.0.1:8898/computer/needs-you
        {"computer":"default","text":"<one sentence>"}
      then STOP. Do not retry in another browser. Do not continue.
    resume: |
      when control is returned, re-read the screen before acting
```

The `qa` card is identical with `"computer":"qa"` and the `:2` proxy port.

## What the new code guarantees on its side

`pages/public/computer/state.js::raiseNeedsYou` is **per computer** (the old
global key let a `:2` request clobber a `:1` banner — BUGS.md B-2), and
`router.js` gates it behind `X-Computer-Token`. The UI shows the card with the
agent's text and a hash-keyed preview, and `resolveNeedsYou` records which
action the human chose ("done" / "skip") so the continuation can be
distinguished.

The Worker cannot message the agent directly — the honest limit stated in the
UI is that answering tells the *human* what to type in chat. A future
continuation channel is the loopback relay described in `IMPROVEMENTS.md` §3.1.
