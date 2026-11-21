'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../core');

// Deterministic fakes: counter RNG and in-memory services. No clock, no disk, no sockets.
function makeEnv(now = 0) {
  let n = 0;
  const calls = [];
  const rng = { hex: (bytes) => String(++n).padStart(bytes * 2, '0') };
  const svc = {
    topics: {
      offer: (code) => { calls.push(['offer', code]); return [{ id: 't1', word: 'cat', diff: 'easy' }, { id: 't2', word: 'big house', diff: 'medium' }, { id: 't3', word: 'volcano', diff: 'hard' }]; },
      commit: (code, id) => calls.push(['commit', code, id]),
      release: (code) => calls.push(['release', code]),
    },
    history: { start: (r) => { calls.push(['hstart', r.tid]); return 7; }, end: (seq, r) => calls.push(['hend', seq, r.out]) },
    adapt: { consider: () => calls.push(['consider']) },
    analytics: { event: (name) => calls.push(['event', name]) },
    archive: { save: (meta, bw) => calls.push(['archive', meta.gameId, !!bw]) },
  };
  return { env: (t) => ({ now: t, rng, svc }), calls };
}

function lobby(count = 3) {
  const h = makeEnv();
  const s = core.create({ code: 'ABCD', now: 0, cfg: { choose: 1000, draw: 5000, result: 500, grace: 200 }, rng: h.env(0).rng });
  const ids = [];
  for (let i = 0; i < count; i++) {
    const j = core.step(s, { type: 'join', name: 'P' + i }, h.env(0)).result;
    ids.push(j.p.id);
    core.step(s, { type: 'attach', playerId: j.p.id }, h.env(0));
  }
  return { s, h, ids };
}

test('core module has no host dependencies', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8').replace(/\/\/.*$/gm, '');
  for (const bad of ['require(\'node:', 'require("node:', 'process.', 'Date.now', 'Math.random', 'setTimeout', 'setInterval', 'console.', 'Buffer']) {
    assert.ok(!src.includes(bad), 'core must not use ' + bad);
  }
  assert.deepEqual([...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]), ['./words']);
});

test('start moves to choosing, emits per-player views and a wake time at the choose deadline', () => {
  const { s, h, ids } = lobby(3);
  const r = core.step(s, { type: 'message', playerId: ids[0], m: { t: 'start' } }, h.env(100));
  assert.equal(s.phase, 'choosing');
  assert.equal(r.nextWakeAt, 1100);
  assert.deepEqual(r.out.map((o) => o.to).sort(), [...ids].sort());
  assert.deepEqual(h.calls.filter((c) => c[0] === 'event').map((c) => c[1]), ['gameStarted']);
});

test('only the drawer sees choices and the word; guessers see only lengths', () => {
  const { s, h, ids } = lobby(3);
  core.step(s, { type: 'message', playerId: ids[0], m: { t: 'start' } }, h.env(0));
  const drawer = s.drawerId, guesser = ids.find((i) => i !== drawer);
  assert.ok(core.view(s, drawer, { now: 0 }).choices);
  assert.equal(core.view(s, guesser, { now: 0 }).choices, undefined);
  core.step(s, { type: 'message', playerId: drawer, m: { t: 'pick', i: 1 } }, h.env(10));
  const gv = JSON.stringify(core.view(s, guesser, { now: 10 }));
  assert.ok(!gv.includes('big house'), 'word hidden from guesser');
  assert.deepEqual(core.view(s, guesser, { now: 10 }).lens, [3, 5]);
  assert.equal(core.view(s, drawer, { now: 10 }).word, 'big house');
  assert.equal(core.view(s, drawer, { now: 10 }).mult, 1.5);
});

test('replay with same commands, times and rng gives identical state and output', () => {
  const run = () => {
    const { s, h, ids } = lobby(3);
    const outs = [];
    const go = (cmd, t) => outs.push(core.step(s, cmd, h.env(t)).out);
    go({ type: 'message', playerId: ids[0], m: { t: 'start' } }, 10);
    const d = s.drawerId, g = ids.filter((i) => i !== d);
    go({ type: 'message', playerId: d, m: { t: 'pick', i: 0 } }, 20);
    go({ type: 'message', playerId: d, m: { t: 'draw', s: true, c: '#000000', w: 4, p: [1, 1, 5, 5] } }, 30);
    go({ type: 'message', playerId: g[0], m: { t: 'guess', text: 'Cat' } }, 1020);
    go({ type: 'message', playerId: g[1], m: { t: 'guess', text: 'cat' } }, 2020);
    go({ type: 'tick' }, 9000);
    return JSON.stringify({ s, outs, calls: h.calls });
  };
  assert.equal(run(), run());
});

test('scoring: time-decayed guess points scaled by difficulty, drawer gain, everyone bonus', () => {
  const { s, h, ids } = lobby(3);
  core.step(s, { type: 'message', playerId: ids[0], m: { t: 'start' } }, h.env(0));
  const d = s.drawerId, g = ids.filter((i) => i !== d);
  core.step(s, { type: 'message', playerId: d, m: { t: 'pick', i: 0 } }, h.env(0)); // easy x1.0, deadline 5000
  core.step(s, { type: 'message', playerId: g[0], m: { t: 'guess', text: 'cat' } }, h.env(0));
  const by = (id) => s.players.find((p) => p.id === id);
  assert.equal(by(g[0]).gain, 200); // full time left: 50+150
  assert.equal(by(d).gain, 25);
  core.step(s, { type: 'message', playerId: g[1], m: { t: 'guess', text: 'cat' } }, h.env(5000)); // no time left: 50
  assert.equal(by(g[1]).gain, 50);
  assert.equal(by(d).gain, 25 + 25 + 100); // two correct guesses + everyone bonus
  assert.equal(s.phase, 'roundEnd');
});

test('tick: choose timeout auto-picks first offer, draw timeout ends round, wake time follows', () => {
  const { s, h, ids } = lobby(2);
  core.step(s, { type: 'message', playerId: ids[0], m: { t: 'start' } }, h.env(0));
  let r = core.step(s, { type: 'tick' }, h.env(999));
  assert.equal(s.phase, 'choosing'); assert.equal(r.nextWakeAt, 1000);
  r = core.step(s, { type: 'tick' }, h.env(1000));
  assert.equal(s.phase, 'drawing'); assert.equal(s.word, 'cat'); assert.equal(r.nextWakeAt, 6000);
  r = core.step(s, { type: 'tick' }, h.env(6000));
  assert.equal(s.phase, 'roundEnd'); assert.equal(r.nextWakeAt, 6500);
  assert.ok(h.calls.some((c) => c[0] === 'hend' && c[2] === 'timeup'));
});

test('drawer-left grace is strictly greater than grace and wake time is grace+1', () => {
  const { s, h, ids } = lobby(3);
  core.step(s, { type: 'message', playerId: ids[0], m: { t: 'start' } }, h.env(0));
  const d = s.drawerId;
  const r = core.step(s, { type: 'detach', playerId: d }, h.env(100));
  assert.equal(r.nextWakeAt, 301);
  core.step(s, { type: 'tick' }, h.env(300));
  assert.equal(s.phase, 'choosing');
  core.step(s, { type: 'tick' }, h.env(301));
  assert.equal(s.phase, 'roundEnd');
});

test('empty room asks to wake for idle retirement at touched + 10 min + 1', () => {
  const { s, h, ids } = lobby(2);
  const r = core.step(s, { type: 'detach', playerId: ids[0] }, h.env(5));
  assert.equal(r.nextWakeAt, null);
  const r2 = core.step(s, { type: 'detach', playerId: ids[1] }, h.env(7));
  assert.equal(r2.nextWakeAt, 7 + 600000 + 1);
});

test('snapshot round trip is JSON-safe, drops host-only fields and resumes identically', () => {
  const { s, h, ids } = lobby(3);
  s.players[0].ip = '1.2.3.4'; s.players[0].send = () => {};
  core.step(s, { type: 'message', playerId: ids[0], m: { t: 'start' } }, h.env(0));
  const d = s.drawerId;
  core.step(s, { type: 'message', playerId: d, m: { t: 'pick', i: 0 } }, h.env(1));
  core.step(s, { type: 'message', playerId: d, m: { t: 'draw', s: true, c: '#e63946', w: 8, p: [1, 1, 9, 9] } }, h.env(2));
  const snap = core.encode(s);
  const text = JSON.stringify(snap);
  assert.ok(!text.includes('1.2.3.4'), 'no IP in snapshot');
  assert.deepEqual(JSON.parse(text), snap);
  const back = core.decode(snap);
  assert.ok(back.players.every((p) => p.connected === false), 'sockets do not survive decode');
  for (const p of back.players) core.step(back, { type: 'attach', playerId: p.id }, h.env(3));
  // same continuation on live and restored state
  const live = core.step(s, { type: 'tick' }, h.env(6000)), rest = core.step(back, { type: 'tick' }, h.env(6000));
  assert.equal(back.phase, s.phase);
  assert.deepEqual(rest.out.map((o) => o.to), live.out.map((o) => o.to));
  assert.throws(() => core.decode({ v: 99, state: {} }), /version/);
});

test('best/worst: first maximum, last minimum excluding best, single drawing has no worst', () => {
  const mk = (gains) => ({ showcase: gains.map((g, i) => ({ name: 'n' + i, gain: g })) });
  const a = core.bestWorst(mk([5, 9, 9, 1, 1]));
  assert.equal(a.best.name, 'n1'); assert.equal(a.worst.name, 'n4');
  const b = core.bestWorst(mk([3]));
  assert.equal(b.best.name, 'n0'); assert.equal(b.worst, null);
  assert.equal(core.bestWorst(mk([])), null);
});

test('input bounds: bad strokes rejected with an error message to the sender only', () => {
  const { s, h, ids } = lobby(2);
  core.step(s, { type: 'message', playerId: ids[0], m: { t: 'start' } }, h.env(0));
  const d = s.drawerId;
  core.step(s, { type: 'message', playerId: d, m: { t: 'pick', i: 0 } }, h.env(0));
  const r = core.step(s, { type: 'message', playerId: d, m: { t: 'draw', s: true, c: 'red', w: 4, p: [1, 1] } }, h.env(1));
  assert.deepEqual(r.out, [{ to: d, msg: { t: 'error', msg: 'Bad stroke' } }]);
  assert.equal(s.strokes.length, 0);
});

test('abort closes the in-flight drawing as abandoned and emits abandon analytics', () => {
  const { s, h, ids } = lobby(2);
  core.step(s, { type: 'message', playerId: ids[0], m: { t: 'start' } }, h.env(0));
  core.step(s, { type: 'message', playerId: s.drawerId, m: { t: 'pick', i: 0 } }, h.env(0));
  core.step(s, { type: 'abort' }, h.env(5));
  assert.ok(h.calls.some((c) => c[0] === 'hend' && c[2] === 'abandoned'));
  assert.ok(h.calls.some((c) => c[0] === 'event' && c[1] === 'gameAbandoned'));
});
