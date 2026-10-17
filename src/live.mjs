// Local live view: serves the viewer and the run that is happening right now.
// usage: node src/live.mjs   then open http://localhost:8088/?live
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const web = path.resolve('web');
const runs = path.resolve('runs');

function current() {
  const files = fs.readdirSync(runs).filter((f) => f.endsWith('.jsonl')).sort();
  if (!files.length) return null;
  const id = files.at(-1).replace('.jsonl', '');
  const events = fs.readFileSync(path.join(runs, `${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const full = fs.existsSync(path.join(runs, `${id}.json`)) ? JSON.parse(fs.readFileSync(path.join(runs, `${id}.json`), 'utf8')) : {};
  const schedules = events.filter((e) => e.kind === 'schedule');
  const last = Math.max(0, ...schedules.map((s) => s.round));
  const start = events.find((e) => e.kind === 'start');
  return {
    id,
    live: true,
    target: full.target ?? 'nextjs/saas-starter',
    mode: full.mode ?? (start?.text?.includes('fork') ? 'fork' : 'sequential'),
    events,
    before: schedules.filter((s) => s.round === 1),
    after: last > 1 ? schedules.filter((s) => s.round === last) : [],
    diff: full.diff,
  };
}

http
  .createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/live.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(current()));
      return;
    }
    const file = path.join(web, url === '/' ? 'index.html' : path.normalize(url));
    if (!file.startsWith(web) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(8088, () => console.log('live view on http://localhost:8088/?live'));
