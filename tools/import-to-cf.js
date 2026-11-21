#!/usr/bin/env node
'use strict';
// Seed a Cloudflare DEV Worker from a pulled legacy backup and verify the result through /admin/export.
// Usage: BASE_URL=https://crayon-breath-dev.<subdomain>.workers.dev ADMIN_TOKEN=... node tools/import-to-cf.js <backup.tar.gz | legacy dir>
// Only works against a Worker with APP_ENV!=production. Reads local files only; never contacts production.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto');
const { sources, parseHistory } = require('../import-legacy');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function untar(buf) { // minimal ustar reader for the export tarball
  const files = {}; let o = 0;
  while (o + 512 <= buf.length) {
    const name = buf.toString('utf8', o, o + 100).replace(/\0.*$/, ''); if (!name) break;
    const size = parseInt(buf.toString('utf8', o + 124, o + 135), 8); files[name] = buf.subarray(o + 512, o + 512 + size); o += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
async function main() {
  const base = process.env.BASE_URL, token = process.env.ADMIN_TOKEN, from = process.argv[2];
  if (!base || !token || !from) { console.error('need BASE_URL, ADMIN_TOKEN and a backup'); process.exit(2); }
  let dir = from;
  if (/\.(tar\.gz|tgz)$/.test(from)) { dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'legacy-')); require('node:child_process').execFileSync('tar', ['xzf', from, '-C', dir]); }
  const src = sources(dir), H = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const post = async (body) => { const r = await fetch(base + '/admin/import', { method: 'POST', headers: H, body: JSON.stringify(body) }); if (!r.ok) throw new Error('import ' + r.status + ' ' + await r.text()); return r.json(); };
  const totals = { drawings: 0, tiers: 0, audit: 0, events: 0, archive: 0 }, add = (r) => { for (const k in totals) totals[k] += r[k]; };
  const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
  for (const c of chunk(src.history.recs, 300)) add(await post({ drawings: c }));
  add(await post({ tiers: Object.entries(src.state.tiers).map(([id, t]) => [id, t, src.state.since[id] || 0]), audit: src.state.audit }));
  for (const c of chunk(src.analytics.rows.map((r) => r.line), 400)) add(await post({ events: c }));
  for (const c of chunk(src.archive.good, 5)) add(await post({ archive: c.map((a) => ({ id: a.id, savedAt: a.savedAt, b64: a.buf.toString('base64'), sha: a.sha })) }));
  // independent verification through the public export endpoint
  const r = await fetch(base + '/admin/export', { headers: { authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('export ' + r.status);
  const files = untar(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())));
  const problems = [];
  const got = parseHistory(files['history.jsonl'].toString('utf8'));
  const upTo = got.recs.filter(([s]) => s <= src.history.maxSeq);
  const h = crypto.createHash('sha256'); for (const [seq, rec] of upTo) h.update(`${seq}\t${JSON.stringify(rec)}\n`);
  if (upTo.length !== src.history.recs.length) problems.push(`history ${upTo.length} != ${src.history.recs.length}`);
  else if (h.digest('hex') !== src.history.checksum) problems.push('history checksum');
  const lines = files['analytics.jsonl'].toString('utf8').split('\n').filter(Boolean);
  // every imported source line must be present byte-for-byte (the host may hold extra rows from live play)
  const have = new Map(); for (const l of lines) have.set(l, (have.get(l) || 0) + 1);
  let missing = 0; for (const { line } of src.analytics.rows) { const n = have.get(line) || 0; if (!n) missing++; else have.set(line, n - 1); }
  if (missing) problems.push(`analytics: ${missing} source lines missing or altered`);
  const st = JSON.parse(files['state.json'].toString('utf8'));
  if (Object.keys(st.tiers).length !== Object.keys(src.state.tiers).length) problems.push('tiers count');
  const arc = await (await fetch(base + '/admin/drawings.json', { headers: H })).json();
  if (arc.games.length < src.archive.good.length) problems.push('archive count');
  const report = { base, source: { history: src.history.recs.length, analytics: src.analytics.rows.length, tiers: Object.keys(src.state.tiers).length, archive: src.archive.good.length, digest: src.digest }, imported: totals, ok: !problems.length, problems };
  console.log(JSON.stringify(report, null, 2)); process.exit(problems.length ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
