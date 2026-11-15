#!/usr/bin/env python3
"""desktop-lease-watcher: mirror the Cloudflare Worker control lease into
the InstaBox desktop control file the computer-use MCP proxy honors, and
do the machine-side jobs the Worker cannot do itself.

Polls GET https://qwenpawx.pages.dev/desktop/__lease?computer=<name> every
10 s, for BOTH computers ("default" = shared :1, "qa" = private :2).
10 s (was 5 s): the control file is treated as stale after 30 s, so
10 s still renews with 3x margin, and it halves the Worker-request
cost of polling (17,280/day instead of 34,560 — the 100k/day Workers
free limit is shared with every console request through the Pages
proxy). See features/storage/QUOTA-BUDGET.md.
- lease holder == "user" (unexpired): write "human worker-lease <epoch>"
  to that computer's control file (/run/user/1000/instabox-control for :1,
  /run/user/1000/qa/instabox-control for :2 — the QA proxy runs with
  XDG_RUNTIME_DIR=/run/user/1000/qa, so a :1 takeover never blocks the QA
  agent and vice versa). Renewed each poll; the proxy treats entries
  older than 30 s as stale, so a dead watcher auto-clears.
- no lease: remove the file ONLY if its owner word is "worker-lease".
  A dashboard takeover writes a different owner word, so this can never
  clear a dashboard hold; no desktop-controller check is needed (the
  owner word is the guard — the desktop status call flaked and added
  nothing here).
- Worker unreachable: leave state unchanged (fail-open for the agent).
- KV is eventually consistent: after a release, a stale read can keep
  refreshing the file for up to ~60 s; the 30 s staleness bound caps the
  agent's wait.

Every 15 s: capture each desktop (scrot :1 and :2) and POST the PNGs to
the Worker /desktop/__preview-upload?computer=<name> (the needs-you
banner and the chat preview read them from there) — but ONLY when the
screenshot actually changed since the last upload, and at most once per
120 s per computer. The old policy uploaded unconditionally every 15 s
(2 KV writes per 15 s = ~11,500/day), which spent Cloudflare's free
1,000 KV writes/day budget by mid-morning and broke EVERY write path
at once (__takeover, __mode and the needs-you raise all answered 500
on 2026-11-15 while reads kept working). The Worker stores previews
with a 600 s TTL, so a changed screen is refreshed within 2 minutes and
a static one costs nothing. The screenshots go to /data/home, never
/tmp — the machine's /tmp is a 512 MB tmpfs that fills up.

Every 30 s: fetch pending taught skills from the Worker
(/desktop/__pending-skills) and deliver each to the QwenPaw skill pool
(SKILL.md via sudo, then `qwenpaw skills enable`), then ack it so the
Worker deletes the KV key. Skills are NEVER hand-edited into skill.json
— QwenPaw reconciles that file itself.

Machine-side auth: the DESKTOP_SYNC_TOKEN (Worker secret on both Pages
projects) is read from /data/home/mcp-proxy/.env (chmod 600). All
Worker calls from here send a Mozilla User-Agent — Python urllib's
default UA is 403'd by Cloudflare on the Pages domain.
Diagnostics to stderr (journalctl -u desktop-lease-watcher).
"""
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request

LEASE_URL = "https://qwenpawx.pages.dev/desktop/__lease"
WORKER = "https://qwenpawx.pages.dev"
# Per-computer control files (the file each computer-use MCP proxy
# honors). :1 uses the shared runtime dir; :2 uses its own (the QA proxy
# runs with XDG_RUNTIME_DIR=/run/user/1000/qa) so a :1 takeover never
# blocks the QA agent and vice versa.
CONTROL_FILES = {
    "default": "/run/user/1000/instabox-control",
    "qa": "/run/user/1000/qa/instabox-control",
}
POLL_S = 10
# Adaptive cadence (IMPROVEMENTS.md §9.2). A fixed 10 s poll for two computers
# is 17,280 Worker requests/day whether or not anyone is using the box — and
# the fast poll only matters while a human holds control. Poll at POLL_S while
# a lease is held, and at POLL_S_IDLE otherwise. 30 s idle stays under the
# control file's own 30 s staleness bound, so a takeover is never missed by
# more than the agent already tolerates.
POLL_S_IDLE = 30
# Kept as its own literal so the cadence is greppable and the test can read it.
POLL_S_ACTIVE = 10
# How often to look at the screens. Was written as `POLL_S * 3`, which becomes
# wrong the moment the loop cadence is adaptive (an idle 30 s loop would then
# check previews every tick). It is its own constant, and it must stay below
# PREVIEW_MIN_S.
PREVIEW_CHECK_S = 15
# Preview uploads: change-only, at most once per 120 s per computer.
# (Unconditional 15 s uploads burned the free KV write budget — see the
# module docstring. The Worker's preview TTL is 600 s, so a static
# desktop costs zero writes and a changed one refreshes within 2 min.)
PREVIEW_MIN_S = 120
SKILLS_S = 30
PREVIEW_PNG = "/data/home/mcp-proxy/preview.png"
PREVIEW_PNG_QA = "/data/home/mcp-proxy/preview-qa.png"
SKILL_POOL = "/data/home/qwenpaw/working/skill_pool"
# The agent reads its own workspace skills/ dir (an identical copy of the
# pool entry — see features/desktop/README.md / the delegate skill, which
# exists in both). Installing only to the pool leaves the skill invisible
# to `qwenpaw skills enable` ("not found"). Never hand-edit skill.json —
# QwenPaw reconciles it.
WS_SKILLS = "/data/home/qwenpaw/working/workspaces/default/skills"


def log(msg):
    sys.stderr.write("lease-watcher: %s\n" % msg)
    sys.stderr.flush()


UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

SYNC_TOKEN = ""
try:
    for line in open("/data/home/mcp-proxy/.env"):
        line = line.strip()
        if line.startswith("DESKTOP_SYNC_TOKEN="):
            SYNC_TOKEN = line.split("=", 1)[1].strip().strip('"').strip("'")
            break
except OSError:
    pass


def get_lease(computer):
    try:
        req = urllib.request.Request(
            LEASE_URL + "?computer=" + computer, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        log("lease fetch failed (%s): %s" % (computer, e))
        return None


def read_control(path):
    try:
        with open(path, "r") as f:
            return f.read().strip().split()
    except OSError:
        return []


def mirror_lease(computer):
    """Mirror one computer's lease into its control file.

    Returns True while an unexpired human lease is being mirrored. The poll
    loop uses that to stay at the fast cadence only while control is actually
    held (see POLL_S_IDLE / POLL_S_ACTIVE).
    """
    control_file = CONTROL_FILES[computer]
    lease = get_lease(computer)
    if lease and lease.get("holder") == "user":
        exp = lease.get("expiresAt", 0)
        if exp > int(time.time() * 1000):  # expiresAt is epoch ms
            with open(control_file, "w") as f:
                f.write("human worker-lease %d\n" % int(time.time()))
            return True
        log("lease expired at %s (%s)" % (exp, computer))
    elif lease is not None:
        # Only ever remove OUR OWN entry (owner word worker-lease).
        words = read_control(control_file)
        if len(words) >= 2 and words[0] == "human" and words[1] == "worker-lease":
            try:
                os.unlink(control_file)
                log("lease ended, control file cleared (%s)" % computer)
            except OSError:
                pass
    return False


def worker_call(method, path, data=None, content_type="application/json"):
    """Call the Pages Worker with the sync token. Returns (status, body)."""
    headers = {"User-Agent": UA}
    if SYNC_TOKEN:
        headers["X-Desktop-Sync"] = SYNC_TOKEN
    body = None
    if data is not None:
        if isinstance(data, (dict, list)):
            body = json.dumps(data).encode()
            headers["Content-Type"] = content_type
        else:
            body = data
            headers["Content-Type"] = content_type
    req = urllib.request.Request(WORKER + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        log("worker call %s failed: %s" % (path, e))
        return None, None


# Last successful preview upload, per computer: (epoch seconds, sha256).
# A re-upload happens only when the screenshot changed AND the minimum
# interval has passed — an unchanged desktop costs zero KV writes.
last_preview = {}


def upload_preview(computer):
    """scrot the computer's display -> POST the PNG to the Worker (600 s TTL in KV).

    Change-only with a 120 s floor: an unchanged desktop is never
    re-uploaded. Returns True when an upload was attempted.
    """
    display = ":2" if computer == "qa" else ":1"
    png_path = PREVIEW_PNG_QA if computer == "qa" else PREVIEW_PNG
    try:
        subprocess.run(
            ["scrot", "-o", png_path],
            env=dict(os.environ, DISPLAY=display),
            capture_output=True, timeout=15, check=True)
    except Exception as e:
        log("scrot failed (%s): %s" % (computer, e))
        return False
    try:
        with open(png_path, "rb") as f:
            png = f.read()
    except OSError as e:
        log("preview read failed (%s): %s" % (computer, e))
        return False
    if not png:
        return False
    digest = hashlib.sha256(png).hexdigest()
    now = time.time()
    prev_at, prev_hash = last_preview.get(computer, (0, ""))
    if digest == prev_hash:
        return False  # unchanged — no KV write spent
    if now - prev_at < PREVIEW_MIN_S:
        return False  # changed again too soon — the last upload is fresh
    status, _ = worker_call("POST", "/desktop/__preview-upload?computer=" + computer, png, "image/png")
    if status != 200:
        log("preview upload failed (%s): HTTP %s" % (computer, status))
        return False
    last_preview[computer] = (now, digest)
    return True


def slugify(name):
    out = []
    for ch in (name or "").lower():
        out.append(ch if ch.isalnum() else "-")
    slug = "".join(out).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug[:40] or "skill"


def skill_markdown(skill, slug):
    # The frontmatter `name` MUST equal the skill-pool directory name:
    # `qwenpaw skills enable <name>` looks the skill up by that name, and
    # a mismatch makes it report "(not found)".
    pb = skill.get("playbook") or {}
    name = skill.get("name") or "Taught skill"
    lines = [
        "---",
        "name: %s" % slug,
        'description: "%s"' % (pb.get("whenToUse") or skill.get("goal") or name).replace('"', "'")[:200],
        "---",
        "",
        "# %s" % name,
        "",
        "Taught skill — recorded by the user demonstrating the workflow on the desktop (Teach a task, /desktop).",
        "",
        "Goal: %s" % (skill.get("goal") or ""),
        "",
        "## When to use",
        str(pb.get("whenToUse") or ""),
        "",
        "## Inputs",
    ]
    for inp in pb.get("inputs") or []:
        lines.append("- %s" % inp)
    lines += ["", "## Steps"]
    for i, step in enumerate(pb.get("steps") or [], 1):
        lines.append("%d. %s" % (i, step))
    lines += [
        "",
        "## How to check",
        str(pb.get("howToCheck") or ""),
        "",
        "## What to return",
        str(pb.get("whatToReturn") or ""),
        "",
        "## Approval boundaries",
        str(pb.get("approvalBoundaries") or ""),
        "",
        "## Failure handling",
        str(pb.get("failureHandling") or ""),
        "",
    ]
    return "\n".join(lines)


def deliver_skills():
    """Fetch pending taught skills and install each into the skill pool."""
    status, body = worker_call("GET", "/desktop/__pending-skills")
    if status != 200 or not body:
        if status not in (None, 200):
            log("pending-skills fetch failed: HTTP %s" % status)
        return
    try:
        skills = json.loads(body.decode()).get("skills") or []
    except Exception:
        return
    for skill in skills:
        skill_id = skill.get("id") or ""
        name = skill.get("name") or "Taught skill"
        slug = "taught-" + slugify(name)
        md = skill_markdown(skill, slug)
        tmp = "/data/home/mcp-proxy/skill-%s.md" % slug
        try:
            with open(tmp, "w") as f:
                f.write(md)
            for base in (SKILL_POOL, WS_SKILLS):
                subprocess.run(["sudo", "install", "-d", os.path.join(base, slug)],
                               capture_output=True, timeout=15, check=True)
                subprocess.run(["sudo", "install", "-m", "644", tmp,
                                os.path.join(base, slug, "SKILL.md")],
                               capture_output=True, timeout=15, check=True)
        except Exception as e:
            log("skill %s install failed: %s" % (slug, e))
            continue
        # Enable it (best-effort; QwenPaw also reconciles new pool dirs).
        try:
            r = subprocess.run(["docker", "exec", "qwenpaw", "qwenpaw",
                                "skills", "enable", slug],
                               capture_output=True, text=True, timeout=30)
            if r.returncode != 0:
                log("skill %s enable returned %s: %s" % (slug, r.returncode, (r.stderr or r.stdout or "")[:200]))
        except Exception as e:
            log("skill %s enable failed: %s" % (slug, e))
        status, _ = worker_call("POST", "/desktop/__pending-skills/ack", {"id": skill_id})
        if status == 200:
            log("skill %s delivered (id %s)" % (slug, skill_id))
        else:
            log("skill %s ack failed: HTTP %s" % (slug, status))
        try:
            os.unlink(tmp)
        except OSError:
            pass


def main():
    log("started, polling %s (default + qa)" % LEASE_URL)
    last_preview_check = 0
    last_skills = 0
    lease_held = False
    while True:
        try:
            for computer in ("default", "qa"):
                if mirror_lease(computer):
                    lease_held = True
        except Exception as e:
            log("poll error: %s" % e)
        now = time.time()
        if now - last_preview_check >= PREVIEW_CHECK_S:
            last_preview_check = now
            upload_preview("default")
            upload_preview("qa")
        if now - last_skills >= SKILLS_S:
            last_skills = now
            deliver_skills()
        # Recompute every tick so a takeover shortens the interval immediately.
        # Worst case one slow tick (<= 30 s), which is inside the lease TTL and
        # inside the agent's own 30 s staleness bound.
        interval = POLL_S_ACTIVE if lease_held else POLL_S_IDLE
        lease_held = False
        time.sleep(interval)


if __name__ == "__main__":
    main()
