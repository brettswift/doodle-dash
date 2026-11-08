'use strict';
// Public-lobby matchmaking. Pure and synchronous: join/leave check and mutate a lobby in one step,
// so concurrent clicks on a single-threaded server can never overfill a lobby or double-place anyone.
// Timers are per lobby (setTimeout only); no timer exists while no lobby is counting down.
const LOBBY_SIZE = 5, MIN_START = 2, FIRST_MS = 30000, RESET_MS = 15000;

class Matchmaker {
  constructor(opts = {}) {
    this.size = opts.size || LOBBY_SIZE;
    this.firstMs = opts.firstMs ?? FIRST_MS;
    this.resetMs = opts.resetMs ?? RESET_MS;
    this.now = opts.now || Date.now;
    this.setTimer = opts.setTimer || setTimeout;
    this.clearTimer = opts.clearTimer || clearTimeout;
    this.onUpdate = opts.onUpdate || (() => {});
    this.onStart = opts.onStart || (() => {});
    this.lobbies = []; // open lobbies, oldest first
    this.where = new Map(); // member -> lobby
    this.seq = 0;
  }
  // Place a member in the oldest open lobby with room, or a new one. Returns the lobby (null if already placed).
  join(member) {
    if (this.where.has(member)) return null;
    let l = this.lobbies.find((x) => !x.started && x.members.length < this.size);
    if (!l) { l = { id: ++this.seq, members: [], deadline: 0, timer: null, started: false }; this.lobbies.push(l); }
    l.members.push(member); this.where.set(member, l);
    const n = l.members.length;
    if (n >= this.size) this.start(l);
    else if (n === MIN_START) this.arm(l, this.firstMs);
    else if (n > MIN_START) this.arm(l, this.resetMs);
    else this.onUpdate(l);
    return l;
  }
  // Remove a waiting member. Below 2: countdown cancelled. Back to 2: restarts at 30 s. 3-4: deadline kept.
  leave(member) {
    const l = this.where.get(member);
    if (!l) return false;
    this.where.delete(member);
    l.members = l.members.filter((m) => m !== member);
    const n = l.members.length;
    if (!n) { this.disarm(l); this.lobbies = this.lobbies.filter((x) => x !== l); return true; }
    if (n < MIN_START) { this.disarm(l); this.onUpdate(l); }
    else if (n === MIN_START) this.arm(l, this.firstMs);
    else this.onUpdate(l);
    return true;
  }
  remainingMs(l) { return l.timer ? Math.max(0, l.deadline - this.now()) : null; }
  arm(l, ms) {
    this.disarm(l);
    l.deadline = this.now() + ms;
    l.timer = this.setTimer(() => { l.timer = null; if (l.members.length >= MIN_START) this.start(l); }, ms);
    this.onUpdate(l);
  }
  disarm(l) { if (l.timer) this.clearTimer(l.timer); l.timer = null; l.deadline = 0; }
  start(l) {
    if (l.started || l.members.length < MIN_START) return;
    this.disarm(l); l.started = true;
    this.lobbies = this.lobbies.filter((x) => x !== l);
    for (const m of l.members) this.where.delete(m);
    this.onStart(l.members.slice(), l);
  }
  close() { for (const l of this.lobbies) this.disarm(l); this.lobbies = []; this.where.clear(); }
}
module.exports = { Matchmaker, LOBBY_SIZE, MIN_START, FIRST_MS, RESET_MS };
