# Doodle Dash on Fly.io

Production runs as one Fly app (doodle-dash-prod, region sjc) with exactly one machine and one 1 GB volume named doodle_data mounted at /data. Doodle has a single writer, so never scale past one machine. The machine stops itself when idle and wakes on the next request, so cost at low traffic is mostly the volume. The app uses shared IPv4 and IPv6 only; never allocate a dedicated IPv4 (it costs about $2 a month).

All flyctl commands need FLY_API_TOKEN in the environment. On buddyserver, export it from ~/.hermes/.env without printing it.

## Deploy

From a clean checkout of main, run `fly deploy --ha=false --app doodle-dash-prod`. The --ha=false flag keeps it to one machine. Check `fly status` and open https://doodle-dash-prod.fly.dev/healthz, which must answer ok. A deploy restarts the machine, so expect a few seconds of downtime.

## Rollback

Run `fly releases --app doodle-dash-prod` to find the last good image, then `fly deploy --image <image-ref> --ha=false`. Data on the volume is not touched by a code rollback.

## Restore from a Fly snapshot

Fly takes a daily volume snapshot and keeps 30 days (snapshot_retention in fly.toml). List them with `fly volumes list` for the volume id, then `fly volumes snapshots list <volume-id>`. Restore by creating a new volume from a snapshot: `fly volumes create doodle_data --snapshot-id <snapshot-id> --size 1 --region sjc`. Stop the machine, then destroy the old machine and recreate it so it mounts the new volume (`fly machine destroy <id> --force`, then `fly deploy --ha=false`). Remove the old volume once the app is confirmed healthy.

## Restore from a pulled backup

Buddyserver pulls /admin/export nightly at 03:30 Mountain time and keeps the newest 30 files in ~/.hermes/backups/doodle/doodle-YYYYMMDD.tar.gz. Each holds history.jsonl, analytics.jsonl, and state.json. To restore, unpack the chosen file in a temp directory and copy these files to the volume: `fly ssh sftp shell --app doodle-dash-prod`, then `put history.jsonl /data/history.jsonl`, `put analytics.jsonl /data/analytics.jsonl`, and `put state.json /data/state.json`. Restart the machine with `fly machine restart <id>` so the server reloads them. To test a backup without touching production, unpack it into a temp directory and run `DATA_DIR=<dir> PORT=8099 node server.js`; /stats should show the history counts.

## DNS cut-over

Do this only after a real game has been played on the fly.dev URL.

1. A day before, lower the TTL of the existing doodle.brettswift.com A record (Route 53, zone brettswift.com) to 60 seconds. Note the current home IP in the record.
2. Run `fly certs add doodle.brettswift.com --app doodle-dash-prod` and `fly certs show doodle.brettswift.com` to see the validation requirements.
3. Replace the A record with a CNAME doodle.brettswift.com pointing to doodle-dash-prod.fly.dev (TTL 60). Wait for `fly certs show` to report the certificate issued.
4. Watch https://doodle.brettswift.com/healthz and play a game.

Rollback is one step: delete the CNAME and recreate the A record with the old home IP (TTL 60). The home deployment is never modified, so it keeps serving. Raise the TTL again once stable.

After the cut-over the home Doodle moves to a different hostname of its own (a new A record to the home IP); doodle.brettswift.com belongs to Fly from then on. Until that new hostname exists, the one-step rollback above is the way back to the home deployment.

A dedicated domain later only needs another `fly certs add` and DNS record; nothing in the app depends on the hostname.

## Export endpoint and secrets

GET /admin/export returns a tar.gz of history.jsonl, analytics.jsonl, and state.json. Analytics includes both the current and rotated segment, merged in chronological segment order; operational samples share this store. It needs an Authorization bearer token matching `DOODLE_EXPORT_TOKEN`, answers 404 when the secret is unset, and is rate limited. Rotate with `fly secrets set DOODLE_EXPORT_TOKEN=<new>` and update the same variable in ~/.hermes/.env on buddyserver.

## Game-start ntfy alerts and QA

Production fly.toml enables `NTFY_ALERTS_ENABLED=true`, `NTFY_BASE_URL=https://ntfy.sh`, and exact `NTFY_TOPIC=crayon_breath`. This reuses the existing ntfy.sh integration used by the running home monitoring relay and Hermes F1 worker notifier; neither integration uses authentication. Anonymous subscription to `https://ntfy.sh/crayon_breath/json?poll=1&since=latest` returns HTTP 200 (verified November 10, 2026, Mountain time). Therefore this topic is public: messages stay aggregate-only (mode, participant count, configured rounds), even when players consent to analytics. Never include the private starter or location here. Public starts say "automatic public lobby". Delivery has two attempts with a two-second timeout each and can duplicate after an ambiguous network failure. Never send diagnostic messages or synthetic production games to prove delivery.

Production is crayonbreath.com on Fly. doodle.brettswift.com is separate home Kubernetes QA, with its own volume and no ntfy settings; the older DNS cut-over section above is historical, not current routing guidance. Never change DNS based on that section.

Production metrics exclude events marked server-side as QA. `NODE_ENV=test`, `APP_ENV=qa`, and non-Fly instances without `APP_ENV=production` default to QA: alerts stay disabled and records carry an unforgeable server-side QA flag. Unit tests may explicitly override `qa` only in isolated temporary state. Production fly.toml declares `APP_ENV=production`; do not reuse that file to deploy QA. Run fixtures against a temporary `DATA_DIR`, with a loopback HTTP receiver and an isolated topic. No diagnostic POST reaches crayon_breath.

## Private statistics and bounded operations

Open `/admin/analytics` and enter the existing backup admin token. The token stays in page memory only. Same-origin `/admin/dashboard.js` works under the site's CSP; inline scripts are not allowed. The authenticated readback is `/admin/analytics.json`. Never paste its names or token into public logs. The page includes:

- Consenting unique browsers, daily first-observed/returning counts, exact D1/D7 retention with eligible denominators, and public/private entry-to-start conversion. Calendar dates use America/Edmonton. "New" means first seen in retained data, not lifetime new. Shared devices, resets, opt-in bias, late joins and tiny samples limit interpretation; there are no all-visitor landing counts.
- Anonymous game totals, configured and completed full rotations by mode, and private lobby creation/start/expiry conversion, including never-started rooms. A partial current rotation does not count as completed. Unresolved lobbies from an earlier process are unknown, not still waiting.
- Process CPU (100% means one CPU core), RSS/heap, event-loop lag, sockets, rooms, players, rejected actions, dropped analytics writes and ntfy send/failure counters. Internal exceptions are not comprehensively counted; host CPU and memory are unavailable, not zero. Send counters reset on restart; retained samples preserve snapshots.
- One service sample per minute while the Fly machine runs, retained for up to seven days in the existing JSONL store. Missing intervals during auto-stop are unavailable, not zero. CSV exports preserve names and all retained service samples. There is no extra monitoring stack or wake-up polling job.

Product data has a 90-day age limit and two approximately 8 MiB segments; actual coverage can be shorter. Startup/hourly maintenance removes expired records. Both segments participate in summaries and backups. Operations expire at seven days. The existing pulled backups and Fly snapshots retain up to 30 days independently; privacy notice explains this backup grace period.

Buddyserver's `~/.hermes/scripts/doodle_backup_pull.py` must accept either legacy history/state archives or current analytics/history/state archives, validate each JSONL, and reject unexpected paths or non-regular members. Its former exact-two-member allowlist caused the nightly "unexpected members" error. Run it with `/usr/bin/python3.14`, then inspect the saved tar members without printing their contents. Restore verification must use a temporary data directory and disable external alerts; never overwrite live history to test backups.

Before rollout, read the authenticated dashboard and confirm no active players, sockets or queued players; preserve one Fly writer. After rollout verify `/healthz`, authenticated `health.analyticsEnabled=true`, `health.qa=false`, `health.ntfyConfigured=true`, and at least one naturally scheduled stored operation sample. The isolated HTTP transport integration test proves private/public start routing and QA suppression without sending real-topic tests. First real production notification remains unverified until an actual game starts and delivery is observed; `ntfyConfigured=true` alone does not prove delivery.
