# Architecture

## Purpose

The application is a private Telegram bot that discovers long-term apartment
rentals from List.am. It reads only the site's **Regular Ads** section and
ignores **Top Ads**. The configured Telegram owner is the only account allowed
to activate the bot. All bot-generated Telegram replies, notification labels,
and missing-value fallbacks are in Russian. Apartment notifications omit the
posting date, although it remains part of the stored record and delivery
ordering. Notifications display the source price and currency, while a
separately stored canonical AMD amount drives all price filtering.

## Runtime flow

1. `src/index.js` validates configuration, starts the reusable Chrome-backed
   page fetcher, and runs the Telegram bot.
2. `src/bot.js` long-polls Telegram. A private `/start` from
   `TELEGRAM_OWNER_ID` activates the persistent monitoring loop; all other
   users and group chats are ignored. `/filters` and the inline start button
   expose persistent price, room, and hierarchical location controls. Range
   values are collected from the owner's next text message; `/cancel` abandons
   pending input.
3. An activation-independent loop in `src/bot.js` asks
   `src/exchange-rates.js` for the persisted CBA snapshot. The service refreshes
   USD, EUR, and RUB together when it is at least 24 hours old. A failed refresh
   keeps the last snapshot active and suppresses another attempt for one hour;
   concurrent refresh requests share one in-flight operation.
4. `src/crawler.js` fetches List.am category pages sequentially through
   `src/browser-fetch.js`, which requests the `ru-RU` browser locale, and parses
   each page with `src/list-am.js`.
5. `src/prices.js` maps source currency symbols to ISO codes and converts every
   newly discovered USD, EUR, or RUB price to whole AMD before apartment state
   is committed. It also migrates version 1 apartment records on their next
   crawl. The rate and snapshot timestamps used for a foreign price remain
   attached to that apartment; a later daily rate refresh does not rewrite
   already-normalized records.
6. On an empty database, pages 1 through 10 are parsed. On later crawls, the
   newest posting date in the database is the temporal watermark. Cards are
   read newest-first through every card sharing that minute, and parsing stops
   when an older posting date is reached. Known IDs above the watermark (for
   example, refreshed ads) do not stop discovery. If stored dates cannot be
   parsed, the crawl falls back to the configured initial page count. The
   crawler also stops on an empty page or a repeated page signature to avoid an
   unbounded loop if pagination changes.
7. Newly discovered apartment records are atomically committed before Telegram
   delivery begins. `src/filters.js` evaluates the current optional ranges and
   location selection without restricting discovery. Non-matching records are
   durably classified as filtered, so changing filters does not release an old
   backlog. When delivery history is empty, the latest matching
   `INITIAL_DELIVERY_LIMIT` records are selected and older matching records are
   durably marked as skipped. The source's newest-first order is then reversed
   so selected messages are delivered by date ascending (earlier first), then
   acknowledged one at a time.

## Filter model

Filters live in Telegram bot state and default to no restrictions. Price and
room filters each have nullable inclusive `min` and `max` bounds. Price input
and comparison are always in AMD, using the apartment's canonical `amountAmd`;
the private notification still renders `originalAmount` and
`originalCurrency`. Each range submission, location toggle, and reset is
persisted immediately; the interface has no deferred save action.

Location configuration is a static ordered hierarchy in `src/filters.js`.
Ереван is deliberately the first region and its districts are the first
place-level choices. Stable compact IDs (`r:<region>` and
`p:<region>:<place>`) keep Telegram callback data well below its size limit and
make multiple selections inexpensive to persist. Selecting a whole region
matches both the region name and all children. Selecting a child removes the
whole-region choice for that region, while selections in other regions remain
intact. `src/filter-ui.js` owns the Russian inline-keyboard presentation and
keeps matching rules independent of Telegram.

## Persistence

All state is JSON written with a temporary file followed by an atomic rename.
The `.data` directory must be mounted on persistent storage in production.

- `apartments.json` is the source of truth for normalized apartment details and
  crawl metadata. Stored fields are URL, item ID, title, whole-AMD canonical
  price, original amount and ISO currency, location, rooms, area in square
  metres, combined current/total floor, posting date, and first-seen timestamp.
  Foreign prices additionally retain the per-unit AMD rate, the time that
  snapshot was fetched, and its CBA effective date.
- `exchange-rates.json` stores one validated, atomic CBA snapshot containing
  USD, EUR, and RUB quote amounts and rates, its fetch timestamp, and its CBA
  effective date. It is reusable across process restarts.
- `telegram-deliveries.json` tracks successfully sent item IDs and the
  intentionally skipped portion of the initial history. Its `filtered` index
  records listings rejected by the filters active when they first reach
  delivery. Discovery is therefore durable even if Telegram is unavailable,
  while selected unsent messages remain retryable. Keeping this index separate
  also avoids rewriting the much larger apartment database after every message.
- `telegram-bot.json` stores owner identity, activation, private chat ID,
  Telegram update offset, optional filters, and any pending range-input mode.
- `chrome-profile/` stores cookies from List.am security verification.

State files include a schema version, type discriminator, and target URL. An
incompatible or target-mismatched apartment state is treated as a fresh crawl
rather than being merged silently.

## Parsing model

The parser scopes card selection to `#contentr`, List.am's Regular Ads
container. It never queries `#tp`, which contains Top Ads. The parser initially
returns source price `{ amount, currency }`; `src/prices.js` turns it into the
canonical and original-price fields before persistence. Words such as
"monthly" are discarded. Rooms, area, and floor are extracted by position from
List.am's comma-separated card metadata, making parsing independent of
localized labels such as `ком.`, `кв.м.`, and `этаж`. The original posting date
is retained as displayed by List.am.

## Failure handling

- HTTP, browser challenge, malformed state, and Telegram API failures propagate
  to the monitoring loop and are logged as structured JSON.
- CBA responses are accepted only when all three required quotes, their amounts,
  and rates are valid. Refresh failures retain the previous snapshot and retry
  hourly. With no previous snapshot, foreign-price normalization fails before
  apartment state is written.
- Telegram HTTP 429 responses honor `retry_after` and are retried up to three
  times.
- A successful Telegram delivery is persisted immediately. If a later message
  fails, only the remaining messages are retried.
- Filter classification is persisted before matching messages are sent. A
  restart cannot turn previously rejected listings into an unexpected backlog.
- Replayed Telegram callbacks that render an already-current menu are treated
  as successful, covering the window between saving filter state and the update
  offset.
- SIGINT and SIGTERM abort both Telegram polling and browser work, then close
  Chrome cleanly.

## Testing boundaries

Parser tests verify field normalization and Top Ads exclusion. Crawler
integration tests exercise multi-page initial discovery, the posting-date
watermark (including refreshed IDs and equal-minute listings), persistence, and
delivery retry and filter-classification behavior. Filter tests cover optional
and open ranges, whole regions, multiple places, composed criteria, and AMD
comparison of foreign source prices. Exchange-rate tests cover SOAP parsing,
atomic validation, daily refresh, hourly failure backoff, restart reuse, and
conversion audit fields. Telegram tests cover admin-only activation,
interactive filter configuration, Yerevan-first selection, Russian message
formatting and fallbacks, and rate-limit retries.
