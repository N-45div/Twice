// Runs inside the sandbox. Resets the database, delivers signed Stripe events
// in the given order, then reads back the state the app ended up in.
// usage: node replay.mjs plan.json
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const db = plan.db ?? { container: 'pg', user: 'postgres', name: 'app' };

function sql(query) {
  const r = spawnSync(
    'docker',
    ['exec', '-i', db.container, 'psql', '-U', db.user, '-d', db.name, '-tA', '-v', 'ON_ERROR_STOP=1'],
    { input: query, encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error(`sql failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function sign(body, secret) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

const out = { deliveries: [], state: null, error: null };
try {
  if (plan.reset_sql) sql(plan.reset_sql);
  for (const event of plan.deliveries) {
    const body = JSON.stringify(event);
    const started = Date.now();
    const res = await fetch(plan.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(body, plan.secret) },
      body,
    });
    out.deliveries.push({ id: event.id, type: event.type, status: res.status, ms: Date.now() - started });
    if (plan.gap_ms) await new Promise((r) => setTimeout(r, plan.gap_ms));
  }
  const row = sql(`SELECT row_to_json(t) FROM (${plan.state_sql.replace(/;\s*$/, '')}) t LIMIT 1;`);
  out.state = row ? JSON.parse(row) : null;
} catch (err) {
  out.error = String(err.message ?? err);
}
console.log(JSON.stringify(out));
