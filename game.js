'use strict';
const crypto = require('node:crypto');
const WORDS = require('./words');

const COLORS = new Set(['#000000', '#e63946', '#f4a261', '#ffd23f', '#2a9d8f', '#1d90ff', '#7b2cbf', '#8d5524', '#ffffff']);
const MAX_PLAYERS = 8, MIN_PLAYERS = 2;
const MAX_STROKES = 400, MAX_STROKE_PTS = 4000, MAX_TOTAL_PTS = 40000, MAX_CHUNK_PTS = 40;
const NAME_RE = /^[A-Za-z0-9 _.-]{1,14}$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const pickN = (arr, n) => { const a = [...arr]; const out = []; while (out.length < n && a.length) out.push(a.splice(crypto.randomInt(a.length), 1)[0]); return out; };

class Room {
  constructor(code, now) {
    this.code = code;
    this.cfg = {
      choose: +process.env.CHOOSE_MS || 15000,
      draw: +process.env.DRAW_MS || 80000,
      result: +process.env.RESULT_MS || 6000,
      grace: +process.env.GRACE_MS || 12000,
    };
    this.players = []; this.hostId = null;
    this.phase = 'lobby'; this.chat = [];
    this.touched = now;
    this.resetGame();
  }
  resetGame() {
    this.phase = 'lobby'; this.queue = []; this.drawn = 0; this.used = new Set();
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
    if (this.phase !== 'lobby' && this.phase !== 'gameOver') this.queue.push(p.id);
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
    if (p.id === this.drawerId && ['choosing', 'drawing'].includes(this.phase)) this.drawerGone = now;
    this.broadcastState(false);
  }

  view(p, withStrokes = true) {
    const you = p.id === this.drawerId;
    const showWord = this.phase === 'roundEnd' || this.phase === 'gameOver' || (you && this.phase === 'drawing');
    const v = {
      t: 'state', code: this.code, you: p.id, hostId: this.hostId, phase: this.phase,
      drawerId: this.drawerId, round: this.drawn + (this.phase === 'lobby' || this.phase === 'gameOver' ? 0 : 1),
      rounds: this.drawn + this.queue.length + (this.phase === 'choosing' || this.phase === 'drawing' ? 1 : 0),
      remaining: Math.max(0, this.deadline - this.now()),
      players: this.players.map((q) => ({ id: q.id, name: q.name, score: q.score, gain: q.gain, guessed: q.guessed, connected: !!q.send })),
      chat: this.chat,
    };
    if (withStrokes) v.strokes = this.strokes;
    if (this.phase === 'choosing' && you) v.choices = this.choices;
    if (showWord && this.word) v.word = this.word;
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
        this.queue = this.players.map((q) => q.id);
        this.chat = [];
        return this.nextRound(now);
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
        const w = this.choices[m.i];
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
    this.queue = this.queue.filter((id) => this.players.find((p) => p.id === id)?.send);
    if (!this.queue.length) return this.gameOver();
    this.drawerId = this.queue.shift();
    const fresh = WORDS.filter((w) => !this.used.has(w));
    this.choices = pickN(fresh.length >= 3 ? fresh : WORDS, 3);
    this.word = null; this.strokes = []; this.pts = 0; this.drawerGone = 0;
    for (const p of this.players) { p.guessed = false; p.gain = 0; }
    this.phase = 'choosing'; this.deadline = now + this.cfg.choose;
    this.broadcastState();
  }
  beginDrawing(w, now) {
    this.word = w; this.used.add(w); this.choices = null;
    this.phase = 'drawing'; this.deadline = now + this.cfg.draw;
    this.broadcastState();
  }
  endRound(now, why) {
    if (!['choosing', 'drawing'].includes(this.phase)) return;
    this.phase = 'roundEnd'; this.deadline = now + this.cfg.result; this.drawn++;
    if (!this.word && this.choices) this.word = null;
    this.choices = null;
    this.say('sys', this.word ? `The word was ${this.word}${why ? ' (' + why + ')' : ''}` : `Round skipped${why ? ' (' + why + ')' : ''}`);
    this.broadcastState();
  }
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
    st.p.push(...pts); this.pts += pts.length;
    this.sendAll({ t: 'draw', s: !!m.s, c: m.c, w: m.w, p: pts }, p);
  }

  guess(p, m, now, err) {
    if (this.phase !== 'drawing') return;
    if (p.id === this.drawerId || p.guessed) return;
    const text = String(m.text ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);
    if (!text) return;
    if (norm(text) === norm(this.word)) {
      p.guessed = true;
      const left = Math.max(0, this.deadline - now);
      const gain = 50 + Math.round(150 * left / this.cfg.draw);
      p.gain = gain; p.score += gain;
      const d = this.drawer(); if (d) { d.score += 25; d.gain += 25; }
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
  constructor() { this.rooms = new Map(); }
  create(now) {
    if (this.rooms.size >= 100) return null;
    let code;
    do { code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (this.rooms.has(code));
    const r = new Room(code, now); this.rooms.set(code, r); return r;
  }
  get(code) { return this.rooms.get(String(code || '').toUpperCase()); }
  tick(now) {
    for (const [c, r] of this.rooms) {
      r.tick(now);
      if (!r.connected.length && now - r.touched > 10 * 60 * 1000) this.rooms.delete(c);
    }
  }
}
module.exports = { Game, MAX_PLAYERS };
