# Doodle Dash on Fly.io

Production runs as one Fly app (doodle-dash-prod, region sea) with exactly one machine and one 1 GB volume named doodle_data mounted at /data. Doodle has a single writer, so never scale past one machine. The machine stops itself when idle and wakes on the next request, so cost at low traffic is mostly the volume. The app uses shared IPv4 and IPv6 only; never allocate a dedicated IPv4 (it costs about $2 a month).

All flyctl commands need FLY_API_TOKEN in the environment. On buddyserver, export it from ~/.hermes/.env without printing it.

## Deploy

From a clean checkout of main, run `fly deploy --ha=false --app doodle-dash-prod`. The --ha=false flag keeps it to one machine. Check `fly status` and open https://doodle-dash-prod.fly.dev/healthz, which must answer ok. A deploy restarts the machine, so expect a few seconds of downtime.

## Rollback

Run `fly releases --app doodle-dash-prod` to find the last good image, then `fly deploy --image <image-ref> --ha=false`. Data on the volume is not touched by a code rollback.

## Restore from a Fly snapshot

Fly takes a daily volume snapshot and keeps 30 days (snapshot_retention in fly.toml). List them with `fly volumes list` for the volume id, then `fly volumes snapshots list <volume-id>`. Restore by creating a new volume from a snapshot: `fly volumes create doodle_data --snapshot-id <snapshot-id> --size 1 --region sea`. Stop the machine, then destroy the old machine and recreate it so it mounts the new volume (`fly machine destroy <id> --force`, then `fly deploy --ha=false`). Remove the old volume once the app is confirmed healthy.

## Restore from a pulled backup

Buddyserver pulls /admin/export nightly at 03:30 Mountain time and keeps the newest 30 files in ~/.hermes/backups/doodle/doodle-YYYYMMDD.tar.gz. Each holds history.jsonl and state.json. To restore, unpack the chosen file in a temp directory and copy both files to the volume: `fly ssh sftp shell --app doodle-dash-prod`, then `put history.jsonl /data/history.jsonl` and `put state.json /data/state.json`. Restart the machine with `fly machine restart <id>` so the server reloads them. To test a backup without touching production, unpack it into a temp directory and run `DATA_DIR=<dir> PORT=8099 node server.js`; /stats should show the history counts.

## DNS cut-over

Do this only after a real game has been played on the fly.dev URL.

1. A day before, lower the TTL of the existing doodle.brettswift.com A record (Route 53, zone brettswift.com) to 60 seconds. Note the current home IP in the record.
2. Run `fly certs add doodle.brettswift.com --app doodle-dash-prod` and `fly certs show doodle.brettswift.com` to see the validation requirements.
3. Replace the A record with a CNAME doodle.brettswift.com pointing to doodle-dash-prod.fly.dev (TTL 60). Wait for `fly certs show` to report the certificate issued.
4. Watch https://doodle.brettswift.com/healthz and play a game.

Rollback is one step: delete the CNAME and recreate the A record with the old home IP (TTL 60). The home deployment is never modified, so it keeps serving. Raise the TTL again once stable.

A dedicated domain later only needs another `fly certs add` and DNS record; nothing in the app depends on the hostname.

## Export endpoint and secrets

GET /admin/export returns a tar.gz of history.jsonl and state.json. It needs `Authorization: Bearer <token>` matching the DOODLE_EXPORT_TOKEN secret, answers 404 when the secret is unset, and is rate limited. Rotate with `fly secrets set DOODLE_EXPORT_TOKEN=<new>` and update the same variable in ~/.hermes/.env on buddyserver.
