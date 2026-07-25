# Production readiness status

## Decision

The repository-side production automation and its credential-free integration
contracts are implemented. Production launch is **not yet approved** because no
real-VPS recovery exercise receipt is committed or claimed.

This status was audited on 2026-07-25. “Verified locally” below means source
inspection, deterministic integration tests, or fake-command contract
execution. It does not mean GitHub publication, Hetzner provisioning, Telegram,
List.am, CBA, reboot, or recovery behavior was observed on the production VPS.

## Automated evidence status

| Boundary                              | Repository evidence                                                                                                                                                                                                                                                                                               | Status                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Application quality                   | `npm run check` covers application, deployment, operations, bootstrap, observability, and exercise integration behavior.                                                                                                                                                                                          | Verified locally                                                 |
| Coverage                              | `npm run test:coverage` retains the 90% line and 80% branch floors for `src/**/*.js`.                                                                                                                                                                                                                             | Verified locally                                                 |
| Deployment contract                   | `npm run check:production-contract` aggregates Bash syntax, ShellCheck, systemd verification, rendered Compose assertions, workflow pinning, production-only paths, and the no-external-observability-server rule. Required CI invokes it on Linux; its orchestration is integration-tested with fake validators. | Repository contract verified; hosted invocation pending          |
| Publication and unattended deployment | Contract tests cover immutable publication order, discovery by digest, metadata binding, no-op, first install, rollback, failed rollback, and quarantine.                                                                                                                                                         | Verified locally; hosted publication and VPS observation pending |
| Host reconciliation                   | Fake `hcloud`/SSH integration tests cover check, dry-run, create, idempotent reconcile, duplicate refusal, protection, secret preservation, and immutable input validation.                                                                                                                                       | Verified locally; first real host reconcile pending              |
| Operations and observability          | Fake Docker/systemd/journal integration tests cover locks, traps, restore isolation, restart after failures, bounded timers, local logs/metrics, and deduplicated alerts.                                                                                                                                         | Verified locally; scheduled production observations pending      |
| Recovery acceptance                   | `ops/production-exercise` records allowlisted restore, failed-deployment rollback, quarantine skip, Docker restart, host reboot, and timer-freshness outcomes. Tests prove pass/fail/pending handling and prevent raw journal or secret capture.                                                                  | Harness verified locally; every VPS exercise is pending          |

The only checked-in exercise artifact is
[`production-exercise-evidence.template.json`](production-exercise-evidence.template.json).
It has `evidenceKind: "repository-template"`, `overallStatus: "pending"`, no
completion time, and pending status for every exercise. It is not production
evidence.

## Requirement traceability

| Requirement                       | Implemented repository contract                                                                                                                                                                                         | Evidence still required outside the repository                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reproducible runtime and artifact | Node/Chrome and action inputs are pinned; the image carries revision/runtime/lock labels; publication scans before immutable push and advances the production discovery pointer last.                                   | Green hosted quality, full image build/execution, Trivy, metadata publication, and GHCR digest evidence for the release revision.                                                        |
| Singleton deployment and rollback | The host polls the production pointer, resolves an immutable digest, verifies metadata/bundle/Compose, snapshots stop-first, verifies production behavior, rolls back on failure, and quarantines the bad digest.       | One successful normal production deployment and one deliberately failing safe candidate with observed snapshot rollback and successful quarantine skip.                                  |
| Host and storage                  | Bootstrap reconciles one labeled VPS, key-only firewall, protected attached backup volume, immutable OS/tool inputs, persistent journald, operations bundle, timers, and a root-only secret file without a delete path. | Authorized Hetzner credentials, SSH key, initial secret input, a clean-host apply/reconcile, and review of the sanitized bootstrap receipt.                                              |
| Durable state and restore         | Atomic state and snapshot tests cover schema/count/target/offset/hash/profile checks; the monthly wrapper restores into labeled temporary resources with networking and Telegram activity disabled.                     | An isolated production-host restore drill within the one-hour RTO, captured by the sanitized exercise receipt.                                                                           |
| Restart recovery                  | systemd owns the exact current digest at boot; Docker and application restart behavior is asserted by the exercise harness.                                                                                             | Observed Docker restart and host reboot showing the same immutable digest and healthy service after each restart.                                                                        |
| Timers                            | Version-controlled persistent UTC timers own deploy, monitor, storage, backup, maintenance, restore drill, and reboot checks; monitor data includes last/next/result.                                                   | All seven production timers enabled, triggered, successful, and inside their freshness limits. A newly installed never-triggered timer remains pending.                                  |
| Local observability and alerts    | Compose uses journald; bounded persistent retention, SSH-only `rentalctl`, local metrics, alert deduplication, and Telegram owner routing require no log/metrics server or inbound port.                                | Review host journal retention/permissions and safely observe one firing/resolved owner notification while Telegram is reachable. Total host/network loss remains an accepted blind spot. |
| Production post-deploy behavior   | Deployment requires ready startup preflight, health, one successful crawl, expected Telegram/channel permissions, and one poll interval plus five minutes.                                                              | Sanitized receipt and bounded events for the exact production digest, including browser/List.am/CBA behavior and expected delivery mode.                                                 |

## Remaining launch evidence

Follow the canonical
[deployment-from-scratch checklist](deployment-from-scratch.md) for the
operator sequence, command locations, expected results, stop conditions, and
final approval record.

Resolve these in order:

1. Obtain green required hosted CI, including
   `npm run check:production-contract`, complete Linux AMD64 image execution,
   audit, Trivy, immutable metadata publication, and GHCR digest capture.
2. Peer-review the real configuration; reconcile the protected VPS and backup
   volume; verify secret, service-account, journal, firewall, and mount
   permissions without printing values.
3. Complete production browser verification if List.am requires it, then
   observe a normal immutable deployment through preflight, one successful
   crawl, expected Telegram/channel behavior, and the complete observation
   window.
4. Follow [production recovery exercises](production-exercises.md) for the
   isolated restore, deliberately failed deployment/automatic rollback,
   quarantine skip, Docker restart, host reboot, and timer-freshness phases.
5. Finalize and validate the mode-`0600` production observation receipt.
   Launch remains blocked if its overall status is `pending` or
   `observed-fail`.

Do not attach the environment file, raw journals, Telegram identifiers,
apartment data, browser cookies, or provider credentials to the launch record.
