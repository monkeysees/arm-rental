# Rental apartments Telegram bot

A multi-user Telegram bot that discovers long-term apartment and house rentals
from List.am and stores normalized listing records locally. It can also publish
eligible apartments to a public Telegram channel and keep those posts current
when List.am card data changes.

Bot replies and listing notification labels are in Russian. Listing messages
retain the price and currency shown by List.am. Internally, all prices are
converted to Armenian drams using the latest persisted Central Bank of Armenia
rate, so private price filters are always entered and evaluated in AMD.

It monitors two List.am categories, one per housing kind:

```text
apartment: https://www.list.am/ru/category/56/{page}?n=0&cmtype=0&crc=0&gl=2&srt=3
house:     https://www.list.am/ru/category/1377/{page}?n=0&cmtype=0&crc=0&gl=2&srt=3
```

Every stored listing records the kind of the category it came from, and every
subscription filter selects apartments, houses, or both. New subscriptions
follow apartments, which is also what every subscription created before houses
existed continues to follow; the channel publishes apartments only.

Only **Regular Ads** are parsed; **Top Ads** are excluded. The categories are
crawled one after another, each with its own pagination and its own date
watermark. A category with no stored history reads pages 1 through 10 on its
first crawl. Every later crawl of that category starts at page 1 and reads
through the newest posting date already stored for it, including every listing
from the same minute. This prevents a refreshed known ad from hiding newer
listings that follow it.

Telegram notifications and new channel posts are sent by date ascending:
earlier listings first, then later listings. Apartments and houses are merged
into that single order rather than being sent category by category.

Private delivery makes one promise about time: a user is only ever sent
apartments List.am posted or changed within the last 24 hours. Everything the
crawl discovers is still stored, but an older card waits for its next List.am
update instead of arriving as news. The same bound governs redelivery, so an
already sent apartment is sent again only for a change List.am made inside that
window.

Whenever a user starts monitoring — the first time, or again after a pause —
the bot asks whether to send the matching apartments of the last 24 hours or to
begin with new listings only. The answer is applied to whatever the database
holds at the next crawl, so a pause never delivers its backlog unannounced. At
most `INITIAL_DELIVERY_LIMIT` apartments are sent, oldest first; the default is 100. Declined apartments are marked as skipped and are never released, and
non-matching ones are marked as filtered.

Changing a filter releases nothing on its own. When a filter edit admits
apartments that were rejected under the previous filters and are still inside
the 24-hour window, the bot offers them the next time the user opens the main
menu, and sends them only if the user accepts. Declining marks them skipped, so
the same apartments are not offered again. A rejected apartment still arrives
on its own when List.am changes its data after the rejection and inside the
window, because that is fresh source activity rather than history.

A batch that carries history — the answer to a start, a restart, or an accepted
filter release — is preceded by a message naming how many apartments follow. A
routine crawl delivering what it has just discovered sends the apartment alone.

## Requirements

- Node.js 24.18.0 (use `.nvmrc` locally)
- Google Chrome or Chromium for local development
- A Telegram bot token and the numeric Telegram user ID of its owner. The owner
  receives server alerts and is always authorized for private controls.

## Set up

```sh
npm install
cp .env.example .env
```

Set the required values:

```dotenv
TELEGRAM_BOT_TOKEN=123456:replace-with-the-token-from-botfather
TELEGRAM_OWNER_ID=123456789
```

Start the bot:

```sh
npm start
```

On each process start, the bot attempts to synchronize its source-controlled
Telegram profile descriptions and private-chat command menu. The command menu
publishes the handlers already supported by the application: `/start`, `/menu`,
`/filters`, `/stop`, `/cancel`, `/clear`, and `/delete_my_data`. Metadata
synchronization does not block polling or apartment monitoring. If it fails, the
failure is logged and retried hourly until the first successful synchronization;
the metadata loop then exits for the lifetime of that process.

Private access defaults to `public`, so any Telegram user can send `/start` or
`/menu` to the bot in a private chat. Set `TELEGRAM_ACCESS_MODE=owner` to permit only
`TELEGRAM_OWNER_ID`, or use `allowlist` to permit the owner plus at least one
unique non-owner ID in `TELEGRAM_ALLOWED_USER_IDS`. Do not repeat the owner in
that list. The owner remains the server-alert recipient in
every mode and is not itself the access policy. The service has no private-user
admission cap; configured rate limits apply independently to each authorized
sender and private recipient. Public-channel publishing is independent of the
private access mode.

Group-chat commands are ignored. `/start` and `/menu` open the user's main menu
without changing monitoring state, so filters can be chosen first. Use **Запустить
мониторинг** to choose whether to receive up to 100 existing matches and then
begin notifications; use **Остановить мониторинг** to pause them. Each user's
monitoring state and filters survive process restarts, and apartment
notifications are delivered independently. `/stop` also pauses monitoring for
the requesting user and returns to the main menu; it does not terminate the bot
process. `/filters` opens the same controls.
Every persisted user, including one suspended by a narrower access policy, can
use `/delete_my_data` to remove their filters and private notification history.
Deletion requires confirmation, stops monitoring, and makes a later `/start` or
`/menu` a new inactive subscription that must choose initial-delivery behavior
again.

Every filter is optional:

- housing kind selects **Квартиры**, **Дома**, or both. Apartments are the
  default, and at least one kind always stays selected;
- price accepts a closed range (`100000-250000`), an open range (`100000-` or
  `-250000`), or one exact value;
- rooms use the same range syntax;
- locations can combine several individual places and whole regions. Ереван is
  first, followed by its districts, then the other regions.

Send `нет` or `/clear` while entering a price or room range to remove only
that restriction. **Сбросить фильтры** removes all filters and returns the
housing kind to apartments. A
whole-region selection matches the region name and all of its listed places;
choosing an individual place replaces a whole-region selection for that region.
Every change is persisted and applied immediately; there is no separate save
step. While the bot is waiting for a price or room range, `/cancel` abandons
that input, leaves the current filter unchanged, and shows the main menu again.

Price bounds are Armenian drams. USD, EUR, and RUB listings are converted to AMD
before filtering, while Telegram notifications continue to show their original
price and currency.

## Public channel publishing

Channel publishing is optional and independent of the private conversation. To
enable it:

1. Create or select a public Telegram channel with an `@username`.
2. Add the bot as an administrator with **Post Messages** and **Edit Messages**
   permissions.
3. Set the channel username, for example
   `TELEGRAM_CHANNEL_ID=@yerevan_rentals`.

The channel crawler runs without any user's `/start` activation. Private
commands, per-user filters, activation, notifications, and delivery histories remain
separate. Leaving `TELEGRAM_CHANNEL_ID` blank preserves private-only behavior.

The channel publishes apartments only; housing kind is not configurable for it.
Its other filters are configured only through the environment:

```dotenv
CHANNEL_FILTER_PRICE_AMD=150000-300000
CHANNEL_FILTER_ROOMS=1-3
CHANNEL_FILTER_LOCATIONS=region:Ереван
```

Price and room values accept an exact value, a closed range (`150000-300000`),
or an open range (`150000-` or `-300000`). Location selectors are
case-insensitive configured Russian names, such as
`region:Котайк,place:Кентрон`; dimensions are combined with AND and multiple
locations with OR. `all` removes the location restriction. Blank locations
default to all configured Yerevan localities. Invalid, unknown, ambiguous, or
conflicting selectors stop startup with an error.

Channel posts reuse the private apartment message, including the original source
price, then append Russian hashtags for region, locality, the canonical AMD
50,000-dram price band, and rooms. The channel applies the same 24-hour bound
to its own classification, and releases on it without asking anyone: a filtered
listing is admitted when it matches and List.am
either posted it or changed it within the last 24 hours, and an initially
skipped listing is admitted when a crawl within that window encounters it again
while it still matches. Changing the channel filters therefore posts at most the
current day; older listings stay classified until List.am touches them again.

On the first compatible run, every stored apartment is classified atomically.
Only the latest `INITIAL_DELIVERY_LIMIT` matches are posted, oldest first.
Changing the channel username starts a fresh classification for that channel.
Successful channel message IDs and content hashes are saved immediately. Later
encounters within the same window publish initially skipped matches, while
changes to already published cards edit the saved message in place. A deleted channel message is
posted again and its saved message ID is replaced.

Telegram does not provide an idempotency key for `sendMessage`. There is a small
at-least-once duplicate risk if the process exits after Telegram accepts a post
but before the local acknowledgement is persisted.

## Exchange rates

The bot retrieves USD, EUR, and RUB rates from the Central Bank of Armenia when
no saved snapshot exists and every 24 hours after a successful retrieval. The
three quotes are validated and atomically persisted together. If refresh fails,
the bot logs the error, continues using the last persisted snapshot, and retries
after one hour. A fresh persisted snapshot is reused after a restart.

If the CBA is unavailable before any snapshot has been stored, apartment
crawling waits rather than persisting a foreign-currency listing without an AMD
price. CBA quote dates may remain unchanged across non-business days; both the
effective date and the time the bot fetched the snapshot are retained.

If List.am requests security verification, stop the bot and run:

```sh
npm run browser:verify
```

Complete the verification in Chrome, then restart the bot. The verified browser
profile is stored in `.data/chrome-profile`.

The initial crawl can discover many apartments and consequently send many
Telegram messages. Delivery state is persisted per message and Telegram rate
limits are respected, so an interruption safely resumes the unsent portion.

## Stored listing data

`.data/state.sqlite3` stores one normalized listing payload per row, including:

- canonical URL and List.am item ID
- housing kind (`apartment` or `house`), from the category it was crawled from
- title
- canonical price rounded to whole AMD
- original price amount and ISO currency
- for non-AMD prices, the applied exchange rate, its fetch timestamp, and the
  CBA effective date
- location
- number of rooms
- area in square metres
- floor as current/total, for example `6/18`
- List.am posting date
- first-seen timestamp
- last source-update timestamp, when a known card changes

See [docs/architecture.md](docs/architecture.md) for component and persistence
details.

## Configuration

| Variable                                 | Default                                  | Purpose                                                        |
| ---------------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| `NODE_ENV`                               | `development`                            | Runtime mode: development, test, or production                 |
| `TELEGRAM_BOT_TOKEN`                     | required                                 | Token issued by BotFather                                      |
| `TELEGRAM_OWNER_ID`                      | required                                 | Server-alert recipient; always authorized for private controls |
| `TELEGRAM_ACCESS_MODE`                   | `public`                                 | Private access: public, owner, or allowlist                    |
| `TELEGRAM_ALLOWED_USER_IDS`              | blank                                    | Unique non-owner IDs; at least one in allowlist mode           |
| `TELEGRAM_USER_UPDATES_PER_MINUTE`       | `30`                                     | Accepted private updates per user each minute                  |
| `TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE` | `20`                                     | Apartment notifications per private recipient each minute      |
| `TELEGRAM_CHANNEL_ID`                    | blank                                    | Public `@username`; blank disables channel                     |
| `CHANNEL_FILTER_PRICE_AMD`               | blank                                    | Optional channel AMD price range                               |
| `CHANNEL_FILTER_ROOMS`                   | blank                                    | Optional channel room-count range                              |
| `CHANNEL_FILTER_LOCATIONS`               | `region:Ереван`                          | Comma-separated channel location selectors                     |
| `DATA_DIRECTORY`                         | `.data`                                  | Persistent state, profile, and singleton lease                 |
| `APARTMENTS_STATE_FILE`                  | `.data/apartments.json`                  | Post-cutover sentinel path; holds no state                     |
| `DELIVERY_STATE_FILE`                    | `.data/telegram-deliveries.json`         | Post-cutover sentinel path; holds no state                     |
| `CHANNEL_DELIVERY_STATE_FILE`            | `.data/telegram-channel-deliveries.json` | Post-cutover sentinel path; holds no state                     |
| `EXCHANGE_RATES_STATE_FILE`              | `.data/exchange-rates.json`              | Post-cutover sentinel path; holds no state                     |
| `TELEGRAM_STATE_FILE`                    | `.data/telegram-bot.json`                | Post-cutover sentinel path; holds no state                     |
| `TELEGRAM_POLL_TIMEOUT_SECONDS`          | `25`                                     | Telegram long-poll duration                                    |
| `POLL_INTERVAL_MS`                       | `60000`                                  | Delay between crawls                                           |
| `INITIAL_PAGE_COUNT`                     | `10`                                     | Pages parsed per List.am category with no stored history       |
| `ADDED_CATEGORY_PAGE_COUNT`              | `2`                                      | First-crawl page cap for a later-added category                |
| `INITIAL_DELIVERY_LIMIT`                 | `100`                                    | Latest initial private/channel selection size                  |
| `TIMEOUT_MS`                             | `30000`                                  | Browser navigation and API timeout                             |
| `EXTERNAL_RETRY_BASE_MS`                 | `1000`                                   | Initial network/5xx retry delay                                |
| `EXTERNAL_RETRY_MAX_MS`                  | `60000`                                  | Retry cap; cannot exceed five minutes                          |
| `CHROME_EXECUTABLE_PATH`                 | auto-detected                            | Chrome/Chromium executable                                     |
| `BROWSER_PROFILE_DIR`                    | `.data/chrome-profile`                   | Persistent Chrome profile                                      |
| `BROWSER_HEADLESS`                       | `false`                                  | Run Chrome headlessly                                          |
| `BROWSER_LOAD_IMAGES`                    | `false`                                  | Fetch and decode page images                                   |
| `BROWSER_CHALLENGE_TIMEOUT_MS`           | `120000`                                 | Verification wait duration                                     |
| `BROWSER_PROTOCOL_TIMEOUT_MS`            | `90000`                                  | Chrome command timeout                                         |
| `BROWSER_CACHE_MAX_BYTES`                | `67108864`                               | Chrome HTTP disk-cache cap in bytes                            |
| `BROWSER_DEBUG_PORT`                     | `49222`                                  | Local background-Chrome control port                           |
| `BACKUP_DIRECTORY`                       | blank                                    | Independent snapshot destination                               |
| `BACKUP_DAILY_RETENTION`                 | `7`                                      | Daily recovery points to retain (minimum 7)                    |
| `BACKUP_WEEKLY_RETENTION`                | `4`                                      | Weekly recovery points to retain (minimum 4)                   |
| `DISK_FREE_WARNING_PERCENT`              | `20`                                     | Low-disk warning threshold                                     |
| `HEALTH_HOST`                            | `127.0.0.1`                              | Private health bind; loopback addresses only                   |
| `HEALTH_PORT`                            | `8787`                                   | Private liveness/readiness port                                |

Production backup and recovery commands are documented in
[docs/state-recovery.md](docs/state-recovery.md). The backup destination must
not share the application volume.

Deterministic CI integration gates and post-deploy production verification are
documented in
[docs/production-testing.md](docs/production-testing.md).

Production uses persistent local journald storage and the SSH-only
`rentalctl status`, `rentalctl logs`, `rentalctl metrics`, and
`rentalctl timers` commands. Retention, local Telegram alert routing, and
response checks are documented in
[docs/observability.md](docs/observability.md).

For a first production launch, follow the single canonical
[deployment-from-scratch checklist](docs/deployment-from-scratch.md). It
identifies which commands run on the operator machine, GitHub Actions, and the
VPS, and continues through final acceptance evidence. Production
deploy/rollback details and the complete operational index are documented in
[docs/release-and-rollback.md](docs/release-and-rollback.md) and
[docs/operational-runbooks.md](docs/operational-runbooks.md).

Weekly state growth reporting, lease-safe Chrome cache maintenance, and the
no-deletion retention policy are documented in
[docs/state-maintenance.md](docs/state-maintenance.md).

The idempotent Hetzner host bootstrap, immutable infrastructure inputs,
root-only initial secret handling, SSH-only firewall, protected backup volume,
and safe check/dry-run workflow are documented in
[docs/host-bootstrap.md](docs/host-bootstrap.md).

Production completion requires observed restore, forced-failure rollback,
Docker restart, host reboot, and timer-freshness evidence. The
[production recovery exercise runbook](docs/production-exercises.md) describes
the disruptive authorization boundary and the phased
`ops/production-exercise` command. The checked-in evidence template is
intentionally pending; deterministic tests do not claim that a VPS exercise
ran.

## Quality checks

```sh
npm run check
npm run test:coverage
npm run check:production-contract
```

## Production image

The production image pins Node.js 24.18.0 and Debian Chromium 151.0.7922.137
from Puppeteer's supported Chrome 151 milestone. It installs the browser,
sandbox helper, and libraries from a dated Debian snapshot and application
packages with
`npm ci --omit=dev`; a host only needs a Linux AMD64 OCI runtime.

Build and inspect the deployment versions:

```sh
docker build --platform linux/amd64 --target production \
  --tag rental-apartments-bot:local .
docker image inspect --format '{{json .Config.Labels}}' \
  rental-apartments-bot:local
docker run --rm --entrypoint node rental-apartments-bot:local --version
docker run --rm \
  --entrypoint /usr/bin/chromium \
  rental-apartments-bot:local --version
```

The image sets production Chrome to headless mode and stores its profile under
`/app/.data`. Supply the required environment and mount `/app/.data` on durable
storage when the service is deployed. No Node, npm package, Chrome, or browser
library installation is required on the host.

Production startup is fail-closed. `NODE_ENV=production` requires an explicit
absolute `DATA_DIRECTORY`, `BROWSER_HEADLESS=true`, and an absolute
`CHROME_EXECUTABLE_PATH`. Managed state and the Chrome profile must resolve
below `DATA_DIRECTORY`; symlink redirection outside that tree is rejected.
Startup creates or verifies the data tree, proves it is writable, restricts
directories to mode `0700`, and requires the SQLite database to be a safe
regular mode-`0600` file before Telegram polling or crawling starts. The
database is never created by startup; a first installation creates it once with
`npm run state:init`, which refuses to run over an existing one.

Before either long-running loop starts, preflight validates the installed
database identity/schema/pragmas/target and domain invariants, proves
the singleton lease is held, authenticates the bot with Telegram, checks
optional channel posting/editing permissions, launches the persistent Chrome
profile, parses the List.am Regular Ads container, and obtains usable CBA rates.
Unsupported or target-mismatched state fails closed without changing the
database. Startup emits one secret-free structured preflight result; only
`status: "ready"` starts the bot.

List.am challenges report the distinct non-ready
`browser_verification_required` status and remediation command:

```sh
npm run browser:verify
```

Stop the service and run the command against the same persistent Chrome profile
on a secure interactive host. Before restart, confirm the configured target and
persisted verification with the production-headless smoke command:

```sh
npm run browser:smoke
```

Both commands acquire the service singleton lease and refuse to open the
profile while the service is running. See
[production browser operations](docs/browser-operations.md) for the secure
interactive and profile-transfer workflows, and
[startup preflight remediation](docs/startup-preflight.md) for credential,
permission, state, storage, browser, List.am, and CBA failures.

Local environment files, `.data` (including developer Chrome profiles),
dependencies, coverage, Git metadata, logs, and development caches are excluded
from the container build context. The image runs as the unprivileged `node`
account and does not read `.env` at runtime; `.env.production` is consumed only
by Compose on the deployment host.

`compose.production.yaml` is the supported singleton supervisor definition. Set
`RENTAL_APARTMENTS_IMAGE` to an immutable image reference, place the required
configuration in a host-only `.env.production`, then start it with:

```sh
chmod 0600 .env.production
docker compose --file compose.production.yaml up --detach
```

Keep `.env.production` outside source control, image build contexts, backups
that lack equivalent access controls, and deployment output. Supply
`TELEGRAM_BOT_TOKEN` through the deployment platform's secret entry mechanism;
the host-only file is the dedicated-host fallback. Never put the token in a
command argument, image `ENV` instruction, Compose YAML value, support ticket,
or diagnostic command. Structured application logging defensively redacts
Telegram token shapes, Telegram Bot API URLs, and authorization-like values,
but redaction is not a substitute for keeping secrets out of inputs.

Compose makes the image filesystem read-only. The durable `/app/.data` volume
is the only persistent writable location; `/tmp` and `/dev/shm` are bounded
128 MiB and 256 MiB in-memory filesystems. The service publishes no ports.
Chrome runs with its normal sandbox, and its control channel is not externally
routable. Do not disable the Chrome sandbox, publish a Chrome debugging port,
or mount a developer `.data` tree into production.

The loopback-only health service exposes `/live` for process/event-loop
liveness and `/ready` (also `/health`) for startup and crawl readiness. The
container healthcheck terminates an unresponsive container after three
consecutive failed liveness probes so the bounded restart policy can recover
it; a single successful probe clears that run, and readiness failures remain
available to private monitoring without causing a restart loop. See
[health and readiness operations](docs/health-readiness.md) for thresholds,
component codes, access, and rollout checks.

Confirm these platform-enforced settings before rollout:

```sh
docker compose --file compose.production.yaml config
docker inspect --format \
  'user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} ports={{json .NetworkSettings.Ports}}' \
  rental-apartments-bot
docker inspect --format '{{json .HostConfig.Tmpfs}}' rental-apartments-bot
```

The fixed container name prevents scaling, and updates and rollbacks stop the
old process before starting its replacement. Unexpected failures restart at
most five times. Planned stops send SIGTERM and allow 45 seconds for polling,
state writes, and Chrome to close:

```sh
docker compose --file compose.production.yaml stop
```

If startup reports `ERR_SINGLETON_LOCKED`, do not remove lock files while the
reported process is alive. A socket left by an unclean exit is detected and
recovered automatically.

See [Telegram token rotation](docs/token-rotation.md) for the stop/rotate/start
procedure that retains private and channel delivery acknowledgements.
