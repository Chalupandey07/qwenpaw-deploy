#!/usr/bin/env bash
# Run INSIDE the InstaBox machine after deploy.
set -euo pipefail
docker compose ps
curl -s http://127.0.0.1:8088/api/version; echo
curl -s http://127.0.0.1:8088/api/healthz; echo
systemctl is-enabled qwenpaw.service docker.service || true
df -h / /data
docker system df || true
echo "Now check from the PUBLIC URL (not localhost): login page must appear."
