// The production wrangler config is separate, explicit and never deployed by tests: checks its content and that it bundles with no credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cfDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const prod = readFileSync(join(cfDir, 'wrangler.production.toml'), 'utf8');
const dev = readFileSync(join(cfDir, 'wrangler.toml'), 'utf8');
const live = (s) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('production config: non-QA, own Worker name, no routes, no workers.dev, no secrets or notifier values', () => {
  const p = live(prod);
  assert.match(p, /^APP_ENV = "production"$/m);
  assert.match(p, /^name = "crayon-breath"$/m);
  assert.notEqual(p.match(/^name = "(.*)"$/m)[1], live(dev).match(/^name = "(.*)"$/m)[1]);
  assert.doesNotMatch(p, /^\s*(routes?|zone_name|custom_domain)\b|pattern\s*=/m, 'no routes until cutover');
  assert.match(p, /^workers_dev = false$/m);
  for (const k of ['DOODLE_EXPORT_TOKEN', 'NTFY_BASE_URL', 'NTFY_TOPIC', 'NTFY_ALERTS_ENABLED']) {
    assert.doesNotMatch(p, new RegExp('^' + k + '\\s*=', 'm'), k + ' must be a secret, not a var');
    assert.match(prod, new RegExp('#\\s+' + k + '\\b'), k + ' documented as a secret name');
  }
  assert.doesNotMatch(live(dev), /APP_ENV = "production"/);
});

test('production config bundles offline with the same classes and migrations as dev (dry run, no credentials, no deploy)', () => {
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
  delete env.CLOUDFLARE_API_TOKEN; delete env.CLOUDFLARE_ACCOUNT_ID;
  const out = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'cf-prod-'));
  const r = spawnSync('npx', ['wrangler', 'deploy', '--dry-run', '-c', 'wrangler.production.toml', '--outdir', out], { cwd: cfDir, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /APP_ENV.*production/);
  assert.match(r.stdout + r.stderr, /env\.DIRECTORY[\s\S]*Durable Object|DIRECTORY/);
  assert.match(r.stdout + r.stderr, /Total Upload/);
});
