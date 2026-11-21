// Durable Object SQLite implementation of the Store interface (same methods as ../../store.js, which uses node:sqlite).
// Uses only synchronous SQL on ctx.storage so a Room/Hub can keep the shared synchronous game core unchanged.
// Nothing here deletes history, analytics or archive rows. The `rooms` table is the only transient data (live room snapshots).
import schema from '../../schema.js';

const { SCHEMA_VERSION, DDL } = schema;
const ROOMS_DDL = 'CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, snap TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;';

export class DoStore {
  constructor(storage, log = () => {}) {
    this.storage = storage; this.sql = storage.sql; this.log = log;
    this.rowsWritten = 0; this.rowsRead = 0; // meter for the free-plan daily budgets
    this.sql.exec(DDL); this.sql.exec(ROOMS_DDL);
    if (this.getMeta('schema') === null) this.setMeta('schema', String(SCHEMA_VERSION));
    else if (+this.getMeta('schema') > SCHEMA_VERSION) throw new Error('database schema is newer than this build');
  }
  run(query, ...args) {
    const c = this.sql.exec(query, ...args);
    const rows = c.toArray(); // drain so rowsRead/rowsWritten are final
    this.rowsWritten += c.rowsWritten; this.rowsRead += c.rowsRead;
    return rows;
  }
  tx(fn) { return this.storage.transactionSync(fn); }
  getMeta(k) { const r = this.run('SELECT v FROM meta WHERE k=?', k); return r.length ? r[0].v : null; }
  setMeta(k, v) { this.run('INSERT INTO meta(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v)); }
  isEmpty() {
    return ['drawings', 'analytics_events', 'archive', 'tiers', 'tier_audit'].every((t) => this.run(`SELECT count(*) n FROM ${t}`)[0].n === 0);
  }

  // ----- history -----
  putDrawing(seq, rec) { this.run('INSERT OR REPLACE INTO drawings(seq,tid,g,rec) VALUES (?,?,?,?)', seq, rec.tid ?? null, rec.g ?? null, JSON.stringify(rec)); }
  loadDrawings(limit) {
    return this.run('SELECT seq, rec FROM drawings ORDER BY seq DESC LIMIT ?', limit).reverse().map((r) => ({ ...JSON.parse(r.rec), seq: r.seq }));
  }
  maxSeq() { return this.run('SELECT coalesce(max(seq),0) n FROM drawings')[0].n; }
  drawingCount() { return this.run('SELECT count(*) n FROM drawings')[0].n; }
  allDrawings() { return this.run('SELECT seq, rec FROM drawings ORDER BY seq').map((r) => ({ ...JSON.parse(r.rec), seq: r.seq })); }
  loadTiers() {
    const tiers = {}, since = {};
    for (const r of this.run('SELECT id, tier, since_seq FROM tiers')) { tiers[r.id] = r.tier; if (r.since_seq) since[r.id] = r.since_seq; }
    return { tiers, since };
  }
  loadAudit(limit = -1) { return this.run('SELECT json FROM (SELECT n, json FROM tier_audit ORDER BY n DESC LIMIT ?) ORDER BY n', limit).map((r) => JSON.parse(r.json)); }
  auditAll() { return this.run('SELECT json FROM tier_audit ORDER BY n').map((r) => r.json); }
  putTier(id, tier, sinceSeq) { this.run('INSERT INTO tiers(id,tier,since_seq) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET tier=excluded.tier, since_seq=excluded.since_seq', id, tier, sinceSeq || 0); }
  addAudit(a) { this.run('INSERT INTO tier_audit(at,json) VALUES (?,?)', Number.isFinite(a && a.at) ? a.at : null, JSON.stringify(a)); }
  setTier(id, tier, sinceSeq, audit) { this.tx(() => { this.putTier(id, tier, sinceSeq); this.addAudit(audit); }); }

  // ----- analytics -----
  addEvent(e, text = JSON.stringify(e)) { this.run('INSERT INTO analytics_events(at,type,qa,json) VALUES (?,?,?,?)', e.at, e.type, e.qa ? 1 : 0, text); }
  events(productSince, opsSince) {
    return this.run("SELECT json FROM analytics_events WHERE (type<>'operation' AND at>?) OR (type='operation' AND at>?) ORDER BY at, id", productSince, opsSince)
      .map((r) => { try { return JSON.parse(r.json); } catch { return null; } }).filter(Boolean);
  }
  eventLines() { return this.run('SELECT json FROM analytics_events ORDER BY id').map((r) => r.json); }
  eventBytes() { return this.run('SELECT coalesce(sum(length(json)),0) n FROM analytics_events')[0].n; }

  // ----- archive -----
  archiveStats() { const r = this.run('SELECT count(*) files, coalesce(sum(size),0) bytes FROM archive')[0]; return { files: r.files, bytes: r.bytes }; }
  archiveHas(id) { return this.run('SELECT 1 x FROM archive WHERE game_id=?', id).length > 0; }
  archivePut(id, savedAt, buf, sha256) { this.run('INSERT INTO archive(game_id,saved_at,size,sha256,data) VALUES (?,?,?,?,?)', id, savedAt, buf.length, sha256, new Uint8Array(buf)); }
  archiveList() { return this.run('SELECT game_id, size, saved_at FROM archive ORDER BY saved_at DESC, game_id').map((r) => ({ gameId: r.game_id, bytes: r.size, mtime: r.saved_at })); }
  archiveGet(id) { const r = this.run('SELECT data FROM archive WHERE game_id=?', id); return r.length ? Buffer.from(r[0].data) : null; }
  archiveSha(id) { const r = this.run('SELECT sha256 FROM archive WHERE game_id=?', id); return r.length ? r[0].sha256 : null; }

  // ----- live room snapshots (transient: lets a hibernated/evicted hub rebuild rooms whose sockets are still connected) -----
  putRoom(code, snap, at) { this.run('INSERT INTO rooms(code,snap,at) VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET snap=excluded.snap, at=excluded.at', code, snap, at); }
  delRoom(code) { this.run('DELETE FROM rooms WHERE code=?', code); }
  loadRooms() { return this.run('SELECT code, snap FROM rooms'); }

  close() {}
}
