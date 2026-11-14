---
name: build-page
description: "Build a self-contained shareable HTML page from the user's request and publish it to Cloudflare Pages (project qwenpaw-pages) with features/botpages/deploy-page.py. Use whenever the user asks for a shareable web page, a link they can send to someone, a landing page, or a small static site."
version: "1.0"
metadata:
  qwenpaw:
    emoji: "🌐"
    requires:
      bins: ["python3", "curl"]
      env: ["CLOUDFLARE_API_TOKEN"]
---

# Build Page

Build a single self-contained HTML page and publish it to Cloudflare
Pages, then give the user the public URL.

## Rules

- **English only.** All page text, labels and comments in English.
- **Self-contained.** One HTML file per page: inline CSS in `<style>`,
  inline JavaScript in `<script>` if needed. No external fonts, scripts,
  images or trackers. No server, no database, no form that posts anywhere.
- **No China endpoints or services.** No links, embeds or assets from
  Chinese domains or providers.
- **Never print, log or paste the Cloudflare API token.** It arrives as
  the `CLOUDFLARE_API_TOKEN` environment variable. If it is missing, stop
  and tell the user to set it (see "Token setup" below) instead of
  guessing or asking for the token in chat.
- **Every deployment is a full snapshot.** Deploying replaces the whole
  `qwenpaw-pages` project, so always deploy the complete pages directory,
  never a single file on its own.
- **Keep a 404 page.** `<workspace>/pages/404.html` must always exist
  (copy it from `features/botpages/404.html` in the repo if it is
  missing). Cloudflare Pages serves it with a real 404 for unknown URLs;
  without it, any typo'd URL returns the homepage with HTTP 200. Never
  delete it when deploying.

## Workflow

### 1. Agree the page with the user

Confirm the slug (URL path), title and the content. A slug is lowercase
letters, digits and hyphens only, e.g. `launch-party`. The page will be
live at `https://qwenpaw-pages.pages.dev/<slug>/`.

### 2. Write the page

Write the page to `<workspace>/pages/<slug>/index.html`, where
`<workspace>` is the current agent's workspace directory. Keep all bot
pages in that one `pages/` directory so step 4 always deploys everything
together. The workspace homepage is `<workspace>/pages/index.html`.

Page requirements:

- Valid HTML, `<html lang="en">`, `<meta charset="utf-8">`, a viewport
  meta tag, a `<title>`, and a visible heading.
- Readable on a phone: responsive layout, no fixed pixel widths wider
  than the screen.
- Keep the file under 1 MB.

### 3. Get the deploy script

The deploy script lives in the public repo and needs no token to fetch:

```bash
mkdir -p <workspace>/pages-deploy
curl -fsSL -o <workspace>/pages-deploy/deploy-page.py \
  https://raw.githubusercontent.com/Ratulbaba7/qwenpaw-deploy/main/features/botpages/deploy-page.py
```

Re-fetch it if it is older than the repo's current version. Do not edit
the script; if it fails, report the exact error to the user.

### 4. Deploy the whole pages directory

```bash
python3 <workspace>/pages-deploy/deploy-page.py <workspace>/pages \
  --project=qwenpaw-pages --branch=main
```

The script prints the deployment id and URL. Wait for it to finish and
check that it reports success. If it fails, do not retry blindly: read
the error, fix the cause (usually a bad file type or an oversized file),
and deploy again.

### 5. Verify and report

Fetch the live URL and confirm it returns HTTP 200 and contains the
page title. Also fetch a nonsense URL (e.g. `/does-not-exist-xyz/`) and
confirm it returns 404: if it returns 200, `404.html` is missing from
the pages directory — add it (see Rules) and redeploy. Then reply to
the user with:

- the public URL (`https://qwenpaw-pages.pages.dev/<slug>/`)
- one line saying what the page is
- the workspace path of the source file, so they can ask for edits

For an edit, change the file in `<workspace>/pages/<slug>/index.html`
and repeat steps 4-5.

## Token setup (for the user, done once)

The deploy step needs a Cloudflare API token with the
"Cloudflare Pages: Edit" scope for account
`ca85fe3692c3f378200950999df9a35e`. The user stores it once in QwenPaw's
encrypted environment store (never in a file or in chat):

```bash
qwenpaw env set CLOUDFLARE_API_TOKEN <token>
```

Run inside the QwenPaw container. The value is encrypted at rest in
`working.secret/envs.json` and is only injected into the agent's
environment at runtime. To remove it: `qwenpaw env delete CLOUDFLARE_API_TOKEN`.

Until the token is set, this skill can still write pages, but it cannot
publish them: write the file, tell the user it is ready in the workspace,
and ask them to set the token or deploy it from the repo with
`features/botpages/deploy-page.py`.
