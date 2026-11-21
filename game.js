'use strict';
// Node host facade over the pure core (core.js). This file owns the host concerns: env config, crypto ids,
// wall clock, live send callbacks and the services (history, topics, archive, analytics). Game rules live in core.js.
const crypto = require('node:crypto');
const core = require('./core');
const { openStore } = require('./store');
const { History } = require('./history');
const { Topics } = require('./topics');
const { Archive } = require('./archive');
const adapt = require('./adapt');
const { NAME_RE, MAX_PLAYERS, DEFAULT_ROTATIONS, MIN_ROTATIONS, MAX_ROTATIONS, scaled } = core;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const rng = { hex: (bytes) => crypto.randomBytes(bytes).toString('hex'), int: (max) => crypto.randomInt(max) };
const makeCtx = (opts = {}) => {
  const store = opts.store || openStore(opts.dataDir || null, { log: opts.log });
  const history = new History({ store, log: opts.log });
  return { store, history, topics: new Topics(history), adapt, analytics: opts.analytics, archive: new Archive({ store, log: opts.log, ...opts.archive }) };
};
const envConfig = () => ({
  choose: +process.env.CHOOSE_MS || 15000,
  draw: +process.env.DRAW_MS || 80000,
  result: +process.env.RESULT_MS || 6000,
  grace: +process.env.GRACE_MS || 12000,
});
// Room state keys proxied to the plain core state, so existing callers/tests keep reading room.phase etc.
const STATE_KEYS = ['code', 'public', 'cfg', 'players', 'hostId', 'rotations', 'chat', 'touched', 'rec', 'phase', 'queue', 'drawn',
  'rotation', 'completedRotations', 'rotSize', 'diff', 'gid', 'drawerId', 'word', 'choices', 'strokes', 'pts', 'analyticsStarted',
  'deadline', 'drawerGone', 'showcase', 'curTid'];

class Room {
  constructor(code, now, ctx) {
    this.ctx = ctx || makeCtx();
    this.state = core.create({ code, now, cfg: envConfig(), rng });
  }
  get connected() { return this.state.players.filter((p) => p.send); }
  drawer() { return this.state.players.find((p) => p.id === this.state.drawerId); }
  now() { return this.clock ? this.clock() : Date.now(); }
  // Run one core command: sync live socket flags in, step, deliver the ordered outbound messages.
  run(command, now) {
    for (const p of this.state.players) p.connected = !!p.send;
    const env = { now, clock: () => this.now(), rng, svc: this.ctx, log: this.ctx.log || console.error };
    const r = core.step(this.state, command, env);
    const wire = new Map();
    for (const { to, msg } of r.out) {
      const p = this.state.players.find((q) => q.id === to);
      if (!p || !p.send) continue;
      if (!wire.has(msg)) wire.set(msg, JSON.stringify(msg));
      p.send(wire.get(msg));
    }
    return r;
  }
  join(name, now) { const r = this.run({ type: 'join', name }, now).result; return r.err ? { err: r.err } : { p: r.p }; }
  // Fallback reconnect: same room + same name + same trusted observed IP, only for a DISCONNECTED player.
  // IP is not authentication; it only re-claims a slot nobody is using. Token is rotated. The IP check is host-side.
  rejoinByIp(name, ip) {
    if (!ip) return null;
    const p = this.state.players.find((q) => q.name.toLowerCase() === String(name).trim().toLowerCase());
    if (!p || p.send || !p.ip || p.ip !== ip) return null;
    return this.run({ type: 'rotateToken', playerId: p.id }, this.now()).result.p;
  }
  resume(token) { return core.resume(this.state, token); }
  // Deliver an object to everyone connected except one player (used by the transport after a public join).
  sendAll(obj, except) { const s = JSON.stringify(obj); for (const p of this.connected) if (p !== except) p.send(s); }
  broadcastState(strokes = true) { for (const p of this.connected) p.send(JSON.stringify(core.view(this.state, p.id, { now: this.now(), clock: () => this.now() }, strokes))); }
  say(k, text, name) { const c = this.state.chat; c.push({ k, name, text }); if (c.length > 60) c.shift(); return c[c.length - 1]; }
  attach(p, send, now) { p.send = send; this.run({ type: 'attach', playerId: p.id }, now); }
  detach(p, now) { p.send = null; this.run({ type: 'detach', playerId: p.id }, now); }
  view(p, withStrokes = true) { return core.view(this.state, p.id, { now: this.now(), clock: () => this.now() }, withStrokes); }
  bestWorst() { return core.bestWorst(this.state); }
  handle(p, m, now) { this.run({ type: 'message', playerId: p.id, m }, now); }
  nextRound(now) { this.run({ type: 'nextRound' }, now); }
  endRound(now, why) { this.run({ type: 'endRound', why }, now); }
  tick(now) { this.run({ type: 'tick' }, now); }
  abort(now) { this.run({ type: 'abort' }, now); }
  snapshot() { return core.encode(this.state); }
}
for (const k of STATE_KEYS) {
  Object.defineProperty(Room.prototype, k, { get() { return this.state[k]; }, set(v) { this.state[k] = v; }, enumerable: true });
}

class Game {
  constructor(opts = {}) { this.rooms = new Map(); this.ctx = { ...makeCtx(opts), onGameStart: opts.onGameStart }; }
  // graceful stop: close in-flight drawings as abandoned and persist state
  shutdown(now = Date.now()) { for (const r of this.rooms.values()) r.abort(now); this.ctx.history.close(); }  // store is closed by its owner (server) after shutdown
  create(now) {
    if (this.rooms.size >= 100) return null;
    let code;
    do { code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (this.rooms.has(code));
    const r = new Room(code, now, this.ctx); this.rooms.set(code, r); return r;
  }
  // Rebuild a room from a core snapshot (host eviction/restart); every player starts disconnected.
  restore(code, snapshot, now) {
    const r = new Room(code, now, this.ctx); r.state = core.decode(snapshot); this.rooms.set(code, r); return r;
  }
  get(code) { return this.rooms.get(String(code || '').toUpperCase()); }
  tick(now) {
    for (const [c, r] of this.rooms) {
      r.tick(now);
      if (!r.connected.length && now - r.touched > 10 * 60 * 1000) { r.abort(now); this.rooms.delete(c); }
    }
  }
}
module.exports = { Game, NAME_RE, MAX_PLAYERS, DEFAULT_ROTATIONS, MIN_ROTATIONS, MAX_ROTATIONS, scaled };
