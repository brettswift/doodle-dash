'use strict';
// Topic selection with cross-room reservation. Node is single-threaded: offer()/hold() run synchronously,
// so two rooms can never be handed the same topic (no await between check and reserve).
const crypto = require('node:crypto');
const { TOPICS, BY_ID, DIFFS } = require('./words');
const WINDOW = 1000; // avoid topics among the latest WINDOW started drawings when the tier allows
const rnd = (a) => a[crypto.randomInt(a.length)];

class Topics {
  constructor(history, { window = WINDOW } = {}) {
    this.h = history; this.window = window; this.held = new Map(); this.byRoom = new Map();
    this.stats = { offers: 0, unused: 0, aged: 0, exhausted: 0, reservationFallback: 0 };
    this.cache = null;
  }
  tierOf(id) { return this.h.tierOf(id, BY_ID.get(id).base); }
  list(d) {
    const key = JSON.stringify(this.h.state.tiers);
    if (!this.cache || this.cache.key !== key) {
      const m = Object.fromEntries(DIFFS.map((x) => [x, []]));
      for (const t of TOPICS) m[this.tierOf(t.id)].push(t.id);
      this.cache = { key, m };
    }
    return this.cache.m[d];
  }
  counts() { return Object.fromEntries(DIFFS.map((d) => [d, this.list(d).length])); }
  // One topic per tier for a room. Offered-but-unchosen topics are only held, never recorded as drawn.
  offer(room) {
    this.release(room);
    const set = new Set(); this.byRoom.set(room, set);
    return DIFFS.map((d) => {
      const id = this.pick(d), t = BY_ID.get(id);
      this.held.set(id, room); set.add(id);
      return { id, word: t.word, diff: d };
    });
  }
  pick(d) {
    const all = this.list(d); this.stats.offers++;
    let cand = all.filter((id) => !this.held.has(id));
    if (!cand.length) { cand = all; this.stats.reservationFallback++; }
    const last = (id) => this.h.last.get(id), floor = this.h.seq - this.window;
    const never = cand.filter((id) => last(id) === undefined);
    if (never.length) { this.stats.unused++; return rnd(never); }
    const aged = cand.filter((id) => last(id) <= floor);
    if (aged.length) { this.stats.aged++; return rnd(aged); }
    this.stats.exhausted++; // every candidate was drawn within the window: least-recently drawn wins
    const min = Math.min(...cand.map(last));
    return rnd(cand.filter((id) => last(id) === min));
  }
  // keep only the chosen topic reserved until the drawing ends
  commit(room, id) {
    const set = this.byRoom.get(room);
    if (set) for (const x of set) if (x !== id && this.held.get(x) === room) this.held.delete(x);
    this.byRoom.set(room, new Set([id])); this.held.set(id, room);
  }
  release(room) {
    const set = this.byRoom.get(room);
    if (set) for (const x of set) if (this.held.get(x) === room) this.held.delete(x);
    this.byRoom.delete(room);
  }
}
module.exports = { Topics, WINDOW };
