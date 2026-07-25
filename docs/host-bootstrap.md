# Production host bootstrap

`infra/hcloud/bootstrap.sh` is the only supported host provisioning and
reconciliation entry point. It creates or checks one exact-name production
server, SSH key, SSH-only firewall, and independent backup volume. The command
never deletes or replaces a resource. Name-or-label ambiguity, immutable
server drift, a changed SSH key, and volume size or location drift fail closed
for manual review.

## Reviewed inputs

Install `hcloud`, authenticate it without putting the token in a command
argument, and select an immutable numeric Ubuntu LTS image ID. Record the image
ID during review; a mutable image description such as `ubuntu-24.04` is not an
acceptable input.

```sh
export HCLOUD_SERVER_TYPE=cx23
export HCLOUD_LOCATION=nbg1
export HCLOUD_IMAGE_ID=123456789
export HCLOUD_VOLUME_SIZE_GB=20
export HCLOUD_SSH_PUBLIC_KEY_FILE="$PWD/operator-production.pub"
```

Names default to:

```text
rental-apartments-production
rental-apartments-production-ssh
rental-apartments-production-firewall
rental-apartments-production-backups
```

Override them with `HCLOUD_SERVER_NAME`, `HCLOUD_SSH_KEY_NAME`,
`HCLOUD_FIREWALL_NAME`, and `HCLOUD_VOLUME_NAME`. Every resource receives
`repository=rental-apartments`, `role=application`, and
`environment=production`. The configured type, location, image ID, size, and
names are an operator-reviewed production configuration, not dynamic
discovery.

Inspect a fresh plan before applying:

```sh
infra/hcloud/bootstrap.sh --dry-run
infra/hcloud/bootstrap.sh
infra/hcloud/bootstrap.sh --check
```

`--dry-run` performs provider reads and prints planned mutations. `--check`
also checks the remotely installed bundle, unit enablement, and active timers;
it exits `2` on drift. Applying an existing host uploads no secrets and
idempotently refreshes the reviewed `ops/`, systemd, journald, and host helper
files.

## Initial authorization and secret boundary

An initial environment file is optional:

```sh
infra/hcloud/bootstrap.sh \
  --initial-secret-file /secure/off-worktree/production.env
```

The file must contain the Telegram and read-only GHCR settings. It is placed
only in the cloud-init payload used for initial server creation. Reconciliation
never uploads or overwrites `/etc/rental-apartments/env`; the host helper only
tightens an existing regular file to root ownership and mode `0600`. Do not put
the file in the repository, shell arguments other than its path, evidence, or
support output.

The `rental-deploy` account accepts the configured key; SSH passwords and root
login are disabled. The firewall admits TCP 22 only and exposes no application,
health, log, or metric port.

## Host result

Cloud-init establishes the deployment account, root-only initial secret, and a
small trusted host helper. The operator bootstrap waits for cloud-init, then
transfers the complete version-controlled operations bundle over SSH and
invokes that helper. This keeps provider user data below Hetzner's 32 KiB
limit. The helper installs Ubuntu-signed Docker Engine, Compose v2, Git, jq,
curl, lnav, and unattended security updates. The installed Docker and Compose
major versions are pinned locally while patch updates remain eligible. It
creates:

```text
/etc/rental-apartments/env
/opt/rental-apartments/
/var/lib/rental-apartments-ops/
/var/lib/rental-apartments/releases/
/mnt/rental-apartments-backups/
/usr/local/lib/rental-apartments-bootstrap/
```

The protected Hetzner volume is mounted from its filesystem UUID. The external
Docker volume `rental-apartments-backups` is a bind to that mount. Reconciliation
will format only a block device with no detected filesystem and refuses a
non-ext4 filesystem.

Journald persists and compresses records for at most 14 days. Its requested
1 GiB cap is reduced automatically when necessary so it never exceeds 10% of
the root filesystem; journald owns rotation and vacuuming.

All version-controlled timers are enabled and started. The application service
is enabled but its systemd path conditions prevent startup until both the
root-only secret and an approved immutable image record exist. The stable
`/usr/local/sbin/rental-deploy` launcher uses the bootstrap operations bundle
for the first release and the verified current release thereafter. The stable
`/usr/local/bin/rentalctl` operator command follows the same boundary, so
status, metrics, logs, and timer inventory always come from the active release
after installation instead of the bootstrap-time copy.

Review the sanitized receipt without exposing the environment file:

```sh
ssh production \
  sudo jq . /var/lib/rental-apartments-ops/bootstrap-receipt.json
```

The receipt contains only the Docker, Compose, kernel, OS, and installed unit
versions. Server delete and rebuild protection plus volume delete protection
are enabled through Hetzner, and there is deliberately no teardown command.
