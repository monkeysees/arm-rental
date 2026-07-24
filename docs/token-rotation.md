# Telegram token rotation

Use this runbook to replace a compromised, scheduled-to-expire, or
operator-requested BotFather token without losing apartment classification or
private/channel delivery acknowledgements.

## Prerequisites

- Exclusive access to BotFather and the production secret facility.
- Permission to stop and start the singleton service.
- A healthy persistent volume and a current snapshot made by the deployment's
  approved backup procedure.
- The immutable image reference and production Compose file used by the running
  release.

Do not paste a token into a shell command, command argument, chat, ticket, log
query, or terminal recording. Use the secret facility's concealed input. On a
dedicated host that uses the supported environment-file fallback, edit
`.env.production` interactively and keep it mode `0600`; do not print it.

## Safe checks

1. Confirm the service is the expected singleton and record its image without
   inspecting its environment:

   ```sh
   docker inspect --format \
     'running={{.State.Running}} image={{.Config.Image}}' \
     rental-apartments-bot
   ```

2. Confirm the persistent volume name and take the approved snapshot. Do not
   copy individual live JSON files while the service is writing.
3. Stop the service and wait for graceful shutdown:

   ```sh
   docker compose --file compose.production.yaml stop
   docker inspect --format '{{.State.Running}}' rental-apartments-bot
   ```

   The expected final value is `false`. Escalate instead of continuing if the
   process does not stop cleanly or another replica is present.

## Rotate and restart

1. Ask BotFather to revoke the old token and issue a replacement.
2. Replace only `TELEGRAM_BOT_TOKEN` in the production secret. Do not change,
   delete, restore, or copy anything under `DATA_DIRECTORY`.
3. For the dedicated-host environment-file fallback, verify access permissions
   without displaying content:

   ```sh
   chmod 0600 .env.production
   stat -c 'mode=%a file=%n' .env.production
   ```

   Expected output contains `mode=600`.

4. Recreate the stopped service with the same immutable image and persistent
   volume:

   ```sh
   docker compose --file compose.production.yaml up --detach --force-recreate
   ```

5. Confirm one process is running and inspect only application logs. Successful
   startup acquires the singleton lease and proceeds to Telegram polling;
   logs must not contain the old or replacement token.
6. Confirm the existing delivery files still exist with restricted modes:

   ```sh
   docker exec rental-apartments-bot \
     find /app/.data -maxdepth 1 -type f -name '*.json' \
     -exec stat -c 'mode=%a file=%n' '{}' +
   ```

   Existing state files report `mode=600`. The next normal crawl must not
   re-publish acknowledged private or channel messages.

## Failure and recovery

If Telegram rejects the new credential, stop the service, correct or rotate the
secret again, and restart against the same persistent volume. A revoked token
cannot be restored as rollback; issue another replacement through BotFather.
Never delete or reset delivery state to troubleshoot authentication.

Restore the pre-rotation volume snapshot only if independent validation proves
the persistent state itself was damaged. Authentication failure alone is not a
restore condition. Escalate when BotFather access is unavailable, state files
changed unexpectedly, startup reports an unsafe path or permission error, or a
post-rotation crawl attempts to resend acknowledged history.
