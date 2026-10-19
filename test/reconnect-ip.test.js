'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, clientIp } = require('../server');

// Documentation-range addresses stand in for public client IPs (sent as X-Real-IP by the trusted proxy).
const A = '203.0.113.7', B = '198.51.100.9';
let srv, plain;
test.before(async () => {
  Object.assign(process.env, { CHOOSE_MS: '800', DRAW_MS: '1500', RESULT_MS: '300' });
  srv = await start(0);
  plain = await start(0, { trustProxy: false });
});
test.after(() => { srv.close(); plain.close(); });

class C {
  constructor(ip, s = srv) { this.ip = ip; this.s = s; this.msgs = []; this.waiters = []; }
  async open() {
    const headers = this.ip ? { 'x-real-ip': this.ip } : {};
    this.ws = new WebSocket(`ws://127.0.0.1:${this.s.port}/ws`, { headers });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data); this.msgs.push(m);
      if (m.t === 'state') this.state = m;
      if (m.t === 'joined') { this.id = m.id; this.token = m.token; this.code = m.code; }
      this.waiters = this.waiters.filter((w) => !w(m));
    };
    this.closed = new Promise((r) => { this.ws.onclose = r; });
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    return this;
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(pred, ms = 3000) {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('timeout')), ms);
      this.waiters.push((m) => { if (pred(m)) { clearTimeout(to); res(m); return true; } return false; });
    });
  }
  async drop() { this.ws.close(); await this.closed; await new Promise((r) => setTimeout(r, 50)); }
}
const mk = async (ip, msg, s) => { const c = await new C(ip, s).open(); c.send(msg); return c; };
async function mkRoom(ip, name = 'Ann', s = srv) {
  const c = await mk(ip, { t: 'create', name }, s); await c.wait((m) => m.t === 'joined'); return c;
}
async function joinAs(ip, code, name, s) {
  const c = await mk(ip, { t: 'join', code, name }, s); return c;
}

test('same IP + same name rejoins disconnected slot without token, keeps identity, rotates token', async () => {
  const host = await mkRoom(A, 'Ann');
  const bob = await joinAs(B, host.code, 'Bob'); await bob.wait((m) => m.t === 'joined');
  const oldTok = bob.token, oldId = bob.id;
  await bob.drop();
  const bob2 = await joinAs(B, host.code, 'bob'); // normalized name
  const j = await bob2.wait((m) => m.t === 'joined');
  assert.equal(j.id, oldId);
  assert.notEqual(j.token, oldTok);
  const st = await bob2.wait((m) => m.t === 'state');
  assert.equal(st.players.length, 2);
  assert.equal(st.you, oldId);
  // old token no longer works
  const stale = await mk(B, { t: 'resume', code: host.code, token: oldTok });
  assert.ok(await stale.wait((m) => m.t === 'error'));
  [host, bob2, stale].forEach((c) => c.ws.close());
});

test('fallback restores score, drawer role and round state', async () => {
  const host = await mkRoom(A, 'Ann');
  const bob = await joinAs(B, host.code, 'Bob'); await bob.wait((m) => m.t === 'joined');
  host.send({ t: 'start' });
  const all = [host, bob];
  const st = await host.wait((m) => m.t === 'state' && m.phase === 'choosing');
  const drawer = all.find((c) => c.id === st.drawerId);
  const other = all.find((c) => c !== drawer);
  await drawer.wait((m) => m.t === 'state' && m.choices);
  drawer.send({ t: 'pick', i: 0 });
  const dw = await drawer.wait((m) => m.t === 'state' && m.phase === 'drawing' && m.word);
  drawer.send({ t: 'draw', s: true, c: '#2a9d8f', w: 4, p: [5, 5, 50, 50] });
  await other.wait((m) => m.t === 'draw');
  const name = drawer === host ? 'Ann' : 'Bob', ip = drawer === host ? A : B;
  await drawer.drop();
  const d2 = await joinAs(ip, host.code, name);
  const s2 = await d2.wait((m) => m.t === 'state');
  assert.equal(s2.you, drawer.id);
  assert.equal(s2.drawerId, drawer.id);
  assert.equal(s2.word, dw.word);
  assert.equal(s2.strokes.length, 1);
  assert.equal(s2.players.length, 2);
  [other, d2].forEach((c) => c.ws.close());
});

test('different IP denied for disconnected name', async () => {
  const host = await mkRoom(A, 'Ann');
  const bob = await joinAs(B, host.code, 'Bob'); await bob.wait((m) => m.t === 'joined');
  await bob.drop();
  const evil = await joinAs('192.0.2.55', host.code, 'Bob');
  assert.match((await evil.wait((m) => m.t === 'error')).msg, /taken/i);
  [host, evil].forEach((c) => c.ws.close());
});

test('active player never replaced, even from same IP', async () => {
  const host = await mkRoom(A, 'Ann');
  const dup = await joinAs(A, host.code, 'Ann');
  assert.match((await dup.wait((m) => m.t === 'error')).msg, /taken/i);
  assert.ok(!dup.msgs.some((m) => m.t === 'joined'));
  assert.equal(host.msgs.filter((m) => m.t === 'error').length, 0);
  [host, dup].forEach((c) => c.ws.close());
});

test('shared IP, different names stay separate slots', async () => {
  const host = await mkRoom(A, 'Ann');
  const bob = await joinAs(A, host.code, 'Bob'); await bob.wait((m) => m.t === 'joined');
  const cy = await joinAs(A, host.code, 'Cy'); await cy.wait((m) => m.t === 'joined');
  assert.notEqual(bob.id, cy.id);
  await bob.drop();
  // Cy (same IP, other name) cannot take Bob's slot; Bob's slot restored only under Bob's name
  const cy2 = await joinAs(A, host.code, 'Cy');
  assert.match((await cy2.wait((m) => m.t === 'error')).msg, /taken/i);
  const bob2 = await joinAs(A, host.code, 'Bob');
  assert.equal((await bob2.wait((m) => m.t === 'joined')).id, bob.id);
  const s = await host.wait((m) => m.t === 'state' && m.players.length === 3 && m.players.every((p) => p.connected));
  assert.equal(s.players.length, 3);
  [host, cy, cy2, bob2].forEach((c) => c.ws.close());
});

test('room boundary: same IP+name in another room does not match', async () => {
  const r1 = await mkRoom(A, 'Ann');
  const r2 = await mkRoom(B, 'Zed');
  const bob = await joinAs(A, r1.code, 'Bob'); await bob.wait((m) => m.t === 'joined');
  await bob.drop();
  const other = await joinAs(A, r2.code, 'Bob'); // new slot in room 2, not Bob's old one
  const j = await other.wait((m) => m.t === 'joined');
  assert.notEqual(j.id, bob.id);
  const bob2 = await joinAs(A, r1.code, 'Bob');
  assert.equal((await bob2.wait((m) => m.t === 'joined')).id, bob.id);
  [r1, r2, other, bob2].forEach((c) => c.ws.close());
});

test('token reconnect still works and is unaffected by IP', async () => {
  const host = await mkRoom(A, 'Ann');
  const bob = await joinAs(B, host.code, 'Bob'); await bob.wait((m) => m.t === 'joined');
  await bob.drop();
  const r = await mk('192.0.2.77', { t: 'resume', code: host.code, token: bob.token });
  assert.equal((await r.wait((m) => m.t === 'joined')).id, bob.id);
  [host, r].forEach((c) => c.ws.close());
});

test('spoofed X-Real-IP from untrusted source is ignored; fallback fails closed', async () => {
  const host = await mkRoom(A, 'Ann', plain);
  const bob = await joinAs(B, host.code, 'Bob', plain); await bob.wait((m) => m.t === 'joined');
  await bob.drop();
  const again = await joinAs(B, host.code, 'Bob', plain);
  assert.match((await again.wait((m) => m.t === 'error')).msg, /taken/i);
  // token path still works when no trustworthy IP
  const r = await mk(null, { t: 'resume', code: host.code, token: bob.token }, plain);
  assert.equal((await r.wait((m) => m.t === 'joined')).id, bob.id);
  [host, again, r].forEach((c) => c.ws.close());
});

test('missing or non-public proxy header fails closed', async () => {
  const host = await mkRoom(A, 'Ann');
  const bob = await joinAs(null, host.code, 'Bob'); await bob.wait((m) => m.t === 'joined');
  await bob.drop();
  assert.ok((await (await joinAs(null, host.code, 'Bob')).wait((m) => m.t === 'error')));
  for (const bad of ['10.1.2.3', '127.0.0.1', 'garbage', '203.0.113.7, 10.0.0.1']) {
    const c = await joinAs(bad, host.code, 'Bob');
    assert.match((await c.wait((m) => m.t === 'error')).msg, /taken/i, bad);
  }
  host.ws.close();
});

test('clientIp: header trusted only from private/loopback peer, XFF never used, rejects private result', () => {
  const req = (peer, h) => ({ socket: { remoteAddress: peer }, headers: h });
  assert.equal(clientIp(req('10.42.0.5', { 'x-real-ip': A }), true), A);
  assert.equal(clientIp(req('::ffff:10.42.0.5', { 'x-real-ip': A }), true), A);
  assert.equal(clientIp(req('8.8.8.8', { 'x-real-ip': A }), true), '8.8.8.8'); // public peer: header ignored
  assert.equal(clientIp(req('10.42.0.5', { 'x-forwarded-for': A }), true), null);
  assert.equal(clientIp(req('10.42.0.5', { 'x-real-ip': A }), false), null); // ingress IP is not a client
  assert.equal(clientIp(req('10.42.0.5', {}), true), null);
  assert.equal(clientIp(req('10.42.0.5', { 'x-real-ip': '192.168.1.4' }), true), null);
});
