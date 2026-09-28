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
`main`. It checks out that workflow's exact commit and builds the Rust image
from committed Git inputs. The publisher verifies the image's runtime, source
and provenance identities, packaged service and HTTP closure, then runs
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
- the Rust toolchain, Cargo lock, source-input, executable, and transport
  digests for schema-3 Rust releases;
- the production Compose digest; and
- a deterministic archive digest for `ops/` and `infra/systemd/`.

Before a registry push, the publisher reads and binds the current `production`
image to its metadata and checks that release's runtime, deployment and
live-state rollback contracts. A candidate fails closed when the pointer
cannot be verified. The publisher copies the new
metadata back out and compares it byte-for-byte before considering `production`.
A runtime or deployable-capability contraction holds that pointer for operator
promotion; a failed quality gate, provenance check, scan, candidate push, or
metadata push cannot change host discovery.

### Cargo provenance contract

Schema-3 metadata is the separate `cargo-source-v1` Rust contract. It requires
an exact Rust runtime, clean source, source revision, immutable image digest,
Cargo lock, Rust executable, curl executable, transport closure, SQLite schema
range, production Compose, and operations archive. The image labels and
`components.json` must agree with the metadata, and the host hashes the actual
files extracted from the image. Schema 3 has no package-lock field, artifact,
or label; unknown and mixed provenance claims fail.

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

Schema-3-to-schema-3 publication verifies the exact current release and can
advance normally. A missing, mismatched, or unknown contract fails before
pointer mutation.

### Rust-only runtime capability transition (#50)

The first schema-3 Rust release retained the bridge capability
`deployableRuntimes: ["node", "rust"]` so its deployer could safely accept
releases from the earlier cutover. A new Rust-only release narrows this to
`["rust"]`. The publisher's `scripts/native-release.py gate` requires the
committed, sanitized `docs/evidence/issue50-bridge-receipt.json` that binds the
accepted intermediate Rust bridge to its exact source, image, metadata and
host receipt. It verifies that evidence against the current published
release before the first Rust-only registry push. The first capability
contraction is published with the discovery pointer held until the separate
promotion workflow confirms the bridge is running on the host. A later
Rust-only-to-bridge expansion and a schema-3-to-schema-2 downgrade are both
refused before production stops.

The [sanitized bridge attestation](evidence/issue50-bridge-receipt.json)
remains an input to the release gate.

An unattended schema-3-to-schema-2 provenance downgrade is refused before
the service stops. The retired pre-SQLite Node image and snapshot cannot be a
manual target for the current SQLite database. Manual rollback must select a
verified retained Rust release whose metadata covers the installed schema, or
restore a matching validated Rust snapshot with its release. Snapshot restore
can replay work accepted after that snapshot.

The retained schema-2 Rust release at source `9c95f8f3efb161f507cc26c33312a64dcfa3c6e0`
and digest `6d2808e1…` has one recognized Cargo-capable archived verifier
variant. Verification still binds its exact source, image, release bundle and
payload; this exception does not admit other schema-2 verifier variants or
restore Node capability.

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
No current release can create a new `protectedReleases` entry. Only the
current-plus-two Rust retention set is available for rollback; see
[state recovery](state-recovery.md).

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
not understand rollback retention and may remove the two retained prior Rust
images. An invalid index, current-image mismatch, missing retained image, or
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

The deployed Rust application accepts SQLite schemas 1–6 and writes schema 6.
The schema-4 upgrade replaces private delivery rows transactionally, then
reclaims free pages with a retryable one-time VACUUM. Allow temporary space
for replacement pages, WAL and the VACUUM copy. An image whose supported
schema range excludes 6 cannot use `state-strategy=compatible` against the
current live state; use a matching snapshot with the restore strategy. See the
[schema contract](sqlite-schema.md) for migration and interruption behavior.

The restored deployment configuration remains the access-policy authority;
never infer an access mode from snapshot users or resume users that the
restored mode does not authorize. Restore private-delivery acknowledgements
with bot state so rollback cannot resend accepted apartments. A snapshot that
contains `deletionPendingAt` must resume that deletion; rolling back across the
deletion boundary is allowed only with the matching, internally consistent
pre-deletion snapshot of both bot and private-delivery state.

On a failed Rust candidate, unattended recovery stops and confirms the
candidate is stopped, validates the matching predeploy snapshot, restores it
with the prior immutable Rust release, then requires readiness. The failed
receipt records `rollback.stateStrategy: snapshot-restore`. A successful
recovery emits
`deployment.rollback.completed`, records `rollback.result: completed`, opens a
deployment alert, and leaves `rental-deploy.service` failed so the incident is
visible.

If the candidate cannot be confirmed stopped, the snapshot is invalid, or the
previous image cannot become ready, recovery leaves the service stopped and
alerts for operator action. The retained Rust snapshot and image remain
available for explicit recovery. Restoring a snapshot can replay work accepted
after it was taken. Deployment never converts state during a code release.

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

The manual `scripts/release-operations.py` runner exposes `validate`, `deploy`
and `rollback` with the established long options and `--dry-run`. It acquires
the shared operations lock itself. Candidate and retained release bundles are
verified before the service stops; both images must explicitly declare the
Rust runtime and pass the published schema-3 metadata and bundle checks.
`--target-release` may select only a verified retained release. The
`--state-strategy compatible` path preserves compatible live SQLite state;
`--state-strategy restore` validates and restores the selected matching
snapshot and can replay work accepted after that snapshot.

```sh
python3 scripts/release-operations.py --help
```

Supply `--environment production`, an accountable `--actor`, immutable
`--image` and `--previous-image` references, a published daily or weekly
`--snapshot`, the poll interval, observation duration and delivery mode. Run
`validate` or `--dry-run` first to check the request without Docker; execution
then verifies both published Rust artifacts before stopping the service. Run
the script with the permissions needed for the shared operations lock; do not
hold a separate external lock around it.

For a Rust container, the compatible-rollback check runs
`rental-app state:inspect`. This command reads the installed SQLite identity,
source binding and schema number without taking the singleton lease or applying
migrations. It can run while the service writes through WAL. It reports a newer
schema as installed; the target image's declared schema range decides whether
rollback is allowed. Use `state:validate` only in its stopped-service maintenance
workflow, since validation can upgrade state.
