# Offline native Rust service

Issue [#39](https://github.com/monkeysees/arm-rental/issues/39) adds an experimental
native service on `experiment/22-runtime-comparison`. Production code, state and
deployment remain unchanged. This is local x86-64 acceptance evidence, not a
measurement of Raspberry Pi performance or a production replacement.

## Boundary and lifecycle

The same Rust executable provides `serve`, `health` and `shutdown`. It downloads
the shared manifest and HTML through the retained curl-impersonate 2.2.2 release
executable with the `safari2601` profile, then runs the existing normalization,
SQLite classification, simulated delivery and per-message durable acknowledgements.
The shared independent Node oracle runs outside the service container.

The fixture peer runs in a separate Node container on an internal Docker network.
It sets a cookie on the manifest response and requires that cookie on subsequent
requests. There is no live source, Telegram or CBA access. The Rust executable
allows only the local fixture hostname or loopback HTTP with an explicit port,
disables proxies, does not follow redirects and permits only plain fixture
basenames. It fetches at most 64 distinct pages, each capped at 8 MiB, with one
curl child and a five-second request deadline. Curl writes to a temporary file;
no unbounded stdout/stderr pipe is collected. Successful responses are renamed
before parsing; the fixture directory and cookie jar are private to the service
user. The existing parser still retains workload-sized normalized collections.
These transport limits do not constitute a general parser memory guarantee.

While SQLite and simulated delivery run, a separate native thread repeatedly
fetches a delayed, cookie-protected probe with an exact expected body. This tests
real curl/delivery/health overlap; it is explicitly a transport probe, not an
additional source crawl. Fixture pages are downloaded before replay. No claims
about overlapping production crawl transactions are made.

The Unix socket health command exits nonzero during fixture fetching, transport
failure, shutdown or absence of a live listener. It reports `active` during the
replay, `pending-restart` after the exercise and `drained` after resume. Readiness
means this offline worker has validated its inputs and is running or has reached
a healthy replay boundary; it does not probe Telegram, CBA or a production source.
Socket clients have bounded reads and deadlines, and a slow client cannot block
SQLite or curl activity.

SIGTERM, SIGINT and the native `shutdown` command all request draining. The
signal handler only sets an atomic flag. Curl is killed and reaped promptly;
SQLite/delivery finish the current **whole replay stage**, close SQLite and write
the stage report before process exit 0. This can take tens of seconds at 500
recipients; operators must allow at least 120 seconds before escalating. Shutdown
is not cancellation at an arbitrary send boundary. A stop during initial fixture
fetching creates no database. A stopped exercise retains 3,000 pending decisions;
`--stage resume` verifies the acknowledged prefix and sends the suffix without
repeating acknowledgements. Arbitrary SIGKILL recovery halfway through a stage is
outside this adapter's contract; the older worker's exit-23 boundary and tests
remain available.

The result retains the oracle's historical `uncleanExitCode: 23` field as its
replay-contract marker. Actual service exits and delivered signals are recorded
separately: these service acceptance runs shut down gracefully with code 0.
The oracle marker is not evidence of a service crash.

See the [Rust development guide](rust-development.md) for build and acceptance tooling.
