'use strict';
// SQLite storage for history, adaptive tiers, analytics events and the best/worst archive.
// One file (<dir>/doodle.sqlite) replaces history.jsonl, state.json, analytics.jsonl(.1) and archive/*.json.gz.
// Uses only synchronous SQL so the same repository code maps onto Durable Object `ctx.storage.sql` later.
// Nothing here deletes data: retention is a read-time view (see Analytics.records) and a cap on new archive writes.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { SCHEMA_VERSION, DDL } = require('./schema');

class Store {
  constructor(file, log = () => {}) {
    this.file = file; this.log = log; this.st = new Map();
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec(DDL);
    if (this.getMeta('schema') === null) this.setMeta('schema', String(SCHEMA_VERSION));
    else if (+this.getMeta('schema') > SCHEMA_VERSION) throw new Error('database schema is newer than this build');
  }
  q(sql) { let s = this.st.get(sql); if (!s) { s = this.db.prepare(sql); this.st.set(sql, s); } return s; }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }
  getMeta(k) { const r = this.q('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : null; }
  setMeta(k, v) { this.q('INSERT INTO meta(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)); }
  isEmpty() {
    return ['drawings', 'analytics_events', 'archive', 'tiers', 'tier_audit'].every((t) => this.db.prepare(`SELECT count(*) n FROM ${t}`).get().n === 0);
  }

  // ----- history -----
  putDrawing(seq, rec) { this.q('INSERT OR REPLACE INTO drawings(seq,tid,g,rec) VALUES (?,?,?,?)').run(seq, rec.tid ?? null, rec.g ?? null, JSON.stringify(rec)); }
  loadDrawings(limit) {
    return this.q('SELECT seq, rec FROM drawings ORDER BY seq DESC LIMIT ?').all(limit).reverse().map((r) => ({ ...JSON.parse(r.rec), seq: r.seq }));
  }
  maxSeq() { return this.q('SELECT coalesce(max(seq),0) n FROM drawings').get().n; }
  drawingCount() { return this.q('SELECT count(*) n FROM drawings').get().n; }
  allDrawings() { return this.q('SELECT seq, rec FROM drawings ORDER BY seq').all().map((r) => ({ ...JSON.parse(r.rec), seq: r.seq })); }
  loadTiers() {
    const tiers = {}, since = {};
    for (const r of this.q('SELECT id, tier, since_seq FROM tiers').all()) { tiers[r.id] = r.tier; if (r.since_seq) since[r.id] = r.since_seq; }
    return { tiers, since };
  }
  loadAudit(limit = -1) { return this.q('SELECT json FROM (SELECT n, json FROM tier_audit ORDER BY n DESC LIMIT ?) ORDER BY n').all(limit).map((r) => JSON.parse(r.json)); }
  auditAll() { return this.q('SELECT json FROM tier_audit ORDER BY n').all().map((r) => r.json); }
  putTier(id, tier, sinceSeq) { this.q('INSERT INTO tiers(id,tier,since_seq) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET tier=excluded.tier, since_seq=excluded.since_seq').run(id, tier, sinceSeq || 0); }
  addAudit(a) { this.q('INSERT INTO tier_audit(at,json) VALUES (?,?)').run(Number.isFinite(a && a.at) ? a.at : null, JSON.stringify(a)); }
  setTier(id, tier, sinceSeq, audit) { this.tx(() => { this.putTier(id, tier, sinceSeq); this.addAudit(audit); }); }

  // ----- analytics -----
  addEvent(e, text = JSON.stringify(e)) { this.q('INSERT INTO analytics_events(at,type,qa,json) VALUES (?,?,?,?)').run(e.at, e.type, e.qa ? 1 : 0, text); }
  // Read view: product events newer than productSince, operation samples newer than opsSince. Rows are never deleted.
  events(productSince, opsSince) {
    return this.q("SELECT json FROM analytics_events WHERE (type<>'operation' AND at>?) OR (type='operation' AND at>?) ORDER BY at, id")
      .all(productSince, opsSince).map((r) => { try { return JSON.parse(r.json); } catch { return null; } }).filter(Boolean);
  }
  // Retention: delete analytics rows older than beforeAt, at most limit rows per call; returns the number deleted. Analytics only.
  pruneEvents(beforeAt, limit = 500) { return this.q('DELETE FROM analytics_events WHERE id IN (SELECT id FROM analytics_events WHERE at<? ORDER BY id LIMIT ?) RETURNING id').all(beforeAt, limit).length; }
  eventLines() { return this.q('SELECT json FROM analytics_events ORDER BY id').all().map((r) => r.json); }
  eventBytes() { return this.q('SELECT coalesce(sum(length(json)),0) n FROM analytics_events').get().n; }

  // ----- archive -----
  archiveStats() { const r = this.q('SELECT count(*) files, coalesce(sum(size),0) bytes FROM archive').get(); return { files: r.files, bytes: r.bytes }; }
  archiveHas(id) { return !!this.q('SELECT 1 x FROM archive WHERE game_id=?').get(id); }
  archivePut(id, savedAt, buf, sha256) { this.q('INSERT INTO archive(game_id,saved_at,size,sha256,data) VALUES (?,?,?,?,?)').run(id, savedAt, buf.length, sha256, buf); }
  archiveList() { return this.q('SELECT game_id, size, saved_at FROM archive ORDER BY saved_at DESC, game_id').all().map((r) => ({ gameId: r.game_id, bytes: r.size, mtime: r.saved_at })); }
  archiveGet(id) { const r = this.q('SELECT data FROM archive WHERE game_id=?').get(id); return r ? Buffer.from(r.data) : null; }
  archiveSha(id) { const r = this.q('SELECT sha256 FROM archive WHERE game_id=?').get(id); return r ? r.sha256 : null; }

  close() { try { this.db.close(); } catch {} }
}

const LEGACY = ['history.jsonl', 'state.json', 'analytics.jsonl', 'analytics.jsonl.1'];
// openStore(dir) -> Store | null (no dir: memory-only, as before). opts.file opens an explicit database file with no auto-import.
function openStore(dir, opts = {}) {
  const log = opts.log || (() => {});
  if (opts.file) return new Store(opts.file, log);
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const store = new Store(path.join(dir, 'doodle.sqlite'), log);
  // One-time, non-destructive adoption of a pre-SQLite data directory. Legacy files stay in place as the rollback copy.
  const hasLegacy = LEGACY.some((f) => fs.existsSync(path.join(dir, f))) || fs.existsSync(path.join(dir, 'archive'));
  if (hasLegacy && store.getMeta('legacy_import') === null && store.isEmpty()) {
    const rep = require('./import-legacy').importLegacy(store, dir);
    log(`imported legacy data: ${rep.history.records} drawings, ${rep.analytics.imported} analytics events, ${rep.archive.imported} archive files`);
  }
  return store;
}
module.exports = { Store, openStore, SCHEMA_VERSION, DDL };
