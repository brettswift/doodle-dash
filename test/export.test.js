'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { start } = require('../server');

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dd-exp-'));
function untar(buf) {
  const t = zlib.gunzipSync(buf), out = {};
  for (let o = 0; o + 512 <= t.length && t[o] !== 0;) {
    const name = t.toString('utf8', o, o + 100).replace(/\0.*$/, '');
    const size = parseInt(t.toString('utf8', o + 124, o + 135), 8);
    out[name] = t.subarray(o + 512, o + 512 + size).toString('utf8');
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
async function boot(token) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'history.jsonl'), '{"a":1}\n{"a":2}\n{"a":3}\n');
  fs.writeFileSync(path.join(dir, 'state.json'), '{"v":1,"tiers":{},"audit":[]}');
  const s = await start(0, { dataDir: dir, exportToken: token });
  return { s, dir, url: `http://127.0.0.1:${s.port}/admin/export` };
}

test('export: no token -> 401, wrong token -> 401, right token -> tar.gz', async () => {
  const { s, url } = await boot('s3cret-token');
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer nope' } })).status, 401);
    const ok = await fetch(url, { headers: { authorization: 'Bearer s3cret-token' } });
    assert.equal(ok.status, 200);
    const files = untar(Buffer.from(await ok.arrayBuffer()));
    assert.deepEqual(Object.keys(files).sort(), ['history.jsonl', 'state.json']);
    assert.equal(typeof files['history.jsonl'], 'string');
    assert.equal(JSON.parse(files['state.json']).v, 1);
  } finally { s.close(); }
});

test('export: secret unset -> 404 even with a bearer header', async () => {
  const { s, url } = await boot(undefined);
  try {
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer anything' } })).status, 404);
  } finally { s.close(); }
});

test('export: rate limited after the burst', async () => {
  const { s, url } = await boot('tok');
  try {
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await fetch(url, { headers: { authorization: 'Bearer tok' } })).status);
    assert.ok(codes.includes(429), codes.join());
  } finally { s.close(); }
});

test('export: archive cuts a partial last line', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'history.jsonl'), '{"a":1}\n{"a":2');
  const files = untar(require('../export').buildArchive(dir));
  assert.equal(files['history.jsonl'], '{"a":1}\n');
  assert.equal(files['state.json'], '{}');
});
