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

## Reproduce

Use the pinned Rust 1.94.0 builder and Cargo registry described in
[Rust replay](rust-replay-slice.md), Node 24.18.0 on the external harness, Linux
Docker with cgroup v2 and readable host `/proc`. Build the existing scratch native
image `arm-rental-working-set:local` as described in the
[retained-history experiment](retained-history-working-set.md) and its linked
[artifact recipe](runtime-comparison.md#reproduce). The new image replaces only
its Rust executable. The acceptance manifest records the resulting immutable
image ID and exact source hashes. The packaged curl hash must match the retained
original transport result, not just its version string.

```bash
docker run --rm -w /repo/experiments/rust-replay \
  -v "$PWD:/repo" \
  -v /tmp/arm-rental-rust-cargo:/usr/local/cargo/registry \
  arm-rental-rust-replay-build \
  sh -c 'cargo fmt --check && cargo check --locked --offline --all-targets && cargo clippy --locked --offline --all-targets -- -D warnings && cargo build --locked --offline --release'
docker build -t arm-rental-native-service:local \
  -f experiments/native-service/Dockerfile .
node experiments/native-service/check.js /dev/shm/native-service-acceptance
```

Every output directory must be new. The retained run uses a host tmpfs under
`/dev/shm` for synthetic state because the host disk was nearly full; ensure
at least 256 MiB of free space there. SQLite FULL/WAL semantics and process
restart are exercised, but tmpfs cannot establish persistence across host power
loss or physical storage latency.

The harness exports fixtures, creates an
internal network, runs negative transport checks followed by one 500-recipient
wall exercise/resume, checks the oracle and its corrupted-output rejection, and
exports the image filesystem for inspection. It removes its containers/network
in cleanup; generated synthetic SQLite state and image tar remain in the chosen
output directory for investigation and can be deleted afterward. No production
mounts or credentials are used. Do not overlap this run with other benchmarks.

The service image contains no Node, npm, shell or package manager. Bundled SQLite,
curl, CA certificates and their native library closure remain. `libc` is now a
direct Cargo dependency for POSIX signals, using the exact 0.2.189 version already
present in the locked dependency graph; this adds no new crate download/version.

## Accounting and limitations

The service has one CPU, a 512 MiB cgroup memory limit and no swap. Its cgroup
includes Rust, SQLite, curl children, health-command processes, database and
response-file cache and kernel charges. The fixture peer, Node oracle/coordinator,
Docker daemon and host OS are outside that boundary. Docker exec can briefly
charge its `runc` launcher/init helpers to the service as well. This is not a whole-machine
memory measurement. The fixture peer reads original fixture files; fetched
response files are written by the service, so their cache belongs to the service.

The harness samples cgroup/process observations every 100 ms. Native transport
samples child VmHWM every 5 ms; this is a lower bound on subprocess peak RSS since
a short-lived child can finish between samples. The cgroup's kernel peak covers
shorter service peaks up to its final observed sample; teardown can occur between
samples. The response cap and sequential child ownership are structural bounds,
not bounds inferred from process sampling. These acceptance runs are not repeated
performance benchmarks or evidence of an optimization over the previous worker.

Live Telegram/CBA/source integration, full List.am parsing, private conversation,
channel parity, migrations, backups, general arbitrary-interruption recovery,
production readiness semantics and deployment supervision remain out of scope.

## Acceptance record

The retained [acceptance manifest](benchmarks/native-service/acceptance.json),
[oracle result](benchmarks/native-service/result.json) and
[summary with source/report hashes](benchmarks/native-service/summary.json)
cover seven fresh service containers: stopped startup, HTTP failure, declared
oversize, chunked oversize, incorrect probe body, and full exercise/resume.
All expected exit codes pass. Every downloaded manifest/HTML file was also
compared byte-for-byte with its original exported fixture after the run.

The 500-recipient wall exercise receives SIGINT during the `updated` delivery
phase, with curl active and native health responding. Curl is cancelled/reaped,
readiness fails while draining, and shutdown exits 0 with 3,000 durable pending
rows. Resume exits 0 through the native shutdown command after preserving
acknowledgements, draining the suffix and retaining all **3,321,500 decisions**.
The unchanged oracle passes and rejects deliberately reversed delivery order.
The earlier startup stop separately checks SIGTERM and child cancellation.

The packaged curl SHA-256 is
`9775f5c719cc7649d0da41a786ef5e25da886514c547399a6d86b6038f105786`, identical
to the original retained curl measurement. An exported image filesystem has
curl/certificates and no Node, npm, shell or package-manager executables.
The largest fetched body is 868,024 bytes; the declared cap is 8,388,608 bytes
and curl concurrency is one. Service cgroup peaks observed through the final
sample are **105.55 MiB** for exercise and **23.18 MiB** for resume; sampled
child RSS high-water marks are **3.53 MiB** and **9.33 MiB**, respectively.
These are single acceptance observations, not repeated performance results.

Resume reuses warm synthetic state after the exercise cgroup exits. Existing
file/tmpfs cache charges can remain with the removed cgroup's ancestor rather
than transfer to the new service; its smaller measured peak is not the full
resident-database budget or evidence of reduced memory requirements. The two
peaks must not be treated as comparable cold starts or summed into a host budget.

Earlier runs exposed harness assumptions about short-lived processes and Docker
exec helpers, plus the host disk-space failure described above. The summary
retains these failures explicitly. The review-driven stale-socket regression was
observed failing before moving fixture-directory setup ahead of socket binding;
it passes after the fix. Independent Standards and Spec review findings were
resolved before final acceptance.

Final verification uses Node 24.18.0 and Rust 1.94.0: **433/433 Node tests**
pass with **94.53% line / 88.33% branch coverage**, and all **14 Rust integration
tests** pass. Cargo check across all targets, Clippy with warnings denied,
Rust formatting, Prettier, and the production-contract validator pass. ESLint
passes with the pre-existing untracked `.scratch/` investigation excluded.
The first full Node run caught the previous ticket's documentation phrase
about adding files to Git in a deployment-terminology guard; changing it to “after adding
the files to Git” passes both the targeted test and the full rerun. Production
runtime and deployment files remain unchanged. Final independent review totals:
**Standards: 0 remaining findings; Spec: 0 remaining findings**.
