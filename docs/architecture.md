# Architecture

## Purpose

The application discovers long-term apartment rentals from List.am for a
private owner-only Telegram bot and, when configured, a public Telegram channel.
It reads only the site's **Regular Ads** section and ignores **Top Ads**. The
configured Telegram owner is the only account allowed to activate and control
private monitoring; channel crawling and publication are
activation-independent.

All bot-generated Telegram replies, notification labels, channel hashtags, and
missing-value fallbacks are in Russian. Apartment messages omit the posting
date, although it remains part of the stored record and delivery ordering.
Messages display the source price and currency, while a separately stored
canonical AMD amount drives all price filtering and channel price-band hashtags.

## Production deployment model

The supported initial production topology is a singleton, long-running process
on a Linux host or in one OCI container. Telegram long polling, local JSON state,
and the persistent Chrome profile require one active writer and exclude
serverless or automatically scaled deployment. A supervisor restarts the
process, forwards SIGTERM for graceful shutdown, and mounts `.data` on durable
local storage.

JSON remains the initial production persistence format while the service has
one writer and modest state volume. The deployment must enforce the singleton
constraint, back up and monitor state, and fail closed on incompatible schemas.
SQLite is the intended migration path if state size or write latency crosses the
documented operational thresholds, cross-state transactions are required, or
multiple replicas become necessary.

Production runs on a pinned, supported Node.js LTS release with a reproducible
Chrome or Chromium installation. Chrome normally runs headlessly with its
profile on persistent storage; interactive List.am verification is performed
only while the service is stopped. Secrets are supplied outside the application
artifact, and readiness represents validated Telegram, browser, storage, and
crawl operation rather than process existence alone.

The complete requirements, acceptance criteria, rollout procedure, and
operational runbooks are defined in
[`docs/production-readiness-spec.md`](production-readiness-spec.md).

## Runtime flow

1. `src/index.js` validates private and channel configuration, starts the
   reusable Chrome-backed page fetcher, and runs the Telegram bot.
2. One loop in `src/bot.js` long-polls Telegram. A private `/start` from
   `TELEGRAM_OWNER_ID` activates persistent private monitoring; all other users
   and group chats are ignored. `/filters` and the inline start button expose
   persistent price, room, and hierarchical location controls. Range values are
   collected from the owner's next text message; `/cancel` abandons pending
   input.
3. A crawl loop runs when private monitoring is active or a channel is
   configured. With neither condition, it waits for activation. After apartment
   state is saved, private admission/delivery and `src/channel.js` publication
   run concurrently against separate state files. Channel state, formatting,
   and Telegram failures are isolated from private delivery and the update
   loop.
4. A separate activation-independent loop asks `src/exchange-rates.js` for the
   persisted CBA snapshot. The service refreshes USD, EUR, and RUB together when
   it is at least 24 hours old. A failed refresh keeps the last snapshot active
   and suppresses another attempt for one hour; concurrent refresh requests
   share one in-flight operation.
5. `src/crawler.js` fetches List.am category pages sequentially through
   `src/browser-fetch.js`, which requests the `ru-RU` browser locale, and parses
   each page with `src/list-am.js`.
6. `src/prices.js` maps source currency symbols to ISO codes and converts every
   newly discovered USD, EUR, or RUB price to whole AMD before apartment state
   is committed. It also migrates version 1 apartment records on their next
   crawl. The rate audit attached to a stored apartment is not rewritten by a
   later daily exchange-rate refresh.
7. On an empty database, pages 1 through 10 are parsed. On later crawls, the
   newest posting date in the database is the temporal watermark. Cards are
   read newest-first through every card sharing that minute, and parsing stops
   when an older posting date is reached. Known IDs above the watermark do not
   stop discovery. If stored dates cannot be parsed, the crawl falls back to the
   configured initial page count. Empty pages and repeated page signatures also
   stop the crawl.
8. Known cards encountered before the watermark are compared across source
   title, original price, location, rooms, area, floor, URL, and posting date. A
   change replaces the source fields, preserves `firstSeenAt`, and records
   `updatedAt`. An original amount or currency change is normalized with the
   latest persisted rate and replaces its rate audit; otherwise the prior
   canonical price and audit remain unchanged.
9. Newly discovered and updated records are atomically committed before
   Telegram delivery begins. Private `src/filters.js` admission remains
   terminal: non-matches become filtered, and on an empty private delivery
   history only the latest matching `INITIAL_DELIVERY_LIMIT` are selected.
   Source order is reversed so selected messages are delivered oldest first,
   then acknowledged one at a time.
10. `src/channel.js` independently evaluates environment filters. With no
    compatible channel state, it atomically classifies the full apartment order:
    the latest matching `INITIAL_DELIVERY_LIMIT` become `pending`, older matches
    become `skipped_initial`, and non-matches become `filtered`. Pending posts
    are sent oldest first. Later unseen IDs are terminally admitted as `pending`
    or `filtered`; a changed filter fingerprint is logged without reclassifying
    history.
11. Published channel entries retain Telegram message IDs and SHA-256 hashes of
    the complete rendered message. A changed hash triggers `editMessageText`;
    an unchanged hash, including a posting-date-only source update, makes no
    request. If Telegram reports a missing message, the publisher sends a
    replacement and stores its new ID. Published posts remain managed even when
    later data would not match the current channel filters.

## Filter model

Private filters live in Telegram bot state and default to no restrictions.
Price and room filters each have nullable inclusive `min` and `max` bounds.
Price input and comparison are always in AMD, using the apartment's canonical
`amountAmd`; the private notification still renders `originalAmount` and
`originalCurrency`. Each range submission, location toggle, and reset is
persisted immediately; the interface has no deferred save action.

Location configuration is a static ordered hierarchy in `src/filters.js`.
Ереван is deliberately the first region and its districts are the first
place-level choices. Stable compact IDs (`r:<region>` and
`p:<region>:<place>`) keep Telegram callback data below its size limit and make
multiple selections inexpensive to persist. Selecting a whole region matches
the region and all children. Selecting a child removes the whole-region choice
for that region, while selections in other regions remain intact.
`src/filter-ui.js` owns presentation and keeps matching rules independent of
Telegram.

Channel filters are parsed once from the environment and never read or mutate
private bot state. Price and rooms use the same inclusive exact/open/closed
ranges. Location selectors resolve case-insensitive human-readable region and
place names to the same stable IDs. Multiple locations are OR conditions;
price, rooms, and location are AND conditions. Blank locations default to the
whole Yerevan region, and `all` removes the location restriction. Unknown,
ambiguous, malformed, duplicate, or whole-region/child conflicts fail startup.

## Channel rendering

`formatChannelApartmentMessage` reuses `formatApartmentMessage` verbatim, adds
one blank line, then appends hashtags in region, locality, AMD price band, and
room order. Region inference uses the configured locality hierarchy. Hashtag
text is NFKC-normalized and Russian-lowercased; spaces and hyphens collapse to
underscores, unsupported characters are removed, and duplicate region/locality
tags are omitted.

Positive canonical AMD prices use inclusive 50,000-dram bands. Missing prices,
locations, regions, and rooms receive explicit Russian fallback tags. Rendering
never changes private apartment messages, which continue to show original
source prices without hashtags.

## Persistence

All state is JSON written with a temporary file followed by an atomic rename.
The `.data` directory must be mounted on persistent storage in production.

- `apartments.json` is the source of truth for normalized apartment details and
  crawl metadata. Stored fields are URL, item ID, title, whole-AMD canonical
  price, original amount and ISO currency, location, rooms, area in square
  metres, combined current/total floor, posting date, first-seen timestamp, and
  source-update timestamp when applicable. Foreign prices additionally retain
  the per-unit AMD rate, snapshot fetch time, and CBA effective date.
- `exchange-rates.json` stores one validated, atomic CBA snapshot containing
  USD, EUR, and RUB quote amounts and rates, its fetch timestamp, and its CBA
  effective date. It is reusable across process restarts.
- `telegram-deliveries.json` tracks private successfully sent item IDs and the
  intentionally skipped portion of initial history. Its `filtered` index records
  listings rejected by the private filters active on first admission. Selected
  unsent messages remain retryable.
- `telegram-bot.json` stores owner identity, activation, private chat ID,
  Telegram update offset, optional private filters, and pending range-input mode.
- `telegram-channel-deliveries.json` is a separate channel state machine keyed
  by item ID. It stores terminal `filtered` and `skipped_initial` admissions,
  retryable `pending` entries, and `published` entries with Telegram message ID,
  content hash, classification/publication timestamps, and an edit timestamp
  when applicable. Compatibility binds state to both the List.am URL template
  and channel username; changing the channel starts a fresh classification.
- `chrome-profile/` stores cookies from List.am security verification.

State files include a schema version and type discriminator. Apartment state
also binds to the target URL. Incompatible or target-mismatched apartment state
is treated as a fresh crawl rather than being merged silently.

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

- HTTP, browser challenge, malformed apartment/private state, and private
  Telegram API failures propagate to the monitoring loop and are logged as
  structured JSON.
- CBA responses are accepted only when all three required quotes, their amounts,
  and rates are valid. Refresh failures retain the previous snapshot and retry
  hourly. With no previous snapshot, foreign-price normalization fails before
  apartment state is written.
- Telegram HTTP 429 responses honor `retry_after` and are retried up to three
  times.
- Private and channel classifications are persisted before messages are sent.
  Successful deliveries are acknowledged immediately. A restart cannot turn a
  rejected listing into an unexpected backlog.
- Channel sends fail independently and leave entries pending. Failed edits
  retain their prior acknowledged content hash. Per-operation structured logs
  include operation, item ID, channel ID, known message ID, outcome, and error,
  without including the bot token.
- Telegram `sendMessage` has no idempotency key. A process exit after Telegram
  accepts a channel post but before local acknowledgement is atomically renamed
  into place carries a small at-least-once duplicate risk.
- Replayed Telegram callbacks that render an already-current menu are treated
  as successful, covering the window between saving filter state and the update
  offset.
- SIGINT and SIGTERM abort Telegram polling and browser work, then close Chrome
  cleanly.

## Testing boundaries

Parser tests verify field normalization and Top Ads exclusion. Crawler
integration tests exercise multi-page initial discovery, the posting-date
watermark (including refreshed IDs and equal-minute listings), known-card
updates, persistence, delivery retry, and filter-classification behavior.
Filter tests cover optional/open ranges, regions, places, composed criteria, and
AMD comparison of foreign source prices. Exchange-rate tests cover SOAP parsing,
atomic validation, daily refresh, hourly failure backoff, restart reuse, and
conversion audit fields. Telegram tests cover owner-only activation,
interactive filter configuration, Yerevan-first selection, Russian formatting
and fallbacks, rate-limit retries, and channel/private runtime isolation.
Channel integration tests cover configuration validation and composition,
initial classification/order, partial-send restart recovery, canonical-AMD
hashtags, edits and retries, and missing-message replacement.
