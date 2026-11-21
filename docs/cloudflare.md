# Cloudflare adapter (steps 5 and 5b, local only)

`cf/` runs the same game on Cloudflare Workers (free plan): one Worker, one `Directory` Durable Object, one `Room` Durable Object per room (all SQLite-backed) and static assets.
Nothing here is deployed; step 6 deploys the dev Worker `crayon-breath-dev`. Production (Fly) is unchanged.

## Shape
- `cf/src/worker.js`: public Worker. Serves the static allowlist with the same headers as `server.js` (assets via `run_worker_first`, `html_handling = "none"`), `/healthz`, `/version`. Routes `/ws?room=CODE` to that room's `Room` object (`idFromName(CODE)`), plain `/ws`, `/stats` and `/admin/*` to the `Directory`. Strips client-supplied `x-hub-*` headers and sets trusted client IP/country/region.
- `cf/src/room.js`: `Room` Durable Object. One live game (shared `game.js`/`core.js`/`session.js`), its hibernatable sockets, one snapshot row. The core stays synchronous: it reads a local cache of tiers and recently drawn topics and writes into an in-memory outbox. The outbox is sent to the Directory asynchronously, in numbered batches, retried until acknowledged (failed batches are persisted as `ob:` rows so eviction cannot lose them; an alarm retries).
- `cf/src/directory.js`: `Directory` Durable Object. Everything global: entry sockets and the public lobby queue, room-code allocation and registry, history sequence and completed-turn history, adaptive tiers, analytics, best/worst archive, admin endpoints and export. `ingest(src, batch)` applies a Room's batch exactly once (batch numbers only increase per source; a repeat is a no-op) and returns the fresh tier/topic view that the Room caches.
- `cf/src/room-services.js`: Room-side service port (`LocalHistory`, `Outbox`).
- `cf/src/do-store.js`: the Store interface (see `store.js`) over `ctx.storage.sql`, same schema (`schema.js`); `DirectoryStore` adds `ingest` and `room_codes`; `RoomStore` is a key/value table. Meters `rowsWritten`/`rowsRead` (Directory plus all Rooms are summed under `health.storage` in `/admin/analytics.json`).
- `session.js` (shared): per-socket protocol handling, used by both hosts so behavior cannot drift.

## Client protocol change (one message)
Every connection starts at the Directory (`/ws`). `create`, `join`, `resume` and the public-lobby match are answered with `{t:'goto', code, msg}`; the client closes that socket, opens `/ws?room=CODE` and sends `msg` there. `msg` is the original message (create/join/resume) or `{t:'resume', code, token, pub:1}` for a public match, whose seats the Directory created in the Room up front. The Node host never sends `goto`; a saved session connects straight to `/ws?room=CODE` (the Node host ignores the parameter). Handled in `public/app.js` and `tools/qa-game.js`. The Room does not count a second `landing` event, and a public hand-over is not counted as a `resume` intent.

## Durability (matches Fly today)
Live room state is in memory. Persisted: completed drawing history, analytics events, adaptive tiers, best/worst archive at game end (written by the Directory). Hibernation: sockets use the hibernation API; each socket's seat is its attachment; one snapshot row per room is written when phase, membership, host or chat length changes (not per stroke). A woken Room rebuilds from that row and re-binds sockets. Strokes drawn since the last snapshot can be lost on eviction (same class of loss as a Fly restart). The 250 ms tick runs only while a room is in a timed phase, so idle rooms hibernate; one alarm per Room covers outbox retry, the public-start deadline and idle retirement (retirement tells the Directory to drop the room code).
Write budget, measured: a 2-player, 1-rotation game writes 18 SQL rows in total across Room and Directory (test `a full 2-player game writes well under 100 SQL rows`).

## Known differences and limits
- Topic non-repetition is exact inside a room. Across rooms it is best effort: a Room avoids what the Directory's view says was drawn recently, but two rooms can rarely be offered the same topic at the same moment (the Directory does not reserve topics). A Room also learns new tiers only with its next acknowledged write.
- Adaptive tiers are decided by the Directory when it records a finished drawing (same `adapt.js`), never by a Room.
- Public lobby: a Room is created and seated by the Directory; the game starts once every seat has connected, or after 10 s with at least two connected. A seat nobody claims stays in the room until it is retired as idle.
- Room cap: the Node host keeps 100 rooms. The Directory allows 500 registered rooms (`MAX_ROOMS`): rooms no longer share one isolate's memory, and nothing else depended on 100.
- Per-IP and total socket caps apply per object (Directory entry sockets, and per Room), not globally across rooms.
- The observed client IP (same-name reconnect fallback) lives only in a Room's memory attachment, never SQL, and is lost on eviction; token resume still works.
- Process CPU/memory metrics are `null`. There is no periodic analytics sampler (objects hibernate); a sample is taken on each dashboard read.
- Directory reads up to 20000 history rows when it wakes; its wake frequency against the free-plan read budget is a step 6 measurement.

## Commands (from `cf/`)
- `npm test`: Durable Object SQLite contract, Worker, Room and Directory tests under workerd (vitest), then local `wrangler dev` runs the BASE_URL QA game client (also two games at once), a real Room hibernation check and a bundle check.
- `npm run dry`: bundle dry-run, no network or credentials.

## Dev deploy and live checks (step 6)
The Worker is named `crayon-breath-dev` and is deployed only for tests on workers.dev (no zone routes, no DNS). Deploy from `cf/` with the Cloudflare token from the environment: `wrangler deploy --var GIT_SHA:<sha> CHOOSE_MS:5000 DRAW_MS:10000 RESULT_MS:2500 GRACE_MS:2000 LOBBY_FIRST_MS:2500 LOBBY_RESET_MS:1000`, then `wrangler secret put DOODLE_EXPORT_TOKEN`. `APP_ENV=qa` (the default in wrangler.toml) disables ntfy and tags analytics.

Seed it from a pulled backup with `BASE_URL=... ADMIN_TOKEN=... node tools/import-to-cf.js <backup.tar.gz>`. This uses `POST /admin/import`, which answers 404 when `APP_ENV=production` and needs the bearer token. The tool re-reads the result through `/admin/export` and compares the history checksum and every analytics line byte for byte.

`cf/test-node/live-checks.mjs` runs the deployed-only checks: social preview bytes, admin auth, archive listing, origin and size refusal, a 40 s idle then wake with both seats, token resume, and a public match where one client drops during the hand-over. Remove the Worker with `wrangler delete crayon-breath-dev` when done; deleting it also removes its Durable Object storage.

## Analytics retention
Analytics rows older than 183 days are deleted in batches of 500 by `Store.pruneEvents`, called through `Analytics.cleanup`. Node runs it at startup and every 24 h. The Directory Durable Object runs it from a daily alarm (up to 20 batches per run, then re-armed after 60 s if more remain). History, tiers and the best/worst archive are never deleted. The dashboard still reads 90 days of product records and 7 days of service samples.

## Production configuration (step 6b, not deployed)

`cf/wrangler.production.toml` is the explicit production config: `APP_ENV=production`, Worker name `crayon-breath` (its own Durable Object namespaces, separate from the dev Worker), `workers_dev=false`, and no routes or DNS. The cutover step adds the crayonbreath.com route deliberately.
Secrets are set by name with `wrangler secret put NAME -c wrangler.production.toml` and never appear in the file: `DOODLE_EXPORT_TOKEN`, `NTFY_BASE_URL`, `NTFY_TOPIC`, `NTFY_ALERTS_ENABLED` (must be `true` for alerts).
Check offline with `npx wrangler deploy --dry-run -c wrangler.production.toml`. The dev-only `/admin/import` endpoint answers 404 under `APP_ENV=production`.

## Write path guarantees (step 6b)

- A Room persists each completed-results batch before sending it to the Directory and deletes the row after acknowledgement; a batch restored after eviction is retried the same way.
- The Directory applies a batch in one SQL transaction (history rows, events, retire, ingest marker), rechecks the marker inside that transaction, and updates its in-memory history and room registry only after the commit. A failed history or archive write rejects the batch so the Room retries; a deliberate "archive full" refusal is still acknowledged and nothing is deleted.
- An unallocated room code is refused before a socket is accepted and creates no storage. A Room snapshot keeps only the current best and worst showcase drawings (same first-best / last-worst tie rules), so it stays far below the 8 MB SQL value limit; if a snapshot write fails the old snapshot is dropped and the write retried on the next event.
- Dashboard health reports the real notifier configuration and sums delivery counters from the live Rooms (counters reset when a Room object is evicted). Private-lobby "waiting" status comes from the live Rooms, not from the Directory's process id.
