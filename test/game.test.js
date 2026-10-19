'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('../server');

let srv, url;
test.before(async () => {
  Object.assign(process.env, { CHOOSE_MS: '800', DRAW_MS: '1500', RESULT_MS: '300' });
  srv = await start(0);
  url = `ws://127.0.0.1:${srv.port}/ws`;
});
test.after(() => srv.close());

class C {
  constructor(name) { this.name = name; this.raw = []; this.msgs = []; this.state = null; this.waiters = []; }
  async open() {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      this.raw.push(e.data);
      const m = JSON.parse(e.data);
      this.msgs.push(m);
      if (m.t === 'state') this.state = m;
      if (m.t === 'joined') { this.id = m.id; this.token = m.token; this.code = m.code; }
      this.waiters = this.waiters.filter((w) => !w(m));
    };
    this.closed = new Promise((r) => { this.ws.onclose = r; });
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    return this;
  }
  send(o) { this.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); }
  wait(pred, ms = 4000) {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout waiting; last state ' + JSON.stringify(this.state && this.state.phase))), ms);
      this.waiters.push((m) => { if (pred(m)) { clearTimeout(to); res(m); return true; } return false; });
    });
  }
  // wait for a message arriving after now
  next(pred, ms) { const n = this.msgs.length; return this.wait((m) => this.msgs.indexOf(m) >= n && pred(m), ms); }
  phase(p, ms) { return this.state && this.state.phase === p ? Promise.resolve(this.state) : this.next((m) => m.t === 'state' && m.phase === p, ms); }
  close() { this.ws.close(); }
}

async function room(n) {
  const host = await new C('P0').open();
  host.send({ t: 'create', name: 'P0' });
  await host.wait((m) => m.t === 'joined');
  const all = [host];
  for (let i = 1; i < n; i++) {
    const c = await new C('P' + i).open();
    c.send({ t: 'join', code: host.code, name: 'P' + i });
    await c.wait((m) => m.t === 'joined');
    all.push(c);
  }
  await host.wait((m) => m.t === 'state' && m.players.length === n);
  return all;
}
const byId = (all, id) => all.find((c) => c.id === id);
async function begin(all) {
  all[0].send({ t: 'start' });
  const st = await all[0].phase('choosing');
  const drawer = byId(all, st.drawerId);
  const d = await drawer.wait((m) => m.t === 'state' && m.phase === 'choosing' && m.choices);
  drawer.send({ t: 'pick', i: 0 });
  const dw = await drawer.wait((m) => m.t === 'state' && m.phase === 'drawing');
  const guessers = all.filter((c) => c !== drawer);
  for (const g of guessers) await g.phase('drawing');
  return { drawer, word: dw.word, choices: d.choices, guessers };
}

test('8 players join, 9th rejected, bad code and bad names rejected', async () => {
  const all = await room(8);
  const x = await new C('x').open();
  x.send({ t: 'join', code: all[0].code, name: 'Nine' });
  const e = await x.wait((m) => m.t === 'error');
  assert.match(e.msg, /full/i);
  x.send({ t: 'join', code: 'ZZZZ', name: 'Nine' });
  assert.match((await x.next((m) => m.t === 'error')).msg, /room/i);
  x.send({ t: 'join', code: all[0].code, name: 'p0' });
  assert.ok(await x.next((m) => m.t === 'error'));
  const y = await new C('y').open();
  y.send({ t: 'create', name: '<img src=x onerror=1>' });
  assert.ok(await y.wait((m) => m.t === 'error'));
  [x, y, ...all].forEach((c) => c.close());
});

test('only host starts; needs two players', async () => {
  const solo = await new C('s').open();
  solo.send({ t: 'create', name: 'Solo' });
  await solo.wait((m) => m.t === 'joined');
  solo.send({ t: 'start' });
  assert.ok(await solo.wait((m) => m.t === 'error'));
  const all = await room(3);
  all[1].send({ t: 'start' });
  assert.ok(await all[1].wait((m) => m.t === 'error'));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(all[0].state.phase, 'lobby');
  [solo, ...all].forEach((c) => c.close());
});

test('word choices and word stay secret from guessers in every frame', async () => {
  const all = await room(6);
  const { drawer, word, choices, guessers } = await begin(all);
  assert.equal(choices.length, 3);
  assert.ok(choices.includes(word));
  for (const g of guessers) {
    assert.equal(g.state.word, undefined);
    assert.equal(g.state.choices, undefined);
    assert.ok(g.state.len > 0);
  }
  drawer.send({ t: 'draw', s: true, c: '#e63946', w: 8, p: [10, 10, 20, 20] });
  await guessers[0].wait((m) => m.t === 'draw');
  guessers[1].send({ t: 'guess', text: 'definitely-wrong' });
  await drawer.wait((m) => m.t === 'chat');
  for (const g of guessers) for (const r of g.raw) for (const w of choices) assert.ok(!r.toLowerCase().includes(w.toLowerCase()), `leak of ${w} in ${r}`);
  all.forEach((c) => c.close());
});

test('live strokes: only drawer draws; clear works; invalid input rejected', async () => {
  const all = await room(5);
  const { drawer, guessers } = await begin(all);
  guessers[0].send({ t: 'draw', s: true, c: '#000000', w: 8, p: [1, 1, 2, 2] });
  guessers[0].send({ t: 'clear' });
  drawer.send({ t: 'draw', s: true, c: '#1d90ff', w: 8, p: [100, 100, 200, 200] });
  drawer.send({ t: 'draw', c: '#1d90ff', w: 8, p: [300, 300] });
  const m = await guessers[2].wait((x) => x.t === 'draw' && x.p[0] === 300);
  assert.equal(m.c, '#1d90ff');
  assert.equal(guessers[1].msgs.filter((x) => x.t === 'draw').length, 2);
  drawer.send({ t: 'draw', s: true, c: 'red;alert(1)', w: 8, p: [1, 1] });
  drawer.send({ t: 'draw', s: true, c: '#000000', w: 8, p: [1, 99999] });
  drawer.send({ t: 'draw', s: true, c: '#000000', w: 8, p: [1] });
  drawer.send({ t: 'draw', s: true, c: '#000000', w: 8, p: new Array(200).fill(5) });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(guessers[1].msgs.filter((x) => x.t === 'draw').length, 2);
  drawer.send({ t: 'clear' });
  await guessers[1].wait((x) => x.t === 'clear');
  assert.equal(drawer.msgs.filter((x) => x.t === 'clear').length, 0);
  all.forEach((c) => c.close());
});

test('correct guess scored server-side, not broadcast, round ends when all guessed', async () => {
  const all = await room(5);
  const { drawer, word, guessers } = await begin(all);
  drawer.send({ t: 'guess', text: word });
  guessers[0].send({ t: 'guess', text: '  ' + word.toUpperCase() + ' ' });
  const ev = await drawer.wait((m) => m.t === 'state' && m.players.some((p) => p.guessed));
  assert.ok(ev.players.find((p) => p.id === guessers[0].id).score > 0);
  assert.equal(ev.players.find((p) => p.id === drawer.id).guessed, false);
  assert.ok(ev.players.find((p) => p.id === drawer.id).score > 0);
  guessers[0].send({ t: 'guess', text: word });
  for (const g of guessers.slice(0, 3)) for (const r of g.raw) assert.ok(!r.toLowerCase().includes('"text":"' + word.toLowerCase()), 'guess echoed');
  const before = ev.players.find((p) => p.id === guessers[0].id).score;
  for (const g of guessers.slice(1)) g.send({ t: 'guess', text: word });
  const end = await guessers[1].phase('roundEnd');
  assert.equal(end.word, word);
  const after = end.players.find((p) => p.id === guessers[0].id).score;
  assert.equal(after, before, 'no double scoring');
  assert.ok(end.players.every((p) => p.id === drawer.id || p.gain > 0));
  all.forEach((c) => c.close());
});

test('timer ends round server-side', async () => {
  const all = await room(2);
  const { guessers } = await begin(all);
  const end = await guessers[0].phase('roundEnd', 3000);
  assert.ok(end.word);
  all.forEach((c) => c.close());
});

test('reconnect resyncs drawer and guesser; late join gets strokes', async () => {
  const all = await room(5);
  const { drawer, word, guessers } = await begin(all);
  drawer.send({ t: 'draw', s: true, c: '#2a9d8f', w: 4, p: [5, 5, 50, 50] });
  await guessers[0].wait((m) => m.t === 'draw');
  const g = guessers[0];
  g.close(); await g.closed;
  const g2 = await new C('g2').open();
  g2.send({ t: 'resume', code: g.code, token: g.token });
  const st = await g2.wait((m) => m.t === 'state');
  assert.equal(st.you, g.id);
  assert.equal(st.strokes.length, 1);
  assert.equal(st.word, undefined);
  drawer.close(); await drawer.closed;
  const d2 = await new C('d2').open();
  d2.send({ t: 'resume', code: drawer.code, token: drawer.token });
  const ds = await d2.wait((m) => m.t === 'state');
  assert.equal(ds.word, word);
  const bad = await new C('bad').open();
  bad.send({ t: 'resume', code: drawer.code, token: 'nope' });
  assert.ok(await bad.wait((m) => m.t === 'error'));
  const late = await new C('Late').open();
  late.send({ t: 'join', code: all[0].code, name: 'Late' });
  const ls = await late.wait((m) => m.t === 'state' && m.phase === 'drawing');
  assert.equal(ls.strokes.length, 1);
  assert.equal(ls.word, undefined);
  late.send({ t: 'guess', text: word });
  await late.wait((m) => m.t === 'state' && m.players.find((p) => p.id === late.id).guessed);
  [late, bad, d2, g2, ...all].forEach((c) => c.close());
});

test('full 8-player game: everyone draws once, results, play again', async () => {
  process.env.DRAW_MS = '1500';
  const all = await room(8);
  all[0].send({ t: 'start' });
  const drawn = new Set();
  for (let r = 0; r < 8; r++) {
    const st = await all[0].next((m) => m.t === 'state' && m.phase === 'choosing', 3000).catch(() => all[0].state);
    const drawer = byId(all, st.drawerId);
    assert.ok(!drawn.has(drawer.id), 'drawer repeated');
    drawn.add(drawer.id);
    await drawer.wait((m) => m.t === 'state' && m.phase === 'choosing' && m.choices && m.drawerId === drawer.id);
    drawer.send({ t: 'pick', i: 1 });
    const dw = await drawer.next((m) => m.t === 'state' && m.phase === 'drawing' && m.word);
    for (const c of all) if (c !== drawer) c.send({ t: 'guess', text: dw.word });
    await all[0].next((m) => m.t === 'state' && (m.phase === 'roundEnd' || m.phase === 'gameOver'), 3000).catch(() => {});
  }
  const over = await all[3].phase('gameOver', 3000);
  assert.equal(drawn.size, 8);
  assert.equal(over.players.length, 8);
  all[1].send({ t: 'again' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(all[0].state.phase, 'gameOver');
  all[0].send({ t: 'again' });
  const lob = await all[5].phase('lobby');
  assert.ok(lob.players.every((p) => p.score === 0));
  all.forEach((c) => c.close());
});

test('abuse: oversized frames closed, bad json ignored, floods rate limited, no static traversal', async () => {
  const c = await new C('a').open();
  c.send('{not json');
  c.send(JSON.stringify({ t: 'nonsense' }));
  c.send({ t: 'create', name: 'Abuser' });
  await c.wait((m) => m.t === 'joined');
  for (let i = 0; i < 500; i++) c.send({ t: 'guess', text: 'x' + i });
  const lim = await c.wait((m) => m.t === 'error' && /slow/i.test(m.msg));
  assert.ok(lim);
  c.send('x'.repeat(20000));
  await c.closed;
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/game.js', '/package.json', '/public/../server.js']) {
    const r = await fetch(`http://127.0.0.1:${srv.port}${p}`);
    assert.equal(r.status, 404, p);
  }
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/healthz`)).status, 200);
  const idx = await fetch(`http://127.0.0.1:${srv.port}/`);
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /Doodle Dash/);
});
