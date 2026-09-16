# Rust offline replay vertical slice

Issue [#31](https://github.com/monkeysees/arm-rental/issues/31) implements the
500-recipient slice of the [shared replay contract](node-replay-baseline.md).
All changes stay on `experiment/22-runtime-comparison`; production runtime and
deployment are unchanged.

## Reproduce

From the repository root with Docker and npm dependencies available:

```bash
docker build -t arm-rental-rust-replay-build \
  -f experiments/rust-replay/Dockerfile.build .
mkdir -p /tmp/arm-rental-node-24.18
docker run --rm -v /tmp/arm-rental-node-24.18:/out \
  node:24.18.0-bookworm-slim cp /usr/local/bin/node /out/node
docker run --rm -v "$PWD:/repo" \
  -v /tmp/arm-rental-node-24.18/node:/usr/local/bin/node:ro \
  -v /tmp/arm-rental-rust-cargo:/usr/local/cargo/registry \
  arm-rental-rust-replay-build \
  sh -c 'cargo fmt --check && cargo check --locked && cargo test --locked && cargo clippy --locked --all-targets -- -D warnings && cargo build --locked --release'

# Shared coordinator, offline constrained container, independent behavior oracle.
docker run --rm --network none --cpus 1 --memory 512m --memory-swap 512m \
  -v "$PWD:/app:ro" \
  -v "$PWD/experiments/rust-replay/target/release/rental-replay:/replay:ro" \
  -w /app node:24.18.0-bookworm-slim \
  node experiments/node-replay/run.js --runtime rust --rust-binary /replay \
  --users 500 --mode virtual > /tmp/rust-replay-result.json
node experiments/node-replay/verify.js /tmp/rust-replay-result.json

# Fresh output directory; one virtual and three wall runs, sequentially.
node experiments/node-replay/measure.js /tmp/rust-replay-measurements \
  --runtime rust \
  --rust-binary "$PWD/experiments/rust-replay/target/release/rental-replay"
```

Local Rust 1.94.0 with a C compiler and Node 24.18.0 can run the Cargo commands
from `experiments/rust-replay`. Cargo check and Clippy supply type/static checks;
the JavaScript repository has no separate typechecking command. Cargo.lock pins
all dependencies. Build downloads happen before measurement; replay containers
have networking disabled. The standalone binary accepts `--fixtures DIRECTORY
--database NEW_SQLITE_PATH --users 500 --mode virtual|wall`. Four recipients are
supported for diagnostics; 1,000 is explicitly refused until the recovery work.
Existing database paths, including symlinks, are refused before opening SQLite.

## Implemented boundary

The Rust executable consumes exported HTML and manifest inputs, not expected
outputs or Node application code. HTML5 parsing selects Regular Ads under
`contentr`, normalizes IDs, URLs, kind, title, source/canonical price, location,
rooms, area, floor and source day. Foreign prices use the exported CBA snapshot.
The fixture parser deliberately supports September Russian dates and the fixture
attribute shape; arbitrary List.am parsing is outside this slice.

SQLite stores one listing payload and source revision per listing. Compact
integer decisions retain all 6,563 initial rows per recipient, including absent
listings. Routine crawls classify only changed source revisions; catch-up queries
an indexed recent-source window and keeps the latest eight matching unclassified
cards, marking earlier matches skipped. A partial pending index loads only the
next payload for a recipient. Every successful simulated send commits its own
acknowledgement before processing the next event.

A single event loop owns SQLite and advances a round-robin recipient cursor.
At most eight transport operations occupy slots; rate and retry waits release
slots and store deadlines. The shared global attempt rate, per-recipient token
bucket, announcements, latency and retry injection all apply. Wall mode sleeps
against monotonic deadlines; virtual mode establishes behavior only. An audit
checks global attempt spacing, retry deadlines, and all contiguous intervals of
logical recipient messages against the token-bucket bound.

The shared native oracle distinguishes `rust-500-slice` from the full Node
recovery contract. It checks every recipient before compression into four
profiles, then verifies payloads, ordering, decisions, announcements and retries
against independently authored expected outputs. Clean reopen checks persisted
acknowledgements before another unchanged crawl, requires zero additional sends,
and verifies retained decision counts and absent-history status/timestamps.
Focused executable tests also mutate source USD prices, reject unknown currency,
check slower transport/retry behavior, refuse existing state and stress scope,
and demonstrate that the oracle rejects wrong ordering and currency. The runner
flushes its entire JSON result beyond the pipe-buffer boundary.

## SQLite, dependencies and departures

Rust 1.94.0 is pinned with the compiler image digest in `Dockerfile.build`.
`rusqlite` 0.40.2 compiles bundled SQLite through `libsqlite3-sys`; there is no
system SQLite dependency. STRICT tables, WITHOUT ROWID decisions, WAL,
`synchronous=FULL`, and a five-second busy timeout are explicit. Transactions
contain only local classification/seed/crawl work, never transport or sleeps.
This is a separate experimental schema, with no production compatibility or
migration claim.

Dependency health checked September 16, 2026: [rusqlite](https://github.com/rusqlite/rusqlite)
released 0.40.2 on August 8, was active September 14, and has about 4,400 stars;
[scraper](https://github.com/rust-scraper/scraper) released 0.27.0 on May 11, was
active September 14, and has about 2,400 stars. [Serde](https://github.com/serde-rs/serde),
[serde_json](https://github.com/serde-rs/json), and [Chrono](https://github.com/chronotope/chrono)
are established projects with August/September activity and about 10,800, 5,600,
and 3,900 stars respectively. Lockfile versions are Serde 1.0.229,
serde_json 1.0.151 and Chrono 0.4.45. Pins record experiment inputs rather than
an automatic update policy.

The single-owner event loop avoids an async runtime around one SQLite writer.
Prepared statements are reused; classification batches commit once per crawl;
pending payloads stay in SQLite. Recent-window selection and prepared-statement
reuse are potentially transferable Node improvements, subject to a separate
production behavior review. Delivery observations are retained for the oracle,
so their memory is part of this experiment, not a production queue design.

Omissions: forced interruption, new-process crash recovery, returning absent
cards, 1,000 recipients, bot polling/conversations, deletion and filter-release
prompts, public channels, live HTTP and CBA refresh, arbitrary date parsing,
pagination/watermarks, migrations, backup, health/alerts, deployment and shutdown
integration. Clean reopen is in the same process. The external-send/local-ack
at-least-once duplicate window remains unresolved.

## Production transport and resource boundary

Curl-impersonate 2.2.2 with Safari `safari2601` remains the production transport
assumption. The [Go slice inventory](go-replay-slice.md#production-transport-closure)
describes the same amd64 runtime artifact: curl 8.21.0-IMPERSONATE with embedded
BoringSSL, zlib 1.3.1, brotli 1.2.0, zstd 1.5.7, libidn2 2.3.7, nghttp2 1.63.0,
ngtcp2 1.20.0 and nghttp3 1.15.0; native dependencies are libpthread, libc, libdl
and the ELF loader. CA certificates, resolver configuration, private writable
cookie storage and licenses remain required. `scripts/assemble-runtime-root`
resolves that closure. ARM64 needs its own inventory before any deployment test.
No live source/Telegram requests or production state access occur here.

Primary RAM is fresh-container cgroup-v2 `memory.peak`, including the Node
coordinator/exporter, Rust executable, SQLite/native allocations, filesystem cache
and kernel charges. It excludes build tools, host OS, Docker daemon, production
supervision and live curl. Secondary fields report Linux process RSS high-water,
single-thread CPU runtime from `/proc/self/schedstat`, phase wall/classification/
drain times and SQLite/WAL sizes. Actual cgroup CPU, memory and swap limits are
recorded; unavailable metrics remain unknown. The shorter lifecycle matches the
Go slice, not the full Node crash-recovery workload. These measurements do not
establish whole-machine or Pi fit.

## Acceptance measurements

Measurements and final validation are recorded after review below.
