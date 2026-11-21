import { env, runInDurableObject } from 'cloudflare:test';
import { test, expect } from 'vitest';
import { get, bearer, client, stubOf, sleep } from './helpers.js';

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
