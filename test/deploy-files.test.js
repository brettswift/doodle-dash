'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

// Every module reachable from server.js must be copied into the image, or the machine crash-loops on boot.
function reachable(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = fs.readFileSync(path.join(root, entry), 'utf8');
  for (const m of src.matchAll(/require\('\.\/([\w-]+)'\)/g)) reachable(m[1] + '.js', seen);
  return seen;
}
const copied = (file) => {
  const line = fs.readFileSync(path.join(root, file), 'utf8').split('\n').find((l) => l.startsWith('COPY package.json'));
  return new Set(line.split(/\s+/).slice(1, -1));
};

test('Dockerfile copies every module server.js needs', () => {
  const have = copied('Dockerfile');
  const missing = [...reachable('server.js')].filter((f) => !have.has(f));
  assert.deepEqual(missing, []);
});

test('dev Fly config is QA-only: no ntfy, short timers, app crayon-breath-dev, one machine', () => {
  const toml = fs.readFileSync(path.join(root, 'fly.dev.toml'), 'utf8');
  assert.match(toml, /^app = "crayon-breath-dev"/m);
  assert.match(toml, /APP_ENV = "qa"/);
  assert.doesNotMatch(toml, /NTFY_ALERTS_ENABLED\s*=\s*"true"/);
  assert.doesNotMatch(toml, /doodle-dash-prod|doodle_data/);
  assert.match(toml, /max_machines_running = 1/);
  assert.match(toml, /source = "crayon_dev_data"/);
  for (const k of ['CHOOSE_MS', 'DRAW_MS', 'RESULT_MS', 'LOBBY_FIRST_MS']) assert.match(toml, new RegExp(k));
});
