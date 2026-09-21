# Architecture

## Purpose

The repository, checkout, and container-package identifier is `arm-rental`.
Runtime resources retain the established `rental-apartments` prefix so existing
production paths, systemd units, and persistent storage remain stable.

The application discovers long-term apartment and house rentals from List.am for
a multi-user private Telegram bot and, when configured, a public Telegram
channel. It reads only the site's **Regular Ads** section and ignores **Top
Ads**. `src/target.js` names one List.am category per housing kind — apartments
in category 56 and houses in category 1377 — and `src/property-kind.js` owns the
kind vocabulary those categories produce. The apartment template remains the
installation's stored identity, so adding a category rebinds no existing state.
Private access defaults to `public`, in which any private sender may use the
bot; `owner` restricts controls to `TELEGRAM_OWNER_ID`, and `allowlist` requires
at least one unique non-owner ID in `TELEGRAM_ALLOWED_USER_IDS`. The owner must
not be repeated there, is always authorized,
and remains the exclusive server-alert recipient in every mode. The service has
no private-user admission cap. Channel crawling and publication are independent
of private access and activation.

Every stored listing carries the kind of the category it was crawled from, and
every private filter selects apartments, houses, or both, defaulting to
apartments. The public channel publishes apartments only.

All bot-generated Telegram replies, notification labels, channel hashtags, and
missing-value fallbacks are in Russian. Apartment messages omit the posting
date, although it remains part of the stored record and delivery ordering.
Messages display the source price and currency, while a separately stored
canonical AMD amount drives all price filtering and channel price-band hashtags.

## Production deployment model

The supported production topology is a singleton, long-running process on a
Linux host or in one OCI container. Telegram long polling, the single-writer
SQLite database, and the singleton lease exclude serverless or
automatically scaled deployment. A supervisor restarts the process, forwards
SIGTERM for graceful shutdown, and mounts `.data` on durable local storage.

SQLite is the only backend this release has, so there is no backend selector:
the installed `state.sqlite3` is the state, and it is bound to its target by the
list URL template and channel ID in `application_metadata`. No runtime caller
may create one. An absent database is refused by every caller rather than read
as an empty one, because startup cannot tell a fresh host from a data directory
that lost its state. `state:init` is the single command allowed to create the
empty database a first installation starts from; it refuses to run over an
existing one, so discarding stored state stays an operator decision made through
a restore. Migration from the retired JSON state is no longer possible in either
direction; the only way forward from a pre-cutover host is a snapshot taken
after the cutover. Missing, corrupt, newer-schema, wrong-application-ID, and
target-mismatched databases fail closed without fallback or dual writes.

The versioned schema uses one `STRICT` database that
stores an apartment payload per row, compact ordered crawl metadata, normalized
private and channel delivery decisions, Telegram users and update offset, and
the validated exchange-rate snapshot. Domain repositories expose bounded
classification, re-admission, acknowledgement, user, and snapshot operations;
the runtime routing adapter never stores a serialized former state document.
Apartment discovery and crawl metadata commit together. User removal crosses
Telegram and private-delivery tables in one transaction. Synchronous
`DatabaseSync` transactions contain only local row operations and never span a
HTTP request, Telegram request, rate-limit wait, or retry delay.

Production runs on pinned Node.js and checksum-verified curl-impersonate.
List.am requests use the fixed Safari `safari2601` network profile and private
persisted HTTP cookies. Secrets are supplied outside the artifact; readiness
represents validated Telegram, source, storage, and crawl operation.

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

Readiness exposes its raw reasons separately from `alertReasons`, which applies
the runtime source-challenge grace policy. The host's JSON probe projects only
those bounded code arrays and the status; transport errors and timeouts receive
stable probe codes. Host failure streaks count only alertable results, preserving
raw HTTP readiness while avoiding a second alert path around the grace period.

Container stdout and stderr flow through Docker's journald driver into
persistent, bounded host journal storage. A short-lived monitor derives an
atomic metrics snapshot and alert-transition state from bounded journal
windows, Docker state, filesystems, and systemd timer state. Operators use
`rentalctl` over SSH for logs, current readiness, recalculated metrics, and
timer status; no observability server or inbound port exists. Telegram is the
deduplicated outbound alert route, while the failed systemd unit and retained
journal records remain the delivery fallback. Derived application alerts are
bounded by the running container's start time; retained alert events from an
older container lifecycle remain queryable as logs but cannot become current
alert state. Monitoring, the read-only storage check, and the unattended
deployment poll defer with successful, structured skip records while a
serialized production operation owns the shared lock. This prevents expected
timer overlap and the deployment observation window from becoming
scheduled-job failures. Explicit operator deployment requests retain the
lock-contention status so they cannot report a requested mutation as completed
when it did not run. Lock contention has a dedicated exit status so only an
owned lock is deferrable; lock-file, permission, and command failures remain
failed operations. Alert
transitions carry bounded, non-secret reasons and are recorded in the host
journal before outbound delivery. Scheduled-operation lifecycle records name
the semantic step that completed or failed; the monitor combines that step with
allowlisted structured unit-journal evidence and falls back to systemd result
and exit status. The snapshot and `rentalctl timers` expose this failure reason
for the same complete eight-timer inventory, including image cleanup and the
reboot check, so its
failed result participates in scheduled-job alert evaluation. A deployment poll
that skips a quarantined candidate is a successful run, so the monitor projects
that skip separately and alerts while a rejected digest keeps the pointer from
delivering any release. Host
reconciliation installs `rentalctl` as a stable launcher
that selects the verified current release and falls back to the bootstrap
bundle only before a first release exists; operator diagnostics therefore
advance atomically with the active operations implementation.

### Systemd operations

Systemd owns the singleton application and recurring backup, storage,
image-cleanup, maintenance, monitoring, restore-drill, and reboot-check jobs.
Every short-lived
operation serializes through
`/var/lib/rental-apartments-ops/operations.lock`, emits structured lifecycle
records, and has an effective `TimeoutStartSec` bound. The storage check exits
successfully with `storage-check.skipped` when that lock is occupied and relies
on its next hourly invocation; deployment independently checks capacity before
mutating production. `RuntimeMaxSec` is not used for these `Type=oneshot` units
because systemd ignores that combination.
Stop-the-world wrappers install their restart and readiness cleanup before
stopping the application. Recovery points remain on the separately mounted
backup filesystem, while monthly restore drills use exactly named and labeled
temporary resources with networking, Telegram polling, and delivery disabled.
Those containers also receive the same non-secret, container-local production
paths and source/health settings that Compose normally injects, so recovery
validation cannot accidentally depend on host environment-file omissions.

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
real mountpoint. It accepts either empty storage or the single regular
`list-am-cookies.txt` file left by an interrupted source check.
Any application state, symlinked cookie file, or other
top-level entry fails closed before the application starts.
`rental-deploy.timer` invokes a stable bootstrap launcher for first
installation and the verified current release thereafter. Deployment shares
the global operations lock, snapshots before mutation, verifies startup and a
complete observation window, atomically advances runtime pointers, and
restores the prior snapshot and digest on failure. Failed candidate digests are
quarantined to prevent retry loops.

The host deploys each candidate with the operations bundle of the release it is
already running, so a candidate whose state backend that release cannot deploy
is undeployable the moment the pointer moves and is retried every poll. Release
metadata therefore declares `deployableStateBackends`, the backends this
release's own verifier accepts, and publication classifies the transition
before touching the pointer: a same-backend candidate advances it, a candidate
the running release cannot deploy fails publication, and a cutover the running
bridge can deploy is published with the pointer held. A held cutover advances
only through the separate `promote-production` workflow, which requires an
operator to report the revision the host actually runs and refuses unless that
matches the release `production` names. An unreadable pointer fails closed
rather than reading as a first publication.

No cutover remains to classify: deployment refuses any release, current or
candidate, that does not declare the SQLite backend, and every refusal names
both the contract the candidate declared and the one this release deploys.
Nothing can take a protected rollback point any more.
`ops/unprotect-migration-rollback` survives as the only way to release the one
protection a host may still carry from the cutover, and it deletes the snapshot
that entry named. Until it is run, retention keeps pinning the bridge image
beside a snapshot no release can read. It edits state only and never stops the
application.

Accepted deployments update a retention index containing the current release
and at most two rollback releases before invoking retention-aware image
cleanup. Cleanup validates that index against the immutable current-image
record and running container, preserves every image used by any container, and
protects matching release-metadata images. It inventories only application
images carrying the reviewed OCI title and exact repository metadata tags,
then removes explicit unprotected image IDs; it never invokes Docker's broad
system, image, container, or volume prune operations. Cleanup failure cannot
roll back an already accepted healthy candidate, but emits a structured
deferred record and remains retryable by the independent weekly
`rental-image-cleanup.timer`. The timer uses the shared operations lock, fails
closed on ambiguous state, verifies the protected inventory and application
readiness after deletion, and reports actual free-space recovery separately
from the virtual sizes of candidate images.

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
Apply performs two idempotent host passes because the first may replace the
host helper itself; the second runs the transferred helper version and closes
the self-update boundary within the same reconciliation.
Archive creation disables macOS metadata, and fully managed host directories
discard AppleDouble sidecars. Host operations reconciliation compares a
filename-and-SHA-256 manifest and prunes unexpected managed files, so empty
local directories and platform metadata do not produce false drift.
The operations state directory is traversable only by root and the
`rental-deploy` operator group. The monitor retains root privileges for its
host probes but uses `rental-deploy` as its primary group, so atomically
replaced, mode-`0640` metrics and alert snapshots remain available to the
unprivileged `rentalctl` interface. Root-only mode-`0600` deployment receipts,
image records, and other sensitive operations state do not cross that boundary.
Shared operation setup preserves the directory's group-traversable mode, so a
root timer cannot temporarily revoke operator access between monitor runs.
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
Its runtime-acceptance phase resolves the configured health endpoint inside the
container, correlates one complete set of per-page source-integrity checks with
its successful crawl, and records only expected/observed access mode, aggregate
user counts, delivery counts, and readiness booleans. Semantic validation
prevents mismatched or incomplete observations from becoming passing evidence.
The host reboot check is split into before/after phases. A failed-candidate
exercise must prove snapshot rollback, previous-digest readiness, quarantine,
and a successful quarantine-skip rerun before timer freshness is evaluated.
The evidence collector normalizes systemd's concrete `exit-code` result to the
failed-deployment outcome so an expected nonzero deploy is not mistaken for an
unknown unit state.
Candidate observation returns as soon as the initial readiness gate is
exhausted; it never waits through the normal runtime observation window for a
container that did not become ready.
The checked-in evidence is intentionally pending: deterministic fake-command
tests verify the collection contract but do not claim real VPS observations.

### Health and readiness boundary

`src/health.js` owns a sanitized, in-memory operational projection. It does not
read Telegram or apartment state and never retains errors, upstream bodies,
credentials, owner/channel identifiers, apartment data, or stacks. Startup
preflight results populate configuration, storage, Telegram, List.am,
and CBA component states. Runtime callbacks then record private activation,
channel configuration, crawl outcomes, List.am challenges, Telegram operations,
and exchange-rate refreshes. Readiness includes only the configured access mode
and aggregate persisted, authorized, suspended, and effectively active private
user counts; it never exposes user IDs or the configured allowlist.

The HTTP server binds to `127.0.0.1:8787` by default; configuration rejects
non-loopback health addresses and production Compose publishes no inbound port.
`/live` is deliberately narrow: answering the request proves the process event
loop is responsive. `/ready` and `/health` require a ready preflight and, when
private monitoring is active or a channel exists, a successful crawl less than
ten minutes old with fewer than five consecutive failures. A success resets
both failure and age gates. List.am verification has its own immediately
visible challenge state.

Readiness responses and alert eligibility are separate: a runtime List.am
challenge makes the endpoint non-ready immediately, but both `list_am_challenge`
and the source reason in `readiness_failure` wait for five crawls ending still
challenged. This prevents a host readiness probe from bypassing the retry grace
period and emitting firing/resolved notifications for a seconds-long challenge.
Other readiness reasons retain their existing gates; preflight challenges alert
immediately because runtime recovery has not started.

The current CBA snapshot timestamp is included without its quote contents. A
snapshot older than 48 hours is a warning; no usable snapshot makes readiness
false whenever the active crawl path requires currency conversion. Component
and reason codes let private alerting distinguish Telegram, List.am challenge,
List.am, CBA, storage, and configuration remediation without exposing raw
exceptions.

The Docker and Compose healthcheck calls `src/health-check.js` from a separate
process, which gives `/live` three seconds to answer — inside Compose's
five-second check timeout, so a failing probe always survives long enough to
record its own failure. Docker runs the command on every probe rather than only
on the ones that change the reported status, so the command owns the recovery
decision: it counts consecutive failures in a private directory on the
container's `/tmp` tmpfs, discards any count it cannot parse, and kills the
application only on the third consecutive failure, one probe behind the
`retries: 2` unhealthy report. A single success clears the run, and the tmpfs
gives the count exactly the lifetime of one container. The target is identified
as the Node executable running `src/index.js` as its first non-option argument,
which excludes the PID 1 container init that carries the same script among its
own arguments and that the kernel would refuse to kill from inside its own PID
namespace. Killing the application makes init exit non-zero and the bounded
`on-failure` policy restart it. It never restarts on `/ready` failure because
repeated restarts cannot repair upstream, permission, verification, or
stale-crawl conditions. Probe behavior and private operator access are
documented in [`docs/health-readiness.md`](health-readiness.md).

### Reproducible runtime packaging

Node.js 24.18.0 is the single supported runtime release. `package.json`,
`.nvmrc`, GitHub Actions, and the production container use that exact patch
version. CI installs the full locked dependency graph with `npm ci` before
running linting, formatting, and tests. The production image performs a
separate `npm ci --omit=dev`, so development-only tooling is not deployed.

The Linux AMD64 production build uses the immutable official Node.js 24.18.0
Bookworm Slim digest and curl-impersonate 2.2.2. Installation verifies the
architecture-specific archive checksum. A scratch final stage receives only
Node, curl-impersonate, their shared libraries, CA certificates, licenses,
production dependencies, and application files. Debian identity and the package
inventory for shipped libraries remain available to vulnerability scanners;
shells, package managers, headers, and installation tools stay in the build
stage. OCI labels expose runtime versions and the supported SQLite schema range.

### Continuous integration and artifact provenance

The two branch-protection boundaries are the stable `Required / quality` and
`Required / production artifact` jobs. The first runs the complete repository
checks, a separate 90%-line/80%-branch coverage gate, and a high-severity
production dependency audit on the pinned Node runtime. The second builds the
production image, exercises HTTP cookies, state initialization, backup,
validation, restore, maintenance, health, startup, and shutdown under production
container restrictions, and scans OS packages and application libraries. Local
fixtures supply external responses; no production credentials or List.am access
are needed.
The required job keeps the validated image ephemeral; publication repeats
build, validation, and scanning before publishing to GHCR.

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
the pinned Node and curl-impersonate versions as OCI labels. After required CI succeeds
for a `main` push, the publication workflow rebuilds those same pinned inputs,
repeats label validation and scanning, pushes an immutable GHCR image, and
creates digest-bound release metadata. The immutable registry digest and its
metadata object are the production deployment handoff; the host never rebuilds
from source or downloads a transient Actions artifact.

Release metadata and OCI labels also declare `stateBackend`,
`minimumStateSchema`, and `maximumStateSchema`. `sqlite` with schema `1` or
higher is the only valid declaration; schema `0` named the JSON state files and
is refused. A compatible rollback reads the live authoritative backend/schema
before stopping the service and rejects a target whose declared range does not
include it. Rolling back to a release that predates the SQLite cutover is not
supported: no snapshot this release can read carries the state such a release
would need.

Workflow actions are immutable commit pins. Dependabot proposes npm, base
image, and workflow-action updates as reviewable pull requests and has no
deployment capability. Coverage exception review, branch-protection setup,
artifact contents, and hosted-only validation are documented in
[`docs/continuous-integration.md`](continuous-integration.md).

### Singleton lease and supervision

`DATA_DIRECTORY` identifies the persistent storage root and defaults to
`.data`. The default apartment, delivery, exchange-rate, Telegram, channel, and
HTTP-cookie paths are resolved beneath it. Explicit per-file overrides
remain available, but the process-wide singleton lease always lives directly in
this directory.

Before constructing the HTTP transport or entering Telegram polling,
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
for their awaited state writes to finish, closes the HTTP transport, and only then releases
the lease. Delivery acknowledgements remain the backlog boundary: an
acknowledged item is not re-enqueued after restart, while an interrupted
unacknowledged send retains the documented at-least-once behavior.

### Deployment artifact isolation

The container build context excludes local environment files, the complete
`.data` tree (including HTTP cookies), dependency and coverage
trees, Git metadata, logs, and common development caches. The Dockerfile copies
only the locked package manifests and `src`, and its runtime command does not
load a local environment file. Production configuration therefore enters at
container creation rather than becoming an image layer. npm and Corepack are
build-time tools only and are removed after installing the locked dependencies
and curl-impersonate, leaving no package manager in the production filesystem.

The final process runs as the unprivileged `node` account. Compose drops all
capabilities, enables `no-new-privileges`, makes the root filesystem read-only,
and publishes no ports. `/app/.data` is persistent; `/tmp` and `/sqlite-tmp`
are separate 128 MiB tmpfs mounts with `nosuid,nodev,noexec`. SQLite scratch
uses the private `/sqlite-tmp` mount; its database and WAL remain persistent.
The native image gate checks the installed curl-impersonate identity and
executes its Safari profile against a local HTTP fixture.

### Configuration and secret boundary

`src/config.js` is the fail-fast boundary before the singleton lease and all
long-running loops. It accepts only the `development`, `test`, and `production`
runtime modes and validates numeric and filter ranges while building the
configuration. `src/config-catalog.js` is the code-owned inventory of supported
environment inputs, including their parser constraints, runtime defaults,
production explicitness, sensitivity classification, and documentation-safe
purpose. `getConfig` reads environment values and defaults through that catalog;
catalog inspection therefore does not load `.env`, runtime state, or configured
secret and identifier values. The catalog defines `public`, `owner`, and
`allowlist` access modes plus per-user inbound and per-recipient outbound rate
limits; access configuration does not alter the owner-alert route or create a
private-user admission limit. Production has no implicit storage or executable
choices: `NODE_ENV=production`, `DATA_DIRECTORY`, and
an absolute `CURL_IMPERSONATE_PATH` must all be explicit.

`src/environment-config.js` is the shared strict parser for runtime mode and
the loopback health endpoint. The main configuration, JSON logger, and sibling
health-check process therefore use the same catalog defaults and reject the
same invalid values. Log `applicationVersion` comes only from immutable package
metadata; an undeclared environment override cannot forge release provenance.

Apartment, private-delivery, channel-delivery, exchange-rate, Telegram bot, and
HTTP-cookie paths are normalized and must be distinct children of
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
errors, List.am challenge failures, and HTTP 5xx responses retry with
exponential delay and jitter, bounded
by the validated `EXTERNAL_RETRY_MAX_MS` value (at most five minutes). A
successful operation resets its backoff object. Telegram's server-supplied
`retry_after` is deliberately authoritative for HTTP 429. Terminal credential
or permission errors, invalid configuration, and incompatible state escape to
the supervisor instead of entering runtime retry loops.

List.am requests have no immediate page retries. A failed crawl backs off
before the next attempt. Challenges and HTTP 429 wait at least
`POLL_INTERVAL_MS`; a server `Retry-After` remains authoritative even beyond
the ordinary backoff cap. Successful crawls reset exponential backoff.

Crawl completion and failure events carry a random crawl ID and elapsed
milliseconds. Successful crawl records also expose the page, discovery,
update, notification, filtering, private/channel re-admission, channel
send/edit, and total counters as log-derived metrics. Retry and
channel-operation records are correlated with the same crawl where applicable.
There is no public metrics surface.

`HealthMonitor` emits firing/resolved events for readiness, List.am
challenges, invalid Telegram access, five crawl failures, and stale rates.
A challenge affects readiness immediately; the dedicated alert waits for five
challenged crawls without validated source recovery. A successful integrity
check clears it even when later delivery fails. Preflight challenges alert
immediately because crawling has not begun. Recovery commands emit backup,
restore-test, and low-disk events. Docker sends application records to bounded
persistent journald storage. The short-lived `ops/monitor`
systemd job derives restart-loop and other host-level alerts from bounded
journal, Docker, filesystem, and timer observations, persists an atomic local
snapshot, and sends deduplicated transitions to the Telegram owner. The alert
projection accepts either a scalar stable reason or a bounded array of stable
reason codes, preserving compound readiness failures without admitting
arbitrary journal text. Operators inspect logs, readiness, metrics, and timers
only through `rentalctl` over SSH; its normal log view adds a compact,
allowlisted diagnostic-context field while excluding identifiers, URLs, and
unknown fields. There is no external collector or inbound observability
service. Retention, alert routes, and scheduled operational checks are
specified in [`docs/observability.md`](observability.md).

### Startup preflight boundary

`src/application.js` does not enter Telegram polling or either monitoring loop
until `src/preflight.js` returns `ready`. Storage validation first proves that
the managed tree supports create, write, rename, and removal; the singleton
lease is then acquired and remains held for the rest of preflight and runtime.
Each stored domain — apartments, channel delivery, exchange rates, and the
Telegram bot — is then read once through its repository. Decoding the rows is
what proves they are usable, and the rebuilt state is re-checked against the
target identities its runtime consumer relies on: the List.am URL template,
Telegram owner, channel username, and AMD rate base. Moving that read ahead of
the first delivery is the point, because a bad row would otherwise surface
mid-crawl.

Private delivery is proved without being rebuilt. It is the one domain whose
size is unbounded — a decision per apartment per recipient, retained for
listings List.am dropped long ago — so holding it to check it would make every
start block for as long as the history happened to be. The schema's own
constraints already refuse an unknown status and an unlinked recipient, which
leaves the decision timestamp; SQLite reformats each one through its own date
parser, and a value that does not survive that round trip is exactly the value
the repository refuses when it next reads that recipient. The check is a
count, so no row is materialized.

Rows that cannot be read, rebuild into malformed state, or are judged malformed
in place produce `ERR_STATE_INCOMPATIBLE` naming the domain and the reason, and
are never interpreted as empty state. A domain with no rows yet is an untouched
domain, not a failure.

External checks use Telegram `getMe`, `getChat`, and `getChatMember` to verify
credentials, channel reachability, and the bot's Post Messages and Edit
Messages administrator permissions. Preflight validates the native executable
and asks the exchange-rate service for either a compatible persisted snapshot
or a successful CBA retrieval before parsing the configured List.am target.
Invalid credentials and channel configuration are terminal. A List.am challenge instead produces the distinct
`source_challenge` non-ready state and source-operations remediation.

Each startup preflight attempt emits a structured `Startup preflight completed` result. It
contains component states, a stable failure code, terminal/readiness flags, and
when applicable the affected state domain and the reason its stored rows were
rejected, or the source remediation command. It
never contains the bot token, Telegram API URL, bot identity, or response
payload. Recoverable List.am startup failures report not-ready immediately,
then start Telegram controls while gating crawling behind a preflight retry.
Retries wait at least `POLL_INTERVAL_MS` or a longer valid `Retry-After` and
continue until recovery without consuming supervisor restarts. The lease and
health endpoint remain live; signals cancel the wait immediately. Terminal
configuration, state, executable, and Telegram credential failures exit without
waiting. Process shutdown releases the HTTP transport and lease.
Operational diagnosis and recovery are documented in
[`docs/startup-preflight.md`](startup-preflight.md).

### List.am HTTP transport boundary

`src/list-am-http.js` invokes curl-impersonate directly without a shell, with
profile `safari2601`, HTTPS-only requests, bounded output, and a request timeout.
It waits at least two seconds between requests. Up to five manual redirects
are permitted only within `https://www.list.am`; pagination redirects return
the destination body so existing repeated-page detection remains effective.
The transport never executes JavaScript or fetches page images.

The mode-`0600` cookie jar lives inside `DATA_DIRECTORY`. Each fetch stages it
in a private directory and atomically replaces the persisted jar after a valid
HTTP response. Failed or challenged requests preserve the previous jar.
Concurrent fetches are rejected. Abort and close kill and reap an active
subprocess and remove temporary files. Startup verifies the executable's
impersonation identity; runtime never downloads executable code.

Explicit `cf-mitigated: challenge` headers and recognizable verification
interstitials raise `ERR_LIST_AM_CHALLENGE`. Missing listing content alone is
a source-integrity failure. Other HTTP statuses and `Retry-After` headers
reach the crawler unchanged. `list_am.challenge` reports component `list_am`,
HTTP status, and `challengeSource` (`edge` or `interstitial`), with no URL,
cookies, or raw response body. Preflight reports `source_challenge`.

`npm run source:smoke` acquires the service singleton lease, validates page one
of both categories with the same transport and integrity checks, and reports
aggregate page/listing counts. It runs only with the service stopped and
writes no verification marker. See [source operations](source-operations.md).

Successive successful crawls retain the configured poll interval with its
existing jitter. Failed crawls use backoff; challenge and rate-limit delays
cannot be shortened by user activation.

### Production-focused test boundary

Deployment-boundary coverage combines deterministic integration tests with
post-deploy verification and isolated operational exercises. HTTP transport
tests cover executable identity, cookies, challenge detection, bounded
redirects and output, cancellation, timeout, and child cleanup.

Persistence integration tests use the real filesystem and
child processes to cover restrictive modes, flush and rename rollback, schema
rejection, singleton contention, and intact snapshot restore.

CI also checks the production Docker, Compose, release, configuration, and
documentation contracts without credentials or network access. Hosted gates
build and scan the exact image and exercise its pinned Node and curl-impersonate binaries.
The documentation consistency gate derives maintained Markdown and valid local
path targets from the Git index while also requiring each target to exist in
the worktree. A directory qualifies only when it contains a tracked descendant,
so untracked files cannot enter validation or satisfy repository references.
After a stop-first production deployment, sanitized probes and structured
events must show ready preflight, one successful crawl, the expected delivery
mode, and continued readiness. Restore and rollback exercises use isolated or
snapshot-backed production workflows and collect only schema-allowlisted
evidence. These boundaries are documented in
[`docs/production-testing.md`](production-testing.md).

The offline retained-history benchmark drives real parsing, classification,
delivery acknowledgements, and SQLite through synthetic source responses. It
separates setup, repeated crawls within one process, delivery bursts, and
restart recovery, with coordinator overhead reported separately. Deterministic
counts and ordering checks accompany CPU, RSS, container memory, and storage
measurements; the existing large historical-decision workload remains available.
See [resource baselines](resource-baseline.md) for reproduction and limitations.

### Durable state and recovery boundary

`src/sqlite-database.js` securely creates `state.sqlite3` at mode `0600`, checks
SQLite 3.51.3 or newer, validates application ID `0x41524d52` and schema version
before persistent pragmas, and requires WAL, `synchronous=FULL`, foreign keys,
and a 5-second busy timeout. Ordered schema migrations and their source revision
commit transactionally. The transaction helper rejects asynchronous callbacks,
always rolls back failures, and maps SQLite errors to stable sanitized codes.

Repository transactions emit `state.transaction.completed` or
`state.transaction.failed` with a stable operation, bounded row count,
duration, database/WAL bytes, and schema version. Each transaction brackets
only the rows it writes, so a private delivery acknowledgement reports the cost
of that single row rather than of a surrounding state comparison. Checkpoints
emit matching events. The collector reports p50/p95, failures, busy exhaustion,
rows changed, and current database/WAL size by operation. Values, SQL, item
IDs, chat IDs, and absolute database paths are never logged, and telemetry
failures cannot alter durability.

`src/state.js` remains the atomic JSON primitive only for the defensive
migration sentinels and maintenance history.
Normal SQLite domain mutations do not call it.

`src/recovery.js` owns the persistence recovery boundary. Backup and restore
acquire the singleton lease while the service is stopped. Manifest-v3 backups
validate database identity, schema, target bindings, full integrity, foreign
keys, logical counts, and update offset. Node's SQLite backup API produces a
consistent standalone database; a new connection validates it before hashes
and the snapshot are published atomically. WAL/SHM and disposable HTTP cookies
are not copied. Retention requires seven daily and four weekly recovery
points on independent storage.

Restore accepts manifests v3 and v2, validating each version's declared files
and hashes. Legacy v2 profile artifacts are not installed or required by the
new transport. Manifest-v1 snapshots predate SQLite and remain unsupported.
Managed live entries are staged in a private rollback directory before the
snapshot entries are installed. Failed installation or validation restores the
prior entries. A successful restore still requires a stopped-service source
smoke before normal startup.

`src/recovery-cli.js` exposes backup, snapshot validation, restore, and the
20%-free-space check. Its structured `backup.*`, `restore.*`, and
`storage.low_disk` events are stable alert hooks without introducing the
generalized health and alert policy reserved for later production-readiness
work. Daily automation, the 24-hour RPO, one-hour RTO, quarterly drill, and
operator escalation are documented in
[`docs/state-recovery.md`](state-recovery.md).

`src/maintenance.js` is the weekly state-growth boundary. Under the singleton
lease it runs integrity and foreign-key checks, checkpoints WAL, and reports
database/WAL sizes, logical counts, and managed bytes. A small versioned JSON
history stores the previous aggregate sample for growth reporting. Maintenance
does not delete domain records. Retention and capacity response are documented
in [state maintenance](state-maintenance.md).

`ops/browser-cleanup` serializes with production operations, verifies the active
HTTP-only image and a valid browser-free snapshot, and reports retained backup
usage without altering retention. Both dry-run and apply stop the application
briefly and restart it through the cleanup trap. The Node cleanup command takes
the singleton lease and considers only the fixed `chrome-profile` directory;
ownership, symlink, hardlink, and filesystem checks fail closed before deletion.
SQLite, HTTP cookies, leases, and unrelated paths are outside its deletion scope.

### Release and rollback boundary

`scripts/release-operations.js` is the non-interactive release contract. Before
any Docker mutation it requires two immutable image IDs/digests, a named human
operator, a published and validated recovery point, an explicit private/channel
expectation, and an observation window no shorter than one configured crawl
interval plus five minutes. Only production contracts are accepted. Validation
and dry-run modes perform no Docker call or write; the only mutating operations
are the explicit production deploy and rollback paths.

The runner verifies the fixed one-replica, stop-first Compose shape and existing
named data volume, stops and confirms the old container before creating the new
one, and never replaces or prunes the volume or image. Normal startup remains
the only preflight implementation; application loops cannot begin until it is
ready. Success additionally requires a ready preflight record, Telegram and
expected channel checks, a successful crawl, and final readiness after the full
observation window.

A failed candidate is stopped before the verified snapshot is restored and the
previous artifact is restarted, so source/rate changes made during an
ultimately failed preflight are reverted with the matching state. Rollback either uses
a reviewed backward-compatible schema or restores the snapshot before the old
artifact starts. Production recovery exercises verify this snapshot-backed
stop-first rollback without introducing a second deployment environment. The
independent backup volume is externally provisioned and mounted separately from
application data. Release and rollback procedures, evidence
receipts, and escalation are in
[`docs/release-and-rollback.md`](release-and-rollback.md). The initial launch
sequence and approval boundary are in
[`docs/deployment-from-scratch.md`](deployment-from-scratch.md), and all
operator procedures are indexed in
[`docs/operational-runbooks.md`](operational-runbooks.md).

## Runtime flow

1. `src/index.js` validates private and channel configuration, acquires the
   persistent-directory singleton lease, and runs the startup preflight. Only a
   ready result permits the reusable HTTP page fetcher and Telegram bot
   to enter their long-running loops. At bot startup, the source-controlled
   profile short description, empty-chat description, and complete supported
   command list in the Telegram metadata module are synchronized through the
   Telegram Bot API. Commands are scoped to private chats because group commands
   are ignored. Synchronization is attempted immediately without blocking
   polling or monitoring. A failure is logged and retried hourly until the first
   complete success, after which the metadata loop exits; this auxiliary
   operation never fails bot startup. Each Bot API request also uses the normal
   short transient-failure retry policy before the hourly retry is scheduled.
2. One loop in `src/bot.js` long-polls Telegram. A private `/start` or `/menu`
   from an authorized Telegram user creates or reopens that user's main menu
   without changing an existing monitoring choice; unauthorized senders cannot create
   private state, new users are inactive by default, and group chats are
   ignored. Authorization uses the Telegram sender ID only after a private chat
   has proved that its chat ID is the same value. Persisted users excluded by a
   narrower deployment policy remain unchanged and suspended at runtime; a
   later policy expansion restores their saved activation choice. A reserved
   persisted-user routing hook permits `/delete_my_data` to remain reachable
   for suspended users without allowing unknown users to create state. Russian
   confirmation and cancellation controls precede deletion. Confirmation first
   persists an inactive marker; recovery then cancels the recipient's product
   wait, drains classification/send/acknowledgement work, removes private
   delivery history, removes the bot user without changing the global update
   offset, and clears only that user's token buckets. Startup and every update
   loop resume markers before activation or delivery. Unknown users receive a
   bounded no-data reply, and completed users may register as new inactive
   subscriptions. `/filters` opens the same per-user price, room, and hierarchical
   location controls. Authorized private messages and callbacks share a
   per-sender, continuously refilled in-memory token bucket. Denied `/start` and
   `/menu` replies and excessive-request replies each have a separate
   five-minute response gate; callbacks are acknowledged without editing their
   messages.
   The inbound decision for a sender and Telegram update ID is reused across a
   transient replay, preventing a failed durable write or later reply from
   charging the same update twice.
   These process-local controls expire after inactivity and reset on restart,
   while the service retains no admission capacity for persisted private
   users. The start callback first asks whether to send the matching apartments
   of the last day of List.am activity, at most `INITIAL_DELIVERY_LIMIT` of
   them, or to monitor new listings only; monitoring remains inactive until
   that choice is persisted. The question is asked at every start, not only the
   first, because a pause leaves a backlog the answer has to decide. The final
   start and stop callbacks durably toggle only that user's delivery state
   before refreshing the panel, wake the dormant crawl loop on activation, and
   update readiness state on either transition. Activation also reopens that
   recipient's selection gate, after the answer itself is durable and before
   the loop wakes, so the first crawl of the session classifies the backlog
   against the answer instead of delivering it as news.
   Every refreshed main menu then offers the rejected history a filter edit
   uncovered: the matches inside the same window that the previous filters
   rejected, capped by the same limit. Sending them clears those rejections for
   the next crawl; declining marks them skipped, which delivery never releases,
   so the offer does not return. The offer is derived from stored decisions
   rather than from a remembered question, so an unanswered one survives a
   restart and a satisfied one disappears on its own. `/stop` performs the same per-user
   deactivation as the stop callback and sends the refreshed main menu; it does
   not terminate the bot process. Range values are collected from that user's
   next text message. The entry prompt explains that `/cancel` abandons only
   that user's pending input, preserves the current filter value, and sends the
   current main menu again. During that same pending entry, `нет` and `/clear`
   both remove only the selected price or room restriction, preserve all other
   filters and monitoring state, persist the change, and send the main menu.
3. A crawl loop runs when private monitoring is active or a channel is
   configured. With neither condition, it waits for activation. After apartment
   state is committed, private admission/delivery and `src/channel.js` publication
   run concurrently through independent repository operations. Channel state, formatting,
   and Telegram failures are isolated from private delivery and the update
   loop.
   All users and the public channel share this one crawl. Activation may wake a
   dormant loop only after the configured crawl interval has elapsed since its
   last attempt; repeated controls, filter changes, denied updates, and future
   deletion actions neither move that timestamp nor reset crawl-failure
   backoff. The loop rechecks effective recipients after this cadence wait, so
   a user who stops meanwhile returns it to dormancy without starting or dating
   another crawl attempt.
4. A separate activation-independent loop asks `src/exchange-rates.js` for the
   persisted CBA snapshot. The service refreshes USD, EUR, and RUB together when
   it is at least 24 hours old. A failed refresh keeps the last snapshot active
   and suppresses another attempt for one hour; concurrent refresh requests
   share one in-flight operation.
5. `src/crawler.js` walks the configured List.am categories one after another,
   fetching their pages sequentially through `src/list-am-http.js`, and parsing each page with
   `src/list-am.js`. Every parsed card is tagged with the kind its category
   publishes, and item identity remains global, so a listing that appeared in
   both categories would still be stored once. Because each category is read
   newest-first but the categories are read in turn, their encounters are
   merged back into one newest-first order by posting date, with unreadable
   dates keeping their source position behind the dated cards. Every later
   decision reads that single stream.
6. `src/prices.js` maps source currency symbols to ISO codes and converts every
   newly discovered USD, EUR, or RUB price to whole AMD before apartment state
   is committed. It also migrates version 1 apartment records on their next
   crawl. The rate audit attached to a stored apartment is not rewritten by a
   later daily exchange-rate refresh.
7. Pagination is decided per category from that category's own stored history.
   With no listing of that kind, pages 1 through 10 are parsed. Otherwise the
   newest posting date stored for that kind is the temporal watermark. Cards are
   read newest-first through every card sharing that watermark — every card of
   the same day, for the day-granular dates List.am now displays — and parsing
   stops when an older posting date is reached. Known IDs above the watermark do not
   stop discovery. If stored dates cannot be parsed, the crawl falls back to the
   configured initial page count. Empty pages and repeated page signatures also
   stop that category. A category introduced to a running installation therefore
   performs its own first crawl while established categories continue
   incrementally, and the per-category outcome — initial run, pages parsed,
   watermark, stopping date, exhaustion — is reported in `sources` on both the
   crawl result and the stored crawl metadata.
8. Known cards encountered before or at the stopping watermark are compared
   across source title, original price, location, rooms, area, floor, URL, and
   posting date. A change replaces the source fields, preserves `firstSeenAt`,
   and records `updatedAt`. Every encounter records `lastSeenAt`, including
   when a renewed ad retains an older displayed posting date and otherwise
   unchanged content. An original amount or currency change is normalized with
   the latest persisted rate and replaces its rate audit; otherwise the prior
   canonical price and audit remain unchanged.
9. Newly discovered and updated records are atomically committed before
   Telegram delivery begins. The crawl fans out across authorized active users,
   each with independent `src/filters.js` admission and delivery history.
   `src/private-delivery-scheduler.js` limits private work to eight concurrent
   classification/send operations. Recipients take one message per turn and
   return to the end of the queue; each recipient remains sequential and
   oldest-first. A slow network operation occupies one slot; product-rate and
   Telegram retry waits occupy none. Channel publication remains independent.
   A worker reads and persists only its own recipient's rows:
   its history is read where it is about to be classified, keyed by
   `(recipient_id, item_id)` and restricted to source changes and durable pending IDs,
   and it commits one bounded write per initial
   selection, re-admission batch, classification batch, or acknowledgement.
   The decision table retains every answer the installation has recorded,
   including those naming listings List.am has since dropped, so no crawl path
   reads it whole or loads a recipient's absent-listing decisions into memory.
   Initial selection, migration, and an explicit filter change include older
   stored listings because non-matches are classified even outside the delivery
   window. Each recipient's source cursor and normalized filter fingerprint
   prevent routine unchanged crawls from repeating that scan. Candidate IDs and
   cursor advancement commit together before classification, and outstanding
   sends remain queued across interruption. Menu history offers use the
   stored listing order to scope the same indexed read. Returning listings
   recover their original decisions; no retention cutoff or schema migration
   is involved. Those writes still pass through a serialized,
   failure-latching chain: it orders them against atomic user deletion
   and stops recording once a write has
   failed. Every delivery decision is bounded to the last day of List.am
   activity, measured against the instant the crawl read the source
   (`SOURCE_ACTIVITY_WINDOW_MS` in `src/source-activity.js`): an apartment
   enters the pending set only when List.am posted it or changed it inside that
   window, whatever path admitted it. Posting dates carry no time zone and are
   compared as UTC calendar components, so the day-wide window absorbs the
   source's offset, and cards with an unparsable date fall back to
   `firstSeenAt`.
   With the recipient's selection gate open, the crawl classifies that window's
   undecided matches against the user's stored answer: the newest
   `INITIAL_DELIVERY_LIMIT` are selected, shedding any rejection they carry
   from earlier filters, and the remainder — every match inside the window when
   the user declined — is atomically marked `skipped`. The default limit is 100. Matches outside the window are left undecided, so a later List.am
   update can still deliver them as fresh activity. Non-matches that carry no
   decision yet become `filtered`, keeping the timestamp of their first
   rejection.
   A filtered apartment is durably re-admitted only when it matches the current
   filters and its source `updatedAt` advances beyond its rejection timestamp
   and lies inside the window. A widened filter releases nothing here: the bot
   offers that backlog through the menu and clears the rejections only once the
   user accepts. A previously delivered apartment similarly becomes pending
   again when its source `updatedAt` is later than that user's last successful
   notification, lies inside the window, and it still matches. Skipped history
   is never released. Source order is reversed so selected
   messages are delivered oldest first, then acknowledged one at a time. A
   batch that carries anything the crawl did not discover itself, or that
   follows a selection, is preceded by one Russian heads-up message naming its
   size; a batch of freshly discovered listings is sent without one. Each
   private recipient has a process-local token bucket with a fixed burst of five
   apartment messages and continuous refill at the configured per-minute rate.
   Initial selections, new apartments, and updated-apartment redelivery all use
   this boundary; control replies and public-channel operations do not. A live
   authorization predicate is checked before any recipient classification and,
   after any product-rate wait, immediately before each send, so a narrowed
   policy cannot mutate a suspended user's delivery history during a long batch.
   A
   terminal private-chat delivery error deactivates only the unavailable user;
   it does not terminate other subscriptions or channel publication.
10. `src/channel.js` independently evaluates environment filters. With no
    compatible channel state, it atomically classifies the full apartment order:
    the latest matching `INITIAL_DELIVERY_LIMIT` become `pending`, older matches
    become `skipped_initial`, and non-matches become `filtered`. Pending posts
    are sent oldest first. Later unseen IDs are admitted as `pending` or
    `filtered`. Re-admission applies the same
    `SOURCE_ACTIVITY_WINDOW_MS` bound as private delivery, measured against the
    publisher's own clock. A filtered apartment is durably re-admitted as
    `pending` when its data matches and either its source `updatedAt` advances
    beyond its classification time and lies inside the window
    (`updated_match`), or List.am posted it inside the window
    (`recent_match`). An initially skipped match whose `lastSeenAt` advances
    beyond its channel classification time and lies inside the window is also
    durably re-admitted (`reencountered`); this lets a renewed historical ad
    publish without releasing the untouched backlog. Classification flags never
    expire on their own, so the window is also what stops a changed filter
    fingerprint from publishing everything List.am has touched since
    classification: the fingerprint change is logged, and only the current day
    of source activity is released.
11. Published channel entries retain Telegram message IDs and SHA-256 hashes of
    the complete rendered message. A changed hash within three days of channel
    publication triggers `editMessageText`; once the post is strictly older
    than 72 hours, the publisher sends the updated apartment as a new message
    and manages that new message ID and publication timestamp. An unchanged
    hash, including a posting-date-only source update, makes no request. If
    Telegram reports a missing message, the publisher sends a replacement and
    stores its new ID. Published posts remain managed even when later data would
    not match the current channel filters.

## Filter model

Private filters live per user in Telegram bot state and default to no
restriction other than the housing kind, which defaults to apartments.
Housing-kind selection is a non-empty subset of `src/property-kind.js`, stored
in catalog order; an absent, malformed, or empty selection normalizes back to
apartments rather than widening, so a subscription stored before houses existed
keeps following exactly what it followed. A listing with no stored kind is an
apartment for the same reason. The kind menu refuses to clear the last selected
kind, and resetting filters returns the selection to apartments.
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
Telegram. Its main menu presents both filter settings and monitoring state and
controls, with navigation returning to that broader menu instead of describing
it as filters alone. The price, room, location, and monitoring buttons use
text-only labels; selection-state markers remain confined to the hierarchical
location menus where they convey state. The reset action is explicitly labeled
as applying to filters, since it does not change monitoring state.

Channel filters are parsed once from the environment and never read or mutate
private bot state. They select the apartment kind explicitly rather than
inheriting the default. Price and rooms use the same inclusive exact/open/closed
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

Private crawl fan-out evaluates source freshness once per listing and checks
for a recent source update before matching a rejected listing against a user's
filters. Scheduler operations start across event-loop turns, keeping health and
source I/O serviceable. `PRIVATE_DELIVERY_CONCURRENCY` is a fixed internal setting
of eight, rather than another operator environment variable. It bounds active
classification snapshots and private HTTP attempts, at the cost of lower peak
throughput. See [measurements and reproduction](private-concurrency-benchmark.md).

The scheduler retains one small descriptor per recipient and at most eight
active operations. Classification may still load one recipient's full candidate
history; it never retains every recipient's full pending payload list. Selected
IDs, their order, and captured durable work tokens go into the connection-local
SQLite TEMP table `private_delivery_batch`. The pinned SQLite build uses
file-backed temporary storage with a roughly 2 MiB page cache; overflow uses
`SQLITE_TMPDIR` (the existing bounded 128 MiB production scratch mount). Exhausting
scratch space fails delivery without discarding durable pending work. One payload
is read per send turn. The temporary table is not part of the durable schema or
backups, and is cleared when delivery finishes or fails. A successful send commits
its acknowledgement, captured work-token removal, and temporary-item removal in
one transaction; a newer menu acceptance token is preserved. Restart rebuilds the
temporary selection from existing durable decisions and outstanding work.

Per-recipient product tokens cover announcements and listing messages. A logical
message consumes one token even if Telegram needs retries. Private Telegram calls
make one HTTP attempt per turn; up to four attempts retain the existing backoff,
retry telemetry, and authoritative `retry_after` semantics. One abortable scheduler
timer covers the earliest ready recipient; waiting recipients retain deadlines
and attempt counts, not text or payloads. Other Telegram call sites retain their
normal inline retry behavior.

Each classification or send-and-acknowledge turn holds the existing recipient
deletion barrier. Deletion cancels the recipient's crawl lifetime, wakes a sleeping
scheduler, drains its active turn, and removes its private rows and temporary
batch. Recreating the same chat ID cannot revive an old lifetime. Authorization
is checked before each turn and again immediately before HTTP. Shutdown stops
new turns, aborts active private HTTP attempts and the scheduler timer, waits for
accepted sends to finish their local acknowledgements, and clears temporary
batches. Unsent work stays durable; no rate-limit or retry deadline must elapse
inside the supported 45-second shutdown grace.

Application state is one versioned `state.sqlite3` database on persistent local
storage. `application_metadata` binds its immutable database ID to the List.am
URL template and configured channel. `schema_migrations` plus `PRAGMA
user_version` provide forward-only schema compatibility. Schema version 2 adds
no tables: it backfills the housing kind everything created before houses left
implicit — `apartment` on every stored listing payload, an explicit apartment
selection on every stored filter, and the flat first-page history reseated as
the apartment category's own series.

Schema version 3 adds indexed category/date watermarks and per-listing encounter
sequence, position, and last-seen columns. It migrates the previous order once,
then removes the serialized historical order from crawl metadata. Fixed,
relative, and yearless dates retain their existing interpretation at read time.

Schema version 4 stores private delivery decisions as integer milliseconds and
status codes in a `STRICT, WITHOUT ROWID` table. The composite recipient/item
primary key serves bounded lookups and recipient deletion; the unused status
index is removed. Repository APIs preserve status names and exact canonical ISO
timestamps. Conversion and schema bookkeeping commit transactionally, then a
durable pending marker makes space reclamation with `VACUUM` retryable after an
interruption. Older binaries require their matching pre-deploy snapshot before
rollback. See the [schema contract](sqlite-schema.md) and
[measured size, query, and migration costs](compact-decisions-benchmark.md).

Schema version 5 adds a shared indexed source-change sequence on each listing,
private recipient cursors and filter fingerprints, and a durable private work
table. Schema version 6 adds the channel source cursor, durable channel work,
and an index for channel admission statuses. Existing decisions remain intact;
the first upgraded pass reconciles them before routine incremental selection.
Both consumers share listing decoding and source revisions, while retaining
their different admission rules. Older binaries require their pre-upgrade
snapshot for rollback.

- `apartments` stores a normalized listing JSON payload plus indexed discovery
  and encounter fields per item. Discovery reads bounded category watermarks
  and looks up only IDs on encountered pages. `crawl_state` stores checked time,
  crawl metadata, sequence, total count, and bounded per-kind source-integrity
  history. Changed payloads, encountered ordering/last-seen fields, and crawl
  metadata commit atomically before Telegram work starts. An unchanged crawl
  serializes no retained listing payloads and rebuilds no membership table;
  absent listings remain available for later re-encounters. Ordering projects
  the current encounters first, followed by previously retained encounter order.
  An indexed scan finds only legacy raw-price payloads for their one-time
  canonicalization in the same transaction.
- `private_recipients` and `private_delivery_decisions` store one row per
  recipient/item terminal decision (`notified`, `skipped`, or `filtered`).
  A missing terminal decision remains undecided; `private_delivery_work`
  explicitly retains candidates awaiting classification or delivery. Initial selection and batch classification commit
  before delivery, filtered re-admission deletes its obsolete row before the
  network call and queues the item, and a successful send is followed immediately by one-row
  acknowledgement. Schema 4 encodes these statuses as 0, 1, and 2 and stores
  exact signed epoch milliseconds; absent-listing decisions remain retained.
- `channel_state` and `channel_deliveries` store target/fingerprint admission
  state plus pending, filtered, skipped-initial, and published rows. Published
  rows alone may contain message ID, content hash, publication time, and optional
  update time. Sends, replacements, edits, and reposts update acknowledgement
  fields only after Telegram accepts the operation. `channel_work` retains
  publication and edit candidates, including failures across process restarts.
  Routine selection uses payload changes and encounters of initially skipped
  posts; unchanged published encounters need no rendering or comparison.
  Candidate reads are paged, and the combined pending/new work follows the
  retained source order. Initial classification streams the listing table in
  one transaction; explicit fingerprint changes reconcile rejected history.
- `telegram_state` stores the nonnegative update offset and optional legacy
  recipient binding. `telegram_users` stores activation, initial-send choice,
  normalized filters, pending range input, and deletion marker. Each processed
  update commits its offset with its user mutation before callback
  acknowledgement or a replay-sensitive response. User deletion first commits
  the inactive marker, drains the recipient barrier, then deletes the user and
  private-delivery rows atomically.
- `exchange_rate_state` stores one validated USD/EUR/RUB snapshot as compact
  JSON. A refresh replaces the in-memory snapshot only after the database commit
  succeeds.
- Inbound token buckets, denial-response timestamps, and private delivery rate
  buckets remain process-local. They use a monotonic process clock, evict idle
  entries after 15 minutes, and restart empty.
- `list-am-cookies.txt` stores the private HTTP session and is excluded from snapshots.
- `.maintenance-history.json` stores only the previous successful maintenance
  timestamp and aggregate managed byte count. It is excluded from application
  state thresholds, entry counts, and managed-growth totals.

Routine private and channel delivery no longer load the full retained listing
or channel-decision projection after a crawl commits. They use indexed source
revisions plus their durable work tables. Full projections remain available for
validation/export and explicit private history offers; selection/filter changes
may reconcile history once. See the [delivery benchmark](incremental-delivery-benchmark.md)
for retained-history CPU, memory, and recovery evidence.

The five legacy JSON paths contain only incompatible `sqlite-migrated`
sentinels after cutover. They carry backend, migration, and database identities
without application data so an older image fails closed. Nothing reads them:
configuration secures their permissions and backup carries them so a restore
leaves the data directory as it was found. No importer remains that could write
them, and no snapshot predating the cutover can be restored.

## Parsing model

The parser scopes card selection to `#contentr`, List.am's Regular Ads
container. Candidate selectors intentionally do not require an item-shaped
`href`, so malformed identities remain visible to diagnostics; descendants of
`#tp`, which contains Top Ads, are excluded. The current card class is the
primary selector; the legacy `.dl` anchor shape is used only when no primary
cards exist. A candidate becomes an apartment only when its URL has the exact
List.am item-path boundary. Duplicate canonical IDs and rejected identities are
counted without retaining card HTML or rejected attributes.

`parseRegularApartments` returns the normalized apartments together with
candidate, unique-candidate, parsed, duplicate, and rejected counts. Its
completeness object counts usable normalized title, date, price, location,
rooms, area, and floor values. Crawling, startup preflight, and source
smoke consume this diagnostic result; the legacy array helper is only a
compatibility wrapper. Posting-date validation and crawl ordering share
`src/posting-date.js`, preventing completeness and watermark decisions from
interpreting dates differently. That module reads three displayed forms: a
dated instant carrying its year, a relative day such as `Сегодня`, and a month
and day without a year. Only the first names an instant. The other two resolve
to the last millisecond of the day they name, because a card that states a day
could have been posted at any hour of it, and reading the day as midnight
would retire it from delivery up to a day early. A form without a year takes
the year it was read in, or the year before when that would place it in the
future. One granularity per category matters: were a card printed as
`Сегодня, 00:00` read as an instant while same-day cards printed as a date
were read as a day, the watermark would treat the first as history. The parser initially returns source price
`{ amount, currency }`; `src/prices.js` turns it into the canonical and
original-price fields before persistence. Words such as "monthly" are
discarded. A candidate is an ad-card anchor, never any anchor inside the list
container: the advertising banners and pagination List.am places among the
cards would otherwise each read as a card whose identity cannot be resolved,
and one such rejection stops a crawl. Rooms, area, and floor are matched by
the label each states rather than by position, so a card that omits one — a
house commonly publishes no area or floor — still yields the rest, and both
the interpunct-separated attribute line of the redesigned card and the older
comma-separated one parse. The location is read from the card's own location
element, falling back to a leading attribute segment that names no attribute.
The original posting date is retained as displayed by List.am. Some redesigned
cards carry no date element at all, and a card without a readable date counts
as posted at the moment it was parsed: `formatPostingDate` stamps the crawl's
own timestamp in the fully dated form, the one displayed shape that names an
instant rather than a whole day. The stamp is taken once. Because the date is a
source field, a card that is already stored keeps the date it was stored with,
which is what stops an undated card from reading as changed on every crawl and
being delivered again each pass. A supplied date is also kept out of the date
watermark comparison: it names a minute, printed same-day cards resolve to the
end of their day, and weighing the two together would read a card the crawl has
just seen for the first time as history and abandon the rest of its page.

Every fetched page is passed through one hard source-integrity evaluator before
the crawler considers empty pagination, a repeated page, or the posting-date
watermark. Page observations and typed failures carry the category's housing
kind, so operational surfaces attribute a source change to the category it
happened in. The evaluator applies deterministic reason precedence for a missing
Regular Ads section, an empty first page, parse success below 100%, rejected
identities, and first-page title completeness below 100%; percentage
boundaries use integer multiplication. A missing posting date is not one of
these rules: the crawler supplies a date for such a card rather than rejecting
the page, so date completeness is reported as telemetry only. Later empty
pages remain valid. The
crawler performs this validation while its discoveries are still in memory, so
an invalid page cannot write apartment or delivery state or invoke private or
channel delivery. Startup preflight and source smoke use the same
evaluator and report success only after validation. Source-integrity
errors are recoverable external failures and therefore use bounded crawl
backoff; readiness, alert, metric, and dedicated integrity-event projection is
integrated with the operational surfaces separately.

After every fetched page validates, the crawler publishes only sanitized page
counts to the runtime boundary before persistence and delivery. This emits
`source.integrity.checked`, restores the List.am health component, and resolves
`list_am_source_integrity` even if a later Telegram operation fails. A typed
failure emits `source.integrity.failed`, makes readiness immediately report
`LIST_AM_SOURCE_INTEGRITY`, and fires the same edge-triggered alert path.
The local metrics snapshot groups failures only by stable reason and retains
application firing/resolution cursors so both edges survive between monitor
runs.

The compatible apartment payload schema version 4 carries a bounded
`sourceIntegrity` aggregate keyed by housing kind: per kind, up to five
non-negative first-page parsed counts, plus one optional canonical ISO timestamp
for the latest successful commit. Each category paginates independently, so
mixing their counts would compare unrelated series. Versions 1 and 2 are
migrated in memory with an empty history and version 3's single flat series
becomes the apartment series, preserving listing records and ordering in every
case; malformed aggregates fail closed across crawling, preflight, recovery, and
maintenance. After all fetched pages validate, the crawler appends each
category's current first-page count to its own series, truncates oldest values
beyond five, and persists that history and `lastSuccessfulAt` in the same
transaction as apartment discovery. Failed observations cannot advance it. With
at least three prior successes for that category, a first-page count is rejected
only when it is strictly below half the prior median and at least five below
it. Odd and even medians are
compared with exact doubled-integer arithmetic, and count drop is the final
hard-rule reason.

## Failure handling

- HTTP, List.am challenge, malformed apartment/private state, and private
  Telegram API failures propagate to the monitoring loop and are logged as
  structured JSON.
- CBA responses are accepted only when all three required quotes, their amounts,
  and rates are valid. Refresh failures retain the previous snapshot and retry
  hourly. With no previous snapshot, foreign-price normalization fails before
  apartment state is written.
- Telegram HTTP 429 responses honor `retry_after` and are retried up to three
  times. One product-rate token covers that logical apartment operation;
  Telegram's requested retry delay remains authoritative and is neither capped
  nor shortened by the private-delivery limiter.
- Policy and inbound-rate rejections durably advance the global Telegram update
  offset before any callback acknowledgement or user-facing response. Their
  structured events contain only fixed reasons, access mode, and configured
  rate; sender IDs, chat IDs, message text, and callback data stay inside the
  operational Telegram request path and never become telemetry or health data.
- Deletion telemetry contains only fixed workflow phase and recovery fields.
  It never contains sender IDs, filters, or delivery classifications. A failed
  completion reply cannot restore already deleted data.
- Private and channel classifications are persisted before messages are sent.
  Successful deliveries are acknowledged immediately. Shutdown aborts a
  private product-rate wait without sending or acknowledging its apartment, so
  it remains pending after restart. A restart cannot turn a rejected listing
  into an unexpected backlog.
- Channel sends fail independently and leave entries pending. Failed edits and
  age-based reposts retain their prior acknowledged message metadata for a
  later retry. Per-operation structured logs distinguish send, edit, and repost
  operations and include item ID, channel ID, known message ID, outcome, and
  error without including the bot token.
- Telegram `sendMessage` has no idempotency key. A process exit after Telegram
  accepts a channel post but before local acknowledgement is atomically renamed
  into place carries a small at-least-once duplicate risk.
- Replayed Telegram callbacks that render an already-current menu are treated
  as successful, covering the window between saving filter state and the update
  offset.
- SIGINT and SIGTERM abort Telegram polling and source work, then reap HTTP subprocesses before the application lease is released.
- Startup preflight failures close the HTTP transport and release the singleton lease before
  exiting. State compatibility is checked before external calls, so invalid
  state cannot be overwritten by a later initialization path.

## Testing boundaries

Parser tests verify field normalization and Top Ads exclusion. Crawler
integration tests exercise multi-page initial discovery, the posting-date
watermark (including refreshed IDs and equal-minute listings), known-card
updates, persistence, new and updated private-delivery retry, and
filter-classification behavior. Telegram integration tests use a fake monotonic
clock to cover inbound bursts, fractional refill, inactivity eviction, restart
reset, bounded rejection responses, durable denial offsets, and the invariant
that private actions cannot accelerate the singleton crawl or its failure
backoff. They also verify the source-controlled profile limits and command list,
the exact Telegram Bot API payloads, non-blocking startup synchronization, and
hourly failure retry that stops after the first success.
Filter tests cover optional/open ranges, regions, places, composed criteria, and
AMD comparison of foreign source prices. Exchange-rate tests cover SOAP parsing,
atomic validation, daily refresh, hourly failure backoff, restart reuse, and
conversion audit fields. Telegram tests cover multi-user private activation,
independent interactive filter configuration, access-mode authorization and
suspension, aggregate identifier-free access reporting, Yerevan-first selection,
Russian formatting and fallbacks, rate-limit retries, and channel/private
runtime isolation. Crawler integration tests prove that one crawl maintains
independent delivery classifications and acknowledgements for multiple users
and rechecks live authorization before classification and delivery.
Channel integration tests cover configuration validation and composition,
initial classification/order, partial-send restart recovery, canonical-AMD
hashtags, edits and retries, and missing-message replacement.
Process integration tests start real child processes against one temporary
persistent directory. They prove that a live second process fails before
polling, an unclean exit is recoverable, and SIGTERM flushes delivery state,
reaps HTTP subprocesses, releases the application lease, and permits a
backlog-free restart. Deployment contract tests pin the one-replica,
stop-before-start, bounded-restart, and 45-second grace settings.
Artifact-isolation tests also verify the build-context denylist, immutable
non-root container contract, bounded writable mounts, dropped capabilities,
and no-new-privileges.
Preflight integration tests exercise the complete ready path across state,
Telegram, channel, source transport, List.am, and CBA boundaries; terminal credential
and permission failures; unchanged incompatible state; the typed source
challenge; loop exclusion; cleanup; and secret-free structured results.

### Offline runtime comparison

The comparison branch also narrows Node's full-history private classification:
SQLite stages unclassified listings, filtered listings matching the current
filters, and notified listings with an update. Skipped and unchanged notified
history stays durable without payload decoding per recipient. One crawl caches
the stored listing inventory and at most eight filter match sets, clearing them
with the delivery batches. A separate inventory-presence flag completes initial
selection even when every stored listing already has a terminal decision.
Routine source changes and durable pending work retain their existing path.
See the [fair comparison protocol](runtime-comparison.md) for its gates and
measurement boundary. This work does not deploy or replace production.

`experiments/node-replay/` exercises the existing parser, normalization, filters,
SQLite classification, private scheduler, acknowledgements, and process restart
with deterministic 500/1,000-recipient fixtures. Its exported JSON/HTML contract
and independent result oracle are shared comparison inputs, not production
components. The [baseline protocol](node-replay-baseline.md) separates virtual
behavior checks from wall measurements and defines the cgroup RAM boundary;
local application-container results do not establish whole-machine Pi capacity.

`experiments/go-replay/` consumes the exported fixture contract for the isolated
500/1,000-recipient Go replay. A single SQLite writer stores source revisions and
compact decisions, queries recent catch-up candidates, and supplies pending
payloads to a bounded fair event loop. The shared runner/verifier executes an
unclean exercise exit and a new resume process. See [Go replay choices and
measurements](go-replay-slice.md).

`experiments/rust-replay/` implements the same isolated 500/1,000-recipient replay in
Rust with HTML5 fixture parsing, bundled SQLite, incremental revisions, compact
integer decisions, and a single bounded delivery scheduler. The native runner
and independent full-contract oracle are shared with Go. No production component imports
this prototype. See [Rust replay choices and measurements](rust-replay-slice.md).

Both prototypes preserve SQLite classifications and durable acknowledgements
through process restart, resume only pending work, and verify retained/absent
history and final queue exhaustion. The [recovery protocol and
measurements](native-replay-recovery.md) retain the shared workload and memory
boundary. A separate diagnostic models the external-acceptance/local-acknowledgement
duplicate window; neither prototype claims exactly-once Telegram delivery.
