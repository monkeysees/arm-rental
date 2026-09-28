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
sharing that date. This prevents a refreshed known ad from hiding newer
listings that follow it. List.am displays a calendar day rather than a clock
time, so a card is placed at the end of the day it names: the 24-hour delivery
window therefore holds a card for the remainder of its posting day plus a full
day, rather than retiring it a fixed 24 hours after an exact posting minute.

Telegram notifications and new channel posts are sent by date ascending:
earlier listings first, then later listings. Apartments and houses are merged
into that single order rather than being sent category by category.

Private delivery runs at most eight classification or send operations at once.
Recipients take turns one message at a time; a recipient waiting for its rate
limit or Telegram's retry delay releases its slot. Pending listing IDs stay in
SQLite and payloads are loaded for the next send. This trades peak throughput for bounded memory and fair progress as the recipient
population grows.

The [Rust development guide](docs/rust-development.md) describes the production
`rental-app` service, maintenance commands, image build and independent
acceptance checks.

Private delivery makes one promise about time: a user is only ever sent
listings that List.am posted or changed within the last 24 hours. Everything the
crawl discovers is still stored, but an older card waits for its next List.am
update instead of arriving as news. The same bound governs redelivery, so an
already sent listing is sent again only for a change List.am made inside that
window.

Whenever a user starts monitoring — the first time, or again after a pause —
the bot asks whether to send the matching listings of the last 24 hours or to
begin with new listings only. The answer is applied to whatever the database
holds at the next crawl, so a pause never delivers its backlog unannounced. At
most `INITIAL_DELIVERY_LIMIT` listings are sent, oldest first; the default
is 100. Declined listings are marked as skipped and are never released, and
non-matching ones are marked as filtered.

Changing a filter releases nothing on its own. When a filter edit admits
listings that were rejected under the previous filters and are still inside
the 24-hour window, the bot offers them the next time the user opens the main
menu, and sends them only if the user accepts. Declining marks them skipped, so
the same listings are not offered again. A rejected listing still arrives on
its own when List.am changes its data after the rejection and inside the
window, because that is fresh source activity rather than history.

A batch that carries history — the answer to a start, a restart, or an accepted
filter release — is preceded by a message naming how many listings follow. A
routine crawl delivering what it has just discovered sends the listing alone.

## Development requirements

- Rust 1.94.0 with Cargo (the pinned build image is
  `experiments/rust-replay/Dockerfile.build`)
- Python 3.11 or newer, Git, Docker, Bash, jq, GNU tar and coreutils for image
  production and verification
- Linux with the pinned curl-impersonate executable (installed below)
- A Telegram bot token and the numeric Telegram user ID of its owner. The owner
  receives server alerts and is always authorized for private controls.

## Run the Rust service locally

```sh
sudo scripts/install-curl-impersonate /usr/local
cp .env.example .env
```

Set the required values:

```dotenv
TELEGRAM_BOT_TOKEN=123456:replace-with-the-token-from-botfather
TELEGRAM_OWNER_ID=123456789
```

Load the local configuration, initialize an absent SQLite database once, and
start the bot from the repository root:

```sh
set -a
. ./.env
set +a
cargo run --locked --manifest-path experiments/rust-replay/Cargo.toml \
  --bin rental-app -- state:init
cargo run --locked --manifest-path experiments/rust-replay/Cargo.toml \
  --bin rental-app -- serve
```

On later starts, run only the `serve` command. The `NODE_ENV` variable retains
its established name in the Rust configuration contract.

On each process start, the bot attempts to synchronize its source-controlled
Telegram profile descriptions and private-chat command menu. The command menu
publishes the handlers already supported by the application: `/start`, `/menu`,
`/filters`, `/stop`, `/cancel`, `/clear`, and `/delete_my_data`. Metadata
synchronization does not block polling or apartment monitoring. If it fails, the
failure is logged and retried hourly until the first successful synchronization;
the metadata loop then exits for the lifetime of that process.

The welcome text and short profile description include the contact @monkeysees
and the channel «Жилье в Ереване от собственников» (@yerevan_rental).

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

List.am pages use curl-impersonate with the pinned Safari `safari2601` profile,
a private persisted cookie jar, and two-second spacing between requests.
Challenges stop the crawl and apply backoff; there is no JavaScript execution.
See [source operations](docs/source-operations.md) for the stopped-service
`rental-app source:smoke` check and recovery procedure.

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
| `DATA_DIRECTORY`                         | `.data`                                  | Persistent state, HTTP cookies, and singleton lease            |
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
| `TIMEOUT_MS`                             | `30000`                                  | HTTP and API request timeout                                   |
| `EXTERNAL_RETRY_BASE_MS`                 | `1000`                                   | Initial network/5xx retry delay                                |
| `EXTERNAL_RETRY_MAX_MS`                  | `60000`                                  | Retry cap; cannot exceed five minutes                          |
| `CURL_IMPERSONATE_PATH`                  | `/usr/local/bin/curl-impersonate`        | List.am curl-impersonate executable                            |
| `LIST_AM_COOKIE_FILE`                    | `.data/list-am-cookies.txt`              | Private, disposable List.am session cookies                    |
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

Weekly state growth reporting and the
no-deletion retention policy are documented in
[docs/state-maintenance.md](docs/state-maintenance.md).
The same runbook documents the guarded [retired browser profile cleanup](docs/state-maintenance.md#http-session-storage-and-former-profiles), which defaults to a dry-run report and preserves current state and recovery points.

The idempotent Hetzner host bootstrap, immutable infrastructure inputs,
root-only initial secret handling, SSH-only firewall, protected backup volume,
and safe check/dry-run workflow are documented in
[docs/host-bootstrap.md](docs/host-bootstrap.md).

The isolated Rust restore drill was accepted after the schema-3 production
release. A full disruptive production exercise, including a deliberate failed
deployment and host reboot, has a separate authorization boundary in the
[production recovery exercise runbook](docs/production-exercises.md). Its
checked-in evidence template remains pending.

## Quality checks

On Linux with Rust 1.94.0, Python, ShellCheck, Docker and systemd tools:

```sh
scripts/check
```

The [CI guide](docs/continuous-integration.md) describes the required Rust,
Python, production contract and native-image gates.

## Production image

Production runs the Rust `rental-app` image built with pinned Rust 1.94.0 and
checksum-verified curl-impersonate 2.2.2 on Linux AMD64. Its final image
contains the native executable, required shared libraries, certificates and
licenses, with no Node, shell or package manager. The schema-3 Rust release
contract uses Cargo and source-input provenance. See [Rust image build and
acceptance](docs/rust-development.md#production-image-and-provenance) and the
[release runbook](docs/release-and-rollback.md#cargo-provenance-contract).

Build and inspect a schema-3 candidate from the exact checked-out Git revision
using a new empty work directory:

```sh
release_work="$(mktemp -d /tmp/arm-rental-native-release.XXXXXX)"
python3 scripts/native-release.py build \
  --source-revision "$(git rev-parse HEAD)" \
  --work-dir "$release_work" \
  --image-tag rental-apartments-bot:local
docker image inspect --format '{{json .Config.Labels}}' \
  rental-apartments-bot:local
docker run --rm \
  --entrypoint /usr/local/bin/curl-impersonate \
  rental-apartments-bot:local --version
```

The producer needs Python 3.11 or newer, Git, and Docker. Release metadata and
host verification also use Bash, jq, GNU tar, and GNU coreutils (including
`sha256sum`). The publisher binds the scanned immutable image to canonical
source and transport manifests, Compose, and an exact Git operations archive.
The host verifies the schema-3 bundle before deployment.

Mount `/app/.data` on durable storage and supply the production environment.
The image contains the HTTP executable and needs no runtime downloads.

Production startup is fail-closed. `NODE_ENV=production` requires an explicit
absolute `DATA_DIRECTORY` and `CURL_IMPERSONATE_PATH`. Managed state and the
cookie jar must resolve below `DATA_DIRECTORY`; symlink redirection is rejected.

Startup creates or verifies the data tree, proves it is writable, restricts
directories to mode `0700`, and requires the SQLite database to be a safe
regular mode-`0600` file before Telegram polling or crawling starts. The
database is never created by startup; a first installation creates it once with
`rental-app state:init`, which refuses to run over an existing one.

Before either long-running loop starts, preflight validates the installed
database identity/schema/pragmas/target and domain invariants, proves
the singleton lease is held, authenticates the bot with Telegram, checks
optional channel posting/editing permissions, verifies curl-impersonate,
and obtains usable CBA rates before parsing the List.am Regular Ads container.
Unsupported or target-mismatched state fails closed without changing the
database. Each attempt emits a secret-free structured preflight result.
Recoverable source failures keep Telegram controls available while preflight
retries every minute (or after a longer valid `Retry-After`). Only
`status: "ready"` permits crawling; source retries do not exhaust supervisor restarts.

List.am challenges report the non-ready `source_challenge` status. The Rust
`rental-app source:smoke` command requires the service to be stopped before it
acquires the singleton lease. See
[source operations](docs/source-operations.md) and
[startup preflight remediation](docs/startup-preflight.md).

The producer stages only committed build inputs into the Rust container
context. Local environment files, `.data` (including HTTP cookies),
dependencies, coverage, Git metadata, logs, and development caches cannot enter
that context. The Rust image runs as UID/GID 1000 and does not read `.env` at
runtime; the host supplies its root-owned environment file
to Compose.

`compose.production.yaml` defines the stable singleton topology. Host
operations apply `ops/compose.native.yaml` for the immutable Rust image.
On the host, validate the active release's selected Compose files without
rendering the secret environment:

```sh
sudo /opt/rental-apartments/current/ops/service config --quiet
```

Use the [release and rollback runbook](docs/release-and-rollback.md) for host
deployment; it owns the operations lock, snapshot and service handoff.

Keep the host-only `/etc/rental-apartments/env` outside source control, image
build contexts, backups that lack equivalent access controls, and deployment
output. Supply
`TELEGRAM_BOT_TOKEN` through the deployment platform's secret entry mechanism;
the root-owned mode-`0600` file is the dedicated-host fallback. Never put the token in a
command argument, image `ENV` instruction, Compose YAML value, support ticket,
or diagnostic command. Structured application logging defensively redacts
Telegram token shapes, Telegram Bot API URLs, and authorization-like values,
but redaction is not a substitute for keeping secrets out of inputs.

Compose makes the image filesystem read-only, drops all capabilities, and
enables `no-new-privileges`. Durable `/app/.data` holds application state;
`/tmp` and `/sqlite-tmp` are separate 128 MiB in-memory filesystems.
`SQLITE_TMPDIR` directs SQLite scratch files to `/sqlite-tmp`; its database
and WAL remain in `/app/.data`. The service publishes no ports.

The loopback-only health service exposes `/live` for process
liveness and `/ready` (also `/health`) for startup and crawl readiness. The
container healthcheck terminates an unresponsive container after three
consecutive failed liveness probes so the bounded restart policy can recover
it; a single successful probe clears that run, and readiness failures remain
available to private monitoring without causing a restart loop. See
[health and readiness operations](docs/health-readiness.md) for thresholds,
component codes, access, and rollout checks.

Confirm these platform-enforced settings before rollout:

```sh
sudo /opt/rental-apartments/current/ops/service config --quiet
docker inspect --format \
  'user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} ports={{json .NetworkSettings.Ports}}' \
  rental-apartments-bot
docker inspect --format '{{json .HostConfig.Tmpfs}}' rental-apartments-bot
```

The fixed container name prevents scaling, and updates and rollbacks stop the
old process before starting its replacement. Unexpected failures restart at
most five times. The installed systemd unit selects the release's runtime-aware
service wrapper; planned stops send SIGTERM and allow 45 seconds for polling,
state writes, and active HTTP subprocesses to finish cleanup.

If startup reports `ERR_SINGLETON_LOCKED`, do not remove lock files while the
reported process is alive. A socket left by an unclean exit is detected and
recovered automatically.

See [Telegram token rotation](docs/token-rotation.md) for the stop/rotate/start
procedure that retains private and channel delivery acknowledgements.
