'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { accept } = require('./ws');
const { Game } = require('./game');

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/geom.js': ['geom.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const net = require('node:net');
// Public-routable only: anything private/loopback/link-local/CGNAT/ULA is never a usable client identity.
function isPublicIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
  }
  if (v === 6) { const l = ip.toLowerCase(); return !(l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('::ffff:')); }
  return false;
}
const isPrivatePeer = (ip) => net.isIP(ip) !== 0 && !isPublicIp(ip);
// Observed client address, or null (fail closed). X-Real-IP is honoured only when the TCP peer is a
// private/loopback address (the in-cluster ingress-nginx, which overwrites it with $remote_addr and is
// not configured with use-forwarded-headers). X-Forwarded-For is never read. Ingress/pod IPs yield null.
function clientIp(req, trustProxy = true) {
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
  if (isPublicIp(peer)) return peer;
  if (!trustProxy || !isPrivatePeer(peer)) return null;
  const h = req.headers['x-real-ip'];
  return typeof h === 'string' && isPublicIp(h.trim()) ? h.trim() : null;
}
const MAX_MSG = 4096, MAX_PER_IP = 24;
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' wss: ws:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" };

function bucket(cap, perSec) {
  let tokens = cap, last = Date.now();
  return () => { const n = Date.now(); tokens = Math.min(cap, tokens + (n - last) * perSec / 1000); last = n; if (tokens < 1) return false; tokens--; return true; };
}

function start(port, opts = {}) {
  const trustProxy = opts.trustProxy !== false;
  const pub = {};
  for (const [url, [f, type]] of Object.entries(FILES)) pub[url] = { body: fs.readFileSync(path.join(__dirname, 'public', f)), type };
  const game = new Game();
  const perIp = new Map();
  const socks = new Set();

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url === '/version') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ sha: process.env.GIT_SHA || 'dev' })); }
    if (url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    const f = req.method === 'GET' || req.method === 'HEAD' ? pub[url] : null;
    if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': f.type, 'cache-control': 'no-cache', ...SEC });
    res.end(req.method === 'HEAD' ? undefined : f.body);
  });

  server.on('upgrade', (req, socket) => {
    const host = req.headers.host, origin = req.headers.origin;
    let okOrigin = true;
    if (origin) { try { okOrigin = new URL(origin).host === host; } catch { okOrigin = false; } }
    const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
    if ((req.url || '').split('?')[0] !== '/ws' || !okOrigin || (perIp.get(ip) || 0) >= MAX_PER_IP) {
      return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    socks.add(socket); socket.on('close', () => socks.delete(socket));
    const observed = clientIp(req, trustProxy);
    let room = null, player = null;
    const general = bucket(80, 60), guessB = bucket(4, 1), joinB = bucket(5, 0.2);
    let warned = 0;
    const conn = accept(req, socket, {
      maxPayload: MAX_MSG,
      onClose: () => {
        perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1));
        if (room && player && player.send === send) room.detach(player, Date.now());
      },
      onMessage: (raw) => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
        const throttle = () => { if (Date.now() - warned > 1000) { warned = Date.now(); send(JSON.stringify({ t: 'error', msg: 'Slow down' })); } };
        if (!general() || (m.t === 'guess' && !guessB())) return throttle();
        const now = Date.now();
        if (!player) {
          if (!['create', 'join', 'resume'].includes(m.t)) return;
          if (!joinB()) return throttle();
          return enter(m, now);
        }
        room.handle(player, m, now);
      },
    });
    if (!conn) { perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1)); return; }
    const send = (s) => conn.send(s);
    const fail = (msg) => send(JSON.stringify({ t: 'error', msg }));
    const pinger = setInterval(() => { if (conn.idleMs() > 70000) conn.close(1001); else conn.ping(); }, 25000);
    socket.on('close', () => clearInterval(pinger));

    function enter(m, now) {
      let r, p, rejoin = false;
      if (m.t === 'create') {
        r = game.create(now);
        if (!r) return fail('Server busy, try later');
        const j = r.join(String(m.name ?? ''), now);
        if (j.err) { game.rooms.delete(r.code); return fail(j.err); }
        p = j.p;
      } else {
        r = game.get(m.code);
        if (!r) return fail('No such room');
        if (m.t === 'join') {
          const name = String(m.name ?? '');
          const back = r.rejoinByIp(name, observed);
          if (back) { p = back; rejoin = true; }
          else {
            const j = r.join(name, now);
            if (j.err) return fail(j.err);
            p = j.p;
          }
        } else {
          p = r.resume(String(m.token ?? ''));
          if (!p) return fail('Session expired');
          if (p.send) p.send(JSON.stringify({ t: 'error', msg: 'Signed in elsewhere' }));
        }
      }
      room = r; player = p;
      send(JSON.stringify({ t: 'joined', code: r.code, id: p.id, token: p.token }));
      p.ip = observed;
      r.attach(p, send, now);
      if (m.t === 'join' && !rejoin) r.sendAll({ t: 'chat', m: r.chat[r.chat.length - 1] }, p);
    }
  });

  const timer = setInterval(() => game.tick(Date.now()), 250);
  return new Promise((resolve) => {
    server.listen(port, () => resolve({
      port: server.address().port, game,
      close: () => { clearInterval(timer); server.close(); server.closeAllConnections?.(); for (const s of socks) s.destroy(); },
    }));
  });
}

module.exports = { start, clientIp };
if (require.main === module) {
  start(+process.env.PORT || 8080).then((s) => console.log('doodle-dash listening on', s.port));
}
