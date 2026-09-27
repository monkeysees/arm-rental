# Native 500-recipient capacity acceptance

`run.py` uses Python's standard library as the coordinator and local HTTP peer.
Only the packaged Rust `rental-app` serves and writes production state. No Node
process is started during acceptance. The output directory must be new and
absolute, and no builds or other benchmarks should overlap the run.

```bash
python3 experiments/native-capacity/run.py \
  --image arm-rental-production-native:local \
  --output /tmp/native-capacity-500
```

CI passes the expected source revision and requires the image's clean-source
label. `--users 4` exercises the protocol quickly but marks its report
`diagnostic: true`; only 500 recipients satisfy issue #47.

## Frozen expectations

`contract.json` is a frozen copy of the independent, hand-reviewed contract
used by the retired Node coordinator; the active gate reads this local copy.
`expected.json` pins the 3,281,500 seeded decisions, the SHA-256 digest of the
3,277,500 immutable historical rows (excluding the eight deliberately updated
listing IDs), exact catch-up and interruption counts, and a separate 24-hour
activity edge. The digest and counts were recorded from the accepted Node oracle
before this runner was written. The input hashes are checked before and after
each run and included in the report. Candidate output never refreshes them.

The coordinator initializes a disposable production SQLite volume through the
image, stores 5,442 source cards through the packaged Rust crawl command, and
inserts the contract's historical decisions and 500 active subscription filters
with Python SQLite. This seeding is setup, outside capacity timing. The
service then crawls local List.am and CBA peers and sends to a local Telegram
peer. Every recipient's ordered payload and durable status are checked against
the frozen arrays. Catch-up inserts 50 one-second 429 retries, tracks the
20-message-per-minute recipient bucket and eight concurrent sends, and checks
fair first progress. The interruption fails the third listing for each user,
kills the process after the failure event, checks the acknowledged prefix in
SQLite, restarts the same image and volume, and requires the exact pending
suffix. Drained and returning phases require zero sends.

The extra `boundary` phase presents one card per cohort with a posting time
23 hours 58 minutes before its source request and another 24 hours 2 minutes
before it. The first must deliver once per recipient; the expired card must
never be acknowledged. The two-minute margins account for minute-resolution
source dates and ordinary crawl scheduling without changing the strict 24-hour
product rule.

The recipient bucket is measured at HTTP receipt, after the app has reserved a
token and after the peer's global 200-attempts/second scheduler. A 100 ms
observation allowance covers that cross-process gap; it does not change the
product's 20/minute, burst-five rate. The report retains the smallest observed
headroom and first-cohort attempt offsets for review. The boundary check reads
all eight stored posting dates back from SQLite, confirms they straddle 24
hours and have no `updatedAt`, and rejects any expired acknowledgement.

`report.json` retains the complete full-wall result and the approved
source-separated delivery result. The 25.025-second catch-up delivery target,
60-second combined routine target, 1.1 tolerance, fairness formula, expected
delivery order, and failure records are never rewritten to make a slow run
pass. Source pacing is measured from `crawl.started` through the last
`source.integrity.checked` event. The full-wall diagnostic can fail while the
approved source-separated capacity check passes. The report identifies the
packaged image ID, binary hash, source revision and input hashes. It does not
claim ARM hardware performance or whole-machine memory fit.

CI prints a bounded `CAPACITY_RUNNER_TELEMETRY` line after the capacity result
and `CAPACITY_RUNNER_VMSTAT` when interval samples are available. They include
available CPUs, one-minute load,
CPU and I/O pressure deltas, cgroup CPU throttling when exposed, and maxima
from ten-second runner CPU samples. These runner-wide observations help explain
timing variation; they cannot attribute a slow run to the application or
replace the unchanged capacity gate.
