'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../store');
const { cases } = require('./store-contract');
for (const [name, fn] of cases) test('store contract (node:sqlite): ' + name, () => fn(() => new Store(':memory:'), assert));
