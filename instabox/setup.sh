#!/usr/bin/env bash
# One-time setup INSIDE the InstaBox machine (instabox ssh qwenpaw).
# Run from /data/home/qwenpaw, with docker-compose.yml + .env already there.
# .env must exist and be chmod 600 before running this.
set -euo pipefail

echo "== Docker status =="
systemctl is-enabled docker || sudo systemctl enable --now docker
systemctl is-active docker

mkdir -p /data/home/qwenpaw/working /data/home/qwenpaw/working.secret /data/home/qwenpaw/working.backups
chmod 700 /data/home/qwenpaw/working.secret
chmod 600 /data/home/qwenpaw/.env

echo "== Pull + start QwenPaw v2.3.0 =="
cd /data/home/qwenpaw
docker compose pull
docker compose up -d
docker compose ps

echo "== Install systemd auto-start =="
sudo cp qwenpaw.service /etc/systemd/system/qwenpaw.service
sudo systemctl daemon-reload
sudo systemctl enable --now qwenpaw.service
sudo systemctl status qwenpaw.service --no-pager || true

echo "== Wait for health =="
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8088/api/healthz >/dev/null 2>&1; then
    echo "healthy: $(curl -s http://127.0.0.1:8088/api/healthz)"
    break
  fi
  echo "waiting… ($i/30)"; sleep 10
done
docker compose ps
echo "Done. Now: instabox port publish qwenpaw 8088 --name QwenPaw"
