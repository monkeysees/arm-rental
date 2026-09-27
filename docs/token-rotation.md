# Telegram token rotation

Use this runbook to replace a BotFather token without changing the Rust
service's SQLite delivery acknowledgements. Production stores the token in the
root-owned `/etc/rental-apartments/env`, outside the image and Git checkout.
Never paste a token into a command argument, ticket, log query or terminal
recording; enter it through the authorized concealed editor or secret facility.

## Before rotation

Confirm the immutable running image, readiness and backup mount through the
normal SSH operator tools:

```sh
rentalctl status
rentalctl timers
sudo systemctl start rental-backup.service
sudo systemctl status rental-backup.service --no-pager
```

The backup service holds the shared operations lock, stops the application,
creates and validates a fresh snapshot, and restarts the same image. Confirm
it succeeded and the service is ready before revoking the old credential.
Do not copy an individual live SQLite file or open a sealed snapshot without
`immutable=1` or a private copy.

After the backup completes, hold the same lock in a dedicated maintenance
shell for the stop, secret edit and restart. If the lock is busy, wait for the
other operation to finish; do not rotate during an active deployment:

```sh
sudo flock -n /var/lib/rental-apartments-ops/operations.lock bash
```

## Rotate and restart

1. Stop the singleton and confirm its container is stopped:

   ```sh
   sudo systemctl stop rental-apartments.service
   docker inspect --format '{{.State.Running}}' rental-apartments-bot
   ```

2. Ask BotFather to revoke the old token and issue a replacement. Edit only
   `TELEGRAM_BOT_TOKEN` in the authorized secret facility. On the dedicated
   host, use `sudoedit /etc/rental-apartments/env` and preserve root ownership
   and mode `0600`; inspect permissions without printing the file:

   ```sh
   sudo stat -c 'mode=%a owner=%U file=%n' /etc/rental-apartments/env
   ```

3. Start the installed systemd unit. It uses the verified current Rust release,
   native Compose override and unchanged persistent SQLite volume:

   ```sh
   sudo systemctl start rental-apartments.service
   rentalctl status
   rentalctl logs --since 20m --event startup.preflight.completed
   ```

Require ready preflight, a successful crawl and no unexpected replay of prior
acknowledgements. Check only sanitized event fields. The database identity,
Telegram offset and delivery history should remain unchanged apart from normal
live activity. Exit the maintenance shell to release its operations lock.

## Failure and recovery

If Telegram rejects the replacement credential, stop the service, correct the
secret and restart the same immutable image and volume. A revoked token cannot
be restored as a rollback; request another replacement from BotFather. Do not
reset SQLite or restore a snapshot for authentication failure alone. Restore
only if independent validation proves state damage, using the
[state recovery procedure](state-recovery.md); a restore can replay work
accepted after its snapshot.
