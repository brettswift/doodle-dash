'use strict';
// Optional first-party analytics. Events are appended to the SQLite analytics_events table; read views are windowed, rows are never deleted.
const crypto = require('node:crypto');
const { openStore } = require('./store');

// Process metrics are optional: Cloudflare Workers has no cpuUsage/memoryUsage, so those fields are null there (unavailable, not zero).
const hr = () => { try { return process.hrtime.bigint(); } catch { return BigInt(Date.now()) * 1000000n; } };
const cpuUse = () => { try { return process.cpuUsage(); } catch { return null; } };
const memUse = () => { try { return process.memoryUsage(); } catch { return {}; } };
const MAX_BYTES = 8 * 1024 * 1024;
const DAY = 86400000;
const allowed = new Set(['landing', 'nameEntered', 'intent', 'queueEntered', 'queueLeft', 'queueTimeout', 'lobbyFormed', 'gameStarted', 'gameEnded', 'gameAbandoned', 'privateLobbyCreated', 'privateLobbyClosed', 'connect', 'reconnect', 'error', 'operation']);
const clean = (v, n = 80) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n);

class Analytics {
  constructor({ dir, store = null, log = () => {}, enabled = true, qa = false } = {}) {
    this.dir = dir; this.log = log; this.qa = !!qa; this.pending = 0; this.dropped = 0; this.writing = false; this.queue = []; this.started = Date.now();
    this.store = enabled ? (store || (dir ? openStore(dir, { log }) : null)) : null; this.enabled = !!this.store;
    this.counts = Object.create(null); this.lastLag = 0; this.lastTick = hr();
    this.runId = crypto.randomBytes(8).toString('hex'); this.cpu = cpuUse(); this.cpuAt = hr();
    this.cpuPercent = null;
  }
  tick() { const now = hr(); const elapsed = Number(now - this.lastTick) / 1e6; this.lastLag = Math.max(0, elapsed - 250); this.lastTick = now; }
  event(type, props = {}) {
    if (!this.enabled || !allowed.has(type)) return;
    const e = { ...props, v: 1, at: Date.now(), type, qa: this.qa || undefined, runId: this.runId };
    try { this.store.addEvent(e); this.counts[type] = (this.counts[type] || 0) + 1; }
    catch (err) { this.dropped++; this.log('analytics write failed', err.message); }
  }
  sample(extra = {}) {
    const now = hr(), cpu = cpuUse();
    if (cpu && this.cpu) this.cpuPercent = Math.round((cpu.user - this.cpu.user + cpu.system - this.cpu.system) / (Number(now - this.cpuAt) / 1000) * 1000) / 10;
    this.cpu = cpu; this.cpuAt = now;
    this.event('operation', this.health(extra));
  }
  operations(records = this.records()) {
    const samples = records.filter((e) => !e.qa && e.type === 'operation' && e.at > Date.now() - 7 * DAY);
    return { enabled: this.enabled, retentionDays: 7, intervalSeconds: 60, samples,
      limitation: 'Process samples only while Fly machine runs. Missing intervals, host metrics, and pre-release history are unavailable, not zero.' };
  }
  health(extra = {}) {
    const mem = memUse(); let size = 0;
    try { if (this.store) size = this.store.eventBytes(); } catch {}
    return { ...extra, analyticsEnabled: this.enabled, qa: this.qa, cpuPercent: this.cpuPercent, hostCpuPercent: null, hostMemoryBytes: null,
      uptimeMs: Date.now() - this.started, rss: mem.rss || null, heapUsed: mem.heapUsed || null, heapTotal: mem.heapTotal || null,
      eventLoopLagMs: Math.round(this.lastLag), openSockets: extra.openSockets || 0, activeRooms: extra.activeRooms || 0,
      activePlayers: extra.activePlayers || 0, publicQueue: extra.publicQueue || 0, pendingWrites: this.pending,
      droppedEvents: this.dropped, eventStoreBytes: size, errorsSinceStart: this.counts.error || 0, counts: { ...this.counts } };
  }
  records() {
    if (!this.enabled) return [];
    const now = Date.now(); // read view only: older rows stay in the database
    return this.store.events(now - 90 * DAY, now - 7 * DAY);
  }
  summary(records = this.records()) {
    const now = Date.now(), recs = records.filter((x) => x.at > now - 90 * DAY && !x.qa && x.type !== 'operation');
    const games = new Map(), names = new Map(), modes = { public: { started: 0, ended: 0, configured: [], completed: [] }, private: { started: 0, ended: 0, configured: [], completed: [] } };
    for (const e of recs) {

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
    const avg = (a) => a.length ? Math.round(a.reduce((s, n) => s + n, 0) / a.length * 10) / 10 : null;
    const lobbies = new Map();
    for (const e of recs) {
      if (e.type === 'privateLobbyCreated') lobbies.set(e.lobbyId, { status: e.runId === this.runId ? 'waiting' : 'unknown' });
      if (e.type === 'gameStarted' && e.mode === 'private') { const x = lobbies.get(e.lobbyId || e.gameId); if (x) x.status = 'started'; }
      if (e.type === 'privateLobbyClosed') { const x = lobbies.get(e.lobbyId); if (x && x.status !== 'started') x.status = 'closed'; }
    }
    const privateLobbies = { created: lobbies.size, started: 0, closedWithoutStarting: 0, currentlyWaiting: 0 };
    const unknown = [...lobbies.values()].filter((x) => x.status === 'unknown').length;
    if (unknown) privateLobbies.unknownAfterRestart = unknown;
    for (const x of lobbies.values()) { if (x.status === 'started') privateLobbies.started++; else if (x.status === 'closed') privateLobbies.closedWithoutStarting++; else if (x.status === 'waiting') privateLobbies.currentlyWaiting++; }
    privateLobbies.createToStartRate = privateLobbies.created ? Math.round(privateLobbies.started / privateLobbies.created * 1000) / 10 : null;
    const audience = audienceSummary(recs, now);
    const out = { generatedAt: now, enabled: this.enabled, retentionDays: 90, maxStoreBytes: 2 * MAX_BYTES,
      observedFrom: recs[0]?.at ?? null, events: recs.length, anonymousBrowsers: audience.uniqueBrowsers, audience, modes: {}, privateLobbies, names: [],
      limitations: ['Opt-in connected browsers, not all visitors or people. No page views before connecting.', 'New means first observed in retained data, not lifetime new. Browser resets and shared devices affect counts.', 'Data is capped at 16 MiB and up to 90 days. Small samples and older missing data limit retention estimates.', 'Games and lobby counts are anonymous operational totals, including non-consenting players. Names and browser cohorts require consent.', 'Coarse location is unavailable unless a trusted edge supplies it. Display names are not verified identities.'] };
    for (const [mode, m] of Object.entries(modes)) {
      const entered = new Set(recs.filter((e) => e.browserId && (mode === 'public' ? e.type === 'queueEntered' : e.type === 'nameEntered' && e.mode === 'private')).map((e) => e.browserId));
      const started = new Set(recs.filter((e) => e.type === 'gameStarted' && e.mode === mode).flatMap((e) => (e.participants || []).map((p) => p.browserId)).filter((id) => entered.has(id)));
      out.modes[mode] = { gamesStarted: m.started, gamesFinished: m.ended, configuredRounds: { average: avg(m.configured), distribution: dist(m.configured) }, completedRounds: { average: avg(m.completed), distribution: dist(m.completed) },
        consentedConversion: { enteredBrowsers: entered.size, startedBrowsers: started.size, percent: entered.size ? Math.round(started.size / entered.size * 1000) / 10 : null } };
    }
    out.names = [...names.values()].map((x) => ({ name: x.name, firstSeen: x.firstSeen, lastSeen: x.lastSeen, sessions: x.sessions.size, games: x.games.size, regions: [...x.regions] })).sort((a, b) => b.lastSeen - a.lastSeen);
    return out;
  }
}
function audienceSummary(recs, now) {
  const browsers = new Map(), day = (at) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
  const today = day(now), daily = new Map();
  for (const e of recs) for (const p of [e, ...(e.participants || [])]) {
    if (!/^[a-f0-9]{32}$/i.test(p.browserId || '')) continue;
    const id = p.browserId.toLowerCase(), d = day(e.at);
    if (!browsers.has(id)) browsers.set(id, { first: d, days: new Set() });
    browsers.get(id).days.add(d);
    if (!daily.has(d)) daily.set(d, new Set()); daily.get(d).add(id);
  }
  const retention = (days) => {
    let eligible = 0, returned = 0;
    for (const b of browsers.values()) {
      const target = new Date(Date.parse(b.first) + days * DAY).toISOString().slice(0, 10);
      if (target >= today) continue;
      eligible++; if (b.days.has(target)) returned++;
    }
    return { eligible, returned, percent: eligible ? Math.round(returned / eligible * 1000) / 10 : null };
  };
  return { uniqueBrowsers: browsers.size, singleDayBrowsers: [...browsers.values()].filter((b) => b.days.size === 1).length,
    returningBrowsers: [...browsers.values()].filter((b) => b.days.size > 1).length,
    calendarTimezone: 'America/Edmonton', retention: { day1: retention(1), day7: retention(7) },
    daily: [...daily].map(([d, ids]) => { const fresh = [...ids].filter((id) => browsers.get(id).first === d).length; return { day: d, active: ids.size, new: fresh, returning: ids.size - fresh }; }) };
}
function dist(a) { const out = {}; for (const n of a) out[n] = (out[n] || 0) + 1; return out; }
function anonId(value) { return /^[a-f0-9]{32}$/i.test(value || '') ? value.toLowerCase() : crypto.randomBytes(16).toString('hex'); }
module.exports = { Analytics, anonId, clean };
