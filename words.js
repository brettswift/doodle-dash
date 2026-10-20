'use strict';
// Topic catalog -> tiers. Difficulty here is the BASE tier; adaptive overrides live in history state (adapt.js).
const { EASY, MEDIUM, HARD } = require('./catalog');
const slug = (w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const BASE = { easy: EASY, medium: MEDIUM, hard: HARD };
const MULT10 = { easy: 10, medium: 15, hard: 20 }; // tenths: 1x, 1.5x, 2x
const DIFFS = Object.keys(BASE);
const TOPICS = DIFFS.flatMap((d) => BASE[d].map((word) => ({ id: slug(word), word, base: d })));
const TIERS = Object.fromEntries(DIFFS.map((d) => [d, BASE[d]]));
const WORDS = TOPICS.map((t) => t.word);
const BY_ID = new Map(TOPICS.map((t) => [t.id, t]));
const difficultyOf = (w) => (BY_ID.get(slug(w)) || {}).base;
module.exports = { TIERS, MULT10, DIFFS, WORDS, TOPICS, BY_ID, slug, difficultyOf };
