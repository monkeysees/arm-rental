# Startup preflight remediation

The process is not ready until every startup preflight check passes. Diagnose
the latest structured log record whose message is
`Startup preflight completed`; use its `failure.component`, `failure.code`, and
component statuses. The record does not contain the Telegram token, bot
identity, or Telegram response payload.

Always stop the service before changing state or running source smoke:

```sh
docker compose --file compose.production.yaml stop
```

Use the same production environment and persistent volume for every check.
Escalate rather than deleting files when the active process or exact persistent
volume is uncertain.

## List.am challenge or transport failure

Status `source_challenge` means List.am returned an explicit mitigation or
recognizable verification interstitial. It is non-ready and gates crawling
while Telegram controls remain available. Missing listing content without a
challenge is reported through source-integrity checks instead.

Check `source_transport` for executable startup errors and `list_am` for HTTP
or integrity failures. Use the stopped-service
[source smoke procedure](source-operations.md), which validates both categories
from the production network with the pinned transport and cookie jar. Wait
before a challenge or rate-limit recheck; repeated restarts are not remediation.
After a passing smoke, start the service and require ready preflight.

Recoverable List.am failures report not-ready immediately. After validating
state, credentials, transport, and exchange rates, the process starts Telegram
controls and retries preflight every `POLL_INTERVAL_MS` (60 seconds by default),
honoring a longer valid `Retry-After`. Crawling begins only after preflight
passes. These retries retain the lease and responsive health endpoint without
consuming supervisor restarts. SIGTERM/SIGINT cancel the wait and clean up immediately.
Terminal configuration, state, executable, and credential failures do not wait.

## Incompatible state

SQLite state failures report a stable storage code and sanitized identity,
schema, integrity, pragma, or target-mismatch context. Startup validates
identity and schema before any persistent pragma, and has no other backend to
fall back to. A data directory holding no database is refused outright with
`ERR_STATE_DATABASE_ABSENT`: startup cannot tell a fresh host from a data
directory that lost its state, so it never creates one. Only `state:init`
creates a database, and only on a directory that has none, so deleting state
cannot make startup silently initialize new state.

### Prerequisites, safe checks, and commands

Prerequisites are a stopped service, named operator, verified complete snapshot,
retained immutable image, and the target/owner/channel configuration that
created the state. Confirm the container is stopped and inspect only sanitized
database metadata:

```sh
docker inspect --format '{{.State.Running}}' rental-apartments-bot
npm run backup:validate -- /app-backups/daily/SELECTED_SNAPSHOT
```

Expected output is `false` and a valid manifest-v3 (or supported v2) identity/count summary
covering SQLite identity, schema, integrity, target, and logical counts. A
snapshot taken before the SQLite cutover is refused with "predates the SQLite
cutover"; it is not a recovery option.
Do not open the production database with an ad hoc SQLite client or copy only
the main database while WAL may contain committed transactions.

### Recovery, expected output, and escalation

Restore a complete matching snapshot and use an image whose declared schema
range includes it. If neither is available, keep the service stopped and
escalate; there is no supported per-table reset, database replacement, export
back to the legacy JSON files, or migration into the database. Never delete a
sidecar, sentinel, or database, and never reach for `state:init`, to make
startup initialize new state.

For a target mismatch, correct the environment when the persisted owner,
List.am target, or channel is still authoritative. Treat an intentional target
change as a migration/reset decision; do not allow startup to silently
reclassify existing apartments or delivery acknowledgements.

After correction, run the stopped-service snapshot validator or restore the
complete matching snapshot—never only one managed file—then start the retained
compatible image. Expected recovery is ready preflight with the
original apartment/delivery counts and Telegram update offset, followed by one
successful crawl without historical resend.

Keep the service stopped and escalate when the source of corruption is unknown,
the backup hash/schema/counts fail, related delivery state may be inconsistent,
no retained artifact understands the schema, target identity genuinely
changed, migration identities disagree, the only candidate snapshot predates the
SQLite cutover, or recovery could duplicate private or channel delivery.

## Telegram credentials or channel permissions

`ERR_TELEGRAM_CREDENTIALS` is terminal. Replace or rotate the token through the
deployment secret facility, following
[Telegram token rotation](token-rotation.md), then restart. Do not place the
token in a command argument or diagnostic output.

`ERR_TELEGRAM_CHANNEL_PERMISSIONS` is terminal when Telegram rejects the
configured target or the returned membership is insufficient. Confirm that
`TELEGRAM_CHANNEL_ID` is the intended public `@username`, add the bot as an
administrator, and enable both **Post Messages** and **Edit Messages**. Restart
and require `channel: passed` before publication. A transient Telegram network
failure is non-terminal; verify outbound HTTPS and retry without changing
credentials.

## Storage, singleton, source transport, List.am, and CBA failures

- Storage: verify the service account owns the persistent volume, directories
  can be mode `0700`, files can be mode `0600`, and the filesystem supports
  atomic rename. Do not redirect managed paths through symlinks.
- Singleton: stop the reported live owner. Never remove the lease while that
  process is alive; stale sockets from an unclean exit recover automatically.
- Source transport: confirm the pinned curl-impersonate executable exists and
  is executable by the service account, and the private cookie path is safe.
- List.am: verify outbound HTTPS and the configured target. A security
  challenge must follow the source-operations procedure above.
- Exchange rates: if no compatible snapshot exists, verify outbound HTTPS to
  the Central Bank of Armenia and retry. Do not fabricate or partially edit a
  rate snapshot.

After remediation, start the service and require one structured result with
`status: "ready"` before considering it operational:

```sh
docker compose --file compose.production.yaml up --detach
docker compose --file compose.production.yaml logs --tail 100
```
