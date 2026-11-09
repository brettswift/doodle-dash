'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, resolveClient } = require('../server');

const fake = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test('private peer: CF-Connecting-IP wins, then Fly-Client-IP, then X-Real-IP', () => {
  const h = { 'cf-connecting-ip': '203.0.113.1', 'fly-client-ip': '198.51.100.2', 'x-real-ip': '192.0.2.3' };
  assert.equal(resolveClient(fake('172.16.0.5', h)), '203.0.113.1');
  delete h['cf-connecting-ip'];
  assert.equal(resolveClient(fake('172.16.0.5', h)), '198.51.100.2');
  delete h['fly-client-ip'];
  assert.equal(resolveClient(fake('172.16.0.5', h)), '192.0.2.3');
  assert.equal(resolveClient(fake('172.16.0.5')), '172.16.0.5');
});

test('invalid header falls through; public peer ignores spoofed headers', () => {
  assert.equal(resolveClient(fake('172.16.0.5', { 'cf-connecting-ip': 'nope', 'fly-client-ip': '198.51.100.2' })), '198.51.100.2');
  assert.equal(resolveClient(fake('203.0.113.50', { 'cf-connecting-ip': '198.51.100.9', 'x-real-ip': '198.51.100.8' })), '203.0.113.50');
  assert.equal(resolveClient(fake('172.16.0.5', { 'cf-connecting-ip': '198.51.100.9' }), false), '172.16.0.5');
});

const open = (port, headers) => new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  ws.onopen = () => res({ ok: true, ws });
  ws.onerror = (e) => res({ ok: false, msg: String(e.message || e.error?.message || '') });
});

test('loopback peer (private): separate buckets per CF-Connecting-IP, per-client cap, global 503', async () => {
  const srv = await start(0, { maxPerIp: 2, maxSockets: 5 });
  const open_ = [];
  try {
    for (const ip of ['203.0.113.1', '203.0.113.1', '203.0.113.2', '203.0.113.2']) {
      const r = await open(srv.port, { 'cf-connecting-ip': ip }); assert.ok(r.ok, ip); open_.push(r.ws);
    }
    assert.equal((await open(srv.port, { 'cf-connecting-ip': '203.0.113.1' })).ok, false, 'third from same client refused');
    const fifth = await open(srv.port, { 'cf-connecting-ip': '203.0.113.3' }); assert.ok(fifth.ok); open_.push(fifth.ws);
    assert.equal((await open(srv.port, { 'cf-connecting-ip': '203.0.113.4' })).ok, false, 'global cap refuses');
    // raw status check for 503
    const net = require('node:net');
    const status = await new Promise((res) => {
      const s = net.connect(srv.port, '127.0.0.1', () => s.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCF-Connecting-IP: 203.0.113.9\r\n\r\n'));
      s.once('data', (d) => { res(String(d).split('\r\n')[0]); s.destroy(); });
    });
    assert.match(status, /503/);
  } finally { for (const w of open_) w.close(); srv.close(); }
});
