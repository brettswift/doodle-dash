'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Game } = require('../game');
const { Analytics } = require('../analytics');
const { makeNotifier } = require('../notifier');

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dd-alerts-'));
function startedGame(publicGame = false) {
  const starts = [];
  const game = new Game({ onGameStart: (event) => starts.push(event) });
  const room = game.create(1); room.public = publicGame;
  const a = room.join('Pat', 1).p, b = room.join('Sam', 1).p;
  a.send = () => {}; b.send = () => {};
  room.handle(a, { t: 'start' }, 2);
  room.handle(a, { t: 'start' }, 3);
  return starts;
}

test('private and automatic public starts emit one safe event', () => {
  const privateStart = startedGame(false);
  assert.equal(privateStart.length, 1);
  assert.equal(privateStart[0].mode, 'private');
  assert.equal(privateStart[0].players, 2);
  assert.equal(privateStart[0].configuredRounds, 5);
  const publicStart = startedGame(true)[0];
  assert.equal(publicStart.mode, 'public');
  assert.equal(publicStart.players, 2);
  assert.equal(publicStart.configuredRounds, 5);
});

test('ntfy sends aggregate-only message and failures do not throw', async () => {
  const calls = [];
  const notifier = makeNotifier({ baseUrl: 'https://notify.example/', fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return { ok: true }; } });
  assert.equal(await notifier.sendGameStart({ mode: 'private', players: 3, configuredRounds: 4, starter: 'Pat', country: 'CA' }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://notify.example/crayon_breath');
  assert.match(calls[0].init.body, /private lobby started: 3 players, 4 rounds/);
  assert.doesNotMatch(calls[0].init.body, /Pat|CA/);
  const broken = makeNotifier({ baseUrl: 'https://notify.example', fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(await broken.sendGameStart({ mode: 'public', players: 2, configuredRounds: 3 }), false);
});

test('private lobby lifecycle counts waiting, started, and closed; QA is excluded', async () => {
  const dir = tmp();
  const analytics = new Analytics({ dir });
  analytics.event('privateLobbyCreated', { lobbyId: 'waiting' });
  analytics.event('privateLobbyCreated', { lobbyId: 'started' });
  analytics.event('gameStarted', { gameId: 'started', lobbyId: 'started', mode: 'private', configuredRounds: 5 });
  analytics.event('privateLobbyCreated', { lobbyId: 'closed' });
  analytics.event('privateLobbyClosed', { lobbyId: 'closed' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(analytics.summary().privateLobbies, { created: 3, started: 1, closedWithoutStarting: 1, currentlyWaiting: 1, createToStartRate: 33.3 });
  const qa = new Analytics({ dir, qa: true }); qa.event('privateLobbyCreated', { lobbyId: 'qa' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(analytics.summary().privateLobbies.created, 3);
});
