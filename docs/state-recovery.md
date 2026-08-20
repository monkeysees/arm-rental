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

Post-cutover snapshots contain a standalone mode-`0600` database produced by
Node's SQLite backup API, the selector and defensive sentinels, a manifest-v2,
SHA-256 hashes, identity/schema/target/count summaries, the Telegram update
offset, and the last successful browser verification record. The backup and restore commands emit stable
`backup.*`, `restore.*`, and `storage.low_disk` events for later alert routing.
The summary includes only bounded logical counts and source-integrity aggregate
metadata; restore validation preserves the exact aggregate without exposing
apartment or user data.

### Protected pre-SQLite recovery point

Before state migration, run the serialized bridge protection operation with a
named accountable actor while the bridge image is current:

```sh
sudo /opt/rental-apartments/current/ops/protect-migration-rollback \
  'Named Human'
```

It stops the application, creates and validates a manifest-v1 JSON snapshot at
`protected/pre-sqlite-<timestamp>`, records that snapshot plus the bridge digest
in the deployment retention index, and returns the bridge to readiness. The
protected directory is outside daily/weekly pruning, and image cleanup includes
its application and metadata images in the protected set even after they age
out of the ordinary current-plus-two index. Re-running against the same pair is
idempotent; a different protected pair fails closed. Expected evidence includes
`migration-protection.started`, `backup.completed`, and
`migration-protection.completed`. Preserve this point until migration, a
post-cutover backup, and the isolated restore acceptance gate have all passed.

### Replacing a protected rollback point

Protection binds to whichever release is current when it is taken. An ordinary
same-backend deploy afterwards moves current past that release, and the cutover
then refuses to run: the protected image is no longer the running bridge, so
`validate-protected-bridge` fails closed. Because a different protected pair
also fails closed, the stale point has to be released before a correct one can
be taken.

```sh
sudo /opt/rental-apartments/current/ops/unprotect-migration-rollback \
  'Named Human' \
  "$(sudo jq -r '.protectedReleases[0].candidateImage' \
    /var/lib/rental-apartments-ops/deployment-retention.json)"
```

Naming the protected image is required: the failure this repairs is a
protection taken against a release nobody re-read. It clears the retention
entry and deletes the snapshot that entry named, so the protected directory
holds no `pre-sqlite-*` directory afterwards and the protected set is
unambiguous for the next attempt. It edits state only, so unlike taking a
protection it never stops the application. Expected evidence includes
`migration-unprotection.started` and `migration-unprotection.completed`. Follow
it immediately with `protect-migration-rollback` against the running bridge,
and confirm the new entry names the current release before deploying.

## Automated daily backup

Prerequisites:

- the bot's normal production environment is available, including target,
  owner, channel, browser, data, and backup configuration;
- the independent backup filesystem is mounted and writable by the service
  account;
- the service supervisor can stop and start the singleton cleanly;
- the local monitor evaluates nonzero results and missing terminal success.

The snapshot includes SQLite state and the browser profile, so the bot **must
be stopped**. The command also acquires the same singleton lease as the
application and fails with `ERR_SINGLETON_LOCKED` if a live process remains.
It opens and validates the source, uses the online backup API, then validates
the destination through a fresh connection; it never copies a live main file
or WAL/SHM sidecars. Never bypass this lease.

`rental-backup.timer` owns the supported production schedule. It runs every day
at 03:15 UTC with a bounded randomized delay and `Persistent=true`, so a missed
run is recovered after boot. The service calls `ops/backup`, which acquires
`/var/lib/rental-apartments-ops/operations.lock`, installs its restart trap,
stops `rental-apartments.service`, creates and validates the snapshot in the
immutable current image, starts the service, and requires Docker health to
return `healthy`.

```sh
systemctl status rental-backup.timer
systemctl list-timers rental-backup.timer
journalctl -u rental-backup.service --since today
```

`RENTAL_APARTMENTS_IMAGE` must remain the running immutable reference. Preserve
the service restart failure cleanup while investigating backup failure.
Expected output includes
`storage.disk_ok`, `backup.started`, and `backup.completed`. A success identifies
the immutable `daily/<timestamp>` recovery point and, on Sunday UTC, its weekly
copy.

The recovery CLI performs schema, target, counts, update-offset, profile, and
checksum validation before publishing the snapshot. It never deletes the
newest seven daily or four weekly points. If it fails, the temporary snapshot
is removed, existing recovery points remain unchanged, and the wrapper still
returns the bot to readiness before reporting failure.

## Disk-free check and response

`rental-storage-check.timer` runs hourly and catches up missed checks after
boot. If another serialized production operation owns the shared lock, the
check emits `storage-check.skipped`, exits successfully, and retries on its
next hourly invocation. Deployments perform the same capacity check before
mutation, so deferral does not bypass a deploying release's storage guard.
Inspect the timer without starting an overlapping operation:

```sh
systemctl status rental-storage-check.timer
journalctl -u rental-storage-check.service --since -2h
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

List recovery points without modifying them. The scheduled monthly check always
selects the newest published daily snapshot and validates it before restore:

```sh
find "$BACKUP_DIRECTORY/daily" "$BACKUP_DIRECTORY/weekly" \
  -mindepth 1 -maxdepth 1 -type d -print
systemctl start rental-restore-drill.service
journalctl -u rental-restore-drill.service --since -2h
```

Expected validation reports the application ID, schema and database IDs,
target bindings, per-domain logical counts, Telegram `updateOffset`, browser
verification timestamp, and hash success. Select the newest valid recovery point from before the incident.
Do not edit a snapshot or restore from a `.snapshot-*.tmp` directory.

An image whose backend or declared schema range does not include the snapshot
must not start against it. Restore the protected manifest-v1 JSON point before
starting the bridge image; never point a JSON-only or older SQLite binary at the
live version-1 database.

## Restore procedure

Prerequisites:

- an isolated temporary volume on the production host with the exact
  target/owner/channel metadata expected by the snapshot;
- the independently stored snapshot mounted read-only or otherwise protected;
- the application data filesystem mounted and writable;
- Chrome at the production version;
- the bot service stopped and a one-hour recovery window opened.

Restore and restore validation require the bot to remain stopped. The command
acquires the singleton lease, stages and validates every entry, moves current
managed state aside, installs the staged entries, and validates the result. If
installation fails, it moves the prior files and profile back before returning
an error.

Production restore is a break-glass procedure, distinct from the nondestructive
drill. Open an incident, disable the deploy timer, acquire
`/var/lib/rental-apartments-ops/operations.lock`, and install a shell exit trap
that starts `rental-apartments.service` before stopping it. Use the exact
current image to run `node src/recovery-cli.js validate <snapshot>` and then
`node src/recovery-cli.js restore <snapshot>`. Keep the backup mount read-only
until the selected point has passed validation. Do not run either command
against the live service or outside the shared lock. If restore fails and the
application cannot pass preflight, cancel the restart in the trap and preserve
the automatic restore rollback directory for diagnosis.

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

Only after all checks pass, start the supervised singleton:

```sh
systemctl start rental-apartments.service
docker inspect --format '{{.State.Health.Status}}' rental-apartments-bot
```

Confirm startup preflight is ready and observe one normal crawl before closing
the recovery window. A restored delivery history prevents acknowledged
apartments from being treated as new; Telegram's documented acknowledgement
window remains at-least-once.

## Drill, rollback, and escalation

`rental-restore-drill.timer` runs on the first Sunday of every month at 05:00
UTC. `ops/restore-drill` validates the newest point, creates a uniquely named
and labeled bind-backed Docker volume, and restores into that isolated data
directory with `--network none`, a noncredential Telegram token, and polling
and delivery explicitly disabled. It never attaches the production bot or data
volume. Cleanup checks the exact container name, volume name, run ID, labels,
directory, and marker before removing anything. A mismatched resource is
preserved and fails the unit. Duration over one hour also fails the unit so the
monitor opens the RTO alert without the drill itself invoking Telegram.

Inspect the schedule and last drill:

```sh
systemctl list-timers rental-restore-drill.timer
systemctl status rental-restore-drill.service
journalctl -u rental-restore-drill.service --since -35d
```

If restore fails, keep the service stopped. The command attempts an automatic
rollback to the pre-restore managed files. Validate those files with startup
preflight before considering restart. Preserve the failed snapshot and command
logs for diagnosis. Escalate when checksums fail, schema or target identity is
incompatible, prior-state rollback reports an error, browser verification
cannot be completed, counts or offset differ from the manifest, the independent
destination is unavailable near the 24-hour RPO, or the one-hour RTO is at
risk.
