'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { accept } = require('./ws');
const { Game, NAME_RE } = require('./game');
const { TOPICS } = require('./words');
const { Matchmaker } = require('./lobby');
const { Analytics, anonId, clean } = require('./analytics');
const { authorized, adminPage } = require('./admin');
const PUBLIC_ROUNDS = 3; // quick game: 3 rounds, each round every player draws once

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/geom.js': ['geom.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/privacy': ['privacy.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/fonts/Schoolbell-400.woff2': ['fonts/Schoolbell-400.woff2', 'font/woff2'],
  '/fonts/PatrickHand-400.woff2': ['fonts/PatrickHand-400.woff2', 'font/woff2'],
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
// Real client address, or null (fail closed). Forwarding headers are honoured only when the TCP peer is a
// private/loopback address (Fly proxy, in-cluster ingress); a public peer is always its own identity.
// Order: CF-Connecting-IP (Cloudflare), Fly-Client-IP, X-Real-IP; each must pass net.isIP. X-Forwarded-For is never read.
function resolveClient(req, trustProxy = true) {
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
  if (!trustProxy || !isPrivatePeer(peer)) return net.isIP(peer) ? peer : null;
  for (const name of ['cf-connecting-ip', 'fly-client-ip', 'x-real-ip']) {
    const h = req.headers[name];
    if (typeof h === 'string' && net.isIP(h.trim())) return h.trim().replace(/^::ffff:/i, '');
  }
  return peer || null;
}
// Observed public client address for reconnect matching, or null. Never logged or persisted.
function clientIp(req, trustProxy = true) {
  const ip = resolveClient(req, trustProxy);
  return ip && isPublicIp(ip) ? ip : null;
}
function coarseLocation(req, trustProxy = true) {
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
  if (!trustProxy || !isPrivatePeer(peer)) return {};
  const country = clean(req.headers['cf-ipcountry'], 3).toUpperCase();
  const region = clean(req.headers['cf-region-code'], 12).toUpperCase();
  return { country: /^[A-Z]{2}$/.test(country) ? country : undefined, region: /^[A-Z0-9-]{1,12}$/.test(region) ? region : undefined };
}
const MAX_MSG = 4096, MAX_PER_IP = 40, MAX_SOCKETS = 600;
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' wss: ws:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" };

const { makeExportHandler } = require('./export');

function bucket(cap, perSec) {
  let tokens = cap, last = Date.now();
  return () => { const n = Date.now(); tokens = Math.min(cap, tokens + (n - last) * perSec / 1000); last = n; if (tokens < 1) return false; tokens--; return true; };
}

function start(port, opts = {}) {
  const trustProxy = opts.trustProxy !== false;
  const pub = {};
  for (const [url, [f, type]] of Object.entries(FILES)) pub[url] = { body: fs.readFileSync(path.join(__dirname, 'public', f)), type };
  const analytics = new Analytics({ dir: opts.dataDir ?? process.env.DATA_DIR, enabled: opts.analyticsEnabled ?? process.env.NODE_ENV !== 'test', log: (...a) => console.error('[doodle]', ...a) });
  const game = new Game({ dataDir: opts.dataDir ?? process.env.DATA_DIR, analytics, log: (...a) => console.error('[doodle]', ...a) });
  const perIp = new Map();
  const maxPerIp = opts.maxPerIp ?? MAX_PER_IP;
  const maxSockets = opts.maxSockets ?? (+process.env.MAX_SOCKETS || MAX_SOCKETS);
  // Public lobby: members are connection handles {name, send, enterRoom}. A started lobby becomes a normal
  // room with rounds = 3 and is started at once by the server; nobody else can join it by code.
  const mm = new Matchmaker({
    firstMs: opts.lobbyFirstMs ?? (+process.env.LOBBY_FIRST_MS || undefined),
    resetMs: opts.lobbyResetMs ?? (+process.env.LOBBY_RESET_MS || undefined),
    onUpdate: (l) => {
      const s = JSON.stringify({ t: 'public', n: l.members.length, max: mm.size, remaining: mm.remainingMs(l) });
      for (const m of l.members) m.send(s);
    },
    onStart: (members) => {
      const now = Date.now(), r = game.create(now);
      if (!r) { for (const m of members) m.failPublic('Server busy, try later'); return; }
      r.public = true; r.rotations = PUBLIC_ROUNDS;
      const taken = new Set();
      const seats = members.map((m) => {
        let name = m.name, k = 1;
        while (taken.has(name.toLowerCase())) { k++; name = m.name.slice(0, 11).trim() + ' ' + k; }
        taken.add(name.toLowerCase());
        return [m, r.join(name, now).p];
      });
      for (const [m, p] of seats) m.enterRoom(r, p, now);
      r.handle(r.players.find((p) => p.id === r.hostId), { t: 'start' }, now);
      analytics.event('lobbyFormed', { mode: 'public', players: seats.length });
      opts.onPublicStart?.(r);
    },
  });
  const socks = new Set();

  const exportToken = Object.hasOwn(opts, 'exportToken') ? opts.exportToken : process.env.DOODLE_EXPORT_TOKEN;
  const exportHandler = makeExportHandler({ dir: opts.dataDir ?? process.env.DATA_DIR, token: exportToken });
  const server = http.createServer((req, res) => {
    if (exportHandler(req, res)) return;
    const url = (req.url || '').split('?')[0];
    if (url === '/version') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ sha: process.env.GIT_SHA || 'dev' })); }
    if (url === '/stats') { // public, aggregate and anonymous: no tokens, names, room codes or per-drawing data
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ topics: TOPICS.length, tiers: game.ctx.topics.counts(), history: game.ctx.history.stats(), selection: game.ctx.topics.stats }));
    }
    if (url === '/admin/analytics') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SEC }); return res.end(adminPage()); }
    if (url === '/admin/analytics.json') {
      if (!authorized(req, exportToken)) { res.writeHead(exportToken ? 401 : 404, { 'cache-control': 'no-store' }); return res.end(exportToken ? 'unauthorized' : 'not found'); }
      const activePlayers = [...game.rooms.values()].reduce((n, r) => n + r.connected.length, 0);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ summary: analytics.summary(), health: analytics.health({ openSockets: socks.size, activeRooms: game.rooms.size, activePlayers, publicQueue: mm.lobbies.reduce((n, l) => n + l.members.length, 0) }) }));
    }
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
    const ip = resolveClient(req, trustProxy) || 'unknown';
    if (socks.size >= maxSockets) {
      return socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 30\r\nConnection: close\r\n\r\n');
    }
    if ((req.url || '').split('?')[0] !== '/ws' || !okOrigin || (perIp.get(ip) || 0) >= maxPerIp) {
      return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    socks.add(socket); socket.on('close', () => socks.delete(socket));
    const observed = clientIp(req, trustProxy);
    let room = null, player = null, waiting = null, identity = null;
    const general = bucket(80, 60), guessB = bucket(4, 1), joinB = bucket(5, 0.2);
    let warned = 0;
    const conn = accept(req, socket, {
      maxPayload: MAX_MSG,
      onClose: () => {
        const left = (perIp.get(ip) || 1) - 1;
        if (left > 0) perIp.set(ip, left); else perIp.delete(ip);
        if (waiting) { analytics.event('queueLeft', identity || {}); mm.leave(waiting); waiting = null; }
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
          if (m.t === 'analytics' && !identity) {
            if (m.consent !== true) return;
            identity = { browserId: anonId(m.browserId), sessionId: anonId(m.sessionId), timezone: clean(m.timezone, 64), language: clean(m.language, 32), ...coarseLocation(req, trustProxy) };
            analytics.event('landing', identity); return;
          }
          if (m.t === 'leavePublic') { if (waiting) { analytics.event('queueLeft', identity || {}); mm.leave(waiting); waiting = null; send(JSON.stringify({ t: 'publicLeft' })); } return; }
          if (!['create', 'join', 'resume', 'public'].includes(m.t) || waiting) return;
          if (!joinB()) return throttle();
          if (m.t === 'public') return queue(m);
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

    // Validation and placement happen in one synchronous step (no await between count check and add).
    function queue(m) {
      const name = String(m.name ?? '').trim();
      if (!NAME_RE.test(name)) return fail('Name: 1-14 letters, numbers, spaces');
      waiting = {
        name, send,
        failPublic: (msg) => { waiting = null; fail(msg); },
        enterRoom: (r, p, now) => {
          waiting = null; room = r; player = p; p.ip = observed;
          send(JSON.stringify({ t: 'joined', code: r.code, id: p.id, token: p.token, public: true }));
          r.attach(p, send, now);
        },
      };
      mm.join(waiting);
      if (identity) analytics.event('queueEntered', { ...identity, name, mode: 'public' });
    }

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
          else if (r.public) return fail('That is a public game; use Public lobby');
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
      if (identity) {
        p.analytics = identity;
        analytics.event('nameEntered', { ...identity, name: p.name, mode: r.public ? 'public' : 'private' });
        analytics.event('intent', { ...identity, mode: m.t === 'create' ? 'private-create' : m.t === 'join' ? 'private-join' : 'resume' });
      }
      send(JSON.stringify({ t: 'joined', code: r.code, id: p.id, token: p.token }));
      p.ip = observed;
      r.attach(p, send, now);
      if (m.t === 'join' && !rejoin) r.sendAll({ t: 'chat', m: r.chat[r.chat.length - 1] }, p);
    }
  });

  const timer = setInterval(() => { analytics.tick(); game.tick(Date.now()); }, 250);
  return new Promise((resolve) => {
    server.listen(port, () => resolve({
      port: server.address().port, game, mm, analytics,
      close: () => { clearInterval(timer); mm.close(); game.shutdown(); server.close(); server.closeAllConnections?.(); for (const s of socks) s.destroy(); },
    }));
  });
}

module.exports = { start, clientIp, resolveClient };
if (require.main === module) {
  start(+process.env.PORT || 8080).then((s) => {
    console.log('doodle-dash listening on', s.port, process.env.DATA_DIR ? `data=${process.env.DATA_DIR}` : '(no DATA_DIR: history not persisted)');
    const stop = () => { s.close(); setTimeout(() => process.exit(0), 200); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  });
}
