# Operational runbook index

This page is the single operational index. Procedures live with the component
they operate; links below are canonical and should be updated instead of copied
into another handbook.

| Incident or change                                  | Canonical runbook                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Fresh production launch                             | [Deploy production from scratch](deployment-from-scratch.md)                                     |
| Deploy and rollback                                 | [Release and rollback](release-and-rollback.md)                                                  |
| Launch approval                                     | [Launch approval](deployment-from-scratch.md#phase-10-approve-launch)                            |
| Rotate Telegram token                               | [Telegram token rotation](token-rotation.md)                                                     |
| Complete or transfer browser verification           | [Production browser operations](browser-operations.md)                                           |
| Restore persistent state                            | [Persistent-state restore](state-recovery.md#restore-procedure)                                  |
| Held state-backend cutover                          | [State backend transitions](release-and-rollback.md#state-backend-transitions)                   |
| Stranded pre-SQLite rollback point                  | [Releasing the stranded rollback point](state-recovery.md#releasing-the-stranded-rollback-point) |
| Malformed, incompatible, or target-mismatched state | [Incompatible-state recovery](startup-preflight.md#incompatible-state)                           |
| Stale crawling                                      | [Stale-crawl response](runtime-incidents.md#stale-crawling)                                      |
| Telegram private or channel failure                 | [Telegram delivery response](runtime-incidents.md#telegram-private-or-channel-delivery-failure)  |
| Stale singleton or Chrome lock                      | [Stale-lock response](runtime-incidents.md#stale-singleton-or-chrome-lock)                       |
| Low disk or growing state                           | [Capacity response](state-maintenance.md#low-disk-and-state-growth-response)                     |
| Failed or overdue scheduled operation               | [Systemd operations](#systemd-operations)                                                        |
| Current status, logs, timers, and local alerts      | [Production observability](observability.md)                                                     |
| Production recovery acceptance exercises            | [Production recovery exercises](production-exercises.md)                                         |

Every linked runbook records prerequisites, checks that do not make the
incident worse, exact commands, expected output, recovery/rollback, and
escalation conditions. Use the immutable image and Compose file from the active
release. Commands assume the deployed directory and external secret facility;
they must not be adapted to print environment variables, tokens, Telegram
identifiers, apartment payloads, or browser cookies.

Before changing production, open an incident/change record with the named
operator, UTC start time, affected environment, immutable image reference,
snapshot ID, and sanitized symptom. After recovery, attach command exit codes,
health results, relevant event names/reason codes, and end time. Attach full
logs only to access-controlled storage.

## Systemd operations

Routine operation is owned by `rental-apartments.service` and the deploy,
monitor, storage-check, backup, maintenance, restore-drill, and reboot-check
timers. Use `rentalctl timers` for the compact view and systemd for a specific
failure:

```sh
rentalctl status
rentalctl timers
systemctl --failed
systemctl status rental-backup.service
journalctl -u rental-backup.service --since -2d
```

All short-lived operations have a bounded runtime, emit one start and one
terminal record, and contend on
`/var/lib/rental-apartments-ops/operations.lock`. A nonzero result and a missing
terminal success are both monitor failures. Monitoring, the storage check, and
the unattended deployment poll record a successful skip instead when another
operation owns the lock; their next timer invocation retries the work. An
explicit operator deployment request retains contention status `75` rather
than claiming success. Do not invoke the underlying Node maintenance/recovery
commands directly: doing so bypasses the shared lock and the application
restart trap.

After investigating and correcting a failed scheduled job, trigger its service
once and verify its terminal record. Do not start a second instance while
another production operation is active:

```sh
systemctl start rental-backup.service
systemctl status rental-backup.service
journalctl -u rental-backup.service --since -30m
```

The weekly reboot check uses the same lock and only asks systemd for a
nonblocking reboot when `/var/run/reboot-required` is a regular file. Docker
and host boot return the immutable current digest through
`rental-apartments.service`.

Begin incident triage with `rentalctl status`, then `rentalctl timers` and a
bounded `rentalctl logs --since 30m` query. Apply an event filter before
increasing the journal window.

The final restore, failed-deployment/rollback, Docker restart, host reboot, and
timer-freshness acceptance window uses `ops/production-exercise`. Its checked-in
template is pending, not production evidence. Follow the
[production recovery exercise runbook](production-exercises.md) to create a
root-only observed receipt without copying secrets or raw journals.
