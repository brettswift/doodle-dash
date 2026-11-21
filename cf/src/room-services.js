// Room-side service port for the synchronous game core. A Room object owns one live game; everything global lives in
// the Directory. The core never awaits anything, so these classes only read local caches and queue writes in an Outbox
// that the Room delivers to the Directory asynchronously (retry + idempotency key per batch).
import { Topics } from '../../topics.js';

// Local stand-in for History: serves the cached tiers / recent-topic positions to Topics and turns finished drawings
// into outbox items. It never touches SQL and never assigns the global drawing sequence (the Directory does).
export class LocalHistory {
  constructor(outbox) {
    this.outbox = outbox; this.seq = 0; this.last = new Map(); this.state = { v: 1, tiers: {}, since: {}, audit: [] }; this.open = new Map();
  }
  // Apply the Directory's view: tier overrides plus last-seen position of every drawn topic. Local picks are never forgotten.
  load(view) {
    if (!view) return;
    this.state.tiers = { ...(view.tiers || {}) };
    for (const [tid, s] of Object.entries(view.last || {})) this.last.set(tid, Math.max(this.last.get(tid) || 0, s));
    this.seq = Math.max(this.seq, view.seq || 0);
  }
  tierOf(id, base) { return this.state.tiers[id] || base; }
  start(rec) {
    const seq = ++this.seq;
    this.open.set(seq, { out: 'abandoned', ...rec }); this.last.set(rec.tid, seq);
    return seq;
  }
  end(seq, f) {
    const r = this.open.get(seq); if (!r) return;
    this.open.delete(seq); this.outbox.addDrawing({ ...r, ...f });
  }
  forTopic() { return []; }
}

// Adaptive tiers are decided by the Directory from the full history; a Room never changes tiers.
export const NO_ADAPT = { consider: () => null };

// Collects what a Room wants the Directory to persist: analytics events, finished drawings, best/worst archive selections.
export class Outbox {
  constructor() { this.cur = this.fresh(); this.queue = []; this.counter = 0; this.retire = false; }
  fresh() { return { events: [], drawings: [], archives: [] }; }
  get eventStore() { return { addEvent: (e) => { this.cur.events.push(e); }, eventBytes: () => 0 }; }
  addDrawing(rec) { this.cur.drawings.push(rec); }
  addArchive(meta, sel) { this.cur.archives.push({ meta, sel: JSON.parse(JSON.stringify(sel)) }); }
  markRetire() { this.retire = true; }
  pendingItems() { const c = this.cur; return c.events.length + c.drawings.length + c.archives.length + (this.retire ? 1 : 0); }
  // Close the current batch into the queue with a strictly increasing number (the idempotency key within one Room code).
  seal(extra = {}) {
    if (!this.pendingItems()) return null;
    const b = { n: Date.now() * 1000 + (++this.counter % 1000), ...this.cur, ...extra };
    if (this.retire) b.retire = true;
    this.cur = this.fresh(); this.retire = false; this.queue.push(b);
    return b;
  }
}

export function makeRoomTopics(history) { return new Topics(history); }
