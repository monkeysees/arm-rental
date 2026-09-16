# Incremental crawl persistence benchmark

Issue #15 replaces retained-history discovery and whole-state crawl writes with
indexed category watermarks, encountered-ID lookups, and atomic listing deltas.
The unchanged discovery-only workload used 89.5% less CPU and 92.5% fewer sampled
allocated bytes. Historical payload serialization disappeared, and transaction
row changes fell from 109,250 to 410 over ten crawls.

## Workload and method

[Raw measurements](benchmarks/2026-09-16-incremental-crawl.json) compare revision
`4d0729075c2b68eee4e23b879bfc3257fdca6dac` (schema v2, the retained-history baseline)
with the isolated #15 implementation on schema v3. Schema v4 and compact private
decisions from #19 were excluded. The candidate was built from a temporary
archive of the baseline with only the crawler, posting-date module, apartment
repository, apartment state-access adapter, and v3 migration changed. Source
hashes are included in the evidence; the measured candidate predates removal of
a redundant bounded map of encountered prices.

Each process retained 5,442 canonical listings and encountered the same 40
unchanged listings per crawl. One private recipient had 5,442 skipped decisions,
so no Telegram send was possible. Three sequential process runs each measured
ten crawls per phase. Setup, seeding, garbage collection before each phase, and
checkpointing before each phase were outside the timed sections. The runtime was
`node:24.18.0-bookworm-slim`, with one CPU, 512 MiB memory, and networking disabled.
The parser, crawler, and SQLite repositories were real; List.am HTML was
synthetic and no Telegram API was contacted.

The V8 heap sampling profiler used a 16 KiB sampling interval and included
objects collected by both minor and major garbage collection. Reported
allocations are sampled estimates, including profiler overhead, rather than a
heap-growth measurement. Payload JSON parse/serialization counts and serialized
bytes were instrumented separately. CPU measurements include that instrumentation
in both implementations. Reported heap/RSS snapshots are supplementary and do
not represent total allocation.

## Results

Values below are medians of three process runs, for ten crawls per phase.
Allocation figures use decimal MB.

| Phase                                   | CPU before → after   | Sampled allocation before → after | Full listing reads before → after |
| --------------------------------------- | -------------------- | --------------------------------- | --------------------------------- |
| Discovery only                          | 2,741.5 → 286.6 ms   | 439.4 → 32.9 MB                   | 10 → 0                            |
| Channel history materialization         | 2,779.7 → 1,514.6 ms | 433.7 → 226.2 MB                  | 10 → 10                           |
| Private delivery, one skipped recipient | 2,937.7 → 1,677.7 ms | 467.4 → 254.9 MB                  | 10 → 10                           |

Every phase reduced payload serializations from 54,420 to zero, eliminating
26,227,240 serialized payload bytes. Discovery-only payload parsing fell from
54,420 to 400. Consumer phases still parsed 54,820 payloads: the 400 encountered
comparisons plus ten complete 5,442-listing projections. The private phase
requested 54,420 recipient decision IDs in both implementations.

Each incremental unchanged crawl changed 40 encounter rows and one crawl
metadata row. The baseline additionally rebuilt its temporary membership table,
producing 109,250 transaction row changes over ten crawls versus 410 after the
change. These counts include temporary-table work; they are not physical disk
write counts. Discovery transaction time fell from 885.5 to 19.3 ms.

The extra persistent date/order indexes and encounter columns consume space.
After the workload stabilized, the database grew from 3,620,864 to 4,952,064
bytes, or 36.8%. WAL size in the later phases grew from 288,432 to 370,832 bytes,
or 28.6%, even though logical row changes decreased. These sizes are specific to
this fixture and checkpoint schedule; the change does not promise smaller
databases or less WAL for every crawl. The separate #19 benchmark measures its
storage compaction independently.

## Remaining consumer work and stress case

The private phase runs the real classification/delivery loop against a skipped
recipient and real decision rows. It still reconstructs the complete listing
projection and requests decisions for every retained listing. Removing that work
belongs to [#16](https://github.com/monkeysees/arm-rental/issues/16). The channel
phase measures the listing projection passed to `afterStateSaved`; it does not
execute channel classification, load the channel delivery repository, or measure
Telegram publication. Incremental channel processing remains
[#17](https://github.com/monkeysees/arm-rental/issues/17). The existing
`retained-history-baseline.js` workload remains the end-to-end multi-recipient
and restart-recovery check; this focused benchmark does not replace it.

An additional stress run encountered all 5,442 retained listings on one source
page and repeated each phase twice. This removes the bounded-encounter advantage:
HTML parsing and consumer work dominate. It still eliminated 10,884 payload
serializations, and row changes fell from 32,654 to 10,886. CPU improvements were
10.7% for discovery, 13.5% for channel projection, and 6.3% for private delivery
in this single sampled run. The
raw evidence includes every value; this stress sample is a limitation check,
not a statistically established regression or speedup claim.

## Reproduction

Run the same script against separate baseline and candidate source directories
with their normal dependencies installed. `--implementation-root` selects the
implementation, while the benchmark script itself stays identical:

```sh
node --expose-gc scripts/incremental-crawl-benchmark.js --implementation-root /path/to/baseline
node --expose-gc scripts/incremental-crawl-benchmark.js --implementation-root /path/to/candidate
node --expose-gc scripts/incremental-crawl-benchmark.js --implementation-root /path/to/candidate --encounters 5442 --repeats 2
```

For the recorded constraints, run each command in the pinned Node image with
`--network none --cpus 1 --memory 512m`, mounting the selected source tree and
dependencies read-only. The script creates and removes its own disposable
database directory. It never opens the installation's configured state.
