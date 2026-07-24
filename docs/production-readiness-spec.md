# Production readiness specification

## Status

Proposed.

This specification defines the work required to operate the rental apartment
bot as an unattended production service. It covers packaging, runtime
configuration, persistence, security, observability, release controls, and
recovery. It does not change the apartment discovery, filtering, or Telegram
delivery behavior documented in `docs/architecture.md`.

## Goals

- Run the bot continuously on a supported, reproducible runtime.
- Prevent concurrent processes from corrupting state or duplicating Telegram
  activity.
- Preserve apartment, delivery, exchange-rate, bot, and browser-verification
  state across restarts and deployments.
- Detect and report failures before monitoring silently becomes stale.
- Keep credentials and persisted user state out of images, repositories, and
  logs.
- Make releases, rollbacks, backups, and restores repeatable.

## Non-goals

- Horizontal scaling or active-active operation.
- Migrating persistence to a network database.
- Exactly-once Telegram delivery. Telegram does not provide an idempotency key
  for `sendMessage`, so the existing small acknowledgement-window duplicate
  risk remains.
- Making List.am security challenges fully automatic.
- Building a public management or monitoring interface.

## Production architecture decisions

### Deployment shape

The supported initial deployment is one long-running application process on a
Linux host, either directly under a service supervisor or in one OCI container.
The process must have:

- one and only one active replica;
- a persistent local volume mounted for all `.data` content;
- a supported Node.js LTS runtime pinned to a specific major and patch version;
- a pinned Chrome or Chromium installation compatible with the installed
  Puppeteer version;
- outbound HTTPS access to Telegram, List.am, and the Central Bank of Armenia;
- no public inbound access except an optional, access-restricted health probe.

Serverless functions and automatically scaled services are unsupported because
Telegram long polling, local JSON state, and the Chrome profile all require a
continuous singleton process.

### Persistence choice

Version 1 production deployment retains the existing JSON state files. This is
acceptable while all of the following remain true:

- exactly one process writes state;
- state is stored on a durable local filesystem with atomic rename semantics;
- backups and restore tests are in place;
- state-file size and write latency remain within the thresholds below;
- operators do not require ad hoc relational queries.

SQLite is the preferred next persistence step. A migration must be planned if
any state file exceeds 50 MB, a state write takes more than 500 ms at p95,
retention exceeds 50,000 apartments, multiple application replicas become a
requirement, or cross-state transactions become necessary. PostgreSQL is not
required for the current singleton architecture.

## Requirements

### PRD-001: Reproducible runtime

The deployment must pin a currently supported Node.js LTS release. The
`engines` declaration, local development version, CI version, and production
runtime must agree on the supported major version.

Chrome or Chromium must be installed as part of the host or image build rather
than discovered from an undocumented machine dependency. Its version and
required Linux libraries must be reproducible.

Acceptance criteria:

- A clean host or image build installs dependencies with `npm ci`.
- Production installs omit development dependencies.
- `node --version` and the browser version are present in deployment metadata.
- A clean deployment starts without manually installing packages on the host.
- The application passes its full quality suite on the production Node major.

### PRD-002: Singleton execution and supervision

The deployment platform must enforce one active replica. It must restart the
process after unexpected failure and send `SIGTERM` during planned shutdown.

The application or its deployment wrapper must also acquire an exclusive lease
or filesystem lock in the persistent data directory. Startup must fail clearly
when another live process holds the lock. The lock is defense in depth and does
not replace the one-replica deployment setting.

Acceptance criteria:

- Replica count, rolling-update behavior, and autoscaling cannot temporarily run
  two bot processes.
- Starting a second process against the same data directory fails before
  Telegram polling or crawling starts.
- An unexpected exit causes a bounded automatic restart.
- A graceful shutdown has at least 30 seconds to abort polling, stop browser
  work, flush state, and close Chrome.
- A shutdown integration test proves that the process exits without leaving a
  second-delivery backlog or an unusable Chrome profile lock.

### PRD-003: Deployment artifact isolation

The deployment artifact must not contain local credentials, local state,
coverage output, development caches, or a developer browser profile.

Acceptance criteria:

- Container deployments include a `.dockerignore` covering at least `.env`,
  `.data`, `node_modules`, `coverage`, `.git`, and logs.
- The final artifact runs as a dedicated non-root user.
- The root filesystem is read-only where the platform supports it; only the
  persistent data directory and a bounded temporary directory are writable.
- Chrome retains its normal sandbox. Production must not add `--no-sandbox`.
- Any Chrome remote-debugging endpoint binds only to a private or loopback
  interface and is not externally routable.

### PRD-004: Configuration and secrets

`TELEGRAM_BOT_TOKEN` must be supplied by the deployment platform's secret
facility. A local environment file is acceptable only on a dedicated host when
it is outside the artifact and readable only by the service account.

Startup configuration validation must fail before any long-running loop begins.
It must reject invalid ranges, unsafe or colliding state paths, unsupported
runtime modes, and configurations that cannot use the persistent data
directory.

Acceptance criteria:

- The Telegram token is absent from the repository, image layers, process
  arguments, deployment output, and logs.
- Secret files use mode `0600`; the data directory uses `0700`; state files use
  `0600`.
- All state paths are distinct and resolve inside the configured persistent
  data directory.
- Production explicitly sets browser headless mode, browser executable path,
  environment name, and persistent data directory.
- Logging applies defensive redaction to tokens, Telegram API URLs, and
  authorization-like values.
- A documented secret-rotation procedure replaces the token without deleting
  delivery state.

### PRD-005: Startup preflight

The service must not report readiness merely because the Node.js process has
started. Before becoming ready it must verify:

1. the data directory exists and is writable;
2. all existing state files contain supported schemas;
3. the singleton lock is held;
4. Telegram credentials are valid using `getMe`;
5. the configured channel is reachable and the bot has required posting and
   editing permissions;
6. Chrome can start with the persistent profile;
7. a List.am page can be loaded or a browser-verification-required state is
   reported explicitly;
8. a usable persisted exchange-rate snapshot exists or the CBA request
   succeeds.

An unsupported or target-mismatched state schema must fail closed. Production
must never interpret incompatible existing state as an empty first run and
overwrite it without an explicit migration or operator-approved reset.

Acceptance criteria:

- Invalid Telegram credentials cause a terminal startup failure.
- Missing channel permissions cause an actionable failure before publication.
- Unsupported state produces an error naming the file and observed schema while
  preserving the file unchanged.
- Browser verification produces a distinct non-ready status and documented
  remediation command.
- Startup logs one structured preflight result without exposing secrets.

### PRD-006: Browser operation and verification

Production must normally run Chrome headlessly with its user-data directory on
the persistent volume. The verification workflow may temporarily run an
interactive browser against the same profile only while the service is stopped.

Acceptance criteria:

- A production-host smoke test loads the configured List.am target and confirms
  the Regular Ads container can be parsed.
- Browser verification survives an application restart.
- Documentation explains how an operator securely opens or transfers a verified
  profile without copying a developer's full `.data` directory into an image.
- The service alerts when a verification challenge prevents crawling.
- Chrome processes and temporary files are cleaned up after normal shutdown and
  unexpected browser failure.

### PRD-007: Durable state and recovery

All state and the verification profile must live on persistent storage. State
writes must retain the existing temporary-file-and-rename strategy and add
durability and access controls:

- write temporary files with mode `0600`;
- flush file contents before rename;
- sync the containing directory after rename where the platform supports it;
- validate the serialized state before replacing the prior file;
- preserve the prior state if any step fails.

Backups must capture a consistent snapshot of apartment, delivery, bot,
exchange-rate, channel, and required browser-profile state.

Service-level recovery objectives:

- recovery point objective: 24 hours;
- recovery time objective: 1 hour.

Acceptance criteria:

- Automated snapshots retain at least seven daily and four weekly recovery
  points.
- Backups are stored independently of the application volume.
- A restore procedure identifies whether the bot must be stopped during
  snapshot and restore.
- A restore drill on a clean staging host succeeds before launch and at least
  quarterly thereafter.
- Recovery validation confirms JSON schemas, apartment counts, delivery counts,
  Telegram update offset, and browser verification before the bot is enabled.
- Disk usage alerts before free space falls below 20%.

### PRD-008: Health and readiness

The deployment must expose liveness and readiness through either a small health
endpoint or an equivalent supervisor watchdog.

Liveness indicates that the process and event loop are responsive. Readiness
requires valid startup preflight and, when private monitoring is active or a
channel is configured, a sufficiently recent successful crawl.

Health output may include timestamps, component status, and application
version. It must not include credentials, owner identifiers, apartment data, or
full error stacks.

Acceptance criteria:

- Liveness failure causes the supervisor to restart the service.
- Readiness becomes false after five consecutive crawl failures or ten minutes
  without a successful crawl, whichever comes first.
- Readiness distinguishes Telegram, browser challenge, List.am, CBA, storage,
  and configuration failures.
- A stale exchange-rate snapshot older than 48 hours creates a warning; absence
  of any usable snapshot makes readiness false when crawling requires currency
  conversion.
- The health mechanism is not publicly reachable without network-level access
  control.

### PRD-009: Logging, metrics, and alerts

Structured JSON logs remain the primary diagnostic stream. Every log record
must include timestamp, severity, environment, application version, and event
name. Crawl-related events must also include a crawl identifier and duration.

Expected external failures must use bounded retry with exponential backoff and
jitter. Telegram `retry_after` remains authoritative for HTTP 429. Invalid
credentials, incompatible state, and invalid configuration are terminal rather
than infinitely retried.

Acceptance criteria:

- Logs are collected outside the application host and retained for at least 14
  days.
- Repeated identical failures are aggregated or rate-limited.
- Network and HTTP 5xx retry delays grow exponentially to a configurable maximum
  of five minutes and reset after success.
- Alerts cover process restart loops, readiness failure, browser challenge,
  invalid Telegram credentials or channel permissions, five consecutive crawl
  failures, stale exchange rates, backup failure, restore-test failure, and low
  disk.
- A successful crawl log includes pages, discovered, updated, notified,
  filtered, channel-sent, channel-edited, total, and duration values.
- Automated tests prove known token shapes are redacted.

### PRD-010: State growth and maintenance

Apartment and delivery state currently retain historical entries indefinitely.
Production must measure file size, record count, state-write duration, Chrome
profile size, and disk growth.

No automatic deletion is required for the initial launch. A documented
retention policy must define which apartment and terminal delivery records may
eventually be archived or pruned without causing old listings to be
redelivered.

Acceptance criteria:

- A weekly report or metric exposes the size and entry count of each state file.
- Alerts fire at 25 MB as an early warning and 50 MB as the SQLite migration
  threshold.
- Chrome cache growth is bounded without deleting verification cookies.
- Any pruning implementation is integration-tested against restart and
  redelivery behavior.

### PRD-011: Continuous integration

Every proposed change must run:

```sh
npm ci
npm run check
npm run test:coverage
npm audit
```

CI must use the production Node major and must build the production artifact.

Acceptance criteria:

- Pull requests cannot merge when linting, formatting, tests, production
  dependency audit, or artifact build fails.
- Coverage does not fall below 90% lines or 80% branches without an explicitly
  reviewed exception.
- High or critical production dependency vulnerabilities block release.
- The artifact receives a dependency and operating-system vulnerability scan.
- Dependency update automation opens reviewed pull requests rather than
  mutating production directly.
- Release metadata records source revision, Node version, browser version, and
  dependency lockfile digest.

### PRD-012: Production-focused testing

The existing unit and integration suite remains required. Production readiness
adds tests for the deployment boundaries that are currently difficult to cover
through application-only mocks.

Acceptance criteria:

- Automated browser tests cover executable discovery, launch failure,
  challenge detection, browser restart, and graceful close.
- Persistence tests cover file permissions, flush/rename failure, incompatible
  schema handling, lock contention, and recovery from an intact backup.
- A staging smoke test uses a dedicated Telegram bot and private test channel,
  never the production channel.
- The staging smoke test exercises Telegram authentication, channel
  permissions, CBA retrieval, a real List.am parse, persistence across restart,
  and graceful shutdown.
- A minimum 24-hour staging soak completes without unbounded memory, browser
  process, profile, or log growth.

### PRD-013: Release and rollback

Deployments must preserve the singleton guarantee and state compatibility.

Release procedure:

1. pass CI and artifact scans;
2. deploy the exact artifact to staging;
3. pass staging smoke and soak requirements;
4. create and verify a production volume snapshot;
5. stop the current production process;
6. deploy without replacing the persistent volume;
7. run preflight and inspect readiness;
8. start polling and crawling;
9. verify one successful crawl and expected Telegram/channel behavior;
10. retain the previous artifact until the observation window ends.

Rollback must stop the new process before starting the old one. If a release
migrates state, it must provide a backward-compatible rollback or a tested state
restore procedure.

Acceptance criteria:

- Release and rollback commands are documented and non-interactive.
- No rollout strategy can overlap old and new replicas.
- A failed preflight leaves existing state unchanged.
- Rollback is rehearsed in staging.
- Production launch has a named operator and an observation window of at least
  one full crawl interval plus five minutes.

## Operational runbooks

The following runbooks must exist before launch:

- deploy and rollback;
- rotate Telegram token;
- complete List.am browser verification;
- restore persistent state from backup;
- recover from malformed or incompatible state;
- diagnose stale crawling;
- diagnose Telegram private or channel delivery failures;
- clean up a stale singleton or Chrome lock after verifying no process is alive;
- respond to low disk and state-growth alerts.

Each runbook must state prerequisites, safe checks, commands, expected output,
rollback or recovery actions, and conditions requiring operator escalation.

## Launch checklist

Production launch is approved only when:

- PRD-001 through PRD-013 acceptance criteria are satisfied;
- production configuration has been peer-reviewed without printing secrets;
- the production volume and independent backup destination exist;
- the singleton constraint and lock have been demonstrated;
- the browser verification procedure has been demonstrated on the production
  runtime;
- readiness and every critical alert have been exercised;
- backup restore and deployment rollback have succeeded in staging;
- a production snapshot has been taken;
- the operator confirms that List.am access and polling frequency are acceptable
  for production use.
