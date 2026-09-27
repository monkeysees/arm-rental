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

The frozen source branch identity does not identify the image now running on
the host. The separately accepted live deployment is recorded below with its
own image digest and receipt; local implementation evidence remains distinct.

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

### Live production cutover (2026-09-27)

Independent host review accepted Rust source revision
`a3b20894ca82785bb80110373a6aef31b427c5f1` running as
`ghcr.io/monkeysees/arm-rental@sha256:d7a453d84daa3935cdd4825f6684a25bc98f7506c85d79ba00668509426b223d`.
The accepted deployment receipt is
`20260927T180637Z-success-d7a453d84daa3935.json`, completed at `18:06:37Z`;
its validated predeploy snapshot is `daily/2026-09-27T18-00-19-960Z`. The
container, current pointer and runtime-aware systemd unit agree on the Rust
release. The service is healthy and ready with zero firing alerts; the backup
mount and timers are healthy, including a successful 18:10 no-op deploy poll.

Rust opened the existing SQLite identity
`46960c40-1fef-4de1-aaa0-745699ed87e0` at schema 6 without changing its
source/channel binding or Telegram offset `930892921`. All 716,231 decision
rows in the retry snapshot remain unchanged. Two older acknowledgements were
refreshed by the recovered Node service before that snapshot, explaining their
timestamp difference from the first-attempt baseline. Two later Rust crawls
with matching source-integrity records naturally sent six and one private
notifications and durably acknowledged all seven; no prior acknowledged work
was replayed in the observed state.

The first live attempt passed Rust observation but failed at final systemd
start because the installed unit still used Node-only direct Compose. Guarded
`compatible-live` rollback restored healthy Node without replacing live SQLite
state; the approved unit was then installed before the successful retry. The
retained Node image and matching snapshot remain rollback options. No external
recipient inbox was inspected, and no deliberate rollback of the healthy Rust
service was performed. The current release still needs package-lock provenance
for host verification; Cargo-only provenance and Node retirement remain #49
and #50 work. See [release and rollback](release-and-rollback.md) for receipts
and the effective-unit preflight.

The implementation lives under `experiments/rust-replay/src/production/`, with a
separate `rental-app` binary. The historical `rental-replay` binary and independent
Node oracle remain separate. The user confirmed service/local-peer, native
maintenance/production-SQLite and independent differential/capacity test boundaries.

### Remediated candidate (2026-09-26)

The five regressions in the [remediation plan](rust-parity-remediation-plan.md)
are fixed in source revision `b56000e96a94ea31231c58732b92ee0fe48076b6`.
Focused Node-versus-Rust process checks reproduced the old failures and now pass:
live disk inspection, maintenance status and alerts, atomic history answers with
injected SQLite failures and restart, deletion or `/stop` during a 60-second
Telegram retry, and saved-history startup preflight. The application lease still
excludes live maintenance. The independent Node oracle was not derived from Rust.

Pinned Rust `1.94.0` formatting, all-target check, all 22 integration tests,
strict Clippy and release build passed. The repository's Node `24.18.0` suite
passed **525 tests with no skips** using `RENTAL_APP_BINARY` and the fixed release
binary; coverage was **94.92% lines and 89.26% branches**, above the 90%/80%
floors. ESLint passed with the unrelated, pre-existing untracked `.scratch/`
directory excluded; Prettier and the shell/Compose/systemd production-contract
gate passed. The packaged image passed all 15 service and maintenance checks,
including read-only non-root operation, backup/restore, local peers, readiness,
shutdown and restart without duplicate delivery.

The packaged 500-recipient run passed all eight phases. Updated and fresh
delivery took 26.961 seconds combined, within the 60-second routine limit.
Catch-up delivered 4,000 listings and 500 announcements with 50 injected
retries in 24.800 seconds of delivery against the unchanged 25.025-second
limit; source pacing added 8.007 seconds. The older full-wall diagnostic is
still a failure under that measurement. All 500 recipients progressed within
the fairness bound with at most eight active delivery requests. After a forced
kill, restart delivered the remaining 3,000 listings after 1,000 acknowledged
listings; drained and returning phases sent nothing. The digest of all
3,277,500 historical decisions was unchanged. This does not remove Telegram's
acceptance-before-local-acknowledgement ambiguity. ARM execution and
whole-machine memory fit remain unverified; the separate live production
cutover evidence appears above.

The fixed artifact identities are:

- Image: `sha256:34ee5013ceecc89692bc097a1908fd73d6e6bd2ff0adade5d036d3bacff25904`.
- Binary SHA256: `e6f63a51efe7def06f8a17122cdb144dfd1b6c3e525508daa13c246496732b84`.
- Source-input SHA256: `37ba018bc66bb972e8c16ad80e229c0870a2ecb7bfd7d8b74e99b07b43cb43dd`.

The build records `sourceDirty: true` because the local checkout included
documentation and untracked scratch files; its source-input manifest identifies
the exact implementation and packaging inputs. Raw evidence is retained outside
Git in `/tmp/arm-rental-native-remediation-build-20260926/build.json`,
`/tmp/arm-rental-native-remediation-check-20260926/report.json` and
`/tmp/arm-rental-production-acceptance-500-remediation-20260926/report.json`.

The WAL-only warning branch could not be exercised through a successful native
maintenance command: both Node and Rust truncate a 27.6 MiB WAL before measuring
it, while a pinned reader makes checkpointing fail with exit `1`. The database
growth warning and both healthy and failure paths have native CLI coverage.

### Earlier candidate (superseded)

Earlier acceptance on 2026-09-26 used pinned Node `24.18.0`, Rust `1.94.0` and the release
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

A later Node-versus-Rust comparison found five regressions at operational and
failure boundaries. The artifact results below describe that earlier candidate
and do not validate the remediated source.

The earlier artifact identities were:

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
