'use strict';
// Durable best/worst drawing archive. One gzip JSON blob row per completed game (archive table, key = gameId).
// Only the exact best/worst selection shown at game over is stored. Never deleted by the app; when a cap is hit
// new writes are refused and logged (retention is a human decision). Single writer, serialized through a promise chain.
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { openStore } = require('./store');

const MAX_FILES = 5000, MAX_BYTES = 256 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}$/;
const COLORS = new Set(['#000000', '#e63946', '#f4a261', '#ffd23f', '#2a9d8f', '#1d90ff', '#7b2cbf', '#8d5524', '#ffffff']);

// Deep copy into plain data now, so later mutation (reset, clear) never touches the stored copy.
const entry = (x, reason) => x && ({
  drawer: x.name, word: x.word, topic: x.tid ?? null, diff: x.diff, gain: x.gain, reason,
  strokes: x.strokes.map((s) => ({ c: s.c, w: s.w, p: s.p.slice() })),
});

class Archive {
  constructor({ dir, store = null, log = () => {}, maxFiles = MAX_FILES, maxBytes = MAX_BYTES } = {}) {
    this.log = log; this.maxFiles = maxFiles; this.maxBytes = maxBytes;
    this.chain = Promise.resolve(); this.files = 0; this.bytes = 0; this.refused = 0; this.failed = 0;
    this.store = store || (dir ? openStore(dir, { log }) : null);
    if (!this.store) return;
    try { ({ files: this.files, bytes: this.bytes } = this.store.archiveStats()); }
    catch (e) { this.log('archive init failed:', e.message); this.store = null; }
  }
  // sel = {best, worst} from Room.bestWorst(); never throws, never blocks gameplay. Returns a promise for tests.
  save(meta, sel) {
    if (!this.store) return Promise.resolve('disabled');
    if (!sel || !sel.best || !ID_RE.test(meta.gameId)) return Promise.resolve('nothing');
    let rec;
    try {
      rec = { v: 1, gameId: meta.gameId, savedAt: new Date().toISOString(), mode: meta.mode, players: meta.players,
        canvas: { w: 960, h: 800, coord: 1000 },
        best: entry(sel.best, 'most drawer points in game'),
        worst: entry(sel.worst, 'fewest drawer points in game') };
      if (!sel.worst) rec.worstNote = 'only one drawing in game';
    } catch (e) { this.log('archive snapshot failed:', e.message); return Promise.resolve('error'); }
    const run = async () => {
      try {
        const buf = zlib.gzipSync(JSON.stringify(rec));
        if (this.store.archiveHas(rec.gameId)) return 'exists';
        if (this.files >= this.maxFiles || this.bytes + buf.length > this.maxBytes) {
          this.refused++; this.log(`archive full (${this.files} files, ${this.bytes} bytes); refusing ${rec.gameId}, nothing deleted`); return 'full';
        }
        this.store.archivePut(rec.gameId, rec.savedAt, buf, crypto.createHash('sha256').update(buf).digest('hex'));
        this.files++; this.bytes += buf.length; return 'saved';
      } catch (e) { this.failed++; this.log('archive write failed:', rec.gameId, e.message); return 'error'; }
    };
    const p = this.chain.then(run); this.chain = p.catch(() => {}); return p;
  }
  list() { return this.store ? this.store.archiveList() : []; }
  read(id) {
    if (!this.store || !ID_RE.test(id)) return null;
    try { const b = this.store.archiveGet(id); return b && JSON.parse(zlib.gunzipSync(b)); } catch { return null; }
  }
  stats() { return { files: this.files, bytes: this.bytes, maxFiles: this.maxFiles, maxBytes: this.maxBytes, refused: this.refused, failed: this.failed }; }
  valid(rec) { return rec.best.strokes.every((s) => COLORS.has(s.c) && s.p.every((n) => n >= 0 && n <= 1000)); }
}
module.exports = { Archive };
