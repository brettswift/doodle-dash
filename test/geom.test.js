'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toNorm, toPixel, lineScale } = require('../public/geom');

const near = (a, b, eps = 1) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
// canvas intrinsic 800x600 (4:3), shown in various CSS boxes
const rects = {
  'portrait phone 360x640 (canvas 344x258)': { left: 8, top: 120, width: 344, height: 258 },
  'portrait S24 412x915 (canvas 396x297)': { left: 8, top: 150, width: 396, height: 297 },
  'landscape phone (canvas 640x480)': { left: 100, top: 30, width: 640, height: 480 },
  'resized small': { left: 0, top: 0, width: 200, height: 150 },
  'scrolled (rect above viewport)': { left: 8, top: -200, width: 396, height: 297 },
};

for (const [name, r] of Object.entries(rects)) {
  test(`finger lands under stroke: ${name}`, () => {
    for (const fx of [0, 0.25, 0.5, 0.9, 1]) for (const fy of [0, 0.25, 0.5, 0.9, 1]) {
      const cx = r.left + fx * r.width, cy = r.top + fy * r.height;
      const n = toNorm(cx, cy, r);
      const [px, py] = toPixel(n, 800, 600);
      // pixel on backing store -> CSS position
      near(r.left + px / 800 * r.width, cx, r.width / 1000 + 0.5);
      near(r.top + py / 600 * r.height, cy, r.height / 1000 + 0.5);
    }
  });
}

test('bottom/right edge of canvas maps to last backing-store pixel (not beyond)', () => {
  assert.deepEqual(toPixel([1000, 1000], 800, 600), [800, 600]);
  assert.deepEqual(toPixel([500, 500], 800, 600), [400, 300]);
});

test('remote normalized point (500,500) renders at canvas centre on any intrinsic size', () => {
  assert.deepEqual(toPixel([500, 500], 1000, 1000), [500, 500]);
  assert.deepEqual(toPixel([500, 500], 400, 300), [200, 150]);
});

test('toNorm clamps outside rect and returns integers', () => {
  const r = rects['landscape phone (canvas 640x480)'];
  assert.deepEqual(toNorm(-50, 9999, r), [0, 1000]);
  assert.ok(toNorm(r.left + 123.4, r.top + 77.7, r).every(Number.isInteger));
});

test('toNorm honours border/padding insets (content box)', () => {
  const r = { left: 10, top: 10, width: 104, height: 104 };
  const ins = { l: 2, t: 2, w: 100, h: 100 };
  assert.deepEqual(toNorm(12, 12, r, ins), [0, 0]);
  assert.deepEqual(toNorm(112, 62, r, ins), [1000, 500]);
});

test('lineScale follows width only', () => {
  assert.equal(lineScale(800), 0.8);
});

test('server serves geom.js (static whitelist)', async () => {
  const { start } = require('../server');
  const s = await start(0);
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/geom.js`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /toNorm/);
  } finally { s.close(); }
});
