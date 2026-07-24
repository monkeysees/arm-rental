# Production browser operations

Production Chrome is always headless and always uses the configured
`BROWSER_PROFILE_DIR` on the persistent data volume. The interactive verifier
and production smoke test take the same singleton lease as the service. They
therefore fail without opening Chrome when the service is running, and the
service cannot start while either operation owns the profile.

Use the exact deployed release, Chrome build, production environment, service
account, outbound IP, and persistent volume. Do not expose Chrome debugging,
disable its sandbox, or put browser state in an image.

## Verify List.am interactively

1. Stop the service and confirm it is stopped:

   ```sh
   docker compose --file compose.production.yaml stop
   docker compose --file compose.production.yaml ps
   ```

2. On a private graphical session on the production host, attach the production
   volume to the deployed release and run:

   ```sh
   npm run browser:verify
   ```

   A container deployment needs a temporary interactive maintenance session
   with the production volume mounted at `/app/.data`, the same `node` service
   account, and a private local display. Do not publish a port or mount a
   developer directory. The regular production container remains headless.

3. Complete only the List.am challenge. Wait for
   `Browser verification succeeded`; this confirms that the Regular Ads
   container parsed. The verifier then closes Chrome and releases the lease.

4. Before restarting the service, run the headless production-host smoke test:

   ```sh
   docker compose --file compose.production.yaml run --rm --no-deps \
     bot npm run browser:smoke
   ```

   Require the structured `Production browser smoke test passed` event. It
   includes the configured page-one target and Regular Ads count. A
   `browser.challenge` event with
   `ERR_BROWSER_VERIFICATION_REQUIRED` is alertable and means verification did
   not persist for this profile and outbound IP.

5. Start the service and require ready preflight after the process restart:

   ```sh
   docker compose --file compose.production.yaml up --detach
   docker compose --file compose.production.yaml logs --tail 100
   ```

The successful interactive run, headless smoke, and restarted preflight all
use the same `BROWSER_PROFILE_DIR`. Chrome writes cookies and site storage
before the verifier closes it, so verification survives service restarts and
artifact replacement as long as the persistent volume is retained.

## Transfer a dedicated verified profile

Opening the production volume on the production host is preferred. If a
separate secure Linux maintenance host is required, create a dedicated profile
there using the exact deployed Chrome build and application service account.
Never export a daily-use browser profile or a developer's complete `.data`
directory.

With Chrome and the service stopped at both ends:

1. Archive only the dedicated `BROWSER_PROFILE_DIR`. Exclude live Chrome
   singleton files, crash dumps, and disposable caches.
2. Restrict the archive to mode `0600`, encrypt it in transit using the
   organization's approved encrypted transfer, and limit access to the
   operators who can access production secrets. Browser profiles contain
   sensitive cookies and site data.
3. On the production host, preserve the current production profile as a
   rollback copy, extract only the profile archive into the configured
   `BROWSER_PROFILE_DIR`, and restore service-account ownership and directory
   mode `0700`. Never extract it over apartment, Telegram, delivery, or
   exchange-rate state.
4. Securely destroy the transfer archive after the import and run
   `npm run browser:smoke` while the service remains stopped.

Chrome can bind cookies to an operating-system key store. Cross-platform,
different-user, different-Chrome, or different-egress-IP transfers may
therefore fail safely with `ERR_BROWSER_VERIFICATION_REQUIRED`; verify directly
on the production host in that case. Do not work around this by transferring
more state, embedding a profile in the image, or weakening Chrome security.

## Failure and cleanup behavior

Every launch gets a private mode-`0700` runtime directory under the bounded
system temporary directory. Chrome receives that directory for runtime and
crash files while its durable user-data directory remains on the persistent
volume. A failed launch, navigation/renderer failure, challenge, normal
shutdown, or signal closes Chrome, terminates a remaining owned browser
process, and removes the runtime directory. The next crawl creates a new Chrome
process against the same persistent profile.

If profile contention is reported, confirm the service and all maintenance
commands are stopped. Do not delete Chrome singleton files belonging to a live
process. A supervisor restart cleans stale application runtime directories
before launch; repeated live contention requires process investigation rather
than lock-file removal.
