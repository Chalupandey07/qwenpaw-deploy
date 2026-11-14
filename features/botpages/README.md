# Bot-built shareable Pages (#7)

QwenPaw can build a web page from a chat request and publish it as a
shareable public URL. This folder holds the skill, the deploy script, and
a sample page. Live project: **qwenpaw-pages**
(`https://qwenpaw-pages.pages.dev/`).

## Files

| File | Purpose |
| --- | --- |
| `build-page-SKILL.md` | Source copy of the `build-page` skill installed on the machine (see "Installed" below). |
| `deploy-page.py` | Deploys a directory of static pages to a Cloudflare Pages project via the direct-upload API. |
| `sample-page.html` | Sample page deployed to the project root on 2026-11-15 (verified HTTP 200). |
| `404.html` | Custom 404 page. Cloudflare Pages serves it with a real HTTP 404 for unknown URLs. Without it, every unknown URL returned the homepage with HTTP 200 (found by live test 2026-11-15) — which also made the skill's "verify 200" check meaningless. Deployed 2026-11-15; unknown paths now return 404. Keep this file in every future snapshot of the project (the `build-page` skill now says so). |

## Installed (on the machine)

- `working/skill_pool/build-page/SKILL.md` — shared skill pool
- `working/workspaces/default/skills/build-page/SKILL.md` — default workspace

Both copies are identical. Registered with QwenPaw's own reconcile
(`qwenpaw skills list --pool` / `qwenpaw skills list` inside the
container); the pool manifest lists it with `source: "customized"`.

## How it works

1. The user asks for a page ("make a page for the launch party").
2. The agent writes one self-contained HTML file to
   `<workspace>/pages/<slug>/index.html` (English only, inline CSS/JS,
   no external resources, no trackers, no China endpoints).
3. The agent fetches the deploy script from this public repo:
   `https://raw.githubusercontent.com/Ratulbaba7/qwenpaw-deploy/main/features/botpages/deploy-page.py`
4. The agent runs it over the whole pages directory:
   `python3 deploy-page.py <workspace>/pages --project=qwenpaw-pages --branch=main`
5. The agent verifies the URL returns HTTP 200 and gives the user the link:
   `https://qwenpaw-pages.pages.dev/<slug>/`

## Deploy script

`deploy-page.py <source-dir> [--project=qwenpaw-pages] [--branch=main]`

- Uses the Wrangler direct-upload protocol, the same flow as the proven
  `scripts/deploy-pages-proxy.py`: upload-token JWT, blake3 file hashes,
  check-missing, upload missing files, upsert-hashes, create deployment.
- Accepts only `.html/.css/.js/.json/.txt/.svg/.png/.jpg/.webp/.ico`
  files, max 20 MB per file. Special files (`_worker.js`, `_headers`,
  `_redirects`, `_routes.json`) are skipped.
- **Every deployment is a full snapshot of the project.** Always deploy
  the complete pages directory; deploying one file alone would delete
  every other page.
- Auth: `CLOUDFLARE_API_TOKEN` env var first (a token with the
  "Cloudflare Pages: Edit" scope); if unset, falls back to the Muse
  Cloudflare connector credential surrogate when run from this VM.
  Never put a real token in the file or in git. The script never prints
  a token or JWT.
- Account id defaults to `ca85fe3692c3f378200950999df9a35e`
  (`CLOUDFLARE_ACCOUNT_ID` overrides it).

## One-time setup (user)

1. Create the project once (done 2026-11-15):
   `python3 cf.py post /client/v4/accounts/<id>/pages/projects '{"name":"qwenpaw-pages","production_branch":"main"}'`
2. Create a Cloudflare API token with "Cloudflare Pages: Edit" and store
   it in QwenPaw's encrypted env store (run inside the container):
   `qwenpaw env set CLOUDFLARE_API_TOKEN <token>`
   Until this is set, the skill can write pages but cannot publish them.

## Verified live (2026-11-15)

- Project `qwenpaw-pages` created; subdomain `qwenpaw-pages.pages.dev`.
- `deploy-page.py` run end-to-end from this repo against the live API:
  deployed the sample page (`/`) and the skill-library page (`/skills/`)
  in one deployment.
- `https://qwenpaw-pages.pages.dev/` → HTTP 200, sample page.
- `https://qwenpaw-pages.pages.dev/skills/` → HTTP 200, skill library.
- Container `qwenpaw` still healthy afterwards; CJK grep over working
  text files still 0.

## Verified live (2026-11-15, subagent re-test + 404 fix)

- `deploy-page.py` re-run end-to-end from a scratch dir: deployed the
  sample page (`/`), the skill-library page (`/skills/`) and a new
  test page (`/test-verify/`); the test page returned 200 with the
  right content, then was removed and the project re-deployed without
  it. Root and skills pages stayed byte-identical (md5-verified).
- Pre-existing quirk found: unknown paths returned HTTP 200 with the
  homepage (verified on the original pre-test deployment too — not
  caused by the test). Fixed by adding `404.html` (this folder) to the
  snapshot: unknown paths now return a real 404. The `build-page` skill
  (repo + both machine copies, md5-verified, scan still 0 findings)
  now requires keeping `404.html` in the pages directory and checking
  a nonsense URL returns 404.
