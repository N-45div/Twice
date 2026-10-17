#!/usr/bin/env bash
# Boots boxyhq/saas-starter-kit next to the other target, on port 4002 with its own database.
set -euo pipefail
exec > /tmp/boot-boxyhq.log 2>&1
echo "[twice] start $(date +%s)"
docker start pg 2>/dev/null || docker run -d --name pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app -p 5432:5432 postgres:16-alpine
until docker exec pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
docker exec pg psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='boxy'" | grep -q 1 || docker exec pg psql -U postgres -c "CREATE DATABASE boxy"
[ -d /boxy/.git ] || git clone --depth 1 https://github.com/boxyhq/saas-starter-kit /boxy
cd /boxy
cp .env.example .env
cat >> .env <<ENV
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/boxy
AUTH_PROVIDERS=credentials
STRIPE_SECRET_KEY=sk_test_twice_offline
STRIPE_WEBHOOK_SECRET=whsec_twice
NEXT_TELEMETRY_DISABLED=1
ENV
npm ci --no-audit --no-fund
echo "[twice] installed $(date +%s)"
npx prisma db push --accept-data-loss
echo "[twice] migrated $(date +%s)"
NODE_OPTIONS=--max-old-space-size=1024 nohup npm run dev > /tmp/boxy.log 2>&1 &
for i in $(seq 1 240); do
  if curl -s -o /dev/null -w '%{http_code}' -X POST localhost:4002/api/webhooks/stripe | grep -q '^[2345]'; then break; fi
  sleep 2
done
echo "[twice] ready $(date +%s)"
