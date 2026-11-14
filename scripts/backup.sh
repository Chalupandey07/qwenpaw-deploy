#!/usr/bin/env bash
# Run INSIDE the InstaBox machine. Tars QwenPaw data/secrets/backups,
# then pull the tar off-box with: instabox pull qwenpaw:/data/home/qwenpaw-backup-<date>.tgz .
set -euo pipefail
DATE=$(date +%F)
tar -czf "/data/home/qwenpaw-backup-${DATE}.tgz" -C /data/home/qwenpaw working working.secret working.backups
ls -lh "/data/home/qwenpaw-backup-${DATE}.tgz"
echo "Pull it off-box with: instabox pull qwenpaw:/data/home/qwenpaw-backup-${DATE}.tgz ."
