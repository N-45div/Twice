#!/usr/bin/env node
// Replays a Twice regression pack against your own running app, so the
// hostile Stripe delivery orders Twice found become a check you can run in CI.
//
// usage:
//   DATABASE_URL=postgres://... STRIPE_WEBHOOK_SECRET=whsec_... \
//     node tools/replay-pack.mjs twice-pack.json --url http://localhost:3000
//
// Needs `psql` on the PATH, or pass --psql "<command>" (for example
// "docker exec -i pg psql -U postgres -d app") instead of DATABASE_URL.
// Exits 1 if any order leaves the database wrong.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const packFile = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
if (!packFile) {
  console.error('usage: node tools/replay-pack.mjs <twice-pack.json> --url http://localhost:3000');
  process.exit(2);
}
const pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
const base = flag('url', 'http://localhost:3000');
const secret = process.env.STRIPE_WEBHOOK_SECRET;
const dbUrl = process.env.DATABASE_URL;
const psqlCmd = flag('psql');
if (!secret || (!dbUrl && !psqlCmd)) {
  console.error('Set STRIPE_WEBHOOK_SECRET (your app\'s webhook secret) and DATABASE_URL (a disposable dev database), or pass --psql.');
  process.exit(2);
}
const [psqlBin, ...psqlArgs] = psqlCmd ? psqlCmd.split(' ') : ['psql', dbUrl];

function sql(query) {
  const r = spawnSync(psqlBin, [...psqlArgs, '-tA', '-v', 'ON_ERROR_STOP=1'], { input: query, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function sign(body) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

function verdict(want, got) {
  if (want === null) return got ? [`row should not exist, found ${JSON.stringify(got)}`] : [];
  if (!got) return ['row is missing'];
  return Object.entries(want)
    .filter(([k, v]) => String(v ?? null) !== String(got[k] ?? null))
    .map(([k, v]) => `${k} ended ${JSON.stringify(got[k] ?? null)}, should be ${JSON.stringify(v ?? null)}`);
}

let failed = 0;
for (const s of pack.schedules) {
  sql(pack.reset_sql);
  for (const i of s.order) {
    const body = JSON.stringify(pack.events[i]);
    await fetch(base + pack.webhook_path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) },
      body,
    });
  }
  const row = sql(`SELECT row_to_json(t) FROM (${pack.state_sql.replace(/;\s*$/, '')}) t LIMIT 1;`);
  const want = pack.expected_after[Math.max(...s.order)];
  const problems = verdict(want, row ? JSON.parse(row) : null);
  if (problems.length) failed++;
  console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${s.name}${problems.length ? ` — ${problems.join('; ')}` : ''}`);
}
console.log(`\n${pack.schedules.length - failed} of ${pack.schedules.length} delivery orders end in the right state.`);
process.exit(failed ? 1 : 0);
