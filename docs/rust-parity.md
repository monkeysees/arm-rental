# Rust application parity

Issue [#44](https://github.com/monkeysees/arm-rental/issues/44) requires the complete
application and maintenance lifecycle. This document tracks production behavior;
the retained replay implementation does not establish production parity.

## Frozen source baseline

- Production source branch: `b5a4f09cebf62999af06e35e8f132c9e9dc45e12`
  (`main`, verified against the remote on 2026-09-26).
- Rewrite starting point: `59cb60352f87eeedf460b1c63d45486da30112ae`
  (`experiment/22-runtime-comparison`, verified against the remote).
- Runtime/toolchain: Node `24.18.0`, Rust `1.94.0`; dependency locks and the
  checksum-pinned curl-impersonate build belong to the recorded source revisions.
- Production state: SQLite application ID `0x41524d52`, current schema 6,
  supported upgrades from schemas 1–5. Configuration names, defaults and validation
  are defined by `src/config-catalog.js`, `src/config.js` and `.env.example` at
  the frozen revision. No live credentials or configuration values are recorded.

The source branch identity is not evidence of the image currently running on a
host. Live state, deployment and messages are outside local implementation
acceptance. The deployed image identity has not been inspected.

The experimental branch changes three Node modules relative to `main`:
`crawler.js`, `sqlite-private-deliveries-repository.js` and
`sqlite-state-access.js`. Preserve their bounded filter cache (eight variants),
shared listing inventory, narrower history candidate selection and completion of
initial selection when all stored listings already have terminal decisions.
These changes form part of the rewrite baseline alongside production behavior.

## Contract inventory

The table links native implementations to their independent acceptance seams.
Targeted coverage is recorded here; full-suite, packaged-service and capacity
acceptance remain separate gates in the verification record below.

| Contract                                                                                          | Source and existing regression coverage                                                                                                                                    | Rust acceptance status                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration, access modes, managed paths and explicit initialization                            | `config.js`, `config-catalog.js`, `state-init.js`; `config.test.js`, `state-init.test.js`                                                                                  | [config.rs](../experiments/rust-replay/src/production/config.rs); [config](../test/rust-production-config.test.js), [storage](../test/rust-production-storage.test.js), [smoke](../test/rust-production-smoke.test.js)                                                             |
| Regular Ads, Top Ads exclusion, canonical identities and both card layouts                        | `list-am.js`; `list-am.test.js`, `list-am-fixture.test.js`                                                                                                                 | [source.rs](../experiments/rust-replay/src/production/source.rs); [domain](../test/rust-production-domain.test.js)                                                                                                                                                                 |
| Day/instant posting dates, inferred years and supplied dates                                      | `posting-date.js`, `source-activity.js`; `posting-date.test.js`, `crawler.test.js`                                                                                         | [source.rs](../experiments/rust-replay/src/production/source.rs); [domain](../test/rust-production-domain.test.js), [crawl](../test/rust-production-crawl.test.js)                                                                                                                 |
| Source integrity, reason precedence, per-kind history and atomic failure                          | `source-integrity.js`, `apartment-state.js`; `source-integrity.test.js`, `apartment-state.test.js`                                                                         | [source.rs](../experiments/rust-replay/src/production/source.rs); [domain](../test/rust-production-domain.test.js), [crawl](../test/rust-production-crawl.test.js)                                                                                                                 |
| Apartment/house pagination, independent watermarks, encounter order and retained history          | `crawler.js`, `sqlite-apartments-repository.js`; `crawler.test.js`, `incremental-crawl.test.js`                                                                            | [crawl.rs](../experiments/rust-replay/src/production/crawl.rs); [crawl](../test/rust-production-crawl.test.js), [service](../test/rust-production-service.test.js)                                                                                                                 |
| Pinned HTTP profile, cookies, pacing, challenges, bounded redirects and cancellation              | `list-am-http.js`, `list-am-operation.js`; `list-am-http.test.js`, `list-am-operation.test.js`                                                                             | [transport.rs](../experiments/rust-replay/src/production/transport.rs); [transport](../test/rust-production-transport.test.js), [crawl](../test/rust-production-crawl.test.js), [smoke](../test/rust-production-smoke.test.js)                                                     |
| CBA retrieval, atomic quotes, daily refresh/hourly retry and AMD normalization                    | `exchange-rates.js`, `prices.js`; `exchange-rates.test.js`, `prices.test.js`                                                                                               | [runtime.rs](../experiments/rust-replay/src/production/runtime.rs); [domain](../test/rust-production-domain.test.js), [service](../test/rust-production-service.test.js)                                                                                                           |
| Private polling, durable offsets, commands, menus, callbacks and conversations                    | `bot.js`, `filter-ui.js`, `telegram.js`; `telegram.test.js`                                                                                                                | [bot.rs](../experiments/rust-replay/src/production/bot.rs); [telegram](../test/rust-production-telegram.test.js), [service](../test/rust-production-service.test.js)                                                                                                               |
| Metadata synchronization, Russian output, original currencies and optional fields                 | `telegram-metadata.js`, `telegram.js`; `telegram.test.js`                                                                                                                  | [bot.rs](../experiments/rust-replay/src/production/bot.rs); [telegram](../test/rust-production-telegram.test.js), [delivery](../test/rust-production-delivery.test.js)                                                                                                             |
| Authorization, inbound limits, policy changes and identifier-free telemetry                       | `bot.js`, `rate-limit.js`; `rate-limits.test.js`, `telegram.test.js`                                                                                                       | [bot.rs](../experiments/rust-replay/src/production/bot.rs); [telegram](../test/rust-production-telegram.test.js), [runtime-failures](../test/rust-production-runtime-failures.test.js)                                                                                             |
| Filters, housing kinds, regions/places, ranges and history-release consent                        | `filters.js`, `filter-ui.js`, `bot.js`; `filters.test.js`, `telegram.test.js`, `crawler.test.js`                                                                           | [filters.rs](../experiments/rust-replay/src/production/filters.rs); [domain](../test/rust-production-domain.test.js), [telegram](../test/rust-production-telegram.test.js), [delivery](../test/rust-production-delivery.test.js)                                                   |
| Start/restart consent, initial limit, 24-hour activity window and source redelivery               | `crawler.js`, `delivery-selection.js`, `source-activity.js`; `crawler.test.js`, `deletion.test.js`                                                                         | [private.rs](../experiments/rust-replay/src/production/private.rs); [delivery](../test/rust-production-delivery.test.js), [runtime-failures](../test/rust-production-runtime-failures.test.js)                                                                                     |
| Compact decisions, durable work, fair eight-operation scheduling and retry waits                  | `sqlite-private-deliveries-repository.js`, `private-delivery-scheduler.js`; `private-delivery-scheduling.test.js`, `sqlite-delivery-migration.test.js`                     | [runtime.rs](../experiments/rust-replay/src/production/runtime.rs); [delivery](../test/rust-production-delivery.test.js), [runtime-failures](../test/rust-production-runtime-failures.test.js)                                                                                     |
| Channel independence, apartment-only selection, hashtags, edits/reposts and acknowledgements      | `channel.js`, `sqlite-channel-deliveries-repository.js`; `channel.test.js`, `sqlite-channel-incremental.test.js`                                                           | [channel.rs](../experiments/rust-replay/src/production/channel.rs); [delivery](../test/rust-production-delivery.test.js), [runtime-failures](../test/rust-production-runtime-failures.test.js)                                                                                     |
| Confirmed deletion, policy-suspended users, atomic removal and restart                            | `bot.js`, `sqlite-telegram-repository.js`; `deletion.test.js`, `sqlite-state.test.js`                                                                                      | [bot.rs](../experiments/rust-replay/src/production/bot.rs); [telegram](../test/rust-production-telegram.test.js), [runtime-failures](../test/rust-production-runtime-failures.test.js)                                                                                             |
| Production database identity, schema/domain validation, target binding and permissions            | `sqlite-database.js`, `sqlite-repositories.js`; `sqlite-state.test.js`, `sqlite-state-access.test.js`                                                                      | [storage.rs](../experiments/rust-replay/src/production/storage.rs); [storage](../test/rust-production-storage.test.js)                                                                                                                                                             |
| Atomic schema 1–6 upgrades, exact timestamp domain and retryable compaction                       | `sqlite-schema.js`, `sqlite-*-migration.js`; `sqlite-decisions-migration.test.js`, `sqlite-delivery-migration.test.js`                                                     | [storage.rs](../experiments/rust-replay/src/production/storage.rs); [storage](../test/rust-production-storage.test.js)                                                                                                                                                             |
| Initialization, consistent backup, validation, restore, disk checks and reporting                 | `state-init.js`, `recovery.js`, `maintenance.js`; `state-init.test.js`, `recovery.test.js`, `maintenance.test.js`                                                          | [recovery.rs](../experiments/rust-replay/src/production/recovery.rs); [recovery](../test/rust-production-recovery.test.js)                                                                                                                                                         |
| Cross-process singleton, stale recovery, preflight, readiness and shutdown                        | `singleton-lock.js`, `preflight.js`, `application.js`, `health.js`; `singleton.test.js`, `preflight.test.js`, `application.test.js`, `health.test.js`                      | [runtime.rs](../experiments/rust-replay/src/production/runtime.rs); [lease](../test/rust-production-lease.test.js), [health](../test/rust-production-health.test.js), [health-cli](../test/rust-production-health-cli.test.js), [service](../test/rust-production-service.test.js) |
| Redacted logs, owner alerts, source grace, host monitoring, timers and lock behavior              | `logger.js`, `health.js`, `ops/`; `logger.test.js`, `operations-observability.test.js`, `operations-systemd.test.js`                                                       | [health.rs](../experiments/rust-replay/src/production/health.rs); [health](../test/rust-production-health.test.js), [runtime-failures](../test/rust-production-runtime-failures.test.js)                                                                                           |
| Native runtime/maintenance packaging, deployment consumers and snapshot-backed rollback           | `Dockerfile`, `compose.production.yaml`, `ops/`; `runtime-packaging.test.js`, `release-operations.test.js`, `deployment-automation.test.js`, `production-contract.test.js` | [operations.rs](../experiments/rust-replay/src/production/operations.rs); [browser-cleanup](../test/rust-production-browser-cleanup.test.js), [recovery](../test/rust-production-recovery.test.js)                                                                                 |
| Full-app differential regression, 500-recipient fairness/durability/capacity and process failures | `experiments/node-replay/`, production tests and local peers                                                                                                               | [runtime.rs](../experiments/rust-replay/src/production/runtime.rs); [service](../test/rust-production-service.test.js), [runtime-failures](../test/rust-production-runtime-failures.test.js)                                                                                       |

Packaging and host integration are implemented in
[`Dockerfile.native`](../Dockerfile.native),
[`ops/lib/runtime.sh`](../ops/lib/runtime.sh) and
[`ops/service`](../ops/service), with
[`native-operations.test.js`](../test/native-operations.test.js) and the retained
deployment, systemd and observability regressions. The
[`image checker`](../experiments/production-image/check.js) exercises the actual
runtime closure. The
[`production acceptance runner`](../experiments/production-acceptance/run.js)
loads the independent 500-recipient fixture and checks real service output,
retained decisions, interruption recovery and capacity; its generated results
stay outside the repository.

Test filenames above are under `test/`. The Node test oracle must remain
independent of Rust output. Local peers and synthetic populated production
databases must cover successes, malformed inputs, retries, cancellation, policy
changes, deletion, channel edits and meaningful crash boundaries. No whole-machine
RAM, physical Pi or further language-comparison gate is required. Catch-up timing
failures still require resolution before capacity acceptance.

## Verification record

The implementation lives under `experiments/rust-replay/src/production/`, with a
separate `rental-app` binary. The historical `rental-replay` binary and independent
Node oracle remain separate. The user confirmed service/local-peer, native
maintenance/production-SQLite and independent differential/capacity test boundaries.

Acceptance on 2026-09-26 uses pinned Node `24.18.0`, Rust `1.94.0` and the release
binary. The actual Linux AMD64 image passed all 15 packaging checks: complete
native/curl/certificate/license closure, non-root/read-only maintenance,
backup/restore, two-category crawling, private controls, readiness, shutdown and
restart without repeating acknowledged delivery.

The final repository suite passed all 510 tests with no skips and
`RENTAL_APP_BINARY` set to the accepted release binary. Coverage was 94.89% of
lines and 89.03% of branches, above the retained 90%/80% floors. ESLint, Prettier
and the shell/Compose/systemd production-contract validator passed. ESLint
excluded the unrelated, pre-existing untracked `.scratch/` directory.
Rust format, release checks for all targets and strict Clippy passed, together
with all 22 retained Rust integration tests (20 replay and two service tests).

The packaged 500-recipient run passed all eight phases against the independent
Node oracle. Updated and fresh delivery took 26.877 seconds combined against the
60-second routine limit. Catch-up sent 4,000 listings and 500 announcements with
50 injected retries in 24.810 seconds of delivery against a 25.025-second limit
(unchanged 1.1 tolerance). Source pacing took another 8.024 seconds; the original
32.835-second full-wall diagnostic remains a failure under the old measurement.
The approved measurement change is described below. The delivery margin was
0.215 seconds on this host, not a guarantee for other deployment environments.

All 500 recipients progressed within the fairness bound, with at most eight
active delivery requests. A forced container kill preserved 1,000 acknowledged
listings; restart delivered exactly the remaining 3,000 listings. Drained and
returning phases sent nothing. All 3,277,500 immutable historical decisions
retained their original digest. This does not remove Telegram's documented
acceptance-before-local-acknowledgement ambiguity.

Independent Standards and Spec reviews compared the work against `main` and
resolved all findings, including startup cancellation, channel storage-failure
propagation, sanitized operation logs and terminal channel permission failures.
Focused reviews also checked the history cache and bounded first-listing priority.

The accepted artifact identities are:

- Image: `sha256:91db0741ec2c7a7b57f2344556f261eb7b180e4e7294a65b311f238cce7f3638`.
- Binary SHA256: `502e66854d9eee894ac042e8ffc54240761a6c650e05dd933af709dadd4465c8`.
- Source-input SHA256: `5443ba2b6603afcf56a427c69b8f2143993fd4c0a2d6b77f07bc2d870e6dd907`.

The build records starting revision `59cb60352f87eeedf460b1c63d45486da30112ae`
with `sourceDirty: true`; the source-input manifest matches the implementation
files committed with this record. It does not claim that the starting commit
alone produced the image. Reproduction commands are in
[Rust development](rust-development.md). Local raw evidence is retained outside
Git in `/tmp/arm-rental-native-44-priority-build/build.json`,
`/tmp/arm-rental-native-44-priority-check/report.json` and
`/tmp/arm-rental-production-acceptance-500-image-priority-44/report.json`.

ARM execution and whole-machine memory fit were not tested. Production publishing,
deployment and live-state validation remain separate cutover work.

## Baseline discrepancies

The README describes a shared 24-hour bound for channel activity. The actual Node
initial channel classification (`sqlite-channel-deliveries-repository.js`) selects
matching retained listings without that bound; pending sends and published edits
in `channel.js` also lack it. The window applies to filtered/skipped readmission.
Rust preserves the observed Node behavior during parity work. This discrepancy
must remain visible rather than be silently presented as a newly verified bound.

The architecture previously promised item, channel and message identifiers in
channel operation logs. The Node application adapter already removed those
identifiers before logging. Rust preserves the sanitized operation, outcome,
crawl identifier and duration fields; the architecture now describes that
existing privacy boundary.

The user approved separating mandatory List.am fetch pacing from catch-up
delivery timing. The 1.1 delivery tolerance, full-wall 60-second routine limit,
fairness and durability requirements remain unchanged. Reports retain the
original full-wall oracle result alongside the source-separated calculation;
this adjustment does not turn an excessive delivery time into a pass.
