# Architecture

## Purpose

The repository, checkout, and container-package identifier is `arm-rental`.
Runtime resources retain the established `rental-apartments` prefix so existing
production paths, systemd units, and persistent storage remain stable.

The application discovers long-term apartment rentals from List.am for a
private owner-only Telegram bot and, when configured, a public Telegram channel.
It reads only the site's **Regular Ads** section and ignores **Top Ads**. The
configured Telegram owner is the only account allowed to activate and control
private monitoring; channel crawling and publication are
activation-independent.

All bot-generated Telegram replies, notification labels, channel hashtags, and
missing-value fallbacks are in Russian. Apartment messages omit the posting
date, although it remains part of the stored record and delivery ordering.
Messages display the source price and currency, while a separately stored
canonical AMD amount drives all price filtering and channel price-band hashtags.

## Production deployment model

The supported initial production topology is a singleton, long-running process
on a Linux host or in one OCI container. Telegram long polling, local JSON state,
and the persistent Chrome profile require one active writer and exclude
serverless or automatically scaled deployment. A supervisor restarts the
process, forwards SIGTERM for graceful shutdown, and mounts `.data` on durable
local storage.

JSON remains the initial production persistence format while the service has
one writer and modest state volume. The deployment must enforce the singleton
constraint, back up and monitor state, and fail closed on incompatible schemas.
SQLite is the intended migration path if state size or write latency crosses the
documented operational thresholds, cross-state transactions are required, or
multiple replicas become necessary.

Production runs on a pinned, supported Node.js LTS release with a reproducible
Chrome or Chromium installation. Chrome normally runs headlessly with its
profile on persistent storage; interactive List.am verification is performed
only while the service is stopped. Secrets are supplied outside the application
artifact, and readiness represents validated Telegram, browser, storage, and
crawl operation rather than process existence alone.

The current implementation evidence, outstanding deployment checks, and launch
blockers are tracked in
[`docs/production-readiness-status.md`](production-readiness-status.md).
The operator control flow from reviewed source through publication, host
reconciliation, first deployment, acceptance evidence, and later unattended
deployment is defined in the canonical
[`docs/deployment-from-scratch.md`](deployment-from-scratch.md) runbook.

### Production environment boundary

Production is the sole deployed environment. `development` and `test` are
code-execution modes only; neither represents deployed infrastructure. Release
confidence comes from deterministic CI integration tests, dependency and image
gates, a verified pre-deploy snapshot, and production post-deploy verification.
Static contract tests prevent the removed staging, soak, and rehearsal paths
from returning.

### Local observability

Container stdout and stderr flow through Docker's journald driver into
persistent, bounded host journal storage. A short-lived monitor derives an
atomic metrics snapshot and alert-transition state from bounded journal
windows, Docker state, filesystems, and systemd timer state. Operators use
`rentalctl` over SSH for logs, current readiness, recalculated metrics, and
timer status; no observability server or inbound port exists. Telegram is the
deduplicated outbound alert route, while the failed systemd unit and retained
journal records remain the delivery fallback.

### Systemd operations

Systemd owns the singleton application and recurring backup, storage,
maintenance, monitoring, restore-drill, and reboot-check jobs. Every short-lived
operation serializes through
`/var/lib/rental-apartments-ops/operations.lock`, emits structured lifecycle
records, and has an effective `TimeoutStartSec` bound. `RuntimeMaxSec` is not
used for these `Type=oneshot` units because systemd ignores that combination.
Stop-the-world wrappers install their restart and readiness cleanup before
stopping the application. Recovery points remain on the separately mounted
backup filesystem, while monthly restore drills use exactly named and labeled
temporary resources with networking, Telegram polling, and delivery disabled.

### Unattended publication and deployment

GitHub Actions serializes production publication and advances the mutable GHCR
`production` tag only after the scanned image, immutable metadata, and
provenance objects exist. The scratch-based release image carries the metadata,
Compose definition, package lock, and hash-bound operations archive without a
runtime entry point. Publication supplies an inert create-time command so it
can copy every release input back from a stopped container and compare the
bytes before advancing discovery. The VPS obtains these inputs with the
read-only GHCR credential, so private Git repository access is not part of the
host credential boundary. The tag is discovery-only: the VPS validates
the operations archive against an explicit `ops/` and `infra/systemd/`
allow-list, including only the structural `infra/` parent emitted by
`git archive`, before extracting it into a staged release directory. The VPS
then validates digest-bound metadata and persists an immutable image reference.
The deployment observation window reads the application's crawl interval from
the root-only environment file and uses the same 60-second application default
when that optional setting is absent; repeated or malformed values fail closed.
On first install, deployment creates the named local data volume with the
Compose project and volume identity labels and verifies that identity against a
real mountpoint. It accepts either empty storage or the single real
`chrome-profile/` directory that a failed first candidate leaves for explicit
operator verification. Any application state, symlinked profile, or other
top-level entry fails closed before the application starts.
`rental-deploy.timer` invokes a stable bootstrap launcher for first
installation and the verified current release thereafter. Deployment shares
the global operations lock, snapshots before mutation, verifies startup and a
complete observation window, atomically advances runtime pointers, and
restores the prior snapshot and digest on failure. Failed candidate digests are
quarantined to prevent retry loops.

### Host reconciliation

Host provisioning is split between exact-name/production-label provider
reconciliation and an idempotent host reconciler. Ambiguous selection and
immutable server, SSH-key, or volume drift fail closed; no resource deletion or
replacement path exists. Cloud-init stays below Hetzner's 32 KiB user-data
limit by establishing only the key-only deployment account, root-only initial
secret, and trusted host helper. After cloud-init completes, the operator
process transfers the full version-controlled operations bundle over SSH and
invokes that helper with the attached volume's stable device path. Later runs
use the same SSH reconciliation path, so an interrupted initial setup can
resume without recreating provider resources or uploading the secret again.
Archive creation disables macOS metadata, and fully managed host directories
discard AppleDouble sidecars. Host operations reconciliation compares a
filename-and-SHA-256 manifest and prunes unexpected managed files, so empty
local directories and platform metadata do not produce false drift.
The reviewed initial production target is a Hetzner `cx23` server in the
Nuremberg `nbg1` location. These remain explicit bootstrap inputs so a later
capacity or location change requires operator review rather than an implicit
default.

The server is protected against both deletion and rebuild, as required
together by the provider, while the delete-protected backup volume is mounted
by filesystem UUID and exposed through a bind-backed external Docker volume.
Persistent journald retention is bounded by both 14 days and a dynamically
capped host-size budget. Application startup remains gated by the root-only
environment file and immutable image record. Operational state is also
root-owned and mode `0700`; the SSH operator reaches it through audited `sudo`
commands. The stable deployment launcher permits first installation before a
current release symlink exists. A sanitized receipt records Docker, Compose,
kernel, OS, and systemd unit versions.

### Production acceptance evidence

Production acceptance is a phased, root-only host workflow.
`ops/production-exercise` observes existing systemd operations and immutable
deployment receipts, then writes only schema-allowlisted mode-`0600` evidence.
The host reboot check is split into before/after phases. A failed-candidate
exercise must prove snapshot rollback, previous-digest readiness, quarantine,
and a successful quarantine-skip rerun before timer freshness is evaluated.
The checked-in evidence is intentionally pending: deterministic fake-command
tests verify the collection contract but do not claim real VPS observations.

### Health and readiness boundary

`src/health.js` owns a sanitized, in-memory operational projection. It does not
read Telegram or apartment state and never retains errors, upstream bodies,
credentials, owner/channel identifiers, apartment data, or stacks. Startup
preflight results populate configuration, storage, Telegram, browser, List.am,
and CBA component states. Runtime callbacks then record private activation,
channel configuration, crawl outcomes, browser challenges, Telegram operations,
and exchange-rate refreshes.

The HTTP server binds to `127.0.0.1:8787` by default; configuration rejects
non-loopback health addresses and production Compose publishes no inbound port.
`/live` is deliberately narrow: answering the request proves the process event
loop is responsive. `/ready` and `/health` require a ready preflight and, when
private monitoring is active or a channel exists, a successful crawl less than
ten minutes old with fewer than five consecutive failures. A success resets
both failure and age gates. Browser verification has its own immediately
visible challenge state.

The current CBA snapshot timestamp is included without its quote contents. A
snapshot older than 48 hours is a warning; no usable snapshot makes readiness
false whenever the active crawl path requires currency conversion. Component
and reason codes let private alerting distinguish Telegram, browser challenge,
List.am, CBA, storage, and configuration remediation without exposing raw
exceptions.

The Docker and Compose healthcheck calls `src/health-check.js` from a separate
process. Failure to receive `/live` within three seconds kills the container,
which makes the bounded `on-failure` policy restart an unresponsive Node event
loop. It never restarts on `/ready` failure because repeated restarts cannot
repair upstream, permission, verification, or stale-crawl conditions. Probe
behavior and private operator access are documented in
[`docs/health-readiness.md`](health-readiness.md).

### Reproducible runtime packaging

Node.js 24.18.0 is the single supported runtime release. `package.json`,
`.nvmrc`, GitHub Actions, and the production container use that exact patch
version. CI installs the full locked dependency graph with `npm ci` before
running linting, formatting, and tests. The production image performs a
separate `npm ci --omit=dev`, so development-only tooling is not deployed.

The Linux AMD64 production image is based on the immutable multi-platform
digest of the official Node.js 24.18.0 Bookworm Slim image. It installs the
known-good Chrome for Testing 150.0.7871.124 patch from Puppeteer Core 25.3.0's
supported Chrome 150 milestone using Puppeteer's browser installer. The patched
build is required for both headless service operation and headful production
verification; the milestone's earlier `.24` build terminates during Linux X11
startup. Chrome's own `deb.deps` manifest is resolved against the Debian
snapshot dated 2026-07-13, making the browser libraries part of the image build
rather than undocumented host state. OCI image labels expose the exact Node and
browser versions for deployment inventory and verification.

### Continuous integration and artifact provenance

The two branch-protection boundaries are the stable `Required / quality` and
`Required / production artifact` jobs. The first runs the complete repository
checks, a separate 90%-line/80%-branch coverage gate, and a high-severity
production dependency audit on the pinned Node runtime. The second builds the
production image, exercises its pinned Chrome in both headless and headful
modes on a native Linux AMD64 runner, and scans its OS packages and application
libraries before it can be packaged. The browser gate uses the same non-root,
read-only, sandbox-enabled capability and tmpfs contract as production, with a
private Xvfb display for the headful pass. Keeping browser validation, scanning,
and packaging in one required job prevents an untested or unscanned image from
becoming the deployable output.

The aggregate production contract uses baseline POSIX/GNU text tooling supplied
by the runner rather than optional hosted-image utilities. Its integration test
places a failing `rg` executable first on `PATH`, preventing an undeclared
ripgrep dependency from returning unnoticed as runner images evolve. ShellCheck
blocks warning- and error-severity findings; style and informational heuristics
remain non-blocking because jq programs and trap callbacks intentionally use
constructs that those lower-severity checks cannot distinguish from mistakes.
Systemd units are verified inside a temporary filesystem root containing
synthetic Docker/network dependencies and executable placeholders for declared
production paths. This keeps dependency and command validation active without
requiring CI to reproduce the VPS directory layout.
Compose rendering similarly disables environment-file and host-path resolution
while retaining model normalization and consistency checks. Before rendering,
the validator asserts and replaces exactly the production secret-file path in a
temporary Compose copy with an empty temporary environment file. The committed
production path remains unchanged, and the static gate does not require
production secrets or directories.

Build arguments bind the image to the full Git revision and SHA-256 digest of
`package-lock.json`; the Dockerfile validates both and records them alongside
the pinned Node and Chrome versions as OCI labels. CI saves the exact scanned
image and creates a release manifest that repeats those inputs and records the
archive digest. This manifest is the handoff boundary for staging and
production: later deployment must load the uploaded archive, not rebuild from
source.

Workflow actions are immutable commit pins. Dependabot proposes npm, base
image, and workflow-action updates as reviewable pull requests and has no
deployment capability. Coverage exception review, branch-protection setup,
artifact contents, and hosted-only validation are documented in
[`docs/continuous-integration.md`](continuous-integration.md).

### Singleton lease and supervision

`DATA_DIRECTORY` identifies the persistent storage root and defaults to
`.data`. The default apartment, delivery, exchange-rate, Telegram, channel, and
Chrome-profile paths are resolved beneath it. Explicit per-file overrides
remain available, but the process-wide singleton lease always lives directly in
this directory.

Before constructing the browser integration or entering Telegram polling,
`src/index.js` starts the lifecycle in `src/application.js`, which calls
`src/singleton-lock.js`. The lock is a Unix-domain socket at
`.singleton.sock`, with operator-readable owner metadata in `.singleton.json`.
A socket provides a kernel-owned live lease: it cannot be acquired by a second
process, and the kernel releases its listener when the owner exits even if no
shutdown handler runs. A contender connects to prove the owner is live and
exits with a message containing its PID and hostname. It does not rely on a PID
file alone, avoiding PID reuse and cross-container PID namespace ambiguity.

An abrupt exit can leave the socket pathname behind even though its listener is
gone. Startup distinguishes this connection-refused state from a live owner,
serializes cleanup through `.singleton-recovery`, removes only the stale socket,
and retries the atomic bind. Recovery ownership itself has a short stale
threshold so a crash during cleanup cannot permanently prevent restart. Lock
release compares the socket inode and metadata lease identifier before deleting
either path, preventing an old owner from removing a successor's lease.

[`compose.production.yaml`](../compose.production.yaml) is the production
supervision definition. It combines a fixed container name and one declared
replica, so explicit scaling is rejected, with stop-first update and rollback
ordering, so old and new releases do not overlap. Planned replacement sends
SIGTERM and allows 45 seconds for shutdown. Unexpected failure is retried at
five-second intervals with at most five attempts; this bounds restart loops
while stale socket recovery permits a crash restart on the same volume.

Node runs directly under a minimal init process. On SIGINT or SIGTERM the
application aborts Telegram long polling, crawl and exchange-rate work, waits
for their awaited state writes to finish, closes Chrome, and only then releases
the lease. Delivery acknowledgements remain the backlog boundary: an
acknowledged item is not re-enqueued after restart, while an interrupted
unacknowledged send retains the documented at-least-once behavior.

### Deployment artifact isolation

The container build context excludes local environment files, the complete
`.data` tree (including any developer Chrome profile), dependency and coverage
trees, Git metadata, logs, and common development caches. The Dockerfile copies
only the locked package manifests and `src`, and its runtime command does not
load a local environment file. Production configuration therefore enters at
container creation rather than becoming an image layer. npm and Corepack are
build-time tools only and are removed after installing the locked dependencies
and browser, leaving no package manager in the production filesystem.

The final process runs as the official Node image's dedicated, unprivileged
`node` account. The production Compose definition repeats that user boundary
and makes the image root filesystem read-only. Its only application-persistent
writable path is `/app/.data`; `/tmp` and `/dev/shm` are explicit in-memory
filesystems capped at 128 MiB and 256 MiB respectively, with device, set-user-ID,
and executable-file behavior disabled. The service publishes no inbound ports.

Chrome retains its Linux sandbox. The pinned `chrome_sandbox` helper is owned by
root with its required mode in the image, while Chrome itself is launched by
the unprivileged application account. Application launch arguments never
disable the sandbox. Puppeteer's production control channel uses a pipe; the
interactive macOS verification path is the only TCP debugging mode and
explicitly binds it to `127.0.0.1`.

The image build and hosted artifact gate execute the installed browser and
require its exact pinned numeric version. Chrome for Testing releases may
report either the standard `Google Chrome` product prefix or the explicit
`Google Chrome for Testing` prefix and may append trailing whitespace, so
packaging trims only trailing whitespace before accepting those two identities
without weakening the version pin.

### Configuration and secret boundary

`src/config.js` is the fail-fast boundary before the singleton lease and all
long-running loops. It accepts only the `development`, `test`, and `production`
runtime modes and validates numeric and filter ranges while building the
configuration. Production has no implicit storage or browser choices:
`NODE_ENV=production`, `DATA_DIRECTORY`, `BROWSER_HEADLESS=true`, and an
absolute `CHROME_EXECUTABLE_PATH` must all be explicit.

Apartment, private-delivery, channel-delivery, exchange-rate, Telegram bot, and
Chrome-profile paths are normalized and must be distinct children of
`DATA_DIRECTORY`. Startup rejects filesystem-root storage, paths outside the
configured tree, non-regular state files, and symlinked managed paths. Before
the lease is acquired it creates and probes the persistent tree, restricts
managed directories to `0700`, and restricts existing state files to `0600`.
Atomic state replacements create their temporary files as `0600`, so the final
file does not inherit a permissive process umask.

The Telegram bot token is accepted only from the process environment populated
by a deployment secret facility or, on a dedicated host, a host-only mode-0600
environment file. No CLI option or image build argument accepts it. The
structured logger recursively redacts token-shaped strings, Telegram Bot API
and file URLs, sensitive-key values, authorization headers, and Bearer/Basic
credentials in normal context and serialized errors. Rotation changes only the
external secret and deliberately preserves every file in the persistent data
directory; the operator runbook is
[`docs/token-rotation.md`](token-rotation.md).

### Observability boundary

`src/logger.js` is the application logging boundary. Every newline JSON record
has UTC timestamp, severity, environment, application version, stable event
name, and message. Warning/error signatures exclude volatile crawl IDs, so
identical failures are rate-limited for five minutes and the next emitted
record reports the suppressed count. Redaction runs after the complete record
is assembled, including generated event names, nested values, and error stacks.

`src/retry.js` provides the shared expected-external-failure policy. Network
errors and HTTP 5xx responses retry with exponential delay and jitter, bounded
by the validated `EXTERNAL_RETRY_MAX_MS` value (at most five minutes). A
successful operation resets its backoff object. Telegram's server-supplied
`retry_after` is deliberately authoritative for HTTP 429. Terminal credential
or permission errors, invalid configuration, and incompatible state escape to
the supervisor instead of entering runtime retry loops.

Crawl completion and failure events carry a random crawl ID and elapsed
milliseconds. Successful crawl records also expose the page, discovery,
update, notification, filtering, channel send/edit, and total counters as
log-derived metrics. Retry and channel-operation records are correlated with
the same crawl where applicable. There is no public metrics surface.

`HealthMonitor` emits edge-triggered firing/resolved events for readiness,
browser challenge, invalid Telegram access, five crawl failures, and stale
rates. Recovery commands emit backup, restore-test, and low-disk firing events.
The external collector derives restart-loop alerts from `application.started`
because restart history outlives a process. Production Compose requires an
external Fluentd-compatible collector. Retention, alert routes, scheduled
operational checks, and staging exercises are specified in
[`docs/observability.md`](observability.md).

### Startup preflight boundary

`src/application.js` does not enter Telegram polling or either monitoring loop
until `src/preflight.js` returns `ready`. Storage validation first proves that
the managed tree supports create, write, rename, and removal; the singleton
lease is then acquired and remains held for the rest of preflight and runtime.
Existing apartment, private-delivery, channel-delivery, exchange-rate, and bot
files are parsed read-only and checked against the schema versions and target
identities understood by their runtime consumers. The bindings include the
List.am URL template, Telegram owner, channel username, and AMD rate base.
Unsupported, malformed, and target-mismatched files produce
`ERR_STATE_INCOMPATIBLE`, including the filename and observed type/version, and
are never interpreted as empty state.

External checks use Telegram `getMe`, `getChat`, and `getChatMember` to verify
credentials, channel reachability, and the bot's Post Messages and Edit
Messages administrator permissions. Preflight launches Chrome with the durable
profile, loads and parses page one of the configured List.am target, and asks
the exchange-rate service for either a compatible persisted snapshot or a
successful CBA retrieval. Invalid credentials and channel configuration are
terminal. A List.am challenge instead produces the distinct
`browser_verification_required` non-ready state and the remediation command
`npm run browser:verify`.

Startup emits exactly one structured `Startup preflight completed` result. It
contains component states, a stable failure code, terminal/readiness flags, and
when applicable the state filename/schema or browser remediation command. It
never contains the bot token, Telegram API URL, bot identity, or response
payload. Chrome and the singleton lease are released on every failed preflight.
Operational diagnosis and recovery are documented in
[`docs/startup-preflight.md`](startup-preflight.md).

### Browser operation and verification boundary

Production, preflight, and production-host smoke launch Chrome headlessly from
the pinned executable. They reuse `BROWSER_PROFILE_DIR` on the durable volume;
the interactive verifier changes only the launch display mode and uses that
same profile. Both maintenance commands validate the managed storage tree and
acquire the application singleton lease before constructing Chrome, which
enforces the requirement that the service is stopped and prevents the service
from starting concurrently.

`npm run browser:verify` opens the configured page-one List.am target in a
private interactive Chrome session, waits for the Regular Ads container, parses
it, closes Chrome, and releases the lease. `npm run browser:smoke` is restricted
to production configuration, retains headless mode, loads the configured target
through the persisted profile, and logs the parsed Regular Ads count. A
successful verifier followed by smoke and restarted preflight proves that
verification state survived Chrome and application restart. Profile state is
mounted at runtime; it is never copied from a developer `.data` directory or
baked into an artifact. Direct production-host verification and a restricted
profile-only transfer fallback are documented in
[`docs/browser-operations.md`](browser-operations.md).

Each Chrome launch uses a profile-keyed, mode-`0700` runtime root beneath the
bounded system temporary directory. Startup clears stale resources left by a
prior failed browser/service run. HOME, XDG configuration/cache, and the XDG
runtime path all resolve beneath this tmpfs-backed launch directory, so Chrome
never needs to write to the immutable image home. Chrome for Testing's Breakpad
and crash-reporter subprocesses are disabled for every launch; its Crashpad
subprocess is additionally disabled for interactive Linux verification because
it triggers Chrome's CFI guard during sandboxed headful startup.
Application-owned structured logging still records browser process and protocol
failures. The container has
the `SYS_ADMIN` capability required by Puppeteer's sandboxed Docker runtime to
create Chrome's short-lived PID and network namespaces; it remains non-root,
read-only, portless, and uses Chrome's sandbox rather than `--no-sandbox`.
Launch initialization, navigation, renderer, challenge, abort, and graceful
shutdown paths close the Puppeteer browser, terminate its remaining owned child
when necessary, and remove the runtime root. A later crawl starts a fresh
Chrome process against the unchanged durable profile.

Challenge detection emits the stable `browser.challenge` event with component
`browser`, code `ERR_BROWSER_VERIFICATION_REQUIRED`, severity `warning`, and the
operator remediation command. Startup additionally retains its distinct
`browser_verification_required` preflight result. This event is the application
hook for production alert routing without coupling browser operation to the
later monitoring implementation.

### Production-focused test boundary

Deployment-boundary coverage is split between deterministic integration tests
and explicitly provisioned staging exercises. Browser integration tests cover
executable discovery, partial-launch cleanup, challenge detection, fresh
launch after failure, protocol-close failure, and graceful child termination.
Persistence integration tests use the real filesystem and child processes to
cover restrictive modes, flush and rename rollback, schema rejection,
singleton contention, and intact snapshot restore.

`src/staging-guard.js` requires production runtime behavior plus explicit
staging markers before either live command can act. A mode-`0600` marker in the
dedicated volume binds the command to the expected dedicated bot and numeric
private-channel IDs. The ordinary public `TELEGRAM_CHANNEL_ID` must be absent.

`src/staging-smoke.js` performs two separately leased passes. Each constructs
new Telegram, browser, and exchange-rate clients, verifies the expected bot and
private-channel permissions, and parses live List.am Regular Ads. The first
pass forces a real CBA retrieval and persists rate, browser, and smoke evidence;
the restarted pass loads and validates it. Chrome close and lease release are
required at both boundaries.

`src/staging-soak.js` launches the normal application, waits for readiness, and
observes it for no less than 24 hours. It bounds process-tree RSS growth, Chrome
child count, profile/cache growth, and captured-log growth. It always requests
SIGTERM and treats forced, signaled, or nonzero exit as failure. The complete
sample series and summary form a versioned JSON artifact. Provisioning,
thresholds, and commands are documented in
[`docs/production-testing.md`](production-testing.md).

### Durable state and recovery boundary

`src/state.js` is the only JSON replacement primitive. It serializes and parses
the complete next value before touching the existing path, creates an exclusive
mode-`0600` temporary file, flushes its contents, and retains a hard-linked
rollback entry for an existing state file. The temporary file is atomically
renamed only after validation. The containing directory is then synced on
filesystems that support directory sync. A flush, link, rename, or directory
sync failure restores the prior link (or removes a newly created target) before
the error returns. This makes a successful call a durable replacement while a
failed call leaves the last committed JSON state readable.

The same primitive emits `state.write.completed` or `state.write.failed` with
the state basename, serialized byte count, outcome, and end-to-end duration.
The application lifecycle installs the structured-log observer and removes it
on shutdown. Observer errors are isolated from persistence, so unavailable
telemetry cannot change the result of a durable write.

Every successful interactive verification, production browser smoke, and
startup List.am preflight writes a versioned verification record inside the
persistent Chrome profile. It binds the profile to the configured List.am
target and records the verification time and parsed Regular Ads count. The
record is evidence for offline snapshot validation; a post-restore browser
smoke remains the required live verification before polling is enabled.

`src/recovery.js` is the maintenance boundary for the complete persistence set.
Backup and restore acquire the application singleton lease, so the service must
be stopped and no browser can mutate the profile. A backup first validates the
apartment, private-delivery, bot, exchange-rate, optional configured channel,
and browser schemas against their runtime compatibility functions. It copies
all managed state and profile files except transient Chrome singleton links
into an unpublished staging directory, restricts copied permissions,
revalidates counts and Telegram update offset, hashes every file, and only then
renames the staged directory into the daily recovery set. Sunday UTC snapshots
are also retained as weekly points. Configuration enforces at least seven daily
and four weekly points and rejects any backup destination that contains or is
contained by the application data directory.

Restore accepts only a snapshot beneath the independently configured backup
destination. It verifies the manifest, hashes, schemas, target identities,
record counts, update offset, and browser record before acquiring the lease.
Managed live entries are moved into a private rollback directory and the staged
snapshot entries are renamed into place. Any failed install or post-install
validation moves the prior entries back. A successful restore deliberately
reports that live browser verification is still required.

`src/recovery-cli.js` exposes backup, snapshot validation, restore, and the
20%-free-space check. Its structured `backup.*`, `restore.*`, and
`storage.low_disk` events are stable alert hooks without introducing the
generalized health and alert policy reserved for later production-readiness
work. Daily automation, the 24-hour RPO, one-hour RTO, quarterly drill, and
operator escalation are documented in
[`docs/state-recovery.md`](state-recovery.md).

`src/maintenance.js` is the weekly state-growth boundary. After startup storage
validation, `src/maintenance-cli.js` acquires the same singleton lease before
reading state or touching the browser profile. It validates and reports the six
state documents (the five configured files plus browser verification), applies
25 MiB early-warning and 50 MiB SQLite-migration thresholds to those files, and
measures the Chrome profile and total managed bytes. A small versioned history
file stores only the prior aggregate byte sample for week-over-week growth; it
is neither an application state input nor included in its own growth total.

Chrome receives a disk-cache byte cap at every launch. Under the stopped-service
lease, weekly maintenance removes only enumerated reconstructible HTTP,
bytecode, GPU, Dawn, Graphite, and shader cache directories. Cookie, local
storage, IndexedDB, Service Worker, preference, and browser-verification data
are outside the cleanup set. Cache targets that are not real directories fail
closed. There is no apartment or delivery deletion path. Future coordinated
archive/prune rules and their mandatory restart/redelivery tests are specified
in [`docs/state-maintenance.md`](state-maintenance.md).

### Release and rollback boundary

`scripts/release-operations.js` is the non-interactive release contract. Before
any Docker mutation it requires two immutable image IDs/digests, a named human
operator, a published and validated recovery point, an explicit private/channel
expectation, and an observation window no shorter than one configured crawl
interval plus five minutes. Validation and dry-run modes perform no Docker call
or write. Staging rehearsal is rejected unless the running container carries
the staging environment label, preventing a rehearsal flag from mutating the
production singleton.

The runner verifies the fixed one-replica, stop-first Compose shape and existing
named data volume, stops and confirms the old container before creating the new
one, and never replaces or prunes the volume or image. Normal startup remains
the only preflight implementation; application loops cannot begin until it is
ready. Success additionally requires a ready preflight record, Telegram and
expected channel checks, a successful crawl, and final readiness after the full
observation window.

A failed candidate is stopped before the verified snapshot is restored and the
previous artifact is restarted, so browser/rate changes made during an
ultimately failed preflight are reverted with JSON state. Rollback either uses
a rehearsed backward-compatible schema or restores the snapshot before the old
artifact starts. Staging rehearsal executes the candidate transition and
snapshot-backed stop-first rollback, then leaves the previous staging artifact
running. The independent backup volume is externally provisioned and mounted
separately from application data. Release and rollback procedures, evidence
receipts, and escalation are in
[`docs/release-and-rollback.md`](release-and-rollback.md). The initial launch
sequence and approval boundary are in
[`docs/deployment-from-scratch.md`](deployment-from-scratch.md), and all
operator procedures are indexed in
[`docs/operational-runbooks.md`](operational-runbooks.md).

## Runtime flow

1. `src/index.js` validates private and channel configuration, acquires the
   persistent-directory singleton lease, and runs the startup preflight. Only a
   ready result permits the reusable Chrome-backed page fetcher and Telegram bot
   to enter their long-running loops.
2. One loop in `src/bot.js` long-polls Telegram. A private `/start` from
   `TELEGRAM_OWNER_ID` activates persistent private monitoring; all other users
   and group chats are ignored. `/filters` and the inline start button expose
   persistent price, room, and hierarchical location controls. Range values are
   collected from the owner's next text message; `/cancel` abandons pending
   input.
3. A crawl loop runs when private monitoring is active or a channel is
   configured. With neither condition, it waits for activation. After apartment
   state is saved, private admission/delivery and `src/channel.js` publication
   run concurrently against separate state files. Channel state, formatting,
   and Telegram failures are isolated from private delivery and the update
   loop.
4. A separate activation-independent loop asks `src/exchange-rates.js` for the
   persisted CBA snapshot. The service refreshes USD, EUR, and RUB together when
   it is at least 24 hours old. A failed refresh keeps the last snapshot active
   and suppresses another attempt for one hour; concurrent refresh requests
   share one in-flight operation.
5. `src/crawler.js` fetches List.am category pages sequentially through
   `src/browser-fetch.js`, which requests the `ru-RU` browser locale, and parses
   each page with `src/list-am.js`.
6. `src/prices.js` maps source currency symbols to ISO codes and converts every
   newly discovered USD, EUR, or RUB price to whole AMD before apartment state
   is committed. It also migrates version 1 apartment records on their next
   crawl. The rate audit attached to a stored apartment is not rewritten by a
   later daily exchange-rate refresh.
7. On an empty database, pages 1 through 10 are parsed. On later crawls, the
   newest posting date in the database is the temporal watermark. Cards are
   read newest-first through every card sharing that minute, and parsing stops
   when an older posting date is reached. Known IDs above the watermark do not
   stop discovery. If stored dates cannot be parsed, the crawl falls back to the
   configured initial page count. Empty pages and repeated page signatures also
   stop the crawl.
8. Known cards encountered before the watermark are compared across source
   title, original price, location, rooms, area, floor, URL, and posting date. A
   change replaces the source fields, preserves `firstSeenAt`, and records
   `updatedAt`. An original amount or currency change is normalized with the
   latest persisted rate and replaces its rate audit; otherwise the prior
   canonical price and audit remain unchanged.
9. Newly discovered and updated records are atomically committed before
   Telegram delivery begins. Private `src/filters.js` admission remains
   terminal: non-matches become filtered, and on an empty private delivery
   history only the latest matching `INITIAL_DELIVERY_LIMIT` are selected.
   Source order is reversed so selected messages are delivered oldest first,
   then acknowledged one at a time.
10. `src/channel.js` independently evaluates environment filters. With no
    compatible channel state, it atomically classifies the full apartment order:
    the latest matching `INITIAL_DELIVERY_LIMIT` become `pending`, older matches
    become `skipped_initial`, and non-matches become `filtered`. Pending posts
    are sent oldest first. Later unseen IDs are terminally admitted as `pending`
    or `filtered`; a changed filter fingerprint is logged without reclassifying
    history.
11. Published channel entries retain Telegram message IDs and SHA-256 hashes of
    the complete rendered message. A changed hash triggers `editMessageText`;
    an unchanged hash, including a posting-date-only source update, makes no
    request. If Telegram reports a missing message, the publisher sends a
    replacement and stores its new ID. Published posts remain managed even when
    later data would not match the current channel filters.

## Filter model

Private filters live in Telegram bot state and default to no restrictions.
Price and room filters each have nullable inclusive `min` and `max` bounds.
Price input and comparison are always in AMD, using the apartment's canonical
`amountAmd`; the private notification still renders `originalAmount` and
`originalCurrency`. Each range submission, location toggle, and reset is
persisted immediately; the interface has no deferred save action.

Location configuration is a static ordered hierarchy in `src/filters.js`.
Ереван is deliberately the first region and its districts are the first
place-level choices. Stable compact IDs (`r:<region>` and
`p:<region>:<place>`) keep Telegram callback data below its size limit and make
multiple selections inexpensive to persist. Selecting a whole region matches
the region and all children. Selecting a child removes the whole-region choice
for that region, while selections in other regions remain intact.
`src/filter-ui.js` owns presentation and keeps matching rules independent of
Telegram.

Channel filters are parsed once from the environment and never read or mutate
private bot state. Price and rooms use the same inclusive exact/open/closed
ranges. Location selectors resolve case-insensitive human-readable region and
place names to the same stable IDs. Multiple locations are OR conditions;
price, rooms, and location are AND conditions. Blank locations default to the
whole Yerevan region, and `all` removes the location restriction. Unknown,
ambiguous, malformed, duplicate, or whole-region/child conflicts fail startup.

## Channel rendering

`formatChannelApartmentMessage` reuses `formatApartmentMessage` verbatim, adds
one blank line, then appends hashtags in region, locality, AMD price band, and
room order. Region inference uses the configured locality hierarchy. Hashtag
text is NFKC-normalized and Russian-lowercased; spaces and hyphens collapse to
underscores, unsupported characters are removed, and duplicate region/locality
tags are omitted.

Positive canonical AMD prices use inclusive 50,000-dram bands. Missing prices,
locations, regions, and rooms receive explicit Russian fallback tags. Rendering
never changes private apartment messages, which continue to show original
source prices without hashtags.

## Persistence

All state is JSON written with a temporary file followed by an atomic rename.
The `.data` directory must be mounted on persistent storage in production.

- `apartments.json` is the source of truth for normalized apartment details and
  crawl metadata. Stored fields are URL, item ID, title, whole-AMD canonical
  price, original amount and ISO currency, location, rooms, area in square
  metres, combined current/total floor, posting date, first-seen timestamp, and
  source-update timestamp when applicable. Foreign prices additionally retain
  the per-unit AMD rate, snapshot fetch time, and CBA effective date.
- `exchange-rates.json` stores one validated, atomic CBA snapshot containing
  USD, EUR, and RUB quote amounts and rates, its fetch timestamp, and its CBA
  effective date. It is reusable across process restarts.
- `telegram-deliveries.json` tracks private successfully sent item IDs and the
  intentionally skipped portion of initial history. Its `filtered` index records
  listings rejected by the private filters active on first admission. Selected
  unsent messages remain retryable.
- `telegram-bot.json` stores owner identity, activation, private chat ID,
  Telegram update offset, optional private filters, and pending range-input mode.
- `telegram-channel-deliveries.json` is a separate channel state machine keyed
  by item ID. It stores terminal `filtered` and `skipped_initial` admissions,
  retryable `pending` entries, and `published` entries with Telegram message ID,
  content hash, classification/publication timestamps, and an edit timestamp
  when applicable. Compatibility binds state to both the List.am URL template
  and channel username; changing the channel starts a fresh classification.
- `chrome-profile/` stores cookies from List.am security verification.
- `.maintenance-history.json` stores only the previous successful maintenance
  timestamp and aggregate managed byte count. It is excluded from application
  state thresholds, entry counts, and managed-growth totals.

State files include a schema version and type discriminator. Apartment state
also binds to the target URL. Incompatible or target-mismatched state fails
closed during startup and remains unchanged until an explicit migration or
operator-approved reset.

## Parsing model

The parser scopes card selection to `#contentr`, List.am's Regular Ads
container. It never queries `#tp`, which contains Top Ads. The parser initially
returns source price `{ amount, currency }`; `src/prices.js` turns it into the
canonical and original-price fields before persistence. Words such as
"monthly" are discarded. Rooms, area, and floor are extracted by position from
List.am's comma-separated card metadata, making parsing independent of
localized labels such as `ком.`, `кв.м.`, and `этаж`. The original posting date
is retained as displayed by List.am.

## Failure handling

- HTTP, browser challenge, malformed apartment/private state, and private
  Telegram API failures propagate to the monitoring loop and are logged as
  structured JSON.
- CBA responses are accepted only when all three required quotes, their amounts,
  and rates are valid. Refresh failures retain the previous snapshot and retry
  hourly. With no previous snapshot, foreign-price normalization fails before
  apartment state is written.
- Telegram HTTP 429 responses honor `retry_after` and are retried up to three
  times.
- Private and channel classifications are persisted before messages are sent.
  Successful deliveries are acknowledged immediately. A restart cannot turn a
  rejected listing into an unexpected backlog.
- Channel sends fail independently and leave entries pending. Failed edits
  retain their prior acknowledged content hash. Per-operation structured logs
  include operation, item ID, channel ID, known message ID, outcome, and error,
  without including the bot token.
- Telegram `sendMessage` has no idempotency key. A process exit after Telegram
  accepts a channel post but before local acknowledgement is atomically renamed
  into place carries a small at-least-once duplicate risk.
- Replayed Telegram callbacks that render an already-current menu are treated
  as successful, covering the window between saving filter state and the update
  offset.
- SIGINT and SIGTERM abort Telegram polling and browser work, then close Chrome
  cleanly before the application lease is released.
- Startup preflight failures close Chrome and release the singleton lease before
  exiting. State compatibility is checked before external calls, so invalid
  state cannot be overwritten by a later initialization path.

## Testing boundaries

Parser tests verify field normalization and Top Ads exclusion. Crawler
integration tests exercise multi-page initial discovery, the posting-date
watermark (including refreshed IDs and equal-minute listings), known-card
updates, persistence, delivery retry, and filter-classification behavior.
Filter tests cover optional/open ranges, regions, places, composed criteria, and
AMD comparison of foreign source prices. Exchange-rate tests cover SOAP parsing,
atomic validation, daily refresh, hourly failure backoff, restart reuse, and
conversion audit fields. Telegram tests cover owner-only activation,
interactive filter configuration, Yerevan-first selection, Russian formatting
and fallbacks, rate-limit retries, and channel/private runtime isolation.
Channel integration tests cover configuration validation and composition,
initial classification/order, partial-send restart recovery, canonical-AMD
hashtags, edits and retries, and missing-message replacement.
Process integration tests start real child processes against one temporary
persistent directory. They prove that a live second process fails before
polling, an unclean exit is recoverable, and SIGTERM flushes delivery state,
closes the Chrome-profile lock, releases the application lease, and permits a
backlog-free restart. Deployment contract tests pin the one-replica,
stop-before-start, bounded-restart, and 45-second grace settings.
Artifact-isolation tests also verify the build-context denylist, immutable
non-root container contract, bounded writable mounts, sandbox configuration,
and loopback-only remote debugging.
Preflight integration tests exercise the complete ready path across state,
Telegram, channel, browser, List.am, and CBA boundaries; terminal credential
and permission failures; unchanged incompatible state; the typed browser
challenge; loop exclusion; cleanup; and secret-free structured results.
