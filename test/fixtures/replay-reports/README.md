# Replay report regression fixtures

These frozen inputs are retained solely for `test/runtime-comparison.test.js`
and `test/service-replay.test.js`. Those tests exercise independent behavior and
accounting verification, capacity-gated RAM claims, and deliberate corruption
rejection without running benchmarks or requiring Docker.

The Node, Go and Rust directories each contain the four results and manifest
needed by the comparison reporter. `service.json` covers the small virtual
service/recovery result and separated service/harness accounting. Inputs were
moved byte-for-byte from the former measurement archive at commit
`ccacd4d515c34f43cb1d9a8aa8447f43899e2011`. Embedded source IDs, commands and paths
are historical fixture data, not instructions or dependencies on those paths.
They are not evidence of current application performance or acceptance.

Keep both valid and corrupted-output assertions when changing the reporter.
Generate any replacement fixtures independently of the verifier being tested.
