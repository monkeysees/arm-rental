# Rust offline replay vertical slice

Issue [#31](https://github.com/monkeysees/arm-rental/issues/31) implements the
500-recipient slice of the [shared replay contract](node-replay-baseline.md).
All changes stay on `experiment/22-runtime-comparison`; production runtime and
deployment are unchanged.

The current executable also implements the [full interruption/recovery and
1,000-recipient follow-up](native-replay-recovery.md). Measurements below retain
the original #31 slice scope; use the follow-up for current acceptance results.

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
supported for diagnostics; 500 and 1,000 run the full recovery contract.
`--stage exercise` refuses existing database paths and exits 23 after interrupted
delivery; `--stage resume` requires existing state. The shared runner invokes both.

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

The historical #31 results use `rust-500-slice`; current results use
`rust-full-contract` and the full recovery oracle. Both check every recipient before compression into four
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
system SQLite dependency. On this amd64 build, `ldd` reports libgcc_s, libm,
libc and the ELF loader; the executable is not fully static. STRICT tables,
WITHOUT ROWID decisions, WAL,
`synchronous=FULL`, and a five-second busy timeout are explicit. Transactions
contain only local classification/seed/crawl work, never transport or sleeps.
This is a separate experimental schema, with no production compatibility or
migration claim. The measured bundled SQLite is 3.53.2 (the Go slice used
3.53.4); driver, SQLite version and statement reuse differ, so timings cannot
be attributed to language alone.

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

The original #31 slice omitted forced interruption, new-process crash recovery,
returning absent cards and 1,000 recipients; the follow-up linked above adds them.
Remaining omissions: bot polling/conversations, deletion and filter-release
prompts, public channels, live HTTP and CBA refresh, arbitrary date parsing,
pagination/watermarks, migrations, backup, health/alerts, deployment and shutdown
integration. The original clean reopen was in the same process. The external-send/local-ack
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

All four 500-recipient runs passed the independent oracle: one virtual run and
three wall runs. The [raw manifest](benchmarks/rust-replay/final/manifest.json)
records exact commands, host/image identity, timestamps and individual verdicts;
[wall run 1](benchmarks/rust-replay/final/500-wall-1.json),
[run 2](benchmarks/rust-replay/final/500-wall-2.json),
[run 3](benchmarks/rust-replay/final/500-wall-3.json) and the
[virtual result](benchmarks/rust-replay/final/500-virtual-1.json) include source
and executable hashes. All hashes were checked against the final implementation.
Containers ran sequentially after tests finished on the same x86-64 KVM host as
the Node/Go baselines, with one CPU, 512 MiB RAM, zero swap and networking disabled.

| Metric                                                     | Wall-run median |   Range across three runs |
| ---------------------------------------------------------- | --------------: | ------------------------: |
| Whole-container peak RAM (MiB)                             |          185.72 |             183.88–185.90 |
| Rust process peak RSS (MiB)                                |           16.09 |               16.04–16.22 |
| Whole Rust replay CPU / wall (s)                           |    6.22 / 38.70 |   6.15–6.25 / 38.65–38.74 |
| Steady unchanged crawl wall (ms)                           |           43.26 |               42.85–45.29 |
| Routine classification / total wall (s)                    |   0.054 / 10.39 | 0.052–0.067 / 10.36–10.40 |
| Catch-up classification / total wall (s)                   |    1.44 / 24.81 |   1.44–1.50 / 24.80–24.85 |
| Last recipient first listing, including classification (s) |            9.06 |                 9.05–9.11 |
| Permitted first-progress deadline, including tolerance (s) |            8.19 |                 8.19–8.25 |
| Final SQLite / WAL after reopen (MiB)                      |       74.99 / 0 |                 74.99 / 0 |

Steady wall time first takes each run's median of its three post-bootstrap
unchanged cycles. Routine totals combine update and fresh-card phases. Each run
retained 3,305,500 decisions, delivered 4,000 catch-up listings with 500
announcements and 50 retries, then sent zero listings after clean reopen.

All three wall runs met routine classification/crawl, application-memory and
25.025-second catch-up targets. **All three missed the first-progress fairness
deadline.** The round-robin cursor can defer a retried recipient to the next
sweep; bounded slots, valid rate/retry behavior and eventual progress do not
ensure this latency target. The miss remains evidence for the parent runtime
comparison, not a relaxed threshold or a production-readiness claim. This ticket
implements and measures the requested slice; the broader runtime decision and
recovery/stress gates remain open.

Verification: all 425 repository tests passed on Node 24.18.0 with 94.57% line
and 88.39% branch coverage. Rust's five executable tests, Cargo check, Clippy with
warnings denied, formatting and release compilation passed. The Go integration
suite and vet passed through the refactored native runner, as did the focused
Node replay test, ESLint, changed-file Prettier and the production deployment
contract validator. Independent standards and spec reviews have no outstanding
findings; a review suggestion replaced bare classification codes with an enum.
Production runtime/deployment files are unchanged.

Implementation effort was approximately 15 minutes of elapsed agent work through
completed acceptance measurements, covering investigation, implementation,
focused tests, two review axes, repository validation and four constrained runs.
Initial focused checks caught compiler integer conversions, missing runner
integration and the fixture weekday prefix; those were fixed before measurement.
No measurement run failed behavior verification, and no human acceptance
execution or production operation was required.
