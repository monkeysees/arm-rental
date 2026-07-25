# Production readiness status

## Decision

The repository implementation of the production-readiness work is complete and
its local, credential-free acceptance boundaries are verified. Production
launch is **not yet approved**: hosted CI/artifact scanning and production
control evidence listed below remain mandatory.

This status was audited on 2026-07-25. “Verified locally” means code,
deterministic integration tests, static deployment contracts, or non-mutating
command validation passed. It does not substitute for evidence that requires
GitHub, live upstream services, or the production platform.

## Requirement traceability

| Requirement                         | Repository implementation and local evidence                                                                                                                                                                                                                                                                                                                                                                                               | Evidence still required outside this repository                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reproducible runtime                | `package.json`, `.nvmrc`, CI, and `Dockerfile` pin Node 24.18.0; the image pins Chrome for Testing 150.0.7871.24 and its Debian snapshot; production uses `npm ci --omit=dev`; OCI metadata records revision, Node, Chrome, and lock digest. Exact-Node integration gates and Dockerfile/build-context validation pass.                                                                                                                    | A complete hosted Linux AMD64 image build must finish the Chrome install, verify both executables/labels, and pass the artifact scan.                                               |
| Singleton execution and supervision | The socket lease is acquired before polling/crawling; process tests prove contention, crash recovery, SIGTERM state flush, Chrome cleanup, and backlog-free restart. Rendered Compose fixes one replica, stop-first update/rollback, bounded restart, and 45-second shutdown grace.                                                                                                                                                        | Confirm supervisor recovery and stop-first replacement through production deployment evidence.                                                                                      |
| Deployment artifact isolation       | `.dockerignore` excludes secrets, state, dependencies, coverage, Git, caches, and logs. Static artifact tests verify the non-root user, read-only root, bounded writable mounts, sandbox preservation, no published ports, and loopback-only interactive debugging.                                                                                                                                                                        | Hosted artifact inspection and OS/library scanning must pass on the completed image.                                                                                                |
| Configuration and secrets           | Startup rejects unsupported modes, invalid ranges, path escape/collision/symlinks, unsafe storage, and missing explicit production browser/storage settings. Filesystem tests prove `0700` directories and `0600` state. Logger tests prove token/API URL/auth redaction. The token has no CLI/build argument, and the rotation runbook preserves delivery state.                                                                          | Peer-review the real secret injection and sanitized production configuration; verify secret-file/service-account permissions without printing values.                               |
| Startup preflight                   | Integration tests cover storage, schemas/target identity, held lease, Telegram `getMe`, channel access and post/edit permissions, Chrome/List.am parsing, persisted/live CBA rates, terminal credential/permission failures, unchanged incompatible files, distinct browser-challenge status, cleanup, and one secret-free structured result before loops.                                                                                 | Run preflight with the reviewed production credentials, channel, Chrome profile, List.am egress, and CBA access.                                                                    |
| Browser operation and verification  | Browser tests cover executable discovery, launch/renderer/close failure cleanup, challenge alerting, restart, graceful close, loopback debugging, and persistent profile reuse. Verifier and smoke commands share the singleton lease and profile; the runbook covers secure verification and restricted profile transfer.                                                                                                                 | Pass interactive verification, headless smoke, restarted preflight, and a real Regular Ads parse on the production runtime/service account/volume/egress path.                      |
| Durable state and recovery          | Filesystem tests cover mode-`0600` temporary writes, serialization validation, file flush, atomic rename, directory sync, failure rollback, intact backup restore, schema/count/update-offset/profile verification, daily/weekly retention floors, independent-path enforcement, and the 20%-free-space alert. Runbooks define stopped-service snapshots, seven daily/four weekly points, 24-hour RPO, one-hour RTO, and quarterly drills. | Provision independent backup storage and schedules; complete an isolated temporary-volume restore within one hour; retain counts, offset, browser verification, and alert evidence. |
| Health and readiness                | Private `/live`, `/ready`, and `/health` tests cover responsive liveness, sanitized component states, preflight gating, five-failure/ten-minute crawl gates, distinct Telegram/browser/List.am/CBA/storage/configuration failures, 48-hour rate warnings, and missing-rate failure. Compose exposes no port and its healthcheck terminates an unresponsive application for supervised restart.                                             | Verify protected production monitoring access, non-public probes, and normal supervisor recovery evidence.                                                                          |
| Logging, metrics, and alerts        | Structured logger tests cover required metadata, crawl IDs/duration/counters, recursive token/API/auth redaction, and duplicate failure suppression. Retry tests cover exponential jittered backoff, five-minute maximum, reset after success, Telegram `retry_after`, and terminal errors. Health/recovery/maintenance events cover every required application alert.                                                                     | Configure retention, restart-loop/write-latency/missing-job alerts and owner routes; verify them with safe synthetic production evaluator inputs.                                   |
| State growth and maintenance        | Weekly maintenance reports bytes and entry counts for each state file, Chrome/profile/cache size, disk and growth; state writes report duration. Tests cover 25/50 MiB alerts, lease enforcement, and deletion of only reconstructible bounded caches. The documented retention policy forbids pruning until restart/redelivery integration coverage exists.                                                                               | Schedule the weekly report and collector-side p95 write-latency/disk-growth monitoring; open SQLite migration work when a documented threshold is crossed.                          |
| Continuous integration              | Workflow/static tests verify PR and `main` triggers, immutable action pins, exact Node, locked install, lint/format/tests, 90%-line/80%-branch coverage, production audit, image build, Trivy high/critical blocking, metadata/archive creation, and reviewed Dependabot PRs. Local gates pass, including production audit with zero findings.                                                                                             | Require both workflow jobs in branch protection and obtain a green hosted run, completed image/Trivy scan, and uploaded immutable artifact/manifest for the release revision.       |
| Production-focused testing          | Automated integration tests cover browser, persistence, release, and supervision boundaries without live credentials. Hosted gates add audit, exact image execution checks, and vulnerability scanning. Post-deploy production verification requires ready preflight, one crawl, expected Telegram/channel behavior, and a full observation window.                                                                                        | Retain the hosted CI result and sanitized production verification evidence for the exact digest.                                                                                    |
| Release and rollback                | The production-only runner rejects mutable images, non-production environments, incomplete windows, and overlapping rollout. Local tests and dry-run validation prove immutable inputs, named operator, snapshot, stop-first order, unchanged volume, preflight/crawl/Telegram evidence, candidate stop before restore, and retained prior image. The complete release, rollback, and launch checklist is documented.                      | Take and verify the production snapshot; name the production operator; execute the stop-first release and observe one full crawl interval plus five minutes.                        |

## Operational runbooks

[`operational-runbooks.md`](operational-runbooks.md) indexes every required
procedure: deploy/rollback, token rotation, browser verification, state restore,
incompatible-state recovery, stale crawling, Telegram delivery failure, stale
singleton/Chrome locks, and low-disk/state-growth response. Contract tests
verify that each canonical runbook contains prerequisites, safe checks,
commands, expected output, recovery or rollback, and escalation conditions.

## Local audit evidence

The final audit ran:

- `npm ci`;
- `npm run check` — 113 tests passed on the host;
- `npm run test:coverage` — 90.07% lines and 82.21% branches;
- the same install, checks, coverage gate, and production audit in the pinned
  Node 24.18.0 Linux AMD64 base image;
- `npm audit --omit=dev --audit-level=high` — zero production findings;
- YAML parsing and repository workflow contract tests;
- `docker compose --file compose.production.yaml config --no-env-resolution`
  with non-secret placeholders;
- `npm run release:validate` with immutable placeholder artifacts — validated
  with no Docker call or evidence-file write; and
- `docker build --check` plus a bounded real build. The real build validated
  revision/lock inputs and completed the production dependency install before
  it was intentionally stopped in the slow combined OS/Chrome layer. The
  required hosted artifact job remains the authority for the complete image.

The pinned Linux runtime initially exposed an overly tight 100 ms success
timeout in the liveness-probe test under architecture emulation. The test now
allows two seconds for healthy/HTTP-error responses while retaining its
deliberate 10 ms non-responsive timeout assertion; the complete exact-Node
check and coverage gates pass after that fix. Production probe behavior remains
unchanged at its three-second timeout.

## Launch blockers

Resolve these in order:

1. Obtain green required hosted CI jobs, including the complete image build,
   executable/label checks, Trivy scan, and immutable artifact upload.
2. Peer-review sanitized production configuration and provision the singleton
   data volume, independent backup volume/schedules, secret injection, external
   log retention, monitoring access, and alert routing.
3. Demonstrate production-runtime browser verification and headless smoke,
   complete an isolated temporary-volume restore drill, then take and validate
   the production snapshot.
4. Record the named operator and observation window, execute the stop-first
   release, and confirm ready preflight, one successful crawl, and expected
   Telegram behavior.
