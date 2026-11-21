'use strict';
// One-time importer: legacy data dir (history.jsonl, state.json, analytics.jsonl(.1), archive/*.json.gz) -> SQLite store.
// Source files are only read, never modified or deleted. Importing the same sources twice is a no-op.
// Usage: node import-legacy.js <legacy dir | backup .tar.gz> <database file> [--verify]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ID_RE = /^[0-9a-f]{8}$/;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const readOr = (f) => { try { return fs.readFileSync(f); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

// Same record semantics as the old History.load: k=s start (abandoned until ended), k=e end merged into its start,
// k=r compacted full record. Malformed lines are counted, not imported; an end with no start is ignored.
function parseHistory(raw) {
  const recs = new Map(); let lines = 0, badLines = 0, orphanEnds = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { badLines++; continue; }
    if (!o || !Number.isInteger(o.seq) || (typeof o.tid !== 'string' && o.k === 's')) { badLines++; continue; }
    lines++;
    const { k, ...rest } = o;
    if (k === 'e') { const r = recs.get(o.seq); if (r) { const { seq, ...f } = rest; recs.set(o.seq, { ...r, ...f, tid: r.tid }); } else orphanEnds++; }
    else { const { seq, ...r } = rest; recs.set(o.seq, k === 's' ? { out: 'abandoned', ...r } : r); }
  }
  const sorted = [...recs.entries()].sort((a, b) => a[0] - b[0]);
  const h = crypto.createHash('sha256'); for (const [seq, r] of sorted) h.update(`${seq}\t${JSON.stringify(r)}\n`);
  return { recs: sorted, lines, badLines, orphanEnds, maxSeq: sorted.length ? sorted[sorted.length - 1][0] : 0, checksum: h.digest('hex') };
}
function parseState(dir) {
  for (const f of ['state.json', 'state.json.bak']) {
    const b = readOr(path.join(dir, f)); if (!b) continue;
    try { const s = JSON.parse(b); if (s && s.v === 1 && s.tiers && s.audit) return { tiers: s.tiers, since: s.since || {}, audit: s.audit, file: f, sha: sha(b) }; } catch {}
  }
  return { tiers: {}, since: {}, audit: [], file: null, sha: null };
}
function parseAnalytics(dir) {
  const out = { lines: 0, rows: [], skipped: 0, shas: [] };
  for (const f of ['analytics.jsonl.1', 'analytics.jsonl']) {
    const b = readOr(path.join(dir, f)); if (!b) continue;
    out.shas.push(f + ':' + sha(b));
    for (const line of b.toString('utf8').split('\n')) {
      if (!line) continue; out.lines++;
      try { const e = JSON.parse(line); if (e && typeof e.type === 'string' && Number.isFinite(e.at)) { out.rows.push({ e, line }); continue; } } catch {}
      out.skipped++;
    }
  }
  const h = crypto.createHash('sha256'); for (const r of out.rows) h.update(r.line + '\n'); out.checksum = h.digest('hex');
  return out;
}
function parseArchive(dir) {
  const d = path.join(dir, 'archive'), out = { good: [], quarantined: [], ignored: 0 };
  let names = []; try { names = fs.readdirSync(d).sort(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const f of names) {
    const id = f.slice(0, -8);
    if (!f.endsWith('.json.gz') || !ID_RE.test(id)) { out.ignored++; continue; }
    const buf = fs.readFileSync(path.join(d, f));
    try { const rec = JSON.parse(zlib.gunzipSync(buf)); if (!rec || typeof rec !== 'object') throw new Error('not an object'); out.good.push({ id, buf, sha: sha(buf), savedAt: rec.savedAt || fs.statSync(path.join(d, f)).mtime.toISOString() }); }
    catch { out.quarantined.push(f); }
  }
  return out;
}
function sources(dir) {
  const hb = readOr(path.join(dir, 'history.jsonl'));
  const history = parseHistory(hb ? hb.toString('utf8') : ''), state = parseState(dir), analytics = parseAnalytics(dir), archive = parseArchive(dir);
  const digest = sha(JSON.stringify([hb ? sha(hb) : null, state.sha, analytics.shas, archive.good.map((a) => a.id + ':' + a.sha), archive.quarantined]));
  return { history, state, analytics, archive, digest, histSha: hb ? sha(hb) : null };
}

function importLegacy(store, dir) {
  const src = sources(dir), marker = 'legacy_import:' + src.digest;
  const prior = store.getMeta(marker);
  if (prior !== null) return { ...JSON.parse(prior), skipped: true };
  if (!store.isEmpty()) throw new Error('refusing to import into a database that already holds data (unplanned delta)');
  const rep = { at: Date.now(), digest: src.digest, sources: { history: src.histSha, state: src.state.sha, analytics: src.analytics.shas },
    history: { lines: src.history.lines, records: src.history.recs.length, badLines: src.history.badLines, orphanEnds: src.history.orphanEnds, maxSeq: src.history.maxSeq, checksum: src.history.checksum },
    tiers: Object.keys(src.state.tiers).length, audit: { imported: src.state.audit.length },
    analytics: { lines: src.analytics.lines, imported: src.analytics.rows.length, skipped: src.analytics.skipped, lastId: 0, checksum: src.analytics.checksum },
    archive: { files: src.archive.good.length + src.archive.quarantined.length, imported: src.archive.good.length, quarantined: src.archive.quarantined.length, quarantinedNames: src.archive.quarantined, collisions: 0, ignored: src.archive.ignored } };
  store.tx(() => {
    for (const [seq, r] of src.history.recs) store.putDrawing(seq, r);
    for (const [id, t] of Object.entries(src.state.tiers)) store.putTier(id, t, src.state.since[id] || 0);
    for (const a of src.state.audit) store.addAudit(a);
    for (const { e, line } of src.analytics.rows) store.addEvent(e, line);
    for (const a of src.archive.good) store.archivePut(a.id, a.savedAt, a.buf, a.sha);
    rep.analytics.lastId = store.db.prepare('SELECT coalesce(max(id),0) n FROM analytics_events').get().n;
    store.setMeta(marker, JSON.stringify(rep)); store.setMeta('legacy_import', src.digest);
  });
  return rep;
}

// Independent re-read of the sources compared with what the database holds for them (rows added later by live play are ignored).
function verifyLegacy(store, dir) {
  const problems = [], src = sources(dir), raw = store.getMeta('legacy_import:' + src.digest);
  if (raw === null) return { ok: false, problems: ['no import recorded for the current source files (sources changed or never imported)'], report: null };
  const rep = JSON.parse(raw);
  const h = crypto.createHash('sha256'); let n = 0;
  for (const r of store.db.prepare('SELECT seq, rec FROM drawings WHERE seq<=? ORDER BY seq').all(src.history.maxSeq)) { h.update(`${r.seq}\t${r.rec}\n`); n++; }
  if (n !== src.history.recs.length) problems.push(`history: ${n} rows, expected ${src.history.recs.length}`);
  else if (h.digest('hex') !== src.history.checksum) problems.push('history: checksum mismatch');
  for (const [id, t] of Object.entries(src.state.tiers)) if (!store.db.prepare('SELECT 1 x FROM tiers WHERE id=?').get(id)) problems.push(`tiers: missing ${id}`);
  const au = store.auditAll();
  if (au.length < src.state.audit.length) problems.push(`audit: ${au.length} rows, expected at least ${src.state.audit.length}`);
  else if (au.slice(0, src.state.audit.length).some((j, i) => j !== JSON.stringify(src.state.audit[i]))) problems.push('audit: content mismatch');
  const rows = store.db.prepare('SELECT json FROM analytics_events WHERE id<=? ORDER BY id').all(rep.analytics.lastId);
  const ah = crypto.createHash('sha256'); for (const r of rows) ah.update(r.json + '\n');
  if (rows.length !== src.analytics.rows.length) problems.push(`analytics: ${rows.length} rows, expected ${src.analytics.rows.length}`);
  else if (ah.digest('hex') !== src.analytics.checksum) problems.push('analytics: checksum mismatch');
  for (const a of src.archive.good) { const got = store.archiveSha(a.id); if (got === null) problems.push(`archive: missing ${a.id}`); else if (got !== a.sha || sha(store.archiveGet(a.id)) !== a.sha) problems.push(`archive: checksum mismatch ${a.id}`); }
  return { ok: !problems.length, problems, report: rep };
}

module.exports = { importLegacy, verifyLegacy, parseHistory, sources };

if (require.main === module) {
  const { openStore } = require('./store');
  const [from, to, flag] = process.argv.slice(2);
  if (!from || !to) { console.error('usage: node import-legacy.js <legacy dir | backup .tar.gz> <database file> [--verify]'); process.exit(2); }
  let dir = from;
  if (/\.(tar\.gz|tgz)$/.test(from)) { dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'legacy-')); require('node:child_process').execFileSync('tar', ['xzf', from, '-C', dir]); }
  const store = openStore(null, { file: to });
  try {
    const rep = flag === '--verify' ? null : importLegacy(store, dir);
    const v = verifyLegacy(store, dir);
    console.log(JSON.stringify({ import: rep, verify: { ok: v.ok, problems: v.problems } }, null, 2));
    process.exitCode = v.ok ? 0 : 1;
  } finally { store.close(); }
}
