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
restore drill, and token rotation. An overlapping operation fails closed.

## Publication prerequisites and gates

`publish-production.yml` runs only after a successful `Required CI` push to
`main`. It checks out that workflow's exact commit, rebuilds the same pinned
production inputs, verifies the Node, Chrome, source-revision, and package-lock
OCI labels, and runs the blocking Trivy scan before logging in or pushing.
GitHub Actions concurrency serializes publication and does not cancel an
in-progress publisher.

The publisher pushes the scanned image, captures its registry digest, and
publishes a metadata image tagged `metadata-<full-git-revision>`. Its
`/release-metadata.json` binds:

- the full source revision and exact image reference/digest;
- the `package-lock.json` digest;
- the production Compose digest; and
- a deterministic archive digest for `ops/` and `infra/systemd/`.

The publisher copies the metadata back out and compares it byte-for-byte before
advancing `production`. Therefore a failed quality gate, provenance check,
scan, candidate push, or metadata push cannot change host discovery.

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
5. stops the old bot, creates and validates a snapshot, then starts the
   candidate against the same named volumes;
6. requires healthy startup, ready Telegram and optional channel preflight, one
   `crawl.succeeded`, and final readiness after one poll interval plus five
   minutes;
7. atomically replaces `/opt/rental-apartments/current` and
   `current-image.env`, starts the systemd-owned application service, and writes
   an exclusive sanitized receipt.

The retention index keeps the current and two prior evidence records. Release
directories, digest-pinned Docker images, receipts, and associated deployment
snapshots must not be manually removed while referenced by that index.

The first install is intentionally separate. It requires no current symlink or
image record and proves the named data volume is empty. It starts and verifies
the candidate without claiming a pre-deploy snapshot. Failure stops the
candidate, records `firstInstall: true` with no rollback attempt, quarantines
the digest, and leaves the service failed.

## Automatic rollback and quarantine

Before the apartment schema first advances to version 3, retain the validated
pre-deploy snapshot as the rollback point. An older image must start only after
that matching snapshot is restored; it must never read or rewrite version-3
apartment state. Candidate acceptance must show a `source.integrity.checked`
record and `crawl.succeeded` record with the same crawl ID.

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
pointer naturally selects a different key.

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
