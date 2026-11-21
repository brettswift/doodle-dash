'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Game } = require('../game');
const { Archive } = require('../archive');
const { start } = require('../server');

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dd-arc-'));
// Drive a Room directly with fake players; turns: [{gain, strokes}] drawn by successive players.
function room(dataDir, opts = {}) {
  const g = new Game({ dataDir, log: () => {}, ...opts });
  const r = g.create(0); r.public = false;
  for (const n of ['A', 'B', 'C']) { const { p } = r.join(n, 0); p.send = () => {}; }
  return { g, r };
}
function play(r, turns) {
  r.rotations = 1; r.handle(r.players[0], { t: 'start' }, 0);
  let now = 0;
  for (const t of turns) {
    const d = r.drawer(); r.handle(d, { t: 'pick', i: 0 }, now);
    for (const s of t.strokes || []) r.handle(d, { t: 'draw', s: true, c: s.c, w: s.w, p: s.p }, now);
    if (t.gain != null) d.gain = t.gain;
    r.endRound(now, 'time up'); now += 10000; r.tick(now + 1e6 > now ? now : now); r.phase === 'roundEnd' && r.nextRound(now);
  }
}
const ink = (x) => [{ c: '#e63946', w: 5, p: [x, 10, x + 50, 900] }];

test('exact shown best/worst persisted, copy not mutated by reset', async () => {
  const dir = tmp(); const { r } = room(dir);
  play(r, [{ gain: 10, strokes: ink(1) }, { gain: 300, strokes: ink(2) }, { gain: 0, strokes: ink(3) }]);
  assert.equal(r.phase, 'gameOver');
  const shown = r.view(r.players[0]).showcase;
  const gid = r.gid;
  await r.ctx.archive.chain;
  const rec = r.ctx.archive.read(gid);
  assert.equal(rec.best.gain, 300); assert.equal(rec.worst.gain, 0);
  assert.deepEqual(rec.best.strokes, shown.best.strokes); assert.deepEqual(rec.worst.strokes, shown.worst.strokes);
  assert.equal(rec.best.drawer, shown.best.name); assert.ok(rec.best.reason && rec.canvas.w === 960);
  assert.ok(r.ctx.archive.valid(rec));
  r.handle(r.players[0], { t: 'again' }, 0);
  r.strokes.length = 0;
  assert.equal(r.ctx.archive.read(gid).best.strokes.length, 1, 'reset leaves archive');
  assert.notEqual(r.gid, gid);
});
test('stored stroke copy independent of live strokes', async () => {
  const a = new Archive({ dir: tmp() });
  const strokes = ink(5);
  const p = a.save({ gameId: 'aaaaaaaa', mode: 'private', players: 2 }, { best: { name: 'A', word: 'w', diff: 1, gain: 1, strokes }, worst: null });
  strokes[0].p[0] = 999; strokes.push({ c: '#000000', w: 1, p: [1, 1, 2, 2] });
  assert.equal(await p, 'saved');
  const rec = a.read('aaaaaaaa');
  assert.equal(rec.best.strokes[0].p[0], 5); assert.equal(rec.best.strokes.length, 1);
  assert.equal(rec.worst, null); assert.ok(rec.worstNote);
});
test('single drawing: best only; no ink: nothing written; abandoned: nothing', async () => {
  const dir = tmp(); const one = room(dir);
  play(one.r, [{ gain: 5, strokes: ink(1) }, {}, {}]);
  await one.r.ctx.archive.chain;
  const rec = one.r.ctx.archive.read(one.r.gid);
  assert.ok(rec.best); assert.equal(rec.worst, null);
  const dir2 = tmp(); const blank = room(dir2);
  play(blank.r, [{}, {}, {}]);
  await blank.r.ctx.archive.chain;
  assert.equal(blank.r.phase, 'gameOver'); assert.equal(blank.r.ctx.archive.list().length, 0);
  const dir3 = tmp(); const ab = room(dir3);
  ab.r.rotations = 1; ab.r.handle(ab.r.players[0], { t: 'start' }, 0);
  ab.r.handle(ab.r.drawer(), { t: 'pick', i: 0 }, 0);
  ab.r.handle(ab.r.drawer(), { t: 'draw', s: true, c: '#000000', w: 3, p: [1, 1, 5, 5] }, 0);
  ab.r.abort(1); await ab.r.ctx.archive.chain;
  assert.equal(ab.r.ctx.archive.list().length, 0);
});
test('write errors do not crash; full cap refuses without deleting', async () => {
  const dir = tmp(); const logs = [];
  const a = new Archive({ dir, log: (...x) => logs.push(x.join(' ')), maxFiles: 1 });
  const sel = { best: { name: 'A', word: 'w', diff: 1, gain: 1, strokes: ink(1) }, worst: null };
  assert.equal(await a.save({ gameId: '11111111' }, sel), 'saved');
  assert.equal(await a.save({ gameId: '22222222' }, sel), 'full');
  assert.equal(a.list().length, 1); assert.ok(logs.some((l) => /full/.test(l)));
  const b = new Archive({ dir: tmp(), log: (...x) => logs.push(x.join(' ')) });
  b.store.close(); // storage failure
  assert.equal(await b.save({ gameId: '33333333' }, sel), 'error');
  assert.ok(logs.some((l) => /write failed/.test(l)));
  // restart: counts reloaded from the database
  assert.equal(new Archive({ dir, maxFiles: 1 }).files, 1);
});
test('admin retrieval needs bearer token', async () => {
  const dir = tmp(); const a = new Archive({ dir });
  await a.save({ gameId: 'abcdef01' }, { best: { name: 'A', word: 'w', diff: 1, gain: 1, strokes: ink(1) }, worst: null });
  const s = await start(0, { dataDir: dir, exportToken: 'tok' });
  const u = (p) => `http://127.0.0.1:${s.port}${p}`;
  try {
    for (const p of ['/admin/drawings.json', '/admin/drawings/abcdef01.json']) {
      assert.equal((await fetch(u(p))).status, 401);
      assert.equal((await fetch(u(p), { headers: { authorization: 'Bearer bad' } })).status, 401);
    }
    const ok = { headers: { authorization: 'Bearer tok' } };
    const list = await (await fetch(u('/admin/drawings.json'), ok)).json();
    assert.equal(list.games[0].gameId, 'abcdef01');
    assert.equal((await (await fetch(u('/admin/drawings/abcdef01.json'), ok)).json()).best.drawer, 'A');
    assert.equal((await fetch(u('/admin/drawings/ffffffff.json'), ok)).status, 404);
    assert.equal((await fetch(u('/stats'))).status, 200);
    assert.ok(!(await (await fetch(u('/stats'))).text()).includes('abcdef01'));
  } finally { s.close(); }
});

// Reference best/worst over the complete list of drawings (first maximum, last minimum excluding best).
function reference(gains) {
  let bi = 0; gains.forEach((g, i) => { if (g > gains[bi]) bi = i; });
  let wi = -1; gains.forEach((g, i) => { if (i !== bi && (wi < 0 || g <= gains[wi])) wi = i; });
  return { best: bi, worst: wi < 0 ? null : wi };
}
test('showcase keeps only best/worst candidates yet matches full-list tie semantics for every small gain sequence', () => {
  let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let k = 0; k < 400; k++) {
    const len = 1 + rnd(8), gains = Array.from({ length: len }, () => rnd(4) * 100);
    const dir = tmp(); const { r } = room(dir);
    r.rotations = 10; // enough turns; drive them manually
    const turns = gains.map((g, i) => ({ gain: g, strokes: ink(i + 1) }));
    // play() supports one rotation of 3 players; chain several single-rotation games by driving the core state directly
    r.handle(r.players[0], { t: 'start' }, 0);
    let now = 0;
    for (const t of turns) {
      if (r.phase === 'gameOver') break;
      const d = r.drawer(); r.handle(d, { t: 'pick', i: 0 }, now);
      for (const s of t.strokes) r.handle(d, { t: 'draw', s: true, c: s.c, w: s.w, p: s.p }, now);
      d.gain = t.gain; r.endRound(now, 'time up'); now += 10000; r.tick(now); if (r.phase === 'roundEnd') r.nextRound(now);
    }
    const played = Math.min(len, 30);
    const ref = reference(gains.slice(0, r.drawn));
    const bw = r.bestWorst();
    assert.ok(r.state.showcase.length <= 2, 'showcase holds at most two drawings, got ' + r.state.showcase.length);
    assert.equal(bw.best.strokes[0].p[0], ref.best + 1, 'best is the first maximum ' + gains);
    if (ref.worst === null) assert.equal(bw.worst, null); else assert.equal(bw.worst.strokes[0].p[0], ref.worst + 1, 'worst is the last minimum ' + gains);
    assert.ok(played > 0);
  }
});
