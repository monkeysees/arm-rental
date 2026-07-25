# Operational runbook index

This page is the single operational index. Procedures live with the component
they operate; links below are canonical and should be updated instead of copied
into another handbook.

| Incident or change                                  | Canonical runbook                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Deploy and rollback                                 | [Release and rollback](release-and-rollback.md)                                                 |
| Launch approval                                     | [Launch checklist](release-and-rollback.md#launch-checklist)                                    |
| Rotate Telegram token                               | [Telegram token rotation](token-rotation.md)                                                    |
| Complete or transfer browser verification           | [Production browser operations](browser-operations.md)                                          |
| Restore persistent state                            | [Persistent-state restore](state-recovery.md#restore-procedure)                                 |
| Malformed, incompatible, or target-mismatched state | [Incompatible-state recovery](startup-preflight.md#incompatible-state)                          |
| Stale crawling                                      | [Stale-crawl response](runtime-incidents.md#stale-crawling)                                     |
| Telegram private or channel failure                 | [Telegram delivery response](runtime-incidents.md#telegram-private-or-channel-delivery-failure) |
| Stale singleton or Chrome lock                      | [Stale-lock response](runtime-incidents.md#stale-singleton-or-chrome-lock)                      |
| Low disk or growing state                           | [Capacity response](state-maintenance.md#low-disk-and-state-growth-response)                    |
| Failed or overdue scheduled operation               | [Systemd operations](#systemd-operations)                                                       |
| Current status, logs, timers, and local alerts      | [Production observability](observability.md)                                                    |

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
terminal success are both monitor failures. Do not invoke the underlying Node
maintenance/recovery commands directly: doing so bypasses the shared lock and
the application restart trap.

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
