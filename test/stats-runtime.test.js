'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { Analytics } = require('../analytics');
const { start } = require('../server');
const { buildArchive } = require('../export');
const { Game } = require('../game');
const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dd-stats-'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { const result = fn(); if (result) return result; await pause(10); } throw Error('condition timed out'); }
const write = (dir, name, rows) => fs.writeFileSync(path.join(dir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

test('browser cohorts dedupe sessions and game participants, count exact completed-day retention, exclude QA', () => {
  const dir = tmp(), now = Date.now(), day = 86400000, a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
  const at = (days) => Date.parse(new Date(now - days * day).toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' }) + 'T19:00:00Z');
  write(dir, 'analytics.jsonl.1', [
    { type: 'landing', at: at(10), browserId: a }, { type: 'landing', at: at(9), browserId: a },
    { type: 'gameStarted', at: at(3), mode: 'public', gameId: 'public', configuredRounds: 3, participants: [{ browserId: a }, { browserId: b }] },
  ]);
  write(dir, 'analytics.jsonl', [
    { type: 'landing', at: at(3), browserId: a, sessionId: 'different' },
    { type: 'landing', at: at(2), browserId: c, qa: true },
    { type: 'landing', at: at(0), browserId: c },
  ]);
  const s = new Analytics({ dir }).summary();
  assert.equal(s.anonymousBrowsers, 3);
  assert.equal(s.audience.returningBrowsers, 1);
  assert.equal(s.audience.daily.find((d) => d.day === new Date(at(3)).toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' })).active, 2);
  assert.deepEqual(s.audience.retention.day1, { eligible: 2, returned: 1, percent: 50 });
  assert.deepEqual(s.audience.retention.day7, { eligible: 1, returned: 1, percent: 100 });
  assert.equal(s.modes.private.configuredRounds.average, null);
  assert.equal(s.privateLobbies.createToStartRate, null);
});

test('retention purges old product/operational records without touching gameplay; rotated records export', () => {
  const dir = tmp(), now = Date.now(), day = 86400000;
  const keep = { type: 'landing', at: now - 8 * day, browserId: 'a'.repeat(32) };
  write(dir, 'analytics.jsonl.1', [keep, { type: 'operation', at: now - 8 * day }, { type: 'landing', at: now - 91 * day }]);
  write(dir, 'analytics.jsonl', [{ type: 'operation', at: now - day, rss: 1 }]);
  fs.writeFileSync(path.join(dir, 'history.jsonl'), '{"preserve":true}\n');
  const analytics = new Analytics({ dir });
  assert.equal(analytics.records().length, 2);
  assert.equal(analytics.summary().events, 1);
  assert.equal(analytics.operations().samples.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8'), '{"preserve":true}\n');
  const archive = zlib.gunzipSync(buildArchive(dir)).toString();
  assert.ok(archive.includes(JSON.stringify(keep)));
  assert.ok(!archive.includes(String(now - 91 * day)));
});

test('old unresolved lobby is unknown after restart, not currently waiting', () => {
  const dir = tmp(); write(dir, 'analytics.jsonl', [{ type: 'privateLobbyCreated', at: Date.now(), lobbyId: 'old', runId: 'previous' }]);
  const l = new Analytics({ dir }).summary().privateLobbies;
  assert.equal(l.unknownAfterRestart, 1); assert.equal(l.currentlyWaiting, 0);
});

test('server-owned QA tag cannot be overwritten', async () => {
  const dir = tmp(), analytics = new Analytics({ dir, qa: true });
  analytics.event('landing', { qa: false, browserId: 'a'.repeat(32), runId: 'spoofed' });
  await until(() => !analytics.writing && !analytics.queue.length);
  assert.equal(analytics.records()[0].qa, true);
  assert.notEqual(analytics.records()[0].runId, 'spoofed');
  assert.equal(analytics.summary().anonymousBrowsers, 0);
});

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`), messages = [];
  ws.onmessage = (e) => messages.push(JSON.parse(e.data));
  return { ws, open: new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }), send: (m) => ws.send(JSON.stringify(m)), wait: (fn) => until(() => messages.find(fn)) };
}

test('real isolated HTTP transport alerts only private/public starts; public consent reaches game analytics', async () => {
  const deliveries = [];
  const receiver = http.createServer((req, res) => { let body = ''; req.on('data', (part) => body += part); req.on('end', () => { deliveries.push({ path: req.url, body }); res.writeHead(200); res.end('{}'); }); });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const s = await start(0, { dataDir: tmp(), exportToken: 'test', qa: false, analyticsEnabled: true, alertsEnabled: true, ntfyBaseUrl: `http://127.0.0.1:${receiver.address().port}`, ntfyTopic: 'isolated_only', lobbyFirstMs: 20, sampleMs: 20 });
  const a = client(s.port), b = client(s.port), c = client(s.port), d = client(s.port);
  try {
    await Promise.all([a.open, b.open, c.open, d.open]);
    a.send({ t: 'create', name: 'Pat' });
    const joined = await a.wait((m) => m.t === 'joined');
    await pause(25); assert.equal(deliveries.length, 0);
    b.send({ t: 'join', code: joined.code, name: 'Sam' }); await b.wait((m) => m.t === 'joined');
    b.send({ t: 'start' }); await b.wait((m) => m.t === 'error'); assert.equal(deliveries.length, 0);
    a.send({ t: 'start' }); a.send({ t: 'start' });
    await until(() => deliveries.length === 1);
    c.send({ t: 'analytics', consent: true, browserId: 'c'.repeat(32), sessionId: 'd'.repeat(32) });
    c.send({ t: 'public', name: 'Consented' }); d.send({ t: 'public', name: 'NoConsent' });
    await until(() => deliveries.length === 2);
    await until(() => !s.analytics.writing && !s.analytics.queue.length);
    assert.match(deliveries[0].body, /private lobby started: 2 players, 5 rounds/);
    assert.match(deliveries[1].body, /automatic public lobby started: 2 players, 3 rounds/);
    for (const x of deliveries) { assert.equal(x.path, '/isolated_only'); assert.doesNotMatch(x.body, /Pat|Sam|Consented|NoConsent|browserId|country/); }
    const e = s.analytics.records().find((x) => x.type === 'gameStarted' && x.mode === 'public');
    assert.equal(e.participants.length, 1); assert.equal(e.participants[0].browserId, 'c'.repeat(32));
    assert.deepEqual(s.analytics.summary().modes.public.consentedConversion, { enteredBrowsers: 1, startedBrowsers: 1, percent: 100 });
    const response = await fetch(`http://127.0.0.1:${s.port}/admin/analytics.json`, { headers: { Authorization: 'Bearer test' } });
    const data = await response.json();
    assert.equal(data.health.ntfyConfigured, true); assert.equal(data.health.ntfy.sent, 2);
    assert.ok(data.operations.samples.length > 0); assert.ok(data.operations.samples[0].cpuPercent >= 0);
    assert.equal(data.health.hostCpuPercent, null);
    const page = await fetch(`http://127.0.0.1:${s.port}/admin/analytics`);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    const html = await page.text(); assert.doesNotMatch(html, /<script>/); assert.match(html, /src="\/admin\/dashboard.js"/);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/admin/dashboard.js`)).status, 200);
  } finally { for (const x of [a, b, c, d]) x.ws.close(); s.close(); await new Promise((resolve) => receiver.close(resolve)); }
});

test('QA runtime suppresses alerts even when configured and excludes isolated games/samples', async () => {
  let calls = 0;
  const s = await start(0, { dataDir: tmp(), qa: true, analyticsEnabled: true, alertsEnabled: true, ntfyBaseUrl: 'https://must-not-call.example', fetchImpl: async () => { calls++; return { ok: true }; }, sampleMs: 10 });
  try {
    const room = s.game.create(Date.now()), a = room.join('Pat', Date.now()).p, b = room.join('Sam', Date.now()).p;
    a.send = () => {}; b.send = () => {}; room.handle(a, { t: 'start' }, Date.now());
    await pause(40); await until(() => !s.analytics.writing && !s.analytics.queue.length);
    assert.equal(calls, 0); assert.equal(s.analytics.summary().modes.private.gamesStarted, 0); assert.equal(s.analytics.operations().samples.length, 0);
  } finally { s.close(); }
});

test('completed rounds count full rotations, not current partially played rotation', () => {
  const events = [], game = new Game({ analytics: { event: (type, props) => events.push({ type, ...props }) } });
  const room = game.create(1), a = room.join('Pat', 1).p, b = room.join('Sam', 1).p;
  a.send = () => {}; b.send = () => {}; room.handle(a, { t: 'start' }, 2);
  room.abort(3);
  assert.equal(events.find((e) => e.type === 'gameAbandoned').completedRounds, 0);
  room.endRound(4, 'time up'); room.nextRound(5); room.endRound(6, 'time up');
  assert.equal(room.completedRotations, 1);
  room.nextRound(7); room.abort(8);
  assert.equal(events.filter((e) => e.type === 'gameAbandoned').at(-1).completedRounds, 1);
  room.ctx.history.close();
});
