#!/usr/bin/env python3
"""Lossless PNG recompression for QwenPaw workspace screenshots.

Win-win rule: keep every screenshot, pixel-for-pixel. Only the file
encoding changes (Pillow optimize=True is a lossless re-encode).
Same filename, same pixels, smaller file. If a file does not shrink,
it is left untouched. If a file fails to decode or the pixels differ
after re-encoding, it is left untouched and reported.

Two phases (workspace files are root-owned, exec runs as uid 1000):
  1. prepare (as user):  decode + re-encode each PNG into --tmp-dir,
     verify pixels match, write a manifest of files that shrink.
  2. apply (as root):    back up each original, replace it with the
     optimized copy, verify the replaced file decodes with identical
     pixels, and report before/after sizes.

Usage:
  python3 recompress_screenshots.py prepare [--dir DIR] [--tmp-dir DIR]
  sudo python3 recompress_screenshots.py apply [--dir DIR] [--tmp-dir DIR] [--backup-dir DIR]
"""
import argparse
import hashlib
import json
import os
import shutil
import sys

try:
    from PIL import Image
except ImportError:
    print("PIL (Pillow) is not available; cannot recompress losslessly. Skipping.")
    sys.exit(2)


def pixels_hash(path):
    """Hash of the decoded pixel data (mode + size + raw bytes)."""
    with Image.open(path) as im:
        im.load()
        return hashlib.sha256(
            f"{im.mode}|{im.size}|".encode() + im.tobytes()
        ).hexdigest()


def do_prepare(args):
    pngs = sorted(
        f for f in os.listdir(args.dir) if f.lower().endswith(".png")
    )
    if not pngs:
        print("No PNG files found in", args.dir)
        return 0
    os.makedirs(args.tmp_dir, exist_ok=True)
    manifest = {"dir": args.dir, "files": []}
    total_before = 0
    total_after = 0
    for name in pngs:
        src = os.path.join(args.dir, name)
        before = os.path.getsize(src)
        total_before += before
        try:
            orig_pixels = pixels_hash(src)
        except Exception as e:
            print(f"  SKIP {name}: cannot decode ({e})")
            total_after += before
            continue
        tmp = os.path.join(args.tmp_dir, name)
        try:
            with Image.open(src) as im:
                im.save(tmp, format="PNG", optimize=True)
            after = os.path.getsize(tmp)
            if pixels_hash(tmp) != orig_pixels:
                print(f"  SKIP {name}: pixels differ after re-encode")
                os.remove(tmp)
                total_after += before
                continue
            if after >= before:
                print(f"  SKIP {name}: {before} -> {after} (no gain)")
                os.remove(tmp)
                total_after += before
                continue
            print(f"  READY {name}: {before} -> {after} (-{before - after})")
            manifest["files"].append(
                {"name": name, "before": before, "after": after,
                 "pixels": orig_pixels}
            )
            total_after += after
        except Exception as e:
            print(f"  FAIL {name}: {e}")
            if os.path.exists(tmp):
                os.remove(tmp)
            total_after += before
    with open(os.path.join(args.tmp_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"---\nPrepared {len(manifest['files'])} of {len(pngs)} files; "
          f"total {total_before} -> {total_after} "
          f"(-{total_before - total_after})")
    return 0


def do_apply(args):
    manifest_path = os.path.join(args.tmp_dir, "manifest.json")
    with open(manifest_path) as f:
        manifest = json.load(f)
    os.makedirs(args.backup_dir, exist_ok=True)
    total_before = 0
    total_after = 0
    applied = 0
    for entry in manifest["files"]:
        name = entry["name"]
        src = os.path.join(args.dir, name)
        tmp = os.path.join(args.tmp_dir, name)
        before = os.path.getsize(src)
        total_before += before
        # Back up the original first.
        shutil.copy2(src, os.path.join(args.backup_dir, name))
        # Replace with the optimized copy.
        shutil.copy2(tmp, src)
        after = os.path.getsize(src)
        total_after += after
        # Verify the replaced file decodes with identical pixels.
        if pixels_hash(src) != entry["pixels"]:
            print(f"  FAIL {name}: pixels differ after replace; restoring backup")
            shutil.copy2(os.path.join(args.backup_dir, name), src)
            total_after += before - after
            continue
        print(f"  OK   {name}: {before} -> {after} (-{before - after})")
        applied += 1
    print(f"---\nApplied {applied} of {len(manifest['files'])} files; "
          f"total {total_before} -> {total_after} "
          f"(-{total_before - total_after})")
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--dir", default="/data/home/qwenpaw/working/workspaces/default")
    p.add_argument("--tmp-dir", default="/tmp/bw-opt")
    a = sub.add_parser("apply")
    a.add_argument("--dir", default="/data/home/qwenpaw/working/workspaces/default")
    a.add_argument("--tmp-dir", default="/tmp/bw-opt")
    a.add_argument(
        "--backup-dir",
        default="/data/home/qwenpaw/working.backups/bloat-winwin-20261118/screenshots",
    )
    args = ap.parse_args()
    if args.cmd == "prepare":
        return do_prepare(args)
    return do_apply(args)


if __name__ == "__main__":
    sys.exit(main())
