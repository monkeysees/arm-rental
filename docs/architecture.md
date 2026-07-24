# Architecture

## Purpose

The application is a private Telegram bot that discovers long-term apartment
rentals from List.am. It reads only the site's **Regular Ads** section and
ignores **Top Ads**. The configured Telegram owner is the only account allowed
to activate the bot.

## Runtime flow

1. `src/index.js` validates configuration, starts the reusable Chrome-backed
   page fetcher, and runs the Telegram bot.
2. `src/bot.js` long-polls Telegram. A private `/start` from
   `TELEGRAM_OWNER_ID` activates the persistent monitoring loop; all other
   users and group chats are ignored.
3. `src/crawler.js` fetches List.am category pages sequentially through
   `src/browser-fetch.js` and parses each page with `src/list-am.js`.
4. On an empty database, pages 1 through 10 are parsed. On later crawls, cards
   are read newest-first until the first stored item ID is encountered. The
   crawler also stops on an empty page or a repeated page signature to avoid an
   unbounded loop if pagination changes.
5. Newly discovered apartment records are atomically committed before Telegram
   delivery begins. When delivery history is empty, only the latest
   `INITIAL_DELIVERY_LIMIT` records are selected and older initial records are
   durably marked as skipped. The source's newest-first order is then reversed
   so selected messages are delivered by date ascending (earlier first), then
   acknowledged one at a time.

## Persistence

All state is JSON written with a temporary file followed by an atomic rename.
The `.data` directory must be mounted on persistent storage in production.

- `apartments.json` is the source of truth for normalized apartment details and
  crawl metadata. Stored fields are URL, item ID, title, numeric price amount,
  price currency, location, rooms, area in square metres, combined
  current/total floor, posting date, and first-seen timestamp.
- `telegram-deliveries.json` tracks successfully sent item IDs and the
  intentionally skipped portion of the initial history. Discovery is therefore
  durable even if Telegram is unavailable, while selected unsent messages
  remain retryable. Keeping this index separate also avoids rewriting the much
  larger apartment database after every message.
- `telegram-bot.json` stores owner identity, activation, private chat ID, and
  Telegram update offset.
- `chrome-profile/` stores cookies from List.am security verification.

State files include a schema version, type discriminator, and target URL. An
incompatible or target-mismatched apartment state is treated as a fresh crawl
rather than being merged silently.

## Parsing model

The parser scopes card selection to `#contentr`, List.am's Regular Ads
container. It never queries `#tp`, which contains Top Ads. Price is stored as
`{ amount, currency }`; words such as "monthly" are discarded. Rooms, area,
and floor are extracted by position from List.am's comma-separated card
metadata, making parsing independent of localized labels such as `ком.`,
`кв.м.`, and `этаж`. The original posting date is retained as displayed by
List.am.

## Failure handling

- HTTP, browser challenge, malformed state, and Telegram API failures propagate
  to the monitoring loop and are logged as structured JSON.
- Telegram HTTP 429 responses honor `retry_after` and are retried up to three
  times.
- A successful Telegram delivery is persisted immediately. If a later message
  fails, only the remaining messages are retried.
- SIGINT and SIGTERM abort both Telegram polling and browser work, then close
  Chrome cleanly.

## Testing boundaries

Parser tests verify field normalization and Top Ads exclusion. Crawler
integration tests exercise multi-page initial discovery, the first-known-item
stop rule, persistence, and delivery retry behavior. Telegram tests cover
admin-only activation, message formatting, and rate-limit retries.
