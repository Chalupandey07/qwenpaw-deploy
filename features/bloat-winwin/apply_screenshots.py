#!/usr/bin/env python3
"""Apply prepared screenshot recompression (runs as user, sudo only for copies).

Reads /tmp/bw-opt/manifest.json (written by the prepare phase), then for
each file: sudo-copy the original to the backup dir, sudo-copy the
optimized file over the original, and verify the replaced file decodes
with identical pixels (Pillow, user python). Restores from backup on
any pixel mismatch.
"""
import hashlib
import json
import os
import subprocess
import sys

from PIL import Image

TMP_DIR = "/tmp/bw-opt"
DIR = "/data/home/qwenpaw/working/workspaces/default"
BACKUP_DIR = "/data/home/qwenpaw/working.backups/bloat-winwin-20261118/screenshots"


def pixels_hash(path):
    with Image.open(path) as im:
        im.load()
        return hashlib.sha256(
            f"{im.mode}|{im.size}|".encode() + im.tobytes()
        ).hexdigest()


def sudo(*args):
    r = subprocess.run(["sudo"] + list(args), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"sudo {' '.join(args)} failed: {r.stderr.strip()}")
    return r


def main():
    with open(os.path.join(TMP_DIR, "manifest.json")) as f:
        manifest = json.load(f)
    sudo("mkdir", "-p", BACKUP_DIR)
    total_before = 0
    total_after = 0
    applied = 0
    for entry in manifest["files"]:
        name = entry["name"]
        src = os.path.join(DIR, name)
        tmp = os.path.join(TMP_DIR, name)
        before = os.path.getsize(src)
        total_before += before
        sudo("cp", "-p", src, os.path.join(BACKUP_DIR, name))
        sudo("cp", "-p", tmp, src)
        after = os.path.getsize(src)
        total_after += after
        if pixels_hash(src) != entry["pixels"]:
            print(f"  FAIL {name}: pixels differ after replace; restoring backup")
            sudo("cp", "-p", os.path.join(BACKUP_DIR, name), src)
            total_after += before - after
            continue
        print(f"  OK   {name}: {before} -> {after} (-{before - after})")
        applied += 1
    print(f"---\nApplied {applied} of {len(manifest['files'])} files; "
          f"total {total_before} -> {total_after} "
          f"(-{total_before - total_after})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
