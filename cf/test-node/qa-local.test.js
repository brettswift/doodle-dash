// Runs the SAME BASE_URL QA game client used for Fly (tools/qa-game.js) against a local workerd Worker (`wrangler dev`),
// plus a real hibernation check and a bundle-content check. Local only: nothing is deployed and no Cloudflare credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), cfDir = join(here, '..'), root = join(cfDir, '..');
const PORT = 18000 + Math.floor(Math.random() * 1000), TOKEN = 'local-qa-' + Math.random().toString(36).slice(2);
const BASE = `http://localhost:${PORT}`;
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
delete env.CLOUDFLARE_API_TOKEN; delete env.CLOUDFLARE_ACCOUNT_ID; // local run must never see real credentials
let dev, log = '';

async function up() {
  const state = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'cf-qa-'));
  dev = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--persist-to', state,
    '--var', `DOODLE_EXPORT_TOKEN:${TOKEN}`, 'CHOOSE_MS:5000', 'DRAW_MS:10000', 'RESULT_MS:2500', 'GRACE_MS:2000', 'LOBBY_FIRST_MS:2500', 'LOBBY_RESET_MS:1000'],
  { cwd: cfDir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  dev.stdout.on('data', (d) => { log += d; }); dev.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start:\n' + log.slice(-2000));
}
test.before(up);
test.after(() => { try { process.kill(-dev.pid, 'SIGTERM'); } catch { /* already gone */ } });

test('QA game client passes 24/24 checks against the local Cloudflare Worker', () => {
  const r = spawnSync('node', [join(root, 'tools/qa-game.js')], { env: { ...env, BASE_URL: BASE, ADMIN_TOKEN: TOKEN }, encoding: 'utf8', timeout: 240000 });
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.checks.filter((c) => !c.ok), []);
  assert.equal(report.checks.length, 24);
  assert.equal(r.status, 0);
});

test('two QA games run concurrently on one Worker, each in its own Room objects, both pass', async () => {
  const run = (extra) => new Promise((resolve) => {
    let out = ''; const p = spawn('node', [join(root, 'tools/qa-game.js')], { env: { ...env, BASE_URL: BASE, ADMIN_TOKEN: TOKEN, ...extra } });
    p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => resolve({ code, out }));
  });
  // the public queue is one global queue, so only one of the two runs exercises it
  const [a, b] = await Promise.all([run({}), run({ QA_SKIP: 'public' })]);
  for (const r of [a, b]) { const rep = JSON.parse(r.out); assert.deepEqual(rep.checks.filter((c) => !c.ok), []); assert.equal(r.code, 0); }
  assert.equal(JSON.parse(a.out).checks.length, 24); assert.equal(JSON.parse(b.out).checks.length, 22);
  const h = (await (await fetch(BASE + '/admin/analytics.json', { headers: { authorization: 'Bearer ' + TOKEN } })).json()).health;
  console.log('storage after 3 QA games (Directory + all Rooms):', JSON.stringify(h.storage), 'registered rooms', h.registeredRooms);
  assert.ok(h.storage.rowsWritten > 0);
});

test('hibernation: after idle the Room object is rebuilt from its snapshot and live sockets keep their seats', async () => {
  // entry socket + goto, like the browser
  const open = () => new Promise((res) => {
    const c = { msgs: [] };
    const attach = (w) => { c.w = w; w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'goto') { w.onclose = null; w.close(); const n = new WebSocket(`ws://localhost:${PORT}/ws?room=${m.code}`); n.onopen = () => n.send(JSON.stringify(m.msg)); attach(n); return; } c.msgs.push(m); }; };
    const w = new WebSocket(`ws://localhost:${PORT}/ws`); attach(w); w.onopen = () => res(c);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = await open(), b = await open();
  a.w.send(JSON.stringify({ t: 'create', name: 'Ann' })); await sleep(400);
  const code = a.msgs.find((m) => m.t === 'joined').code;
  b.w.send(JSON.stringify({ t: 'join', code, name: 'Bob' })); await sleep(400);
  const starts = () => (log.match(/room start: [A-Z]{4} restored/g) || []).length, before = starts();
  await sleep(25000); // idle lobby: no timers, so workerd hibernates the object
  a.w.send(JSON.stringify({ t: 'rounds', n: 2 })); await sleep(800);
  assert.ok(starts() > before, 'object was evicted and rebuilt');
  assert.match(log, /room start: [A-Z]{4} restored 2 socket\(s\)/);
  for (const c of [a, b]) assert.equal(c.msgs.filter((m) => m.t === 'state').pop().rotations, 2);
  a.w.close(); b.w.close();
});

test('bundle: Worker bundle has no Node HTTP server, custom ws framing or real node:sqlite', () => {
  const r = spawnSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', join(cfDir, 'dist')], { cwd: cfDir, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const src = readFileSync(join(cfDir, 'dist/worker.js'), 'utf8');
  assert.doesNotMatch(src, /from "node:(http|https)"/);
  assert.doesNotMatch(src, /Sec-WebSocket-Accept/i);
  assert.match(src, /node:sqlite is not available in Workers/); // only the stub
  assert.ok(Buffer.byteLength(src) < 3 * 1024 * 1024, 'under the 3 MB free-plan script limit');
});

test('tools/import-to-cf.js seeds the local Worker from a legacy dir (synthetic) and verification passes', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs'); const { gzipSync } = await import('node:zlib');
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'legacy-'));
  writeFileSync(join(d, 'history.jsonl'), [1, 2, 3].map((n) => JSON.stringify({ k: 'r', seq: n, tid: 'cat', g: 'g' + n, out: 'ok' })).join('\n') + '\n');
  writeFileSync(join(d, 'analytics.jsonl'), [1, 2].map((n) => JSON.stringify({ v: 1, at: Date.now() - n, type: 'landing', synthetic: true })).join('\n') + '\n');
  writeFileSync(join(d, 'state.json'), JSON.stringify({ v: 1, tiers: { cat: 'hard' }, since: {}, audit: [{ at: 1, id: 'cat' }] }));
  mkdirSync(join(d, 'archive')); writeFileSync(join(d, 'archive', 'deadbeef.json.gz'), gzipSync(JSON.stringify({ savedAt: '2026-11-01T00:00:00.000Z', best: {} })));
  const r = spawnSync('node', [join(root, 'tools/import-to-cf.js'), d], { env: { ...env, BASE_URL: BASE, ADMIN_TOKEN: TOKEN }, encoding: 'utf8', timeout: 120000 });
  const rep = JSON.parse(r.stdout);
  assert.deepEqual(rep.problems, []); assert.equal(r.status, 0);
  assert.deepEqual(rep.imported, { drawings: 3, tiers: 1, audit: 1, events: 2, archive: 1 });
});
