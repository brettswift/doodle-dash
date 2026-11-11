'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('../server');

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dd-analytics-'));
test('analytics dashboard requires export token and exposes only consent-based local records', async () => {
  const dir = tmp();
  const s = await start(0, { dataDir: dir, exportToken: 'token', analyticsEnabled: true, qa: false });
  const base = `http://127.0.0.1:${s.port}`;
  try {
    s.analytics.event('nameEntered', { browserId: 'a'.repeat(32), sessionId: 'b'.repeat(32), name: 'Pat', country: 'CA', region: 'AB' });
    s.analytics.event('gameStarted', { gameId: 'g1', mode: 'private', configuredRounds: 5, participants: [{ browserId: 'a'.repeat(32), sessionId: 'b'.repeat(32), name: 'Pat', country: 'CA', region: 'AB' }] });
    s.analytics.event('gameEnded', { gameId: 'g1', mode: 'private', completedRounds: 5, drawingTurns: 10 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await fetch(base + '/admin/analytics.json')).status, 401);
    const r = await fetch(base + '/admin/analytics.json', { headers: { authorization: 'Bearer token' } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.summary.modes.private.gamesStarted, 1);
    assert.equal(body.summary.modes.private.completedRounds.distribution['5'], 1);
    assert.deepEqual(body.summary.names[0].regions, ['CA-AB']);
    assert.equal((await fetch(base + '/privacy')).status, 200);
  } finally { s.close(); }
});
