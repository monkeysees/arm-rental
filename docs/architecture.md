# Architecture

## Purpose

The repository, checkout, and container-package identifier is `arm-rental`.
Runtime resources retain the established `rental-apartments` prefix so existing
production paths, systemd units, and persistent storage remain stable.

The application discovers long-term apartment and house rentals from List.am for
a multi-user private Telegram bot and, when configured, a public Telegram
channel. It reads only the site's **Regular Ads** section and ignores **Top
Ads**. The Rust [source module](../experiments/rust-replay/src/production/source.rs)
names one List.am category per housing kind — apartments in category 56 and
houses in category 1377. The apartment template remains the
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

The live service is Rust. Its production modules are under
`experiments/rust-replay/src/production/`; `rental-app` exposes serving,
maintenance, state, recovery, source smoke and health commands. The former Node
implementation and its recovery image have been retired.

### Rust service

The Rust service has one `rental-app` executable under
`experiments/rust-replay/src/production/`; its `contract` subcommand runs the
fixture protocol. The service uses the production SQLite application ID and
schema 6, including transactional upgrades from supported older schemas. Its
configuration catalog and Russian bot vocabulary preserve the accepted
behavior contract. See [Rust development](rust-development.md) for local
acceptance checks.

Source parsing, filters, crawl commits, Telegram control handling, private
classification, channel publication, health and recovery are separate modules.
The runtime coordinates a polling thread, metadata synchronization, periodic
currency refresh, health serving and a bounded private delivery scheduler.
SQLite transactions contain no network waits. Private rate/retry waits release
worker capacity; channel work runs independently. Confirmed deletion first
persists a tombstone, cancels that recipient's HTTP request, drains its worker
and removes its state atomically. Telegram acceptance before a local
acknowledgement remains ambiguous and can produce a duplicate after restart.

`Dockerfile.native` assembles a non-root, read-only runtime with curl, native
libraries, certificates and licenses. Host operations select native command
arguments and `ops/compose.native.yaml` only for images explicitly labelled
`com.rental-apartments.runtime=rust`. The production publisher selects this
native image from an exact Git revision.

The active module boundaries are:

| Responsibility                                 | Rust modules                                                                                                                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration, preflight and lifecycle         | [config.rs](../experiments/rust-replay/src/production/config.rs), [runtime.rs](../experiments/rust-replay/src/production/runtime.rs), [lease.rs](../experiments/rust-replay/src/production/lease.rs)                 |
| List.am HTTP, parsing and crawl commits        | [transport.rs](../experiments/rust-replay/src/production/transport.rs), [source.rs](../experiments/rust-replay/src/production/source.rs), [crawl.rs](../experiments/rust-replay/src/production/crawl.rs)             |
| Telegram controls and private/channel delivery | [bot.rs](../experiments/rust-replay/src/production/bot.rs), [private.rs](../experiments/rust-replay/src/production/private.rs), [channel.rs](../experiments/rust-replay/src/production/channel.rs)                   |
| SQLite state, backup and maintenance           | [storage.rs](../experiments/rust-replay/src/production/storage.rs), [recovery.rs](../experiments/rust-replay/src/production/recovery.rs), [operations.rs](../experiments/rust-replay/src/production/operations.rs)   |
| Readiness and operator inspection              | [health.rs](../experiments/rust-replay/src/production/health.rs), [health_cli.rs](../experiments/rust-replay/src/production/health_cli.rs), [inspection.rs](../experiments/rust-replay/src/production/inspection.rs) |

The [CLI](../experiments/rust-replay/src/bin/rental-app.rs) dispatches these
modules. `NODE_ENV` remains the public runtime-mode configuration name despite
the Rust implementation.

### Installed service

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
Telegram and private-delivery tables in one transaction. Rust storage
transactions contain only local row operations and never span an
HTTP request, Telegram request, rate-limit wait, or retry delay.

Production runs on pinned Rust 1.94.0 and checksum-verified curl-impersonate.
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

GitHub Actions serializes production publication and may advance the mutable GHCR
`production` tag only after the scanned image, immutable metadata, and
provenance objects exist. The scratch-based schema-3 Rust release image carries
metadata, Compose, canonical source and transport manifests, and the hash-bound
operations archive without a runtime entry point. Schema-2 release images,
including the accepted 2026-09-27 Rust intermediate, carry the package lock instead
of those manifests. Publication supplies an inert create-time command so it can
copy every release input back from a stopped container and compare the
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
recovers the prior digest on failure. A failed candidate restores its matching
predeploy Rust snapshot before the previous Rust image restarts. Failed
candidate digests are quarantined to prevent retry loops.

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

Deployment refuses a release that does not declare the SQLite backend or an
unsupported runtime capability. Normal retention holds the current Rust
release and at most two Rust rollback releases.

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

[health.rs](../experiments/rust-replay/src/production/health.rs) owns a sanitized,
in-memory operational projection. It does not
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

The native image healthcheck calls `rental-app health-check` from a separate
process, which gives `/live` three seconds to answer — inside Compose's
five-second check timeout, so a failing probe always survives long enough to
record its own failure. Docker runs the command on every probe rather than only
on the ones that change the reported status, so the command owns the recovery
decision: it counts consecutive failures in a private directory on the
container's `/tmp` tmpfs, discards any count it cannot parse, and kills the
application only on the third consecutive failure, one probe behind the
`retries: 2` unhealthy report. A single success clears the run, and the tmpfs
gives the count exactly the lifetime of one container. The target is identified
as the `rental-app` executable running `serve` with the same data directory;
PID 1 and the probe process are excluded. Killing the application makes init
exit non-zero and the bounded
`on-failure` policy restart it. It never restarts on `/ready` failure because
repeated restarts cannot repair upstream, permission, verification, or
stale-crawl conditions. Probe behavior and private operator access are
documented in [`docs/health-readiness.md`](health-readiness.md).

### Reproducible runtime packaging

The Linux AMD64 production image builds `rental-app` with pinned Rust 1.94.0,
locked Cargo dependencies, and checksum-verified curl-impersonate 2.2.2. Its
scratch final stage carries the Rust executable, native transport and shared
library closure, CA certificates and licenses, with no Node or package manager.
`scripts/native-release.py` builds schema-3 images from exact Git objects at the
checked-out revision in a restricted context. It records canonical Cargo lock,
source-input, executable, curl, and transport-closure digests in the image
labels and components file. `source.dirty=false` describes those committed build
inputs, not unrelated working-tree files. The producer uses Python 3.11 or
newer, Git, and Docker; metadata and host verification also require Bash, jq,
GNU tar, and GNU coreutils (including `sha256sum`).

The [release runbook](release-and-rollback.md#cargo-provenance-contract)
describes the current Cargo and source-input verifier contract.

### Continuous integration and artifact provenance

The two branch-protection boundaries are the stable `Required / quality` and
`Required / production artifact` jobs. The first runs pinned Cargo formatting,
type checking, linting and tests, Python tests, and the production contract.
The second builds the exact Rust production candidate, exercises the native
image's service, maintenance and 500-recipient contracts under production
container restrictions, and scans OS packages and application libraries. Local
fixtures supply external responses; no production credentials or List.am
access are needed.
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

The native producer stages only declared source files from the exact Git
revision, builds the Rust payload, independently checks its ELF library closure,
and finalizes labels from the observed Cargo, source, binary, and transport
hashes. After required CI succeeds for a `main` push, publication repeats the
build, validation, and scan, pushes an immutable GHCR image, and creates
schema-3 metadata binding its registry digest to source and transport manifests,
Compose, and the exact Git operations archive. The immutable registry digest
and its metadata object are the production deployment handoff; the host never
rebuilds from source or downloads a transient Actions artifact.

Release metadata and OCI labels also declare `stateBackend`,
`minimumStateSchema`, and `maximumStateSchema`. `sqlite` with schema `1` or
higher is the only valid declaration; schema `0` named the JSON state files and
is refused. A compatible rollback reads the live authoritative backend/schema
before stopping the service and rejects a target whose declared range does not
include it. Rolling back to a release that predates the SQLite cutover is not
supported: no snapshot this release can read carries the state such a release
would need.

Workflow actions are immutable commit pins. Dependabot proposes base
image, and workflow-action updates as reviewable pull requests and has no
deployment capability. Coverage exception review, branch-protection setup,
artifact contents, and hosted-only validation are documented in
[`docs/continuous-integration.md`](continuous-integration.md).

### Singleton lease and supervision

[The Rust lease](../experiments/rust-replay/src/production/lease.rs) is owned by
one process for the persistent `DATA_DIRECTORY`. An existing live owner prevents
another service or maintenance writer from starting. Stale socket recovery
checks the owner before removing only the abandoned lease path. Systemd and
Compose stop the previous container before starting another; SIGTERM cancels
polling and source work, drains accepted acknowledgements, closes transport,
and releases the lease within the supervised shutdown grace. A sent Telegram
message whose local acknowledgement did not commit remains an at-least-once
boundary after restart.

### Deployment artifact and configuration boundary

The [native producer](../scripts/native-release.py) stages an allowlist of
committed Git objects into an isolated context: the Rust crate and lockfile,
Dockerfile, pinned transport inputs and production Compose definitions. Local
`.env`, `.data` (including cookies), dependency caches, Git metadata and logs
cannot enter the release image. It records exact Cargo, source, executable,
curl and transport hashes. The final image runs as UID/GID 1000 with a read-only
root filesystem, dropped capabilities, `no-new-privileges`, no published ports,
persistent `/app/.data`, and separate `/tmp` and `/sqlite-tmp` tmpfs mounts.
The host injects its root-owned environment at container creation.

[Configuration](../experiments/rust-replay/src/production/config.rs) validates
runtime mode, access policy, filters, numeric limits, target paths and secrets
before long-running work. `NODE_ENV` is the established public name for the
Rust runtime mode. Production requires explicit absolute `DATA_DIRECTORY` and
`CURL_IMPERSONATE_PATH`; managed state and cookie paths must be distinct regular
children of the data directory without symlink redirection. The bot token is
accepted from environment only, never a CLI argument or image build input.
See [configuration](../README.md#configuration), [token
rotation](token-rotation.md), and [startup preflight](startup-preflight.md).

### Source, Telegram and delivery boundary

[Runtime](../experiments/rust-replay/src/production/runtime.rs) acquires the
lease and runs state, Telegram, curl and List.am preflight before allowing a
crawl. Recoverable source failures leave private controls and the health
endpoint running while preflight retries; incompatible state and terminal
credentials fail closed. A single crawl serves private recipients and the
optional channel. With neither active recipients nor a channel, it waits for
activation without changing the normal crawl interval or failure backoff.

[Transport](../experiments/rust-replay/src/production/transport.rs) invokes the
pinned curl-impersonate executable without a shell, using Safari `safari2601`,
HTTPS List.am pages, bounded output, two-second request spacing and a private
cookie jar. Challenges and HTTP 429 apply source backoff rather than immediate
page retries. [Source parsing](../experiments/rust-replay/src/production/source.rs)
selects only Regular Ads, normalizes cards and posting dates, and checks every
page's integrity before [crawl](../experiments/rust-replay/src/production/crawl.rs)
can commit discoveries. Each housing category has its own page watermark;
categories merge into a single date-ordered stream. A known card above the
watermark cannot hide a newer card following it. USD, EUR and RUB prices are
normalized to AMD using the persisted, atomically refreshed CBA snapshot while
the source amount and currency remain in messages.

[Bot controls](../experiments/rust-replay/src/production/bot.rs) long-poll
Telegram and persist the update offset with user state before replay-sensitive
responses. Only verified private senders can create user state; group commands
are ignored. Public, owner and allowlist admission affect private users but
never change the owner alert route or the independent channel. Users remain
inactive until they choose initial delivery or new listings only. Filter
changes persist immediately; widening a filter offers recent rejected history
on the menu, and user deletion first persists an inactive marker, drains that
recipient's work, then removes its private rows atomically.

[Private delivery](../experiments/rust-replay/src/production/private.rs) and
[channel delivery](../experiments/rust-replay/src/production/channel.rs) read
indexed SQLite source revisions and durable work rows after a crawl commits.
Private recipients take turns one message at a time with at most eight active
classification or send operations. Rate and retry waits release worker
capacity. Initial selections are limited to the latest
`INITIAL_DELIVERY_LIMIT` matches, then sent oldest first. A listing is eligible
for private or channel delivery only when List.am posted or changed it inside
the 24-hour source activity window. Filtered listings re-enter only on eligible
source activity or an explicit accepted private history offer; skipped history
is never released automatically. The channel publishes apartments only,
retains message IDs and content hashes for edit or repost, and is isolated from
private failures. Telegram has no idempotency key for `sendMessage`, so a
successful send followed by a crash before the local acknowledgement can
produce a duplicate after restart.

### SQLite state and recovery boundary

[Storage](../experiments/rust-replay/src/production/storage.rs) owns the single
`state.sqlite3` database. It checks application ID `0x41524d52`, schema and
target binding, uses WAL, full synchronization and foreign keys, and refuses
missing or incompatible state. `state:init` alone creates a first-installation
database; schemas 1 through 5 upgrade transactionally to schema 6. Listing
payloads, per-category crawl metadata, private and channel decisions and work,
Telegram users and update offset, and exchange rates live in this database.
Discovery and crawl metadata commit before delivery. Private send and channel
publish acknowledgements commit only after Telegram accepts the operation;
network waits never occur inside a SQLite transaction. The
[schema contract](sqlite-schema.md) describes tables, migrations and indexes.

[Recovery](../experiments/rust-replay/src/production/recovery.rs) creates and
validates consistent SQLite snapshots on independent storage. Snapshot
validation checks file hashes, database identity, schema, target binding,
integrity, foreign keys, logical counts and update offset. Restore requires
the singleton lease with the service stopped and stages the old live entries
for rollback if installation fails. It cannot restore pre-SQLite manifest-v1
state. The host creates a fresh validated snapshot before each replacement
deployment and
retains daily and weekly recovery points. The isolated
`rental-restore-drill.service` restores a copy with networking and Telegram
delivery disabled; it leaves the live service, data directory and container
untouched. See [state recovery](state-recovery.md) and
[release and rollback](release-and-rollback.md).

### Health, failure and test boundary

[Health](../experiments/rust-replay/src/production/health.rs) projects only
sanitized component states and aggregate counts. `/live` proves the loop can
answer; `/ready` requires successful preflight and a recent successful crawl
when monitoring is active. Source challenges make readiness false immediately,
while runtime challenge alerts wait for five unresolved crawls. The
[health CLI](../experiments/rust-replay/src/production/health_cli.rs) probes
the private endpoint from the container. Logs carry stable, redacted event
names and bounded counts; the host monitor combines those with Docker, systemd,
storage and timer state. Operators inspect them through `rentalctl` over SSH.
See [health and readiness](health-readiness.md),
[observability](observability.md), and [runtime incidents](runtime-incidents.md).

The [Rust development guide](rust-development.md) gives the current local
checks. Required CI builds and tests the production image with synthetic
Telegram, List.am and CBA peers, a 500-recipient capacity workload, lifecycle
and recovery checks, provenance verification and a blocking vulnerability
scan. The [Rust development guide](rust-development.md) describes the active
acceptance checks.
