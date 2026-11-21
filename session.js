'use strict';
// Transport-independent client session: one per connected socket. Used by both the Node host (server.js)
// and the Cloudflare host (cf/src/hub.js) so the wire protocol cannot drift between runtimes.
// The host supplies send(string), the observed public IP (or null), the coarse location and the shared services.
const { NAME_RE } = require('./game');
const { Matchmaker } = require('./lobby');
const { anonId, clean } = require('./analytics');
const PUBLIC_ROUNDS = 3; // quick game: 3 rounds, each round every player draws once

function bucket(cap, perSec, nowFn = Date.now) {
  let tokens = cap, last = nowFn();
  return () => { const n = nowFn(); tokens = Math.min(cap, tokens + (n - last) * perSec / 1000); last = n; if (tokens < 1) return false; tokens--; return true; };
}

// Public lobby: members are connection handles {name, send, enterRoom, failPublic}. A started lobby becomes a
// normal room with rounds = 3 and is started at once by the server; nobody else can join it by code.
function createMatchmaker({ game, analytics, firstMs, resetMs, onPublicStart, setTimer, clearTimer }) {
  const mm = new Matchmaker({
    firstMs, resetMs, setTimer, clearTimer,
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
      onPublicStart?.(r);
    },
  });
  return mm;
}

// deps: { game, mm, analytics }. conn: { send(string), observed, location }.
// Returns { message(raw), close(), snapshot(), rebind(room, player), requeue(name) }.
function createSession({ game, mm, analytics }, conn) {
  const { send, observed, location = {} } = conn;
  let room = null, player = null, waiting = null;
  // Default identity covers clients (native ws) that never send an analytics message; web client upgrades it once.
  let identity = conn.identity || { sessionId: anonId(), ...location }, identified = false;
  const general = bucket(80, 60), guessB = bucket(4, 1), joinB = bucket(5, 0.2);
  let warned = 0;
  const fail = (msg) => { analytics.event('error', { category: 'rejected-action' }); send(JSON.stringify({ t: 'error', msg })); };

  function queue(m) {
    const name = String(m.name ?? '').trim();
    if (!NAME_RE.test(name)) return fail('Name: 1-14 letters, numbers, spaces');
    waiting = makeWaiting(name);
    mm.join(waiting);
    analytics.event('queueEntered', { ...identity, name, mode: 'public' });
  }
  function makeWaiting(name) {
    return {
      name, send,
      failPublic: (msg) => { waiting = null; fail(msg); },
      enterRoom: (r, p, now) => {
        waiting = null; room = r; player = p; p.ip = observed;
        p.analytics = identity; analytics.event('nameEntered', { ...identity, name: p.name, mode: 'public' });
        send(JSON.stringify({ t: 'joined', code: r.code, id: p.id, token: p.token, public: true }));
        r.attach(p, send, now);
        conn.onBound?.();
      },
    };
  }
  function enter(m, now) {
    let r, p, rejoin = false;
    if (m.t === 'create') {
      r = game.create(now);
      if (!r) return fail('Server busy, try later');
      const j = r.join(String(m.name ?? ''), now);
      if (j.err) { game.rooms.delete(r.code); return fail(j.err); }
      p = j.p;
      analytics.event('privateLobbyCreated', { lobbyId: r.gid });
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
    p.analytics = identity;
    analytics.event('nameEntered', { ...identity, name: p.name, mode: r.public ? 'public' : 'private' });
    analytics.event('intent', { ...identity, mode: m.t === 'create' ? 'private-create' : m.t === 'join' ? 'private-join' : 'resume' });
    send(JSON.stringify({ t: 'joined', code: r.code, id: p.id, token: p.token }));
    p.ip = observed;
    r.attach(p, send, now);
    if (m.t === 'join' && !rejoin) r.sendAll({ t: 'chat', m: r.chat[r.chat.length - 1] }, p);
    conn.onBound?.();
  }

  return {
    get identity() { return identity; },
    message(raw) {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      const throttle = () => { if (Date.now() - warned > 1000) { warned = Date.now(); send(JSON.stringify({ t: 'error', msg: 'Slow down' })); } };
      if (!general() || (m.t === 'guess' && !guessB())) return throttle();
      const now = Date.now();
      if (!player) {
        if (m.t === 'analytics') {
          if (identified) return; identified = true;
          identity = { browserId: anonId(m.browserId), sessionId: anonId(m.sessionId), timezone: clean(m.timezone, 64), language: clean(m.language, 32), ...location };
          analytics.event('landing', identity); conn.onBound?.(); return;
        }
        if (m.t === 'leavePublic') { if (waiting) { analytics.event('queueLeft', identity); mm.leave(waiting); waiting = null; send(JSON.stringify({ t: 'publicLeft' })); conn.onBound?.(); } return; }
        if (!['create', 'join', 'resume', 'public'].includes(m.t) || waiting) return;
        if (!joinB()) return throttle();
        if (m.t === 'public') { queue(m); conn.onBound?.(); return; }
        return enter(m, now);
      }
      room.handle(player, m, now);
    },
    close() {
      if (waiting) { analytics.event('queueLeft', identity); mm.leave(waiting); waiting = null; }
      if (room && player && player.send === send) room.detach(player, Date.now());
    },
    // Small JSON describing what this socket is bound to; the Cloudflare host keeps it as the hibernation attachment.
    snapshot() {
      return { code: room && player ? room.code : undefined, pid: room && player ? player.id : undefined, q: waiting ? waiting.name : undefined, identity };
    },
    // Re-bind a socket to its seat after the host object was evicted and rebuilt (no analytics, no broadcast).
    rebind(r, p) { room = r; player = p; p.send = send; p.connected = true; p.analytics = identity; identified = true; },
    requeue(name) { waiting = makeWaiting(name); mm.join(waiting); },
  };
}

module.exports = { createSession, createMatchmaker, bucket, PUBLIC_ROUNDS };
