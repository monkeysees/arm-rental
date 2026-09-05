# Runtime incident response

These runbooks cover a running release. They do not replace
[release rollback](release-and-rollback.md), [browser verification](browser-operations.md),
or [state restore](state-recovery.md).

## Stale crawling

### Prerequisites and safe checks

Have protected access to the host, external log search, and the active release
record. Do not restart first: capture the readiness reason and last successful
crawl so the incident remains diagnosable.

```sh
docker inspect --format \
  'running={{.State.Running}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}} image={{.Config.Image}}' \
  rental-apartments-bot
docker exec rental-apartments-bot node -e \
  'fetch("http://127.0.0.1:8787/ready").then(async r => { console.log(await r.text()); process.exitCode=r.ok?0:1 })'
docker compose --file compose.production.yaml logs --since 20m bot |
  jq -Rr 'fromjson? | select(.event == "source.integrity.checked" or .event == "source.integrity.failed" or .event == "crawl.succeeded" or .event == "crawl.failed" or .event == "retry.scheduled" or .event == "browser.challenge") | [.timestamp,.event,.reason,.component,.code,.crawlId] | @tsv'
```

Expected healthy output is a running container, ready HTTP response, and a
recent `crawl.succeeded`. Readiness becomes stale after ten minutes and fails
at five consecutive crawl failures. An inactive private bot with no channel
does not crawl; confirm the sanitized readiness monitoring state rather than
reading Telegram state.

### Recovery and expected output

- `browser.challenge`: the application immediately retries the page once in a
  fresh Chrome process; do not add another operator-forced crawl. A successful
  retry permits the complete crawl to resolve the challenge and restore
  readiness. If the fresh attempt is also challenged, the crawl fails and uses
  its normal backoff. Isolated `browser.challenge` events that a later
  `crawl.succeeded` clears need no action and raise no alert; the
  `browser_challenge` alert means five crawls in a row ended still challenged.
  On that alert or no later complete crawl, stop and use the
  [browser verification runbook](browser-operations.md). Expected manual
  recovery is passed headless smoke, ready preflight, then `crawl.succeeded`.
- `list_am`: verify host DNS/outbound HTTPS and the configured production
  target. Do not increase crawl rate, bypass a challenge, or repeatedly hammer
  List.am.
- `LIST_AM_SOURCE_INTEGRITY`: preserve the prior state and bounded baseline,
  inspect only aggregate `source.integrity.failed` counts, compare a sanitized
  fixture in the current release, and deploy a reviewed selector/parser fix.
  Do not reset state, clear the Chrome profile, print HTML, or bypass backoff.
  Expected recovery is `source.integrity.checked`, the matching alert
  resolution, and then a correlated `crawl.succeeded` when delivery completes.
- `exchange_rates`: retain a usable snapshot while checking CBA access. Never
  hand-edit rates. Absence of any usable snapshot blocks currency conversion.
- `storage`: run `npm run storage:check` and follow the
  [capacity runbook](state-maintenance.md#low-disk-and-state-growth-response).
- A responsive process with a transient upstream error should recover through
  bounded retry. A dead/unresponsive process should be restarted by the
  supervisor after three consecutive failed liveness probes, roughly 90 seconds
  of unanswered `/live`, and shows as an increased `RestartCount`; confirm
  `application.started`, ready preflight, and a successful crawl afterward. An
  unhealthy container whose `RestartCount` is unchanged has not yet failed
  three probes in a row — a single probe answering in time clears the run.

Rollback to the retained immutable artifact and verified snapshot when staleness
began with a release and upstream/storage checks are healthy. Escalate at the
fifth failure, ten stale minutes, repeated browser challenge, restart
exhaustion, unexplained lack of crawl while monitoring is active, rate snapshot
absence, or any risk of exceeding the agreed List.am access rate.

## Telegram private or channel delivery failure

### Prerequisites and safe checks

Have BotFather/channel-admin access and the delivery mode from the release
record. Never print the token, container environment, state contents, owner ID,
channel ID, or Telegram response bodies.

```sh
docker exec rental-apartments-bot node -e \
  'fetch("http://127.0.0.1:8787/ready").then(async r => { console.log(await r.text()); process.exitCode=r.ok?0:1 })'
docker compose --file compose.production.yaml logs --since 20m bot |
  jq -Rr 'fromjson? | select(.event == "runtime.operation.failed" or .event == "channel.operation.failed" or .event == "telegram.channel.operation.completed" or .event == "retry.scheduled") | [.timestamp,.event,.component,.code,.operation,.outcome] | @tsv'
```

Expected healthy preflight has `telegram: passed` and either `channel: passed`
or `channel: skipped`. A successful crawl may legitimately report zero
notifications/posts when nothing is new; that is not a delivery failure.

### Recovery and expected output

- Invalid private credentials: stop the service and follow
  [token rotation](token-rotation.md). Preserve all delivery state.
- Channel permission/target failure: confirm the reviewed configured public
  channel, restore the bot as creator or administrator with **Post Messages**
  and **Edit Messages**, then restart. Do not change delivery state.
- HTTP 429: keep Telegram's `retry_after`; do not add a competing retry loop.
- Network/5xx: verify outbound HTTPS and allow bounded exponential retry.
- A deleted channel message is reposted by normal channel behavior and the new
  message ID is saved. Do not manually alter the acknowledgement file.

After remediation require ready preflight, one `crawl.succeeded`, and no new
failure event. Verify only expected new test traffic using the approved
private/channel observation; never manufacture a production apartment or
delete acknowledgements. Roll back when the failure is release-correlated and
credentials/permissions are healthy. Escalate on possible duplicate delivery,
unexpected historical resend, owner/channel mismatch, inability to regain
BotFather/admin access, repeated 401/403/429, or a state write failure after
Telegram accepted a message.

## Stale singleton or Chrome lock

### Prerequisites and safe checks

The service must be intentionally stopped. Lock removal is permitted only after
proving no application, verifier, smoke, maintenance, recovery, or Chrome
process uses the production data/profile. A live `.singleton.sock` is a
kernel-owned lease, not a stale file.

```sh
docker compose --file compose.production.yaml stop bot
docker inspect --format '{{.State.Running}}' rental-apartments-bot
docker ps --filter volume=rental-apartments-data \
  --format 'container={{.ID}} name={{.Names}} status={{.Status}}'
pgrep -a -f 'src/(index|verify-browser|browser-smoke|maintenance-cli|recovery-cli)\\.js|chrome.*chrome-profile' || true
docker run --rm --user node \
  --mount type=volume,src=rental-apartments-data,dst=/app/.data \
  --entrypoint sh "$RENTAL_APARTMENTS_IMAGE" -c \
  'find /app/.data -maxdepth 3 \\( -name ".singleton*" -o -name "SingletonLock" -o -name "SingletonSocket" -o -name "SingletonCookie" \\) -print'
```

Expected safe output is `false`, no other container using the volume, no
matching host process, and only the listed lock artifacts. If any process is
alive, stop here and terminate it through its supervisor; never unlink its
lock.

### Recovery and expected output

The application automatically recovers a refused stale singleton socket on
next acquisition. Try one normal start first:

```sh
docker compose --file compose.production.yaml up --detach bot
docker compose --file compose.production.yaml logs --tail 100 bot
```

Expected output is `Singleton lease acquired` and ready preflight. If Chrome
still reports a stale `SingletonLock`, repeat every no-process check, take and
validate a snapshot, then remove **only** Chrome's three well-known singleton
entries while the service remains stopped:

```sh
docker compose --file compose.production.yaml run --rm --no-deps \
  --entrypoint sh bot -c \
  'rm -f /app/.data/chrome-profile/SingletonLock /app/.data/chrome-profile/SingletonSocket /app/.data/chrome-profile/SingletonCookie'
docker compose --file compose.production.yaml run --rm --no-deps bot \
  npm run browser:smoke
docker compose --file compose.production.yaml up --detach bot
```

Do not remove `.singleton.sock`, `.singleton.json`, the profile, or any other
Chrome file manually. Roll back the profile from the verified snapshot if smoke
shows corruption. Escalate when ownership is uncertain, any process/container
remains, automatic singleton recovery fails, paths are symlinks or unexpected
types, Chrome locks immediately recur, smoke needs verification, or state/profile
damage is suspected.
