'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Runs the real entrypoint (node server.js) as a child, so the BASE_URL-driven QA client is exercised
// exactly the way it will be run against a deployed dev app.
function boot(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dd-qa-'));
  const env = { ...process.env, PORT: '0', DATA_DIR: dir, APP_ENV: 'qa', DOODLE_EXPORT_TOKEN: 'qa-token-test',
    CHOOSE_MS: '400', DRAW_MS: '3000', RESULT_MS: '250', GRACE_MS: '500', LOBBY_FIRST_MS: '600', LOBBY_RESET_MS: '300', ...extraEnv };
  const port = 20000 + Math.floor(Math.random() * 20000);
  env.PORT = String(port);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('listening')) resolve({ child, base: `http://127.0.0.1:${port}`, dir }); });
    child.on('exit', (c) => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('server start timeout')), 8000);
  });
}

test('QA scenario passes end to end against a freshly started server', { timeout: 60000 }, async () => {
  const { runScenario } = require('../tools/qa-game');
  const { child, base } = await boot();
  try {
    const report = await runScenario({ baseUrl: base, adminToken: 'qa-token-test' });
    const failed = report.checks.filter((c) => !c.ok);
    assert.deepEqual(failed, [], JSON.stringify(failed));
    for (const name of ['private-game-completed', 'scores-and-everyone-bonus', 'archive-saved', 'public-formed', 'resume-token', 'oversize-closed', 'bad-origin-403', 'social-preview', 'admin-auth', 'analytics-health', 'export-targz']) {
      assert.ok(report.checks.some((c) => c.name === name && c.ok), 'missing check ' + name);
    }
  } finally { child.kill(); }
});

test('QA scenario reports failure (not a crash) when the server is unreachable', { timeout: 20000 }, async () => {
  const { runScenario } = require('../tools/qa-game');
  const report = await runScenario({ baseUrl: 'http://127.0.0.1:1', adminToken: 'x', timeoutMs: 1500 });
  assert.ok(report.checks.some((c) => !c.ok));
});
