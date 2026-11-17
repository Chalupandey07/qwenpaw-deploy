# /reset — Settings Reset (Pages route)

A Settings page where the user picks categories to wipe, previews exactly
what will be deleted, and confirms with a typed DELETE plus a checkbox.
The design is in `features/reset/README.md`; this file is the route
contract for the Pages side.

## Files

| File | Role |
|---|---|
| `pages/public/reset/router.js` | `handleReset(request, env, url, origin)`. Session-gates the API, forwards to the broker. |
| `pages/public/reset/index.html` | The /reset page (static bytes, exempt from the session gate). |
| `pages/public/reset/ui.js` | The page logic: categories, preview, typed-DELETE + checkbox gate, execute, report. |
| `pages/public/_worker.js` | Wires `/reset*` to `handleReset` (import + route, next to the vault block). |

## Auth

This is a destructive surface, so it uses the strongest check the console
offers: `authenticate()` from `machine-control.js`, which forwards the
caller's Bearer token to the console's own `/api/cron/jobs` and trusts
only a 200 with a JSON body. A revoked token stops working here at the
same moment it stops working in the console. Never `/api/auth/status`
(public). The UI reads the console token from localStorage (same lookup
the console's own injected scripts use) and sends it as
`Authorization: Bearer`.

The broker call adds the shared `RESET_TOKEN` (`X-Reset-Token`). Without
it the route fails closed with 503. The broker is reached at
`env.RESET_BROKER_URL` (default `http://172.18.0.1:8895`).

## Endpoints

| Route | Method | Auth | Behaviour |
|---|---|---|---|
| `/reset` | GET | none (static page) | Serves `index.html`. |
| `/reset/ui.js` | GET | none (static asset) | Serves the page script. |
| `/reset/api/preview` | POST | console Bearer | Forwards `{categories}` to the broker `/preview`. Returns per-category `{paths, bytes, files}` + totals + `plan_id`. |
| `/reset/api/execute` | POST | console Bearer | Forwards `{categories, confirm, ack, plan_id}` + `X-Request-Id` to the broker `/execute`. Returns the report (200 ok / 207 partial). |

The router passes the broker's status and body through unchanged. It never
touches the filesystem and never accepts client-supplied paths (there are
none — the broker only takes a category enum).

## UI flow

1. Pick categories (9 checkboxes). Ticking Memories force-ticks Lessons
   (Lessons is a subset of Memories).
2. Preview — shows per-category sizes, file counts and the first 12 paths,
   plus the total. The `plan_id` is held for the execute.
3. Confirm — type exactly `DELETE` and tick "I understand this cannot be
   undone". The Delete button stays disabled until both.
4. Execute — posts the plan_id. A 409 `plan_changed` means the files
   changed since the preview; preview again. The report lists per-category
   status, bytes freed, files deleted, errors and skips.

If no console token is found, the page tells the user to sign in to the
console first.

## Deploy notes

- `_worker.js` is bundled with esbuild before deploy (the deploy script
  does this automatically and refuses an unbundled `_worker.js`).
- `RESET_TOKEN` and `RESET_BROKER_URL` are Pages secrets; changing them
  requires a redeploy to take effect.
- The broker is a separate service on the machine
  (`qwenpaw-reset-broker`, port 8895). The route returns 502
  `reset_broker_unreachable` when it does not answer.
