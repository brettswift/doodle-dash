'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Matchmaker } = require('../lobby');

// Fake clock with explicit timers so tests can see every live timer.
function fake() {
  let t = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = due[1].at; due[1].fn();
      }
      t = end;
    },
    live: () => timers.size,
  };
}
function setup() {
  const c = fake(), started = [];
  const mm = new Matchmaker({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onStart: (m) => started.push(m) });
  return { c, mm, started };
}
const rem = (mm, l) => mm.remainingMs(l);

test('one player: no timer, never starts', () => {
  const { c, mm, started } = setup();
  const l = mm.join('a');
  assert.equal(rem(mm, l), null); assert.equal(c.live(), 0);
  c.advance(10 * 60 * 1000);
  assert.equal(started.length, 0);
});

test('2nd join starts 30 s; 3rd and 4th reset to 15 s; expiry starts', () => {
  const { c, mm, started } = setup();
  const l = mm.join('a'); mm.join('b');
  assert.equal(rem(mm, l), 30000);
  c.advance(20000); assert.equal(rem(mm, l), 10000);
  mm.join('c'); assert.equal(rem(mm, l), 15000);
  c.advance(5000); mm.join('d'); assert.equal(rem(mm, l), 15000);
  assert.equal(c.live(), 1);
  c.advance(14999); assert.equal(started.length, 0);
  c.advance(1); assert.deepEqual(started, [['a', 'b', 'c', 'd']]);
  assert.equal(c.live(), 0); assert.equal(mm.lobbies.length, 0);
});

for (const n of [2, 3, 4]) {
  test(`countdown expiry starts with ${n} players`, () => {
    const { c, mm, started } = setup();
    for (let i = 0; i < n; i++) mm.join('p' + i);
    c.advance(30000);
    assert.equal(started.length, 1); assert.equal(started[0].length, n); assert.equal(c.live(), 0);
  });
}

test('5th join starts immediately; 6th opens a new lobby', () => {
  const { c, mm, started } = setup();
  for (const p of 'abcde') mm.join(p);
  assert.deepEqual(started, [['a', 'b', 'c', 'd', 'e']]); assert.equal(c.live(), 0);
  const l = mm.join('f');
  assert.deepEqual(l.members, ['f']); assert.equal(rem(mm, l), null);
});

test('double join is ignored', () => {
  const { mm } = setup();
  mm.join('a'); assert.equal(mm.join('a'), null);
  assert.equal(mm.lobbies[0].members.length, 1);
});

test('leave: below 2 cancels, back to 2 restarts at 30 s, 4 to 3 keeps deadline, empty is collected', () => {
  const { c, mm, started } = setup();
  const l = mm.join('a'); mm.join('b');
  mm.leave('b'); assert.equal(rem(mm, l), null); assert.equal(c.live(), 0);
  c.advance(60000); assert.equal(started.length, 0);
  mm.join('b'); mm.join('c'); mm.join('d'); c.advance(5000);
  mm.leave('d'); assert.equal(rem(mm, l), 10000);
  mm.leave('c'); assert.equal(rem(mm, l), 30000);
  assert.equal(c.live(), 1);
  mm.leave('a'); mm.leave('b');
  assert.equal(c.live(), 0); assert.equal(mm.lobbies.length, 0); assert.equal(mm.where.size, 0);
  assert.equal(mm.leave('zz'), false);
});

test('leaver frees a seat; started lobby is closed to joins', () => {
  const { mm, started } = setup();
  for (const p of 'abcd') mm.join(p);
  mm.leave('b'); mm.join('x');
  assert.deepEqual(mm.lobbies[0].members, ['a', 'c', 'd', 'x']);
  mm.join('y');
  assert.equal(started.length, 1);
  const l = mm.join('late');
  assert.notEqual(l, null); assert.deepEqual(l.members, ['late']);
  assert.equal(mm.leave('a'), false); // already in a game, not waiting
});

test('close clears all timers', () => {
  const { c, mm } = setup();
  mm.join('a'); mm.join('b'); mm.join('c');
  mm.close(); assert.equal(c.live(), 0);
});
