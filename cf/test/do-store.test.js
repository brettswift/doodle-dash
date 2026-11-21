import { env, runInDurableObject } from 'cloudflare:test';
import { test, expect } from 'vitest';
import assert from 'node:assert/strict';
import { DoStore } from '../src/do-store.js';
import contract from '../../test/store-contract.js';

let n = 0;
// Each case gets a fresh Durable Object (own SQLite database) and runs against its real ctx.storage.
for (const [name, fn] of contract.cases) {
  test('store contract (Durable Object SQLite): ' + name, async () => {
    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName('contract-' + ++n));
    await runInDurableObject(stub, async (_inst, state) => { fn(() => new DoStore(state.storage), assert); });
  });
}

