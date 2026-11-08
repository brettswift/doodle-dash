'use strict';
// Public lobby over real WebSockets against a real server instance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('../server');

Object.assign(process.env, { CHOOSE_MS: '5000', DRAW_MS: '5000', RESULT_MS: '300' });

function client(url) {
  const c = { msgs: [], errors: [], waiters: [] };
  c.ws = new WebSocket(url);
  c.ws.onmessage = (e) => {
    const m = JSON.parse(e.data); m.at = Date.now(); c.msgs.push(m);
    if (m.t === 'error') c.errors.push(m.msg);
    c.waiters = c.waiters.filter((w) => !w(m));
  };
  c.open = new Promise((r, j) => { c.ws.onopen = r; c.ws.onerror = j; });
  c.send = (o) => c.ws.send(JSON.stringify(o));
  c.wait = (pred, ms = 5000) => {
    const hit = c.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout')), ms);
      c.waiters.push((m) => { if (pred(m)) { clearTimeout(to); res(m); return true; } return false; });
    });
  };
  return c;
}
const started = (m) => m.t === 'state' && m.phase === 'choosing';

async function rush(srv, n) {
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const cs = Array.from({ length: n }, () => client(url));
  await Promise.all(cs.map((c) => c.open));
  await Promise.all(cs.map(async (c) => c.send({ t: 'public', name: 'Pat' }))); // everyone clicks at once
  return cs;
}
function groups(cs) {
  const by = new Map();
  for (const c of cs) {
    const j = c.msgs.filter((m) => m.t === 'joined');
    assert.equal(j.length, 1, 'each player placed in exactly one game');
    by.set(j[0].code, [...(by.get(j[0].code) || []), c]);
  }
  return by;
}

test('20 simultaneous joins: exactly 4 lobbies of 5, all start, no errors', async () => {
  const srv = await start(0); // real 30 s / 15 s rules: only the 5th join can start a lobby here
  try {
    const cs = await rush(srv, 20);
    const st = await Promise.all(cs.map((c) => c.wait(started)));
    const by = groups(cs);
    assert.equal(by.size, 4);
    for (const [code, g] of by) {
      assert.equal(g.length, 5);
      const r = srv.game.get(code);
      assert.equal(r.public, true); assert.equal(r.rotations, 3); assert.equal(r.players.length, 5);
      assert.deepEqual(r.players.map((p) => p.name).sort(), ['Pat', 'Pat 2', 'Pat 3', 'Pat 4', 'Pat 5']);
    }
    for (const s of st) { assert.equal(s.rotations, 3); assert.equal(s.rotation, 1); }
    for (const c of cs) {
      assert.deepEqual(c.errors, []);
      for (const m of c.msgs.filter((x) => x.t === 'public')) assert.ok(m.n >= 1 && m.n <= 5 && m.max === 5);
    }
    assert.equal(srv.game.rooms.size, 4);
    assert.equal(srv.mm.lobbies.length, 0); assert.equal(srv.mm.where.size, 0);
    // a late joiner goes to a fresh lobby and a public room cannot be joined by code
    const late = (await rush(srv, 1))[0];
    const w = await late.wait((m) => m.t === 'public');
    assert.equal(w.n, 1); assert.equal(w.remaining, null);
    const intruder = client(`ws://127.0.0.1:${srv.port}/ws`); await intruder.open;
    intruder.send({ t: 'join', code: [...by.keys()][0], name: 'Sam' });
    assert.match((await intruder.wait((m) => m.t === 'error')).msg, /public game/);
    for (const c of [...cs, late, intruder]) c.ws.close();
  } finally { srv.close(); }
});

test('23 simultaneous joins: 4 full lobbies plus one of 3 that starts on the 15 s rule (shortened)', async () => {
  const srv = await start(0, { lobbyFirstMs: 3000, lobbyResetMs: 600 });
  try {
    const cs = await rush(srv, 23);
    await Promise.all(cs.map((c) => c.wait(started)));
    const by = groups(cs);
    const sizes = [...by.values()].map((g) => g.length).sort();
    assert.deepEqual(sizes, [3, 5, 5, 5, 5]);
    const small = [...by.values()].find((g) => g.length === 3);
    for (const c of small) {
      const pubs = c.msgs.filter((m) => m.t === 'public');
      const last = pubs[pubs.length - 1];
      assert.equal(last.n, 3); assert.equal(last.remaining, 600);
      const go = c.msgs.find(started);
      const waited = go.at - last.at;
      assert.ok(waited >= 450 && waited < 2500, `started ${waited} ms after the 3rd join`);
    }
    for (const c of cs) assert.deepEqual(c.errors, []);
    assert.equal(srv.mm.lobbies.length, 0);
    cs.forEach((c) => c.ws.close());
  } finally { srv.close(); }
});

test('disconnect while waiting removes the player and cancels the countdown', async () => {
  const srv = await start(0);
  try {
    const [a, b] = await rush(srv, 2);
    await a.wait((m) => m.t === 'public' && m.n === 2 && m.remaining > 29000);
    b.ws.close();
    const back = await a.wait((m) => m.t === 'public' && m.n === 1);
    assert.equal(back.remaining, null);
    a.send({ t: 'leavePublic' });
    await a.wait((m) => m.t === 'publicLeft');
    assert.equal(srv.mm.lobbies.length, 0);
    // rate limit: a flood of public joins from one connection is throttled
    for (let i = 0; i < 10; i++) { a.send({ t: 'public', name: 'Pat' }); a.send({ t: 'leavePublic' }); }
    await a.wait((m) => m.t === 'error' && /Slow down/.test(m.msg));
    a.ws.close();
  } finally { srv.close(); }
});
