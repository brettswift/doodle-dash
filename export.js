'use strict';
// Read-only backup export: GET /admin/export -> tar.gz of history.jsonl and state.json.
// Disabled (404) when no export token is configured. Token is never logged.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function tarEntry(name, body) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000600\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148); h.write('0', 156); h.write('ustar\0' + '00', 257);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = (512 - (body.length % 512)) % 512;
  return Buffer.concat([h, body, Buffer.alloc(pad)]);
}

// History is append-only: read up to the size seen now, cut at the last full line.
function readHistory(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return Buffer.alloc(0); throw e; }
  try {
    const size = fs.fstatSync(fd).size, buf = Buffer.alloc(size);
    let off = 0; while (off < size) { const n = fs.readSync(fd, buf, off, size - off, off); if (!n) break; off += n; }
    const cut = buf.subarray(0, off).lastIndexOf(10);
    return buf.subarray(0, cut + 1);
  } finally { fs.closeSync(fd); }
}

function buildArchive(dir) {
  const hist = readHistory(path.join(dir, 'history.jsonl'));
  const analytics = Buffer.concat([readHistory(path.join(dir, 'analytics.jsonl.1')), readHistory(path.join(dir, 'analytics.jsonl'))]);
  let state; // state.json is replaced by atomic rename, so a read sees one whole version
  try { state = fs.readFileSync(path.join(dir, 'state.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; state = Buffer.from('{}'); }
  return zlib.gzipSync(Buffer.concat([tarEntry('history.jsonl', hist), tarEntry('analytics.jsonl', analytics), tarEntry('state.json', state), Buffer.alloc(1024)]));
}

// Returns handler(req,res) -> true if the request was an export request (handled).
function makeExportHandler({ dir, token, perMinute = 6 }) {
  const want = token ? sha(token) : null;
  let tokens = perMinute, last = Date.now();
  const allow = () => { const n = Date.now(); tokens = Math.min(perMinute, tokens + (n - last) * perMinute / 60000); last = n; if (tokens < 1) return false; tokens--; return true; };
  return (req, res) => {
    if ((req.url || '').split('?')[0] !== '/admin/export') return false;
    const plain = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(msg); return true; };
    if (!want || !dir) return plain(404, 'not found');
    if (req.method !== 'GET') return plain(405, 'method not allowed');
    if (!allow()) return plain(429, 'rate limited');
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m || !crypto.timingSafeEqual(sha(m[1]), want)) return plain(401, 'unauthorized');
    let body;
    try { body = buildArchive(dir); } catch (e) { return plain(500, 'export failed'); }
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': body.length, 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="doodle-export.tar.gz"' });
    res.end(body);
    return true;
  };
}

module.exports = { makeExportHandler, buildArchive };
