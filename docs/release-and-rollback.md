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
`main`. It checks out that workflow's exact commit, rebuilds the same pinned
production inputs, verifies the Node, curl-impersonate, source-revision, and package-lock
OCI labels, and runs the blocking Trivy scan before logging in or pushing.
GitHub Actions concurrency serializes publication and does not cancel an
in-progress publisher.

The publisher pushes the scanned image, captures its registry digest, and
publishes a metadata image tagged `metadata-<full-git-revision>`. Its
`/release-metadata.json` binds:

- the full source revision and exact image reference/digest;
- the supported state backend and inclusive schema range;
- the state backends this release's own deployer accepts
  (`deployableStateBackends`);
- the `package-lock.json` digest;
- the production Compose digest; and
- a deterministic archive digest for `ops/` and `infra/systemd/`.

The publisher copies the metadata back out and compares it byte-for-byte before
advancing `production`. Therefore a failed quality gate, provenance check,
scan, candidate push, or metadata push cannot change host discovery.

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
sudo rentalctl timers
sudo rentalctl status
sudo jq '{candidateImage,previousImage,sourceRevision,snapshot,rollback}' \
  /var/lib/rental-apartments-ops/deployments/*.json
```

Expected output reports mode `600`, the mounted backup filesystem, an active
timer, an immutable current image, and sanitized receipts. Stop and escalate
if the secret file is a symlink, the mount is absent, the current image file
contains a tag, multiple containers exist, or the timer repeatedly fails.

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

The restored deployment configuration remains the access-policy authority;
never infer an access mode from snapshot users or resume users that the
restored mode does not authorize. Restore private-delivery acknowledgements
with bot state so rollback cannot resend accepted apartments. A snapshot that
contains `deletionPendingAt` must resume that deletion; rolling back across the
deletion boundary is allowed only with the matching, internally consistent
pre-deletion snapshot of both bot and private-delivery state.

Any candidate failure after mutation stops the candidate, restores the verified
pre-deploy snapshot, starts the previous immutable image through systemd, and
requires readiness. A successful recovery emits
`deployment.rollback.completed`, records `rollback.result: completed`, opens a
deployment alert, and leaves `rental-deploy.service` failed so the incident is
visible.

The same recovery path covers launch and observation failures. The restore is
performed by the previous image, whose exact managed-target list removes the
database and sidecars before reinstalling the verified snapshot. The
previous release is restarted only after restore succeeds. Deployment never
converts state during a code release.

If snapshot restore or previous-image readiness fails, the command records
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
