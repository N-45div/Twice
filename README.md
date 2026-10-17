# Twice

**A 200 isn't enough.** Twice is an agent that tests your Stripe webhook handler against the delivery orders Stripe's own docs say will happen: the same event twice, events out of order, a late retry landing after newer events, and deliveries that never arrive. It boots your real app and its database in a CreateOS sandbox, replays signed Stripe events in every one of those orders, checks what actually ended up in the database, and then writes the fix and proves it.

Demo video (2 min): https://youtu.be/tPClB1H2_64

Live run viewer: https://dep-7f478f70-2537-427a-9b65-a9113c2d880f.tyzo.nodeops.app

## What it found

I pointed Twice at [nextjs/saas-starter](https://github.com/nextjs/saas-starter), Vercel's official Next.js + Postgres + Stripe starter (16k stars).

- **5 of 12 delivery orders left the database wrong, and every single request returned HTTP 200.** When a late `customer.subscription.updated` arrives after `customer.subscription.deleted`, the handler writes whatever status the late event carries. A team that cancelled ends up back on the "Basic" plan as `trialing` or `active`.
- The agent then changed the app: it records each event's `created` time on the team and ignores anything older than the last event it applied. After the fix, **0 of 12** orders were wrong.
- The whole loop (resume the booted app, read the code, write the test, run 12 orders, fix, run 12 again) takes under three minutes. In the latest recorded run it took 163 seconds, and the booted app resumed from its paused snapshot in 4.6 s.

I then pointed the same agent at a second popular starter, [boxyhq/saas-starter-kit](https://github.com/boxyhq/saas-starter-kit) (Next.js + Prisma + Postgres), with no code changes to Twice beyond the app's folder, port and database:

- **5 of 12 delivery orders left a cancelled subscription in the database as `active: true`.** The handler hard-deletes the subscription on `customer.subscription.deleted`, so a late `created` or `updated` event re-creates it with `active` hard-coded to true.
- The agent changed the handler and the Prisma schema; after the fix, **0 of 12** orders were wrong. That run took 247 seconds.
- Side finding: a duplicate `customer.subscription.created` makes the handler return HTTP 400 (primary-key error) on every delivery, so Stripe keeps retrying an event the app will never accept.

The recorded run, including every command the agent ran and the diff it wrote, is in [`web/run.json`](web/run.json) and [`web/run-boxyhq.json`](web/run-boxyhq.json) and on the viewer page.

A side note from the same run: to read the plan name, the handler casts `plan.product` to an expanded Product object, but stores the same field as the product id string. With the expanded shape the agent used, the starter stores `[object Object]` as the product id.

## How it works

1. **Boot.** [`targets/nextjs-saas-starter/boot.sh`](targets/nextjs-saas-starter/boot.sh) runs inside a CreateOS sandbox (`devbox:1`): Postgres in Docker, the repo cloned, dependencies installed, migrations applied, `next dev` started.
2. **Lock the network.** Twice sets the sandbox's egress allowlist to `127.0.0.1/32`. Nothing the app runs, and nothing the agent writes, can reach Stripe or anywhere else. Every event is signed locally with the app's own webhook secret.
3. **The agent writes the test it will be held to.** A tool-using agent ([`src/agent.js`](src/agent.js)) works inside the sandbox with `run` and `write_file` tools. It reads the webhook route and the code it calls, inspects the schema with `psql`, and writes `.twice/spec.json`: a seed for one test customer, a query for the state that matters, a realistic subscription lifecycle as Stripe events, and the state expected after each one. Twice replays the events once, in order; if the app disagrees with the spec, the agent is told exactly how and fixes its own spec.
4. **Explore.** [`src/schedules.js`](src/schedules.js) turns the lifecycle into hostile orders: every event twice, fully reversed, each adjacent pair swapped, a late retry of each event, each event dropped. [`sandbox/replay.mjs`](sandbox/replay.mjs) runs inside the sandbox: it resets the database, posts the signed events in that order, and reads the state back. The rule: the database must match the newest event it was sent, whatever order the deliveries arrived in.
5. **Fix.** The agent gets the failing orders, edits the app's own code, adds a column through Drizzle and `psql` when it needs one, re-runs the failing replays itself, and Twice then re-runs every order from scratch.

Booting the app is the slow part (install, migrate, compile), so it happens once. Between runs the booted sandbox stays paused with its memory, and Twice resumes it in a few seconds with `next dev` and Postgres still running; `--pause-after` pauses it again when the run ends.

With `--fork`, Twice pauses the booted app once and forks a fresh copy (memory and disk) for each delivery order, so every order starts from exactly the same running state. The run above used sequential mode, because my CreateOS plan allows one sandbox at a time.

## Take the result with you

The run viewer has three buttons under the fix:

- **Download the fix (.patch)**: the agent's change as a `git apply`-able patch.
- **Copy PR description**: a ready pull-request body listing every order that broke, what the database ended up with, the fix, and the verification run.
- **Download regression pack**: the events, the hostile delivery orders and the expected end states as `twice-pack.json`. Replay it against your own running app with [`tools/replay-pack.mjs`](tools/replay-pack.mjs), which has no dependencies and exits 1 if any order leaves the database wrong, so the bug can't come back:

```bash
DATABASE_URL=postgres://localhost/dev STRIPE_WEBHOOK_SECRET=whsec_...   node tools/replay-pack.mjs twice-pack.json --url http://localhost:3000
```

## Stack

- **Stripe Projects** set up the stack from an empty directory: `stripe projects init`, then `stripe projects add createos/free` and `createos/project`, which created the CreateOS account and wrote its credentials to `.env`.
- **CreateOS Sandbox** runs everything the agent touches: exec, file writes, egress allowlist, pause and fork (`@nodeops-createos/sandbox`). The viewer is deployed on CreateOS too.
- **OpenAI `gpt-5.4`** drives the agent through tool calls.

## Run it

```bash
npm install
stripe projects init twice && stripe projects add createos/free && stripe projects add createos/project
export OPENAI_API_KEY=...            # the agent's model

# boot the target in a sandbox
createos sandbox create --name twice-base --shape s-2vcpu-2gb --rootfs devbox:1
createos sandbox push twice-base targets/nextjs-saas-starter/boot.sh /root/boot.sh
createos sandbox exec twice-base -- bash /root/boot.sh

# run Twice against it (add --fork on a plan that allows several sandboxes)
node --env-file=.env src/run.js --sandbox <sandbox-id> --pause-after

# watch it live
node src/live.mjs   # then open http://localhost:8088/?live
```

Each run writes `runs/<id>.json` and `runs/latest.json`; copy one to `web/run.json` to show it on the viewer.

## Honest limits

- The events are built by the agent from the handler's own field reads and signed locally. They are not recorded from a live Stripe account.
- Twice judges one table row per customer. It does not yet check emails, credits or other side effects.
- The target needs a boot script. Two are included so far: nextjs/saas-starter and boxyhq/saas-starter-kit.

Built during the CreateOS × Stripe Projects hackathon (Oct 17, 2026), in coordination with an AI coding assistant, Claude Code.
