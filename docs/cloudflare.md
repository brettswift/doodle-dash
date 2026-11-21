# Cloudflare adapter (step 5, local only)

`cf/` runs the same game on Cloudflare Workers (free plan): one Worker, one SQLite-backed Durable Object (`GameHub`) and static assets.
Nothing here is deployed; step 6 deploys the dev Worker `crayon-breath-dev`. Production (Fly) is unchanged.

## Shape
- `cf/src/worker.js`: public Worker. Serves the static allowlist with the same headers as `server.js` (assets via `run_worker_first`, `html_handling = "none"`), `/healthz`, `/version`, and forwards `/ws`, `/stats` and `/admin/*` to the hub. Strips client-supplied `x-hub-*` headers and sets trusted client IP/country/region.
- `cf/src/hub.js`: `GameHub` Durable Object. Hosts all rooms in memory, the public lobby, analytics, history, tiers and the archive using the shared `game.js`, `core.js`, `session.js`, `analytics.js`. One object because the core services (topic reservation, history sequence, adaptive tiers) are synchronous and global, and rooms are capped at 100. The client protocol is unchanged.
- `cf/src/do-store.js`: the Store interface (see `store.js`) over `ctx.storage.sql`, same schema (`schema.js`) plus a transient `rooms` table. Meters `rowsWritten`/`rowsRead` (shown under `health.storage` in `/admin/analytics.json`).
- `session.js` (shared): per-socket protocol handling, used by both hosts so behavior cannot drift.

## Durability (matches Fly today)
Live room state is in memory. Persisted: completed drawing history, analytics events, adaptive tiers, best/worst archive at game end. Hibernation: sockets use the hibernation API; each socket's seat is its attachment; one snapshot row per room is written when phase, membership, host or chat length changes (not per stroke). A woken hub rebuilds rooms from those rows and re-binds sockets. Strokes drawn since the last snapshot can be lost on eviction (same class of loss as a Fly restart). The 250 ms tick runs only while a room is in a timed phase, so idle lobbies can hibernate; one alarm retires abandoned rooms.

## Known differences
- The observed client IP (for same-name reconnect fallback) lives only in memory attachments, never SQL, and is lost on eviction; token resume still works.
- Process CPU/memory metrics are `null` (unavailable on Workers).
- Periodic analytics samples are taken while games run and on dashboard reads, not on a fixed 60 s timer.

## Commands (from `cf/`)
- `npm test`: Durable Object SQLite contract + Worker tests under workerd (vitest), then local `wrangler dev` runs the BASE_URL QA game client, a real hibernation check and a bundle check.
- `npm run dry`: bundle dry-run, no network or credentials.
