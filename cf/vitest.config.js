import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' }, miniflare: { bindings: { DOODLE_EXPORT_TOKEN: 'test-admin-token', CHOOSE_MS: '4000', DRAW_MS: '8000', RESULT_MS: '1500', LOBBY_FIRST_MS: '3000' } } })],
  test: { include: ['test/**/*.test.js'] },
});
