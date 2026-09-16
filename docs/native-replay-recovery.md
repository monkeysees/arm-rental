# Go and Rust interruption recovery

Issues [#32](https://github.com/monkeysees/arm-rental/issues/32) and
[#33](https://github.com/monkeysees/arm-rental/issues/33) extend the native
prototypes to the full [shared replay contract](node-replay-baseline.md), at
500 and 1,000 recipients. Production state, runtime and deployment are unchanged.
All work remains on `experiment/22-runtime-comparison`.

## Reproduce

Build and run the language checks using the commands in the
[Go slice](go-replay-slice.md#reproduce) and
[Rust slice](rust-replay-slice.md#reproduce) documents. Then, from the repository
root, run the complete acceptance protocol into new directories:

```bash
node experiments/node-replay/measure.js /tmp/go-recovery-measurements \
  --runtime go --go-binary /tmp/arm-rental-go-build/replay
node experiments/node-replay/measure.js /tmp/rust-recovery-measurements \
  --runtime rust \
  --rust-binary "$PWD/experiments/rust-replay/target/release/rental-replay"
```

Each command runs one virtual behavior check and three independent wall replays
at each population, sequentially in fresh offline containers with one CPU,
512 MiB application RAM and no swap. Keep source and binaries unchanged during
measurement. The manifest records exact Docker commands, image identity and host
details; each result records source and binary hashes. Virtual timings are not
performance evidence. Four recipients remain available for focused diagnostics.

For one diagnostic using either compiled executable:

```bash
node experiments/node-replay/run.js --runtime go \
  --go-binary /tmp/arm-rental-go-build/replay --users 4 --mode virtual \
  > /tmp/go-recovery-diagnostic.json
node experiments/node-replay/verify.js /tmp/go-recovery-diagnostic.json
```

## Recovery boundary

The coordinator exports the same HTML and manifest for both languages. It starts
an exercise process with a fresh SQLite database, waits for exit code 23, then
starts a resume process against that database. The exercise fails the third
listing send for every recipient after two durable acknowledgements. It emits
its observations and exits without closing SQLite. The new process checks the
acknowledged prefix and pending suffix before resuming delivery. It then runs
the unchanged drained phase and returning absent-card phase. The independent
oracle checks every phase's delivery order, classifications and actual payloads;
the completed replay must have no pending decisions.

This is the same handled-failure/unclean-process-exit boundary as the Node
baseline. It does not claim arbitrary instruction-level crash coverage or
exactly-once Telegram delivery. Acceptance by Telegram and a local SQLite
acknowledgement cannot commit atomically: a process that dies between them can
send that listing again after restart. Focused diagnostic tests model this
window separately from the frozen capacity workload. Durably acknowledged sends
must never be replayed.

## Measurement interpretation

The primary memory metric remains the fresh container's cumulative cgroup-v2
`memory.peak`, including the Node coordinator/exporter, native workers, SQLite,
filesystem cache and kernel charges. Repeated phase samples and process RSS are
secondary; sampled values can miss short peaks. Workers execute sequentially,
so process peak RSS is their maximum, while process CPU and wall work are summed.
The original raw slice measurements remain historical evidence of their shorter
lifecycle and are not overwritten.

The host OS, Docker daemon, live curl, production polling, supervision and other
operational services remain outside this boundary. These results cannot establish
whole-machine or Raspberry Pi capacity. The existing fixture-parser restrictions,
experimental schemas, and missing production features listed in the two slice
documents still apply. No production migration, deployment or live Telegram
acceptance is implied.
