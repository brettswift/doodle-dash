'use strict';
// Read-only backup export: GET /admin/export -> tar.gz of history.jsonl, analytics.jsonl and state.json (rebuilt from SQLite).
// Disabled (404) when no export token is configured. Token is never logged.
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

// Same three files as before, rebuilt from SQLite: history.jsonl (compacted k=r records, every row), analytics.jsonl, state.json.
// The result re-imports with import-legacy.js. The best/worst archive is not part of this backup.
function buildArchive(store) {
  const hist = Buffer.from(store.allDrawings().map(({ seq, ...r }) => JSON.stringify({ k: 'r', seq, ...r }) + '\n').join(''));
  const analytics = Buffer.from(store.eventLines().map((l) => l + '\n').join(''));
  const { tiers, since } = store.loadTiers();
  const state = Buffer.from(`{"v":1,"tiers":${JSON.stringify(tiers)},"since":${JSON.stringify(since)},"audit":[${store.auditAll().join(',')}]}`);
  return zlib.gzipSync(Buffer.concat([tarEntry('history.jsonl', hist), tarEntry('analytics.jsonl', analytics), tarEntry('state.json', state), Buffer.alloc(1024)]));
}

// Returns handler(req,res) -> true if the request was an export request (handled).
function makeExportHandler({ store, token, perMinute = 6 }) {
  const want = token ? sha(token) : null;
  let tokens = perMinute, last = Date.now();
  const allow = () => { const n = Date.now(); tokens = Math.min(perMinute, tokens + (n - last) * perMinute / 60000); last = n; if (tokens < 1) return false; tokens--; return true; };
  return (req, res) => {
    if ((req.url || '').split('?')[0] !== '/admin/export') return false;
    const plain = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(msg); return true; };
    if (!want || !store) return plain(404, 'not found');
    if (req.method !== 'GET') return plain(405, 'method not allowed');
    if (!allow()) return plain(429, 'rate limited');
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m || !crypto.timingSafeEqual(sha(m[1]), want)) return plain(401, 'unauthorized');
    let body;
    try { body = buildArchive(store); } catch (e) { return plain(500, 'export failed'); }
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': body.length, 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="doodle-export.tar.gz"' });
    res.end(body);
    return true;
  };
}

module.exports = { makeExportHandler, buildArchive };
