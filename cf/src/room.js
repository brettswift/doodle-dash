// Room Durable Object: exactly one live game (one room code), its hibernatable WebSockets and one small snapshot row.
// It runs the SAME synchronous game core and client sessions as the Node host. Everything global (history sequence,
// adaptive tiers, analytics, best/worst archive, room codes, public matchmaking) lives in the Directory object:
//  - reads: a local cache of the tiers and recently drawn topics, given at creation and refreshed with each acknowledged write;
//  - writes: queued in an Outbox, sent to the Directory asynchronously with an idempotency number, retried until acknowledged.
// The core never waits for either. Live game state is in memory (as on Fly); a snapshot row is written on phase/membership changes.
import { DurableObject } from 'cloudflare:workers';
import { createHmac, randomBytes } from 'node:crypto';
import { Game } from '../../game.js';
import { Analytics } from '../../analytics.js';
import { createSession, PUBLIC_ROUNDS } from '../../session.js';
import { makeNotifier } from '../../notifier.js';
import { isPublicIp } from '../../ip.js';
import { RoomStore } from './do-store.js';
import { LocalHistory, NO_ADAPT, Outbox, makeRoomTopics } from './room-services.js';

const MAX_MSG = 4096, MAX_SOCKETS = 24, IDLE_ALARM_MS = 11 * 60 * 1000, START_WAIT_MS = 10000, RETRY_MS = [2000, 5000, 15000, 60000];
const TIMED = new Set(['choosing', 'drawing', 'roundEnd']);
const plain = (status, msg) => new Response(msg, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
const num = (v) => (+v || undefined);

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.log = (...a) => console.error('[doodle-room]', ...a);
    this.store = new RoomStore(ctx.storage);
    this.qa = env.APP_ENV !== 'production';
    // No write happens here: an object nobody initialised (e.g. a probed, unallocated room code) stays storage-free.
    this.salt = this.store.get('salt');
    this.interval = null; this.retryN = 0; this.flushing = null;
    this.build();
    ctx.blockConcurrencyWhile(async () => this.restore());
  }

  // The Directory stub; tests replace this to simulate an outage.
  dirStub() { return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('dir')); }

  build() {
    this.code = this.store.get('code');
    this.fingerprint = null; this.live = false;
    this.outbox = new Outbox();
    const analytics = new Analytics({ store: this.outbox.eventStore, enabled: true, qa: this.qa, log: this.log });
    // The Directory already recorded the visit ('landing'); the Room-side socket must not count it again.
    this.analytics = { event: (type, props) => { if (type !== 'landing') analytics.event(type, props); } };
    this.notifier = this.makeNotifier();
    this.history = new LocalHistory(this.outbox);
    this.topics = makeRoomTopics(this.history);
    this.archive = { save: (meta, sel) => { if (sel && sel.best) this.outbox.addArchive(meta, sel); return Promise.resolve('queued'); } };
    this.game = new Game({ store: null, analytics: this.analytics, onGameStart: (e) => { void this.notifier.sendGameStart(e); }, log: this.log });
    this.game.ctx = { ...this.game.ctx, history: this.history, topics: this.topics, adapt: NO_ADAPT, analytics: this.analytics, archive: this.archive };
    // Single-room facade for the shared session code: only this object's room exists, nothing can be created beyond the one the Directory allocated.
    this.facade = {
      rooms: new Map(),
      create: () => { const r = this.room(); return r && !r.players.length ? r : null; },
      get: (c) => (this.code && String(c || '').toUpperCase() === this.code ? this.room() : undefined),
    };
    this.sessions = new Map();
    this.selSent = { offers: 0, unused: 0, aged: 0, exhausted: 0, reservationFallback: 0 };
    this.pending = null;
  }
  makeNotifier() { return makeNotifier({ baseUrl: this.env.NTFY_BASE_URL, topic: this.env.NTFY_TOPIC || 'crayon_breath', enabled: !this.qa && this.env.NTFY_ALERTS_ENABLED === 'true', log: this.log }); }
  room() { return this.code ? this.game.get(this.code) : undefined; }

  restore() {
    const now = Date.now();
    const snap = this.code && this.store.get('snap');
    if (snap) {
      try { this.game.restore(this.code, JSON.parse(snap), now); this.live = true; } catch (e) { this.log('room restore failed', this.code, e.message); this.store.del('snap'); }
    }
    const pend = this.store.get('pend'); if (pend) this.pending = JSON.parse(pend);
    for (const k of this.store.keys('ob:')) { try { this.outbox.queue.push(JSON.parse(this.store.get(k))); } catch { this.store.del(k); } }
    this.log('room start:', this.code || '(none)', this.live ? 'restored' : 'empty', this.ctx.getWebSockets().length, 'socket(s)', this.outbox.queue.length, 'queued batch(es)');
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      const session = this.makeSession(ws, att);
      this.sessions.set(ws, session);
      const room = this.room(), player = room && room.state.players.find((p) => p.id === att.pid);
      if (player) session.rebind(room, player);
      else { try { ws.close(1011, 'session lost'); } catch { /* already closed */ } }
    }
    this.afterEvent();
    if (this.live) void this.refreshView();
    void this.flush();
  }
  // Test hook: simulate eviction by discarding all in-memory state and rebuilding from storage and attachments.
  evictForTest() { if (this.interval) { clearInterval(this.interval); this.interval = null; } this.build(); this.restore(); }

  // ----- RPC from the Directory -----
  // Create this object's room. Public rooms are pre-seated for the matched players, who then reconnect with their seat token;
  // the game starts once every seat is connected (or after a short wait with at least two).
  init({ code, view, isPublic = false, names = [] }) {
    if (!/^[A-Z]{4}$/.test(String(code))) throw new Error('bad code');
    if (this.live) throw new Error('room exists');
    const now = Date.now();
    if (!this.salt) { this.salt = randomBytes(16).toString('hex'); this.store.set('salt', this.salt); }
    this.code = code; this.store.set('code', code);
    this.history.load(view);
    const r = this.game.open(code, now); this.live = true;
    let seats = [];
    if (isPublic) {
      r.public = true; r.rotations = PUBLIC_ROUNDS;
      seats = names.map((name) => { const j = r.join(name, now); if (j.err) throw new Error(j.err); return { name, id: j.p.id, token: j.p.token }; });
      this.pending = { n: seats.length, by: now + START_WAIT_MS }; this.store.set('pend', JSON.stringify(this.pending));
    }
    this.afterEvent();
    return seats;
  }
  stats() {
    const r = this.room();
    const lobbyId = r && !r.public && r.phase === 'lobby' && !r.state.analyticsStarted ? r.gid : null;
    return { live: !!r, lobbyId, ntfy: { ...this.notifier.status }, sockets: this.ctx.getWebSockets().length, connected: r ? r.connected.length : 0, phase: r ? r.phase : null, public: r ? !!r.public : false,
      rowsWritten: this.store.rowsWritten, rowsRead: this.store.rowsRead };
  }

  makeSession(ws, att) {
    const send = (s) => { try { ws.send(s); } catch { /* socket closed */ } };
    const session = createSession({ game: this.facade, mm: { join() {}, leave() {} }, analytics: this.analytics }, {
      send, observed: att.observed || null, location: att.location || {}, identity: att.identity,
      onBound: () => { try { ws.serializeAttachment({ ipk: att.ipk, location: att.location, ...session.snapshot() }); } catch { /* socket closed */ } },
    });
    return session;
  }
  ipKey(ip) { return createHmac('sha256', this.salt).update(String(ip || 'unknown')).digest('hex').slice(0, 16); }

  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') return plain(404, 'not found');
    // Only a room the Directory allocated and initialised has a live game; anything else is refused before a socket is accepted.
    if (!this.live) return plain(404, 'not found');
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= (num(this.env.MAX_ROOM_SOCKETS) || MAX_SOCKETS)) return new Response(null, { status: 503, headers: { 'retry-after': '30' } });
    // x-hub-* headers are set by the public Worker only (it strips any client-supplied copy). Never persist the raw IP.
    const ip = request.headers.get('x-hub-ip') || '';
    const ipk = this.ipKey(ip);
    let used = 0;
    for (const s of sockets) if ((s.deserializeAttachment() || {}).ipk === ipk) used++;
    if (used >= (num(this.env.MAX_PER_IP) || 40)) return plain(403, 'forbidden');
    const location = {};
    const c = (request.headers.get('x-hub-country') || '').toUpperCase(), rg = (request.headers.get('x-hub-region') || '').toUpperCase();
    if (/^[A-Z]{2}$/.test(c)) location.country = c;
    if (/^[A-Z0-9-]{1,12}$/.test(rg)) location.region = rg;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const att = { ipk, location, observed: isPublicIp(ip) ? ip : null };
    server.serializeAttachment(att);
    this.sessions.set(server, this.makeSession(server, att));
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

  tick() { this.game.tick(Date.now()); this.afterEvent(); }

  // ----- directory delivery -----
  applyView(view) { this.history.load(view); }
  async refreshView() { try { this.applyView(await this.dirStub().view()); } catch (e) { this.log('view refresh failed', e.message); } }
  // Close the current outbox into a numbered batch. Topic-selection counters ride along only when a batch exists.
  sealBatch() {
    if (!this.outbox.pendingItems()) return null;
    const sel = {};
    for (const k of Object.keys(this.selSent)) { const d = this.topics.stats[k] - this.selSent[k]; if (d) { sel[k] = d; this.selSent[k] = this.topics.stats[k]; } }
    const b = this.outbox.seal({ src: this.code, sel });
    // Durable before the first delivery attempt, so an eviction during an outstanding RPC cannot lose completed results.
    try { this.store.set(this.obKey(b), JSON.stringify(b)); } catch (e) { this.log('outbox persist failed', e.message); }
    return b;
  }
  obKey(b) { return 'ob:' + String(b.n).padStart(20, '0'); }
  // Deliver queued batches in order. A failed batch stays queued (and persisted, so eviction cannot lose it); an alarm retries it.
  flush() {
    if (this.flushing) { this.again = true; return this.flushing; }
    const run = async () => {
      {
        do {
          this.again = false; this.sealBatch();
          while (this.outbox.queue.length) {
            const b = this.outbox.queue[0];
            let res;
            try { res = await this.dirStub().ingest(b.src || 'orphan', b); }
            catch (e) {
              this.log('directory write failed, will retry:', e.message);
              this.retryN++; await this.schedule(); return;
            }
            this.outbox.queue.shift(); this.retryN = 0;
            this.store.del(this.obKey(b));
            if (res && res.view) this.applyView(res.view);
          }
        } while (this.again);
      }
    };
    // assign before the body can finish, and clear afterwards (an async body may complete synchronously)
    this.flushing = run().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  // ----- lifecycle -----
  startPending(now) {
    const r = this.room(); if (!this.pending || !r) { this.pending = null; return; }
    const ready = r.connected.length >= this.pending.n || (now >= this.pending.by && r.connected.length >= 2);
    if (!ready) { if (now >= this.pending.by) { this.pending = null; this.store.del('pend'); } return; }
    this.pending = null; this.store.del('pend');
    const host = r.players.find((p) => p.id === r.hostId);
    if (host) r.handle(host, { t: 'start' }, now);
  }
  retire() {
    this.live = false; this.fingerprint = null;
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    this.outbox.markRetire();
    for (const k of ['snap', 'code', 'pend']) this.store.del(k);
    this.pending = null;
  }
  // After any event: start a pending public game, persist the changed snapshot, retire a finished room, arm/disarm timers, deliver writes.
  afterEvent() {
    const now = Date.now();
    if (this.pending) this.startPending(now);
    const r = this.room();
    if (r) {
      const fp = `${r.phase}|${r.drawn}|${r.rotation}|${r.players.length}|${r.connected.length}|${r.hostId}|${r.chat.length}|${r.rotations}|${r.public}`;
      if (this.fingerprint !== fp) {
        this.fingerprint = fp;
        try { this.store.set('snap', JSON.stringify(r.snapshot())); }
        catch (e) {
          // Never leave an older snapshot that looks current: drop it and retry on the next event (the game keeps running in memory).
          this.log('room snapshot failed, dropping stale snapshot', e.message);
          try { this.store.del('snap'); } catch { /* storage unavailable */ }
          this.fingerprint = null;
        }
      }
    } else if (this.live) {
      this.retire();
    }
    const timed = !!r && TIMED.has(r.phase);
    if (timed && !this.interval) this.interval = setInterval(() => this.tick(), 250);
    else if (!timed && this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.outbox.pendingItems() || this.outbox.queue.length) void this.flush();
    void this.schedule();
  }
  // One alarm covers: retry of undelivered writes, the public-start deadline, and idle-room retirement.
  async schedule() {
    const now = Date.now(); let at = null;
    const want = (t) => { at = at === null ? t : Math.min(at, t); };
    if (this.outbox.queue.length) want(now + RETRY_MS[Math.min(this.retryN, RETRY_MS.length - 1)]);
    if (this.pending) want(this.pending.by);
    const r = this.room();
    if (r && !TIMED.has(r.phase)) want(now + IDLE_ALARM_MS);
    if (at === null) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || at < cur) await this.ctx.storage.setAlarm(at);
  }
  async alarm() {
    this.game.tick(Date.now());
    this.afterEvent();
    await this.flush();
    await this.schedule();
  }
}
