// Twice: finds the Stripe event orders that break an app, then fixes the app.
// usage: node --env-file=.env src/run.js --sandbox <id> [--fork] [--target nextjs/saas-starter]
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from './agent.js';
import { connect, sh, writeFile } from './sandbox.js';
import { schedules, expected, verdict } from './schedules.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1] ?? true;
};
const FORK = process.argv.includes('--fork');
const WAVE = Number(arg('wave', 4));
const LOCKED = ['127.0.0.1/32'];
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const record = { id: runId, target: arg('target', 'nextjs/saas-starter'), mode: FORK ? 'fork' : 'sequential', events: [] };
fs.mkdirSync('runs', { recursive: true });
const jsonl = fs.createWriteStream(path.join('runs', `${runId}.jsonl`));

function log(event) {
  const e = { t: Date.now(), ...event };
  record.events.push(e);
  jsonl.write(JSON.stringify(e) + '\n');
  const brief = e.text ?? e.command ?? e.name ?? e.path ?? '';
  console.log(`[${e.kind}] ${String(brief).slice(0, 160)}`);
}

function save() {
  fs.writeFileSync(path.join('runs', `${runId}.json`), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join('runs', 'latest.json'), JSON.stringify(record, null, 2));
}

const SYSTEM = `You are Twice, an engineer who tests Stripe webhook handlers against the delivery orders Stripe's docs say will happen: duplicates, events out of order, late retries and dropped deliveries.
You work inside a CreateOS sandbox. The app under test is checked out at /app and is running with "next dev" on http://localhost:3000.
Its Postgres runs in a docker container named "pg" (user postgres, database app). Query it with: docker exec -i pg psql -U postgres -d app -c "<sql>".
The app's Stripe webhook signing secret is whsec_twice. Twice signs every event itself, so nothing ever calls Stripe.
Twice's own tools live in /twice. Never edit files in /twice. Keep every command short and non-interactive.`;

const SPEC_TASK = `Read the app's Stripe webhook route and the code it calls, then write /app/.twice/spec.json describing one customer's subscription lifecycle as Stripe would send it.
The file must be JSON with exactly these keys:
- "webhook_path": the route path that receives Stripe events.
- "reset_sql": SQL that puts the database into a known starting state for one test customer with stripe customer id "cus_twice" (delete then insert, so it is safe to run before every replay; fill every NOT NULL column).
- "state_sql": one SELECT returning exactly one row with the columns these events change for that customer.
- "events": 3 or 4 complete Stripe event objects (id, object "event", type, created, data.object with every field the handler reads) for subscription "sub_twice", in true chronological order with increasing "created", walking a realistic life such as trialing, then active, then canceled. Only use event types the handler acts on.
- "expected_after": an array with one object per event: the row state_sql must return after events 0..i were delivered once, in order. Use the exact column names state_sql returns and JSON null for empty values.
Check your SQL runs against the database before you finish. Then call finish.`;

async function replay(sandbox, spec, schedule, tag) {
  const plan = {
    url: `http://localhost:3000${spec.webhook_path}`,
    secret: 'whsec_twice',
    reset_sql: spec.reset_sql,
    state_sql: spec.state_sql,
    deliveries: schedule.order.map((i) => spec.events[i]),
    gap_ms: 150,
  };
  const file = `/twice/plan-${tag}.json`;
  await writeFile(sandbox, file, JSON.stringify(plan));
  const r = await sh(sandbox, `node /twice/replay.mjs ${file}`);
  let out;
  try {
    out = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    out = { deliveries: [], state: null, error: r.stderr || r.stdout || `exit ${r.code}` };
  }
  const want = expected(spec, schedule.order);
  const v = out.error ? { ok: false, diffs: [{ column: '(error)', expected: '', actual: out.error }] } : verdict(want, out.state);
  return { ...schedule, file, deliveries: out.deliveries, state: out.state, expected: want, ...v };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

async function explore(base, spec, round) {
  const list = schedules(spec.events.length);
  log({ kind: 'explore_start', round, count: list.length, mode: record.mode });
  const results = [];
  if (!FORK) {
    for (const s of list) {
      const r = await replay(base, spec, s, slug(s.name));
      log({ kind: 'schedule', round, ...r });
      results.push(r);
    }
    return results;
  }
  const t0 = Date.now();
  await base.pause();
  await base.waitUntilPaused({ timeoutMs: 600_000 });
  log({ kind: 'paused', text: `Paused the booted app in ${((Date.now() - t0) / 1000).toFixed(1)} s`, ms: Date.now() - t0 });
  for (let i = 0; i < list.length; i += WAVE) {
    const wave = list.slice(i, i + WAVE);
    const done = await Promise.all(
      wave.map(async (s) => {
        const f0 = Date.now();
        const copy = await base.fork({ egress: LOCKED });
        log({ kind: 'forked', name: s.name, sandbox: copy.id, ms: Date.now() - f0 });
        try {
          await sh(copy, 'true');
          return await replay(copy, spec, s, slug(s.name));
        } finally {
          await copy.destroy().catch(() => {});
        }
      })
    );
    for (const r of done) {
      log({ kind: 'schedule', round, ...r });
      results.push(r);
    }
  }
  await base.resume();
  return results;
}

async function main() {
  const base = await connect(arg('sandbox'));
  log({ kind: 'start', text: `Twice on ${record.target} in ${record.mode} mode`, sandbox: base.id });
  // Booting the app (install, migrate, compile) is slow, so it happens once.
  // Between runs the booted sandbox sits paused, memory included, and resumes in seconds.
  if (base.status === 'paused') {
    const r0 = Date.now();
    await base.resume();
    await base.waitUntilRunning({ timeoutMs: 300_000 });
    log({ kind: 'resumed', text: `Resumed the booted app from its paused snapshot in ${((Date.now() - r0) / 1000).toFixed(1)} s (next dev and Postgres still running)`, ms: Date.now() - r0 });
  }
  await writeFile(base, '/twice/replay.mjs', fs.readFileSync('sandbox/replay.mjs', 'utf8'));
  // The app never needs the internet for this. Lock its network to itself so
  // nothing it runs, and nothing the agent writes, can reach Stripe or anywhere else.
  await base.setEgress(LOCKED);
  const probe = await sh(base, 'curl -s -m 5 -o /dev/null https://api.stripe.com && echo reachable || echo blocked');
  log({ kind: 'egress', text: `Network locked to 127.0.0.1. Reaching api.stripe.com from inside the sandbox: ${probe.stdout.trim()}` });
  const agent = new Agent(base, SYSTEM, log);

  // 1. The agent reads the handler and writes the test it will be held to.
  let spec;
  let feedback = SPEC_TASK;
  for (let attempt = 1; attempt <= 3; attempt++) {
    log({ kind: 'phase', text: attempt === 1 ? 'Reading the webhook handler' : `Fixing its own spec (attempt ${attempt})` });
    await agent.task(feedback);
    const raw = await sh(base, 'cat /app/.twice/spec.json');
    try {
      spec = JSON.parse(raw.stdout);
    } catch (e) {
      feedback = `/app/.twice/spec.json is not valid JSON (${e.message}). Fix it.`;
      continue;
    }
    const check = await replay(base, spec, { name: 'In order', order: spec.events.map((_, i) => i) }, 'baseline');
    log({ kind: 'baseline', ...check });
    if (check.ok) break;
    feedback = `I replayed your events once, in order. The app returned ${JSON.stringify(check.deliveries)} and ended at ${JSON.stringify(check.state)}, but your expected_after says ${JSON.stringify(check.expected)}. Differences: ${JSON.stringify(check.diffs)}. The app is the ground truth for in-order delivery, so fix the spec (events, SQL or expectations) until in-order delivery matches.`;
    spec = null;
  }
  if (!spec) throw new Error('could not build a spec that passes in-order delivery');
  record.spec = spec;
  save();

  // 2. Explore hostile orders.
  let results = await explore(base, spec, 1);
  record.before = results;
  save();
  let broken = results.filter((r) => !r.ok);
  log({ kind: 'summary', text: `${broken.length} of ${results.length} delivery orders left the app in the wrong state`, broken: broken.length, total: results.length });

  // 3. The agent fixes the app until every order passes.
  const handlerBefore = await sh(base, 'cd /app && git diff --stat; git status --short');
  for (let round = 2; broken.length && round <= 4; round++) {
    log({ kind: 'phase', text: `Writing a fix (round ${round - 1})` });
    const failures = broken.map((b) => ({
      order: b.name,
      delivered: b.deliveries.map((d) => `${d.type} ${d.id} -> HTTP ${d.status}`),
      ended_at: b.state,
      should_be: b.expected,
      replay_with: `node /twice/replay.mjs ${b.file}`,
    }));
    await agent.task(
      `These delivery orders left the app in the wrong state:\n${JSON.stringify(failures, null, 2)}\n` +
        `Change the app's own code (not /app/.twice and not /twice) so that the stored state always reflects the newest event for a subscription (compare event.created), and an older event can never bring back a cancelled subscription. ` +
        `Keep the change small and in the style of the codebase. If you need a new column, add it to the Drizzle schema AND create it in the database with psql. next dev reloads files on its own. ` +
        `Re-run the replay commands above yourself until every one of them ends in the right state, then call finish.`
    );
    results = await explore(base, spec, round);
    broken = results.filter((r) => !r.ok);
    log({ kind: 'summary', text: `${broken.length} of ${results.length} delivery orders still wrong after the fix`, broken: broken.length, total: results.length, round });
  }
  record.after = results;
  record.diff = (await sh(base, "cd /app && git diff -- . ':!tsconfig.json' ':!next-env.d.ts'")).stdout;
  await base.setEgress(null);
  record.files = handlerBefore.stdout;
  log({ kind: 'end', text: broken.length ? 'Some orders still fail' : 'Every delivery order now ends in the right state' });
  save();
  if (process.argv.includes('--pause-after')) {
    const p0 = Date.now();
    await base.pause();
    await base.waitUntilPaused({ timeoutMs: 600_000 });
    log({ kind: 'paused', text: `Paused the sandbox again in ${((Date.now() - p0) / 1000).toFixed(1)} s, so it stops using CPU until the next run` });
    save();
  }
}

main()
  .then(() => jsonl.end(() => process.exit(0)))
  .catch((err) => {
    log({ kind: 'error', text: String(err.stack ?? err) });
    save();
    jsonl.end(() => process.exit(1));
  });
