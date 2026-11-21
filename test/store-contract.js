'use strict';
// Shared storage contract: the same cases run against the Node SQLite Store and the Durable Object SQLite store
// (cf/src/do-store.js, executed in workerd). Cases take (make, assert) where make() returns a fresh empty store.
const cases = [
  ['starts empty and records the schema version', (make, assert) => {
    const s = make();
    assert.equal(s.isEmpty(), true);
    assert.equal(s.getMeta('schema'), '1');
    assert.equal(s.getMeta('nope'), null);
  }],
  ['meta round-trips and overwrites', (make, assert) => {
    const s = make(); s.setMeta('a', 1); s.setMeta('a', 'two');
    assert.equal(s.getMeta('a'), 'two');
  }],
  ['drawings: put, replace, load latest window, max seq, count, all', (make, assert) => {
    const s = make();
    for (let i = 1; i <= 5; i++) s.putDrawing(i, { tid: 't' + (i % 2), g: 'g1', out: 'abandoned' });
    s.putDrawing(3, { tid: 't1', g: 'g1', out: 'ok', gt: [1, 2] });
    assert.equal(s.maxSeq(), 5); assert.equal(s.drawingCount(), 5); assert.equal(s.isEmpty(), false);
    assert.deepEqual(s.loadDrawings(2).map((r) => r.seq), [4, 5]);
    assert.deepEqual(s.allDrawings().map((r) => r.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(s.allDrawings()[2], { tid: 't1', g: 'g1', out: 'ok', gt: [1, 2], seq: 3 });
  }],
  ['tiers and audit: setTier is atomic, loadAudit returns the latest n in order', (make, assert) => {
    const s = make();
    s.setTier('cat', 'hard', 7, { at: 10, id: 'cat' });
    s.setTier('cat', 'easy', 9, { at: 20, id: 'cat' });
    s.setTier('dog', 'medium', 0, { at: 30, id: 'dog' });
    assert.deepEqual(s.loadTiers(), { tiers: { cat: 'easy', dog: 'medium' }, since: { cat: 9 } });
    assert.deepEqual(s.loadAudit(2).map((a) => a.at), [20, 30]);
    assert.deepEqual(s.auditAll().map((j) => JSON.parse(j).at), [10, 20, 30]);
  }],
  ['transaction rolls back on error', (make, assert) => {
    const s = make();
    assert.throws(() => s.tx(() => { s.setMeta('x', '1'); throw new Error('boom'); }), /boom/);
    assert.equal(s.getMeta('x'), null);
    s.tx(() => s.setMeta('y', '2'));
    assert.equal(s.getMeta('y'), '2');
  }],
  ['analytics events: windowed read view, qa flag stored, raw lines kept, nothing deleted', (make, assert) => {
    const s = make();
    s.addEvent({ at: 100, type: 'landing' }); s.addEvent({ at: 5, type: 'landing' });
    s.addEvent({ at: 100, type: 'operation' }); s.addEvent({ at: 5, type: 'operation' });
    const ev = s.events(50, 50);
    assert.deepEqual(ev.map((e) => [e.type, e.at]), [['landing', 100], ['operation', 100]]);
    assert.equal(s.events(0, 0).length, 4);
    assert.equal(s.eventLines().length, 4);
    assert.equal(s.eventBytes(), s.eventLines().reduce((n, l) => n + l.length, 0));
  }],
  ['archive: put/has/get/list/stats/sha round-trip exact bytes', (make, assert) => {
    const s = make();
    const buf = Buffer.from([0x1f, 0x8b, 0, 255, 7, 8, 9]);
    assert.equal(s.archiveHas('aaaaaaaa'), false); assert.equal(s.archiveGet('aaaaaaaa'), null);
    s.archivePut('aaaaaaaa', '2026-11-21T00:00:00.000Z', buf, 'abc');
    s.archivePut('bbbbbbbb', '2026-11-22T00:00:00.000Z', Buffer.from('xy'), 'def');
    assert.equal(s.archiveHas('aaaaaaaa'), true);
    assert.deepEqual([...s.archiveGet('aaaaaaaa')], [...buf]);
    assert.equal(s.archiveSha('aaaaaaaa'), 'abc');
    assert.deepEqual(s.archiveStats(), { files: 2, bytes: 9 });
    assert.deepEqual(s.archiveList().map((a) => a.gameId), ['bbbbbbbb', 'aaaaaaaa']);
    assert.throws(() => s.archivePut('aaaaaaaa', 'x', buf, 'z'), /./); // never overwrites
    assert.deepEqual([...s.archiveGet('aaaaaaaa')], [...buf]);
  }],
];
module.exports = { cases };
