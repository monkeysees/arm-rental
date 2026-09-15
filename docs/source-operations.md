# List.am source operations

List.am HTML is fetched by curl-impersonate 2.2.2 using the fixed Safari
`safari2601` profile. The transport runs no JavaScript. It spaces requests by
at least two seconds, persists private HTTP cookies, and follows at most five
redirects within the same HTTPS origin. Sustained access still depends on
List.am's responses; a successful smoke is a current observation, not a
promise that challenges cannot return.

## Install and verify

Production images contain the checksum-verified executable. For Linux local
development, install it with:

```sh
sudo scripts/install-curl-impersonate /usr/local
/usr/local/bin/curl-impersonate --version
```

The installer accepts an absolute prefix and an optional `amd64` or `arm64`
architecture. Set `CURL_IMPERSONATE_PATH` to its absolute executable path.
`LIST_AM_COOKIE_FILE` defaults to `.data/list-am-cookies.txt` and must stay
inside `DATA_DIRECTORY`. Cookies are mode `0600`, disposable, and excluded from
backups; do not print or copy them into diagnostics.

## Stopped-service smoke

### Prerequisites and safe checks

Use the deployed image, production environment, service account, outbound
network, and data volume. Stop the service before probing; the command takes
the same singleton lease and refuses concurrent operation.

```sh
docker compose --file compose.production.yaml stop bot
docker inspect --format '{{.State.Running}}' rental-apartments-bot
docker compose --file compose.production.yaml run --rm --no-deps bot \
  node src/list-am-smoke.js
```

Locally, use `npm run source:smoke` with the bot stopped. The check validates
page one of both categories with the production parser and integrity rules,
reports aggregate counts, and exits nonzero on failure. It does not modify
listing or delivery state or create a verification record. After a passing
check, start the service and require ready preflight and a successful crawl:

```sh
docker compose --file compose.production.yaml up --detach bot
rentalctl logs --since 20m --event crawl.succeeded
rentalctl status
```

Expected recovery is `List.am HTTP smoke test passed`, ready preflight, and a
subsequent `crawl.succeeded` event. Escalate if the service cannot be proven
stopped, the deployed executable differs from its pinned release, or smoke
continues failing after the reported cooldown.

## Challenges and failures

`ERR_LIST_AM_CHALLENGE` and `list_am.challenge` mean an explicit mitigation
header (`challengeSource: edge`) or a recognizable interstitial
(`challengeSource: interstitial`). Missing or malformed listing content alone
belongs to source-integrity checks. Inspect only bounded status/reason fields.

A challenge stops the crawl. There are no immediate page retries. Challenges
and HTTP 429 wait at least the configured poll interval before retrying; the
server's `Retry-After` can extend the wait beyond the ordinary backoff cap.
A validated source recovery clears the challenge. Readiness changes
immediately; the dedicated alert waits for five challenged crawls without
validated recovery. Startup challenges mark preflight non-ready immediately,
then wait at least the poll interval or a longer valid `Retry-After` before
exiting for bounded supervisor retries. The lease and live health endpoint
remain available during this cooldown; a stop signal cancels it immediately.

For persistent failure, check the installed executable, host DNS/outbound
HTTPS, and the source response codes. Preserve the cookie jar while diagnosing
ordinary failures. Do not repeatedly run smoke or restart to bypass backoff.
If failures began with a release, follow [release rollback](release-and-rollback.md).
If the pinned transport remains challenged after waiting, keep monitoring
paused and investigate the transport against sanitized fixtures before
changing its identity or request rate.

## Retiring old profile data

The native release does not open or maintain the legacy `.data/chrome-profile`
directory. Keep existing profile data only while retaining a rollback release
that needs it; after that window, remove that explicitly identified directory
under the stopped-service lease. Do not delete unrelated data or active state.
The one-time host operations transition is documented in
[release and rollback](release-and-rollback.md).
