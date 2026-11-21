#!/usr/bin/env node
'use strict';
// BASE_URL-driven scripted QA game. Runs the same scenario against any Crayon Breath host (local, Fly dev, later Cloudflare dev).
// Uses only the public wire protocol plus the authenticated admin endpoints. Prints a JSON report; exit code 1 if any check fails.
// Usage: BASE_URL=https://crayon-breath-dev.fly.dev ADMIN_TOKEN=... node tools/qa-game.js
// The host must be started with short timers (CHOOSE_MS/DRAW_MS/RESULT_MS/LOBBY_FIRST_MS) and APP_ENV=qa; never point this at production.
const http = require('node:http');
const zlib = require('node:zlib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(baseUrl, label, timeoutMs) {
    this.label = label; this.timeoutMs = timeoutMs; this.msgs = []; this.state = null; this.joined = null; this.closed = false; this.waiters = []; this.gotos = 0;
    this.wsBase = baseUrl.replace(/^http/, 'ws') + '/ws'; this.outbox = [];
    this.opened = this.open('');
  }
  // Open a socket. On the Cloudflare host the first (entry) socket answers create/join/resume/public with {t:'goto', code, msg}:
  // like the browser, reconnect to /ws?room=CODE and send msg there. The Node host never sends goto.
  open(query) {
    const ws = this.ws = new WebSocket(this.wsBase + query); this.closed = false;
    const opened = new Promise((res, rej) => { ws.onopen = () => { this.outbox.splice(0).forEach((s) => ws.send(s)); res(); }; ws.onerror = () => rej(new Error(this.label + ' ws error')); });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'goto') { this.gotos++; ws.onclose = null; ws.close(); this.outbox.push(JSON.stringify(m.msg)); this.open('?room=' + m.code); return; }
      this.msgs.push(m);
      if (m.t === 'state') this.state = m; if (m.t === 'joined') this.joined = m;
      this.waiters = this.waiters.filter((w) => !w(m));
    };
    ws.onclose = (e) => { if (ws !== this.ws) return; this.closed = true; this.closeCode = e?.code; this.waiters = this.waiters.filter((w) => !w(null)); };
    return opened;
  }
  send(o) { const s = typeof o === 'string' ? o : JSON.stringify(o); if (this.ws.readyState === 1) this.ws.send(s); else this.outbox.push(s); }
  // Resolve with the first message (now or later) matching pred; reject on timeout.
  waitFor(pred, what, ms = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.label}: timeout waiting for ${what}`)), ms);
      const check = (m) => { if (m && pred(m)) { clearTimeout(t); resolve(m); return true; } if (m === null) { clearTimeout(t); reject(new Error(`${this.label}: closed waiting for ${what}`)); return true; } return false; };
      this.waiters.push(check);
      for (const m of this.msgs) if (pred(m)) { clearTimeout(t); this.waiters = this.waiters.filter((w) => w !== check); return resolve(m); }
    });
  }
  waitState(pred, what, ms) { // current state counts too
    if (this.state && pred(this.state)) return Promise.resolve(this.state);
    return this.waitFor((m) => m.t === 'state' && pred(m), what, ms);
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function rawUpgrade(baseUrl, headers) { // resolves HTTP status of a websocket upgrade attempt
  return new Promise((resolve) => {
    const u = new URL(baseUrl);
    const lib = u.protocol === 'https:' ? require('node:https') : http;
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: '/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'), ...headers } });
    req.on('response', (res) => { resolve(res.statusCode); res.resume(); });
    req.on('upgrade', (res, sock) => { sock.destroy(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(5000, () => { req.destroy(); resolve(0); });
    req.end();
  });
}

async function runScenario({ baseUrl, adminToken, timeoutMs = 20000 } = {}) {
  baseUrl = String(baseUrl || '').replace(/\/$/, '');
  const checks = [], trace = [], clients = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); };
  const mk = (label) => { const c = new Client(baseUrl, label, timeoutMs); clients.push(c); return c; };
  const auth = { authorization: 'Bearer ' + adminToken };
  const getJson = async (p, h = auth) => { const r = await fetch(baseUrl + p, { headers: h }); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null, res: r }; };
  const skip = new Set((process.env.QA_SKIP || '').split(',').filter(Boolean)); // e.g. QA_SKIP=public when several runs share one host (the public queue is global)
  const step = async (name, fn) => { if (skip.has(name)) return; try { await fn(); } catch (e) { check(name, false, e.message); } };
  const t0 = Date.now(); let version = null;
  try {
    // ---- HTTP basics, social preview, admin auth ----
    await step('http-basics', async () => {
      const h = await fetch(baseUrl + '/healthz'); check('healthz', h.status === 200 && (await h.text()) === 'ok');
      version = (await (await fetch(baseUrl + '/version')).json()).sha; check('version', typeof version === 'string' && version.length > 0, version);
    });
    await step('social-preview', async () => {
      const html = await (await fetch(baseUrl + '/')).text();
      const img = await fetch(baseUrl + '/social-preview.png'), head = await fetch(baseUrl + '/', { method: 'HEAD' });
      const png = Buffer.from(await img.arrayBuffer());
      check('social-preview', /og:image/.test(html) && /twitter:card/.test(html) && img.headers.get('content-type') === 'image/png' && png.subarray(1, 4).toString() === 'PNG' && head.status === 200 && (await head.text()) === '', { pngBytes: png.length });
      check('privacy-page', (await fetch(baseUrl + '/privacy')).status === 200);
    });
    await step('admin-auth', async () => {
      const a = (await fetch(baseUrl + '/admin/analytics.json')).status, b = (await fetch(baseUrl + '/admin/analytics.json', { headers: { authorization: 'Bearer wrong' } })).status;
      const c = (await fetch(baseUrl + '/admin/export')).status, d = (await fetch(baseUrl + '/admin/drawings.json')).status;
      check('admin-auth', a === 401 && b === 401 && c === 401 && d === 401, { noToken: a, wrong: b, exportNoToken: c, drawingsNoToken: d });
    });
    const before = (await getJson('/admin/drawings.json')).body?.stats?.files ?? 0;

    // ---- private game: 3 clients, 1 rotation, everyone guesses ----
    await step('private-game', async () => {
      const [a, b, c] = [mk('A'), mk('B'), mk('C')];
      await Promise.all([a.opened, b.opened, c.opened]);
      a.send({ t: 'create', name: 'Alice' }); const ja = await a.waitFor((m) => m.t === 'joined', 'A joined');
      b.send({ t: 'join', name: 'Bob', code: ja.code }); c.send({ t: 'join', name: 'Cat', code: ja.code });
      await Promise.all([b.waitFor((m) => m.t === 'joined', 'B joined'), c.waitFor((m) => m.t === 'joined', 'C joined')]);
      await a.waitState((s) => s.players.length === 3, '3 players');
      a.send({ t: 'rounds', n: 1 }); await a.waitState((s) => s.rotations === 1, 'rotations=1');
      a.send({ t: 'start' });
      const all = [a, b, c], byId = (id) => all.find((x) => x.joined.id === id);
      const seenDrawers = [], gains = {}; let everyoneBonus = 0, wordLeak = null, scoreOk = true;
      // Event-driven and turn-numbered: scans the full message history, so a fast phase change or network latency never desyncs the script.
      const at = (c, phase, turn, what) => c.waitFor((m) => m.t === 'state' && m.phase === phase && m.turn === turn, `${c.label} ${what || phase} turn ${turn}`);
      for (let turn = 1; turn <= 3; turn++) {
        const s = await at(a, 'choosing', turn);
        const drawer = byId(s.drawerId); seenDrawers.push(s.drawerId);
        await drawer.waitFor((m) => m.t === 'state' && m.phase === 'choosing' && m.turn === turn && m.choices, 'drawer choices');
        drawer.send({ t: 'pick', i: 0 });
        const dstate = await at(drawer, 'drawing', turn, 'drawing');
        const word = dstate.word;
        drawer.send({ t: 'draw', s: true, c: '#000000', w: 6, p: [100, 100, 300, 300, 500, 200] });
        drawer.send({ t: 'draw', s: false, c: '#000000', w: 6, p: [600, 400, 800, 700] });
        for (const g of all) if (g !== drawer) { const gs = await at(g, 'drawing', turn, 'guesser drawing'); if (gs.word) wordLeak = { turn, client: g.label }; }
        for (const g of all) if (g !== drawer) g.send({ t: 'guess', text: word });
        const end = await a.waitFor((m) => m.t === 'state' && (m.phase === 'roundEnd' || m.phase === 'gameOver') && m.turn === turn, 'round end turn ' + turn);
        for (const p of end.players) { if (p.id === s.drawerId) { if (!(p.gain > 0)) scoreOk = false; } else if (!(p.gain >= 50)) scoreOk = false; }
        if (a.msgs.some((m) => m.t === 'chat' && JSON.stringify(m.m).includes('Everyone got it'))) everyoneBonus = Math.max(everyoneBonus, 1);
        trace.push({ turn, diff: end.diff, drawerGain: end.players.find((p) => p.id === s.drawerId).gain, phase: end.phase });
      }
      const over = await a.waitState((x) => x.phase === 'gameOver', 'gameOver');
      check('private-game-completed', new Set(seenDrawers).size === 3 && over.rotation === 1, { rotation: over.rotation, drawers: seenDrawers.length });
      check('word-secret-from-guessers', !wordLeak, wordLeak);
      check('scores-and-everyone-bonus', scoreOk && everyoneBonus >= 1, { everyoneBonus });
      check('showcase', !!(over.showcase && over.showcase.best && over.showcase.worst && over.showcase.best.strokes.length > 0));
      // resume by token after dropping a socket
      const tok = b.joined.token; b.close(); await sleep(200);
      const b2 = mk('B2'); await b2.opened; b2.send({ t: 'resume', code: ja.code, token: tok });
      const j2 = await b2.waitFor((m) => m.t === 'joined', 'resume joined');
      const st = await b2.waitState((s) => s.phase === 'gameOver', 'resumed state');
      check('resume-token', j2.id === b.joined.id && st.players.some((p) => p.name === 'Bob'));
      const bad = mk('BAD'); await bad.opened; bad.send({ t: 'resume', code: ja.code, token: 'nope' });
      check('bad-token-rejected', !!(await bad.waitFor((m) => m.t === 'error', 'bad token error')));
      // restart then ensure the room returns to the lobby (play again)
      a.send({ t: 'again' }); await a.waitState((s) => s.phase === 'lobby', 'lobby after again');
      check('play-again', true);
    });

    // ---- archive, analytics, export (async writes: poll) ----
    await step('archive', async () => {
      let files = before, list;
      for (let i = 0; i < 40 && files <= before; i++) { await sleep(250); list = (await getJson('/admin/drawings.json')).body; files = list?.stats?.files ?? before; }
      check('archive-saved', files > before, { before, after: files });
      const id = list?.games?.[0]?.gameId ?? list?.games?.[0]?.id;
      if (id) { const r = await getJson('/admin/drawings/' + id + '.json'); check('archive-record', r.status === 200 && r.body && (r.body.best || r.body.gameId), { id }); }
    });
    await step('analytics', async () => {
      const r = await getJson('/admin/analytics.json');
      check('analytics-health', r.status === 200 && r.body?.health && r.body.health.qa === true && r.body.health.analyticsEnabled === true && r.body.health.ntfyConfigured === false, { qa: r.body?.health?.qa, analyticsEnabled: r.body?.health?.analyticsEnabled, ntfyConfigured: r.body?.health?.ntfyConfigured });
      check('analytics-summary', !!r.body?.summary && !!r.body?.operations);
      const s = await (await fetch(baseUrl + '/stats')).json();
      check('stats-anonymous', typeof s.topics === 'number' && !/Alice|Bob|Cat|token/.test(JSON.stringify(s)), { topics: s.topics, history: s.history });
      trace.push({ stats: s.history });
    });
    await step('export', async () => {
      const r = await fetch(baseUrl + '/admin/export', { headers: auth }); const buf = Buffer.from(await r.arrayBuffer());
      const tar = zlib.gunzipSync(buf), names = [];
      for (let o = 0; o + 512 <= tar.length && tar[o] !== 0;) { names.push(tar.toString('utf8', o, o + 100).replace(/\0.*$/, '')); const size = parseInt(tar.toString('utf8', o + 124, o + 135), 8); o += 512 + Math.ceil(size / 512) * 512; }
      check('export-targz', r.status === 200 && ['analytics.jsonl', 'history.jsonl', 'state.json'].every((n) => names.includes(n)), names);
    });

    // ---- public matchmaking: duplicate names ----
    await step('public', async () => {
      const [p1, p2] = [mk('P1'), mk('P2')]; await Promise.all([p1.opened, p2.opened]);
      p1.send({ t: 'public', name: 'Twin' }); p2.send({ t: 'public', name: 'Twin' });
      await p1.waitFor((m) => m.t === 'public', 'queue status');
      const s = await p1.waitState((x) => x.phase === 'choosing' || x.phase === 'drawing', 'public game start', 30000);
      const names = s.players.map((p) => p.name).sort();
      check('public-formed', s.players.length === 2 && names[0] !== names[1], names);
      // queue leave/rejoin
      const q = mk('Q'); await q.opened; q.send({ t: 'public', name: 'Quit' }); await q.waitFor((m) => m.t === 'public', 'q queued');
      q.send({ t: 'leavePublic' }); check('queue-leave', !!(await q.waitFor((m) => m.t === 'publicLeft', 'publicLeft')));
    });

    // ---- rejection paths ----
    await step('rejections', async () => {
      const u = new URL(baseUrl);
      check('bad-origin-403', (await rawUpgrade(baseUrl, { Origin: 'https://evil.example', Host: u.host })) === 403);
      const o = mk('OVER'); await o.opened; o.send('x'.repeat(5000)); await sleep(500);
      let closed = o.closed; for (let i = 0; i < 80 && !closed; i++) { await sleep(100); closed = o.closed; }
      check('oversize-closed', closed, { closeCode: o.closeCode, readyState: o.ws.readyState });
      const n = mk('NAME'); await n.opened; n.send({ t: 'create', name: '<<bad name that is far too long>>' });
      check('bad-name-rejected', !!(await n.waitFor((m) => m.t === 'error', 'name error')));
      check('unknown-path-404', (await fetch(baseUrl + '/nope')).status === 404 && (await fetch(baseUrl + '/../server.js')).status === 404);
    });
  } catch (e) { check('scenario', false, e.message); }
  finally { for (const c of clients) c.close(); }
  return { baseUrl, version, startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0, ok: checks.length > 0 && checks.every((c) => c.ok), checks, trace };
}

module.exports = { runScenario };
if (require.main === module) {
  const baseUrl = process.env.BASE_URL || process.argv[2];
  if (!baseUrl) { console.error('BASE_URL required'); process.exit(2); }
  runScenario({ baseUrl, adminToken: process.env.ADMIN_TOKEN, timeoutMs: +process.env.QA_TIMEOUT_MS || 20000 }).then((r) => {
    console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1);
  });
}
