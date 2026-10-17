#!/usr/bin/env bash
# Boots nextjs/saas-starter with a local Postgres inside a CreateOS sandbox.
set -euo pipefail
exec > /tmp/boot.log 2>&1
echo "[twice] start $(date +%s)"
docker start pg 2>/dev/null || docker run -d --name pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app -p 5432:5432 postgres:16-alpine
[ -d /app/.git ] || git clone --depth 1 https://github.com/nextjs/saas-starter /app
cd /app
command -v pnpm >/dev/null || corepack enable pnpm || npm i -g pnpm
cat > .env <<ENV
POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/app
STRIPE_SECRET_KEY=sk_test_twice_offline
STRIPE_WEBHOOK_SECRET=whsec_twice
BASE_URL=http://localhost:3000
AUTH_SECRET=twice-local-auth-secret-0123456789
ENV
CI=true pnpm install --frozen-lockfile --config.dangerously-allow-all-builds=true || CI=true pnpm rebuild
echo "[twice] installed $(date +%s)"
until docker exec pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
pnpm db:migrate
echo "[twice] migrated $(date +%s)"
nohup pnpm next dev -p 3000 > /tmp/next.log 2>&1 &
for i in $(seq 1 180); do
  if curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3000/api/stripe/webhook | grep -q '^[2345]'; then break; fi
  sleep 2
done
echo "[twice] ready $(date +%s)"
