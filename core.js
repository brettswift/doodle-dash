'use strict';
// Pure game core. No I/O of its own: no fs, sockets, timers, process.env, crypto, Date.now, Math.random or console.
// The host (game.js on Node, a Durable Object later) supplies everything through `env`:
//   env.now      number, the logical time for this command
//   env.clock    optional () => number used only for the "remaining" field of views (defaults to env.now)
//   env.rng      { hex(bytes) -> string }, opaque id/token source
//   env.svc      service port { topics, history, adapt, analytics, archive, onGameStart, onFeedback }; core calls it, never owns it
// State is plain JSON-able data (no Sets, Maps, functions, sockets). step() updates the state it is given and
// returns it together with an ordered list of outbound messages and the next absolute wake time.
const { MULT10 } = require('./words');

const DEFAULT_ROTATIONS = 5, MIN_ROTATIONS = 1, MAX_ROTATIONS = 10;
const DEFAULT_CONFIG = Object.freeze({ choose: 15000, draw: 80000, result: 6000, grace: 12000 });
const IDLE_RETIRE_MS = 10 * 60 * 1000;
// Points: base time-decay points times the difficulty multiplier (tenths), rounded half up to an integer.
const scaled = (base, diff) => Math.round(base * MULT10[diff] / 10);
const EVERYONE_BONUS = 100, EVERYONE_MIN_GUESSERS = 2; // drawer bonus when every guesser gets the word

const COLORS = new Set(['#000000', '#e63946', '#f4a261', '#ffd23f', '#2a9d8f', '#1d90ff', '#7b2cbf', '#8d5524', '#ffffff']);
const MAX_PLAYERS = 8, MIN_PLAYERS = 2;
const MAX_STROKES = 400, MAX_STROKE_PTS = 4000, MAX_TOTAL_PTS = 40000, MAX_CHUNK_PTS = 40;
const NAME_RE = /^[A-Za-z0-9 _.-]{1,14}$/;
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const OUTCOME = { 'time up': 'timeup', 'everyone guessed': 'all', 'drawer left': 'drawerLeft' };
const SNAPSHOT_VERSION = 1;
// Host-only player fields that never enter a snapshot (live socket, observed IP).
const HOST_ONLY = new Set(['send', 'ip']);

function create({ code, now, cfg, rng, isPublic = false }) {
  const s = {
    code, public: !!isPublic, cfg: { ...DEFAULT_CONFIG, ...cfg },
    players: [], hostId: null, rotations: DEFAULT_ROTATIONS, chat: [], touched: now, rec: null,
  };
  resetGame(s, rng);
  return s;
}

function resetGame(s, rng) {
  s.phase = 'lobby'; s.queue = []; s.drawn = 0; s.rotation = 0; s.completedRotations = 0; s.rotSize = 0; s.diff = null; s.gid = rng.hex(4);
  s.drawerId = null; s.word = null; s.choices = null; s.strokes = []; s.pts = 0; s.analyticsStarted = false;
  s.deadline = 0; s.drawerGone = 0; s.showcase = [];
  for (const p of s.players) { p.score = 0; p.gain = 0; p.guessed = false; }
}

const connected = (s) => s.players.filter((p) => p.connected);
const drawerOf = (s) => s.players.find((p) => p.id === s.drawerId);
const mode = (s) => (s.public ? 'public' : 'private');

function say(s, k, text, name) {
  const m = { k, name, text }; s.chat.push(m); if (s.chat.length > 60) s.chat.shift(); return m;
}

// ---- outbound messages: plain {to: playerId, msg} entries, in order. Host decides how to deliver. ----
function sendOne(out, to, msg) { out.push({ to, msg }); }
function sendAll(s, out, msg, except) { for (const p of connected(s)) if (p.id !== except) out.push({ to: p.id, msg }); }
function broadcastState(s, out, env, strokes = true) { for (const p of connected(s)) out.push({ to: p.id, msg: view(s, p.id, env, strokes) }); }

// ---- views ----
function view(s, playerId, env, withStrokes = true) {
  const you = playerId === s.drawerId;
  const showWord = s.phase === 'roundEnd' || s.phase === 'gameOver' || (you && s.phase === 'drawing');
  const clock = env.clock ? env.clock() : env.now;
  const v = {
    t: 'state', code: s.code, you: playerId, hostId: s.hostId, phase: s.phase,
    drawerId: s.drawerId, rotations: s.rotations, rotation: s.rotation, completedRounds: s.completedRotations || 0,
    remaining: Math.max(0, s.deadline - clock),
    players: s.players.map((q) => ({ id: q.id, name: q.name, score: q.score, gain: q.gain, guessed: q.guessed, connected: !!q.connected })),
    chat: s.chat.slice(),
  };
  // A rotation = every player draws once. turn* counts single drawer turns over the whole game.
  const live = s.phase === 'choosing' || s.phase === 'drawing';
  if (s.word && s.phase === 'drawing' && !you) v.lens = s.word.split(' ').map((x) => x.length);
  if (s.phase !== 'lobby') {
    v.turn = s.drawn + (live ? 1 : 0);
    v.turns = v.turn + s.queue.length + Math.max(0, s.rotations - s.rotation) * s.players.length;
    v.rotTurn = s.rotSize - s.queue.length; v.rotTurns = s.rotSize;
  }
  if (withStrokes) v.strokes = s.strokes;
  if (s.phase === 'gameOver') {
    const bw = bestWorst(s), pick = (x) => x && ({ name: x.name, word: x.word, diff: x.diff, gain: x.gain, strokes: x.strokes });
    v.showcase = bw && { best: pick(bw.best), worst: pick(bw.worst) };
  }
  if (s.phase === 'choosing' && you) v.choices = s.choices.map((c) => ({ word: c.word, diff: c.diff, mult: MULT10[c.diff] / 10 }));
  if (showWord && s.word) v.word = s.word;
  // difficulty is shown to the drawer while drawing and to everyone only once the word is revealed
  if (s.diff && showWord) { v.diff = s.diff; v.mult = MULT10[s.diff] / 10; }
  if (s.word && s.phase === 'drawing' && !you) v.len = s.word.length;
  return v;
}

// Best = most points earned by the drawer (first maximum); worst = fewest (last minimum), always a different drawing.
function bestWorst(s) {
  const list = s.showcase;
  if (!list.length) return null;
  let bi = 0; list.forEach((x, i) => { if (x.gain > list[bi].gain) bi = i; });
  let wi = -1; list.forEach((x, i) => { if (i !== bi && (wi < 0 || x.gain <= list[wi].gain)) wi = i; });
  return { best: list[bi], worst: wi < 0 ? null : list[wi] };
}

// ---- snapshot codec: JSON-safe, versioned, no live-connection or IP data ----
function encode(s) {
  return JSON.parse(JSON.stringify({ v: SNAPSHOT_VERSION, state: s }, (k, val) => (HOST_ONLY.has(k) ? undefined : val)));
}
function decode(snap) {
  if (!snap || snap.v !== SNAPSHOT_VERSION) throw new Error('unsupported snapshot version');
  const s = JSON.parse(JSON.stringify(snap.state));
  for (const p of s.players) p.connected = false; // sockets do not survive; host re-attaches
  return s;
}

// ---- transitions ----
function join(s, name, env) {
  if (!NAME_RE.test(name || '') || !name.trim()) return { err: 'Name: 1-14 letters, numbers, spaces' };
  if (s.players.length >= MAX_PLAYERS) return { err: 'Room is full' };
  if (s.players.some((p) => p.name.toLowerCase() === name.trim().toLowerCase())) return { err: 'Name taken' };
  const p = { id: env.rng.hex(4), token: env.rng.hex(16), name: name.trim(), score: 0, gain: 0, guessed: false, connected: false };
  s.players.push(p);
  if (!s.hostId) s.hostId = p.id;
  if (s.phase !== 'lobby' && s.phase !== 'gameOver') { s.queue.push(p.id); s.rotSize++; }
  s.touched = env.now;
  say(s, 'sys', `${p.name} joined`);
  return { p };
}

const resume = (s, token) => s.players.find((p) => p.token === token);

// Host has validated the reclaim (name + observed IP); core only rotates the token.
function rotateToken(s, playerId, env) {
  const p = s.players.find((q) => q.id === playerId);
  if (p) p.token = env.rng.hex(16);
  return p;
}

function attach(s, playerId, env, out) {
  const p = s.players.find((q) => q.id === playerId); if (!p) return;
  p.connected = true; s.touched = env.now;
  if (p.id === s.drawerId) s.drawerGone = 0;
  out.push({ to: p.id, msg: view(s, p.id, env, true) });
  for (const q of connected(s)) if (q !== p) out.push({ to: q.id, msg: view(s, q.id, env, false) });
}

function detach(s, playerId, env, out) {
  const p = s.players.find((q) => q.id === playerId); if (!p) return;
  p.connected = false; s.touched = env.now;
  if (s.rec && s.phase === 'drawing') {
    if (p.id === s.drawerId) s.rec.dd = true;
    else if (!p.guessed) s.rec.el = s.rec.el.filter((id) => id !== p.id);
  }
  if (p.id === s.drawerId && ['choosing', 'drawing'].includes(s.phase)) s.drawerGone = env.now;
  broadcastState(s, out, env, false);
}

function nextRound(s, env, out) {
  const svc = env.svc, now = env.now;
  // Turn order: a rotation lists every player once. A player offline when their turn comes loses that
  // turn (never stalls the game); they draw again next rotation. Late joiners draw at the end of the current one.
  for (;;) {
    while (s.queue.length && !s.players.find((p) => p.id === s.queue[0])?.connected) s.queue.shift();
    if (s.queue.length) break;
    s.completedRotations = s.rotation;
    if (s.rotation >= s.rotations || !connected(s).length) return gameOver(s, env, out);
    s.rotation++; s.queue = s.players.map((q) => q.id); s.rotSize = s.queue.length;
    if (s.rotation > 1) say(s, 'sys', `Round ${s.rotation} of ${s.rotations}`);
  }
  s.drawerId = s.queue.shift();
  s.choices = svc.topics.offer(s.code);
  s.word = null; s.diff = null; s.strokes = []; s.pts = 0; s.drawerGone = 0;
  for (const p of s.players) { p.guessed = false; p.gain = 0; }
  s.phase = 'choosing'; s.deadline = now + s.cfg.choose;
  broadcastState(s, out, env);
}

function beginDrawing(s, c, env, out) {
  const svc = env.svc, now = env.now;
  s.chat = s.chat.filter((m) => m.k !== 'chat'); // the word storm shows this round's guesses only
  s.word = c.word; s.diff = c.diff; s.curTid = c.id; s.choices = null;
  // Only the chosen topic is recorded; unchosen offers were merely held and are released here.
  svc.topics.commit(s.code, c.id);
  const el = connected(s).filter((q) => q.id !== s.drawerId).map((q) => q.id);
  const seq = svc.history.start({ tid: c.id, d: c.diff, m: MULT10[c.diff], g: s.gid, t0: now, el0: el.length, budget: s.cfg.draw });
  s.rec = { seq, tid: c.id, el, el0: el.length, t0: now, gt: [], ink: false, dd: false };
  s.phase = 'drawing'; s.deadline = now + s.cfg.draw;
  broadcastState(s, out, env);
}

function endRound(s, why, env, out) {
  const svc = env.svc, now = env.now;
  if (!['choosing', 'drawing'].includes(s.phase)) return;
  finishRec(s, now, OUTCOME[why] || 'abandoned', svc);
  svc.topics.release(s.code);
  keepDrawing(s);
  s.phase = 'roundEnd'; s.deadline = now + s.cfg.result; s.drawn++;
  if (!s.queue.length) s.completedRotations = s.rotation;
  s.choices = null;
  say(s, 'sys', s.word ? `The word was ${s.word}${why ? ' (' + why + ')' : ''}` : `Round skipped${why ? ' (' + why + ')' : ''}`);
  broadcastState(s, out, env);
}

// Remember this round's drawing (in memory, this room only) for the game-over best/worst reveal.
function keepDrawing(s) {
  const d = drawerOf(s);
  if (!d || !s.word || !s.strokes.length) return;
  s.showcase.push({ name: d.name, word: s.word, tid: s.curTid, diff: s.diff, gain: d.gain, strokes: s.strokes });
  // Only the current best and worst can ever be shown, so keep just those two (in drawing order). Adding a drawing can only
  // make the new one best, or replace the worst; the old best/worst always stay candidates, so the first-best / last-worst
  // tie rules give the same answer as scanning every drawing. This also bounds snapshot size (at most two canvases).
  const bw = bestWorst(s), keep = new Set([bw.best, bw.worst]);
  s.showcase = s.showcase.filter((x) => keep.has(x));
}

// Anonymous per-drawing telemetry: no names/ids/IPs; times are ms since the drawing began.
function finishRec(s, now, outcome, svc) {
  const r = s.rec; if (!r) return; s.rec = null;
  svc.history.end(r.seq, { out: outcome, t1: now, dur: now - r.t0, ok: r.gt.length, gt: r.gt, el1: r.el.length, ink: r.ink, dd: r.dd });
  svc.adapt.consider(svc.history, svc.topics, r.tid, now);
}

// room torn down or server stopping mid-turn
function abort(s, env) {
  const svc = env.svc, now = env.now;
  finishRec(s, now, 'abandoned', svc); svc.topics.release(s.code);
  if (!s.public && !s.analyticsStarted) svc.analytics?.event('privateLobbyClosed', { lobbyId: s.gid, reason: 'expired-or-shutdown' });
  if (s.analyticsStarted && s.phase !== 'gameOver') svc.analytics?.event('gameAbandoned', { gameId: s.gid, mode: mode(s), configuredRounds: s.rotations, completedRounds: s.completedRotations, drawingTurns: s.drawn, players: s.players.length });
}

function gameOver(s, env, out) {
  const svc = env.svc;
  s.phase = 'gameOver'; s.deadline = 0;
  svc.analytics?.event('gameEnded', { gameId: s.gid, mode: mode(s), configuredRounds: s.rotations, completedRounds: s.completedRotations, drawingTurns: s.drawn, players: s.players.length });
  // Persist the exact selection shown to players; failures never reach gameplay.
  try {
    void svc.archive?.save({ gameId: s.gid, mode: mode(s), players: s.players.length }, bestWorst(s));
  } catch (e) { env.log?.('[doodle] archive error', e.message); }
  broadcastState(s, out, env);
}

function draw(s, p, m, out) {
  const err = (msg) => sendOne(out, p.id, { t: 'error', msg });
  if (s.phase !== 'drawing' || p.id !== s.drawerId) return;
  const pts = m.p;
  if (!Array.isArray(pts) || pts.length < 2 || pts.length > MAX_CHUNK_PTS * 2 || pts.length % 2) return err('Bad stroke');
  if (!pts.every((n) => Number.isInteger(n) && n >= 0 && n <= 1000)) return err('Bad stroke');
  if (!COLORS.has(m.c) || !Number.isInteger(m.w) || m.w < 1 || m.w > 40) return err('Bad stroke');
  let st;
  if (m.s) {
    if (s.strokes.length >= MAX_STROKES) return err('Too many strokes - clear the canvas');
    st = { c: m.c, w: m.w, p: [] }; s.strokes.push(st);
  } else {
    st = s.strokes[s.strokes.length - 1];
    if (!st || st.c !== m.c || st.w !== m.w) return;
  }
  if (st.p.length + pts.length > MAX_STROKE_PTS * 2 || s.pts + pts.length > MAX_TOTAL_PTS * 2) return err('Canvas full - clear it');
  st.p.push(...pts); s.pts += pts.length; if (s.rec) s.rec.ink = true;
  sendAll(s, out, { t: 'draw', s: !!m.s, c: m.c, w: m.w, p: pts }, p.id);
}

function guess(s, p, m, env, out) {
  const now = env.now;
  if (s.phase !== 'drawing') return;
  if (p.id === s.drawerId || p.guessed) return;
  const text = String(m.text ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40);
  if (!text) return;
  if (norm(text) === norm(s.word)) {
    p.guessed = true;
    if (s.rec && s.rec.el.includes(p.id)) s.rec.gt.push(now - s.rec.t0);
    const left = Math.max(0, s.deadline - now);
    const gain = scaled(50 + Math.round(150 * left / s.cfg.draw), s.diff);
    p.gain = gain; p.score += gain;
    const d = drawerOf(s); if (d) { const dg = scaled(25, s.diff); d.score += dg; d.gain += dg; }
    sendAll(s, out, { t: 'chat', m: say(s, 'ok', `${p.name} guessed it!`) });
    const guessers = connected(s).filter((q) => q.id !== s.drawerId);
    if (guessers.length && guessers.every((q) => q.guessed)) {
      // Bonus for a word everyone got. Needs 2+ guessers so a 2-player room cannot farm it; scaled by difficulty, so Easy pays half of Hard.
      if (d && guessers.length >= EVERYONE_MIN_GUESSERS) {
        const bonus = scaled(EVERYONE_BONUS, s.diff); d.score += bonus; d.gain += bonus;
        sendAll(s, out, { t: 'chat', m: say(s, 'ok', `Everyone got it! ${d.name} +${bonus}`) });
      }
      return endRound(s, 'everyone guessed', env, out);
    }
    return broadcastState(s, out, env, false);
  }
  sendAll(s, out, { t: 'chat', m: say(s, 'chat', text, p.name) });
}

function clientMessage(s, p, m, env, out) {
  const svc = env.svc, now = env.now;
  s.touched = now;
  const err = (msg) => sendOne(out, p.id, { t: 'error', msg });
  switch (m.t) {
    case 'start': {
      if (p.id !== s.hostId) return err('Only the host can start');
      if (s.phase !== 'lobby') return err('Already started');
      if (connected(s).length < MIN_PLAYERS) return err('Need at least 2 players');
      s.players = s.players.filter((q) => q.connected);
      s.queue = []; s.rotation = 0; s.rotSize = 0;
      s.chat = []; s.showcase = [];
      s.analyticsStarted = true;
      svc.analytics?.event('gameStarted', { gameId: s.gid, lobbyId: s.gid, mode: mode(s), configuredRounds: s.rotations, players: s.players.length, participants: s.players.filter((q) => q.analytics).map((q) => ({ ...q.analytics, name: q.name })) });
      svc.onGameStart?.({ gameId: s.gid, mode: mode(s), players: s.players.length, configuredRounds: s.rotations });
      return nextRound(s, env, out);
    }
    case 'rounds': {
      if (p.id !== s.hostId) return err('Only the host can change rounds');
      if (s.phase !== 'lobby') return err('Rounds can only change in the lobby');
      if (!Number.isInteger(m.n) || m.n < MIN_ROTATIONS || m.n > MAX_ROTATIONS) return err(`Rounds must be a whole number ${MIN_ROTATIONS}-${MAX_ROTATIONS}`);
      s.rotations = m.n;
      return broadcastState(s, out, env, false);
    }
    case 'again': {
      if (p.id !== s.hostId) return err('Only the host can restart');
      if (s.phase !== 'gameOver') return err('Game not finished');
      s.players = s.players.filter((q) => q.connected);
      if (!s.players.some((q) => q.id === s.hostId)) s.hostId = s.players[0].id;
      resetGame(s, env.rng); s.chat = [];
      if (!s.public) svc.analytics?.event('privateLobbyCreated', { lobbyId: s.gid });
      return broadcastState(s, out, env);
    }
    case 'pick': {
      if (s.phase !== 'choosing' || p.id !== s.drawerId) return err('Not your choice');
      const w = Number.isInteger(m.i) && s.choices[m.i];
      if (!w) return err('Bad choice');
      return beginDrawing(s, w, env, out);
    }
    case 'feedback': {
      // One optional answer per player per finished round. Never carries names, ids or codes outward.
      const rating = Number.isInteger(m.rating) && m.rating >= 1 && m.rating <= 5 ? m.rating : 0;
      const text = String(m.text ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      const round = m.round;
      if (!Number.isInteger(round) || round < 1 || round > (s.completedRotations || 0) || (!rating && !text)) return;
      const last = p.fb && p.fb.g === s.gid ? p.fb.r : 0;
      if (round <= last) return;
      p.fb = { g: s.gid, r: round };
      svc.onFeedback?.({ gameId: s.gid, mode: mode(s), round, rounds: s.rotations, rating, text, players: s.players.length });
      return;
    }
    case 'draw': return draw(s, p, m, out);
    case 'clear': {
      if (s.phase !== 'drawing' || p.id !== s.drawerId) return;
      s.strokes = []; s.pts = 0;
      return sendAll(s, out, { t: 'clear' }, p.id);
    }
    case 'guess': return guess(s, p, m, env, out);
  }
}

function tick(s, env, out) {
  const now = env.now;
  if (s.phase === 'choosing' && now >= s.deadline) return beginDrawing(s, s.choices[0], env, out);
  if (s.phase === 'drawing' && now >= s.deadline) return endRound(s, 'time up', env, out);
  if (s.phase === 'roundEnd' && now >= s.deadline) return nextRound(s, env, out);
  if (s.drawerGone && now - s.drawerGone > s.cfg.grace) { s.drawerGone = 0; endRound(s, 'drawer left', env, out); }
}

// Earliest absolute time something becomes due (strict comparisons get +1), or null when nothing is pending.
function nextWakeAt(s) {
  const t = [];
  if (['choosing', 'drawing', 'roundEnd'].includes(s.phase)) t.push(s.deadline);
  if (s.drawerGone) t.push(s.drawerGone + s.cfg.grace + 1);
  if (!connected(s).length) t.push(s.touched + IDLE_RETIRE_MS + 1);
  return t.length ? Math.min(...t) : null;
}

// Single entry point. Commands:
//   {type:'join', name} {type:'rotateToken', playerId} {type:'attach', playerId} {type:'detach', playerId}
//   {type:'message', playerId, m} {type:'tick'} {type:'abort'} {type:'nextRound'} {type:'endRound', why}
// Returns {state, out:[{to,msg}], nextWakeAt, result}.
function step(s, command, env) {
  const out = []; let result;
  const player = () => s.players.find((q) => q.id === command.playerId);
  switch (command.type) {
    case 'join': result = join(s, command.name, env); break;
    case 'rotateToken': result = { p: rotateToken(s, command.playerId, env) }; break;
    case 'attach': attach(s, command.playerId, env, out); break;
    case 'detach': detach(s, command.playerId, env, out); break;
    case 'message': { const p = player(); if (p) clientMessage(s, p, command.m, env, out); break; }
    case 'tick': tick(s, env, out); break;
    case 'abort': abort(s, env); break;
    case 'nextRound': nextRound(s, env, out); break;
    case 'endRound': endRound(s, command.why, env, out); break;
    default: throw new Error('unknown command ' + command.type);
  }
  return { state: s, out, nextWakeAt: nextWakeAt(s), result };
}

module.exports = {
  create, step, view, encode, decode, resume, bestWorst, nextWakeAt,
  NAME_RE, MAX_PLAYERS, DEFAULT_ROTATIONS, MIN_ROTATIONS, MAX_ROTATIONS, DEFAULT_CONFIG, IDLE_RETIRE_MS, SNAPSHOT_VERSION, scaled,
};
