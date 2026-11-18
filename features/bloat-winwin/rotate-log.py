#!/usr/bin/env python3
"""QwenPaw log rotation (systemd timer, daily).

Rotates /data/home/qwenpaw/working/qwenpaw.log when it exceeds
MAX_BYTES: gzip the current log to a dated archive, VERIFY the archive
exists and is non-empty, and only then truncate the live log. Every
rotated byte is kept (no deletion, no retention expiry); archives live
in /data/home/qwenpaw/working.backups/log-archives/.

Runs as root via the qwenpaw-log-rotate systemd service (the log file
is root-owned). Safe to run when the container is up: the app holds
the log open and keeps writing to the same inode after truncate
(copytruncate semantics), so no restart is needed.

Exit 0 when there is nothing to rotate or the rotation succeeded.
Exit 1 on any verification failure (the live log is left untouched).
"""
import gzip
import os
import shutil
import sys
from datetime import datetime, timezone

LOG = "/data/home/qwenpaw/working/qwenpaw.log"
ARCHIVE_DIR = "/data/home/qwenpaw/working.backups/log-archives"
MAX_BYTES = 5 * 1024 * 1024  # 5 MiB


def main():
    if not os.path.exists(LOG):
        print(f"{LOG} does not exist; nothing to rotate")
        return 0
    size = os.path.getsize(LOG)
    if size < MAX_BYTES:
        print(f"{LOG} is {size} bytes (< {MAX_BYTES}); nothing to rotate")
        return 0
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")
    try:
        os.makedirs(ARCHIVE_DIR, exist_ok=True)
    except OSError as exc:
        print(f"ERROR: cannot create archive dir {ARCHIVE_DIR}: {exc}; "
              "live log untouched")
        return 1
    archive = os.path.join(ARCHIVE_DIR, f"qwenpaw.log.{stamp}.gz")
    # 1. Compress the live log to the archive.
    try:
        with open(LOG, "rb") as src, gzip.open(archive, "wb") as dst:
            shutil.copyfileobj(src, dst)
    except OSError as exc:
        print(f"ERROR: cannot write archive {archive}: {exc}; "
              "live log untouched")
        return 1
    # 2. Verify the archive BEFORE touching the live log.
    if not os.path.exists(archive) or os.path.getsize(archive) == 0:
        print(f"ERROR: archive {archive} missing or empty; live log untouched")
        return 1
    # Verify the archive decompresses and has the expected byte count.
    with gzip.open(archive, "rb") as f:
        archived_bytes = sum(len(chunk) for chunk in iter(lambda: f.read(1 << 20), b""))
    if archived_bytes != size:
        print(f"ERROR: archive holds {archived_bytes} bytes, live log has {size}; "
              "live log untouched")
        return 1
    # 3. Only now truncate the live log in place (app keeps its open handle).
    with open(LOG, "wb"):
        pass
    print(f"Rotated {LOG} ({size} bytes) -> {archive} "
          f"({os.path.getsize(archive)} bytes gzipped)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
