'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { accept } = require('./ws');
const { Game } = require('./game');
const { TOPICS } = require('./words');
const { createSession, createMatchmaker } = require('./session');
const { Analytics, clean } = require('./analytics');
const { openStore } = require('./store');
const { authorized, adminPage } = require('./admin');
const { makeNotifier } = require('./notifier');

const { FILES, SEC } = require('./static-files');
const net = require('node:net');
const { isPublicIp } = require('./ip');
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

const { makeExportHandler } = require('./export');

function start(port, opts = {}) {
  const trustProxy = opts.trustProxy !== false;
  const qa = opts.qa ?? (process.env.NODE_ENV === 'test' || process.env.APP_ENV === 'qa' || (!process.env.FLY_APP_NAME && process.env.APP_ENV !== 'production'));
  const pub = {};
  for (const [url, [f, type]] of Object.entries(FILES)) pub[url] = { body: fs.readFileSync(path.join(__dirname, 'public', f)), type };
  const dataDir = opts.dataDir ?? process.env.DATA_DIR, store = openStore(dataDir, { log: (...a) => console.error('[doodle]', ...a) });
  const analytics = new Analytics({ store, enabled: opts.analyticsEnabled ?? process.env.NODE_ENV !== 'test', qa, log: (...a) => console.error('[doodle]', ...a) });
  const notifier = makeNotifier({ baseUrl: opts.ntfyBaseUrl ?? process.env.NTFY_BASE_URL, topic: opts.ntfyTopic ?? process.env.NTFY_TOPIC ?? 'crayon_breath', fetchImpl: opts.fetchImpl, enabled: !qa && (opts.alertsEnabled ?? process.env.NTFY_ALERTS_ENABLED === 'true'), log: (...a) => console.error('[doodle]', ...a) });
  const game = new Game({ store, analytics, onGameStart: (event) => { void notifier.sendGameStart(event); }, log: (...a) => console.error('[doodle]', ...a) });
  const perIp = new Map();
  const maxPerIp = opts.maxPerIp ?? MAX_PER_IP;
  const maxSockets = opts.maxSockets ?? (+process.env.MAX_SOCKETS || MAX_SOCKETS);
  const mm = createMatchmaker({ game, analytics, firstMs: opts.lobbyFirstMs ?? (+process.env.LOBBY_FIRST_MS || undefined),
    resetMs: opts.lobbyResetMs ?? (+process.env.LOBBY_RESET_MS || undefined), onPublicStart: opts.onPublicStart });
  const socks = new Set();

  const exportToken = Object.hasOwn(opts, 'exportToken') ? opts.exportToken : process.env.DOODLE_EXPORT_TOKEN;
  const exportHandler = makeExportHandler({ store, token: exportToken });
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
      const records = analytics.records();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ summary: analytics.summary(records), operations: analytics.operations(records), health: analytics.health({ ...runtime(), activePlayers }) }));
    }
    if (url === '/admin/drawings.json' || /^\/admin\/drawings\/[0-9a-f]{8}\.json$/.test(url)) { // private best/worst archive, bearer token only
      if (!authorized(req, exportToken)) { res.writeHead(exportToken ? 401 : 404, { 'cache-control': 'no-store' }); return res.end(exportToken ? 'unauthorized' : 'not found'); }
      const arc = game.ctx.archive;
      const body = url === '/admin/drawings.json' ? { stats: arc.stats(), games: arc.list() } : arc.read(url.slice(16, 24));
      res.writeHead(body ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(body || { error: 'not found' }));
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
    let session = null;
    const conn = accept(req, socket, {
      maxPayload: MAX_MSG,
      onClose: () => {
        const left = (perIp.get(ip) || 1) - 1;
        if (left > 0) perIp.set(ip, left); else perIp.delete(ip);
        session?.close();
      },
      onMessage: (raw) => session.message(raw),
    });
    if (!conn) { perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1)); return; }
    session = createSession({ game, mm, analytics }, { send: (s) => conn.send(s), observed, location: coarseLocation(req, trustProxy) });
    const pinger = setInterval(() => { if (conn.idleMs() > 70000) conn.close(1001); else conn.ping(); }, 25000);
    socket.on('close', () => clearInterval(pinger));
  });

  function runtime() {
    return { openSockets: socks.size, activeRooms: game.rooms.size,
      activePlayers: [...game.rooms.values()].reduce((n, r) => n + r.connected.length, 0),
      publicQueue: mm.lobbies.reduce((n, l) => n + l.members.length, 0), ntfyConfigured: notifier.configured, ntfy: { ...notifier.status }, qa };
  }
  const timer = setInterval(() => { analytics.tick(); game.tick(Date.now()); }, 250);
  const sampleTimer = setInterval(() => analytics.sample(runtime()), opts.sampleMs ?? 60000);
  return new Promise((resolve) => {
    server.listen(port, () => resolve({
      port: server.address().port, game, mm, analytics,
      close: () => { clearInterval(timer); clearInterval(sampleTimer); mm.close(); game.shutdown(); store?.close(); server.close(); server.closeAllConnections?.(); for (const s of socks) s.destroy(); },
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
