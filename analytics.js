'use strict';
// Optional first-party analytics. JSONL is append-only, bounded, and never blocks gameplay.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 8 * 1024 * 1024;
const DAY = 86400000;
const allowed = new Set(['landing', 'nameEntered', 'intent', 'queueEntered', 'queueLeft', 'queueTimeout', 'lobbyFormed', 'gameStarted', 'gameEnded', 'gameAbandoned', 'connect', 'reconnect', 'error']);
const clean = (v, n = 80) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n);

class Analytics {
  constructor({ dir, log = () => {}, enabled = true } = {}) {
    this.dir = dir; this.log = log; this.enabled = !!(dir && enabled); this.file = dir && path.join(dir, 'analytics.jsonl');
    this.pending = 0; this.dropped = 0; this.writing = false; this.queue = []; this.started = Date.now();
    this.counts = Object.create(null); this.lastLag = 0; this.lastTick = process.hrtime.bigint();
    if (this.enabled) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { this.enabled = false; this.log('analytics disabled', e.message); } }
  }
  tick() { const now = process.hrtime.bigint(); const elapsed = Number(now - this.lastTick) / 1e6; this.lastLag = Math.max(0, elapsed - 250); this.lastTick = now; }
  event(type, props = {}) {
    if (!this.enabled || !allowed.has(type)) return;
    if (this.queue.length >= 200) { this.dropped++; return; }
    const e = { v: 1, at: Date.now(), type, ...props };
    this.queue.push(JSON.stringify(e) + '\n'); this.counts[type] = (this.counts[type] || 0) + 1;
    if (!this.writing) this.flush();
  }
  flush() {
    if (!this.queue.length || !this.enabled) return;
    this.writing = true; const text = this.queue.splice(0).join(''); this.pending += Buffer.byteLength(text);
    fs.appendFile(this.file, text, (err) => {
      this.pending -= Buffer.byteLength(text); this.writing = false;
      if (err) { this.dropped++; this.log('analytics write failed', err.message); }
      else this.rotate();
      if (this.queue.length) this.flush();
    });
  }
  rotate() {
    try {
      if (fs.statSync(this.file).size <= MAX_BYTES) return;
      const old = `${this.file}.1`; try { fs.unlinkSync(old); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      fs.renameSync(this.file, old);
    } catch (e) { this.log('analytics rotate failed', e.message); }
  }
  health(extra = {}) {
    const mem = process.memoryUsage(); let size = 0;
    try { size = fs.statSync(this.file).size; } catch {}
    return { uptimeMs: Date.now() - this.started, rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal,
      eventLoopLagMs: Math.round(this.lastLag), openSockets: extra.openSockets || 0, activeRooms: extra.activeRooms || 0,
      activePlayers: extra.activePlayers || 0, publicQueue: extra.publicQueue || 0, pendingWrites: this.pending,
      droppedEvents: this.dropped, eventStoreBytes: size, counts: this.counts };
  }
  records() {
    if (!this.enabled) return [];
    let raw = ''; try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  }
  summary() {
    const now = Date.now(), recs = this.records().filter((x) => x.at > now - 90 * DAY);
    const games = new Map(), browsers = new Set(), names = new Map(), modes = { public: { started: 0, ended: 0, configured: [], completed: [] }, private: { started: 0, ended: 0, configured: [], completed: [] } };
    for (const e of recs) {
      if (e.browserId) browsers.add(e.browserId);
      if (e.type === 'nameEntered' && e.name) { const x = names.get(e.name.toLowerCase()) || { name: e.name, firstSeen: e.at, lastSeen: e.at, sessions: new Set(), games: new Set(), regions: new Set() }; x.lastSeen = e.at; if (e.sessionId) x.sessions.add(e.sessionId); if (e.gameId) x.games.add(e.gameId); if (e.region || e.country) x.regions.add([e.country, e.region].filter(Boolean).join('-')); names.set(e.name.toLowerCase(), x); }
      if (e.type === 'gameStarted') {
        games.set(e.gameId, e); const m = modes[e.mode]; if (m) { m.started++; m.configured.push(e.configuredRounds); }
        for (const p of e.participants || []) {
          if (!p.name) continue;
          const x = names.get(p.name.toLowerCase()) || { name: p.name, firstSeen: e.at, lastSeen: e.at, sessions: new Set(), games: new Set(), regions: new Set() };
          x.lastSeen = Math.max(x.lastSeen, e.at); if (p.sessionId) x.sessions.add(p.sessionId); x.games.add(e.gameId); if (p.region || p.country) x.regions.add([p.country, p.region].filter(Boolean).join('-')); names.set(p.name.toLowerCase(), x);
        }
      }
      if (e.type === 'gameEnded' || e.type === 'gameAbandoned') { const start = games.get(e.gameId); const m = modes[e.mode || start?.mode]; if (m) { if (e.type === 'gameEnded') m.ended++; m.completed.push(e.completedRounds || 0); } }
    }
    const avg = (a) => a.length ? Math.round(a.reduce((s, n) => s + n, 0) / a.length * 10) / 10 : 0;
    const out = { generatedAt: now, retentionDays: 90, events: recs.length, anonymousBrowsers: browsers.size, modes: {}, names: [] };
    for (const [mode, m] of Object.entries(modes)) out.modes[mode] = { gamesStarted: m.started, gamesFinished: m.ended, configuredRounds: { average: avg(m.configured), distribution: dist(m.configured) }, completedRounds: { average: avg(m.completed), distribution: dist(m.completed) } };
    out.names = [...names.values()].map((x) => ({ name: x.name, firstSeen: x.firstSeen, lastSeen: x.lastSeen, sessions: x.sessions.size, games: x.games.size, regions: [...x.regions] })).sort((a, b) => b.lastSeen - a.lastSeen);
    return out;
  }
}
function dist(a) { const out = {}; for (const n of a) out[n] = (out[n] || 0) + 1; return out; }
function anonId(value) { return /^[a-f0-9]{32}$/i.test(value || '') ? value.toLowerCase() : crypto.randomBytes(16).toString('hex'); }
module.exports = { Analytics, anonId, clean };
