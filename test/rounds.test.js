'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, DEFAULT_ROTATIONS, scaled } = require('../game');
const { TIERS, DIFFS, WORDS, difficultyOf } = require('../words');

function mkRoom(n, T0 = 1000) {
  const r = new Game().create(T0);
  const ps = [];
  for (let i = 0; i < n; i++) {
    const { p } = r.join('P' + i, T0);
    p.out = []; r.attach(p, (s) => p.out.push(JSON.parse(s)), T0); ps.push(p);
  }
  return { r, ps };
}
const lastState = (p) => [...p.out].reverse().find((m) => m.t === 'state');

test('word tiers: disjoint, large enough, difficulty fixed per word', () => {
  assert.equal(new Set(WORDS).size, WORDS.length, 'a word appears in two tiers');
  for (const d of DIFFS) { assert.ok(TIERS[d].length >= 30, d); for (const w of TIERS[d]) assert.equal(difficultyOf(w), d); }
});

test('default 5 rotations; host-only integer 1-10 setting in lobby', () => {
  const { r, ps } = mkRoom(3);
  assert.equal(lastState(ps[0]).rotations, DEFAULT_ROTATIONS);
  assert.equal(DEFAULT_ROTATIONS, 5);
  const errs = (p) => p.out.filter((m) => m.t === 'error').length;
  r.handle(ps[1], { t: 'rounds', n: 3 }, 1100);            // non-host
  assert.equal(r.rotations, 5); assert.equal(errs(ps[1]), 1);
  for (const bad of [0, 11, -1, 2.5, '4', null, NaN, Infinity, [3], undefined]) {
    r.handle(ps[0], { t: 'rounds', n: bad }, 1100); assert.equal(r.rotations, 5, String(bad));
  }
  assert.equal(errs(ps[0]), 10);
  for (const ok of [1, 10, 7]) { r.handle(ps[0], { t: 'rounds', n: ok }, 1100); assert.equal(r.rotations, ok); assert.equal(lastState(ps[1]).rotations, ok); }
  r.handle(ps[0], { t: 'start' }, 1200);
  r.handle(ps[0], { t: 'rounds', n: 2 }, 1200);             // game running
  assert.equal(r.rotations, 7);
});

test('snapshot rotation/turn counters coherent through a whole game; each rotation = everyone once', () => {
  const { r, ps } = mkRoom(4);
  r.handle(ps[0], { t: 'rounds', n: 3 }, 1100);
  r.handle(ps[0], { t: 'start' }, 1200);
  let t = 1200, turns = 0; const seen = {};
  while (r.phase !== 'gameOver') {
    const v = lastState(ps[0]);
    assert.equal(v.phase, 'choosing'); assert.equal(v.turns, 12); assert.equal(v.turn, turns + 1);
    assert.equal(v.rotations, 3); assert.equal(v.rotTurns, 4);
    assert.equal(v.rotation, Math.floor(turns / 4) + 1); assert.equal(v.rotTurn, (turns % 4) + 1);
    (seen[v.rotation] ||= []).push(v.drawerId);
    r.handle(r.drawer(), { t: 'pick', i: 0 }, t);
    for (const p of ps) if (p.id !== r.drawerId) r.handle(p, { t: 'guess', text: r.word }, t);
    assert.equal(r.phase, 'roundEnd'); assert.equal(lastState(ps[0]).turn, turns + 1);
    t += 7000; r.tick(t); turns++;
  }
  assert.equal(turns, 12);
  for (const k of [1, 2, 3]) assert.deepEqual([...seen[k]].sort(), ps.map((p) => p.id).sort());
});

test('score exactness: difficulty multiplier on time-decayed guesser and drawer points', () => {
  const cases = [[1, 200, 25], [0.5, 125, 25], [0, 50, 25]]; // fraction of draw time left, base guesser, base drawer
  const mult = { easy: 1, medium: 1.5, hard: 2 };
  for (const d of DIFFS) for (const [frac, base] of cases) {
    const { r, ps } = mkRoom(3, 0);
    r.handle(ps[0], { t: 'start' }, 0);
    const dr = r.drawer(); const idx = DIFFS.indexOf(d);
    r.handle(dr, { t: 'pick', i: idx }, 0);
    assert.equal(r.diff, d); assert.equal(difficultyOf(r.word), d);
    const g = ps.find((p) => p.id !== dr.id);
    r.handle(g, { t: 'guess', text: r.word }, r.cfg.draw * (1 - frac));
    assert.equal(g.gain, Math.round(base * mult[d]), `${d} ${frac}`);
    assert.equal(dr.score, Math.round(25 * mult[d]));
  }
  assert.deepEqual([200, 125, 50].map((b) => ['easy', 'medium', 'hard'].map((d) => scaled(b, d))), [[200, 300, 400], [125, 188, 250], [50, 75, 100]]);
  assert.deepEqual(['easy', 'medium', 'hard'].map((d) => scaled(25, d)), [25, 38, 50]);
});

test('secrecy: drawer sees 3 choices; guessers never get unchosen words or difficulty until reveal', () => {
  const { r, ps } = mkRoom(3);
  r.handle(ps[0], { t: 'start' }, 0);
  const dr = r.drawer(), others = ps.filter((p) => p !== dr);
  const picks = lastState(dr).choices;
  assert.deepEqual(picks.map((c) => c.diff), ['easy', 'medium', 'hard']);
  assert.equal(new Set(picks.map((c) => c.word)).size, 3);
  r.handle(dr, { t: 'pick', i: 2 }, 10);
  for (const o of others) {
    const raw = JSON.stringify(o.out);
    for (const c of picks) assert.ok(!raw.includes(c.word), 'leak ' + c.word);
    assert.ok(!/"diff":"|"mult"/.test(raw));
  }
  assert.equal(lastState(dr).diff, 'hard');
  assert.equal(lastState(dr).mult, 2);
  r.handle(others[0], { t: 'guess', text: r.word }, 20); r.handle(others[1], { t: 'guess', text: r.word }, 20);
  assert.equal(lastState(others[0]).diff, 'hard');
});

test('disconnect skips only that turn; reconnect before turn keeps it; late joiner draws this rotation', () => {
  const { r, ps } = mkRoom(4);
  r.handle(ps[0], { t: 'rounds', n: 2 }, 0);
  r.handle(ps[0], { t: 'start' }, 0);
  const order = [r.drawerId];
  const finish = (t) => { r.endRound(t, 'test'); r.tick(t + 7000); };
  const byId = (id) => ps.find((p) => p.id === id);
  // a queued player disconnects then returns before their turn: still draws
  const q = byId(r.queue[1]); r.detach(q, 5); r.attach(q, (s) => q.out.push(JSON.parse(s)), 6);
  // another queued player stays offline: loses that turn
  const gone = byId(r.queue[2]); r.detach(gone, 7);
  // late joiner
  const { p: late } = r.join('Late', 8); late.out = []; r.attach(late, (s) => late.out.push(JSON.parse(s)), 8);
  assert.equal(lastState(ps[0]).rotTurns, 5);
  finish(10); order.push(r.drawerId);
  finish(20); order.push(r.drawerId);
  finish(30); order.push(r.drawerId);
  assert.ok(!order.slice(0, 4).includes(gone.id) , 'offline player drew');
  assert.ok(order.slice(0, 4).includes(q.id) && order.slice(0, 4).includes(late.id));
  assert.equal(r.rotation, 1);
  r.attach(gone, (s) => gone.out.push(JSON.parse(s)), 40);
  finish(40); // rotation 2 begins, everyone (5) is in it
  assert.equal(r.rotation, 2); assert.equal(lastState(ps[0]).rotTurns, 5);
  const rot2 = [r.drawerId];
  for (let i = 0; i < 4; i++) { finish(50 + i * 20); rot2.push(r.drawerId); }
  assert.equal(new Set(rot2).size, 5);
  finish(200);
  assert.equal(r.phase, 'gameOver');
});

test('reconnect mid-turn keeps rotation counters and difficulty for drawer', () => {
  const { r, ps } = mkRoom(3);
  r.handle(ps[0], { t: 'start' }, 0);
  const dr = r.drawer(); r.handle(dr, { t: 'pick', i: 1 }, 1);
  r.detach(dr, 2); r.attach(dr, (s) => dr.out.push(JSON.parse(s)), 3);
  const v = lastState(dr);
  assert.equal(v.diff, 'medium'); assert.equal(v.rotation, 1); assert.equal(v.turn, 1); assert.equal(v.turns, 15);
});
