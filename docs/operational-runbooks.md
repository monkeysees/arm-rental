# Operational runbook index

This page is the single operational index. Procedures live with the component
they operate; links below are canonical and should be updated instead of copied
into another handbook.

| Incident or change                                  | Canonical runbook                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Deploy, rollback, staging rehearsal                 | [Release and rollback](release-and-rollback.md)                                                 |
| Launch approval                                     | [Launch checklist](release-and-rollback.md#launch-checklist)                                    |
| Rotate Telegram token                               | [Telegram token rotation](token-rotation.md)                                                    |
| Complete or transfer browser verification           | [Production browser operations](browser-operations.md)                                          |
| Restore persistent state                            | [Persistent-state restore](state-recovery.md#restore-procedure)                                 |
| Malformed, incompatible, or target-mismatched state | [Incompatible-state recovery](startup-preflight.md#incompatible-state)                          |
| Stale crawling                                      | [Stale-crawl response](runtime-incidents.md#stale-crawling)                                     |
| Telegram private or channel failure                 | [Telegram delivery response](runtime-incidents.md#telegram-private-or-channel-delivery-failure) |
| Stale singleton or Chrome lock                      | [Stale-lock response](runtime-incidents.md#stale-singleton-or-chrome-lock)                      |
| Low disk or growing state                           | [Capacity response](state-maintenance.md#low-disk-and-state-growth-response)                    |

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
