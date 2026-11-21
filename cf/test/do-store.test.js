import { env, runInDurableObject } from 'cloudflare:test';
import { test, expect } from 'vitest';
import assert from 'node:assert/strict';
import { DoStore } from '../src/do-store.js';
import contract from '../../test/store-contract.js';

let n = 0;
// Each case gets a fresh Durable Object (own SQLite database) and runs against its real ctx.storage.
for (const [name, fn] of contract.cases) {
  test('store contract (Durable Object SQLite): ' + name, async () => {
    const stub = env.HUB.get(env.HUB.idFromName('contract-' + ++n));
    await runInDurableObject(stub, async (_inst, state) => { fn(() => new DoStore(state.storage), assert); });
  });
}

test('DoStore keeps room snapshots and can drop one', async () => {
  const stub = env.HUB.get(env.HUB.idFromName('rooms'));
  await runInDurableObject(stub, async (_inst, state) => {
    const s = new DoStore(state.storage);
    s.putRoom('ABCD', '{"a":1}', 5); s.putRoom('ABCD', '{"a":2}', 6); s.putRoom('WXYZ', '{}', 7);
    expect(s.loadRooms().sort((a, b) => a.code.localeCompare(b.code))).toEqual([{ code: 'ABCD', snap: '{"a":2}' }, { code: 'WXYZ', snap: '{}' }]);
    s.delRoom('ABCD');
    expect(s.loadRooms().map((r) => r.code)).toEqual(['WXYZ']);
  });
});
