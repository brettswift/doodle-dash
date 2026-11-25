'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../game');
const { makeNotifier } = require('../notifier');

function room(events) {
  const r = new Game({ onFeedback: (e) => events.push(e) }).create(1000);
  const ps = [];
  for (let i = 0; i < 2; i++) {
    const { p } = r.join('Secret' + i, 1000);
    p.out = []; r.attach(p, (s) => p.out.push(JSON.parse(s)), 1000); ps.push(p);
  }
  return { r, ps };
}
const state = (p) => [...p.out].reverse().find((m) => m.t === 'state');

test('feedback is accepted once per player per finished round and never carries identities', () => {
  const events = [];
  const { r, ps } = room(events);
  r.handle(ps[0], { t: 'rounds', n: 2 }, 1100); r.handle(ps[0], { t: 'start' }, 1200);
  r.handle(ps[0], { t: 'feedback', round: 1, rating: 5 }, 1300);
  assert.equal(events.length, 0, 'round 1 is not finished yet');
  let t = 1300;
  for (let i = 0; i < 2; i++) { r.handle(r.drawer(), { t: 'pick', i: 0 }, t); r.endRound(t, 'test'); t += 7000; r.tick(t); }
  assert.equal(state(ps[0]).completedRounds, 1);
  r.handle(ps[0], { t: 'feedback', round: 1, rating: 4, text: ' fun <b>game</b>\nsecond  line ' + 'x'.repeat(300) }, t);
  r.handle(ps[0], { t: 'feedback', round: 1, rating: 1 }, t);      // duplicate
  r.handle(ps[1], { t: 'feedback', round: 1, rating: 0, text: '' }, t); // empty
  r.handle(ps[1], { t: 'feedback', round: 2, rating: 3 }, t);      // unfinished round
  r.handle(ps[1], { t: 'feedback', round: 1, rating: 9 }, t);      // bad rating, no text
  r.handle(ps[1], { t: 'feedback', round: 1, rating: 2 }, t);
  assert.equal(events.length, 2);
  assert.equal(events[0].rating, 4);
  assert.ok(events[0].text.length <= 200 && !/[<>\n]/.test(events[0].text));
  assert.deepEqual(Object.keys(events[0]).sort(), ['gameId', 'mode', 'players', 'rating', 'round', 'rounds', 'text']);
  assert.doesNotMatch(JSON.stringify(events), /Secret/);
});

test('ntfy feedback message is aggregate, one attempt, and failure is reported', async () => {
  const calls = [];
  const n = makeNotifier({ baseUrl: 'https://notify.example/', fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return { ok: true }; } });
  assert.equal(await n.sendFeedback({ mode: 'public', round: 2, rounds: 5, players: 4, rating: 4, text: 'fun' }), true);
  assert.equal(calls[0].url, 'https://notify.example/crayon_breath');
  assert.equal(calls[0].init.body, 'public lobby, round 2 of 5, 4 players · 4/5 · "fun"');
  const down = makeNotifier({ baseUrl: 'https://notify.example', fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(await down.sendFeedback({ mode: 'private', round: 1, rounds: 1, players: 2, rating: 1, text: '' }), false);
  assert.equal(makeNotifier({}).sendFeedback({}) instanceof Promise, true);
});
