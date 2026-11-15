"""Fix DriverCard YAML: convert the unquoted single-line `description:` (which
contains ': ' inside JSON, breaking YAML) to a literal block scalar. Run
INSIDE the QwenPaw container as: python3 /app/working/fixcard.py
Backs up each card to /app/working.backups/ first. Verifies with yaml.safe_load.
"""
import os
import shutil
import yaml

PATHS = [
    "/app/working/workspaces/default/drivers/mcp/computer-use.yaml",
    "/app/working/workspaces/QwenPaw_QA_Agent_0.2/drivers/mcp/computer-use.yaml",
]

for path in PATHS:
    backup = path.replace("/app/working/", "/app/working.backups/").replace(
        "drivers/mcp/computer-use.yaml", "computer-use.yaml"
    )
    backup = backup.replace("computer-use.yaml", "computer-use.yaml.bak-2026-11-15-yaml-fix")
    # QA card lives in a different workspace dir; keep its name distinct.
    if "QwenPaw_QA_Agent" in path:
        backup = backup.replace(
            "computer-use.yaml.bak-2026-11-15-yaml-fix",
            "computer-use-qa.yaml.bak-2026-11-15-yaml-fix",
        )
    os.makedirs(os.path.dirname(backup), exist_ok=True)
    shutil.copy(path, backup)
    print("backup:", backup)
    text = open(path).read()
    lines = text.split("\n")
    out = []
    changed = False
    for line in lines:
        if line.startswith("  description: ") and not line.startswith("  description: |"):
            desc = line[len("  description: "):]
            out.append("  description: |")
            out.append("    " + desc)
            changed = True
        else:
            out.append(line)
    if changed:
        open(path, "w").write("\n".join(out))
        print(path, "rewrote description as block scalar")
    d = yaml.safe_load(open(path))
    print(
        path,
        "YAML OK, desc len:",
        len(d["config"]["description"]),
        "policy:",
        d["policy"]["rules"][0]["effect"],
        "url:",
        d["endpoint"]["url"],
    )
print("DONE")
