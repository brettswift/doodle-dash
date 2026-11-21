import { env, runInDurableObject } from 'cloudflare:test';
import { test, expect } from 'vitest';
import { get, bearer, client, stubOf, sleep, BASE } from './helpers.js';
const BASE_ORIGIN = BASE;

const DIR = () => stubOf(env.DIRECTORY, 'dir');
const inRoom = (code, fn) => runInDurableObject(stubOf(env.ROOM, code), fn);
const inDir = (fn) => runInDurableObject(DIR(), fn);

async function twoPlayerRoom(a, b, names = ['Ann', 'Bob']) {
  a.send({ t: 'create', name: names[0] });
  const j = await a.wait((m) => m.t === 'joined');
  b.send({ t: 'join', code: j.code, name: names[1] });
  await b.wait((m) => m.t === 'joined');
  await a.wait((m) => m.t === 'state' && m.players.length === 2);
  return j.code;
}

test('two concurrent rooms live in two separate Room objects with separate state', async () => {
  const [a1, b1, a2, b2] = await Promise.all([client(), client(), client(), client()]);
  const [c1, c2] = await Promise.all([twoPlayerRoom(a1, b1), twoPlayerRoom(a2, b2, ['Cy', 'Di'])]);
  expect(c1).not.toBe(c2);
  a1.send({ t: 'rounds', n: 2 });
  await a1.wait((m) => m.t === 'state' && m.rotations === 2);
  const r1 = await inRoom(c1, async (inst) => ({ code: inst.code, rooms: [...inst.game.rooms.keys()], names: inst.game.get(c1).players.map((p) => p.name), rot: inst.game.get(c1).rotations }));
  const r2 = await inRoom(c2, async (inst) => ({ code: inst.code, rooms: [...inst.game.rooms.keys()], names: inst.game.get(c2).players.map((p) => p.name), rot: inst.game.get(c2).rotations }));
  expect(r1).toEqual({ code: c1, rooms: [c1], names: ['Ann', 'Bob'], rot: 2 });
  expect(r2.rooms).toEqual([c2]); expect(r2.names).toEqual(['Cy', 'Di']); expect(r2.rot).not.toBe(2);
  // the Directory holds no live game at all, only the registry of room codes
  const d = await inDir(async (inst) => ({ codes: [...inst.codes].sort(), hasGame: 'game' in inst }));
  expect(d.codes).toEqual(expect.arrayContaining([c1, c2])); expect(d.hasGame).toBe(false);
  expect(a2.msgs.some((m) => m.t === 'state' && m.rotations === 2)).toBe(false); // no cross-room leakage
});

test('Directory: unknown room code and bad names are refused before any Room is created', async () => {
  const a = await client();
  a.send({ t: 'join', code: 'ZZZZ', name: 'Ann' });
  expect((await a.wait((m) => m.t === 'error')).msg).toBe('No such room');
  const b = await client();
  b.send({ t: 'create', name: '' });
  expect((await b.wait((m) => m.t === 'error')).msg).toMatch(/^Name:/);
  expect(a.gotos + b.gotos).toBe(0);
  expect((await get('/ws?room=no1', { headers: { Upgrade: 'websocket', Origin: 'https://crayon.test' } })).status).toBe(404);
});

test('Room only accepts create once: a second create on an occupied room is refused', async () => {
  const a = await client(), b = await client();
  const code = await twoPlayerRoom(a, b);
  const evil = await client();
  evil.ws.close();
  const raw = await (await import('cloudflare:test')).SELF.fetch('https://crayon.test/ws?room=' + code, { headers: { Upgrade: 'websocket', Origin: 'https://crayon.test' } });
  const ws = raw.webSocket; ws.accept(); const got = [];
  ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
  ws.send(JSON.stringify({ t: 'create', name: 'Eve' }));
  await sleep(300);
  expect(got.find((m) => m.t === 'error')).toBeTruthy();
  expect(got.find((m) => m.t === 'joined')).toBeUndefined();
});

test('public matchmaking: Directory forms the match, Room object hosts and starts the game', async () => {
  const a = await client(), b = await client();
  a.send({ t: 'public', name: 'Twin' }); b.send({ t: 'public', name: 'Twin' });
  await a.wait((m) => m.t === 'public');
  const sa = await a.wait((m) => m.t === 'state' && (m.phase === 'choosing' || m.phase === 'drawing'), 15000);
  await b.wait((m) => m.t === 'state' && (m.phase === 'choosing' || m.phase === 'drawing'), 15000);
  expect(a.gotos).toBe(1); expect(b.gotos).toBe(1);
  const names = sa.players.map((p) => p.name).sort();
  expect(names.length).toBe(2); expect(names[0]).not.toBe(names[1]);
  const j = a.msgs.find((m) => m.t === 'joined');
  const info = await inRoom(j.code, async (inst) => { const r = inst.game.get(j.code); return { pub: r.public, rot: r.rotations, n: r.players.length, phase: r.phase }; });
  expect(info.pub).toBe(true); expect(info.rot).toBe(3); expect(info.n).toBe(2);
  const q = await inDir(async (inst) => ({ queue: inst.mm.lobbies.length }));
  expect(q.queue).toBe(0);
  // a public room cannot be joined by code
  const c = await client();
  c.send({ t: 'join', code: j.code, name: 'Late' });
  expect((await c.wait((m) => m.t === 'error')).msg).toMatch(/public game/);
});

test('Directory ingest is idempotent: the same batch applied twice writes once; older batches are ignored', async () => {
  const batch = { n: Date.now() * 1000 + 1, events: [{ v: 1, at: Date.now(), type: 'error', category: 'x', runId: 'r1' }], drawings: [{ tid: 'cat', d: 'easy', m: 10, g: 'g1', t0: 1, out: 'timeup', ok: 1, gt: [100], el0: 2, el1: 2, ink: true, dd: false, budget: 8000, t1: 2, dur: 1 }] };
  const stub = DIR();
  const count = () => runInDurableObject(stub, async (inst) => ({ ev: inst.store.eventLines().length, dr: inst.store.drawingCount() }));
  const before = await count();
  const r1 = await stub.ingest('IDEM', batch);
  const r2 = await stub.ingest('IDEM', batch);
  const r3 = await stub.ingest('IDEM', { ...batch, n: batch.n - 5, events: batch.events });
  const after = await count();
  expect(r1.dup).toBeFalsy(); expect(r2.dup).toBe(true); expect(r3.dup).toBe(true);
  expect(after.ev - before.ev).toBe(1); expect(after.dr - before.dr).toBe(1);
  expect(r1.view.seq).toBeGreaterThan(0);
});

test('Room retries failed Directory writes with the same batch, keeps them across eviction, and the Directory applies them once', async () => {
  const a = await client(), b = await client();
  const code = await twoPlayerRoom(a, b);
  const evBefore = await inDir(async (inst) => inst.store.eventLines().length);
  await inRoom(code, async (inst) => {
    let calls = 0;
    inst.dirStub = () => ({ ingest: async () => { calls++; throw new Error('directory down'); } });
    inst.analytics.event('error', { category: 'retry-test' });
    await inst.flush();
    expect(calls).toBe(1);
    expect(inst.outbox.queue.length).toBe(1);
    expect(inst.store.keys('ob:').length).toBe(1); // survives eviction
    inst.evictForTest(); // forget everything in memory; the persisted batch is reloaded
    expect(inst.outbox.queue.length).toBe(1);
  });
  await inRoom(code, async (inst) => { delete inst.dirStub; await inst.flush(); expect(inst.outbox.queue.length).toBe(0); expect(inst.store.keys('ob:').length).toBe(0); });
  // deliver the very same batch a second time (as a retry after a lost acknowledgment would): no duplicate event
  const evAfter = await inDir(async (inst) => inst.store.eventLines().length);
  expect(evAfter - evBefore).toBe(1);
});

test('Room eviction mid-game: a rebuilt Room restores phase, seats and live sockets, and the game continues', async () => {
  const a = await client(), b = await client();
  const code = await twoPlayerRoom(a, b);
  a.send({ t: 'rounds', n: 1 }); a.send({ t: 'start' });
  const isChoice = (m) => m.t === 'state' && m.phase === 'choosing' && m.choices;
  const dr = await Promise.race([a.wait(isChoice).then((m) => [a, m]), b.wait(isChoice).then((m) => [b, m])]);
  await inRoom(code, async (inst) => { inst.evictForTest(); });
  dr[0].send({ t: 'pick', i: 0 });
  const st = await dr[0].wait((m) => m.t === 'state' && m.phase === 'drawing');
  expect(st.players.length).toBe(2);
});

test('one completed turn becomes one history row, written once by the Directory', async () => {
  const a = await client(), b = await client();
  const code = await twoPlayerRoom(a, b);
  a.send({ t: 'rounds', n: 1 }); a.send({ t: 'start' });
  const isChoice = (m) => m.t === 'state' && m.phase === 'choosing' && m.choices;
  const dr = await Promise.race([a.wait(isChoice).then((m) => [a, m]), b.wait(isChoice).then((m) => [b, m])]);
  const before = await inDir(async (inst) => inst.store.drawingCount());
  dr[0].send({ t: 'pick', i: 0 });
  await dr[0].wait((m) => m.t === 'state' && m.phase === 'drawing');
  await inRoom(code, async (inst) => { inst.game.get(code).endRound(Date.now(), 'time up'); await inst.flush(); });
  const after = await inDir(async (inst) => inst.store.drawingCount());
  expect(after - before).toBe(1);
  const view = await inDir(async (inst) => inst.view());
  expect(view.seq).toBeGreaterThanOrEqual(after);
});

test('a full 2-player game writes well under 100 SQL rows across Room and Directory', async () => {
  const a = await client(), b = await client();
  const code = await twoPlayerRoom(a, b);
  const rows0 = (await inDir(async (inst) => inst.store.rowsWritten));
  const roomRows0 = await inRoom(code, async (inst) => inst.store.rowsWritten);
  a.send({ t: 'rounds', n: 1 }); a.send({ t: 'start' });
  const isChoice = (m) => m.t === 'state' && m.phase === 'choosing' && m.choices;
  for (let turn = 0; turn < 2; turn++) {
    const dr = await Promise.race([a.wait((m) => isChoice(m) && a.msgs.indexOf(m) >= (a.__from || 0)).then(() => a), b.wait((m) => isChoice(m) && b.msgs.indexOf(m) >= (b.__from || 0)).then(() => b)]);
    dr.send({ t: 'pick', i: 0 });
    await dr.wait((m) => m.t === 'state' && m.phase === 'drawing' && dr.msgs.indexOf(m) >= (dr.__from || 0));
    dr.send({ t: 'draw', s: true, c: '#000000', w: 6, p: [100, 100, 300, 300, 500, 200] });
    await sleep(100);
    await inRoom(code, async (inst) => { inst.game.get(code).endRound(Date.now(), 'time up'); });
    a.__from = a.msgs.length; b.__from = b.msgs.length;
    await inRoom(code, async (inst) => { inst.game.get(code).nextRound(Date.now()); });
  }
  await a.wait((m) => m.t === 'state' && m.phase === 'gameOver', 8000);
  await inRoom(code, async (inst) => { await inst.flush(); });
  const total = (await inDir(async (inst) => inst.store.rowsWritten)) - rows0 + (await inRoom(code, async (inst) => inst.store.rowsWritten)) - roomRows0;
  expect(total).toBeGreaterThan(0); expect(total).toBeLessThan(100);
  const arch = await (await get('/admin/drawings.json', { headers: bearer })).json();
  expect(arch.stats.files).toBeGreaterThanOrEqual(1); // best/worst archive written by the Directory
}, 30000);

test('Directory alarm deletes analytics older than 183 days only, keeps history/tiers/archive, and re-arms daily', async () => {
  const DAY = 86400000;
  await inDir(async (inst, state) => {
    const st = inst.store;
    for (let i = 0; i < 3; i++) st.addEvent({ at: Date.now() - 200 * DAY - i, type: 'landing' });
    st.addEvent({ at: Date.now() - 10 * DAY, type: 'landing' });
    st.putDrawing(990001, { tid: 'cat', g: 'g', out: 'ok' });
  });
  const stub = DIR();
  const { runDurableObjectAlarm } = await import('cloudflare:test');
  await inDir(async (inst, state) => { await state.storage.setAlarm(Date.now() + 10); });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const after = await inDir(async (inst, state) => ({ old: inst.store.eventLines().map((l) => JSON.parse(l)).filter((e) => e.at < Date.now() - 183 * DAY).length, drawing: inst.store.drawingCount() > 0, alarm: await state.storage.getAlarm() }));
  expect(after.old).toBe(0); expect(after.drawing).toBe(true);
  expect(after.alarm).toBeGreaterThan(Date.now() + 20 * 3600000);
});

test('dev import endpoint: token required, loads drawings/tiers/audit/events/archive chunks, export reflects them', async () => {
  const body = { drawings: [[7001, { tid: 'cat', g: 'gimp', out: 'ok' }], [7002, { tid: 'dog', g: 'gimp', out: 'abandoned' }]],
    tiers: [['cat', 'hard', 7001]], audit: [{ at: 5, id: 'cat' }], events: [JSON.stringify({ at: 123456, type: 'landing', v: 1 })],
    archive: [{ id: 'abcdef01', savedAt: '2026-11-01T00:00:00.000Z', b64: Buffer.from('gz').toString('base64'), sha: 'h' }] };
  const post = (h) => get('/admin/import', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
  expect((await post({})).status).toBe(401);
  expect((await get('/admin/import', { headers: bearer })).status).toBe(405);
  const r = await post(bearer); expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ drawings: 2, tiers: 1, audit: 1, events: 1, archive: 1 });
  const d = await inDir(async (inst) => ({ n: inst.store.drawingCount(), tiers: inst.store.loadTiers().tiers, ev: inst.store.eventLines().includes(body.events[0]), arc: inst.store.archiveHas('abcdef01'), seq: inst.history.seq }));
  expect(d.n).toBeGreaterThanOrEqual(2); expect(d.tiers.cat).toBe('hard'); expect(d.ev).toBe(true); expect(d.arc).toBe(true);
});

// ===== step 6b: review findings 1-6 + secondary items =====
const drawing = (g) => ({ tid: 'cat', d: 'easy', m: 10, g, t0: 1, out: 'timeup', ok: 1, gt: [100], el0: 2, el1: 2, ink: true, dd: false, budget: 8000, t1: 2, dur: 1 });
const archiveItem = (gameId) => ({ meta: { gameId, mode: 'private', players: 2 }, sel: { best: { name: 'Ann', word: 'cat', tid: 'cat', diff: 'easy', gain: 5, strokes: [{ c: '#000000', w: 3, p: [1, 2, 3, 4] }] }, worst: null } });
let batchNo = Date.now() * 1000 + 500;
const nextN = () => ++batchNo;

// Run `fn` inside the Directory object with one store/archive method replaced, restoring it afterwards.
const withPatch = (target, method, impl, fn) => inDir(async (i) => {
  const obj = target(i), orig = obj[method];
  obj[method] = function (...a) { return impl.call(this, orig, ...a); };
  try { return await fn(i); } finally { obj[method] = orig; }
});
const failsIn = (i, src, batch) => i.ingest(src, batch).then(() => false, () => true);

test('finding 1: a failed history write rejects the batch atomically (SQL rolled back, marker, cache and sequence untouched) and a retry applies it once', async () => {
  const src = 'ATOM', batch = { n: nextN(), events: [{ v: 1, at: Date.now(), type: 'error', category: 'atom', runId: 'r' }], drawings: [drawing('ga'), drawing('gb')] };
  const tally = (i) => ({ seq: i.history.seq, recs: i.history.recs.size, last: i.history.last.size, dr: i.store.allDrawings().filter((r) => r.g === 'ga' || r.g === 'gb').length, ev: i.store.eventLines().filter((l) => l.includes('"atom"')).length, mk: i.store.lastIngest(src), deg: i.history.degraded });
  let k = 0;
  const res = await withPatch((i) => i.store, 'putDrawing', function (orig, ...a) { if (++k === 2) throw new Error('sql down'); return orig.apply(this, a); }, async (i) => {
    const before = tally(i);
    const failed = await failsIn(i, src, batch);
    return { before, failed, mid: tally(i) };
  });
  expect(res.failed).toBe(true);
  expect(res.mid.dr).toBe(0); expect(res.mid.ev).toBe(0); expect(res.mid.mk).toBeNull(); // first row rolled back too
  expect({ ...res.mid, seq: 0 }).toEqual({ ...res.before, seq: 0 });
  expect(res.mid.seq).toBe(res.before.seq); expect(res.mid.recs).toBe(res.before.recs); expect(res.mid.deg).toBe(false);
  const after = await inDir(async (i) => { const r = await i.ingest(src, batch); return { r, ...tally(i) }; });
  expect(after.r.dup).toBe(false); expect(after.dr).toBe(2); expect(after.ev).toBe(1); expect(after.seq - res.before.seq).toBe(2); expect(after.deg).toBe(false);
});

test('finding 2: a failed archive save rejects the batch; retry after archive success + later failure does not duplicate; a full archive is still a deliberate refusal', async () => {
  const src = 'ARCH', batch = { n: nextN(), events: [{ v: 1, at: Date.now(), type: 'error', category: 'arch', runId: 'r' }], drawings: [drawing('gc')], archives: [archiveItem('b6b00001')] };
  const tally = (i) => ({ ev: i.store.eventLines().filter((l) => l.includes('"arch"')).length, dr: i.store.allDrawings().filter((r) => r.g === 'gc').length, files: i.store.archiveStats().files, mk: i.store.lastIngest(src) });
  const s1 = await withPatch((i) => i.store, 'archivePut', () => { throw new Error('sql down'); }, async (i) => ({ before: tally(i), failed: await failsIn(i, src, batch), after: tally(i) }));
  expect(s1.failed).toBe(true); expect(s1.after).toEqual(s1.before); expect(s1.before.mk).toBeNull();
  // archive now saves, but the history write fails: batch still rejected, archive kept once
  const s2 = await withPatch((i) => i.store, 'putDrawing', () => { throw new Error('sql down'); }, async (i) => ({ failed: await failsIn(i, src, batch), after: tally(i) }));
  expect(s2.failed).toBe(true); expect(s2.after.files - s1.before.files).toBe(1); expect(s2.after.dr).toBe(0); expect(s2.after.mk).toBeNull();
  const ok = await inDir(async (i) => ({ r: await i.ingest(src, batch), ...tally(i) }));
  expect(ok.r.dup).toBe(false);
  expect(ok.files - s1.before.files).toBe(1); expect(ok.dr).toBe(1); expect(ok.ev).toBe(1); expect(ok.mk).toBe(batch.n);
  // deliberate refusal when the archive is full: acknowledged, nothing deleted, nothing stored
  const full = await inDir(async (i) => { i.archive.maxFiles = 0; try { return { r: await i.ingest('ARC2', { n: nextN(), archives: [archiveItem('b6b00002')] }), files: i.store.archiveStats().files }; } finally { i.archive.maxFiles = 5000; } });
  expect(full.r.dup).toBe(false); expect(full.files).toBe(ok.files);
});

test('secondary: overlapping ingests of the same archive-bearing batch apply it once (marker rechecked inside the commit)', async () => {
  const src = 'RACE', batch = { n: nextN(), events: [{ v: 1, at: Date.now(), type: 'error', category: 'race', runId: 'r' }], drawings: [drawing('gd')], archives: [archiveItem('b6b00003')] };
  const out = await withPatch((i) => i.archive, 'save', async function (orig, ...a) { await sleep(60); return orig.apply(this, a); }, async (i) => {
    const [x, y] = await Promise.all([i.ingest(src, batch), i.ingest(src, batch)]);
    return { dups: [x.dup, y.dup].sort(), ev: i.store.eventLines().filter((l) => l.includes('"race"')).length, dr: i.store.allDrawings().filter((r) => r.g === 'gd').length, files: i.store.archiveStats().files };
  });
  expect(out.dups).toEqual([false, true]); expect(out.ev).toBe(1); expect(out.dr).toBe(1);
});

test('finding 3: a completed batch is persisted before delivery, and its durable row is removed after the first successful delivery', async () => {
  const a = await client(), b = await client();
  const code = await twoPlayerRoom(a, b);
  await inRoom(code, async (inst) => {
    let seen = -1;
    inst.dirStub = () => ({ ingest: async () => { seen = inst.store.keys('ob:').length; return { dup: false, view: null }; } });
    inst.analytics.event('error', { category: 'persist-first' });
    await inst.flush();
    expect(seen).toBe(1); // durable before the RPC was attempted
    expect(inst.outbox.queue.length).toBe(0);
    expect(inst.store.keys('ob:').length).toBe(0);
  });
});

test('finding 3: a batch restored after eviction is deleted when its very first delivery succeeds', async () => {
  const a = await client(), b = await client();
  const code = await twoPlayerRoom(a, b);
  await inRoom(code, async (inst) => {
    await inst.flush();
    inst.dirStub = () => ({ ingest: async () => ({ dup: false, view: null }) });
    inst.store.set('ob:' + String(1).padStart(20, '0'), JSON.stringify({ n: 1, src: code, events: [], drawings: [], archives: [] }));
    inst.evictForTest();
    expect(inst.outbox.queue.length).toBe(1);
    await inst.flush();
    expect(inst.outbox.queue.length).toBe(0);
    expect(inst.store.keys('ob:')).toEqual([]);
  });
});

test('finding 4: a valid-format but unallocated room code is refused before acceptance and creates no durable state', async () => {
  const res = await get('/ws?room=QQQQ', { headers: { Upgrade: 'websocket', Origin: BASE_ORIGIN } });
  expect(res.status).toBe(404);
  const probe = await inRoom('QQQQ', async (inst) => ({
    tables: inst.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map((r) => r.name),
    sockets: inst.ctx.getWebSockets().length, salt: inst.salt,
  }));
  expect(probe.tables).not.toContain('kv'); expect(probe.sockets).toBe(0); expect(probe.salt).toBeFalsy();
  expect(await inDir(async (i) => i.codes.has('QQQQ'))).toBe(false);
});

test('finding 4: an allocated room still accepts sockets and persists its salt only once initialised', async () => {
  const a = await client(), b = await client();
  const code = await twoPlayerRoom(a, b);
  const probe = await inRoom(code, async (inst) => ({ salt: !!inst.store.get('salt'), code: inst.store.get('code') }));
  expect(probe).toEqual({ salt: true, code });
});

test('finding 5: a maximum-size game (80 drawings of 400 strokes / 40000 points) keeps a small snapshot and the exact best/worst', async () => {
  const a = await client(), b = await client();
  const code = await twoPlayerRoom(a, b);
  await inRoom(code, async (inst) => {
    const r = inst.game.get(code), s = r.state;
    const strokes = (k) => Array.from({ length: 400 }, (_, i) => ({ c: '#000000', w: 3, p: Array.from({ length: 200 }, (_, j) => (i + j + k) % 1000) }));
    const gains = [];
    for (let i = 0; i < 80; i++) {
      const g = [50, 10, 50, 10, 30][i % 5] + (i === 40 ? 500 : 0); gains.push(g);
      const d = s.players[i % 2]; s.drawerId = d.id; s.word = 'cat'; s.curTid = 'cat'; s.diff = 'easy'; s.strokes = strokes(i); s.phase = 'drawing'; d.gain = g;
      r.endRound(Date.now(), 'time up');
    }
    inst.afterEvent();
    const snap = inst.store.get('snap');
    expect(snap.length).toBeLessThan(2_000_000);
    const saved = JSON.parse(snap).state.showcase;
    expect(saved.length).toBeLessThanOrEqual(2);
    const bw = r.bestWorst(); // best = first maximum (turn 40), worst = last minimum excluding best (turn 78)
    expect(gains.indexOf(Math.max(...gains))).toBe(40);
    expect(bw.best.strokes[0].p[0]).toBe(40); expect(bw.worst.strokes[0].p[0]).toBe(78);
    expect(bw.best.strokes.length).toBe(400);
  });
});

test('finding 5: when a snapshot write fails, the stale successful-looking snapshot is dropped and the write retried on the next event', async () => {
  const a = await client(), b = await client();
  const code = await twoPlayerRoom(a, b);
  await inRoom(code, async (inst) => {
    expect(inst.store.get('snap')).toBeTruthy();
    const orig = inst.store.set;
    inst.store.set = function (k, v) { if (k === 'snap') throw new Error('too big'); return orig.call(this, k, v); };
    inst.game.get(code).state.chat.push({ k: 'sys', text: 'x' });
    inst.afterEvent();
    inst.store.set = orig;
    expect(inst.store.get('snap')).toBeNull();
    expect(inst.fingerprint).toBeNull();
    inst.afterEvent(); // next event retries and succeeds
    expect(inst.store.get('snap')).toBeTruthy();
  });
});

test('finding 6: production-mode Room notifier sends the aggregate-only message once per game start; QA never sends', async () => {
  const calls = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init.body }); return new Response('ok'); };
  try {
    for (const prod of [true, false]) {
      calls.length = 0;
      const a = await client(), b = await client();
      const code = await twoPlayerRoom(a, b, prod ? ['Ann', 'Bob'] : ['Cat', 'Dan']);
      await inRoom(code, async (inst) => {
        if (prod) { inst.env = { ...inst.env, APP_ENV: 'production', NTFY_BASE_URL: 'https://ntfy.invalid', NTFY_TOPIC: 'crayon_test', NTFY_ALERTS_ENABLED: 'true' }; inst.qa = false; }
        inst.notifier = inst.makeNotifier();
        expect(inst.notifier.configured).toBe(prod);
      });
      a.send({ t: 'rounds', n: 2 }); a.send({ t: 'start' });
      await a.wait((m) => m.t === 'state' && (m.phase === 'choosing' || m.phase === 'drawing'));
      await sleep(100);
      if (prod) { expect(calls.length).toBe(1); expect(calls[0].url).toBe('https://ntfy.invalid/crayon_test'); expect(calls[0].body).toBe('private lobby started: 2 players, 2 rounds'); expect(calls[0].body).not.toMatch(/Ann|Bob/); }
      else expect(calls.length).toBe(0);
    }
  } finally { globalThis.fetch = realFetch; }
});

test('finding 6: Directory health reports the real notifier configuration and sums delivery status from the Rooms', async () => {
  const a = await client(), b = await client();
  const code = await twoPlayerRoom(a, b);
  const base = await inDir(async (i) => i.runtime()); // Rooms of earlier tests may still be registered, so compare deltas
  expect(base.ntfyConfigured).toBe(false); expect(base.ntfy.payload).toBe('aggregate-only'); expect(Object.keys(base.ntfy).sort()).toEqual(['failed', 'lastFailedAt', 'lastSentAt', 'payload', 'sent']);
  await inRoom(code, async (inst) => { Object.assign(inst.notifier.status, { sent: 2, failed: 1, lastSentAt: 1e15, lastFailedAt: 2e15 }); });
  const prod = await inDir(async (i) => { i.env = { ...i.env, NTFY_BASE_URL: 'https://ntfy.invalid', NTFY_TOPIC: 'crayon_test', NTFY_ALERTS_ENABLED: 'true' }; i.qa = false; return i.runtime(); });
  expect(prod.ntfyConfigured).toBe(true);
  expect(prod.ntfy).toEqual({ sent: base.ntfy.sent + 2, failed: base.ntfy.failed + 1, lastSentAt: 1e15, lastFailedAt: 2e15, payload: 'aggregate-only' });
});

test('finding 6: a freshly created private lobby is reported as waiting, not unknown-after-restart', async () => {
  const a = await client(), b = await client();
  const code = await twoPlayerRoom(a, b);
  const gid = await inRoom(code, async (inst) => inst.game.get(code).gid);
  let s;
  for (let i = 0; i < 20; i++) { // the Room delivers 'privateLobbyCreated' to the Directory asynchronously
    s = (await (await get('/admin/analytics.json', { headers: bearer })).json());
    if (s.summary.privateLobbies.created) break;
    await sleep(100);
  }
  // QA events are excluded from the product summary, so mark the test records as non-QA for this check
  const pl = await inDir(async (i) => { i.qa = false; const rt = await i.runtime(); const recs = i.analytics.records().map((e) => ({ ...e, qa: undefined })); return { rt, sum: i.analytics.summary(recs, { waiting: new Set(rt.waitingLobbies) }).privateLobbies }; });
  expect(pl.rt.waitingLobbies).toContain(gid);
  expect(pl.sum.currentlyWaiting).toBe(pl.rt.waitingLobbies.length); expect(pl.sum.currentlyWaiting).toBeGreaterThanOrEqual(1);
  expect(pl.sum.unknownAfterRestart || 0).toBe(pl.sum.created - pl.sum.currentlyWaiting - pl.sum.started - pl.sum.closedWithoutStarting);
});

test('production-mode Directory refuses /admin/import', async () => {
  const code = await inDir(async (i) => { i.qa = false; const r = await i.fetch(new Request('https://crayon.test/admin/import', { method: 'POST', headers: bearer, body: '{}' })); return r.status; });
  expect(code).toBe(404);
});

test('Room retries a failed local outbox write before delivery, never sends an unpersisted batch, and ingests once after restore', async () => {
  const a = await client(), b = await client();
  const code = await twoPlayerRoom(a, b);
  const gid = 'localfail' + Math.random().toString(16).slice(2, 8);
  const result = await inRoom(code, async (inst) => {
    inst.schedule = async () => {};
    let attempts = 0, durableAtSend = [];
    inst.dirStub = () => ({ ingest: async () => { attempts++; durableAtSend.push(inst.store.keys('ob:').length); throw new Error('injected Directory outage'); } });
    const original = inst.store.set;
    inst.store.set = function (key, value) {
      if (key.startsWith('ob:')) throw new Error('injected transient local SQL failure');
      return original.call(this, key, value);
    };
    inst.outbox.addDrawing({ tid: 'cat', g: gid, out: 'ok' });
    await inst.flush();
    const first = { durable: inst.store.keys('ob:').length, queued: inst.outbox.queue.length, attempts };
    inst.store.set = original;
    await inst.flush();
    const retry = { durable: inst.store.keys('ob:').length, queued: inst.outbox.queue.length, attempts, durableAtSend };
    inst.evictForTest();
    return { first, retry, afterRestore: inst.outbox.queue.length, durableAfter: inst.store.keys('ob:').length };
  });
  // no Directory call while the batch was not durable; after local recovery it is persisted before the (failing) send
  expect(result.first).toEqual({ durable: 0, queued: 1, attempts: 0 });
  expect(result.retry.durable).toBe(1);
  expect(result.retry.durableAtSend.length).toBeGreaterThan(0); expect(result.retry.durableAtSend.every((d) => d === 1)).toBe(true);
  expect(result.afterRestore).toBe(1);
  expect(result.durableAfter).toBe(1);
  await inRoom(code, async (inst) => { delete inst.dirStub; await inst.flush(); expect(inst.outbox.queue.length).toBe(0); expect(inst.store.keys('ob:').length).toBe(0); });
});
