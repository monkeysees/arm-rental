# Deploy production from scratch

This is the canonical checklist for taking the application from a reviewed
checkout to an approved production launch. Follow the phases in order. The
linked component runbooks provide incident and implementation detail; they do
not replace this sequence.

After this one-time launch, ordinary deployment is unattended: every successful
push to `main` publishes a scanned image, and the production VPS checks for a
new image every five minutes.

## Where commands run

| Location                 | Responsibility                                                                 |
| ------------------------ | ------------------------------------------------------------------------------ |
| Operator Mac or Linux PC | Review, local tests, GitHub release observation, and Hetzner reconciliation    |
| GitHub Actions           | Required CI, Linux production contract, image build and scan, and GHCR publish |
| Production VPS           | Immutable deployment, health verification, backups, monitoring, and exercises  |
| Hetzner console          | Emergency access only when SSH or host startup fails                           |

Do not run `infra/hcloud/bootstrap.sh` inside the VPS. It runs on the operator
machine and creates or reconciles the remote host through the Hetzner API and
SSH.

## Phase 1: establish prerequisites

Required access and inputs:

- repository administration sufficient to review Actions and package
  publication;
- a Hetzner Cloud project and an API token entered through an authenticated
  `hcloud` context, never a command argument;
- a dedicated SSH key whose public half can be registered on the VPS;
- the Telegram bot token and numeric owner ID;
- a read-only GHCR credential that can pull the repository's private package;
- a reviewed server type, Hetzner location, numeric Ubuntu LTS image ID, and
  backup-volume size.

On the operator machine, install Node through `nvm`, the GitHub and Hetzner
CLIs, and the local validation tools. On macOS with Homebrew:

```sh
cd /path/to/arm-rental
nvm install
nvm use
brew install gh hcloud jq shellcheck
gh auth status
hcloud context list
```

Authenticate `hcloud` interactively if no intended context is active. Do not
place a Hetzner token in shell history or the repository.

The operator machine does not need to reproduce
`npm run check:production-contract` when it is macOS. That aggregate command
requires Linux `systemd-analyze`; Required CI runs the complete gate on Linux.

Expected result: `node --version` is `v24.18.0`, GitHub authentication selects
the intended account, and `hcloud` selects the intended project.

Stop and resolve any account, repository, or cloud-project ambiguity before
continuing.

## Phase 2: validate and publish the release revision

Start from a clean checkout and inspect everything that will enter `main`:

```sh
cd /path/to/arm-rental
git status --short
git fetch origin
git log --oneline origin/main..HEAD
npm ci
npm run check
npm run test:coverage
```

Expected result: the worktree is clean, every intended commit is reviewed, all
tests pass, and coverage remains above the configured floors.

Merge through a reviewed pull request, or push `main` if direct pushes are the
approved repository policy:

```sh
git push origin main
git rev-parse HEAD
```

Record the full revision printed by the second command. In GitHub, require both
stable branch-protection checks:

- `Required CI / Required / quality`
- `Required CI / Required / production artifact`

Watch both workflows:

```sh
gh run list --workflow quality.yml --branch main --limit 5
gh run list --workflow publish-production.yml --branch main --limit 5
```

For the recorded revision, require:

1. successful `Required CI`;
2. successful `Publish production / Publish / scanned production digest`;
3. an immutable candidate in `ghcr.io/monkeysees/arm-rental`;
4. digest-bound release metadata; and
5. advancement of the `production` discovery tag.

Retain the two workflow URLs, full source revision, and
`ghcr.io/monkeysees/arm-rental@sha256:<digest>` reference. Do not continue after
a failed or cancelled workflow, and do not manually move the `production` tag
around a failed gate. Diagnose the hosted failure and publish a corrected
commit.

## Phase 3: create the initial production secret

Create this file outside the repository and any unprotected backup or
synchronization directory:

```sh
install -m 0600 /dev/null /secure/path/rental-apartments-production.env
```

Edit it without placing values in command arguments. It must contain:

```dotenv
TELEGRAM_BOT_TOKEN=replace-with-botfather-token
TELEGRAM_OWNER_ID=replace-with-numeric-owner-id
TELEGRAM_ACCESS_MODE=public
TELEGRAM_ALLOWED_USER_IDS=
TELEGRAM_USER_UPDATES_PER_MINUTE=30
TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE=20
GHCR_IMAGE_REPOSITORY=ghcr.io/monkeysees/arm-rental
GHCR_USERNAME=replace-with-read-only-package-user
GHCR_READ_TOKEN=replace-with-read-only-package-token
POLL_INTERVAL_MS=60000
```

Private access defaults to `public`, which permits any private sender subject
to the per-user rate limits. `owner` permits only `TELEGRAM_OWNER_ID`;
`allowlist` permits the owner plus at least one unique positive non-owner ID in
`TELEGRAM_ALLOWED_USER_IDS`; do not repeat `TELEGRAM_OWNER_ID` there. Leave the
allowlist blank in `public` and `owner`
modes. The owner is always authorized and remains the server-alert recipient;
the access mode never changes alert routing. There is no private-user admission
cap.

Before rollout, review the intended access mode and the aggregate persisted-user
count from sanitized operational output. Do not place Telegram IDs in the
deployment record. Access-policy changes are reviewed environment-file changes,
not bot commands.

Optional channel publication settings may be added:

```dotenv
TELEGRAM_CHANNEL_ID=@replace_with_public_channel
CHANNEL_FILTER_PRICE_AMD=
CHANNEL_FILTER_ROOMS=
CHANNEL_FILTER_LOCATIONS=region:Ереван
```

When a channel is configured, add the bot as an administrator with Post
Messages and Edit Messages permissions before deployment.

The production Compose file supplies production-only runtime paths, headless
Chrome, backup mount, and health settings. Do not copy a developer `.data`
directory or browser profile into this file.

Expected result: the file is a regular non-symlink file with mode `0600` and
has exactly one nonempty value for each of the five required keys.
`POLL_INTERVAL_MS` may be omitted to use the application's documented
60-second default; when present, it must not be repeated and must be one
positive integer. Never print the file for troubleshooting or attach it to
launch evidence.

## Phase 4: review the Hetzner plan

Select an immutable numeric Ubuntu LTS image ID, not a mutable description such
as `ubuntu-24.04`. Review the available values with `hcloud` or the Hetzner
console, then export the selected configuration:

```sh
export HCLOUD_SERVER_TYPE=cx23
export HCLOUD_LOCATION=nbg1
export HCLOUD_IMAGE_ID=replace-with-reviewed-numeric-image-id
export HCLOUD_VOLUME_SIZE_GB=20
export HCLOUD_SSH_PUBLIC_KEY_FILE=/secure/path/rental-production.pub
```

The examples are not automatic sizing recommendations. Review cost, capacity,
location, and the public key before continuing. Ensure the matching private key
is available to the SSH agent:

```sh
ssh-add /secure/path/rental-production
```

Validate the secret shape and inspect a no-mutation provider plan:

```sh
infra/hcloud/bootstrap.sh \
  --dry-run \
  --initial-secret-file /secure/path/rental-apartments-production.env
```

Expected plan: one exact-name production server, SSH key, SSH-only firewall,
and independent backup volume. Resources receive production labels, and the
server and volume receive deletion protection.

Stop if the plan selects an unexpected existing resource, account, region,
image, key, firewall rule, or volume. Name-or-label ambiguity and immutable
drift require review rather than replacement.

The dry run and the sanitized host inspection below are the safe checks to
repeat before any recovery or escalation.

## Phase 5: create and reconcile the VPS

This command creates billable resources:

```sh
infra/hcloud/bootstrap.sh \
  --initial-secret-file /secure/path/rental-apartments-production.env
```

The script keeps cloud-init below Hetzner's 32 KiB user-data limit by sending
only the deployment account, root-only initial secret, and trusted host helper.
It then transfers the full operations bundle over SSH and reconciles systemd,
journald, Docker, mounts, and permissions. The initial secret is used only
while creating a new server. Later reconciliation never uploads or overwrites
`/etc/rental-apartments/env`.

Prove a second pass has no drift:

```sh
infra/hcloud/bootstrap.sh --check
```

Expected result: both commands finish with:

```text
Hetzner production host is reconciled; no delete operations are implemented
```

If creation partially fails, retain the output, inspect the exact named
resources, and rerun the same reconciliation only after the secret boundary is
understood. Do not delete or recreate the protected volume to recover from a
bootstrap failure. Escalate if an existing server was created without the
initial secret, because reconciliation intentionally will not upload it later.

## Phase 6: establish SSH and verify the host

Obtain the server address without copying credentials:

```sh
hcloud server describe rental-apartments-production --output json |
  jq -r '.public_net.ipv4.ip'
```

Use the returned address with the `rental-deploy` account, or create a local
SSH alias named `production`:

```sh
ssh rental-deploy@replace-with-server-ip
```

On the operator machine, confirm the provider firewall rules:

```sh
hcloud firewall describe \
  rental-apartments-production-firewall \
  --output json |
  jq '.rules'
```

On the VPS, run only sanitized checks:

```sh
sudo jq . /var/lib/rental-apartments-ops/bootstrap-receipt.json
sudo stat --format='mode=%a owner=%U:%G' /etc/rental-apartments/env
sudo findmnt --mountpoint /mnt/rental-apartments-backups
sudo systemctl status rental-deploy.timer --no-pager
sudo rentalctl timers
sudo systemctl --failed
```

Expected result:

- the bootstrap receipt contains versions but no credentials;
- the environment file reports mode `600` and owner `root:root`;
- the independent backup filesystem is mounted;
- the deploy and operational timers are enabled;
- no systemd unit is unexpectedly failed; and
- only TCP port 22 is admitted by the Hetzner firewall.

Stop if the secret is a symlink, the backup mount is absent, journal storage is
not persistent, an unexpected inbound port exists, or unit failures repeat.
Use the Hetzner console only if SSH or normal boot recovery is unavailable.

## Phase 7: observe the first unattended deployment

`rental-deploy.timer` starts five minutes after boot and checks every five
minutes. It resolves the GHCR discovery tag to an immutable digest, verifies
the release metadata, and performs the first installation automatically.

On the VPS, observe it without running Compose manually:

```sh
sudo systemctl status rental-deploy.timer rental-deploy.service --no-pager
sudo journalctl --unit rental-deploy.service --since -30m
sudo rentalctl status
sudo rentalctl logs --since 30m --event crawl.succeeded
```

For a private-only first installation in `public` mode, any intended user can
send `/start` to the bot in a private chat as soon as Telegram polling begins.
In `owner` or `allowlist` mode, only the configured authorized users can do so.
Activation starts the first crawl and is persisted for later unattended
deployments. A configured channel crawls without private activation. Server
alerts continue to use only `TELEGRAM_OWNER_ID` as their destination.

Deployment success requires ready startup preflight, healthy private probes,
one successful crawl, the configured Telegram/channel permission result, and
continued readiness for one `POLL_INTERVAL_MS` interval plus five minutes. With
the default 60-second interval, that observation window is six minutes. The
deploy service does not report success until the window finishes.

Then verify the immutable deployment receipt:

```sh
sudo jq \
  '{candidateImage,sourceRevision,firstInstall,snapshot,rollback}' \
  /var/lib/rental-apartments-ops/deployments/*.json
```

A first installation has no state database, and the application refuses to
create one: startup cannot distinguish an empty data volume from a data
directory that lost its state, so an absent database always fails closed. The
deploy runs `state:init` once, immediately after it has proved the volume empty,
and that is the only command in the tree permitted to create a database. It
refuses to run over an existing one. A quarantined first candidate leaves the
volume as it found it — the deploy removes the database it created, keeping the
dedicated Chrome profile — so the next attempt initializes normally rather than
being refused by the empty-storage gate.

Expected result: the source revision and immutable candidate digest equal the
GitHub release record, `firstInstall` is true, readiness is healthy, and a
`crawl.succeeded` event exists. A first installation has no pre-deploy snapshot.
Its named data volume must be empty or contain only the dedicated
`chrome-profile/` created while resolving a failed candidate's browser
verification challenge; application state or any other top-level entry is
rejected.

If startup reports `browser_verification_required`, keep the service stopped
and follow [production browser operations](browser-operations.md) against the
same production profile, Chrome build, service account, and outbound address.
Do not bypass a challenge, expose Chrome debugging, or transfer a daily-use
browser profile.

If deployment fails, retain the failed unit, quarantine record, and sanitized
receipt. First-install failure cannot roll back because no prior release
exists. Follow [release and rollback](release-and-rollback.md) and correct the
candidate rather than editing the immutable image record.

## Phase 8: verify operations and alerting

After every timer has had an opportunity to run, check:

```sh
sudo rentalctl status
sudo rentalctl metrics --since 1h
sudo rentalctl timers
sudo rentalctl logs --since 30m --severity error
sudo journalctl --disk-usage
```

Verify a normal backup completes, the monitor's local snapshot is current, and
a sanitized firing/resolved test notification reaches the Telegram owner.
Never test alerts by revoking the live token, corrupting state, changing
channel permissions, or deliberately breaking an upstream service.

The repository does not expose a general-purpose alert-injection CLI. If no
safe, reviewed evaluator input is available during the launch window, record
alert delivery as pending instead of manufacturing a production failure.

Expected result: the application is ready, the current image is immutable,
scheduled jobs are enabled and successful, the backup destination is
independent, journal use is bounded, and owner alerts contain no identifiers,
credentials, apartment data, or raw errors.

Local Telegram monitoring cannot report total VPS, network, Hetzner-account, or
journal loss. Treat the Hetzner console and account-level monitoring as the
fallback for that accepted blind spot.

## Phase 9: collect production acceptance evidence

The first healthy deployment makes the service operational but does not finish
production acceptance. Schedule an authorized change window for an isolated
restore, a deliberately failing safe candidate, Docker restart, and host
reboot. Keep a second SSH session and the Hetzner console available.

Initialize the root-only evidence file on the VPS:

```sh
sudo install -d -m 0700 /var/lib/rental-apartments-ops/exercises
sudo /opt/rental-apartments/current/ops/production-exercise init \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json \
  --actor human:OWNER \
  --host-alias production-vps
```

Run the isolated restore:

```sh
sudo /opt/rental-apartments/current/ops/production-exercise restore-drill \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json
```

After a normal crawl, record ready source/access state and compare its aggregate
private-delivery count with the reviewed expectation (normally zero after a
stable restart):

```sh
sudo /opt/rental-apartments/current/ops/production-exercise \
  runtime-acceptance \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json \
  --expected-access-mode public \
  --expected-private-deliveries 0
```

Replace `public` with the reviewed deployed mode. Require ready health, an exact
expected/observed access-mode match, aggregate persisted, authorized,
suspended, and active user counts, a successful crawl with one matching runtime
source-integrity check per parsed page, and no unexpected redelivery. The
receipt contains no user or apartment identifiers.

Publish a reviewed candidate that fails startup verification safely without
Telegram side effects, credential changes, storage failure, or upstream
interference. Record the active and failing immutable digests:

```sh
export PREVIOUS_IMAGE='ghcr.io/monkeysees/arm-rental@sha256:replace'
export FAILED_IMAGE='ghcr.io/monkeysees/arm-rental@sha256:replace'
sudo /opt/rental-apartments/current/ops/production-exercise \
  failed-deployment \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json \
  --candidate "$FAILED_IMAGE" \
  --previous "$PREVIOUS_IMAGE"
```

Require completed automatic snapshot rollback, restored readiness on
`PREVIOUS_IMAGE`, digest quarantine, and a successful quarantine-skip rerun.
A failed rollback is an incident; stop and use the retained snapshot and
immutable release evidence.

Run Docker and host restart recovery:

```sh
sudo /opt/rental-apartments/current/ops/production-exercise docker-restart \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json
sudo /opt/rental-apartments/current/ops/production-exercise reboot-before \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json \
  --request-reboot
```

After SSH returns:

```sh
sudo /opt/rental-apartments/current/ops/production-exercise reboot-after \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json
sudo /opt/rental-apartments/current/ops/production-exercise timers \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json
sudo /opt/rental-apartments/current/ops/production-exercise finalize \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json
sudo /opt/rental-apartments/current/ops/production-exercise validate \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json
```

Expected result: every group is `observed-pass` and `overallStatus` is
`observed-pass`. A new timer that has never triggered remains pending; wait for
its scheduled execution and repeat the timer/finalize/validate phases. The
detailed authorization, expected evidence, recovery, and escalation conditions
are in [production recovery exercises](production-exercises.md).

The failing digest remains quarantined and the discovery pointer still names
it. After retaining the exercise evidence, publish a new reviewed healthy
commit through Phase 2 and observe its normal deployment through Phase 7. Do
not clear the quarantine or manually retag the rejected image merely to finish
the checklist.

## Phase 10: approve launch

The launch record must contain only:

- full source revision;
- Required CI and Publish production workflow URLs;
- immutable GHCR digest;
- sanitized bootstrap and deployment receipts;
- final readiness and successful-crawl evidence;
- sanitized firing/resolved alert evidence; and
- the validated production exercise file with `overallStatus:
"observed-pass"`.

Do not attach the production environment file, raw journals, provider
credentials, Telegram identifiers, apartment data, browser cookies, or
complete browser profiles.

Production launch remains blocked when any hosted gate failed, the active image
does not match the recorded digest, readiness is false, rollback failed, a
required exercise is pending, or the final evidence reports `observed-fail`.

## Subsequent deployments

No Hetzner or VPS command is required for a normal redeployment:

```sh
git push origin main
```

After Required CI succeeds, GitHub publishes the scanned image and advances the
discovery pointer. The VPS detects it within five minutes, snapshots the live
state, deploys the immutable digest, observes health and crawling, and rolls
back plus quarantines the digest if verification fails.

The pull-based discovery pointer represents the latest successful release. If
several commits publish faster than the VPS can deploy them, an intermediate
digest can be skipped even though its immutable image remains in GHCR.

Use `infra/hcloud/bootstrap.sh --check` for host drift checks. Do not pass
`--initial-secret-file` expecting it to rotate or replace an existing secret;
use the dedicated token-rotation procedure instead.
