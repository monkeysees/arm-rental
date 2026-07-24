# Rental apartments Telegram bot

An admin-only Telegram bot that discovers long-term apartment rentals from
List.am and stores normalized apartment records locally. It can also publish
eligible apartments to a public Telegram channel and keep those posts current
when List.am card data changes.

Bot replies and apartment notification labels are in Russian. Apartment
messages retain the price and currency shown by List.am. Internally, all prices
are converted to Armenian drams using the latest persisted Central Bank of
Armenia rate, so private price filters are always entered and evaluated in AMD.

It monitors:

```text
https://www.list.am/ru/category/56/{page}?n=0&cmtype=0&crc=0&gl=2&srt=3
```

Only **Regular Ads** are parsed; **Top Ads** are excluded. The first crawl reads
pages 1 through 10. Every later crawl starts at page 1 and reads through the
newest posting date already in the database, including every listing from the
same minute. This prevents a refreshed known ad from hiding newer apartments
that follow it.

Telegram notifications and new channel posts are sent by date ascending:
earlier apartments first, then later apartments.

When no delivery history exists, all discovered apartments are stored but only
the latest `INITIAL_DELIVERY_LIMIT` matching apartments are sent. The default
is 10. Older matching apartments are marked as skipped and non-matching ones
as filtered; neither group will be sent after a restart or filter change.

## Requirements

- Node.js 24.18.0 (use `.nvmrc` locally)
- Google Chrome or Chromium for local development
- A Telegram bot token and the numeric Telegram user ID of its owner

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

Send `/start` to the bot in a private chat from the configured owner account.
Messages and commands from every other account, and commands in group chats,
are ignored. Activation survives process restarts. The start response includes
a **Настроить фильтры** button; `/filters` opens the same controls directly and
also works before monitoring is activated.

Every filter is optional:

- price accepts a closed range (`100000-250000`), an open range (`100000-` or
  `-250000`), or one exact value;
- rooms use the same range syntax;
- locations can combine several individual places and whole regions. Ереван is
  first, followed by its districts, then the other regions.

Send `нет` while entering a range to remove that restriction. **Сбросить всё**
removes all filters. A whole-region selection matches the region name and all
of its listed places; choosing an individual place replaces a whole-region
selection for that region. Every change is persisted and applied immediately;
there is no separate save step.

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

The channel crawler runs without the owner's `/start` activation. Private
commands, filters, activation, notifications, and delivery history remain
separate. Leaving `TELEGRAM_CHANNEL_ID` blank preserves private-only behavior.

Channel filters are configured only through the environment:

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
50,000-dram price band, and rooms. Channel filter changes apply only to
apartments not yet classified; they never release a historical filtered or
initially skipped backlog.

On the first compatible run, every stored apartment is classified atomically.
Only the latest `INITIAL_DELIVERY_LIMIT` matches are posted, oldest first.
Changing the channel username starts a fresh classification for that channel.
Successful channel message IDs and content hashes are saved immediately. Later
card changes edit the existing post when rendered content changes; a deleted
channel message is posted again and its saved message ID is replaced.

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

## Stored apartment data

`.data/apartments.json` stores:

- canonical URL and List.am item ID
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

| Variable                        | Default                                  | Purpose                                        |
| ------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`            | required                                 | Token issued by BotFather                      |
| `TELEGRAM_OWNER_ID`             | required                                 | Only user allowed to activate the private bot  |
| `TELEGRAM_CHANNEL_ID`           | blank                                    | Public `@username`; blank disables channel     |
| `CHANNEL_FILTER_PRICE_AMD`      | blank                                    | Optional channel AMD price range               |
| `CHANNEL_FILTER_ROOMS`          | blank                                    | Optional channel room-count range              |
| `CHANNEL_FILTER_LOCATIONS`      | `region:Ереван`                          | Comma-separated channel location selectors     |
| `DATA_DIRECTORY`                | `.data`                                  | Persistent state, profile, and singleton lease |
| `CHANNEL_DELIVERY_STATE_FILE`   | `.data/telegram-channel-deliveries.json` | Channel admission and publication state        |
| `APARTMENTS_STATE_FILE`         | `.data/apartments.json`                  | Apartment database                             |
| `DELIVERY_STATE_FILE`           | `.data/telegram-deliveries.json`         | Private sent, skipped, and filtered apartments |
| `EXCHANGE_RATES_STATE_FILE`     | `.data/exchange-rates.json`              | Last validated CBA rate snapshot               |
| `TELEGRAM_STATE_FILE`           | `.data/telegram-bot.json`                | Private activation, filters, and update offset |
| `TELEGRAM_POLL_TIMEOUT_SECONDS` | `25`                                     | Telegram long-poll duration                    |
| `POLL_INTERVAL_MS`              | `60000`                                  | Delay between crawls                           |
| `INITIAL_PAGE_COUNT`            | `10`                                     | Pages parsed with an empty apartment database  |
| `INITIAL_DELIVERY_LIMIT`        | `10`                                     | Latest initial private/channel selection size  |
| `TIMEOUT_MS`                    | `30000`                                  | Browser navigation and API timeout             |
| `BROWSER_PROFILE_DIR`           | `.data/chrome-profile`                   | Persistent Chrome profile                      |
| `BROWSER_HEADLESS`              | `false`                                  | Run Chrome headlessly                          |
| `BROWSER_CHALLENGE_TIMEOUT_MS`  | `120000`                                 | Verification wait duration                     |
| `BROWSER_PROTOCOL_TIMEOUT_MS`   | `30000`                                  | Chrome command timeout                         |
| `BROWSER_DEBUG_PORT`            | `49222`                                  | Local background-Chrome control port           |
| `CHROME_EXECUTABLE_PATH`        | auto-detected                            | Chrome/Chromium executable                     |

## Quality checks

```sh
npm run check
npm run test:coverage
```

## Production image

The production image pins Node.js 24.18.0 and the Chrome for Testing
150.0.7871.24 build supported by Puppeteer. It installs browser libraries from
a dated Debian snapshot and installs application packages with
`npm ci --omit=dev`; a host only needs a Linux AMD64 OCI runtime.

Build and inspect the deployment versions:

```sh
docker build --platform linux/amd64 --target production \
  --tag rental-apartments-bot:local .
docker image inspect --format '{{json .Config.Labels}}' \
  rental-apartments-bot:local
docker run --rm --entrypoint node rental-apartments-bot:local --version
docker run --rm \
  --entrypoint /opt/chrome/chrome/linux-150.0.7871.24/chrome-linux64/chrome \
  rental-apartments-bot:local --version
```

The image sets production Chrome to headless mode and stores its profile under
`/app/.data`. Supply the required environment and mount `/app/.data` on durable
storage when the service is deployed. No Node, npm package, Chrome, or browser
library installation is required on the host.

Local environment files, `.data` (including developer Chrome profiles),
dependencies, coverage, Git metadata, logs, and development caches are excluded
from the container build context. The image runs as the unprivileged `node`
account and does not read `.env` at runtime; `.env.production` is consumed only
by Compose on the deployment host.

`compose.production.yaml` is the supported singleton supervisor definition. Set
`RENTAL_APARTMENTS_IMAGE` to an immutable image reference, place the required
configuration in a host-only `.env.production`, then start it with:

```sh
docker compose --file compose.production.yaml up --detach
```

Compose makes the image filesystem read-only. The durable `/app/.data` volume
is the only persistent writable location; `/tmp` and `/dev/shm` are bounded
128 MiB and 256 MiB in-memory filesystems. The service publishes no ports.
Chrome runs with its normal sandbox, and its control channel is not externally
routable. Do not disable the Chrome sandbox, publish a Chrome debugging port,
or mount a developer `.data` tree into production.

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
