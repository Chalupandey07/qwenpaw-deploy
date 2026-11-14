---
name: github
description: "Work with GitHub through the REST API: list repositories, read files and issues, open issues and pull requests, and commit small file changes. Use whenever the user asks about a GitHub repo, an issue or PR, or wants a file read from or written to GitHub. No gh CLI is installed; this skill uses curl and python3 against api.github.com."
version: "1.0"
metadata:
  qwenpaw:
    emoji: "🐙"
    requires:
      bins: ["python3", "curl"]
      env: ["GITHUB_TOKEN"]
---

# GitHub

Work with GitHub through the REST API at `https://api.github.com`.
There is no `gh` CLI in the container, so use `curl` (or `python3`
with `urllib`) for every call.

## Authentication

- The token comes from the `GITHUB_TOKEN` environment variable, injected
  from QwenPaw's encrypted environment store at runtime.
- **Never print, log, paste or guess the token.** If it is missing, stop
  and tell the user to set it (see "Token setup" below). Never ask the
  user to paste a token into chat.
- Every request sends:
  `Authorization: Bearer $GITHUB_TOKEN` and
  `Accept: application/vnd.github+json` and
  `X-GitHub-Api-Version: 2022-11-28`.
- If a call returns 401, the token is missing, expired or revoked: stop
  and tell the user to check it. If it returns 403 with a rate-limit
  message, stop and report the limit instead of retrying.

## Read operations (no confirmation needed)

- List the user's repos:
  `curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "https://api.github.com/user/repos?per_page=100"`
- Read a file: `GET /repos/{owner}/{repo}/contents/{path}` (add
  `?ref={branch}` for a non-default branch). The response `content`
  field is base64; decode it, do not show the raw base64 to the user.
- List issues: `GET /repos/{owner}/{repo}/issues?state=open`
- Read one issue or PR: `GET /repos/{owner}/{repo}/issues/{number}`
- List PRs: `GET /repos/{owner}/{repo}/pulls?state=open`
- Search code or issues: `GET /search/issues?q={query}` or
  `GET /search/code?q={query}` (search is rate-limited; keep queries
  narrow and paginate with `per_page`).

Default repository for this setup is `Ratulbaba7/qwenpaw-deploy`
(branch `main`). If the user names a different repo, use that one.

## Write operations (confirm with the user first)

Confirm the exact change with the user before any write, and report the
resulting URL afterwards. Writes:

- Open an issue: `POST /repos/{owner}/{repo}/issues` with
  `{"title": "...", "body": "..."}`.
- Comment on an issue or PR: `POST /repos/{owner}/{repo}/issues/{number}/comments`
  with `{"body": "..."}`.
- Open a pull request: `POST /repos/{owner}/{repo}/pulls` with
  `{"title": "...", "head": "<branch>", "base": "main", "body": "..."}`.
- Create or update a small file: `PUT /repos/{owner}/{repo}/contents/{path}`
  with `{"message": "...", "content": "<base64>", "branch": "main"}`.
  Updating an existing file also needs its current `sha` from a prior
  GET. Prefer small, single-file commits; for larger changes ask the user
  to make them from their own checkout instead.

Do not delete repos, force-push, or merge PRs unless the user explicitly
asks for that exact action.

## Token setup (for the user, done once)

Create a token at https://github.com/settings/tokens (classic token
with the `repo` scope, or a fine-grained token scoped to the repos the
agent may touch). Store it in QwenPaw's encrypted environment store,
never in a file or in chat:

```bash
qwenpaw env set GITHUB_TOKEN <token>
```

Run inside the QwenPaw container. The value is encrypted at rest in
`working.secret/envs.json` and is only injected into the agent's
environment at runtime. To remove it:
`qwenpaw env delete GITHUB_TOKEN`.

Until the token is set, this skill can explain GitHub concepts but cannot
call the API: say so plainly instead of pretending to have read a repo.
