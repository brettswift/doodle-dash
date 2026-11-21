'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { openStore, SCHEMA_VERSION } = require('../store');
const { importLegacy, verifyLegacy } = require('../import-legacy');
const { History } = require('../history');
const { Analytics } = require('../analytics');
const { Archive } = require('../archive');
const { buildArchive } = require('../export');

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dd-store-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const jl = (rows) => rows.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n';
const day = 86400000;

// ---------- store contract ----------
test('store: creates schema, records version, reapplying is a no-op and keeps data', () => {
  const dir = tmp();
  let s = openStore(dir);
  assert.equal(s.getMeta('schema'), String(SCHEMA_VERSION));
  s.setMeta('hello', 'world');
  s.close();
  s = openStore(dir);
  assert.equal(s.getMeta('hello'), 'world');
  assert.equal(s.getMeta('schema'), String(SCHEMA_VERSION));
  s.close();
});

test('store: openStore without a dir is null (memory-only, as before)', () => {
  assert.equal(openStore(null), null);
});

test('store: transaction rolls back on error', () => {
  const s = openStore(tmp());
  assert.throws(() => s.tx(() => { s.setMeta('a', '1'); throw new Error('boom'); }), /boom/);
  assert.equal(s.getMeta('a'), null);
  s.close();
});

// ---------- history on SQLite ----------
test('history: persists to SQLite only (no jsonl written), reloads, keeps rows beyond the active window', () => {
  const dir = tmp();
  let h = new History({ dir, maxRecords: 5 });
  for (let i = 0; i < 12; i++) h.end(h.start({ tid: 't' + (i % 3), d: 'easy', m: 10, g: 'g' + i, t0: i, el0: 2, budget: 1 }), { out: 'all', ok: 1, gt: [5], el1: 2, ink: true, dd: false });
  h.setTier('t1', 'medium', { at: 1, id: 't1', from: 'easy', to: 'medium', rules: 1 });
  assert.ok(h.recs.size <= 7, 'active view bounded: ' + h.recs.size);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.json')), []);
  h.close();
  h = new History({ dir, maxRecords: 5 });
  assert.equal(h.seq, 12); assert.equal(h.recs.size, 5);
  assert.equal(h.state.tiers.t1, 'medium'); assert.equal(h.state.since.t1, 12); assert.equal(h.state.audit.length, 1);
  const s = openStore(dir);
  assert.equal(s.db.prepare('SELECT count(*) n FROM drawings').get().n, 12, 'nothing deleted');
  s.close(); h.close();
});

test('history: unfinished start reloads as abandoned; end merges fields', () => {
  const dir = tmp();
  let h = new History({ dir });
  const a = h.start({ tid: 'apple', d: 'easy', m: 10, g: 'g1', t0: 1, el0: 3, budget: 80000 });
  h.end(a, { out: 'all', t1: 9, dur: 8, ok: 2, gt: [1000, 2000], el1: 3, ink: true, dd: false });
  const b = h.start({ tid: 'cat', d: 'easy', m: 10, g: 'g1', t0: 20, el0: 3, budget: 80000 });
  h.close();
  h = new History({ dir });
  assert.equal(h.recs.get(a).out, 'all'); assert.equal(h.recs.get(a).ok, 2); assert.deepEqual(h.recs.get(a).gt, [1000, 2000]);
  assert.equal(h.recs.get(b).out, 'abandoned'); assert.equal(h.last.get('apple'), a); assert.equal(h.seq, b);
  h.close();
});

test('history: audit rows are never trimmed in storage; memory keeps the latest 1000', () => {
  const dir = tmp();
  let h = new History({ dir });
  for (let i = 0; i < 1010; i++) h.setTier('x', i % 2 ? 'hard' : 'medium', { at: i, id: 'x', from: 'easy', to: 'medium', rules: 1 });
  assert.equal(h.state.audit.length, 1000);
  h.close();
  const s = openStore(dir);
  assert.equal(s.db.prepare('SELECT count(*) n FROM tier_audit').get().n, 1010);
  s.close();
});

// ---------- analytics on SQLite ----------
test('analytics: events persist synchronously; reads show 90d product + 7d operation window; old rows are kept', () => {
  const dir = tmp(), now = Date.now();
  const a = new Analytics({ dir });
  a.event('landing', { browserId: 'a'.repeat(32) });
  a.event('operation', { rss: 1 });
  const s = openStore(dir);
  const ins = s.db.prepare('INSERT INTO analytics_events(at,type,qa,json) VALUES (?,?,?,?)');
  for (const e of [{ type: 'landing', at: now - 91 * day }, { type: 'operation', at: now - 8 * day }, { type: 'landing', at: now - 8 * day }]) ins.run(e.at, e.type, 0, JSON.stringify(e));
  s.close();
  assert.equal(a.records().length, 3, 'two fresh + 8d landing; 91d landing and 8d operation hidden');
  assert.equal(a.operations().samples.length, 1);
  assert.equal(openStore(dir).db.prepare('SELECT count(*) n FROM analytics_events').get().n, 5, 'nothing deleted');
  assert.equal(a.records().find((e) => e.type === 'landing' && e.browserId).runId, a.runId);
  assert.ok(a.health().eventStoreBytes > 0);
});

// ---------- archive on SQLite ----------
const sel = (n) => ({ best: { name: 'A', word: 'cat', tid: 'cat', diff: 'easy', gain: 100, strokes: [{ c: '#000000', w: 4, p: [1, 2, n, 4] }] }, worst: null });
test('archive: saves gzip rows, reloads, refuses duplicates and caps, never deletes', async () => {
  const dir = tmp();
  let a = new Archive({ dir, maxFiles: 2 });
  assert.equal(await a.save({ gameId: 'aaaaaaaa', mode: 'private', players: 3 }, sel(3)), 'saved');
  assert.equal(await a.save({ gameId: 'aaaaaaaa', mode: 'private', players: 3 }, sel(9)), 'exists');
  assert.equal(await a.save({ gameId: 'bbbbbbbb', mode: 'private', players: 3 }, sel(3)), 'saved');
  assert.equal(await a.save({ gameId: 'cccccccc', mode: 'private', players: 3 }, sel(3)), 'full');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f === 'archive'), []);
  a = new Archive({ dir, maxFiles: 2 });
  assert.equal(a.stats().files, 2); assert.equal(a.list().length, 2);
  const rec = a.read('aaaaaaaa');
  assert.equal(rec.best.strokes[0].p[2], 3); assert.equal(rec.worstNote, 'only one drawing in game'); assert.ok(a.valid(rec));
  assert.equal(a.read('zzzzzzzz'), null);
});

// ---------- legacy importer ----------
function legacyFixture() {
  const dir = tmp(), now = Date.now();
  fs.writeFileSync(path.join(dir, 'history.jsonl'), jl([
    { k: 's', seq: 1, tid: 'apple', d: 'easy', m: 10, g: 'g1', t0: 1, el0: 3, budget: 80000 },
    { k: 'e', seq: 1, out: 'all', ok: 2, gt: [1, 2], el1: 3, ink: true, dd: false },
    { k: 'r', seq: 2, tid: 'cat', d: 'easy', g: 'g1', out: 'timeup', unknownField: 7 },
    { k: 's', seq: 3, tid: 'dog', d: 'easy', g: 'g2', t0: 5 },          // unfinished -> abandoned
    { k: 'e', seq: 99, out: 'all' },                                      // orphan end: ignored
    '{"k":"s","seq":4,"tid":"torn',                                       // torn line
  ]).replace(/\n$/, ''));                                                 // no trailing newline
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ v: 1, tiers: { cat: 'medium' }, since: { cat: 2 }, audit: [{ at: 1, id: 'cat', from: 'easy', to: 'medium', seq: 2, rules: 1 }] }));
  const keep = { type: 'landing', at: now - day, browserId: 'a'.repeat(32) };
  fs.writeFileSync(path.join(dir, 'analytics.jsonl.1'), jl([keep, keep, 'not json', { type: 'landing' }]));
  fs.writeFileSync(path.join(dir, 'analytics.jsonl'), jl([{ type: 'gameStarted', at: now, mode: 'public', gameId: 'abcd1234' }]));
  fs.mkdirSync(path.join(dir, 'archive'));
  const rec = { v: 1, gameId: 'abcd1234', savedAt: new Date().toISOString(), mode: 'public', players: 2, canvas: { w: 960, h: 800, coord: 1000 }, best: { drawer: 'A', word: 'cat', topic: 'cat', diff: 'easy', gain: 1, reason: 'x', strokes: [] }, worst: null, worstNote: 'only one drawing in game' };
  const gz = zlib.gzipSync(JSON.stringify(rec));
  fs.writeFileSync(path.join(dir, 'archive', 'abcd1234.json.gz'), gz);
  fs.writeFileSync(path.join(dir, 'archive', 'badbadba.json.gz'), 'not gzip');
  fs.writeFileSync(path.join(dir, 'archive', 'leftover.tmp'), 'x');
  return { dir, gz };
}

test('import: legacy files map to SQLite with exact counts, checksums and quarantine; source untouched', () => {
  const { dir, gz } = legacyFixture();
  const before = fs.readdirSync(dir).map((f) => [f, f === 'archive' ? '' : sha(fs.readFileSync(path.join(dir, f)))]);
  const store = openStore(null, { file: path.join(tmp(), 'x.sqlite') });
  const rep = importLegacy(store, dir);
  assert.equal(rep.history.records, 3); assert.equal(rep.history.badLines, 1); assert.equal(rep.history.orphanEnds, 1); assert.equal(rep.history.maxSeq, 3);
  assert.equal(rep.analytics.lines, 5); assert.equal(rep.analytics.imported, 3); assert.equal(rep.analytics.skipped, 2);
  assert.equal(rep.audit.imported, 1); assert.deepEqual(rep.tiers, 1);
  assert.equal(rep.archive.imported, 1); assert.equal(rep.archive.quarantined, 1); assert.equal(rep.archive.collisions, 0);
  assert.equal(store.archiveGet('abcd1234').equals(gz), true, 'gzip bytes preserved exactly');
  const v = verifyLegacy(store, dir);
  assert.deepEqual(v.problems, []); assert.equal(v.ok, true);
  assert.deepEqual(fs.readdirSync(dir).map((f) => [f, f === 'archive' ? '' : sha(fs.readFileSync(path.join(dir, f)))]), before, 'source files untouched');
  const again = importLegacy(store, dir);
  assert.equal(again.skipped, true, 'identical reimport is a no-op');
  assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_events').get().n, 3);
  store.close();
});

test('import: verifier detects a missing row and a changed archive byte', () => {
  const { dir } = legacyFixture();
  const store = openStore(null, { file: path.join(tmp(), 'x.sqlite') });
  importLegacy(store, dir);
  store.db.prepare('DELETE FROM analytics_events WHERE id=(SELECT min(id) FROM analytics_events)').run();
  store.db.prepare("UPDATE archive SET data=x'00' WHERE game_id='abcd1234'").run();
  const v = verifyLegacy(store, dir);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /analytics/.test(p)) && v.problems.some((p) => /archive/.test(p)), v.problems.join('|'));
  store.close();
});

test('import: opening a data dir with legacy files and no database imports once, automatically', () => {
  const { dir } = legacyFixture();
  const h = new History({ dir });
  assert.equal(h.seq, 3); assert.equal(h.state.tiers.cat, 'medium'); assert.equal(h.recs.get(3).out, 'abandoned');
  assert.equal(h.recs.get(2).unknownField, 7);
  h.close();
  const h2 = new History({ dir });
  assert.equal(h2.recs.size, 3); h2.close();
  const s = openStore(dir);
  assert.equal(s.db.prepare('SELECT count(*) n FROM analytics_events').get().n, 3, 'not imported twice');
  s.close();
});

test('export: buildArchive from SQLite re-imports to identical counts (full export/reimport)', () => {
  const { dir } = legacyFixture();
  const a = new Archive({ dir }); const h = new History({ dir }); const an = new Analytics({ dir });
  an.event('landing', { browserId: 'b'.repeat(32) });
  const out = tmp();
  const t = zlib.gunzipSync(buildArchive(openStore(dir)));
  const files = {};
  for (let o = 0; o + 512 <= t.length && t[o] !== 0;) {
    const name = t.toString('utf8', o, o + 100).replace(/\0.*$/, ''), size = parseInt(t.toString('utf8', o + 124, o + 135), 8);
    files[name] = t.subarray(o + 512, o + 512 + size); o += 512 + Math.ceil(size / 512) * 512;
  }
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(out, n), b);
  const store = openStore(null, { file: path.join(tmp(), 'y.sqlite') });
  const rep = importLegacy(store, out);
  assert.equal(rep.history.records, h.recs.size); assert.equal(rep.analytics.imported, 4); assert.equal(rep.history.maxSeq, 3);
  assert.equal(rep.audit.imported, 1);
  assert.equal(verifyLegacy(store, out).ok, true);
  store.close(); h.close(); void a;
});
