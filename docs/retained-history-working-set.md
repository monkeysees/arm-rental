# Retained-history working set

Issue [#38](https://github.com/monkeysees/arm-rental/issues/38) changes only the
Rust replay on `experiment/22-runtime-comparison`. The complete 500-recipient
history, production runtime, parser and deployment contracts remain intact.

## Profile before choosing the change

The read-only `working_set` Cargo example uses the worker's pinned bundled
SQLite and listing decoder. It records query plans, VM steps, sorts, full-scan
steps, decoded payload counts/bytes, SQLite connection cache counters and
`dbstat` table/index sizes. Each query experiment opens a fresh connection;
the kernel file cache is warm. These diagnostics are not service RAM, cold-disk
or Pi measurements. Query timing includes iteration and decoding, but excludes
writes, transport, checkpointing and connection setup.

The input is an isolated baseline 500-recipient exercise database. Two backups
remove only its 20,000 catch-up decisions to expose the same 40 candidates per
recipient; the native replay's real history is never pruned. One copy keeps the
original `(posted,id)` index, the other replaces it with `(posted,id,revision)`.
The interrupted pending suffix remains available for delivery-query profiling.
This is a diagnostic query workload, not a replacement acceptance fixture.
The [raw profiles](benchmarks/retained-history/profile/) and their manifest
record that transformation and the exact input/source hashes.

At the original 2,000 KiB cache target, catch-up decodes 20,000 payloads (40 for
each of 500 recipients). Merely reducing the cache to 512 KiB increases cache
misses from 16,934 to 229,508. A covering revision index and a query returning
only eligible IDs/revisions keep misses at 16,539 with the smaller cache; a
transaction-local payload cache decodes only 40 listings. The covering plan
reads the recent index and probes the decision primary key without visiting
the listing payload table for already classified revisions. Classification
still checks every recent candidate against each recipient's own history.

The diagnostic history fingerprint scans 3,285,500 retained rows in roughly
0.9–1.0 seconds. The native acceptance worker retains its complete ordered
fingerprints, absent-history validation and count checks across interruption.
Those full scans are a real part of the measured worker, including their
kernel cache charges; removing them would weaken the recovery evidence.

Sorting pending IDs before fetching the next payload offered no useful gain
on the six-pending-per-recipient diagnostic (roughly 3–4 ms for 500 reads).
The existing partial pending index and delivery query are therefore retained.
No additional decision index is introduced.

## Implemented boundary

The recent-listing index now covers revision. Opening an older experimental
state creates the new index and removes the old one; decision rows and payloads
are unchanged. New databases create only the covering index. This is an
experimental index transition, not a production migration.

Catch-up first materializes compact eligible `(id,revision)` pairs for one
recipient, newest first. It finishes that decision-dependent cursor before
writing decisions. Payloads are loaded on demand into a transaction-local map
with at most 128 entries; reaching the limit clears the map. Every matching
candidate beyond the initial limit is still persisted as skipped and every
nonmatch as filtered. Transport reads the resulting pending work oldest first.
The map is dropped before transport and cannot cross a source update or restart.
The 128-entry bound is a count, not a byte ceiling for arbitrarily large titles;
the input parser and per-recipient compact key vector retain their existing
workload-dependent bounds.

Every connection requests a 512 KiB SQLite page-cache target. This is not a hard
RSS cap. The diagnostic cache allocation is about 0.51 MiB during classification
and 1.02 MiB after the history scan, versus 2.01 and 4.01 MiB at the old target.
SQLite's [connection cache counters](https://www.sqlite.org/c3ref/c_dbstatus_options.html)
measure approximate pager heap allocation and page hits/misses. They do not
measure Linux's filesystem cache. A SQLite miss can be served from warm kernel
cache without physical read I/O. Cgroup `memory.stat` file/anonymous/kernel
charges and `io.stat` are reported separately and overlapping counters are not
added together.

Seed batching, WAL checkpoints, FULL synchronization, atomic classification,
per-send acknowledgements, rate limits, retry waits and fair scheduling remain
as described in [the storage policy](native-storage-policy.md). The classification
observations additionally report decoded and peak retained history payloads.

## Acceptance and resource comparison

The before/after service results use the existing
[service-only accounting boundary](service-replay.md): fresh one-CPU,
536,870,912-byte, no-swap cgroups with offline synthetic fixtures and local
transport. Holder, Rust, SQLite, database/WAL cache and kernel charges are
inside; the Node coordinator/oracle, Docker daemon and host OS are outside.
Runs are sequential, with no concurrent tests, builds or benchmarks. This is
local x86-64 KVM/Docker evidence, not measured ARM/Pi performance or a
production-ready native service.

The [before manifest](benchmarks/retained-history/before/manifest.json),
[after manifest](benchmarks/retained-history/after/manifest.json) and
[numeric summary](benchmarks/retained-history/summary.json) retain one virtual
gate and three independent wall repeats per version. All eight pass the
independent oracle, and all six wall runs pass the unchanged capacity and
fairness gates. Each full replay retains 3,321,500 decisions and ends with zero
pending rows. Source, binary, image, fixture and result hashes are recorded.
Baseline is `d83ebea3`; candidate source hashes identify the exact measured edits.

Values below are medians of three wall runs:

| Metric                            |        Before |         After |
| --------------------------------- | ------------: | ------------: |
| Service lifetime peak (MiB)       |        101.92 |        101.79 |
| Peak range (MiB)                  | 101.90–102.02 | 101.79–101.79 |
| Process peak RSS (MiB)            |         16.00 |         16.34 |
| Post-bootstrap idle (MiB)         |         91.18 |         91.39 |
| Idle anonymous charge (MiB)       |         11.30 |         11.42 |
| Idle file/cache charge (MiB)      |         77.05 |         77.07 |
| Idle kernel charge (MiB)          |          2.70 |          2.70 |
| Service CPU (s)                   |          9.88 |          9.74 |
| Cgroup block reads (MiB)          |             0 |             0 |
| Cgroup block writes (MiB)         |        359.73 |        359.61 |
| Final database (MiB)              |         76.77 |         76.70 |
| Sampled database + WAL peak (MiB) |         80.70 |         80.63 |
| Sampled WAL peak (MiB)            |          4.60 |          5.22 |
| Seed wall time (s)                |          3.53 |          3.56 |
| Catch-up classification (s)       |         1.381 |         1.147 |
| Complete catch-up (s)             |        24.760 |        24.513 |
| Catch-up transport drain (s)      |        23.314 |        23.316 |
| Catch-up queue age p95 (s)        |        23.672 |        23.432 |
| Resumed transport drain (s)       |        15.395 |        15.401 |

Classification is about 17% faster and total service CPU about 1.4% lower.
The component cache allocation and redundant decoding fall, but these runs do
**not** demonstrate a material service/process RAM or block-I/O reduction.
Process peak RSS and idle anonymous memory increase slightly. Fixture parsing,
allocator retention and the retained history's file cache still dominate this
workload; the smaller SQLite target is not a whole-process memory guarantee.
The cache bound limits future decoded catch-up growth without deleting history.
In the diagnostic, the newly built covering index occupies 114,688 bytes versus
122,880 for the original incrementally built index; record payload rises from
88,352 to 93,882 bytes while page slack falls. Index creation order matters to
occupancy. The final database also reflects a different decision insertion
order/page occupancy. No VACUUM or decision-table rewrite was performed.

Block reads are zero on these warm-image, newly generated local databases,
which says nothing about cold-storage cost. File-length observations are sampled
every 250 ms and can miss brief WAL peaks; native storage observations retain
transaction-boundary WAL lengths. Differences between sampled peaks are not
evidence of changed WAL limits. Complete raw worker outputs and cgroup samples
are retained alongside each result.

The [cross-version recovery record](benchmarks/retained-history/recovery/manifest.json)
also resumes an untouched baseline database with the candidate executable after
exit 23, replacing its old index and passing the full independent oracle. The
added CLI regression exposes 200 eligible listings, exceeding the 128-payload
cache: newest selection, skipped/filtered older updates, bounded retention and
unclean recovery all pass. The ordinary 500-recipient run decodes 40 catch-up
payloads once each; full history fingerprints and absent decisions remain checked.

## Further compaction and migration cost

The original diagnostic decision table occupies 78,606,336 bytes, including
57,747,235 bytes of payload and 10,724,313 unused bytes after the explicitly
recorded diagnostic row removal. Decisions already use compact integer columns and a
[WITHOUT ROWID primary key](https://www.sqlite.org/withoutrowid.html); adding a
second full decision index would duplicate much of the dominant history.
The listing payload table is about 1.56 MiB and its recent index about 0.12 MiB.
Removing decoded payloads cannot remove the much larger history file cache.

A VACUUM-style rebuild could reclaim page slack at the cost of copying the
whole database, temporary free space, write I/O and downtime; it would not
remove per-decision semantic state. Deduplicating timestamps/revisions or
packing decision ranges might reduce the remaining record payload, but would
require a versioned state migration, restartable conversion, snapshot rollback,
new update/deletion logic and proof for per-recipient skipped/filtered/notified
states, absent listings and source-update redelivery. No historical rows can be
dropped, and arithmetic reconstruction from this fixture's ID patterns is not a
valid general state representation. Broader compaction is a separate experiment
if a lower total footprint is required; this ticket does not justify a rewrite.

## Transfer to Go and Node

Go's `Store.classify` uses the same recent-listing join and repeatedly decodes
payloads into a per-recipient slice. The covering index, eligible-key selection
and a bounded transaction-local decoded cache are directly transferable design
candidates. The smaller cache should be adopted only with that covering query
and measured using Go's bundled SQLite, GC and full recovery replay; the Rust
numbers are not claimed as measured Go savings. Go also lacks the Rust seed/WAL
policy, so its total service footprint cannot be predicted from this change.

Node already narrows routine work by source sequence and stages durable pending
IDs. `matchingHistory` shares decoded history across recipients and caches at
most eight filter variants, so applying the native cache mechanically would
undo some existing reuse. Its full retained listing projection could instead
be replaced by bounded iteration and compact matching IDs at an explicit
history/filter reconciliation boundary. Production history additionally handles
filter-release consent, restart selection, arbitrary source dates, channel
rules, deletion and source changes. Any port must preserve those predicates and
use the real production normalization/parser and repository integration tests.
Neither Node production code nor Go code changes in this ticket, and no general
parser is replaced with the synthetic fixture parser.

## Reproduce

Build with the pinned toolchain and existing Cargo registry described in
[Rust replay](rust-replay-slice.md). The profiling executable is built with
`cargo build --locked --offline --release --example working_set`; invoke it as:

```bash
experiments/rust-replay/target/release/examples/working_set \
  /tmp/isolated-profile.sqlite3 1789473600000 500 512
```

The positional arguments are synthetic database, inclusive window cutoff in
milliseconds, recipient count and cache target in KiB. It opens state read-only.
The profile manifest describes how to reproduce the diagnostic backups from a
fresh baseline exercise. Run both cache sizes (2000 and 512) against both index
variants. Query plans are evidence for this pinned SQLite build, not a stable
textual API.

For primary measurements use `experiments/service-replay/run.js` with the
identified image and `--native-baseline` source/binary manifest, then revalidate
all results with `experiments/service-replay/report.js`. Both before and after
use `--users 500 --mode all --repeats 3`. Keep builds/tests separate from these
runs and retain failures as well as successes.

Regenerate the comparison table's numeric source while rechecking every oracle
and accounting boundary:

```bash
node experiments/service-replay/working-set-report.js \
  docs/benchmarks/retained-history/before \
  docs/benchmarks/retained-history/after
```
