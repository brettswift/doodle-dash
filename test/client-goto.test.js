'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The browser client cannot run here; guard the pieces the Cloudflare entry/goto flow depends on.
test('browser client follows {t:goto}: reconnects to /ws?room=CODE and replays the message', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /case 'goto':/);
  assert.match(src, /pendingEnter = m\.msg; connect\(m\.code\)/);
  assert.match(src, /'\/ws' \+ \(room \? '\?room=' \+ encodeURIComponent\(room\)/);
  assert.match(src, /room = room \|\| \(sess && sess\.code\)/);
});

test('QA client follows goto too', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'qa-game.js'), 'utf8');
  assert.match(src, /m\.t === 'goto'/);
  assert.match(src, /'\?room=' \+ m\.code/);
});
