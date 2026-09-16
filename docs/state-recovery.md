# Persistent-state backup and restore

## Objectives and scope

The production recovery point objective (RPO) is 24 hours and the recovery time
objective (RTO) is one hour. A snapshot contains the apartment database,
private-delivery history, bot activation and Telegram update offset,
exchange-rate snapshot and configured channel-delivery history. Disposable
HTTP session cookies are excluded; restore clears them, and the next HTTP
request starts a fresh session.

Run one backup every day. The command retains the newest seven daily snapshots
and, when the UTC backup date is Sunday, the newest four weekly snapshots.
Retention values may be increased but not reduced below those limits.
`BACKUP_DIRECTORY` is mandatory for recovery commands and must resolve outside
and independently of `DATA_DIRECTORY`. In production it must be a separately
managed volume or remote-mounted filesystem whose loss is independent of the
application volume and host.

Snapshots contain a standalone mode-`0600` database produced by
Node's SQLite backup API, the defensive sentinels, a manifest-v3,
SHA-256 hashes, identity/schema/target/count summaries, the Telegram update
offset. The backup and restore commands emit stable
`backup.*`, `restore.*`, and `storage.low_disk` events for later alert routing.
The summary includes only bounded logical counts and source-integrity aggregate
metadata; restore validation preserves the exact aggregate without exposing
apartment or user data.

### Existing SQLite snapshots

Manifest-v2 snapshots remain restorable: every archived file is checksum
validated and the database summary must match. Their obsolete browser profile
is not installed. Existing profile directories in the live data volume are
left untouched by restore; use the default-dry-run `ops/browser-cleanup`
procedure in [state maintenance](state-maintenance.md#http-session-storage-and-former-profiles).
New snapshots use manifest-v3 and contain no browser artifacts.

Schemas 1 through 4 remain supported. Validation reads the archived schema
version from a writable staged copy, then upgrades and validates that copy;
the archived version must still match the manifest. Logical counts, target
identity, and update offset must match after migration. The snapshot database
and its checksums remain unchanged. Restore installs and upgrades a staged
copy before normal startup. Schema 4 compacts private decisions without
discarding history; see [the schema contract](sqlite-schema.md).

A pre-schema-4 image must restore its matching pre-deploy snapshot before it
starts. Validating an older snapshot with the candidate does not make the
candidate's upgraded live database readable by the older image. Retain the old
snapshot and immutable image together through candidate acceptance.

### The stranded pre-SQLite recovery point

A snapshot taken before the SQLite cutover carries a manifest-v1 body naming
the five JSON state files and no `state.sqlite3` beside them. **No release in
this tree can read one.** It is not a restorable backup, and it must not be
counted as a recovery point when judging RPO. `backup`, `backup:validate`, and
`restore` all refuse it by name:

```
Backup predates the SQLite cutover and cannot be restored by this release
```

Nothing can create such a snapshot any more, and no command will migrate JSON
state into the database. A host may still carry one protected snapshot and the
bridge image pinned beside it in the deployment retention index, left from the
cutover. Retention keeps both until the entry is released.

### Releasing the stranded rollback point

Releasing the entry clears it from the retention index, deletes the snapshot it
named, and lets image cleanup retire the bridge image. **This is destructive and
irreversible: the snapshot it deletes is the only copy of the pre-migration
state.** Do it only as a deliberate decision to give that state up.

```sh
sudo /opt/rental-apartments/current/ops/unprotect-migration-rollback \
  'Named Human' \
  "$(sudo jq -r '.protectedReleases[0].candidateImage' \
    /var/lib/rental-apartments-ops/deployment-retention.json)"
```

Naming the protected image is required: clearing the entry unread would destroy
the record of which release the retained image belonged to. It edits state only
and never stops the application. Expected evidence includes
`migration-unprotection.started` and `migration-unprotection.completed`. There
is no counterpart operation: nothing can take a new protected rollback point.

## Automated daily backup

Prerequisites:

- the bot's normal production environment is available, including target,
  owner, channel, HTTP transport, data, and backup configuration;
- the independent backup filesystem is mounted and writable by the service
  account;
- the service supervisor can stop and start the singleton cleanly;
- the local monitor evaluates nonzero results and missing terminal success.

The bot **must be stopped** to keep the snapshot consistent with application
state. The command also acquires the same singleton lease as the
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

The recovery CLI performs schema, target, counts, update-offset, and
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
2. identify whether application state, logs, or another tenant
   is consuming the filesystem;
3. move logs through their normal retention mechanism and expand the volume if
   the safe cause is not immediately removable;
4. do not delete state, cookies, or recovery points to silence the warning;
5. escalate if free space cannot be restored above 20% before the next crawl.

## Safe snapshot checks

List recovery points without modifying them. The scheduled monthly check always
selects the newest published daily snapshot and validates it as part of the
restore:

```sh
find "$BACKUP_DIRECTORY/daily" "$BACKUP_DIRECTORY/weekly" \
  -mindepth 1 -maxdepth 1 -type d -print
systemctl start rental-restore-drill.service
journalctl -u rental-restore-drill.service --since -2h
```

Expected validation reports the application ID, schema and database IDs,
target bindings, per-domain logical counts, Telegram `updateOffset`, and hash success. Select the newest valid recovery point from before the incident.
Do not edit a snapshot or restore from a `.snapshot-*.tmp` directory.

An image whose declared schema range does not include the snapshot must not
start against it. There is no supported path back to a release that predates
the SQLite cutover: the snapshot such a release would need cannot be read, and
starting a pre-cutover image against the live database is never correct.

## Restore procedure

Prerequisites:

- an isolated temporary volume on the production host with the exact
  target/owner/channel metadata expected by the snapshot;
- the independently stored snapshot mounted read-only or otherwise protected;
- the application data filesystem mounted and writable;
- the packaged curl-impersonate executable;
- the bot service stopped and a one-hour recovery window opened.

Restore and restore validation require the bot to remain stopped. The command
acquires the singleton lease, stages and validates every entry, moves current
managed state aside, installs the staged entries, and validates the result. If
installation fails, it moves the prior files back before returning
an error.

Production restore is a break-glass procedure, distinct from the nondestructive
drill. Open an incident, disable the deploy timer, acquire
`/var/lib/rental-apartments-ops/operations.lock`, and install a shell exit trap
that starts `rental-apartments.service` before stopping it. Use the exact
current image to run `node src/recovery-cli.js validate <snapshot>` and then
`node src/recovery-cli.js restore <snapshot>`. Keep the backup mount read-only
throughout: validation stages the snapshot's database inside `DATA_DIRECTORY`
rather than opening it in place, so no step writes to a recovery point. Do not
run either command against the live service or outside the shared lock. If
restore fails and the application cannot pass preflight, cancel the restart in
the trap and preserve the automatic restore rollback directory for diagnosis.

Do not start polling after `restore` alone. Run the HTTP source smoke check
using the packaged transport to verify that this host can load and parse
List.am with a fresh session. A challenge fails the check; investigate the
source response and network conditions before resuming polling.

Compare the restore output with the selected manifest:

- apartment count matches;
- private and channel delivery counts match;
- Telegram update offset matches;
- exchange-rate schema contains USD, EUR, and RUB;
- HTTP source smoke parses the Regular Ads container.

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
UTC. `ops/restore-drill` selects the newest point, creates a uniquely named
and labeled bind-backed Docker volume, and restores into that isolated data
directory with `--network none`, a noncredential Telegram token, and polling
and delivery explicitly disabled. The restore validates the snapshot before
installing it, so the drill holds a single validation pass whose outcome is the
drill's own: no earlier pass can report a healthy recovery point that the
restore then rejects. It never attaches the production bot or data volume.
Cleanup checks the exact container name, volume name, run ID, labels,
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
incompatible, prior-state rollback reports an error, the HTTP source check
cannot be completed, counts or offset differ from the manifest, the independent
destination is unavailable near the 24-hour RPO, or the one-hour RTO is at
risk.
