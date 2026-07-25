# Release, rollback, and launch

This is the canonical deploy and rollback runbook. It uses the application’s
real startup boundary: configuration, storage, singleton acquisition, and the
complete external preflight finish before polling or crawling can begin.
`scripts/release-operations.js` then requires readiness, one successful crawl,
and the expected Telegram/channel preflight result.

The commands are non-interactive. A release is not authorized until a named
human operator has reviewed the dry-run output. All image values must be an
immutable registry digest (`registry/name@sha256:...`) or an already loaded
Docker image ID (`sha256:...`); tags are rejected.

## Prerequisites

- CI quality, coverage, audit, image scan, and artifact jobs passed for the
  exact source revision.
- The exact scanned archive was loaded or the digest-pinned registry artifact
  was pulled in production. Do not rebuild.
- Docker Compose v2, `jq`, the deployed Compose file, mode-`0600`
  `.env.production`, the named `rental-apartments-data` volume, and the
  separately provisioned external `rental-apartments-backups` volume exist.
- Deterministic CI integration tests, coverage, dependency audit, image
  execution checks, and the blocking vulnerability scan passed for this
  artifact.
- Browser verification, production alert checks, an isolated restore drill,
  and the [launch checklist](#launch-checklist) are complete.
- The change window names one accountable operator and lasts at least
  `POLL_INTERVAL_MS + 300000` milliseconds.

Load a CI archive without changing a running service:

```sh
gzip --decompress --stdout release/rental-apartments-bot.tar.gz |
  docker load
docker image inspect rental-apartments-bot:ci \
  --format 'id={{.Id}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
```

Record the printed `sha256:...` ID as `CANDIDATE_IMAGE`. Do not delete the
archive, the candidate, or the current image during the change window.

## Safe checks and production snapshot

Set reviewed values. `SNAPSHOT` is a path **inside** the backup volume, not a
host path. The example six-minute window is valid only for a 60-second crawl
interval.

```sh
export OPERATOR='Named Human'
export CANDIDATE_IMAGE='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export PREVIOUS_IMAGE="$(docker inspect --format '{{.Config.Image}}' rental-apartments-bot)"
export POLL_INTERVAL_MS='60000'
export OBSERVATION_MINUTES='6'
export DELIVERY_MODE='both'
export RENTAL_APARTMENTS_IMAGE="$PREVIOUS_IMAGE"
```

Confirm the current singleton and mounts without printing its environment:

```sh
docker inspect --format \
  'running={{.State.Running}} image={{.Config.Image}} restart={{.RestartCount}}' \
  rental-apartments-bot
docker inspect --format \
  '{{range .Mounts}}{{println .Type .Name .Destination}}{{end}}' \
  rental-apartments-bot
docker volume inspect rental-apartments-data rental-apartments-backups \
  --format 'volume={{.Name}} mount={{.Mountpoint}}'
docker compose --file compose.production.yaml config --format json |
  jq -e '
    .services.bot.container_name == "rental-apartments-bot" and
    .services.bot.deploy.replicas == 1 and
    .services.bot.deploy.update_config.order == "stop-first" and
    ([.services.bot.volumes[] | select(.target == "/app/.data")] | length == 1)
  '
```

Expected output reports one running container, the reviewed previous image, one
named `/app/.data` mount, a distinct `/app-backups` mount, and `true` from
`jq`. Stop rather than continue if another replica/process exists, either
volume is missing, the current image is not the expected release, or Compose
does not enforce stop-first.

A consistent snapshot requires the bot to be stopped. The trap returns the
previous release to service if backup or validation fails.

```sh
snapshot_log="$(mktemp)"
trap 'RENTAL_APARTMENTS_IMAGE="$PREVIOUS_IMAGE" docker compose --file compose.production.yaml up --detach bot' EXIT
docker compose --file compose.production.yaml stop bot
docker inspect --format '{{.State.Running}}' rental-apartments-bot
docker compose --file compose.production.yaml run --rm --no-deps bot \
  npm run backup | tee "$snapshot_log"
export SNAPSHOT="$(
  jq -r 'select(.event == "backup.completed" and .snapshot != null) | .snapshot' \
    "$snapshot_log" | tail -n 1
)"
test -n "$SNAPSHOT"
docker compose --file compose.production.yaml run --rm --no-deps bot \
  npm run backup:validate -- "$SNAPSHOT"
docker compose --file compose.production.yaml up --detach bot
trap - EXIT
```

Expected output includes `backup.completed`, the published
`/app-backups/daily/<timestamp>` path, checksum/schema/count validation, and
`false` while the old container is stopped. A backup or validation failure
leaves existing snapshots and live state unchanged; restart the old image,
preserve the log, and escalate.

## Deploy

Validate the complete contract first. `validate` never calls Docker and never
writes an evidence file:

```sh
npm run release:validate -- \
  --environment production \
  --operator "$OPERATOR" \
  --image "$CANDIDATE_IMAGE" \
  --previous-image "$PREVIOUS_IMAGE" \
  --snapshot "$SNAPSHOT" \
  --poll-interval-ms "$POLL_INTERVAL_MS" \
  --observation-minutes "$OBSERVATION_MINUTES" \
  --delivery "$DELIVERY_MODE" \
  --state-strategy compatible \
  --evidence-file "/var/lib/rental-apartments/releases/deploy.json"
```

Review the JSON plan, then execute the same immutable inputs:

```sh
npm run release:deploy -- \
  --environment production \
  --operator "$OPERATOR" \
  --image "$CANDIDATE_IMAGE" \
  --previous-image "$PREVIOUS_IMAGE" \
  --snapshot "$SNAPSHOT" \
  --poll-interval-ms "$POLL_INTERVAL_MS" \
  --observation-minutes "$OBSERVATION_MINUTES" \
  --delivery "$DELIVERY_MODE" \
  --state-strategy compatible \
  --evidence-file "/var/lib/rental-apartments/releases/deploy.json"
```

The command verifies both images and the snapshot before mutation. It confirms
the current image and volume, stops the old container, confirms it is stopped,
and only then recreates the service with the candidate and the same named data
volume. The application completes preflight before its loops. The command
waits for ready preflight, a `crawl.succeeded` event, passed Telegram
authentication, the expected passed/skipped channel check, and a final ready
probe after the full observation window.

Success prints a receipt and creates the exclusive evidence file with operator,
images, snapshot, volume, timestamps, observation period, crawl ID/counters,
and Telegram/channel results. It contains no credentials. Preserve the
previous image and CI archive until the window closes.

If candidate startup, preflight, evidence, or final readiness fails, the command
stops the candidate first, restores the verified snapshot, starts the previous
image, checks readiness, and exits nonzero. This restores preflight-time browser
profile or exchange-rate changes as well as JSON state. Preserve logs and
escalate if automatic recovery does not return the old release to ready.

## Rollback

Use `restore` unless deterministic compatibility tests prove that every state
schema written by the current release is backward compatible. The rollback
target is `--image`; the currently running release is `--previous-image`, so a
failed rollback can be recovered safely.

```sh
export CURRENT_IMAGE="$(docker inspect --format '{{.Config.Image}}' rental-apartments-bot)"
export ROLLBACK_IMAGE="$PREVIOUS_IMAGE"

npm run release:rollback -- \
  --environment production \
  --operator "$OPERATOR" \
  --image "$ROLLBACK_IMAGE" \
  --previous-image "$CURRENT_IMAGE" \
  --snapshot "$SNAPSHOT" \
  --poll-interval-ms "$POLL_INTERVAL_MS" \
  --observation-minutes "$OBSERVATION_MINUTES" \
  --delivery "$DELIVERY_MODE" \
  --state-strategy restore \
  --evidence-file "/var/lib/rental-apartments/releases/rollback.json"
```

The command validates the snapshot before mutation, stops the new release
before state restore or old-image start, preserves the named data volume,
restores the snapshot, and subjects the old artifact to the same preflight,
crawl, Telegram/channel, and observation checks. With
`--state-strategy compatible`, it skips the planned restore but still restores
the snapshot if the rollback target itself fails.

Expected output is a completed rollback receipt. Escalate with both image
references, snapshot ID, receipt/logs, and sanitized preflight reason if schema
compatibility is uncertain, restore fails, the singleton cannot stop, browser
verification is required, Telegram/channel behavior differs, no successful
crawl arrives, or readiness regresses.

## Launch checklist

The named operator records each item and its evidence location. Unchecked or
verbal-only items block launch.

- [ ] Production-readiness acceptance criteria are mapped to passing tests,
      CI results, runbook evidence, or a documented external control.
- [ ] Production configuration was peer-reviewed without rendering secrets;
      the secret file/facility and data directory modes are correct.
- [ ] The production data volume and independently managed backup volume exist,
      have capacity, and use distinct filesystems.
- [ ] Singleton contention, stop-first behavior, graceful SIGTERM, and bounded
      restart are covered by integration tests and production observation with
      no overlapping writers.
- [ ] The exact artifact passed deterministic integration tests, coverage,
      dependency audit, image execution checks, and vulnerability scan.
- [ ] Interactive browser verification and headless smoke passed on the
      production runtime, service account, profile, and outbound IP.
- [ ] `/live`, `/ready`, log retention, and safe critical-alert checks were
      exercised in production without exposing secrets or disrupting normal
      delivery.
- [ ] An isolated restore drill from the newest production snapshot matched
      counts, update offset, schemas, and browser verification without starting
      bot polling or delivery.
- [ ] A fresh production snapshot was taken and validated; its ID and manifest
      summary are attached to the change.
- [ ] Candidate and previous immutable artifacts are present and retained
      through the observation window.
- [ ] The named production operator and an observation window of at least one
      crawl interval plus five minutes are recorded.
- [ ] The operator confirms List.am access and the configured polling frequency
      are acceptable and observes one successful production crawl plus expected
      private/channel behavior.

Production launch evidence is necessarily external to the repository. Store CI
links, restore records, alert notifications, snapshot validation, production
receipt, and change approval in the controlled operations record; do not commit
credentials, live identifiers, or production logs.
