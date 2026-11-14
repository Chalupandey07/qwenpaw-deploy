#!/usr/bin/env python3
"""Regenerate the QwenPaw cost/usage page (read-only against the machine).

Pulls working/token_usage.json plus provider pricing facts via ib exec
(reads only, never writes to the machine) and rewrites cost-data.json +
cost.html in this directory:

    python3 refresh-cost.py

Schema of token_usage.json (verified live 2026-11-15):
  { "YYYY-MM-DD": { "<agent>\\u001f<provider>\\u001f<model>": {
        "provider_id", "model_name", "prompt_tokens", "completion_tokens",
        "cache_read_tokens", "cache_write_tokens",
        "cache_eligible_input_tokens", "cache_observed_calls",
        "call_count", "agent_id" } } }

Cost math: only models whose provider catalog carries pricing can be
priced. Kilo models report pricing all "0" and billing "free", so their
cost is $0.00. xingchiapi (GPT Astra) models report pricing {} and billing
"unknown", so their cost is shown as UNKNOWN, never guessed. If a rate is
later confirmed, add it to KNOWN_RATES below and re-run.
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

# USD per 1M tokens, only for rates verified from the provider catalog.
# Kilo: pricing fields are all "0", billing "free" -> $0.
# xingchiapi: pricing {} / billing "unknown" -> no rate; do NOT guess.
KNOWN_RATES = {
    ("kilo", "kilo-auto/free"): {"prompt": 0.0, "completion": 0.0},
}


def ib_exec(cmd, timeout=120):
    payload = {"cmd": cmd, "timeoutSeconds": timeout}
    p = Path("/tmp/board-refresh-cmd.json")
    p.write_text(json.dumps(payload))
    out = subprocess.run(
        ["python3", IB, "exec", MACHINE, str(p)],
        capture_output=True, text=True, timeout=timeout + 120,
    )
    res = json.loads(out.stdout)
    if res.get("exitCode") not in (0, None):
        raise RuntimeError(f"machine command failed: {cmd!r}: {res}")
    return res.get("stdout", "")


def fetch_live():
    raw = json.loads(ib_exec(f"cat {WORKING}/token_usage.json"))
    # Provider pricing facts (structure only; api_key values never printed).
    pricing_py = (
        "import json;"
        "k=json.load(open('/data/home/qwenpaw/working.secret/providers/builtin/kilo.json'));"
        "x=json.load(open('/data/home/qwenpaw/working.secret/providers/custom/xingchiapi.json'));"
        "print(json.dumps({"
        "'kilo_auto':{'pricing':k['models'][0].get('pricing'),'billing':k['models'][0].get('billing')},"
        "'astra':[{'id':m['id'],'pricing':m.get('pricing'),'billing':m.get('billing')} for m in x['discovered_models']],"
        "'active_model':json.load(open('/data/home/qwenpaw/working.secret/providers/active_model.json'))"
        "}))"
    )
    pricing = json.loads(ib_exec(f"sudo -n python3 -c \"{pricing_py}\""))

    per_day, per_model, totals = {}, {}, {"prompt": 0, "completion": 0, "calls": 0, "cost_usd": 0.0, "cost_known": True}
    for day, entries in sorted(raw.items()):
        d = {"prompt": 0, "completion": 0, "cache_read": 0, "calls": 0, "cost_usd": 0.0, "cost_known": True, "models": {}}
        for key, r in entries.items():
            agent, provider, model = (key.split("\x1f") + ["", "", ""])[:3]
            p, c, calls = r["prompt_tokens"], r["completion_tokens"], r["call_count"]
            rate = KNOWN_RATES.get((provider, model))
            cost = None if rate is None else (p * rate["prompt"] + c * rate["completion"]) / 1_000_000
            row = {"agent": agent, "provider": provider, "model": model,
                   "prompt": p, "completion": c, "cache_read": r.get("cache_read_tokens", 0),
                   "calls": calls, "cost_usd": cost}
            d["models"][f"{provider}/{model}"] = row
            d["prompt"] += p
            d["completion"] += c
            d["cache_read"] += r.get("cache_read_tokens", 0)
            d["calls"] += calls
            if cost is None:
                d["cost_known"] = False
            else:
                d["cost_usd"] += cost
            m = per_model.setdefault(f"{provider}/{model}", {"prompt": 0, "completion": 0, "cache_read": 0, "calls": 0, "cost_usd": 0.0, "cost_known": True, "days": []})
            m["prompt"] += p
            m["completion"] += c
            m["cache_read"] += r.get("cache_read_tokens", 0)
            m["calls"] += calls
            m["days"].append(day)
            if cost is None:
                m["cost_known"] = False
            else:
                m["cost_usd"] += cost
        per_day[day] = d
        totals["prompt"] += d["prompt"]
        totals["completion"] += d["completion"]
        totals["calls"] += d["calls"]
        if not d["cost_known"]:
            totals["cost_known"] = False
        else:
            totals["cost_usd"] += d["cost_usd"]

    return {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "machine": MACHINE,
        "source": "working/token_usage.json (read-only via ib exec)",
        "active_model": pricing["active_model"],
        "pricing_facts": pricing,
        "per_day": per_day,
        "per_model": per_model,
        "totals": totals,
        "notes": [
            "Cost is shown only where the provider catalog states a price. Kilo models are free ($0.00). xingchiapi (GPT Astra) models report no pricing, so their cost is UNKNOWN — never guessed.",
            "GET /api/token-usage (and /details) on the console returns the same data live, but it is auth-gated: from the public Pages URL it returns 401 without a logged-in session (verified 2026-11-15). This page instead renders the token_usage.json file pulled read-only from the machine.",
            "Thinking level is per-agent, not a global cost control: agent.json thinking_level is currently 'inherit' for both agents. See config-patch.md. Reasoning-effort options offered by the providers are none/minimal/low/medium/high/xhigh with a thinking budget range of 1-81920 tokens; a higher level means more reasoning tokens per call.",
        ],
    }


HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QwenPaw — Model Usage &amp; Cost</title>
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
  <h1>QwenPaw — Model Usage &amp; Cost</h1>
  <p>Snapshot generated __GENERATED_AT__ (UTC) from <code>working/token_usage.json</code>. Not live: re-run <code>python3 refresh-cost.py</code> in <code>features/board/</code> to refresh.</p>
  <p id="age" class="muted"></p>
  <p>Active model right now: <code id="active"></code></p>
</header>
<main>
  <section><h2>Totals</h2><div id="totals"></div></section>
  <section><h2>Per model</h2><div id="permodel"></div></section>
  <section><h2>Per day</h2><div id="perday"></div></section>
  <section><h2>Notes</h2><div id="notes"></div></section>
  <p class="muted">Ticket board: <a href="https://qwenpaw-board.qwenpaw-rohan.workers.dev">qwenpaw-board.qwenpaw-rohan.workers.dev</a> &middot; Console: <a href="https://qwenpawx.pages.dev">qwenpawx.pages.dev</a> &middot; Open work: <a href="open-work.html">open-work.html</a> &middot; Fallback proposal: <a href="config-patch.md">config-patch.md</a></p>
</main>
<script>
const DATA = __DATA_JSON__;
const esc = (s)=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const cost = (v, known)=> known ? "$"+Number(v).toFixed(4) : "UNKNOWN rate";
document.getElementById("active").textContent = DATA.active_model.provider_id + "/" + DATA.active_model.model;
const t = DATA.totals;
document.getElementById("totals").innerHTML =
  "<table><tr><th>Prompt tokens</th><th>Completion tokens</th><th>Total tokens</th><th>Calls</th><th>Cost</th></tr><tr><td>"+t.prompt.toLocaleString()+"</td><td>"+t.completion.toLocaleString()+"</td><td>"+(t.prompt+t.completion).toLocaleString()+"</td><td>"+t.calls+"</td><td>"+cost(t.cost_usd, t.cost_known)+(t.cost_known?"":" — see notes")+"</td></tr></table>";
let pm = "<table><tr><th>Model</th><th>Prompt</th><th>Completion</th><th>Cache read</th><th>Calls</th><th>Days</th><th>Cost</th></tr>";
for (const [k, m] of Object.entries(DATA.per_model))
  pm += "<tr><td><code>"+esc(k)+"</code></td><td>"+m.prompt.toLocaleString()+"</td><td>"+m.completion.toLocaleString()+"</td><td>"+m.cache_read.toLocaleString()+"</td><td>"+m.calls+"</td><td>"+esc(m.days.join(", "))+"</td><td>"+cost(m.cost_usd, m.cost_known)+"</td></tr>";
document.getElementById("permodel").innerHTML = pm + "</table>";
let pd = "<table><tr><th>Day</th><th>Prompt</th><th>Completion</th><th>Cache read</th><th>Calls</th><th>Cost</th><th>Models</th></tr>";
for (const [day, d] of Object.entries(DATA.per_day))
  pd += "<tr><td>"+esc(day)+"</td><td>"+d.prompt.toLocaleString()+"</td><td>"+d.completion.toLocaleString()+"</td><td>"+d.cache_read.toLocaleString()+"</td><td>"+d.calls+"</td><td>"+cost(d.cost_usd, d.cost_known)+"</td><td>"+esc(Object.keys(d.models).join(", "))+"</td></tr>";
document.getElementById("perday").innerHTML = pd + "</table>";
document.getElementById("notes").innerHTML = "<ul>" + DATA.notes.map(n=>"<li>"+esc(n)+"</li>").join("") + "</ul>";
(function(){
  const gen = new Date(DATA.generated_at_utc);
  const mins = Math.max(0, Math.round((Date.now() - gen.getTime())/60000));
  const age = mins < 60 ? mins+" minute(s)" : Math.floor(mins/60)+"h "+(mins%60)+"m";
  document.getElementById("age").textContent = "Snapshot age: "+age+" old. If it is more than a few hours old, re-run python3 refresh-cost.py.";
})();
</script>
</body>
</html>
"""


def main():
    data = fetch_live()
    (HERE / "cost-data.json").write_text(json.dumps(data, indent=2) + "\n")
    html = (
        HTML_TEMPLATE.replace("__DATA_JSON__", json.dumps(data))
        .replace("__GENERATED_AT__", data["generated_at_utc"])
    )
    (HERE / "cost.html").write_text(html)
    print(f"wrote cost-data.json + cost.html ({data['generated_at_utc']})")
    print(f"  totals: {data['totals']}")
    print(f"  active model: {data['active_model']}")


if __name__ == "__main__":
    sys.exit(main())
