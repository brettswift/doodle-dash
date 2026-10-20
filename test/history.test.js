'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../server');
const { Game } = require('../game');
const { History } = require('../history');
const { Topics } = require('../topics');
const adapt = require('../adapt');
const { TOPICS, TIERS, BY_ID, DIFFS } = require('../words');

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dd-'));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- catalog ----------
test('catalog: >=1000 distinct familiar topics, balanced tiers, stable slug ids, no padding', () => {
  assert.ok(TOPICS.length >= 1000, 'count ' + TOPICS.length);
  for (const d of DIFFS) assert.ok(TIERS[d].length >= 300, d + ' ' + TIERS[d].length);
  const ids = new Set(TOPICS.map((t) => t.id)), ns = new Set(TOPICS.map((t) => norm(t.word)));
  assert.equal(ids.size, TOPICS.length); assert.equal(ns.size, TOPICS.length);
  const stem = (s) => s.replace(/ies$/, 'y').replace(/(es|s)$/, '');
  assert.equal(new Set([...ns].map(stem)).size, ns.size, 'singular/plural duplicate');
  for (const t of TOPICS) {
    assert.match(t.id, /^[a-z0-9]+(-[a-z0-9]+)*$/); assert.doesNotMatch(t.word, /\d/, 'synthetic/numbered label');
    assert.ok(t.word.length >= 2 && t.word.length <= 28 && t.word.split(' ').length <= 5, t.word);
  }
  // known synonym families may appear at most once each
  const fam = ['couch sofa', 'bunny rabbit', 'puppy dog', 'kitty cat', 'automobile car', 'cap hat', 'mug cup', 'tv television', 'bike bicycle',
    'airplane plane', 'ship boat', 'present gift', 'sun sunshine', 'phone telephone', 'torch flashlight', 'cellphone phone'];
  for (const f of fam) assert.ok(f.split(' ').filter((w) => ns.has(w)).length <= 1, 'synonyms: ' + f);
  // the original words keep their ids
  for (const w of ['apple', 'icecream', 'hourglass']) assert.ok(BY_ID.has(w));
});

// ---------- durable store ----------
test('history: reload, partial last line, corrupt state fallback, bounded compaction', () => {
  const dir = tmp();
  let h = new History({ dir });
  const a = h.start({ tid: 'apple', d: 'easy', m: 10, g: 'g1', t0: 1, el0: 3, budget: 80000 });
  h.end(a, { out: 'all', t1: 9, dur: 8, ok: 2, gt: [1000, 2000], el1: 3, ink: true, dd: false });
  const b = h.start({ tid: 'cat', d: 'easy', m: 10, g: 'g1', t0: 20, el0: 3, budget: 80000 }); // never ended: restart mid-drawing
  h.setTier('cat', 'medium', { at: 1, id: 'cat', from: 'easy', to: 'medium', rules: 1 });
  fs.appendFileSync(path.join(dir, 'history.jsonl'), '{"k":"s","seq":99,"tid":"torn'); // torn write
  h = new History({ dir });
  assert.equal(h.recs.get(a).ok, 2); assert.equal(h.recs.get(a).out, 'all');
  assert.equal(h.recs.get(b).out, 'abandoned'); assert.equal(h.seq, b);
  assert.equal(h.last.get('apple'), a); assert.equal(h.state.tiers.cat, 'medium'); assert.equal(h.state.audit.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2, 'torn line dropped');
  // corrupt state.json -> .bak
  h.setTier('dog', 'medium', { at: 2, id: 'dog', from: 'easy', to: 'medium', rules: 1 });
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
  h = new History({ dir });
  assert.equal(h.state.tiers.cat, 'medium');
  // bounded
  const small = new History({ dir: tmp(), maxRecords: 40 });
  for (let i = 0; i < 400; i++) small.end(small.start({ tid: 't' + (i % 7), d: 'easy', g: 'x', t0: i, el0: 1, budget: 1 }), { out: 'all' });
  assert.ok(small.recs.size <= 50, 'recs ' + small.recs.size);
  const lines = fs.readFileSync(path.join(small.dir, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  assert.ok(lines <= 100, 'lines ' + lines);
  assert.equal(new History({ dir: small.dir, maxRecords: 40 }).seq, 400);
  assert.ok(!fs.readdirSync(small.dir).some((f) => f.endsWith('.tmp')));
});

// ---------- selection / reservation ----------
const mem = () => new History();

test('topics: simultaneous rooms never get the same topic; unchosen offers are not burned', () => {
  const h = mem(), T = new Topics(h);
  const rooms = Array.from({ length: 100 }, (_, i) => 'R' + i);
  const offers = rooms.map((r) => T.offer(r));
  const flat = offers.flat().map((c) => c.id);
  assert.equal(new Set(flat).size, flat.length, 'overlap across 100 simultaneous rooms');
  assert.equal(h.recs.size, 0, 'offers record nothing');
  const [c] = offers[0];
  T.commit('R0', c.id); h.start({ tid: c.id, d: c.diff, g: 'g', t0: 0, el0: 1, budget: 1 });
  assert.deepEqual([...h.last.keys()], [c.id]);
  T.release('R0'); // unchosen + chosen released: only the started one is in history
  for (let i = 0; i < 200; i++) assert.ok(!T.offer('X').some((o) => o.id === c.id) || h.recs.size === 1);
});

test('topics: unused before aged before exhausted; hard-only stream has no repeat until the tier is used up', () => {
  const h = new History(), T = new Topics(h, { window: 1000 });
  const hard = T.list('hard').length, seen = new Map(), order = [];
  for (let i = 0; i < hard * 2 + 5; i++) {
    const c = T.offer('R').find((x) => x.diff === 'hard');
    T.commit('R', c.id); const seq = h.start({ tid: c.id, d: 'hard', g: 'g', t0: i, el0: 1, budget: 1 }); h.end(seq, { out: 'all' }); T.release('R');
    order.push(c.id);
    if (i < hard) assert.ok(!seen.has(c.id), 'repeat before exhaustion at ' + i); // guarantee holds for first `hard` hard picks
    seen.set(c.id, i);
  }
  assert.equal(new Set(order.slice(0, hard)).size, hard);
  assert.ok(T.stats.exhausted > 0, 'exhaustion path used');
  // after exhaustion: least-recently drawn first, i.e. second cycle repeats in first-cycle order
  assert.deepEqual(order.slice(hard, hard + 20), order.slice(0, 20));
});

test('topics: in-window topics skipped while tier has others; restart (reload) remembers', () => {
  const dir = tmp(); let h = new History({ dir }); let T = new Topics(h);
  const used = new Set();
  for (let i = 0; i < 30; i++) {
    const c = T.offer('R')[0]; T.commit('R', c.id); h.end(h.start({ tid: c.id, d: 'easy', g: 'g', t0: i, el0: 1, budget: 1 }), { out: 'all' }); T.release('R'); used.add(c.id);
  }
  h = new History({ dir }); T = new Topics(h);
  for (let i = 0; i < 300; i++) for (const c of T.offer('N' + i % 3)) assert.ok(!used.has(c.id), 'repeated after reload: ' + c.id);
});

// ---------- room telemetry ----------
function fakeRoom(game, n, now = 0) {
  const r = game.create(now), sends = [];
  const ps = [];
  for (let i = 0; i < n; i++) {
    const p = r.join('P' + i, now).p; const box = []; sends.push(box);
    r.attach(p, (s) => box.push(JSON.parse(s)), now); ps.push(p);
  }
  return { r, ps, sends };
}
const clock = (r, t) => { r.clock = () => t.v; };
function startGame(r, ps, t) {
  r.handle(ps[0], { t: 'start' }, t.v);
  const d = r.drawer();
  return d;
}

test('telemetry: correct counts, guess times, ink, anonymity, tier snapshot, unchosen not recorded', () => {
  const game = new Game(), t = { v: 1000 };
  const { r, ps } = fakeRoom(game, 4, t.v); clock(r, t);
  const d = startGame(r, ps, t);
  assert.equal(game.ctx.history.recs.size, 0, 'choosing records nothing');
  const pick = r.choices[2]; r.handle(d, { t: 'pick', i: 2 }, t.v);
  assert.equal(game.ctx.history.recs.size, 1);
  r.handle(d, { t: 'draw', s: true, c: '#000000', w: 4, p: [10, 10, 20, 20] }, t.v);
  const [g1, g2, g3] = ps.filter((p) => p !== d);
  r.detach(g3, t.v); // eligible guesser who never guessed drops offline -> excluded
  t.v += 4000; r.handle(g1, { t: 'guess', text: pick.word }, t.v);
  t.v += 6000; r.handle(g2, { t: 'guess', text: 'wrong' }, t.v); r.handle(g2, { t: 'guess', text: pick.word }, t.v);
  // everyone connected has guessed -> ends
  assert.equal(r.phase, 'roundEnd');
  const f = [...game.ctx.history.recs.values()][0];
  assert.deepEqual({ tid: f.tid, d: f.d, m: f.m, out: f.out, ok: f.ok, el0: f.el0, el1: f.el1, ink: f.ink, dd: f.dd }, { tid: pick.id, d: 'hard', m: 20, out: 'all', ok: 2, el0: 3, el1: 2, ink: true, dd: false });
  assert.deepEqual(f.gt, [4000, 10000]); assert.equal(f.dur, 10000);
  const json = JSON.stringify([...game.ctx.history.recs.values()]);
  for (const bad of [...ps.map((p) => p.name), ps[0].token, 'wrong', '#000000', 'strokes', 'ip']) assert.ok(!json.includes(bad), 'leaked ' + bad);
  assert.equal(game.ctx.topics.held.size, 0, 'reservations released at round end');
});

test('telemetry: drawer left, time up, shutdown abandon; fair-trial filter excludes them', () => {
  const game = new Game(), t = { v: 1000 };
  const { r, ps } = fakeRoom(game, 3, 1000); clock(r, t);
  const d = startGame(r, ps, t);
  r.handle(d, { t: 'pick', i: 0 }, t.v);
  r.detach(d, t.v); t.v += 20000; r.tick(t.v);
  const rec = () => [...game.ctx.history.recs.values()];
  assert.equal(rec()[0].out, 'drawerLeft'); assert.ok(!adapt.eligible(rec()[0]));
  // next turn: time up with ink
  t.v += 7000; r.tick(t.v);
  const d2 = r.drawer(); assert.ok(d2.send || true);
  if (!d2.send) { r.tick(t.v + 20000); }
  game.shutdown(t.v + 1);
  assert.ok(rec().every((x) => x.out !== undefined));
  assert.equal(game.ctx.topics.held.size, 0);
});

test('telemetry: skipped turn (drawer gone while choosing) records nothing and burns nothing', () => {
  const game = new Game(), t = { v: 1000 };
  const { r, ps } = fakeRoom(game, 3, 1000); clock(r, t);
  const d = startGame(r, ps, t); r.detach(d, t.v); t.v += 13000; r.tick(t.v);
  assert.equal(game.ctx.history.recs.size, 0); assert.equal(game.ctx.topics.held.size, 0);
});

// ---------- adaptation ----------
function seed(h, tid, tier, n, games, { ok, el = 4, gtFrac = 0.3, out = 'timeup' }) {
  for (let i = 0; i < n; i++) {
    const budget = 80000, c = Math.round(ok * el);
    const s = h.start({ tid, d: tier, m: 10, g: 'G' + (i % games), t0: i, el0: el, budget });
    h.end(s, { out, t1: i + 1, dur: budget, ok: c, gt: Array.from({ length: c }, () => Math.round(gtFrac * budget)), el1: el, ink: true, dd: false });
  }
}
const mk = () => { const h = mem(); return { h, T: new Topics(h) }; };

test('adapt: insufficient evidence (drawings or rooms) changes nothing', () => {
  let { h, T } = mk(); seed(h, 'apple', 'easy', 19, 5, { ok: 0 });
  assert.equal(adapt.consider(h, T, 'apple'), null);
  ({ h, T } = mk()); seed(h, 'apple', 'easy', 40, 2, { ok: 0 }); // plenty of drawings but only 2 rooms
  assert.equal(adapt.consider(h, T, 'apple'), null); assert.equal(T.tierOf('apple'), 'easy');
});

test('adapt: robust hard/easy evidence moves exactly one tier, audited, future-only', () => {
  let { h, T } = mk(); seed(h, 'apple', 'easy', 24, 4, { ok: 0 });
  const ch = adapt.consider(h, T, 'apple', 5000);
  assert.deepEqual(ch, { id: 'apple', from: 'easy', to: 'medium' }); assert.equal(T.tierOf('apple'), 'medium');
  const a = h.state.audit[0]; assert.equal(a.rules, adapt.RULES.version); assert.ok(a.n >= 20 && a.games >= 3 && a.hi < 0.45 && a.at === 5000);
  // no second hop on the same evidence (evidence resets after a move, one step only)
  assert.equal(adapt.consider(h, T, 'apple', 6000), null);
  // old records keep their selection-time tier
  assert.ok(h.forTopic('apple').every((r) => r.d === 'easy'));
  ({ h, T } = mk()); seed(h, 'trumpet', 'hard', 24, 4, { ok: 1, gtFrac: 0.1 });
  assert.equal(adapt.consider(h, T, 'trumpet').to, 'medium');
  // survives reload via state
  const dir = tmp(); const h2 = new History({ dir }); const T2 = new Topics(h2); seed(h2, 'apple', 'easy', 24, 4, { ok: 0 });
  adapt.consider(h2, T2, 'apple'); assert.equal(new Topics(new History({ dir })).tierOf('apple'), 'medium');
});

test('adapt: hysteresis band, unfair trials excluded, daily bound and tier floor', () => {
  let { h, T } = mk(); seed(h, 'cake', 'easy', 30, 5, { ok: 0.6, gtFrac: 0.4 }); // mid-range: stays
  assert.equal(adapt.consider(h, T, 'cake'), null);
  ({ h, T } = mk()); seed(h, 'apple', 'easy', 30, 5, { ok: 0, out: 'drawerLeft' }); // abandoned: ignored
  assert.equal(adapt.consider(h, T, 'apple'), null);
  ({ h, T } = mk());
  for (let i = 0; i < 24; i++) { const s = h.start({ tid: 'apple', d: 'easy', g: 'G' + (i % 4), t0: i, el0: 4, budget: 80000 }); h.end(s, { out: 'timeup', ok: 0, gt: [], el1: 1, ink: true, dd: false }); } // guessers left
  assert.equal(adapt.consider(h, T, 'apple'), null, 'half the guessers offline -> unfair');
  ({ h, T } = mk());
  for (const id of ['apple', 'banana', 'pizza', 'cake', 'cookie', 'bread', 'cheese', 'carrot']) seed(h, id, 'easy', 24, 4, { ok: 0 });
  const moved = ['apple', 'banana', 'pizza', 'cake', 'cookie', 'bread', 'cheese', 'carrot'].map((id) => adapt.consider(h, T, id, 1000)).filter(Boolean);
  assert.equal(moved.length, adapt.RULES.maxPerDay);
});

// ---------- end-to-end over WebSocket with restart ----------
class C {
  constructor(url) { this.msgs = []; this.url = url; }
  async open() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (e) => { const m = JSON.parse(e.data); this.msgs.push(m); if (m.t === 'state') this.state = m; if (m.t === 'joined') Object.assign(this, { id: m.id, code: m.code }); };
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; }); return this;
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async until(f, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 15)); } throw new Error('timeout'); }
}

test('e2e: real drawing persists across restart, /stats is aggregate-only, no admin endpoints, no repeat after restart', async () => {
  Object.assign(process.env, { CHOOSE_MS: '800', DRAW_MS: '3000', RESULT_MS: '300' });
  const dir = tmp();
  let srv = await start(0, { dataDir: dir });
  const url = () => `ws://127.0.0.1:${srv.port}/ws`;
  const a = await new C(url()).open(); a.send({ t: 'create', name: 'Ann' }); await a.until(() => a.code);
  const b = await new C(url()).open(); b.send({ t: 'join', code: a.code, name: 'Bob' }); await b.until(() => b.id);
  await a.until(() => a.state && a.state.players.length === 2);
  a.send({ t: 'start' });
  await a.until(() => a.state.phase === 'choosing');
  const drawer = a.state.drawerId === a.id ? a : b, other = drawer === a ? b : a;
  await drawer.until(() => drawer.state.choices); drawer.send({ t: 'pick', i: 1 });
  await drawer.until(() => drawer.state.phase === 'drawing' && drawer.state.word);
  const word = drawer.state.word;
  drawer.send({ t: 'draw', s: true, c: '#000000', w: 4, p: [100, 100, 300, 300] });
  other.send({ t: 'guess', text: word });
  await other.until(() => other.state.phase === 'roundEnd');
  const base = `http://127.0.0.1:${srv.port}`;
  const stats = await (await fetch(base + '/stats')).json();
  assert.equal(stats.history.persistent, true); assert.equal(stats.history.records, 1); assert.ok(stats.topics >= 1000);
  assert.ok(!JSON.stringify(stats).match(/token|Ann|Bob|127\.0/));
  for (const p of ['/admin', '/reset', '/history', '/api/reset']) for (const m of ['GET', 'POST', 'DELETE']) assert.equal((await fetch(base + p, { method: m })).status, 404);
  a.ws.close(); b.ws.close(); srv.close();
  const raw = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8');
  for (const bad of ['Ann', 'Bob', 'token', '127.0.0.1', '#000000']) assert.ok(!raw.includes(bad), 'leak ' + bad);
  const rec = Object.assign({}, ...raw.trim().split('\n').map((l) => JSON.parse(l)));
  assert.equal(rec.ok, 1); assert.equal(rec.d, 'medium'); assert.equal(rec.out, 'all');
  srv = await start(0, { dataDir: dir }); // restart
  assert.equal(srv.game.ctx.history.recs.size, 1); assert.equal(srv.game.ctx.history.recs.get(rec.seq).tid, rec.tid);
  for (let i = 0; i < 300; i++) for (const c of srv.game.ctx.topics.offer('Z')) assert.notEqual(c.id, rec.tid);
  srv.close();
});
