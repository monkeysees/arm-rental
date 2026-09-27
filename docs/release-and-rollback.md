# Unattended release and rollback

Production releases are published by GitHub Actions and discovered by the VPS.
No inbound deploy connection or routine operator command is involved. The
mutable `production` tag is only a discovery pointer: the host resolves it once
and persists only an immutable
`ghcr.io/owner/repository@sha256:<64 lowercase hex>` reference.

`rental-deploy.timer` runs five minutes after boot and every five minutes. Its
oneshot service invokes the stable `/usr/local/sbin/rental-deploy` launcher as
`systemd:rental-deploy`. Before the first release, that launcher uses the
bootstrap-installed bundle at
`/usr/local/lib/rental-apartments-bootstrap/ops`; afterward it delegates to the
verified current release. Both paths share
`/var/lib/rental-apartments-ops/operations.lock` with backup, maintenance,
restore drill, and token rotation. An overlapping unattended poll records a
successful `deployment.skipped` deferral and retries on its next timer run.
Explicit operator deployment requests retain temporary-failure status `75` so
they cannot falsely report that a requested mutation completed.

## Publication prerequisites and gates

`publish-production.yml` runs only after a successful `Required CI` push to
`main`. It checks out that workflow's exact commit and selects one image with
`PRODUCTION_RUNTIME`. The setting is `rust` for the accepted production release;
the updated Node bridge was published first and verified on the host before
the initial Rust promotion. Each path verifies the image's runtime,
source and provenance identities, packaged service and HTTP closure, then runs
the blocking Trivy scan before pushing.
GitHub Actions concurrency serializes publication and does not cancel an
in-progress publisher.

The publisher pushes the scanned image, captures its registry digest, and
publishes a metadata image tagged `metadata-<full-git-revision>`. Its
`/release-metadata.json` binds:

- the full source revision and exact image reference/digest;
- the supported state backend and inclusive schema range;
- the state backends this release's own deployer accepts
  (`deployableStateBackends`);
- the tested live-state rollback capability
  (`cutoverRollbackContract: preserve-live-state-v1`);
- the `package-lock.json` digest for historical schema-2 releases;
- the Rust toolchain, Cargo lock, source-input, executable, and transport
  digests for schema-3 Rust releases;
- the production Compose digest; and
- a deterministic archive digest for `ops/` and `infra/systemd/`.

Before the first Rust registry push, the publisher reads and binds the current
`production` image to its metadata and checks that release's runtime deployment
and live-state rollback contracts. The older Node bridge does not carry the
rollback marker and cannot authorize Rust publication. A Rust candidate
fails closed when the pointer cannot be verified. The publisher copies the new
metadata back out and compares it byte-for-byte before considering `production`.
A runtime change holds that pointer for operator promotion; a failed quality
gate, provenance check, scan, candidate push, or metadata push cannot change
host discovery.

### Cargo provenance transition (#49)

The intermediate Rust release publishes schema-2 metadata with
`package-lock.json` and its image label, so the deployed predecessor can verify
it. Its metadata advertises
`deployableProvenanceContracts: ["legacy-package-lock-v2", "cargo-source-v3"]`
only when the archived host verifier matches the source being published. The
host verifier accepts both contracts after that intermediate release is
deployed. The schema-3 publisher requires the committed, sanitized
`docs/evidence/issue49-stage1-receipt.json` operator acceptance record before
its first registry push. That record binds the stage-1 source revision, exact
image digest, successful deployment receipt name/hash/time, validated snapshot,
and observed live host image. The publisher compares it with the pulled current
image and its fully verified metadata and archived verifier capability. It also
checks that the candidate covers the current SQLite schema range before the
first push. This
record is an operator attestation of direct host evidence, not a cryptographic
remote attestation. A published pointer or marker alone does not prove that the
host has deployed the verifier.

Schema-3 metadata is the separate `cargo-source-v1` Rust contract. It requires
an exact Rust runtime, clean source, source revision, immutable image digest,
Cargo lock, Rust executable, curl executable, transport closure, SQLite schema
range, production Compose, and operations archive. The image labels and
`components.json` must agree with the metadata, and the host hashes the actual
files extracted from the image. Schema 3 has no package-lock field, artifact,
or label; unknown and mixed provenance claims fail. Historical schema-2 Node
releases may omit the runtime label and retain their package-lock verification.

The schema-3 metadata bundle contains `source-inputs.json` and
`transport-files.json`. Each is one newline-terminated `jq --compact-output
--sort-keys` JSON object with `files`, `kind`, and `schemaVersion: 1`; `files`
is a sorted, unique list of safe relative `path` and lowercase SHA-256 pairs.
The Python producer stages only exact committed Git objects into its Docker
context and requires the requested revision to equal checked-out HEAD. The
source manifest covers `Dockerfile.native`, Cargo.toml/lock, every regular
file copied from `experiments/rust-replay/src/` (including JSON and SQL), the
pinned curl installer/version, native assembly/license scripts, base Compose,
and `ops/compose.native.yaml`. The image carries a source tar with exactly
those regular-file members; the host checks every member byte without
extracting paths onto the host. The publisher must compare this path set and
its bytes against the exact Git revision and Docker build inputs. Operations
source and the native Compose override are also bound by the separately
hashed `operations.tar`, which the producer compares byte-for-byte with a Git
archive for the same revision; base Compose is separately hashed in metadata.

The transport manifest covers curl, CA certificates, nsswitch, and every
library in the image's `libraries.txt`, including its `/lib64/ld-linux-*`
loader. The host requires the declared path set and hashes each extracted
file. The producer independently resolves both executables' ELF dependencies
inside the payload, then re-extracts every declared file from the final image
and compares the OCI labels, components file, and manifests before scan and
push. The host's manifest check does not rediscover an undeclared library. The
host also re-verifies a cached release directory, including its artifact set
and executable modes, before using it.

The initial schema-2-to-schema-3 release stays behind the `production` pointer
even though both images run Rust/SQLite. Promotion requires an operator to
report the deployed intermediate revision and immutable digest; the workflow
re-verifies both exact images and metadata bundles before moving the pointer.
Later schema-3-to-schema-3 publication verifies the exact current release and
can advance normally. A missing, mismatched, or unknown contract fails before
pointer mutation.

An unattended schema-3-to-schema-2 provenance downgrade is refused before
the service stops. A retained historical schema-2 Node release remains an
explicit, snapshot-backed operator rollback target. For that path,
`scripts/release-operations.js rollback --state-strategy restore` requires
`--target-release /var/lib/rental-apartments/releases/<revision>-<digest-prefix>`;
it retrieves the published bundle, verifies the image and installed release,
then validates and restores the selected snapshot with that Node image's own
commands and Compose file before starting Node. The release must be under the
canonical `/var/lib/rental-apartments/releases` directory owned by the
`rental-deploy` account, directly under root-owned trusted ancestors. The
target must be an immediate child of that directory. This is the host-bootstrap
ownership contract. The retained release and its files must be root-owned, with no group- or
world-writable path. The snapshot must predate any
schema the old image cannot read, and restoring it can replay work accepted
after the snapshot.

### First upgrade to the HTTP transport

The preceding release's deployer requires `SYS_ADMIN` in candidate Compose.
The HTTP release drops all capabilities and enables `no-new-privileges`, so
that older deployer rejects it before stopping the running application. The
normal timer has already verified and staged the release bundle at this point;
it cannot complete this one transition automatically.

After publication, let the normal deployer stage the candidate. Confirm its
journal failed at Compose validation, with the application still ready, and
obtain the exact revision and digest from the successful publication record.
Run the new staged deployer once, using those values (replace both examples):

```sh
revision=FULL_40_CHARACTER_SOURCE_REVISION
digest=FULL_64_CHARACTER_IMAGE_DIGEST_WITHOUT_SHA256_PREFIX
[[ "$revision" =~ ^[0-9a-f]{40}$ && "$digest" =~ ^[0-9a-f]{64}$ ]]
release="/var/lib/rental-apartments/releases/${revision}-${digest:0:16}"
sudo jq --exit-status --arg revision "$revision" --arg digest "sha256:$digest" \
  '.sourceRevision == $revision and .imageDigest == $digest' \
  "$release/release-metadata.json"
sudo "$release/ops/deploy" --actor operator:http-transport-upgrade
```

Use only the root-owned bundle staged and verified by the regular deployer;
do not invoke an arbitrary downloaded script or repoint `current` manually.
The new deployer repeats candidate validation, takes the normal snapshot, and
performs the existing stop-first deployment and rollback checks. Once it
succeeds, the stable launcher uses the new current release and subsequent
updates are unattended again. If it fails, retain the receipt and follow the
rollback procedure below.

### State backend transitions

The host deploys each candidate using the operations bundle of the release it
is already running, so a candidate that release cannot deploy is undeployable
the moment the pointer moves, and the host retries it every poll. Before
advancing the pointer the publisher reads the metadata of the release
`production` currently names and compares state backends:

- same backend: the pointer advances as usual;
- backend change, and the current release's `deployableStateBackends` does not
  include the candidate's: publication fails. The bridge release that performs
  the cutover has to be published first;
- backend change the current release can deploy: the image and metadata are
  published but the pointer is held.

Every release in this tree declares `sqlite`, so today the first case is the
only one reached. The machinery stays because it is what would gate any future
backend or storage change; it is not a path back to JSON, which no release can
read.

### Runtime transition to Rust

The older Node bridge can start Rust, but its rollback path restores the
predeploy snapshot after a rejected candidate. The updated Node bridge was
published first with `PRODUCTION_RUNTIME: node` and advanced the discovery
pointer through the same-runtime path. It declares both deployable runtimes and
the `preserve-live-state-v1` rollback contract. With the publisher now set to
`rust`, publication requires that marker on the current pointer and holds the
Rust candidate for explicit promotion. Confirm the host has deployed the
updated bridge before that promotion; publication alone is not host acceptance.

On 2026-09-26, the host accepted Node bridge
`db93d9b9633c92296c75cf4226b2d4e9ad8496a5` at image digest
`sha256:d43d07fea3e961d7ec6d966e0ca1e28b387925314b57a8eccc7553a289163a82`.
Its successful receipt completed at `22:35:06Z`, with validated snapshot
`daily/2026-09-26T22-28-50-466Z`. The normal deploy launcher then succeeded and
the unattended timer resumed. This records the prerequisite Node bridge
acceptance; the later Rust cutover has its own live evidence below.

For a host still running the older deployer, pause its unattended timer until
the first updated bridge rollout is accepted. The earlier #47 update failed
when discovery displaced the retained image reference. While the application
stays live, stage the
immutable Node release from its metadata-bound digest using the existing
`deployment_extract_release_bundle`, `deployment_verify_release`,
`deployment_validate_operations_archive`, and `deployment_fetch_release`
checks. Refuse any pre-existing release directory that has not been verified
against those inputs. Then invoke that staged release's `ops/deploy` once with
an operator actor; verify its receipt, image digest, service readiness, backup
mount and operations lock before re-enabling the timer. Do not unpause the old
launcher and let it retry the transition. Check the one-time command against
the published revision and digest before execution.

Once the bridge is current, a Rust candidate can be published, but the
publisher holds the discovery pointer for this runtime change even though both
images use SQLite. Confirm the deployed bridge revision with `rentalctl status`
and use `promote-production.yml` with that exact revision to advance the
pointer. A Node image retained for rollback still requires the Node command
contract in its own historical release bundle; removing Node from the new Rust
image does not remove that rollback path.

A held cutover is deliberate. Publishing the bridge is not the same as the host
having deployed it, and only the host knows which. Confirm the deployed
revision on the host, then run `promote-production.yml` with the revision to
promote and the deployed bridge revision. It refuses unless the reported
revision matches the release `production` names, so a host that has not yet
converged cannot be promoted past.

Expected publication evidence is the successful
`Publish production / Publish / scanned production digest` check, the immutable
candidate digest, and its metadata object. Retain the GitHub run URL; never put
tokens or rendered environment files in release evidence.

Before requesting the pointer move, run the
[disposable Node-to-Rust cutover drill](../experiments/native-cutover/README.md)
with the accepted image IDs and retain its sanitized `report.json`. It checks a
Node-created predeploy snapshot, failed native startup and exact-row Node
rollback, then native readiness, crawl, new delivery and prior acknowledgement
continuity on the same SQLite mount. It restarts the retained Node service after
each restore and checks readiness, crawl, and offset continuity through local
HTTPS peers. It does not replace the host bridge,
backup mount, operations lock, or live delivery checks below.

The disposable drill exposes a rollback boundary: Node preserved a listing
acknowledged by Rust when restarted against compatible live schema-6 state,
but resent it after restoring the older predeploy snapshot. On a failed Rust
candidate with a retained Node predecessor, the updated unattended deployer
stops and confirms the candidate is stopped, inspects the live database
read-only, checks its schema against the prior release, and restarts Node on
that live state. If inspection, compatibility, or restart fails, it leaves the
service stopped and alerts for operator recovery. The validated predeploy
snapshot and retained Node image remain available for explicit restore, which
can replay work accepted after the snapshot. Other runtime transitions retain
snapshot rollback.

### First live Rust attempt and recovery (2026-09-27)

The operator explicitly promoted source revision
`a3b20894ca82785bb80110373a6aef31b427c5f1` at image digest
`sha256:d7a453d84daa3935cdd4825f6684a25bc98f7506c85d79ba00668509426b223d`.
The host validated predeploy snapshot `daily/2026-09-27T17-45-07-234Z` and
observed Rust readiness, source integrity and successful crawls through the
six-minute deployment window. Final `systemctl start rental-apartments.service`
then failed because the installed unit still used the old direct Compose
invocation and its Node-only `user: node` setting. The candidate was rejected;
this attempt was **not** a Rust production acceptance.

Guarded `compatible-live` rollback completed at `17:51:45Z` and restored the
healthy Node bridge at digest
`sha256:d43d07fea3e961d7ec6d966e0ca1e28b387925314b57a8eccc7553a289163a82`.
The failed receipt is `20260927T175145Z-failed-d7a453d84daa3935.json`. The
installed SQLite identity, schema, source binding, update offset `930892921`,
and the fixed 39,358-row acknowledged-delivery cohort remained unchanged. The
rollback retained live state instead of restoring the older snapshot, so it did
not discard acknowledgements made after that snapshot. No new live listings
were observed during the attempted rollout; this is state-continuity evidence,
not a live-message delivery result.

Before retry, the operator backed up the old unit to
`/var/lib/rental-apartments-ops/unit-backups/rental-apartments.service.pre-rust-20260927T175638Z`
and installed the approved bridge unit, whose full-file SHA-256 is
`b9744b143cd10bb102dd5c79e2bad5af6ff193af43a1c30017be9861f5c61d34`.
The loaded start, reload and stop commands use the stable release launcher,
there are no drop-ins, and the Node service remained healthy after daemon
reload. Verify this effective unit and the backup mount before a Rust candidate
can stop the previous service; repository unit files alone do not prove the
host has the compatible unit installed.
Follow-up source commit `0b4d68221b7bcde30fb378fc6998fdcab9f497f2`
adds a pre-stop check for this effective unit. It was not part of the promoted
`a3b20894ca82785bb80110373a6aef31b427c5f1` image or its operations bundle;
the operator verified the installed unit separately before retry.

### Accepted Rust deployment and continuity (2026-09-27)

The normal deployment timer retried the same immutable Rust candidate after
the approved unit repair. Receipt
`20260927T180637Z-success-d7a453d84daa3935.json` completed at `18:06:37Z`
for source `a3b20894ca82785bb80110373a6aef31b427c5f1` and image
`ghcr.io/monkeysees/arm-rental@sha256:d7a453d84daa3935cdd4825f6684a25bc98f7506c85d79ba00668509426b223d`.
The host validated snapshot `daily/2026-09-27T18-00-19-960Z` on its independent
backup volume before starting Rust on the existing SQLite volume. The receipt
reports success with rollback not attempted; the running container and current
image pointer match the immutable digest. The loaded runtime-aware service unit
succeeded, readiness is healthy with no firing alerts, and the 18:10 deployment
poll was a successful no-op. The backup mount and timers remain healthy.

Independent read-only host review confirmed the same database identity
`46960c40-1fef-4de1-aaa0-745699ed87e0`, schema 6, source/channel binding
and Telegram offset `930892921`. All 716,231 decision rows in the retry
snapshot remain unchanged in live Rust state. Two acknowledgements from the
first-attempt cohort had their `decidedAt` refreshed by the recovered Node
service at `17:59:38Z`, before the retry snapshot; they were not lost or
replayed. Later Rust crawls with matching source-integrity records naturally
sent six and one private notifications, respectively, and committed seven new
status-0 acknowledgements. The previous Node digest and matching recovery
snapshot remain retained for rollback.

This acceptance proves the observed host readiness, crawl, durable delivery
continuity and supported guarded recovery from the failed first attempt. The
recipients' Telegram inboxes were not inspected externally, and no deliberate
rollback of the healthy Rust service was performed. The current Rust release
still carries package-lock provenance for the host verifier; Cargo-only release
provenance and Node retirement are separate work in #49 and #50.

## Host prerequisites and safe checks

The host requires Docker Engine, Compose v2, Git, jq, a mounted independent
backup filesystem, and the installed systemd units. These exact runtime paths
are part of the release contract:

```text
/etc/rental-apartments/env
/opt/rental-apartments/current/compose.production.yaml
/var/lib/rental-apartments-ops/current-image.env
/var/lib/rental-apartments-ops/operations.lock
/var/lib/rental-apartments/releases/
```

`/etc/rental-apartments/env` is root-owned mode `0600` and includes the
application settings plus:

```dotenv
GHCR_IMAGE_REPOSITORY=ghcr.io/owner/repository
GHCR_USERNAME=read-only-machine-user
GHCR_READ_TOKEN=read-only-package-token
```

The deploy command does not source or print this file. It passes the token only
to `docker login --password-stdin` using an ephemeral `DOCKER_CONFIG`, which
the exit trap removes.

Use these safe checks without rendering secrets:

```sh
sudo stat --format='mode=%a owner=%U:%G' /etc/rental-apartments/env
sudo findmnt --mountpoint /mnt/rental-apartments-backups
sudo systemctl status rental-deploy.timer rental-deploy.service
sudo systemctl show rental-apartments.service \
  --property=FragmentPath,DropInPaths,ExecStart,ExecReload,ExecStop
sudo rentalctl timers
sudo rentalctl status
sudo jq '{candidateImage,previousImage,sourceRevision,snapshot,rollback}' \
  /var/lib/rental-apartments-ops/deployments/*.json
```

Expected output reports mode `600`, the mounted backup filesystem, an active
timer, an immutable current image, and sanitized receipts. Stop and escalate
if the secret file is a symlink, the mount is absent, the current image file
contains a tag, multiple containers exist, or the timer repeatedly fails.
Before a runtime change, require the loaded application unit's start, reload
and stop commands to call `/opt/rental-apartments/current/ops/service`, with no
unreviewed drop-ins. A stale direct Compose unit can pass repository and release
checks but fail after the candidate's observation window.

## Deployment sequence

For a new digest, `ops/deploy`:

1. checks the secret boundary, mount, free space, Docker daemon, backup volume,
   and existing application service without printing configuration values;
2. authenticates with the read-only credential, pulls `production`, resolves
   it to a digest, and exits successfully on a current-digest no-op;
3. reads the source revision from the image label, fetches exactly that detached
   commit into a new release directory, extracts its metadata image, and
   verifies image, package lock, Compose, and operational-bundle digests;
4. renders Compose and proves one fixed production container, stop-first
   updates, no ports, and unchanged data and backup mounts;
5. verifies the state contract from both releases' metadata — both must declare
   `sqlite`, and the candidate must span the schema range the current release
   serves — then stops the old bot and creates and validates the ordinary
   pre-deploy snapshot;
6. starts the candidate against the unchanged named volumes. No deployment
   converts state: SQLite is the only backend, and forward-only schema
   migrations run inside the candidate when it first opens the database;
7. requires healthy startup, ready Telegram and optional channel preflight, one
   `crawl.succeeded`, and final readiness after one poll interval plus five
   minutes;
8. atomically replaces `/opt/rental-apartments/current` and
   `current-image.env`, starts the systemd-owned application service, and writes
   an exclusive sanitized receipt;
9. updates the current-plus-two rollback index and attempts explicit-ID image
   cleanup without turning cleanup failure into rollback of an already healthy
   accepted release.

The retention index keeps the current and two prior evidence records. Release
directories, digest-pinned Docker images, receipts, and associated deployment
snapshots must not be manually removed while referenced by that index.
A host may still carry one `protectedReleases` entry left from the SQLite
cutover, pinning a pre-SQLite snapshot, the bridge application image, and its
release-metadata image against ordinary current-plus-two rotation. Nothing can
create another. That snapshot cannot be read by this release; see
[releasing the stranded rollback point](state-recovery.md#releasing-the-stranded-rollback-point).

After a candidate is accepted, deployment performs retention-aware image
cleanup. A weekly timer retries the same idempotent operation as a safety net:

```sh
sudo /opt/rental-apartments/current/ops/image-cleanup --dry-run
sudo systemctl start rental-image-cleanup.service
sudo journalctl -u rental-image-cleanup.service --since -30m
```

The dry run lists only managed application and release-metadata image IDs that
are absent from the retention index and unused by every container. Never
substitute `docker system prune` or `docker image prune -a`; those commands do
not understand rollback retention and may remove the two protected prior
images. An invalid index, current-image mismatch, missing protected image, or
running-container mismatch fails before deletion.

The first install is intentionally separate. It requires no current symlink or
image record and proves the named data volume is empty. It starts and verifies
the candidate without claiming a pre-deploy snapshot. Failure stops the
candidate, records `firstInstall: true` with no rollback attempt, quarantines
the digest, and leaves the service failed.

## Automatic rollback and quarantine

A `state-strategy=compatible` rollback is accepted only when the rollback
image's metadata backend matches live state and its inclusive schema range
contains the live schema. This check completes before the live container is
stopped. An out-of-range schema fails with `ERR_RELEASE_STATE_INCOMPATIBLE`;
use a matching post-cutover snapshot and the `restore` strategy for a reviewed
break-glass rollback. Rolling back to a release that predates the SQLite
cutover is not supported at all: the snapshot it would need cannot be read.

Before a SQLite schema first advances beyond an older image's declared range,
retain the validated pre-deploy snapshot as the rollback point. An older image
must start only after that matching snapshot is restored; it must never read or
rewrite an unsupported database. Candidate acceptance must show a
`source.integrity.checked` record and `crawl.succeeded` record with the same
crawl ID.

The retained Node bridge and deployed Rust application accept SQLite schemas 1–6
and write schema 6. The upgrade to
schema 4 replaces private delivery rows transactionally, then reclaims free
pages with a retryable one-time VACUUM before startup continues. Allow temporary
space for replacement pages, WAL, and the VACUUM copy, and preserve the stopped
service's pre-deploy snapshot on independent storage. Images whose supported
schema range excludes 6 cannot use `state-strategy=compatible` against this live state: use the existing
snapshot restore rollback path. See the [schema contract](sqlite-schema.md)
for migration and interruption behavior.

The restored deployment configuration remains the access-policy authority;
never infer an access mode from snapshot users or resume users that the
restored mode does not authorize. Restore private-delivery acknowledgements
with bot state so rollback cannot resend accepted apartments. A snapshot that
contains `deletionPendingAt` must resume that deletion; rolling back across the
deletion boundary is allowed only with the matching, internally consistent
pre-deletion snapshot of both bot and private-delivery state.

On a failed Rust candidate with a retained Node predecessor, unattended
recovery stops and confirms the candidate is stopped, inspects live SQLite
state read-only, checks its schema against the prior release, then starts the
previous immutable Node image on that live state and requires readiness. It
does not automatically restore the older pre-deploy snapshot, which could
erase Rust acknowledgements and cause repeated delivery. A failed deployment
receipt records `rollback.stateStrategy` as `compatible-live` for this path or
`snapshot-restore` for other transitions. A successful recovery emits
`deployment.rollback.completed`, records `rollback.result: completed`, opens a
deployment alert, and leaves `rental-deploy.service` failed so the incident is
visible.

This guarded live-state path covers Rust launch and observation failures. If
the candidate cannot be confirmed stopped, live state is incompatible or
corrupt, or the previous image cannot become ready, recovery leaves the service
stopped and alerts for operator action. For other runtime transitions, the
previous image restores the verified pre-deploy snapshot before restart. The
validated snapshot and retained image remain available for an explicit
operator restore after a failed Rust cutover; that restore can replay work
accepted after the snapshot. Deployment never converts state during a code
release.

If guarded recovery, snapshot restore, or previous-image readiness fails, the command records
`deployment.rollback.failed`, preserves its evidence, and leaves the unit
failed. It does not repeatedly restart or mutate state. Recover manually using
the retained snapshot and previous digest, then escalate with the sanitized
receipt and:

```sh
sudo journalctl --unit rental-deploy.service --since -2h
sudo rentalctl logs --since 2h --severity error
sudo systemctl status rental-apartments.service rental-deploy.service
```

Every rejected candidate gets
`/var/lib/rental-apartments-ops/quarantine/<digest>.json`. Later timer runs exit
successfully while the pointer resolves to that digest. A changed production
pointer naturally selects a different key. Because those runs succeed, the
timer itself never reports the block; the monitor's `deployment_blocked` alert
does, and keeps firing until the quarantine is cleared or the pointer moves.

After the fault is understood and recovery evidence is retained, a named human
may clear exactly one quarantine entry and trigger a break-glass retry:

```sh
sudo /opt/rental-apartments/current/ops/deploy \
  --actor 'Named Human' \
  --clear-quarantine \
  'ghcr.io/owner/repository@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
sudo systemctl start rental-deploy.service
```

The actor must be a named human or a stable automation identity such as
`systemd:rental-deploy` or `github-actions:<run-id>`; blank and generic
identities are rejected. Clearing quarantine does not deploy by itself.

## Manual recovery boundary

Do not edit `current-image.env`, repoint `current`, restore a snapshot, or run
Compose outside the shared operations lock while an operation is active.
Automatic rollback deliberately stops after one attempt. When both deployment
and rollback fail, the operator must choose between repairing the previous
release, restoring another validated snapshot, or keeping the bot stopped.
Follow [state recovery](state-recovery.md), retain all pre-change and failure
evidence, and escalate before destructive volume or snapshot changes.

The manual `scripts/release-operations.js` runner selects commands from each
immutable image's `com.rental-apartments.runtime` label. Rust images use the
bundled native Compose override, `rental-app` readiness probes and native backup
commands. Explicit `node` labels and retained images without a runtime label use
their existing Node commands; an unknown label fails before the running service
is stopped. Candidate and retained images are evaluated independently, so a
rollback across runtimes keeps using the retained image's own recovery tools.
For a snapshot-backed rollback from Rust to historical Node, supply the
verified installed Node release with `--target-release`. The runner checks its
published schema-2 package-lock bundle and image labels before stopping Rust,
uses that release's base Compose, and runs Node backup validation and restore
against the selected snapshot. Its `--state-strategy compatible` path continues
to inspect live state and does not restore a snapshot.

For a Rust container, the compatible-rollback check runs
`rental-app state:inspect`. This command reads the installed SQLite identity,
source binding and schema number without taking the singleton lease or applying
migrations. It can run while the service writes through WAL. It reports a newer
schema as installed; the target image's declared schema range decides whether
rollback is allowed. Use `state:validate` only in its stopped-service maintenance
workflow, since validation can upgrade state.
