'use strict';
const crypto = require('node:crypto');
const { MULT10 } = require('./words');
const { History } = require('./history');
const { Topics } = require('./topics');
const adapt = require('./adapt');
const DEFAULT_ROTATIONS = 5, MIN_ROTATIONS = 1, MAX_ROTATIONS = 10;
// Points: base time-decay points times the difficulty multiplier (tenths), rounded half up to an integer.
const scaled = (base, diff) => Math.round(base * MULT10[diff] / 10);

const COLORS = new Set(['#000000', '#e63946', '#f4a261', '#ffd23f', '#2a9d8f', '#1d90ff', '#7b2cbf', '#8d5524', '#ffffff']);
const MAX_PLAYERS = 8, MIN_PLAYERS = 2;
const MAX_STROKES = 400, MAX_STROKE_PTS = 4000, MAX_TOTAL_PTS = 40000, MAX_CHUNK_PTS = 40;
const NAME_RE = /^[A-Za-z0-9 _.-]{1,14}$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const OUTCOME = { 'time up': 'timeup', 'everyone guessed': 'all', 'drawer left': 'drawerLeft' };
const makeCtx = (opts = {}) => {
  const history = new History({ dir: opts.dataDir || null, log: opts.log });
  return { history, topics: new Topics(history), adapt };
};

class Room {
  constructor(code, now, ctx) {
    this.code = code; this.ctx = ctx || makeCtx(); this.rec = null;
    this.cfg = {
      choose: +process.env.CHOOSE_MS || 15000,
      draw: +process.env.DRAW_MS || 80000,
      result: +process.env.RESULT_MS || 6000,
      grace: +process.env.GRACE_MS || 12000,
    };
    this.players = []; this.hostId = null; this.rotations = DEFAULT_ROTATIONS;
    this.phase = 'lobby'; this.chat = [];
    this.touched = now;
    this.resetGame();
  }
  resetGame() {
    this.phase = 'lobby'; this.queue = []; this.drawn = 0; this.rotation = 0; this.rotSize = 0; this.diff = null; this.gid = crypto.randomBytes(4).toString('hex');
    this.drawerId = null; this.word = null; this.choices = null; this.strokes = []; this.pts = 0;
    this.deadline = 0; this.drawerGone = 0;
    for (const p of this.players) { p.score = 0; p.gain = 0; p.guessed = false; }
  }
  get connected() { return this.players.filter((p) => p.send); }
  drawer() { return this.players.find((p) => p.id === this.drawerId); }

  join(name, now) {
    if (!NAME_RE.test(name || '') || !name.trim()) return { err: 'Name: 1-14 letters, numbers, spaces' };
    if (this.players.length >= MAX_PLAYERS) return { err: 'Room is full' };
    if (this.players.some((p) => p.name.toLowerCase() === name.trim().toLowerCase())) return { err: 'Name taken' };
    const p = { id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(16).toString('hex'), name: name.trim(), score: 0, gain: 0, guessed: false, send: null };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    if (this.phase !== 'lobby' && this.phase !== 'gameOver') { this.queue.push(p.id); this.rotSize++; }
    this.touched = now;
    this.say('sys', `${p.name} joined`);
    return { p };
  }
  // Fallback reconnect: same room + same name + same trusted observed IP, only for a DISCONNECTED player.
  // IP is not authentication; it only re-claims a slot nobody is using. Token is rotated.
  rejoinByIp(name, ip) {
    if (!ip) return null;
    const p = this.players.find((q) => q.name.toLowerCase() === String(name).trim().toLowerCase());
    if (!p || p.send || !p.ip || p.ip !== ip) return null;
    p.token = crypto.randomBytes(16).toString('hex');
    return p;
  }
  resume(token) { return this.players.find((p) => p.token === token); }
  say(k, text, name) { this.chat.push({ k, name, text }); if (this.chat.length > 40) this.chat.shift(); return this.chat[this.chat.length - 1]; }
  sendAll(obj, except) { const s = JSON.stringify(obj); for (const p of this.connected) if (p !== except) p.send(s); }
  broadcastState(strokes = true) { for (const p of this.connected) p.send(JSON.stringify(this.view(p, strokes))); }
  attach(p, send, now) {
    p.send = send; this.touched = now;
    if (p.id === this.drawerId) this.drawerGone = 0;
    p.send(JSON.stringify(this.view(p, true)));
    for (const q of this.connected) if (q !== p) q.send(JSON.stringify(this.view(q, false)));
  }
  detach(p, now) {
    p.send = null; this.touched = now;
    if (this.rec && this.phase === 'drawing') {
      if (p.id === this.drawerId) this.rec.dd = true;
      else if (!p.guessed) this.rec.el.delete(p.id);
    }
    if (p.id === this.drawerId && ['choosing', 'drawing'].includes(this.phase)) this.drawerGone = now;
    this.broadcastState(false);
  }

  view(p, withStrokes = true) {
    const you = p.id === this.drawerId;
    const showWord = this.phase === 'roundEnd' || this.phase === 'gameOver' || (you && this.phase === 'drawing');
    const v = {
      t: 'state', code: this.code, you: p.id, hostId: this.hostId, phase: this.phase,
      drawerId: this.drawerId, rotations: this.rotations, rotation: this.rotation,
      remaining: Math.max(0, this.deadline - this.now()),
      players: this.players.map((q) => ({ id: q.id, name: q.name, score: q.score, gain: q.gain, guessed: q.guessed, connected: !!q.send })),
      chat: this.chat,
    };
    // A rotation = every player draws once. turn* counts single drawer turns over the whole game.
    const live = this.phase === 'choosing' || this.phase === 'drawing';
    if (this.word && this.phase === 'drawing' && !you) v.lens = this.word.split(' ').map((s) => s.length);
    if (this.phase !== 'lobby') {
      v.turn = this.drawn + (live ? 1 : 0);
      v.turns = v.turn + this.queue.length + Math.max(0, this.rotations - this.rotation) * this.players.length;
      v.rotTurn = this.rotSize - this.queue.length; v.rotTurns = this.rotSize;
    }
    if (withStrokes) v.strokes = this.strokes;
    if (this.phase === 'choosing' && you) v.choices = this.choices.map((c) => ({ word: c.word, diff: c.diff, mult: MULT10[c.diff] / 10 }));
    if (showWord && this.word) v.word = this.word;
    // difficulty is shown to the drawer while drawing and to everyone only once the word is revealed
    if (this.diff && (showWord)) { v.diff = this.diff; v.mult = MULT10[this.diff] / 10; }
    if (this.word && this.phase === 'drawing' && !you) v.len = this.word.length;
    return v;
  }
  now() { return this.clock ? this.clock() : Date.now(); }

  handle(p, m, now) {
    this.touched = now;
    const err = (msg) => p.send && p.send(JSON.stringify({ t: 'error', msg }));
    switch (m.t) {
      case 'start': {
        if (p.id !== this.hostId) return err('Only the host can start');
        if (this.phase !== 'lobby') return err('Already started');
        if (this.connected.length < MIN_PLAYERS) return err('Need at least 2 players');
        this.players = this.players.filter((q) => q.send);
        this.queue = []; this.rotation = 0; this.rotSize = 0;
        this.chat = [];
        return this.nextRound(now);
      }
      case 'rounds': {
        if (p.id !== this.hostId) return err('Only the host can change rounds');
        if (this.phase !== 'lobby') return err('Rounds can only change in the lobby');
        if (!Number.isInteger(m.n) || m.n < MIN_ROTATIONS || m.n > MAX_ROTATIONS) return err(`Rounds must be a whole number ${MIN_ROTATIONS}-${MAX_ROTATIONS}`);
        this.rotations = m.n;
        return this.broadcastState(false);
      }
      case 'again': {
        if (p.id !== this.hostId) return err('Only the host can restart');
        if (this.phase !== 'gameOver') return err('Game not finished');
        this.players = this.players.filter((q) => q.send);
        if (!this.players.some((q) => q.id === this.hostId)) this.hostId = this.players[0].id;
        this.resetGame(); this.chat = [];
        return this.broadcastState();
      }
      case 'pick': {
        if (this.phase !== 'choosing' || p.id !== this.drawerId) return err('Not your choice');
        const w = Number.isInteger(m.i) && this.choices[m.i];
        if (!w) return err('Bad choice');
        return this.beginDrawing(w, now);
      }
      case 'draw': return this.draw(p, m, err);
      case 'clear': {
        if (this.phase !== 'drawing' || p.id !== this.drawerId) return;
        this.strokes = []; this.pts = 0;
        return this.sendAll({ t: 'clear' }, p);
      }
      case 'guess': return this.guess(p, m, now, err);
    }
  }

  nextRound(now) {
    // Turn order: a rotation lists every player once. A player offline when their turn comes loses that
    // turn (never stalls the game); they draw again next rotation. Late joiners draw at the end of the current one.
    for (;;) {
      while (this.queue.length && !this.players.find((p) => p.id === this.queue[0])?.send) this.queue.shift();
      if (this.queue.length) break;
      if (this.rotation >= this.rotations || !this.connected.length) return this.gameOver();
      this.rotation++; this.queue = this.players.map((q) => q.id); this.rotSize = this.queue.length;
      if (this.rotation > 1) this.say('sys', `Round ${this.rotation} of ${this.rotations}`);
    }
    this.drawerId = this.queue.shift();
    this.choices = this.ctx.topics.offer(this.code);
    this.word = null; this.diff = null; this.strokes = []; this.pts = 0; this.drawerGone = 0;
    for (const p of this.players) { p.guessed = false; p.gain = 0; }
    this.phase = 'choosing'; this.deadline = now + this.cfg.choose;
    this.broadcastState();
  }
  beginDrawing(c, now) {
    this.word = c.word; this.diff = c.diff; this.choices = null;
    // Only the chosen topic is recorded; unchosen offers were merely held and are released here.
    this.ctx.topics.commit(this.code, c.id);
    const el = this.connected.filter((q) => q.id !== this.drawerId).map((q) => q.id);
    const seq = this.ctx.history.start({ tid: c.id, d: c.diff, m: MULT10[c.diff], g: this.gid, t0: now, el0: el.length, budget: this.cfg.draw });
    this.rec = { seq, tid: c.id, el: new Set(el), el0: el.length, t0: now, gt: [], ink: false, dd: false };
    this.phase = 'drawing'; this.deadline = now + this.cfg.draw;
    this.broadcastState();
  }
  endRound(now, why) {
    if (!['choosing', 'drawing'].includes(this.phase)) return;
    this.finishRec(now, OUTCOME[why] || 'abandoned');
    this.ctx.topics.release(this.code);
    this.phase = 'roundEnd'; this.deadline = now + this.cfg.result; this.drawn++;
    if (!this.word && this.choices) this.word = null;
    this.choices = null;
    this.say('sys', this.word ? `The word was ${this.word}${why ? ' (' + why + ')' : ''}` : `Round skipped${why ? ' (' + why + ')' : ''}`);
    this.broadcastState();
  }
  // Anonymous per-drawing telemetry: no names/ids/IPs; times are ms since the drawing began.
  finishRec(now, out) {
    const r = this.rec; if (!r) return; this.rec = null;
    this.ctx.history.end(r.seq, { out, t1: now, dur: now - r.t0, ok: r.gt.length, gt: r.gt, el1: r.el.size, ink: r.ink, dd: r.dd });
    this.ctx.adapt.consider(this.ctx.history, this.ctx.topics, r.tid, now);
  }
  // room torn down or server stopping mid-turn
  abort(now) { this.finishRec(now, 'abandoned'); this.ctx.topics.release(this.code); }
  gameOver() { this.phase = 'gameOver'; this.deadline = 0; this.word = this.word; this.broadcastState(); }

  draw(p, m, err) {
    if (this.phase !== 'drawing' || p.id !== this.drawerId) return;
    const pts = m.p;
    if (!Array.isArray(pts) || pts.length < 2 || pts.length > MAX_CHUNK_PTS * 2 || pts.length % 2) return err('Bad stroke');
    if (!pts.every((n) => Number.isInteger(n) && n >= 0 && n <= 1000)) return err('Bad stroke');
    if (!COLORS.has(m.c) || !Number.isInteger(m.w) || m.w < 1 || m.w > 40) return err('Bad stroke');
    let st;
    if (m.s) {
      if (this.strokes.length >= MAX_STROKES) return err('Too many strokes - clear the canvas');
      st = { c: m.c, w: m.w, p: [] }; this.strokes.push(st);
    } else {
      st = this.strokes[this.strokes.length - 1];
      if (!st || st.c !== m.c || st.w !== m.w) return;
    }
    if (st.p.length + pts.length > MAX_STROKE_PTS * 2 || this.pts + pts.length > MAX_TOTAL_PTS * 2) return err('Canvas full - clear it');
    st.p.push(...pts); this.pts += pts.length; if (this.rec) this.rec.ink = true;
    this.sendAll({ t: 'draw', s: !!m.s, c: m.c, w: m.w, p: pts }, p);
  }

  guess(p, m, now, err) {
    if (this.phase !== 'drawing') return;
    if (p.id === this.drawerId || p.guessed) return;
    const text = String(m.text ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);
    if (!text) return;
    if (norm(text) === norm(this.word)) {
      p.guessed = true;
      if (this.rec && this.rec.el.has(p.id)) this.rec.gt.push(now - this.rec.t0);
      const left = Math.max(0, this.deadline - now);
      const gain = scaled(50 + Math.round(150 * left / this.cfg.draw), this.diff);
      p.gain = gain; p.score += gain;
      const d = this.drawer(); if (d) { const dg = scaled(25, this.diff); d.score += dg; d.gain += dg; }
      this.sendAll({ t: 'chat', m: this.say('ok', `${p.name} guessed it!`) });
      const guessers = this.connected.filter((q) => q.id !== this.drawerId);
      if (guessers.length && guessers.every((q) => q.guessed)) return this.endRound(now, 'everyone guessed');
      return this.broadcastState(false);
    }
    this.sendAll({ t: 'chat', m: this.say('chat', text, p.name) });
  }

  tick(now) {
    if (this.phase === 'choosing' && now >= this.deadline) return this.beginDrawing(this.choices[0], now);
    if (this.phase === 'drawing' && now >= this.deadline) return this.endRound(now, 'time up');
    if (this.phase === 'roundEnd' && now >= this.deadline) return this.nextRound(now);
    if (this.drawerGone && now - this.drawerGone > this.cfg.grace) { this.drawerGone = 0; this.endRound(now, 'drawer left'); }
  }
}

class Game {
  constructor(opts = {}) { this.rooms = new Map(); this.ctx = makeCtx(opts); }
  // graceful stop: close in-flight drawings as abandoned and persist state
  shutdown(now = Date.now()) { for (const r of this.rooms.values()) r.abort(now); this.ctx.history.close(); }
  create(now) {
    if (this.rooms.size >= 100) return null;
    let code;
    do { code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (this.rooms.has(code));
    const r = new Room(code, now, this.ctx); this.rooms.set(code, r); return r;
  }
  get(code) { return this.rooms.get(String(code || '').toUpperCase()); }
  tick(now) {
    for (const [c, r] of this.rooms) {
      r.tick(now);
      if (!r.connected.length && now - r.touched > 10 * 60 * 1000) { r.abort(now); this.rooms.delete(c); }
    }
  }
}
module.exports = { Game, MAX_PLAYERS, DEFAULT_ROTATIONS, MIN_ROTATIONS, MAX_ROTATIONS, scaled };
