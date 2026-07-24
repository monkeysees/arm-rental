# Production-focused testing

The ordinary `npm test` suite covers deployment boundaries without network
credentials:

- `test/browser-fetch.test.js` covers Chrome executable discovery, launch
  failure cleanup, List.am challenge detection, a fresh launch after renderer
  failure, protocol-close failure, and owned-child termination.
- `test/browser-operation.test.js` covers interactive-to-headless profile reuse
  across restart and browser/lease cleanup.
- `test/state.test.js`, `test/config.test.js`, `test/preflight.test.js`,
  `test/singleton.test.js`, and `test/recovery.test.js` cover restrictive file
  modes, file and directory flush failures, rename rollback, incompatible
  schemas, real cross-process lease contention, and recovery from an intact
  validated snapshot.
- `test/staging.test.js` exercises smoke and soak contracts with fakes. It has
  no real bot token and contacts no external service.

The commands below are excluded from CI because they require a provisioned
staging host, live external services, and at least 24 hours.

## Dedicated staging boundary

Never share the bot, channel, persistent directory, Chrome profile, or health
port with production. Create a separate BotFather bot and a private Telegram
channel with no public `@username`. Add the staging bot as an administrator
with **Post Messages** and **Edit Messages**. Obtain the private channel's
numeric ID, which begins with `-100`.

Run the exact scanned release artifact with production behavior and these
additional staging settings:

```dotenv
NODE_ENV=production
DEPLOYMENT_ENVIRONMENT=staging
ALLOW_STAGING_TESTS=true
DATA_DIRECTORY=/srv/rental-apartments-staging
TELEGRAM_BOT_TOKEN=replace-with-dedicated-staging-token
TELEGRAM_OWNER_ID=replace-with-staging-owner-id
STAGING_TELEGRAM_BOT_ID=replace-with-dedicated-staging-bot-id
STAGING_TELEGRAM_CHANNEL_ID=-1001234567890
TELEGRAM_CHANNEL_ID=
BROWSER_HEADLESS=true
CHROME_EXECUTABLE_PATH=/opt/chrome/chrome
```

`TELEGRAM_CHANNEL_ID` must be unset. This prevents the test process from using
the application's publication channel; smoke reaches only the numeric private
test channel and makes read-only identity and permission checks.

Provision
`DATA_DIRECTORY/.staging-test-environment.json` with mode `0600`. Its IDs must
match the environment:

```json
{
  "type": "rental-apartments-staging-environment",
  "version": 1,
  "environment": "staging",
  "botId": 700,
  "channelId": -1001234567890
}
```

Both commands fail before external access or process launch when the explicit
confirmation, marker, mode, bot ID, channel ID, private-channel shape, or data
directory is wrong. Never place this marker on a production volume.

## Staging smoke

With the application stopped, run:

```sh
npm run staging:smoke
```

The command acquires the singleton lease and performs two passes with newly
constructed clients. The initial pass authenticates the expected bot, verifies
private-channel post/edit permissions, parses at least one live List.am Regular
Ad, forces a live CBA retrieval, and atomically persists the rate snapshot,
browser verification evidence, and a staging smoke record. It then closes
Chrome and releases the lease.

The restarted pass reacquires the lease with new Telegram, Chrome, and CBA
clients, repeats the Telegram/List.am checks, loads the CBA snapshot instead of
refreshing it, and verifies all persisted evidence. Cleanup is required again.
A JSON result is printed; any check or cleanup failure exits nonzero. Smoke
does not publish a Telegram message or mutate production delivery state.

## Minimum 24-hour soak

Run smoke first, privately activate the staging bot with `/start`, then run:

```sh
npm run staging:soak
```

The command starts `src/index.js`, waits for `/ready`, and samples the complete
service process tree and staging files every five minutes for at least 24
hours. It measures aggregate RSS growth, Chrome child count, Chrome profile
growth, enumerated reconstructible cache growth, and captured log growth.

It ends with SIGTERM and requires a clean exit within 45 seconds. The JSON
result is printed and atomically written to
`DATA_DIRECTORY/.staging-soak/result.json`; service output is captured in
`DATA_DIRECTORY/.staging-soak/service.log`. Monitor errors, early exit,
exceeded ceilings, forced termination, signals, and nonzero exit all fail.

Defaults are 256 MiB RSS growth, 16 Chrome processes, 512 MiB profile growth,
the browser cache cap plus 16 MiB, and 1 GiB log growth. Operators may configure
stricter or explicitly reviewed higher ceilings:

```dotenv
STAGING_SOAK_SAMPLE_INTERVAL_MS=300000
STAGING_SOAK_MAX_MEMORY_GROWTH_BYTES=268435456
STAGING_SOAK_MAX_CHROME_PROCESSES=16
STAGING_SOAK_MAX_PROFILE_GROWTH_BYTES=536870912
STAGING_SOAK_MAX_CACHE_GROWTH_BYTES=83886080
STAGING_SOAK_MAX_LOG_GROWTH_BYTES=1073741824
```

`STAGING_SOAK_DURATION_MS` may lengthen the test, but values below `86400000`
are rejected. Preserve the result with release evidence and investigate
violations rather than raising a ceiling without review.
