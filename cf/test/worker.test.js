import { env, runInDurableObject } from 'cloudflare:test';
import { test, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { toHub } from '../src/worker.js';
import { BASE, bearer, get, client, stubOf, sleep } from './helpers.js';

test('healthz and version', async () => {
  expect(await (await get('/healthz')).text()).toBe('ok');
  const v = await (await get('/version')).json();
  expect(typeof v.sha).toBe('string');
});

test('static allowlist: html page with security headers, js alias, png bytes, HEAD without body, unknown paths 404', async () => {
  const r = await get('/');
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(r.headers.get('cache-control')).toBe('no-cache');
  expect(await r.text()).toContain('og:image');
  const dash = await get('/admin/dashboard.js');
  expect(dash.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  expect((await get('/privacy')).status).toBe(200);
  const png = await get('/social-preview.png');
  expect(png.headers.get('content-type')).toBe('image/png');
  const bytes = new Uint8Array(await png.arrayBuffer());
  expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect((await get('/fonts/Schoolbell-400.woff2')).headers.get('content-type')).toBe('font/woff2');
  const head = await get('/', { method: 'HEAD' });
  expect(head.status).toBe(200); expect(await head.text()).toBe('');
  for (const p of ['/admin.js', '/index.html', '/nope', '/fonts/']) expect((await get(p)).status, p).toBe(404);
  expect((await get('/', { method: 'POST' })).status).toBe(404);
});

test('admin JSON: 401 without or with a wrong token, 200 with the bearer token, never cached', async () => {
  for (const p of ['/admin/analytics.json', '/admin/drawings.json', '/admin/drawings/deadbeef.json']) {
    expect((await get(p)).status, p).toBe(401);
    expect((await get(p, { headers: { authorization: 'Bearer wrong' } })).status, p).toBe(401);
  }
  const a = await get('/admin/analytics.json', { headers: bearer });
  expect(a.status).toBe(200); expect(a.headers.get('cache-control')).toBe('no-store');
  const body = await a.json();
  expect(Object.keys(body).sort()).toEqual(['health', 'operations', 'summary']);
  expect(body.health.qa).toBe(true);
  const d = await (await get('/admin/drawings.json', { headers: bearer })).json();
  expect(d.stats.files).toBe(0); expect(d.games).toEqual([]);
  expect((await get('/admin/drawings/deadbeef.json', { headers: bearer })).status).toBe(404);
  expect((await get('/admin/analytics')).status).toBe(200); // public shell, private data stays behind the token
});

test('export: GET-only, bearer token, returns a tar.gz with history, analytics and state', async () => {
  expect((await get('/admin/export', { method: 'POST', headers: bearer })).status).toBe(405);
  expect((await get('/admin/export')).status).toBe(401);
  const r = await get('/admin/export', { headers: bearer });
  expect(r.status).toBe(200); expect(r.headers.get('content-type')).toBe('application/gzip');
  const tar = gunzipSync(Buffer.from(await r.arrayBuffer())).toString('latin1');
  for (const f of ['history.jsonl', 'analytics.jsonl', 'state.json']) expect(tar).toContain(f);
});

test('stats is public and aggregate only', async () => {
  const s = await (await get('/stats')).json();
  expect(s.topics).toBe(1039);
  expect(Object.keys(s).sort()).toEqual(['history', 'selection', 'tiers', 'topics']);
});

test('toHub strips client-supplied x-hub-* headers and sets trusted ones', () => {
  const req = new Request(BASE + '/ws', { headers: { 'x-hub-ip': '6.6.6.6', 'X-Hub-Country': 'XX', 'cf-connecting-ip': '8.8.8.8' } });
  const out = toHub(req, { country: 'CA', regionCode: 'AB' });
  expect(out.headers.get('x-hub-ip')).toBe('8.8.8.8');
  expect(out.headers.get('x-hub-country')).toBe('CA');
  expect(out.headers.get('x-hub-region')).toBe('AB');
  expect(toHub(new Request(BASE + '/ws', { headers: { 'x-hub-ip': '6.6.6.6' } }), {}).headers.get('x-hub-ip')).toBeNull();
});

test('websocket: bad origin 403, plain GET /ws 404, create and join a private room', async () => {
  expect((await client({ Origin: 'https://evil.test' })).status).toBe(403);
  expect((await get('/ws')).status).toBe(404);
  const a = await client();
  a.send({ t: 'create', name: 'Ann' });
  const j = await a.wait((m) => m.t === 'joined');
  expect(j.code).toMatch(/^[A-Z]{4}$/);
  const b = await client();
  b.send({ t: 'join', code: j.code, name: 'Bob' });
  await b.wait((m) => m.t === 'joined');
  const st = await a.wait((m) => m.t === 'state' && m.players && m.players.length === 2);
  expect(st.players.map((p) => p.name).sort()).toEqual(['Ann', 'Bob']);
});

test('websocket: oversize message closes the socket 1009, bad token resume is rejected', async () => {
  const a = await client();
  a.ws.send('x'.repeat(5000));
  await new Promise((r) => setTimeout(r, 100));
  expect(a.closed).toBe(1009);
  const b = await client();
  b.send({ t: 'resume', code: 'ABCD', token: 'nope' });
  expect((await b.wait((m) => m.t === 'error')).msg).toBe('No such room');
});

test('websocket: picking a word starts a drawing (history row), snapshots the room and stores analytics events', async () => {
  const a = await client(), b = await client();
  a.send({ t: 'create', name: 'Ann' });
  const j = await a.wait((m) => m.t === 'joined');
  b.send({ t: 'join', code: j.code, name: 'Bob' });
  await b.wait((m) => m.t === 'joined');
  a.send({ t: 'rounds', n: 1 });
  a.send({ t: 'start' });
  const isChoice = (m) => m.t === 'state' && m.phase === 'choosing' && m.choices;
  const drawer = await Promise.race([a.wait(isChoice).then((m) => [a, m]), b.wait(isChoice).then((m) => [b, m])]);
  expect(drawer[1].choices.length).toBe(3);
  drawer[0].send({ t: 'pick', i: 0 });
  await drawer[0].wait((m) => m.t === 'state' && m.phase === 'drawing');
  await sleep(300); // the Room hands its history/analytics batch to the Directory asynchronously
  const room = await runInDurableObject(stubOf(env.ROOM, j.code), async (inst) => ({ snap: inst.store.get('snap') }));
  expect(room.snap).toContain(j.code);
  const n = await runInDurableObject(stubOf(env.DIRECTORY, 'dir'), async (inst) => ({ types: inst.store.eventLines().map((l) => JSON.parse(l).type) }));
  expect(n.types).toEqual(expect.arrayContaining(['privateLobbyCreated', 'nameEntered', 'gameStarted']));
});

test('eviction: a rebuilt hub restores the room from its snapshot and re-binds the live sockets', async () => {
  const a = await client(), b = await client();
  a.send({ t: 'create', name: 'Ann' });
  const j = await a.wait((m) => m.t === 'joined');
  b.send({ t: 'join', code: j.code, name: 'Bob' });
  await b.wait((m) => m.t === 'joined');
  await a.wait((m) => m.t === 'state' && m.players.length === 2);
  await runInDurableObject(stubOf(env.ROOM, j.code), async (inst) => { inst.evictForTest(); });
  const before = a.msgs.length;
  a.send({ t: 'rounds', n: 2 }); // host command works on the restored room
  const st = await a.wait((m) => m.t === 'state' && m.rotations === 2 && a.msgs.indexOf(m) >= before);
  expect(st.players.length).toBe(2);
  expect(st.players.every((p) => p.connected !== false)).toBe(true);
  // the other socket also receives the broadcast: its seat was re-bound too
  await b.wait((m) => m.t === 'state' && m.rotations === 2);
});

test('no raw IP is stored anywhere: Room and Directory attachments, snapshots and events hold a keyed digest only', async () => {
  const a = await client({ 'cf-connecting-ip': '8.8.4.4' });
  a.send({ t: 'analytics', browserId: 'b', sessionId: 's', timezone: 'UTC', language: 'en' });
  a.send({ t: 'create', name: 'Ann' });
  const j = await a.wait((m) => m.t === 'joined');
  await sleep(300);
  const room = await runInDurableObject(stubOf(env.ROOM, j.code), async (inst, state) => ({
    atts: state.getWebSockets().map((w) => JSON.stringify(w.deserializeAttachment())).join(''),
    rows: state.storage.sql.exec('SELECT v FROM kv').toArray().map((r) => r.v).join('') }));
  const dir = await runInDurableObject(stubOf(env.DIRECTORY, 'dir'), async (inst, state) => ({
    rows: state.storage.sql.exec('SELECT json FROM analytics_events').toArray().map((r) => r.json).join('') }));
  expect(room.atts + room.rows + dir.rows).not.toContain('8.8.4.4');
});
