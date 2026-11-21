'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../server');

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dd-analytics-'));
test('analytics dashboard requires export token and exposes only consent-based local records', async () => {
  const dir = tmp();
  const s = await start(0, { dataDir: dir, exportToken: 'token', analyticsEnabled: true, qa: false });
  const base = `http://127.0.0.1:${s.port}`;
  try {
    s.analytics.event('nameEntered', { browserId: 'a'.repeat(32), sessionId: 'b'.repeat(32), name: 'Pat', country: 'CA', region: 'AB' });
    s.analytics.event('gameStarted', { gameId: 'g1', mode: 'private', configuredRounds: 5, participants: [{ browserId: 'a'.repeat(32), sessionId: 'b'.repeat(32), name: 'Pat', country: 'CA', region: 'AB' }] });
    s.analytics.event('gameEnded', { gameId: 'g1', mode: 'private', completedRounds: 5, drawingTurns: 10 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await fetch(base + '/admin/analytics.json')).status, 401);
    const r = await fetch(base + '/admin/analytics.json', { headers: { authorization: 'Bearer token' } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.summary.modes.private.gamesStarted, 1);
    assert.equal(body.summary.modes.private.completedRounds.distribution['5'], 1);
    assert.deepEqual(body.summary.names[0].regions, ['CA-AB']);
    assert.equal((await fetch(base + '/privacy')).status, 200);
  } finally { s.close(); }
});

test('no checkbox; client always sends existing analytics fields; privacy states them', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const priv = fs.readFileSync(path.join(__dirname, '../public/privacy.html'), 'utf8');
  assert.ok(!/analyticsConsent|type="checkbox"/.test(html));
  assert.ok(!/analyticsConsent|crayon-breath-analytics-consent|consent:/.test(js));
  assert.ok(/t: 'analytics'.*browserId.*sessionId.*timezone.*language/.test(js));
  assert.ok(!/If you opt in|Optional analytics/.test(priv));
  assert.ok(/browser identifier/.test(priv) && /timezone/.test(priv) && /not anonymous/.test(priv));
});

test('native ws clients: gameStarted lists usernames once; legacy consent flag irrelevant; web client ids kept', async () => {
  const dir = tmp();
  Object.assign(process.env, { CHOOSE_MS: '800', DRAW_MS: '1500', RESULT_MS: '300' });
  const s = await start(0, { dataDir: dir, analyticsEnabled: true, qa: false });
  const open = async () => { const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`); const msgs = []; ws.onmessage = (e) => msgs.push(JSON.parse(e.data)); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return { ws, msgs }; };
  const wait = async (f) => { for (let i = 0; i < 100; i++) { const x = f(); if (x) return x; await new Promise((r) => setTimeout(r, 30)); } throw new Error('timeout'); };
  try {
    const a = await open(), b = await open();
    a.ws.send(JSON.stringify({ t: 'analytics', consent: false, browserId: 'c'.repeat(32), sessionId: 'd'.repeat(32), timezone: 'America/Edmonton', language: 'en-CA' }));
    a.ws.send(JSON.stringify({ t: 'create', name: 'TestAnn' }));
    const j = await wait(() => a.msgs.find((m) => m.t === 'joined'));
    b.ws.send(JSON.stringify({ t: 'join', code: j.code, name: 'TestBob' })); // native client: no analytics message
    await wait(() => b.msgs.find((m) => m.t === 'joined'));
    a.ws.send(JSON.stringify({ t: 'start' }));
    const rec = () => s.analytics.records().filter((e) => e.type === 'gameStarted');
    await wait(() => rec().length);
    assert.equal(rec().length, 1);
    const ps = rec()[0].participants, ann = ps.find((p) => p.name === 'TestAnn'), bob = ps.find((p) => p.name === 'TestBob');
    assert.equal(ps.length, 2);
    assert.equal(ann.browserId, 'c'.repeat(32)); assert.equal(ann.timezone, 'America/Edmonton'); assert.equal(ann.language, 'en-CA');
    assert.ok(bob.sessionId && !bob.browserId);
    assert.equal(s.analytics.records().filter((e) => e.type === 'landing').length, 1);
    a.ws.close(); b.ws.close();
  } finally { s.close(); }
});

test('analytics retention: cleanup removes only analytics older than 183 days at a fixed clock, in batches', () => {
  const { Store } = require('../store');
  const { Analytics, RETENTION_DAYS } = require('../analytics');
  assert.equal(RETENTION_DAYS, 183);
  const store = new Store(':memory:'); const DAY = 86400000, now = 1800000000000;
  const a = new Analytics({ store });
  for (let i = 0; i < 5; i++) store.addEvent({ at: now - 184 * DAY - i, type: 'landing' });
  store.addEvent({ at: now - 183 * DAY + 1000, type: 'landing' });   // just inside
  store.addEvent({ at: now - 1000, type: 'landing' });
  store.putDrawing(1, { tid: 't', g: 'g', out: 'ok' });
  assert.equal(a.cleanup(now, 3), 3);          // one batch
  assert.equal(a.cleanup(now, 3), 2);          // rest, fewer than limit => done
  assert.equal(store.eventLines().length, 2);
  assert.equal(store.drawingCount(), 1);
});

test('server runs analytics retention cleanup at startup', async () => {
  const { Store } = require('../store');
  const dir = tmp(); const st = new Store(path.join(dir, 'doodle.sqlite'));
  st.addEvent({ at: Date.now() - 200 * 86400000, type: 'landing' }); st.addEvent({ at: Date.now(), type: 'landing' }); st.close();
  const s = await start(0, { dataDir: dir, exportToken: 't', analyticsEnabled: true, qa: true, sampleMs: 3600000 });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const lines = s.analytics.store.eventLines();
    assert.equal(lines.filter((l) => JSON.parse(l).at < Date.now() - 183 * 86400000).length, 0);
    assert.ok(lines.length >= 1);
  } finally { s.close(); }
});

test('privacy page states analytics is kept 6 months', () => {
  const priv = fs.readFileSync(path.join(__dirname, '../public/privacy.html'), 'utf8');
  assert.ok(/6 months/.test(priv));
  assert.ok(!/up to 90 days/.test(priv));
});

test('private lobby status can come from an explicit live-lobby set instead of the process run id', () => {
  const { Analytics } = require('../analytics');
  const mem = []; const store = { addEvent: (e) => mem.push(e), events: () => mem, eventBytes: () => 0 };
  const a = new Analytics({ store, enabled: true, qa: false, log: () => {} });
  mem.push({ v: 1, at: Date.now(), type: 'privateLobbyCreated', lobbyId: 'L1', runId: 'some-other-object' });
  mem.push({ v: 1, at: Date.now(), type: 'privateLobbyCreated', lobbyId: 'L2', runId: 'some-other-object' });
  const plain = a.summary(a.records()).privateLobbies;
  assert.equal(plain.unknownAfterRestart, 2, 'without a live set the Node run id rule applies');
  const live = a.summary(a.records(), { waiting: new Set(['L1']) }).privateLobbies;
  assert.equal(live.currentlyWaiting, 1);
  assert.equal(live.unknownAfterRestart, 1);
});
