'use strict';
// Durable anonymous drawing history + adaptive-difficulty state.
// Files in dir: history.jsonl (append-only, one JSON per line), state.json (+ .bak, atomic tmp+rename).
// No names, IPs, tokens, chat or strokes are ever written. `g` is a random per-game id (not the room code).
// Retention: latest MAX_RECORDS drawings; older records are dropped by atomic compaction.
// A start line with no end line (crash/restart mid-drawing) is loaded as outcome "abandoned".
const fs = require('node:fs');
const path = require('node:path');
const STATE_V = 1, MAX_RECORDS = 20000, MAX_AUDIT = 1000;

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

class History {
  constructor({ dir = null, maxRecords = MAX_RECORDS, log = () => {} } = {}) {
    this.dir = dir; this.max = maxRecords; this.log = log;
    this.recs = new Map(); this.seq = 0; this.last = new Map(); this.lines = 0; this.degraded = false;
    this.state = { v: STATE_V, tiers: {}, since: {}, audit: [] };
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, 'history.jsonl'); this.sfile = path.join(dir, 'state.json');
      this.loadState(); this.load();
    }
  }
  get persistent() { return !!this.dir && !this.degraded; }

  loadState() {
    for (const f of [this.sfile, this.sfile + '.bak']) {
      try {
        const s = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (s && s.v === STATE_V && s.tiers && s.audit) { this.state = { since: {}, ...s }; return; }
      } catch (e) { if (e.code !== 'ENOENT') this.log('state unreadable', f, e.message); }
    }
  }
  saveState() {
    if (!this.dir) return;
    try {
      try { fs.copyFileSync(this.sfile, this.sfile + '.bak'); } catch {}
      atomicWrite(this.sfile, JSON.stringify(this.state));
    } catch (e) { this.degraded = true; this.log('state write failed', e.message); }
  }
  load() {
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    let bad = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { bad++; continue; }
      if (!o || !Number.isInteger(o.seq) || typeof o.tid !== 'string' && o.k === 's') { bad++; continue; }
      this.lines++;
      if (o.k === 'e') { const r = this.recs.get(o.seq); if (r) Object.assign(r, o, { k: undefined, tid: r.tid }); }
      else { const { k, ...r } = o; this.recs.set(o.seq, k === 's' ? { out: 'abandoned', ...r } : r); }
      this.seq = Math.max(this.seq, o.seq);
    }
    for (const r of [...this.recs.values()].sort((a, b) => a.seq - b.seq)) this.last.set(r.tid, r.seq);
    if (bad || (raw && !raw.endsWith('\n'))) { this.log('history: dropped', bad, 'bad line(s); rewriting'); this.compact(true); }
  }
  append(o) {
    this.lines++;
    if (!this.dir || this.degraded) return;
    try {
      const fd = fs.openSync(this.file, 'a');
      try { fs.writeSync(fd, JSON.stringify(o) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (e) { this.degraded = true; this.log('history write failed (memory only)', e.message); }
  }
  // begin a drawing; rec: {tid,d,m,g,t0,el0,budget}
  start(rec) {
    const seq = ++this.seq, r = { seq, out: 'abandoned', ...rec };
    this.recs.set(seq, r); this.last.set(rec.tid, seq);
    this.append({ k: 's', ...r });
    return seq;
  }
  end(seq, f) {
    const r = this.recs.get(seq); if (!r) return;
    Object.assign(r, f); this.append({ k: 'e', seq, ...f });
    if (this.lines > this.max * 1.25 || this.recs.size > this.max * 1.25) this.compact();
  }
  compact(force) {
    const keep = [...this.recs.values()].sort((a, b) => a.seq - b.seq).slice(-this.max);
    if (keep.length < this.recs.size) {
      this.recs = new Map(keep.map((r) => [r.seq, r]));
      this.last = new Map(); for (const r of keep) this.last.set(r.tid, r.seq);
    }
    this.lines = keep.length;
    if (!this.dir) return;
    try { atomicWrite(this.file, keep.map((r) => JSON.stringify({ k: 'r', ...r })).join('\n') + (keep.length ? '\n' : '')); }
    catch (e) { this.degraded = true; this.log('compact failed', e.message); }
  }
  forTopic(tid) { return [...this.recs.values()].filter((r) => r.tid === tid); }

  tierOf(id, base) { return this.state.tiers[id] || base; }
  setTier(id, to, audit) {
    this.state.tiers[id] = to; this.state.since[id] = this.seq;
    this.state.audit.push(audit);
    if (this.state.audit.length > MAX_AUDIT) this.state.audit.splice(0, this.state.audit.length - MAX_AUDIT);
    this.saveState();
  }
  stats() { return { persistent: this.persistent, records: this.recs.size, seq: this.seq, tierOverrides: Object.keys(this.state.tiers).length, tierChanges: this.state.audit.length }; }
  close() { if (this.dir && !this.degraded) this.saveState(); }
}
module.exports = { History, MAX_RECORDS, atomicWrite };
