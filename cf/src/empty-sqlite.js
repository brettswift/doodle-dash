// Stub for node:sqlite so the shared store.js can be bundled; the Worker uses do-store.js instead.
export class DatabaseSync { constructor() { throw new Error('node:sqlite is not available in Workers; use DoStore'); } }
