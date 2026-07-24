# Persistent-state backup and restore

## Objectives and scope

The production recovery point objective (RPO) is 24 hours and the recovery time
objective (RTO) is one hour. A snapshot contains the apartment database,
private-delivery history, bot activation and Telegram update offset,
exchange-rate snapshot, configured channel-delivery history, and the complete
required Chrome profile. Chrome's transient `Singleton*` lock entries are
excluded.

Run one backup every day. The command retains the newest seven daily snapshots
and, when the UTC backup date is Sunday, the newest four weekly snapshots.
Retention values may be increased but not reduced below those limits.
`BACKUP_DIRECTORY` is mandatory for recovery commands and must resolve outside
and independently of `DATA_DIRECTORY`. In production it must be a separately
managed volume or remote-mounted filesystem whose loss is independent of the
application volume and host.

Snapshots contain mode-restricted copies, a versioned manifest, SHA-256 hashes,
schema/count summaries, the Telegram update offset, and the last successful
browser verification record. The backup and restore commands emit stable
`backup.*`, `restore.*`, and `storage.low_disk` events for later alert routing.

## Automated daily backup

Prerequisites:

- the bot's normal production environment is available, including target,
  owner, channel, browser, data, and backup configuration;
- the independent backup filesystem is mounted and writable by the service
  account;
- the service supervisor can stop and start the singleton cleanly;
- the scheduler has a failure notification for a nonzero command exit.

The snapshot includes several independently written JSON files and the browser
profile, so the bot **must be stopped**. The command also acquires the same
singleton lease as the application and fails with `ERR_SINGLETON_LOCKED` if a
live process remains. Never bypass this lease.

For the supported production Compose deployment, configure the scheduler with a
trap so restart happens even when backup fails:

```sh
backup_status=0
trap 'docker compose --file compose.production.yaml up --detach bot' EXIT
docker compose --file compose.production.yaml stop bot
docker compose --file compose.production.yaml run --rm --no-deps bot \
  npm run backup || backup_status=$?
docker compose --file compose.production.yaml up --detach bot
trap - EXIT
exit "$backup_status"
```

`RENTAL_APARTMENTS_IMAGE` must remain the running immutable reference. Preserve
the start step in the scheduler's failure cleanup while still alerting on
backup failure. Expected output includes
`storage.disk_ok`, `backup.started`, and `backup.completed`. A success identifies
the immutable `daily/<timestamp>` recovery point and, on Sunday UTC, its weekly
copy.

`npm run backup` performs schema, target, counts, update-offset, profile, and
checksum validation before publishing the snapshot. It never deletes the
newest seven daily or four weekly points. If it fails, the temporary snapshot
is removed, existing recovery points remain unchanged, and the bot can be
restarted after the operator records the failure.

## Disk-free check and response

Run this from the host monitoring scheduler at least as often as backup:

```sh
npm run storage:check
```

It exits `2` and emits `storage.low_disk` when available blocks fall below 20%
(or the higher configured threshold). At warning:

1. keep the independent backup destination mounted;
2. identify whether application state, Chrome caches, logs, or another tenant
   is consuming the filesystem;
3. move logs through their normal retention mechanism and expand the volume if
   the safe cause is not immediately removable;
4. do not delete state, cookies, or recovery points to silence the warning;
5. escalate if free space cannot be restored above 20% before the next crawl.

## Safe snapshot checks

List recovery points without modifying them:

```sh
find "$BACKUP_DIRECTORY/daily" "$BACKUP_DIRECTORY/weekly" \
  -mindepth 1 -maxdepth 1 -type d -print
npm run backup:validate -- "$BACKUP_DIRECTORY/daily/<timestamp>"
```

Expected validation reports the apartment count, private-delivery
notified/skipped/filtered counts, channel and published counts, exchange-rate
currency count, Telegram `updateOffset`, browser verification timestamp, and
hash success. Select the newest valid recovery point from before the incident.
Do not edit a snapshot or restore from a `.snapshot-*.tmp` directory.

## Restore procedure

Prerequisites:

- a clean staging or production host with the exact target/owner/channel
  configuration expected by the snapshot;
- the independently stored snapshot mounted read-only or otherwise protected;
- the application data filesystem mounted and writable;
- Chrome at the production version;
- the bot service stopped and a one-hour recovery window opened.

Restore and restore validation require the bot to remain stopped. The command
acquires the singleton lease, stages and validates every entry, moves current
managed state aside, installs the staged entries, and validates the result. If
installation fails, it moves the prior files and profile back before returning
an error.

```sh
export SNAPSHOT='/app-backups/daily/<timestamp>'
docker compose --file compose.production.yaml stop bot
docker compose --file compose.production.yaml run --rm --no-deps bot \
  npm run backup:validate -- "$SNAPSHOT"
docker compose --file compose.production.yaml run --rm --no-deps bot \
  npm run restore -- "$SNAPSHOT"
docker compose --file compose.production.yaml run --rm --no-deps bot \
  npm run browser:smoke
```

Do not start polling after `restore` alone. The structural verification record
proves which profile was captured; `browser:smoke` is the required live check
that the restored profile can still load and parse List.am on this host. If it
reports a challenge, run `npm run browser:verify` interactively while the
service is still stopped, then repeat `npm run browser:smoke`.

Compare the restore output with the selected manifest:

- apartment count matches;
- private and channel delivery counts match;
- Telegram update offset matches;
- exchange-rate schema contains USD, EUR, and RUB;
- browser smoke parses the Regular Ads container.

Only after all checks pass:

```sh
docker compose --file compose.production.yaml up --detach bot
```

Confirm startup preflight is ready and observe one normal crawl before closing
the recovery window. A restored delivery history prevents acknowledged
apartments from being treated as new; Telegram's documented acknowledgement
window remains at-least-once.

## Drill, rollback, and escalation

Perform the complete procedure on a clean staging host before production launch
and at least quarterly. Record the snapshot ID, counts, offset, browser result,
start/end times, and whether the one-hour RTO was met. Never use the production
Telegram channel for the drill.

If restore fails, keep the service stopped. The command attempts an automatic
rollback to the pre-restore managed files. Validate those files with startup
preflight before considering restart. Preserve the failed snapshot and command
logs for diagnosis. Escalate when checksums fail, schema or target identity is
incompatible, prior-state rollback reports an error, browser verification
cannot be completed, counts or offset differ from the manifest, the independent
destination is unavailable near the 24-hour RPO, or the one-hour RTO is at
risk.
