'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('../server');

const IMG = 'https://crayonbreath.com/social-preview.png';
test('landing page statically declares absolute social preview metadata', async () => {
  const srv = await start(0, { dataDir: require('node:fs').mkdtempSync(require('node:os').tmpdir() + '/sp-'), analyticsEnabled: false });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const html = await (await fetch(base + '/', { headers: { 'user-agent': 'Redditbot/1.0' } })).text();
    const meta = (k, v) => new RegExp(`<meta (?:property|name)="${k}" content="${v}">`);
    assert.match(html, meta('og:image', IMG));
    assert.match(html, meta('og:image:secure_url', IMG));
    assert.match(html, meta('og:image:width', '1200'));
    assert.match(html, meta('og:image:height', '630'));
    assert.match(html, meta('og:image:type', 'image/png'));
    assert.match(html, /<meta property="og:image:alt" content="[^"]{10,}">/);
    assert.match(html, meta('og:url', 'https://crayonbreath.com/'));
    assert.match(html, /<link rel="canonical" href="https:\/\/crayonbreath.com\/">/);
    assert.match(html, meta('twitter:card', 'summary_large_image'));
    assert.match(html, meta('twitter:image', IMG));
    assert.match(html, meta('twitter:title', 'Crayon Breath'));
    const r = await fetch(base + '/social-preview.png');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(b.subarray(1, 4).toString(), 'PNG');
    assert.equal(b.readUInt32BE(16), 1200);
    assert.equal(b.readUInt32BE(20), 630);
    assert.ok(b.length < 5 * 1024 * 1024);
  } finally { await srv.close?.(); }
});
