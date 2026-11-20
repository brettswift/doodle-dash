'use strict';
// Durable best/worst drawing archive. One gzip JSON file per completed game: <dir>/archive/<gameId>.json.gz.
// Only the exact best/worst selection shown at game over is stored. Never deleted by the app; when a cap is hit
// new writes are refused and logged (retention is a human decision). Single writer, serial async, tmp+rename.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const MAX_FILES = 5000, MAX_BYTES = 256 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}$/;
const COLORS = new Set(['#000000', '#e63946', '#f4a261', '#ffd23f', '#2a9d8f', '#1d90ff', '#7b2cbf', '#8d5524', '#ffffff']);

// Deep copy into plain data now, so later mutation (reset, clear) never touches the stored copy.
const entry = (x, reason) => x && ({
  drawer: x.name, word: x.word, topic: x.tid ?? null, diff: x.diff, gain: x.gain, reason,
  strokes: x.strokes.map((s) => ({ c: s.c, w: s.w, p: s.p.slice() })),
});

class Archive {
  constructor({ dir, log = () => {}, maxFiles = MAX_FILES, maxBytes = MAX_BYTES } = {}) {
    this.dir = dir ? path.join(dir, 'archive') : null; this.log = log; this.maxFiles = maxFiles; this.maxBytes = maxBytes;
    this.chain = Promise.resolve(); this.files = 0; this.bytes = 0; this.refused = 0; this.failed = 0;
    if (!this.dir) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const f of fs.readdirSync(this.dir)) {
        if (f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(this.dir, f)); } catch {} continue; }
        if (!f.endsWith('.json.gz')) continue;
        this.files++; this.bytes += fs.statSync(path.join(this.dir, f)).size;
      }
    } catch (e) { this.log('archive init failed:', e.message); this.dir = null; }
  }
  // sel = {best, worst} from Room.bestWorst(); never throws, never blocks gameplay. Returns a promise for tests.
  save(meta, sel) {
    if (!this.dir) return Promise.resolve('disabled');
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
        const file = path.join(this.dir, rec.gameId + '.json.gz');
        if (fs.existsSync(file)) return 'exists';
        if (this.files >= this.maxFiles || this.bytes + buf.length > this.maxBytes) {
          this.refused++; this.log(`archive full (${this.files} files, ${this.bytes} bytes); refusing ${rec.gameId}, nothing deleted`); return 'full';
        }
        const tmp = file + '.tmp';
        await fs.promises.writeFile(tmp, buf, { flag: 'w' });
        await fs.promises.rename(tmp, file);
        this.files++; this.bytes += buf.length; return 'saved';
      } catch (e) { this.failed++; this.log('archive write failed:', rec.gameId, e.message); return 'error'; }
    };
    const p = this.chain.then(run); this.chain = p.catch(() => {}); return p;
  }
  list() {
    if (!this.dir) return [];
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json.gz')).map((f) => {
      const st = fs.statSync(path.join(this.dir, f));
      return { gameId: f.slice(0, -8), bytes: st.size, mtime: st.mtime.toISOString() };
    }).sort((a, b) => a.mtime < b.mtime ? 1 : -1);
  }
  read(id) {
    if (!this.dir || !ID_RE.test(id)) return null;
    try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(this.dir, id + '.json.gz')))); } catch { return null; }
  }
  stats() { return { files: this.files, bytes: this.bytes, maxFiles: this.maxFiles, maxBytes: this.maxBytes, refused: this.refused, failed: this.failed }; }
  valid(rec) { return rec.best.strokes.every((s) => COLORS.has(s.c) && s.p.every((n) => n >= 0 && n <= 1000)); }
}
module.exports = { Archive };
