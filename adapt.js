'use strict';
// Evidence-based difficulty recategorization. Rules are versioned; every change is appended to the audit trail.
//   per-drawing solve index S = (correct/eligible) * (1 - 0.5 * mean(guessMs/budget)); 0 if nobody solved.
//   Drawings are clustered by game (g): average S inside each game, then mean/SE across games, so one chatty
//   or friendly room cannot dominate. SE uses a floor SD so 3 agreeing games are not over-trusted.
//   A topic moves one tier step only if the one-sided 90% bound clears the threshold (hysteresis: the up and
//   down thresholds are far apart), evidence is counted only from drawings after its last move, and a
//   rolling-day budget plus a minimum tier share bound how much the catalog can shift.
const { TOPICS, BY_ID, DIFFS } = require('./words');
const RULES = {
  version: 1, minDrawings: 20, minGames: 3, recent: 100, z: 1.28, sdFloor: 0.15,
  toHarder: { easy: 0.45, medium: 0.22 },   // move down a tier if upper bound < value
  toEasier: { medium: 0.70, hard: 0.45 },   // move up a tier if lower bound >= value
  maxPerDay: 6, minTierShare: 0.2,
};
const idx = (t) => DIFFS.indexOf(t);

// Fair trial: finished normally, drawer never dropped, drawer actually drew, enough guessers stayed online.
function eligible(r) {
  return (r.out === 'timeup' || r.out === 'all') && !r.dd && r.ink && r.el1 >= 1 && r.el1 * 2 >= r.el0 && r.budget > 0;
}
function solve(r) {
  if (!r.ok) return 0;
  const gt = (r.gt || []).slice(0, r.ok);
  const speed = gt.reduce((a, t) => a + Math.min(1, Math.max(0, t / r.budget)), 0) / (gt.length || 1);
  return Math.min(1, r.ok / r.el1) * (1 - 0.5 * speed);
}
function evidence(recs, since = 0, rules = RULES) {
  const ok = recs.filter((r) => r.seq > since && eligible(r)).sort((a, b) => a.seq - b.seq).slice(-rules.recent);
  const games = new Map();
  for (const r of ok) { const a = games.get(r.g) || []; a.push(r); games.set(r.g, a); }
  const gm = [...games.values()].map((a) => a.reduce((s, r) => s + solve(r), 0) / a.length);
  const n = ok.length, G = gm.length;
  if (!n) return { n, games: G, mean: 0, lo: 0, hi: 1, success: 0, speed: 0 };
  const mean = gm.reduce((a, b) => a + b, 0) / G;
  const sd = G > 1 ? Math.sqrt(gm.reduce((a, b) => a + (b - mean) ** 2, 0) / (G - 1)) : 0;
  const se = Math.max(sd, rules.sdFloor) / Math.sqrt(G);
  const success = ok.reduce((s, r) => s + r.ok / r.el1, 0) / n;
  const fast = ok.filter((r) => r.ok); // mean normalized guess time over drawings with at least one solve
  const speed = fast.length ? fast.reduce((s, r) => s + r.gt.slice(0, r.ok).reduce((a, t) => a + t / r.budget, 0) / r.ok, 0) / fast.length : 1;
  return { n, games: G, mean, lo: mean - rules.z * se, hi: mean + rules.z * se, success, speed };
}
// Returns {to, ev} if the topic should move, else null (insufficient evidence or inside the hysteresis band).
function decide(tier, ev, rules = RULES) {
  if (ev.n < rules.minDrawings || ev.games < rules.minGames) return null;
  if (rules.toHarder[tier] !== undefined && ev.hi < rules.toHarder[tier]) return DIFFS[idx(tier) + 1];
  if (rules.toEasier[tier] !== undefined && ev.lo >= rules.toEasier[tier]) return DIFFS[idx(tier) - 1];
  return null;
}
// Re-evaluate one topic after a drawing of it ended. Never touches in-flight turns: rooms keep the
// difficulty snapshot they were offered; only future offers see the new tier.
function consider(history, topics, tid, now = Date.now(), rules = RULES) {
  const t = BY_ID.get(tid); if (!t) return null;
  const from = topics.tierOf(tid);
  const ev = evidence(history.forTopic(tid), history.state.since[tid] || 0, rules);
  const to = decide(from, ev, rules); if (!to) return null;
  const recent = history.state.audit.filter((a) => now - a.at < 864e5).length;
  if (recent >= rules.maxPerDay) return null;
  const counts = topics.counts(), floor = Math.ceil(TOPICS.length * rules.minTierShare);
  if (counts[from] - 1 < floor) return null;
  history.setTier(tid, to, { rules: rules.version, at: now, id: tid, from, to, seq: history.seq, n: ev.n, games: ev.games,
    mean: +ev.mean.toFixed(3), lo: +ev.lo.toFixed(3), hi: +ev.hi.toFixed(3), success: +ev.success.toFixed(3), speed: +ev.speed.toFixed(3) });
  return { id: tid, from, to };
}
module.exports = { RULES, eligible, solve, evidence, decide, consider };
