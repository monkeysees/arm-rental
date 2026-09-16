# Go offline replay vertical slice

Issue [#30](https://github.com/monkeysees/arm-rental/issues/30) implements the
500-recipient vertical slice of the [shared Node contract](node-replay-baseline.md).
The runtime and deployment in production are unchanged. All experiment work stays
on `experiment/22-runtime-comparison`.

The current executable also implements the [full interruption/recovery and
1,000-recipient follow-up](native-replay-recovery.md). Measurements below retain
the original #30 slice scope; use the follow-up for current acceptance results.

## Reproduce

From the repository root, with Docker and the existing npm dependencies installed:

```bash
# Build and test in a disposable compiler container. Node is needed by the
# integration test to export fixtures and run the independent shared verifier.
# On this Linux host /usr/bin/node is the installed Node executable.
mkdir -p /tmp/arm-rental-go-build
docker run --rm \
  -v "$PWD:/repo" -v /usr/bin/node:/usr/local/bin/node:ro \
  -v /tmp/arm-rental-go-cache:/root/.cache/go-build \
  -v /tmp/arm-rental-go-mod:/go/pkg/mod \
  -v /tmp/arm-rental-go-build:/out \
  -w /repo/experiments/go-replay \
  golang:1.27.1-bookworm@sha256:648f440f42a0958804efb24df176f806f9d353b41f1c0627f666428e40310f6b \
  sh -c 'go test ./... && go vet ./... && go build -buildvcs=false -trimpath -o /out/replay .'

# Shared runner: identical exported HTML/JSON, fresh database, independent oracle.
docker run --rm --network none --cpus 1 --memory 512m --memory-swap 512m \
  -v "$PWD:/app:ro" -v /tmp/arm-rental-go-build/replay:/replay:ro \
  -w /app node:24.18.0-bookworm-slim \
  node experiments/node-replay/run.js --runtime go --go-binary /replay \
  --users 500 --mode virtual > /tmp/go-replay-result.json
node experiments/node-replay/verify.js /tmp/go-replay-result.json

# One virtual run, then three wall runs in fresh offline constrained containers.
# Output must be a new directory. Do not edit source during measurements.
node experiments/node-replay/measure.js /tmp/go-replay-measurements \
  --runtime go --go-binary /tmp/arm-rental-go-build/replay
```

With Go 1.27.1, a C compiler, and Node available locally, `go test ./...`,
`go vet ./...`, and `go build -trimpath -o /tmp/go-replay .` also work from
`experiments/go-replay`. Go compilation and vet provide the prototype's type
checks. The JavaScript project has no separate typechecking command.
The standalone executable accepts `--fixtures EXPORTED_DIRECTORY --database
NEW_SQLITE_PATH --users 500 --mode virtual|wall`; it refuses existing database
files in `--stage exercise`, then exits 23 after interrupted delivery.
`--stage resume` requires the existing database. The shared runner invokes both
stages. Populations 500 and 1,000 are supported; four recipients are diagnostic.

## Implemented boundary

The Go executable reads the exported manifest and HTML, never Node application
code or expected outputs. An HTML5 parser extracts regular category cards and
normalizes IDs, URLs, kind, title, original/canonical price, location, rooms,
area, floor, and source date. Foreign prices use the exported exchange-rate
snapshot. Filters use the exported kind, price, rooms, and location predicates.
The parser intentionally supports the fixture's September Russian date and
attribute shape; this is not a general List.am parser port.

SQLite stores listing payloads once, source revisions per listing, and compact
integer decisions keyed by recipient/listing. Seed loading writes all 6,563
retained decisions per recipient, including absent listings. Crawls compare
normalized payloads and classify only changed revisions. A pending partial index
provides the next payload on demand. Catch-up queries the indexed recent source
window, keeps the latest eight unclassified matches, and persists older matches
as skipped. Decisions are committed before transport; every successful simulated
send receives its own durable acknowledgement before another event is processed.

A single event loop owns the SQLite connection and cycles through recipients,
starting one operation per ready recipient per turn. At most eight simulated
transport operations can occupy slots; rate and retry deadlines release capacity.
The shared 200-attempt/second ceiling, five-token initial recipient burst,
20-message/minute refill, 5 ms transport delay, and catch-up retry injection all
apply. Announcements consume tokens; retries reuse their logical message token.
A separate audit checks observed attempt spacing, retry deadlines, and every
recipient's contiguous logical-message intervals against the token-bucket bound.
Wall mode sleeps against monotonic deadlines; virtual time is behavior evidence
only and has no capacity verdict.

The historical #30 results are identified as `go-500-slice`; current results use
`go-full-contract` and the recovery oracle. The original slice verifier
checks bootstrap plus three unchanged cycles, updates, fresh cards, catch-up
storage/selection/delivery, and a clean reopen followed by an unchanged crawl.
Every recipient's actual payload/order and classifications are compared before
compression into four profiles. The independent oracle checks those observations
against its hand-authored expectations, including all payload fields. Tests also
prove wrong order/currency are rejected, changed USD prices alter exact AMD
filtering, unknown currencies fail, and existing state is refused. Clean reopen
checks acknowledgements before another crawl, verifies zero additional sends,
and checks retained row counts and absent-decision timestamps/statuses.

## SQLite, build, and dependency choices

The prototype uses `database/sql` with one connection and
[`mattn/go-sqlite3` v1.14.49](https://github.com/mattn/go-sqlite3/releases/tag/v1.14.49),
compiling its bundled SQLite through CGO. Tables are STRICT; decisions use
WITHOUT ROWID. WAL, `synchronous=FULL`, and a five-second busy timeout are explicit
connection settings. Transactions never span transport or sleeps. There is no
production-schema compatibility, migration, or durability downgrade. The binary
requires glibc and the ELF loader, not a system SQLite shared library.

Dependency health checked September 16, 2026: go-sqlite3's July 29 release is
v1.14.49, with September 5 repository activity and about 9,200 GitHub stars.
The HTML5 parser is the Go team's
[`golang.org/x/net/html`](https://pkg.go.dev/golang.org/x/net/html), pinned through
`golang.org/x/net` v0.55.0 and `go.sum`; the upstream repository is active through
September 15 with about 3,000 stars. These are established upstream projects;
the pin is an experiment input, not an automatic dependency update policy.
Go 1.27.1 and the compiler image digest are recorded above. Build downloads happen
before measurement; replay containers have networking disabled.

## Departures, omissions, and measurement boundary

The event loop replaces goroutine workers because the useful seam is bounded
local classification and transport scheduling around a single SQLite writer.
It makes fair cursor advancement and deadline ownership explicit. Bulk local
classification uses one transaction per crawl; pending sends remain separate.
Recent-window catch-up selection avoids rereading every retained decision for
every recipient. Both are potentially transferable Node improvements, but their
impact needs a separate production-contract review before adoption.

The original #30 slice did not include forced interruption, a new-process crash recovery
suffix, the returning-absent-card phase, or the 1,000-recipient stress gate. The
full Node verifier retained those requirements; the original Go scope did not
claim to pass them. The follow-up linked above implements them. The original
clean close/reopen was within the same process. The prototype still omits bot
polling/conversations, deletion, filter-release prompts, public channels,
metadata, live source transport, arbitrary date/attribute parsing, category
pagination/watermarks, CBA refresh, migrations, backups, health checks, operational
alerts, deployment, and shutdown integration. Production's external-send/local-
acknowledgement duplicate window remains unresolved.

The primary RAM metric is the entire fresh replay container's cgroup-v2
`memory.peak`: Node coordinator/exporter, Go executable, SQLite/native memory,
filesystem cache, and kernel charges, sampled by the coordinator after verifying
the worker result. It excludes build tools, the host OS,
Docker daemon, production supervision, and live curl. Maximum process RSS, Go
heap, total process CPU, per-phase wall/classification/drain times, and final
SQLite/WAL sizes are secondary. Resource output records actual CPU/memory/swap
limits. Missing cgroup metrics remain unknown. This shorter lifecycle is not
identical to the full Node recovery replay; compare common phases and keep that
qualification on whole-container peak comparisons. No Pi or whole-machine
capacity claim follows from a 512 MiB application cgroup.

### Production transport closure

Curl-impersonate remains the production transport assumption: pinned release
2.2.2 and Safari profile `safari2601`, using the existing checksum-verifying
installer. An offline inventory of the existing runtime artifact's executable
reported curl 8.21.0-IMPERSONATE with embedded BoringSSL, zlib 1.3.1, brotli 1.2.0,
zstd 1.5.7, libidn2 2.3.7, nghttp2 1.63.0, ngtcp2 1.20.0, and nghttp3 1.15.0.
On amd64, `ldd` resolves `libpthread.so.0`, `libc.so.6`, `libdl.so.2`, and
`ld-linux-x86-64.so.2`; the vdso entry is supplied by the kernel. Runtime also
needs the CA certificate bundle, DNS/resolver configuration, writable private
cookie storage, and the redistribution licenses. The existing
`scripts/assemble-runtime-root` resolves the native closure for each supported
architecture. ARM64 closure must be inventoried on its own artifact before a
Go deployment experiment. No live curl request or production state access was
performed; curl memory and subprocess costs are excluded from these measurements.

## Acceptance measurements

The final protocol uses one virtual run and three wall runs at 500 recipients.
The [raw manifest](benchmarks/go-replay/final/manifest.json) records host details,
image identity, exact commands, timestamps, and individual verdicts. Each result
includes source hashes and the compiled binary hash. The host is the same x86-64
four-vCPU KVM guest described in the Node baseline; every measurement container
has one CPU, 512 MiB RAM, networking disabled, and zero swap allowance.

All four runs passed the independent behavior verifier, including every
recipient's payload/order, catch-up announcement/retry/skip decisions, and clean
reopen. The final database retains 3,305,500 decisions: the original 3,281,500
plus 48 new classifications per recipient. The compiled SQLite version is 3.53.4.

| Metric                                                       | Wall-run median |   Range across three runs |
| ------------------------------------------------------------ | --------------: | ------------------------: |
| Primary whole-container peak RAM (MiB)                       |          193.72 |             193.57–194.90 |
| Go process peak RSS (MiB)                                    |           27.41 |               25.22–27.64 |
| Whole Go replay CPU / wall (s)                               |   19.12 / 51.36 | 18.92–19.34 / 51.19–51.62 |
| Routine classification / total wall (s)                      |    0.35 / 11.65 |   0.32–0.35 / 11.55–11.71 |
| Catch-up classification / total wall (s)                     |    1.88 / 27.06 |   1.81–1.91 / 26.77–27.09 |
| Last recipient's first listing, including classification (s) |            9.98 |                9.85–10.14 |
| Permitted first-progress deadline, including tolerance (s)   |            8.68 |                 8.60–8.70 |
| Final SQLite / WAL after clean reopen (MiB)                  |       74.99 / 0 |                 74.99 / 0 |

All three wall runs met the routine 60-second target and application memory
limit. All three missed the 25.025-second catch-up target and the shared
first-progress deadline. The round-robin cursor can defer a retried recipient
until the next sweep, so valid rate/retry behavior and eventual progress do not
guarantee that deadline. These are capacity misses, not relaxed thresholds or a
claim of production readiness. The common capacity evaluator also reproduces
all eight checked-in Node baseline verdicts exactly.

Local verification passed all 425 repository tests on Node 24.18.0, with 94.51%
line and 88.33% branch coverage, plus the Go integration suite, Go vet/compilation,
ESLint, changed-file formatting, and the production deployment-contract check.
The repository-wide formatter flags an existing untracked `.scratch/` Markdown
file; it is outside this task. Standards and specification reviews have no
remaining findings. Production runtime and deployment files are unchanged.

Implementation effort was approximately 25 minutes of elapsed agent work,
including repository/spec inspection, Go implementation, focused tests, two
independent review axes and follow-ups, full repository validation, and repeated
measurement attempts. No human acceptance execution or production operation was
required. The [initial diagnostic failure](benchmarks/go-replay/initial-failure/README.md)
records the output-truncation failure and the discarded measurement attempts;
those attempts are not capacity evidence.
