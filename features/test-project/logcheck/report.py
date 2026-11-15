#!/usr/bin/env python3
"""QwenPaw LOG-CHECK report generator.

Turns a collect.py snapshot JSON into a single self-contained HTML file
(index.html) that can be opened directly in a browser — no server, no
external assets, no JavaScript fetching. Everything is inlined.

Usage:
    python3 report.py [snapshot.json] [--out index.html]
Defaults: latest.json in this directory -> index.html in this directory.
"""

import argparse
import html
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

CSS = """
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0; background: #0f1115; color: #e8eaf0; line-height: 1.5; }
main { max-width: 980px; margin: 0 auto; padding: 2rem 1rem 4rem; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; border-bottom: 1px solid #2a2e3a;
  padding-bottom: .3rem; }
h3 { font-size: 1rem; margin: 1.2rem 0 .3rem; }
p.sub { color: #9aa3b2; margin: 0 0 1rem; }
.cards { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1rem 0; }
.card { flex: 1 1 140px; background: #171a21; border: 1px solid #2a2e3a;
  border-radius: 10px; padding: .8rem 1rem; }
.card b { display: block; font-size: 1.7rem; line-height: 1.1; }
.card span { color: #9aa3b2; font-size: .85rem; }
.card.bad b { color: #ff6b6b; }
.card.warn b { color: #f5b544; }
.card.good b { color: #4ecb71; }
.badge { display: inline-block; font-size: .75rem; font-weight: 700;
  padding: .1rem .45rem; border-radius: 999px; vertical-align: middle; }
.badge.new { background: #ff6b6b; color: #fff; }
.badge.err { background: #5a1f1f; color: #ff9a9a; }
.badge.warn { background: #4d3a10; color: #f5b544; }
.badge.ok { background: #12351f; color: #4ecb71; }
.badge.missing { background: #3a2a12; color: #f5b544; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #232733; }
th { color: #9aa3b2; font-weight: 600; }
td.num, th.num { text-align: right; }
.issue { background: #171a21; border: 1px solid #2a2e3a; border-radius: 10px;
  padding: .8rem 1rem; margin: .6rem 0; }
.issue.is-new { border-color: #ff6b6b; box-shadow: 0 0 0 1px #ff6b6b inset; }
.issue .key { font-weight: 600; word-break: break-word; }
.issue .meta { color: #9aa3b2; font-size: .85rem; margin: .2rem 0 .4rem; }
pre { background: #0b0d12; border: 1px solid #232733; border-radius: 8px;
  padding: .6rem .8rem; overflow-x: auto; font-size: .8rem; white-space: pre-wrap;
  word-break: break-word; margin: .4rem 0 0; }
.src-head { display: flex; gap: .5rem; align-items: baseline; flex-wrap: wrap; }
.src-head code { color: #9aa3b2; font-size: .85rem; }
.muted { color: #9aa3b2; font-size: .9rem; }
footer { margin-top: 3rem; color: #9aa3b2; font-size: .85rem;
  border-top: 1px solid #2a2e3a; padding-top: 1rem; }
"""

ESC = html.escape


def issue_block(iss, source_label):
    new = iss.get("new")
    cls = "issue is-new" if new else "issue"
    sev = iss["severity"]
    sev_badge = ('<span class="badge err">ERROR</span>' if sev == "error"
                 else '<span class="badge warn">WARNING</span>')
    new_badge = ' <span class="badge new">NEW</span>' if new else ""
    samples = "".join("<pre>%s</pre>" % ESC(s) for s in iss.get("samples", []))
    first = iss.get("first_seen") or "?"
    last = iss.get("last_seen") or "?"
    return (
        '<div class="%s">%s%s'
        '<div class="key">%s</div>'
        '<div class="meta">seen %d× &middot; first %s &middot; last %s '
        '&middot; source: %s</div>%s</div>'
        % (cls, sev_badge, new_badge, ESC(iss["key"]), iss["count"],
           ESC(str(first)), ESC(str(last)), ESC(source_label), samples))


def render(snapshot):
    s = snapshot["summary"]
    gen = snapshot.get("generated_at_utc", "?")
    new_issues = []
    for src in snapshot["sources"]:
        for iss in src.get("issues", []):
            if iss.get("new"):
                new_issues.append((src, iss))
    new_distinct = len({iss["key"] for _, iss in new_issues})

    parts = []
    parts.append("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
                 "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
                 "<title>QwenPaw log-check — %s</title><style>%s</style></head>"
                 "<body><main>" % (ESC(gen[:10]), CSS))
    parts.append("<h1>QwenPaw log-check</h1>")
    parts.append("<p class=\"sub\">Collected %s (UTC) &middot; machine %s "
                 "&middot; last %d lines per log source &middot; machine pull: %s</p>"
                 % (ESC(gen), ESC(snapshot.get("machine_id", "?")),
                    snapshot.get("lines_per_source", 0),
                    "ok" if snapshot.get("machine_pull_ok") else "FAILED"))

    err_cls = "bad" if s["total_errors"] else "good"
    warn_cls = "warn" if s["total_warnings"] else "good"
    new_cls = "bad" if s["new_issues"] else "good"
    parts.append('<div class="cards">'
                 '<div class="card %s"><b>%d</b><span>errors (grouped occurrences)</span></div>'
                 '<div class="card %s"><b>%d</b><span>warnings (grouped occurrences)</span></div>'
                 '<div class="card %s"><b>%d</b><span>NEW issues since last check</span></div>'
                 '<div class="card"><b>%d / %d</b><span>sources ok</span></div>'
                 '</div>' % (err_cls, s["total_errors"], warn_cls,
                              s["total_warnings"], new_cls, s["new_issues"],
                              s["sources_ok"], s["sources_total"]))
    if s.get("sources_missing_or_error"):
        parts.append("<p><span class=\"badge missing\">ATTENTION</span> "
                     "missing / error sources: %s</p>"
                     % ESC(", ".join(s["sources_missing_or_error"])))
    if s.get("lines_scrubbed"):
        parts.append("<p class=\"muted\">%d line(s) contained secret-looking "
                     "values and were redacted/dropped before the snapshot "
                     "was written.</p>" % s["lines_scrubbed"])

    # NEW issues first
    parts.append("<h2>New issues since the last check (%d)</h2>" % new_distinct)
    if not new_issues:
        parts.append("<p class=\"muted\">No new issues. NEW means the "
                     "normalized issue text was never seen in any previous "
                     "log-check run (see seen.json). A fixed issue that "
                     "comes back is flagged NEW again.</p>")
    for src, iss in new_issues:
        parts.append(issue_block(iss, src["label"]))

    # Per-source sections
    parts.append("<h2>Per-source detail</h2>")
    for src in snapshot["sources"]:
        kind = src.get("kind", "")
        status = src.get("status", "?")
        if status == "ok":
            badge = '<span class="badge ok">OK</span>'
        elif status == "missing":
            badge = '<span class="badge missing">MISSING</span>'
        else:
            badge = '<span class="badge err">ERROR</span>'
        parts.append('<div class="src-head"><h3>%s</h3>%s</div>'
                     % (ESC(src["label"]), badge))
        parts.append("<p class=\"muted\"><code>%s</code></p>"
                     % ESC(src.get("path", "")))
        if kind == "remote":
            parts.append("<p>HTTP %s &middot; %s ms%s%s</p>"
                         % (ESC(str(src.get("http_status"))),
                            ESC(str(src.get("elapsed_ms"))),
                            (" &middot; status field: " + ESC(str(src.get("detail"))))
                            if src.get("detail") else "",
                            (" &middot; " + ESC(str(src.get("error"))))
                            if src.get("error") else ""))
            if src.get("note"):
                parts.append("<pre>%s</pre>" % ESC(src["note"]))
            continue
        if status != "ok":
            parts.append("<p>%s</p>" % ESC(src.get("note") or "no data"))
            continue
        parts.append("<p>%d lines scanned &middot; %d errors &middot; %d warnings</p>"
                     % (src.get("lines", 0), src.get("errors", 0),
                        src.get("warnings", 0)))
        issues = src.get("issues", [])
        if not issues:
            parts.append("<p class=\"muted\">No errors or warnings in this window.</p>")
        for iss in issues:
            parts.append(issue_block(iss, src["label"]))

    # Services
    parts.append("<h2>Services on the machine</h2>")
    parts.append("<p class=\"muted\">%s</p>"
                 % ESC(snapshot.get("container", "")))
    if snapshot.get("services"):
        rows = "".join(
            "<tr><td><code>%s</code></td><td>%s</td></tr>"
            % (ESC(sv["unit"]),
               ('<span class="badge ok">active</span>' if sv["state"] == "active"
                else '<span class="badge missing">%s</span>' % ESC(sv["state"])))
            for sv in snapshot["services"])
        parts.append("<table><tr><th>Unit</th><th>State</th></tr>%s</table>" % rows)
    else:
        parts.append("<p class=\"muted\">No service states collected "
                     "(machine pull failed or returned nothing).</p>")

    parts.append("<footer>Generated by features/test-project/logcheck — "
                 "run <code>python3 collect.py &amp;&amp; python3 report.py</code> "
                 "to refresh. NEW = normalized issue never seen in seen.json. "
                 "Snapshot: latest.json in the same directory.</footer>")
    parts.append("</main></body></html>")
    return "".join(parts)


def main():
    ap = argparse.ArgumentParser(description="QwenPaw log-check report")
    ap.add_argument("snapshot", nargs="?", default=os.path.join(HERE, "latest.json"),
                    help="snapshot JSON (default latest.json)")
    ap.add_argument("--out", default=os.path.join(HERE, "index.html"),
                    help="HTML output path (default index.html)")
    args = ap.parse_args()
    with open(args.snapshot) as f:
        snapshot = json.load(f)
    with open(args.out, "w") as f:
        f.write(render(snapshot))
    s = snapshot["summary"]
    print("report written: %s" % args.out)
    print("  errors: %d  warnings: %d  NEW: %d  sources ok: %d/%d"
          % (s["total_errors"], s["total_warnings"], s["new_issues"],
             s["sources_ok"], s["sources_total"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
