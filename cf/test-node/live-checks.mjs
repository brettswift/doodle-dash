// Live checks against a deployed DEV Worker (not part of `npm test`).
// Usage: BASE_URL=https://crayon-breath-dev.<sub>.workers.dev ADMIN_TOKEN=... node cf/test-node/live-checks.mjs
import { readFileSync } from 'node:fs';
import https from 'node:https';
const BASE = process.env.BASE_URL, TOKEN = process.env.ADMIN_TOKEN, WS = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra: String(extra) }); console.error((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' :: ' + extra : '')); };
const H = { authorization: 'Bearer ' + TOKEN };
const health = async () => (await (await fetch(BASE + '/admin/analytics.json', { headers: H })).json());

function open(opts = {}) {
  const c = { msgs: [], gotos: 0 };
  const attach = (w) => { c.w = w; w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'goto') { c.gotos++; w.onclose = null; w.close(); if (opts.dropAfterGoto) { c.dropped = m; return; } const n = new WebSocket(`${WS}/ws?room=${m.code}`); n.onopen = () => n.send(JSON.stringify(m.msg)); attach(n); return; } c.msgs.push(m); }; };
  const w = new WebSocket(WS + '/ws'); attach(w);
  return new Promise((res) => { w.onopen = () => res(c); });
}
const last = (c, t) => c.msgs.filter((m) => m.t === t).pop();
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(150); } return false; };

// ---- social preview, headers, HTTP ----
const idx = await (await fetch(BASE + '/')).text();
check('social preview tags', /og:image/.test(idx) && /twitter:card/.test(idx) && /canonical/.test(idx));
const png = Buffer.from(await (await fetch(BASE + '/social-preview.png')).arrayBuffer());
check('social-preview.png bytes identical to repo', png.equals(readFileSync(new URL('../../public/social-preview.png', import.meta.url))), png.length + ' bytes');
const pr = await fetch(BASE + '/privacy'); const pt = await pr.text();
check('privacy page says 6 months', pr.status === 200 && /6 months/.test(pt));
check('security headers', !!(await fetch(BASE + '/')).headers.get('x-content-type-options'));
check('HEAD / ok', (await fetch(BASE + '/', { method: 'HEAD' })).status === 200);

// ---- admin ----
check('admin analytics 401 without token', (await fetch(BASE + '/admin/analytics.json')).status === 401);
check('admin drawings 401 without token', (await fetch(BASE + '/admin/drawings.json')).status === 401);
check('admin export 401 without token', (await fetch(BASE + '/admin/export')).status === 401);
check('admin import 401 without token', (await fetch(BASE + '/admin/import', { method: 'POST', body: '{}' })).status === 401);
const a0 = await health();
const need = ['summary', 'operations', 'health'];
check('analytics.json has summary/operations/health', need.every((k) => k in a0));
const hh = a0.health;
check('health fields present, process metrics null (not 0) on Workers', ['cpuPercent', 'rss', 'heapUsed'].every((k) => hh[k] === null) && 'storage' in hh, JSON.stringify(hh.storage));
const dr = await (await fetch(BASE + '/admin/drawings.json', { headers: H })).json();
check('drawings.json lists archive', Array.isArray(dr.games) && dr.stats && dr.games.length > 0, `${dr.games?.length} games, stats ${JSON.stringify(dr.stats)}`);
if (dr.games?.[0]) { const g = await fetch(`${BASE}/admin/drawings/${dr.games[0].gameId}.json`, { headers: H }); const j = await g.json(); check('archive record round-trips (best strokes present)', g.status === 200 && j.best && Array.isArray(j.best.strokes ?? j.best.drawing?.strokes ?? [1])); }
check('stats endpoint aggregate-only', (await (await fetch(BASE + '/stats')).json()).topics > 1000);
const exp = await fetch(BASE + '/admin/export', { headers: H }); check('export tar.gz', exp.status === 200 && /gzip/.test(exp.headers.get('content-type')));

// ---- ws guards ----
const badOrigin = await new Promise((res) => { const r = https.request(WS.replace('wss', 'https') + '/ws', { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: 'https://evil.example' } }, (r2) => res(r2.statusCode)); r.on('upgrade', () => res(101)); r.on('error', () => res('err')); r.end(); });
check('wrong origin refused', badOrigin === 403, badOrigin);
{ const c = await open(); const closed = new Promise((r) => { c.w.onclose = (e) => r(e.code); }); c.w.send('x'.repeat(5000)); const code = await Promise.race([closed, sleep(10000).then(() => 'timeout')]); check('oversize message closes socket', code !== 'timeout', code); }
{ const c = await open(); c.w.send(JSON.stringify({ t: 'create', name: '' })); check('bad name refused', await until(() => last(c, 'error'), 6000), JSON.stringify(last(c, 'error'))); c.w.close(); }

// ---- hibernation + token resume (live) ----
const before = (await health()).health.storage.rowsWritten;
const a = await open(), b = await open();
a.w.send(JSON.stringify({ t: 'create', name: 'Ann' })); await until(() => last(a, 'joined'));
const code = last(a, 'joined').code, tokenA = last(a, 'joined').token;
b.w.send(JSON.stringify({ t: 'join', code, name: 'Bob' })); await until(() => last(b, 'joined'));
await sleep(40000); // idle lobby, no timers: the Room object should hibernate
a.w.send(JSON.stringify({ t: 'rounds', n: 2 }));
check('after 40 s idle, room still answers and keeps both seats', await until(() => last(a, 'state')?.rotations === 2 && last(b, 'state')?.rotations === 2 && last(a, 'state').players.length === 2));
// token resume after dropping a socket
a.w.close(); await sleep(500);
const a2 = new WebSocket(`${WS}/ws?room=${code}`); const m2 = []; a2.onmessage = (e) => m2.push(JSON.parse(e.data)); await new Promise((r) => { a2.onopen = r; });
a2.send(JSON.stringify({ t: 'resume', code, token: tokenA }));
check('token resume into room works', await until(() => m2.some((m) => m.t === 'state' && m.players?.some((p) => p.name === 'Ann')), 8000));
a2.close(); b.w.close();

// ---- public transfer with one client dropping after goto ----
const p1 = await open(), p2 = await open(), p3 = await open({ dropAfterGoto: true });
for (const [c, n] of [[p1, 'Pat'], [p2, 'Quinn'], [p3, 'Rae']]) c.w.send(JSON.stringify({ t: 'public', name: n }));
const started = await until(() => last(p1, 'state')?.phase && last(p1, 'state').phase !== 'lobby' && last(p2, 'state')?.phase !== 'lobby' && last(p2, 'state')?.phase, 30000);
check('public match forms; game starts although one client dropped during transfer', started && p3.gotos === 1, `phase ${last(p1, 'state')?.phase}, players ${last(p1, 'state')?.players?.length}`);
for (const c of [p1, p2]) c.w.close();
await sleep(2000);
const a1 = await health();
check('rows written during checks', true, `${a1.health.storage.rowsWritten - before} rows (all objects) across hibernation + public + resume checks`);
console.log(JSON.stringify({ base: BASE, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
