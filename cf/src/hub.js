// Single SQLite-backed Durable Object hosting every room, the public lobby, analytics, history, adaptive tiers and the
// best/worst archive. It runs the SAME synchronous game core, services and client sessions as the Node host (server.js).
// Why one object: the core's services (topic reservation across rooms, history sequence, adaptive tiers) are synchronous
// and global; a Durable Object has exactly that single-writer, synchronous SQL model, and the app caps rooms at 100.
// Live room state lives in memory (as on Fly). Hibernation: sockets are hibernatable, each socket's seat is kept in its
// attachment, and one small snapshot row per room is written at phase/membership changes so a woken object can rebuild.
import { DurableObject } from 'cloudflare:workers';
import { createHmac, randomBytes } from 'node:crypto';
import { Game } from '../../game.js';
import { Analytics } from '../../analytics.js';
import { createSession, createMatchmaker } from '../../session.js';
import { authorized, adminPage } from '../../admin.js';
import { makeNotifier } from '../../notifier.js';
import { buildArchive } from '../../export.js';
import { TOPICS } from '../../words.js';
import { isPublicIp } from '../../ip.js';
import { SEC } from '../../static-files.js';
import { DoStore } from './do-store.js';

const MAX_MSG = 4096, MAX_PER_IP = 40, MAX_SOCKETS = 600, IDLE_ALARM_MS = 11 * 60 * 1000, TIMED = new Set(['choosing', 'drawing', 'roundEnd']);
const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
const plain = (status, msg, extra = {}) => new Response(msg, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store', ...extra } });
const num = (v) => (+v || undefined);

export class GameHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.log = (...a) => console.error('[doodle]', ...a);
    this.store = new DoStore(ctx.storage, this.log);
    this.qa = env.APP_ENV !== 'production';
    this.exportToken = env.DOODLE_EXPORT_TOKEN;
    this.exportBucket = { tokens: 6, last: Date.now() };
    if (!this.store.getMeta('ip_salt')) this.store.setMeta('ip_salt', randomBytes(16).toString('hex'));
    this.ipSalt = this.store.getMeta('ip_salt');
    this.lastSample = 0;
    this.interval = null;
    this.fingerprints = new Map();
    this.build();
    ctx.blockConcurrencyWhile(async () => this.restore());
  }

  // Fresh in-memory game world over the durable store.
  build() {
    const analytics = this.analytics = new Analytics({ store: this.store, enabled: true, qa: this.qa, log: this.log });
    this.notifier = makeNotifier({ baseUrl: this.env.NTFY_BASE_URL, topic: this.env.NTFY_TOPIC || 'crayon_breath', enabled: !this.qa && this.env.NTFY_ALERTS_ENABLED === 'true', log: this.log });
    this.game = new Game({ store: this.store, analytics, onGameStart: (e) => { void this.notifier.sendGameStart(e); }, log: this.log });
    this.mm = createMatchmaker({ game: this.game, analytics, firstMs: num(this.env.LOBBY_FIRST_MS), resetMs: num(this.env.LOBBY_RESET_MS),
      setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (t) => clearTimeout(t) });
    this.sessions = new Map(); // WebSocket -> session
    this.fingerprints.clear();
  }

  // Rebuild rooms from their snapshot rows and re-bind every live socket to its seat (cold start or wake from hibernation).
  restore() {
    const now = Date.now();
    this.log('hub start: restoring', this.store.loadRooms().length, 'room snapshot(s),', this.ctx.getWebSockets().length, 'socket(s)');
    for (const { code, snap } of this.store.loadRooms()) {
      try { this.game.restore(code, JSON.parse(snap), now); } catch (e) { this.log('room restore failed', code, e.message); this.store.delRoom(code); }
    }
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      const session = this.makeSession(ws, att);
      this.sessions.set(ws, session);
      const room = att.code && this.game.get(att.code), player = room && room.state.players.find((p) => p.id === att.pid);
      if (player) session.rebind(room, player);
      else if (att.q) session.requeue(att.q);
      else if (att.code) { try { ws.close(1011, 'session lost'); } catch { /* already closed */ } }
    }
    this.afterEvent();
  }
  // Test hook: simulate eviction by discarding all in-memory state and rebuilding from storage and attachments.
  evictForTest() { if (this.interval) { clearInterval(this.interval); this.interval = null; } this.mm.close(); this.build(); this.restore(); }

  makeSession(ws, att) {
    const send = (s) => { try { ws.send(s); } catch { /* socket closed */ } };
    const session = createSession({ game: this.game, mm: this.mm, analytics: this.analytics }, {
      send, observed: att.observed || null, location: att.location || {}, identity: att.identity,
      onBound: () => { try { ws.serializeAttachment({ ipk: att.ipk, location: att.location, ...session.snapshot() }); } catch { /* socket closed */ } },
    });
    return session;
  }

  ipKey(ip) { return createHmac('sha256', this.ipSalt).update(String(ip || 'unknown')).digest('hex').slice(0, 16); }

  async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path === '/ws') return this.upgrade(request);
    if (path === '/stats') {
      return json(200, { topics: TOPICS.length, tiers: this.game.ctx.topics.counts(), history: this.game.ctx.history.stats(), selection: this.game.ctx.topics.stats });
    }
    if (path === '/admin/analytics') return new Response(adminPage(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SEC } });
    const auth = () => authorized({ headers: { authorization: request.headers.get('authorization') || '' } }, this.exportToken);
    const denied = () => plain(this.exportToken ? 401 : 404, this.exportToken ? 'unauthorized' : 'not found');
    if (path === '/admin/analytics.json') {
      if (!auth()) return denied();
      this.analytics.sample(this.runtime()); // current process-level sample so the dashboard is never empty
      const records = this.analytics.records();
      return json(200, { summary: this.analytics.summary(records), operations: this.analytics.operations(records), health: this.analytics.health(this.runtime()) });
    }
    if (path === '/admin/drawings.json' || /^\/admin\/drawings\/[0-9a-f]{8}\.json$/.test(path)) {
      if (!auth()) return denied();
      const arc = this.game.ctx.archive;
      const body = path === '/admin/drawings.json' ? { stats: arc.stats(), games: arc.list() } : arc.read(path.slice(16, 24));
      return json(body ? 200 : 404, body || { error: 'not found' });
    }
    if (path === '/admin/export') {
      if (!this.exportToken) return plain(404, 'not found');
      if (request.method !== 'GET') return plain(405, 'method not allowed');
      const b = this.exportBucket, n = Date.now();
      b.tokens = Math.min(6, b.tokens + (n - b.last) * 6 / 60000); b.last = n;
      if (b.tokens < 1) return plain(429, 'rate limited');
      b.tokens--;
      if (!auth()) return plain(401, 'unauthorized');
      let body;
      try { body = buildArchive(this.store); } catch (e) { this.log('export failed', e.message); return plain(500, 'export failed'); }
      return new Response(body, { headers: { 'content-type': 'application/gzip', 'content-length': String(body.length), 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="doodle-export.tar.gz"' } });
    }
    return plain(404, 'not found');
  }

  upgrade(request) {
    if (request.headers.get('upgrade') !== 'websocket') return plain(404, 'not found');
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= (num(this.env.MAX_SOCKETS) || MAX_SOCKETS)) return new Response(null, { status: 503, headers: { 'retry-after': '30' } });
    // x-hub-* headers are set by the public Worker only (it strips any client-supplied copy). Never persist the raw IP.
    const ip = request.headers.get('x-hub-ip') || '';
    const ipk = this.ipKey(ip);
    const perIp = num(this.env.MAX_PER_IP) || MAX_PER_IP;
    let used = 0;
    for (const s of sockets) if ((s.deserializeAttachment() || {}).ipk === ipk) used++;
    if (used >= perIp) return plain(403, 'forbidden');
    const location = {};
    const c = (request.headers.get('x-hub-country') || '').toUpperCase(), r = (request.headers.get('x-hub-region') || '').toUpperCase();
    if (/^[A-Z]{2}$/.test(c)) location.country = c;
    if (/^[A-Z0-9-]{1,12}$/.test(r)) location.region = r;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const att = { ipk, location, observed: isPublicIp(ip) ? ip : null };
    // observed IP lives only in this socket's in-memory attachment (never in SQL); lost on eviction, so IP-fallback reconnect needs a live object.
    server.serializeAttachment(att);
    const session = this.makeSession(server, att);
    this.sessions.set(server, session);
    return new Response(null, { status: 101, webSocket: client });
  }

  sessionFor(ws) {
    let s = this.sessions.get(ws);
    if (!s) { s = this.makeSession(ws, ws.deserializeAttachment() || {}); this.sessions.set(ws, s); }
    return s;
  }
  webSocketMessage(ws, message) {
    if (typeof message !== 'string') return ws.close(1003, 'text only');
    if (new TextEncoder().encode(message).length > MAX_MSG) return ws.close(1009, 'too big');
    this.sessionFor(ws).message(message);
    this.afterEvent();
  }
  webSocketClose(ws) { this.drop(ws); try { ws.close(1000); } catch { /* already closed */ } }
  webSocketError(ws) { this.drop(ws); }
  drop(ws) { const s = this.sessions.get(ws); this.sessions.delete(ws); if (s) s.close(); this.afterEvent(); }

  runtime() {
    const rooms = [...this.game.rooms.values()];
    return { openSockets: this.ctx.getWebSockets().length, activeRooms: rooms.length, activePlayers: rooms.reduce((n, r) => n + r.connected.length, 0),
      publicQueue: this.mm.lobbies.reduce((n, l) => n + l.members.length, 0), ntfyConfigured: this.notifier.configured, ntfy: { ...this.notifier.status }, qa: this.qa,
      storage: { rowsWritten: this.store.rowsWritten, rowsRead: this.store.rowsRead } };
  }

  tick() {
    const now = Date.now();
    this.analytics.tick();
    this.game.tick(now);
    if (now - this.lastSample >= 60000) { this.lastSample = now; this.analytics.sample(this.runtime()); }
    this.afterEvent();
  }

  // After any event: persist changed room snapshots, drop retired rooms, and arm/disarm timers.
  afterEvent() {
    const now = Date.now(), live = new Set();
    for (const [code, r] of this.game.rooms) {
      live.add(code);
      const fp = `${r.phase}|${r.drawn}|${r.rotation}|${r.players.length}|${r.connected.length}|${r.hostId}|${r.chat.length}|${r.rotations}|${r.public}`;
      if (this.fingerprints.get(code) !== fp) {
        this.fingerprints.set(code, fp);
        try { this.store.putRoom(code, JSON.stringify(r.snapshot()), now); } catch (e) { this.log('room snapshot failed', code, e.message); }
      }
    }
    for (const code of [...this.fingerprints.keys()]) if (!live.has(code)) { this.fingerprints.delete(code); this.store.delRoom(code); }
    const timed = [...this.game.rooms.values()].some((r) => TIMED.has(r.phase));
    if (timed && !this.interval) this.interval = setInterval(() => this.tick(), 250);
    else if (!timed && this.interval) { clearInterval(this.interval); this.interval = null; }
    // Idle rooms (lobby/game over, no timers) let the object hibernate; one alarm retires them if everyone leaves.
    if (!timed && this.game.rooms.size) this.ctx.storage.getAlarm().then((a) => { if (a === null) return this.ctx.storage.setAlarm(Date.now() + IDLE_ALARM_MS); });
  }
  async alarm() { this.game.tick(Date.now()); this.afterEvent(); }
}
