# Rental apartments Telegram bot

An admin-only Telegram bot that discovers long-term apartment rentals from
List.am and stores normalized apartment records locally.

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

Telegram notifications are sent by date ascending: earlier apartments first,
then later apartments.

When no delivery history exists, all discovered apartments are stored but only
the latest `INITIAL_DELIVERY_LIMIT` matching apartments are sent. The default
is 10. Older matching apartments are marked as skipped and non-matching ones
as filtered; neither group will be sent after a restart or filter change.

## Requirements

- Node.js 22.12 or newer
- Google Chrome or Chromium
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

See [docs/architecture.md](docs/architecture.md) for component and persistence
details.

## Configuration

| Variable                        | Default                          | Purpose                                         |
| ------------------------------- | -------------------------------- | ----------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`            | required                         | Token issued by BotFather                       |
| `TELEGRAM_OWNER_ID`             | required                         | Only user allowed to activate the bot           |
| `APARTMENTS_STATE_FILE`         | `.data/apartments.json`          | Apartment database                              |
| `DELIVERY_STATE_FILE`           | `.data/telegram-deliveries.json` | Sent, skipped, and filtered apartments          |
| `EXCHANGE_RATES_STATE_FILE`     | `.data/exchange-rates.json`      | Last validated CBA exchange-rate snapshot       |
| `TELEGRAM_STATE_FILE`           | `.data/telegram-bot.json`        | Bot activation, filters, and update offset      |
| `TELEGRAM_POLL_TIMEOUT_SECONDS` | `25`                             | Telegram long-poll duration                     |
| `POLL_INTERVAL_MS`              | `60000`                          | Delay between crawls                            |
| `INITIAL_PAGE_COUNT`            | `10`                             | Pages parsed with an empty apartment database   |
| `INITIAL_DELIVERY_LIMIT`        | `10`                             | Latest apartments sent without delivery history |
| `TIMEOUT_MS`                    | `30000`                          | Browser navigation and API timeout              |
| `BROWSER_PROFILE_DIR`           | `.data/chrome-profile`           | Persistent Chrome profile                       |
| `BROWSER_HEADLESS`              | `false`                          | Run Chrome headlessly                           |
| `BROWSER_CHALLENGE_TIMEOUT_MS`  | `120000`                         | Verification wait duration                      |
| `BROWSER_PROTOCOL_TIMEOUT_MS`   | `30000`                          | Chrome command timeout                          |
| `BROWSER_DEBUG_PORT`            | `49222`                          | Local background-Chrome control port            |
| `CHROME_EXECUTABLE_PATH`        | auto-detected                    | Chrome/Chromium executable                      |

## Quality checks

```sh
npm run check
npm run test:coverage
```
