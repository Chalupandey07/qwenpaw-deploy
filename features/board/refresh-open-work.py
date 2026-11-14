#!/usr/bin/env python3
"""Regenerate the QwenPaw open-work snapshot (read-only against the machine).

Pulls live data from the InstaBox machine via ib exec (reads only, never
writes to the machine) and rewrites open-work-data.json + open-work.html
in this directory. Re-run any time to refresh the snapshot:

    python3 refresh-open-work.py

What it reads (all read-only):
  - working/workspaces/<agent>/jobs.json          (open jobs; both agents)
  - working/workspaces/<agent>/agent.json         (agent name / model fields)
  - working/workspaces/<agent>/chats.json         (chat counts only, no content)
  - working/workspaces/<agent>/history.db         (SQLite, mode=ro: row counts,
                                                   kinds, sessions, date range)
  - recent workspace files (names, sizes, mtimes) for the artifacts section
  - working/workspaces/<agent>/state/last_dispatch.json (last dispatch target)
  - features/board/follow-ups.md                  (manual follow-up checklist)

It never reads chat message content, MEMORY content, auth.json or .env.
"""
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
MACHINE = "m_agq5wqqo2fvypym7rjlpvngc2m"
IB = "/home/hatch/workspace/custom-connectors/custom.instabox/bin/ib.py"
WORKING = "/data/home/qwenpaw/working"
AGENTS = ["default", "QwenPaw_QA_Agent_0.2"]


def ib_exec(cmd, timeout=120):
    """Run one read-only shell command on the machine; return its stdout."""
    payload = {"cmd": cmd, "timeoutSeconds": timeout}
    p = Path("/tmp/board-refresh-cmd.json")
    p.write_text(json.dumps(payload))
    out = subprocess.run(
        ["python3", IB, "exec", MACHINE, str(p)],
        capture_output=True, text=True, timeout=timeout + 120,
    )
    try:
        res = json.loads(out.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"ib exec returned non-JSON: {out.stdout[:300]} {out.stderr[:300]}")
    if res.get("exitCode") not in (0, None):
        raise RuntimeError(f"machine command failed: {cmd!r}: {res}")
    return res.get("stdout", "")


def fetch_live():
    jobs, agents, chats, history, artifacts, dispatch = {}, {}, {}, {}, {}, {}
    for agent in AGENTS:
        ws = f"{WORKING}/workspaces/{agent}"
        try:
            jobs[agent] = json.loads(ib_exec(f"cat {ws}/jobs.json"))
        except Exception as e:
            jobs[agent] = {"error": str(e)}
        try:
            a = json.loads(ib_exec(f"sudo -n cat {ws}/agent.json"))
            agents[agent] = {
                "name": a.get("name"),
                "language": a.get("language"),
                "fallback_models": a.get("fallback_models", []),
                "fallback_policy": a.get("fallback_policy"),
                "thinking_level": a.get("thinking_level"),
                "active_model": a.get("active_model"),
            }
        except Exception as e:
            agents[agent] = {"error": str(e)}
        try:
            c = json.loads(ib_exec(f"cat {ws}/chats.json"))
            chats[agent] = {
                "chat_count": len(c.get("chats", [])) if isinstance(c.get("chats"), list) else len(c.get("chats", {})),
                "group_count": len(c.get("groups", [])) if isinstance(c.get("groups"), list) else len(c.get("groups", {})),
            }
        except Exception as e:
            chats[agent] = {"error": str(e)}
        # history.db metadata only — no message content is ever selected.
        hist_py = (
            "import sqlite3,json;"
            f"con=sqlite3.connect('file:{ws}/history.db?mode=ro',uri=True);"
            "print(json.dumps({"
            "'rows':con.execute('SELECT COUNT(*) FROM conversation_history').fetchone()[0],"
            "'kinds':dict(con.execute('SELECT kind,COUNT(*) FROM conversation_history GROUP BY kind').fetchall()),"
            "'roles':dict(con.execute('SELECT role,COUNT(*) FROM conversation_history GROUP BY role').fetchall()),"
            "'sessions':[{'session_id':s,'rows':n} for s,n in con.execute('SELECT session_id,COUNT(*) FROM conversation_history GROUP BY session_id')],"
            "'range':con.execute('SELECT MIN(created_at),MAX(created_at) FROM conversation_history').fetchone(),"
            "}))"
        )
        try:
            history[agent] = json.loads(ib_exec(f"python3 -c \"{hist_py}\""))
        except Exception as e:
            history[agent] = {"error": str(e)}
        try:
            listing = ib_exec(
                f"find {ws} -maxdepth 3 -type f "
                f"-not -name 'history.db*' -not -name '*.lock' "
                f"-printf '%TY-%Tm-%TdT%TH:%TM %s %p\\n' 2>/dev/null | sort -r | head -40"
            )
            files = []
            for line in listing.strip().splitlines():
                if not line.strip():
                    continue
                mtime, size, path = line.split(" ", 2)
                files.append({"mtime": mtime, "size_bytes": int(size), "path": path.replace(ws + "/", "")})
            artifacts[agent] = files
        except Exception as e:
            artifacts[agent] = {"error": str(e)}
        try:
            dispatch[agent] = json.loads(ib_exec(f"sudo -n cat {ws}/state/last_dispatch.json 2>/dev/null || echo null"))
        except Exception:
            dispatch[agent] = None

    followups = {"shared": [], "default": [], "QwenPaw_QA_Agent_0.2": []}
    fmd = HERE / "follow-ups.md"
    if fmd.exists():
        section = "shared"
        for line in fmd.read_text().splitlines():
            s = line.strip()
            if s.startswith("## "):
                name = s[3:].strip()
                section = name if name in followups else "shared"
                continue
            if s.startswith("- [ ]"):
                followups[section].append({"done": False, "text": s[5:].strip()})
            elif s.startswith("- [x]"):
                followups[section].append({"done": True, "text": s[5:].strip()})

    # Last execution per scheduled job, from jobs_history/<job-id>.json
    # (written by QwenPaw's cron runner; absent when no job ever ran).
    job_history = {}
    hist_py = (
        "import json,glob;"
        "out={};"
        f"base='{WORKING}/workspaces';"
        "for _f in glob.glob(base+'/*/jobs_history/*.json'):"
        "    _parts=_f.split('/');"
        "    _agent=_parts[-3]; _jid=_parts[-1][:-5];"
        "    try:"
        "        _d=json.load(open(_f));"
        "        out.setdefault(_agent,{})[_jid]=_d[0] if _d else None;"
        "    except Exception:"
        "        pass;"
        "print(json.dumps(out))"
    )
    try:
        job_history = json.loads(ib_exec(f"python3 -c \"{hist_py}\""))
    except Exception:
        job_history = {}

    return {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "machine": MACHINE,
        "jobs": jobs,
        "agents": agents,
        "chats": chats,
        "history": history,
        "artifacts": artifacts,
        "last_dispatch": dispatch,
        "follow_ups": followups,
        "job_history": job_history,
        "notes": [
            "jobs.json is QwenPaw's scheduled-jobs (cron) store: each job is a CronJobSpec {id, name, enabled, schedule, task_type text|agent, dispatch}. Both workspaces currently report zero jobs, and no jobs_history exists yet (no job has ever run).",
            "Artifacts are workspace files the agent produced (resource/, media/, digest/). Those directories are currently empty, so the artifact list is the recent workspace file listing instead.",
            "history.db is read metadata-only (counts, kinds, sessions, date range). No message content is copied into this snapshot.",
            "Follow-ups are per agent, like Rakazo's per-bot open-work list: edit follow-ups.md under '## default', '## QwenPaw_QA_Agent_0.2' or '## shared'.",
        ],
    }


HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QwenPaw — Open Work</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}
header{padding:16px 20px;background:#1e293b}
header h1{font-size:20px;margin:0}
header p{margin:4px 0 0;color:#94a3b8;font-size:13px}
main{padding:16px 20px;max-width:1000px}
section{background:#1e293b;border-radius:8px;padding:14px;margin-bottom:14px}
h2{font-size:16px;margin:0 0 8px}
table{border-collapse:collapse;font-size:13px}
td,th{border:1px solid #475569;padding:4px 8px;text-align:left}
code{background:#0f172a;padding:1px 4px;border-radius:4px}
.muted{color:#94a3b8;font-size:13px}
ul{margin:6px 0}
a{color:#38bdf8}
</style>
</head>
<body>
<header>
  <h1>QwenPaw — Open Work</h1>
  <p>Snapshot generated __GENERATED_AT__ (UTC) from live machine data. Not live: re-run <code>python3 refresh-open-work.py</code> in <code>features/board/</code> to refresh. Machine: <code>__MACHINE__</code></p>
  <p id="age" class="muted"></p>
</header>
<main>
  <section><h2>Open jobs (jobs.json)</h2><div id="jobs"></div></section>
  <section><h2>Artifacts — files the agent produced</h2><div id="artifacts"></div></section>
  <section><h2>Follow-ups</h2><div id="followups"></div></section>
  <section><h2>Recent activity (history.db metadata only)</h2><div id="history"></div></section>
  <section><h2>Agents &amp; chats</h2><div id="agents"></div></section>
  <section><h2>Notes</h2><div id="notes"></div></section>
  <p class="muted">Ticket board: <a href="https://qwenpaw-board.qwenpaw-rohan.workers.dev">qwenpaw-board.qwenpaw-rohan.workers.dev</a> &middot; Console: <a href="https://qwenpawx.pages.dev">qwenpawx.pages.dev</a> &middot; Cost page: <a href="cost.html">cost.html</a></p>
</main>
<script>
const DATA = __DATA_JSON__;
const esc = (s)=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function jobsHtml(){
  let h = "";
  for (const [agent, j] of Object.entries(DATA.jobs)){
    const list = j.jobs || [];
    h += "<h3>"+esc(agent)+"</h3>";
    if (j.error) h += "<p>Error reading jobs.json: "+esc(j.error)+"</p>";
    else if (!list.length) h += "<p>No scheduled jobs. (jobs.json: <code>"+esc(JSON.stringify(j))+"</code> — this file is QwenPaw's cron/scheduled-jobs store.)</p>";
    else {
      h += "<table><tr><th>Name</th><th>Enabled</th><th>Type</th><th>Schedule</th><th>Dispatch</th><th>Last run</th></tr>";
      for (const job of list){
        const hist = (DATA.job_history[agent]||{})[job.id];
        const last = hist ? esc(hist.run_at||"")+" — "+esc(hist.status||"")+(hist.error?" — "+esc(hist.error):"")+(hist.trigger?" ("+esc(hist.trigger)+")":"") : "never ran";
        h += "<tr><td>"+esc(job.name||job.id||"")+"</td><td>"+esc(job.enabled)+"</td><td>"+esc(job.task_type||"")+"</td><td><code>"+esc(JSON.stringify(job.schedule||{}))+"</code></td><td><code>"+esc(JSON.stringify(job.dispatch||{}))+"</code></td><td>"+last+"</td></tr>";
      }
      h += "</table>";
    }
  }
  return h;
}
function artifactsHtml(){
  let h = "";
  for (const [agent, files] of Object.entries(DATA.artifacts)){
    h += "<h3>"+esc(agent)+"</h3>";
    if (files.error) h += "<p>Error: "+esc(files.error)+"</p>";
    else if (!files.length) h += "<p>No workspace files found.</p>";
    else {
      h += "<p class='muted'>Recent workspace files (newest first). Agent-produced artifacts would appear under <code>resource/</code>, <code>media/</code> or <code>digest/</code> — those directories are currently empty.</p><table><tr><th>Modified</th><th>Size</th><th>Path</th></tr>"
        + files.map(f=>"<tr><td>"+esc(f.mtime)+"</td><td>"+esc(f.size_bytes)+"</td><td><code>"+esc(f.path)+"</code></td></tr>").join("") + "</table>";
    }
  }
  return h;
}
function followupsHtml(){
  let h = "<p class='muted'>Per-agent open-work checklist from <code>follow-ups.md</code> (like Rakazo's per-bot open-work list), plus anything open in jobs.json / the ticket board.</p>";
  const sections = [["default","Default agent"],["QwenPaw_QA_Agent_0.2","QA agent"],["shared","Shared"]];
  let any = false;
  for (const [key, label] of sections){
    const items = DATA.follow_ups[key] || [];
    if (!items.length) continue;
    any = true;
    const open = items.filter(f=>!f.done), done = items.filter(f=>f.done);
    h += "<h3>"+esc(label)+"</h3><ul>" + open.map(f=>"<li>☐ "+esc(f.text)+"</li>").join("") + "</ul>";
    if (done.length) h += "<p class='muted'>Done:</p><ul>" + done.map(f=>"<li>☑ "+esc(f.text)+"</li>").join("") + "</ul>";
  }
  if (!any) h += "<p>No follow-ups recorded.</p>";
  h += "<p class='muted'>Open (non-Done, non-Won't-do) tickets on the <a href='https://qwenpaw-board.qwenpaw-rohan.workers.dev'>ticket board</a> are also follow-ups — check there.</p>";
  return h;
}
function historyHtml(){
  let h = "";
  for (const [agent, v] of Object.entries(DATA.history)){
    h += "<h3>"+esc(agent)+"</h3>";
    if (v.error) h += "<p>Error: "+esc(v.error)+"</p>";
    else {
      h += "<p>"+esc(v.rows)+" history rows; kinds: <code>"+esc(JSON.stringify(v.kinds))+"</code>; roles: <code>"+esc(JSON.stringify(v.roles))+"</code><br>Range: "+esc(v.range[0])+" → "+esc(v.range[1])+"<br>Sessions:</p><ul>"
        + v.sessions.map(s=>"<li><code>"+esc(s.session_id)+"</code> — "+esc(s.rows)+" rows</li>").join("") + "</ul>";
    }
  }
  return h;
}
function agentsHtml(){
  let h = "<table><tr><th>Agent</th><th>Name</th><th>Chats</th><th>Thinking</th><th>Fallbacks</th><th>Last dispatch</th></tr>";
  for (const [agent, a] of Object.entries(DATA.agents)){
    const c = DATA.chats[agent] || {};
    const d = DATA.last_dispatch[agent];
    h += "<tr><td><code>"+esc(agent)+"</code></td><td>"+esc(a.name||"")+"</td><td>"+esc(c.chat_count??"?")+"</td><td>"+esc(a.thinking_level||"")+"</td><td>"+esc(JSON.stringify(a.fallback_models||[]))+"</td><td><code>"+esc(d?JSON.stringify(d):"—")+"</code></td></tr>";
  }
  return h + "</table>";
}
document.getElementById("jobs").innerHTML = jobsHtml();
document.getElementById("artifacts").innerHTML = artifactsHtml();
document.getElementById("followups").innerHTML = followupsHtml();
document.getElementById("history").innerHTML = historyHtml();
document.getElementById("agents").innerHTML = agentsHtml();
document.getElementById("notes").innerHTML = "<ul>" + DATA.notes.map(n=>"<li>"+esc(n)+"</li>").join("") + "</ul>";
(function(){
  const gen = new Date(DATA.generated_at_utc);
  const mins = Math.max(0, Math.round((Date.now() - gen.getTime())/60000));
  const age = mins < 60 ? mins+" minute(s)" : Math.floor(mins/60)+"h "+(mins%60)+"m";
  document.getElementById("age").textContent = "Snapshot age: "+age+" old. If it is more than a few hours old, re-run python3 refresh-open-work.py.";
})();
</script>
</body>
</html>
"""


def main():
    data = fetch_live()
    (HERE / "open-work-data.json").write_text(json.dumps(data, indent=2) + "\n")
    html = (
        HTML_TEMPLATE.replace("__DATA_JSON__", json.dumps(data))
        .replace("__GENERATED_AT__", data["generated_at_utc"])
        .replace("__MACHINE__", MACHINE)
    )
    (HERE / "open-work.html").write_text(html)
    print(f"wrote open-work-data.json + open-work.html ({data['generated_at_utc']})")
    for agent, j in data["jobs"].items():
        print(f"  jobs {agent}: {j}")
    for agent, v in data["history"].items():
        print(f"  history {agent}: {v.get('rows', v)} rows")


if __name__ == "__main__":
    sys.exit(main())
