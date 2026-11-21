'use strict';
// Durable anonymous drawing history + adaptive-difficulty state, stored in SQLite (see store.js).
// No names, IPs, tokens, chat or strokes are ever written. `g` is a random per-game id (not the room code).
// The in-memory view holds the latest MAX_RECORDS drawings (what selection and adaptation read); the database keeps every row.
// A start with no end (crash/restart mid-drawing) is stored as outcome "abandoned".
const { openStore } = require('./store');
const STATE_V = 1, MAX_RECORDS = 20000, MAX_AUDIT = 1000;

class History {
  constructor({ dir = null, store = null, maxRecords = MAX_RECORDS, log = () => {} } = {}) {
    this.dir = dir; this.max = maxRecords; this.log = log;
    this.recs = new Map(); this.seq = 0; this.last = new Map(); this.degraded = false;
    this.state = { v: STATE_V, tiers: {}, since: {}, audit: [] };
    this.store = store || (dir ? openStore(dir, { log }) : null); this.owns = !store && !!this.store;
    if (this.store) this.load();
  }
  get persistent() { return !!this.store && !this.degraded; }

  load() {
    const s = this.store;
    for (const r of s.loadDrawings(this.max)) { const { seq, ...rest } = r; this.recs.set(seq, { seq, ...rest }); }
    this.seq = s.maxSeq();
    for (const r of [...this.recs.values()].sort((a, b) => a.seq - b.seq)) this.last.set(r.tid, r.seq);
    const { tiers, since } = s.loadTiers();
    this.state = { v: STATE_V, tiers, since, audit: s.loadAudit(MAX_AUDIT) };
  }
  write(what, fn) {
    if (!this.store || this.degraded) return;
    try { fn(this.store); } catch (e) { this.degraded = true; this.log(what + ' write failed (memory only)', e.message); }
  }
  trim() {
    if (this.recs.size <= this.max * 1.25) return;
    const keep = [...this.recs.values()].sort((a, b) => a.seq - b.seq).slice(-this.max);
    this.recs = new Map(keep.map((r) => [r.seq, r]));
    this.last = new Map(); for (const r of keep) this.last.set(r.tid, r.seq);
  }
  rowOf(r) { const { seq, ...rest } = r; return rest; }
  // begin a drawing; rec: {tid,d,m,g,t0,el0,budget}
  start(rec) {
    const seq = ++this.seq, r = { seq, out: 'abandoned', ...rec };
    this.recs.set(seq, r); this.last.set(rec.tid, seq);
    this.write('history', (s) => s.putDrawing(seq, this.rowOf(r)));
    return seq;
  }
  end(seq, f) {
    const r = this.recs.get(seq); if (!r) return;
    Object.assign(r, f); this.write('history', (s) => s.putDrawing(seq, this.rowOf(r)));
    this.trim();
  }
  forTopic(tid) { return [...this.recs.values()].filter((r) => r.tid === tid); }

  tierOf(id, base) { return this.state.tiers[id] || base; }
  setTier(id, to, audit) {
    this.state.tiers[id] = to; this.state.since[id] = this.seq;
    this.state.audit.push(audit);
    if (this.state.audit.length > MAX_AUDIT) this.state.audit.splice(0, this.state.audit.length - MAX_AUDIT);
    this.write('state', (s) => s.setTier(id, to, this.seq, audit));
  }
  stats() { return { persistent: this.persistent, records: this.recs.size, seq: this.seq, tierOverrides: Object.keys(this.state.tiers).length, tierChanges: this.state.audit.length }; }
  close() { if (this.owns && this.store) { this.store.close(); this.store = null; } }
}
module.exports = { History, MAX_RECORDS };
