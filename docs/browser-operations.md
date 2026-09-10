# Production browser operations

Production Chromium is always headless and always uses the configured
`BROWSER_PROFILE_DIR` on the persistent data volume. The interactive verifier
and production smoke test take the same singleton lease as the service. They
therefore fail without opening Chrome when the service is running, and the
service cannot start while either operation owns the profile.

Use the exact deployed release, Chrome build, production environment, service
account, outbound IP, and persistent volume. Do not expose Chrome debugging,
disable its sandbox, or put browser state in an image.

## Prerequisites and safe checks

Open a change/incident with a named operator, take and validate a complete
snapshot, and retain the active immutable image. Confirm the service account,
profile path, Chrome version, and outbound IP are the production values.

```sh
docker inspect --format \
  'running={{.State.Running}} image={{.Config.Image}} user={{.Config.User}}' \
  rental-apartments-bot
docker ps --filter volume=rental-apartments-data \
  --format 'container={{.ID}} name={{.Names}} status={{.Status}}'
```

Expected output identifies only the reviewed singleton. Stop and escalate if
another container/process uses the volume or if the image, user, profile, or
egress boundary differs from the release record.

## Verify List.am interactively

1. Stop the service and confirm it is stopped:

   ```sh
   docker compose --file compose.production.yaml stop
   docker compose --file compose.production.yaml ps
   ```

2. On a private graphical session on the production host, attach the production
   volume to the deployed release and run:

   ```sh
   node src/verify-browser.js
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
     bot node src/browser-smoke.js
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

## Browser identity

The browser uses ordinary desktop Chrome's reduced user-agent version
(`Chrome/<major>.0.0.0`) and retains the installed full version in client hints.
Headful verification and headless crawling use the same identity. Navigator
properties remain native rather than being replaced with page JavaScript
getters. These consistency checks do not guarantee acceptance by List.am;
compare challenge rates after release to measure their effect.

## Image loading

The crawl browser loads page images, as `BROWSER_LOAD_IMAGES` defaults to
`true`. Nothing downstream reads an image element or its source, so the fetch
buys the crawl nothing directly; it is paid for what it says about the client.
A browser that requests a listing page and none of its images does not behave
like the browser its user agent claims to be, and List.am's edge scores that.
Setting `BROWSER_LOAD_IMAGES=false` launches with
`--blink-settings=imagesEnabled=false`, which suppresses fetching and decoding
while leaving image elements and their attributes in the document, so the
parsed HTML is unchanged either way — take that saving back on a host where
bandwidth and decode time matter more than the challenge rate. The interactive
verifier always loads images: a challenge has to be visible to be completed.

Before deploying a change to this setting, run `npm run browser:smoke` on the
production host with images enabled and again with them disabled, and require
an identical Regular Ads count from both. A difference means List.am ties
listing content to image loading. The same failure in production reaches
`src/source-integrity.js`, which raises `ERR_LIST_AM_SOURCE_INTEGRITY` when
first-page counts fall outside the expected range; a verification challenge
instead surfaces as the absent `#contentr` element and a `browser.challenge`
event. Both are alertable, and the rollback for both is the environment
variable.

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

Expected recovery is `Browser verification succeeded`, a passed
`Production browser smoke test`, ready startup preflight, and one subsequent
successful crawl. If a profile import or verification makes behavior worse,
stop the service and restore the pre-change verified snapshot before restarting
the retained image.

Escalate when the service or another Chrome process cannot be proven stopped,
the sandbox/debugging boundary differs, the profile has unexpected ownership or
symlinks, the challenge immediately returns, smoke cannot parse Regular Ads,
the profile cannot be restored, or List.am asks for credentials or actions
outside its ordinary browser verification.
