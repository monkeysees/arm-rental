# Startup preflight remediation

The process is not ready until every startup preflight check passes. Diagnose
the single structured log record whose message is
`Startup preflight completed`; use its `failure.component`, `failure.code`, and
component statuses. The record does not contain the Telegram token, bot
identity, or Telegram response payload.

Always stop the service before changing state or opening the persistent Chrome
profile:

```sh
docker compose --file compose.production.yaml stop
```

Use the same production environment and persistent volume for every check.
Escalate rather than deleting files when the active process or exact persistent
volume is uncertain.

## Browser verification required

Status `browser_verification_required` means Chrome started successfully but
List.am did not expose its Regular Ads container. It is non-ready and does not
start Telegram polling or crawling.

On a secure interactive host with the production environment and the same
`BROWSER_PROFILE_DIR`, run the exact remediation command reported by preflight:

```sh
npm run browser:verify
```

Complete List.am verification in the opened Chrome window. Success prints
`Browser verification succeeded`. Close the verifier, start the service, and
confirm that preflight reports `ready`. Do not run the verifier while the
service is active, copy a developer profile into production, expose Chrome's
debugging endpoint, or disable the Chrome sandbox.

The verifier takes the service singleton lease and fails before opening Chrome
if the service is still active. Follow the complete
[production browser operations](browser-operations.md) runbook, including the
headless `npm run browser:smoke` check before restart and the restricted
profile-transfer procedure when direct verification is impossible.

If the challenge returns immediately, confirm that the verifier and service use
the same persistent profile and outbound IP. Escalate repeated challenges or
any request for credentials unrelated to List.am verification.

## Incompatible state

`ERR_STATE_INCOMPATIBLE` reports the exact file, observed type/version, and
whether the problem is an unsupported schema, malformed contents, invalid
JSON, or target mismatch. Startup reads the file without writing it and leaves
it unchanged.

### Prerequisites, safe checks, and commands

Prerequisites are a stopped service, named operator, verified full snapshot,
retained immutable image, and the target/owner/channel configuration that
created the state. Confirm the container is stopped and hash the reported file
before inspection:

```sh
docker inspect --format '{{.State.Running}}' rental-apartments-bot
sha256sum .data/apartments.json
cp --archive .data/apartments.json .data/apartments.json.preflight-backup
node -e 'const s=require("./.data/apartments.json"); console.log({type:s.type,version:s.version})'
```

Expected output is `false`, a recorded hash, and only the non-secret
`type`/`version`. If JSON parsing fails, keep the hash and copy; do not use a
tool that rewrites the file merely by opening it.

### Recovery, expected output, and escalation

Restore the matching deployment artifact if it still supports that schema.
Otherwise use a tested migration. If neither is possible, an operator may
approve a reset only after confirming the backup and the delivery-duplication
impact; move the exact reported file to a dated quarantine name while the
service is stopped, then restart. Never replace an incompatible file with `{}`,
and never reset apartment state without reviewing the corresponding private
and channel delivery state.

For a target mismatch, correct the environment when the persisted owner,
List.am target, or channel is still authoritative. Treat an intentional target
change as a migration/reset decision; do not allow startup to silently
reclassify existing apartments or delivery acknowledgements.

After correction, run the stopped-service snapshot validator or restore the
complete matching snapshot—never only the malformed file—then start the
retained compatible image. Expected recovery is ready preflight with the
original apartment/delivery counts and Telegram update offset, followed by one
successful crawl without historical resend.

Keep the service stopped and escalate when the source of corruption is unknown,
the backup hash/schema/counts fail, related delivery state may be inconsistent,
no retained artifact understands the schema, target identity genuinely
changed, a migration has not passed deterministic compatibility and restore
tests, or reset could duplicate private or channel delivery.

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

## Storage, singleton, Chrome, List.am, and CBA failures

- Storage: verify the service account owns the persistent volume, directories
  can be mode `0700`, files can be mode `0600`, and the filesystem supports
  atomic rename. Do not redirect managed paths through symlinks.
- Singleton: stop the reported live owner. Never remove the lease while that
  process is alive; stale sockets from an unclean exit recover automatically.
- Chrome: confirm the pinned executable exists, is executable by the service
  account, and the profile is not open elsewhere.
- List.am: verify outbound HTTPS and the configured target. A security
  challenge must follow the browser-verification procedure above.
- Exchange rates: if no compatible snapshot exists, verify outbound HTTPS to
  the Central Bank of Armenia and retry. Do not fabricate or partially edit a
  rate snapshot.

After remediation, start the service and require one structured result with
`status: "ready"` before considering it operational:

```sh
docker compose --file compose.production.yaml up --detach
docker compose --file compose.production.yaml logs --tail 100
```
