// Directory Durable Object: everything global, nothing live. Room objects (room.js) host the games.
//  - entry sockets: every browser connects here first (/ws); create/join/resume are answered with {t:'goto', code, msg}, which
//    makes the client reconnect to /ws?room=CODE and send msg there; the public lobby queue lives here;
//  - room-code allocation and the registry of live rooms;
//  - history sequence + completed-turn history, adaptive tiers, analytics, best/worst archive (all written by `ingest`, one
//    idempotent batch at a time, from Rooms) and the admin endpoints that read them.
import { DurableObject } from 'cloudflare:workers';
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { Analytics, anonId, clean } from '../../analytics.js';
import { History } from '../../history.js';
import { Topics } from '../../topics.js';
import { Archive } from '../../archive.js';
import * as adapt from '../../adapt.js';
import { Matchmaker } from '../../lobby.js';
import { bucket } from '../../session.js';
import { NAME_RE } from '../../game.js';
import { authorized, adminPage } from '../../admin.js';
import { buildArchive } from '../../export.js';
import { TOPICS } from '../../words.js';
import { SEC } from '../../static-files.js';
import { DirectoryStore } from './do-store.js';

const MAX_MSG = 4096, MAX_PER_IP = 40, MAX_SOCKETS = 600, DEFAULT_MAX_ROOMS = 500;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ', CODE_RE = /^[A-Z]{4}$/;
const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
const plain = (status, msg, extra = {}) => new Response(msg, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store', ...extra } });
const num = (v) => (+v || undefined);

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.log = (...a) => console.error('[doodle-dir]', ...a);
    this.store = new DirectoryStore(ctx.storage, this.log);
    this.qa = env.APP_ENV !== 'production';
    this.exportToken = env.DOODLE_EXPORT_TOKEN;
    this.exportBucket = { tokens: 6, last: Date.now() };
    if (!this.store.getMeta('ip_salt')) this.store.setMeta('ip_salt', randomBytes(16).toString('hex'));
    this.ipSalt = this.store.getMeta('ip_salt');
    this.history = new History({ store: this.store, log: this.log });
    this.topics = new Topics(this.history);
    this.analytics = new Analytics({ store: this.store, enabled: true, qa: this.qa, log: this.log });
    this.archive = new Archive({ store: this.store, log: this.log });
    this.codes = new Set(this.store.loadCodes());
    this.build();
    ctx.blockConcurrencyWhile(async () => this.restore());
  }

  build() {
    this.sessions = new Map();
    this.mm = new Matchmaker({
      firstMs: num(this.env.LOBBY_FIRST_MS), resetMs: num(this.env.LOBBY_RESET_MS),
      setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (t) => clearTimeout(t),
      onUpdate: (l) => { const s = JSON.stringify({ t: 'public', n: l.members.length, max: this.mm.size, remaining: this.mm.remainingMs(l) }); for (const m of l.members) m.send(s); },
      onStart: (members) => { void this.formPublic(members); },
    });
  }
  restore() {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      const entry = this.makeEntry(ws, att);
      this.sessions.set(ws, entry);
      if (att.q) entry.requeue(att.q);
    }
  }
  evictForTest() { this.mm.close(); this.build(); this.restore(); }

  // ----- Room-facing RPC -----
  // What a Room needs to run the synchronous core: tier overrides and the last-seen position of every drawn topic.
  view() { return { seq: this.history.seq, tiers: { ...this.history.state.tiers }, last: Object.fromEntries(this.history.last) }; }

  // Apply one batch from a Room exactly once: batch numbers only increase per source, an older or equal number is a duplicate.
  async ingest(src, batch) {
    if (!batch || !Number.isFinite(batch.n) || typeof src !== 'string') throw new Error('bad batch');
    const last = this.store.lastIngest(src);
    if (last !== null && batch.n <= last) return { dup: true, view: this.view() };
    for (const a of batch.archives || []) await this.archive.save(a.meta, a.sel); // idempotent by game id ('exists')
    const applied = [];
    this.store.tx(() => {
      for (const rec of batch.drawings || []) { const { seq, ...r } = rec; applied.push({ tid: r.tid, seq: this.history.record(r) }); }
      for (const e of batch.events || []) if (e && typeof e.type === 'string' && Number.isFinite(e.at)) this.store.addEvent(e);
      if (batch.retire && CODE_RE.test(src)) { this.codes.delete(src); this.store.delCode(src); }
      this.store.setIngest(src, batch.n);
    });
    for (const a of applied) adapt.consider(this.history, this.topics, a.tid, Date.now());
    if (batch.sel) for (const [k, v] of Object.entries(batch.sel)) if (k in this.topics.stats && Number.isFinite(v)) this.topics.stats[k] += v;
    return { dup: false, view: this.view() };
  }

  allocate() {
    if (this.codes.size >= (num(this.env.MAX_ROOMS) || DEFAULT_MAX_ROOMS)) return null;
    let code;
    do { code = Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join(''); } while (this.codes.has(code));
    this.codes.add(code); this.store.addCode(code, Date.now());
    return code;
  }
  release(code) { this.codes.delete(code); this.store.delCode(code); }
  roomStub(code) { return this.env.ROOM.get(this.env.ROOM.idFromName(code)); }

  // Public lobby formed: allocate a Room, seat everybody (duplicate names get a number), tell each client where to go.
  async formPublic(members) {
    const code = this.allocate();
    if (!code) { for (const m of members) m.failPublic('Server busy, try later'); return; }
    const taken = new Set();
    const names = members.map((m) => {
      let name = m.name, k = 1;
      while (taken.has(name.toLowerCase())) { k++; name = m.name.slice(0, 11).trim() + ' ' + k; }
      taken.add(name.toLowerCase()); return name;
    });
    let seats;
    try { seats = await this.roomStub(code).init({ code, view: this.view(), isPublic: true, names }); }
    catch (e) { this.log('public room init failed', e.message); this.release(code); for (const m of members) m.failPublic('Server busy, try later'); return; }
    this.analytics.event('lobbyFormed', { mode: 'public', players: seats.length });
    members.forEach((m, i) => m.goto(code, { t: 'resume', code, token: seats[i].token, pub: 1 }));
  }

  // ----- entry sockets -----
  makeEntry(ws, att) {
    const send = (s) => { try { ws.send(s); } catch { /* socket closed */ } };
    const general = bucket(80, 60), joinB = bucket(5, 0.2);
    let identity = att.identity || { sessionId: anonId(), ...(att.location || {}) }, identified = !!att.identified, waiting = null, warned = 0;
    const save = () => { try { ws.serializeAttachment({ ipk: att.ipk, location: att.location, identity, identified, q: waiting ? waiting.name : undefined }); } catch { /* socket closed */ } };
    const fail = (msg) => { this.analytics.event('error', { category: 'rejected-action' }); send(JSON.stringify({ t: 'error', msg })); };
    const goto = (code, msg) => send(JSON.stringify({ t: 'goto', code, msg }));
    const makeWaiting = (name) => ({ name, send, goto: (code, msg) => { waiting = null; save(); goto(code, msg); }, failPublic: (msg) => { waiting = null; save(); fail(msg); } });
    const entry = {
      message: async (raw) => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
        const throttle = () => { if (Date.now() - warned > 1000) { warned = Date.now(); send(JSON.stringify({ t: 'error', msg: 'Slow down' })); } };
        if (!general()) return throttle();
        if (m.t === 'analytics') {
          if (identified) return; identified = true;
          identity = { browserId: anonId(m.browserId), sessionId: anonId(m.sessionId), timezone: clean(m.timezone, 64), language: clean(m.language, 32), ...(att.location || {}) };
          this.analytics.event('landing', identity); save(); return;
        }
        if (m.t === 'leavePublic') { if (waiting) { this.analytics.event('queueLeft', identity); this.mm.leave(waiting); waiting = null; send(JSON.stringify({ t: 'publicLeft' })); save(); } return; }
        if (!['create', 'join', 'resume', 'public'].includes(m.t) || waiting) return;
        if (!joinB()) return throttle();
        const name = String(m.name ?? '').trim();
        if (m.t === 'public') {
          if (!NAME_RE.test(name)) return fail('Name: 1-14 letters, numbers, spaces');
          waiting = makeWaiting(name); this.mm.join(waiting);
          this.analytics.event('queueEntered', { ...identity, name, mode: 'public' }); save(); return;
        }
        if (m.t === 'create') {
          if (!NAME_RE.test(name)) return fail('Name: 1-14 letters, numbers, spaces');
          const code = this.allocate();
          if (!code) return fail('Server busy, try later');
          try { await this.roomStub(code).init({ code, view: this.view() }); } catch (e) { this.log('room init failed', e.message); this.release(code); return fail('Server busy, try later'); }
          return goto(code, { t: 'create', name: String(m.name ?? '') });
        }
        const code = String(m.code ?? '').toUpperCase();
        if (!CODE_RE.test(code) || !this.codes.has(code)) return fail('No such room');
        goto(code, m.t === 'join' ? { t: 'join', code, name: String(m.name ?? '') } : { t: 'resume', code, token: String(m.token ?? '') });
      },
      close: () => { if (waiting) { this.analytics.event('queueLeft', identity); this.mm.leave(waiting); waiting = null; } },
      requeue: (name) => { waiting = makeWaiting(name); this.mm.join(waiting); },
    };
    return entry;
  }

  ipKey(ip) { return createHmac('sha256', this.ipSalt).update(String(ip || 'unknown')).digest('hex').slice(0, 16); }

  async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (path === '/ws') return this.upgrade(request);
    if (path === '/stats') {
      return json(200, { topics: TOPICS.length, tiers: this.topics.counts(), history: this.history.stats(), selection: this.topics.stats });
    }
    if (path === '/admin/analytics') return new Response(adminPage(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SEC } });
    const auth = () => authorized({ headers: { authorization: request.headers.get('authorization') || '' } }, this.exportToken);
    const denied = () => plain(this.exportToken ? 401 : 404, this.exportToken ? 'unauthorized' : 'not found');
    if (path === '/admin/analytics.json') {
      if (!auth()) return denied();
      const rt = await this.runtime();
      this.analytics.sample(rt); // current sample so the dashboard is never empty (no periodic sampler: objects hibernate)
      const records = this.analytics.records();
      return json(200, { summary: this.analytics.summary(records), operations: this.analytics.operations(records), health: this.analytics.health(rt) });
    }
    if (path === '/admin/drawings.json' || /^\/admin\/drawings\/[0-9a-f]{8}\.json$/.test(path)) {
      if (!auth()) return denied();
      const arc = this.archive;
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
    const ip = request.headers.get('x-hub-ip') || '';
    const ipk = this.ipKey(ip);
    let used = 0;
    for (const s of sockets) if ((s.deserializeAttachment() || {}).ipk === ipk) used++;
    if (used >= (num(this.env.MAX_PER_IP) || MAX_PER_IP)) return plain(403, 'forbidden');
    const location = {};
    const c = (request.headers.get('x-hub-country') || '').toUpperCase(), r = (request.headers.get('x-hub-region') || '').toUpperCase();
    if (/^[A-Z]{2}$/.test(c)) location.country = c;
    if (/^[A-Z0-9-]{1,12}$/.test(r)) location.region = r;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const att = { ipk, location };
    server.serializeAttachment(att);
    this.sessions.set(server, this.makeEntry(server, att));
    return new Response(null, { status: 101, webSocket: client });
  }

  sessionFor(ws) {
    let s = this.sessions.get(ws);
    if (!s) { s = this.makeEntry(ws, ws.deserializeAttachment() || {}); this.sessions.set(ws, s); }
    return s;
  }
  webSocketMessage(ws, message) {
    if (typeof message !== 'string') return ws.close(1003, 'text only');
    if (new TextEncoder().encode(message).length > MAX_MSG) return ws.close(1009, 'too big');
    return Promise.resolve(this.sessionFor(ws).message(message)).catch((e) => this.log('entry message failed', e.message));
  }
  webSocketClose(ws) { this.drop(ws); try { ws.close(1000); } catch { /* already closed */ } }
  webSocketError(ws) { this.drop(ws); }
  drop(ws) { const s = this.sessions.get(ws); this.sessions.delete(ws); if (s) s.close(); }

  // Aggregate live numbers by asking each registered Room (read-only, on demand, nothing stored).
  async runtime() {
    const codes = [...this.codes];
    const stats = await Promise.all(codes.map((c) => this.roomStub(c).stats().catch(() => null)));
    const live = stats.filter((s) => s && s.live);
    const sum = (k) => live.reduce((n, s) => n + (s[k] || 0), 0);
    return {
      openSockets: this.ctx.getWebSockets().length + sum('sockets'), activeRooms: live.length, activePlayers: sum('connected'),
      publicQueue: this.mm.lobbies.reduce((n, l) => n + l.members.length, 0), ntfyConfigured: false, ntfy: {}, qa: this.qa,
      registeredRooms: codes.length, unreachableRooms: stats.length - stats.filter(Boolean).length,
      storage: { rowsWritten: this.store.rowsWritten + sum('rowsWritten'), rowsRead: this.store.rowsRead + sum('rowsRead'), directoryRowsWritten: this.store.rowsWritten },
    };
  }
}
