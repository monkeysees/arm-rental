# Rust rewrite development

[#44](https://github.com/monkeysees/arm-rental/issues/44) tracks the complete Rust
rewrite with feature parity and regression acceptance. The production Node
application, README, architecture, state schema and operational runbooks define
the baseline. `rental-app` is the production-schema Rust candidate; its modules
live under `experiments/rust-replay/src/production/`. The separate `rental-replay`
executable retains the synthetic experiment contract. Production remains on the
Node image until the candidate passes acceptance and a separate cutover is
approved. See [the parity ledger](rust-parity.md) for coverage and remaining gaps.

Whole-machine validation and further language-selection measurements are no
longer required. Historical decision reports and acceptance runs were removed
from the working tree; they remain available at commit
`ccacd4d515c34f43cb1d9a8aa8447f43899e2011` and through the closed issues. Their
results do not establish full-app parity or passing capacity at 50 MB/75 MB.
Do not use a historical success label as acceptance of new code.

## Retained contracts and tools

| Location                                                                                       | Purpose                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/`, `test/`, production documentation                                                      | Current Node behavior and regression baseline.                                                                                                                     |
| `experiments/node-replay/`                                                                     | Shared fixture exporter, independent behavior oracle, capacity/fairness contract and Node/native coordinators. See the [replay contract](node-replay-baseline.md). |
| `experiments/rust-replay/`                                                                     | Rust source, pinned build image, Cargo lockfile, and integration tests.                                                                                            |
| `experiments/go-replay/`                                                                       | Existing independent implementation used by cross-runtime regression/tooling checks; not a second rewrite target.                                                  |
| `experiments/native-service/`                                                                  | Local peer and packaged transport/cookie/health/shutdown acceptance.                                                                                               |
| `experiments/native-maintenance/`, `experiments/native-migration/`                             | Native maintenance and migration failure-injection acceptance.                                                                                                     |
| `experiments/native-image/`                                                                    | Minimal closure assembly, license inventory, packaging checks and optional size tools.                                                                             |
| `experiments/service-replay/`, `experiments/native-limits/`, `experiments/runtime-comparison/` | Reusable resource-accounting/report validation tools. Running fresh measurements is optional work, not a prerequisite for the rewrite decision.                    |
| `test/fixtures/replay-reports/`                                                                | Only frozen report inputs required by existing regression tests; not current performance evidence.                                                                 |

Keep the shared oracle independent of Rust output. Extend parity coverage to real
application behavior rather than narrowing production behavior to synthetic
fixtures. The current replay contract declares 500 recipients and supports four
for diagnostics; do not infer larger-population acceptance from old ticket text.

## Build and regression checks

Use Node from `.nvmrc`, the repository npm lockfile, and Rust 1.94.0 from the
pinned Dockerfile. Run from the repository root on Linux with Docker:

```bash
npm ci
docker build -t arm-rental-rust-replay-build \
  -f experiments/rust-replay/Dockerfile.build .
mkdir -p /tmp/arm-rental-node-24.18
docker run --rm -v /tmp/arm-rental-node-24.18:/out \
  node:24.18.0-bookworm-slim cp /usr/local/bin/node /out/node
docker run --rm -v "$PWD:/repo" \
  -v /tmp/arm-rental-node-24.18/node:/usr/local/bin/node:ro \
  -v /tmp/arm-rental-rust-cargo:/usr/local/cargo/registry \
  arm-rental-rust-replay-build \
  sh -c 'cargo fetch --locked && cargo fmt --check && cargo check --locked && cargo test --locked && cargo clippy --locked --all-targets -- -D warnings && cargo build --locked --release'
RENTAL_APP_BINARY="$PWD/experiments/rust-replay/target/release/rental-app" \
  npm run test:coverage
npm run lint
npm run format:check
npm run check:production-contract
```

The first build downloads dependencies; subsequent runs can use Cargo's offline
mode with the populated registry. Native differential tests require
`RENTAL_APP_BINARY`; without it, ordinary Node-only development skips those
files. Required CI always builds the binary and sets that variable. ARM builds require a target C toolchain for
bundled SQLite and matching curl/native libraries. Current image assembly is
AMD64-specific; an AMD64 run is not ARM execution evidence.

For a virtual-clock behavior/recovery check, use a fresh result path:

```bash
docker run --rm --network none --cpus 1 --memory 512m --memory-swap 512m \
  -v "$PWD:/app:ro" \
  -v "$PWD/experiments/rust-replay/target/release/rental-replay:/replay:ro" \
  -w /app node:24.18.0-bookworm-slim \
  node experiments/node-replay/run.js --runtime rust --rust-binary /replay \
  --users 500 --mode virtual > /tmp/rust-replay-result.json
node experiments/node-replay/verify.js /tmp/rust-replay-result.json
```

Virtual time checks behavior, not throughput. The native worker's exercise stage
exits 23 at its designated durable interruption boundary; the coordinator resumes
in a fresh process and checks the acknowledged prefix/pending suffix. The
external-acceptance/local-acknowledgement ambiguity remains; no exactly-once
Telegram delivery claim follows from this test.

## Production candidate image

`Dockerfile.native` builds `rental-app` from the locked Rust source using the
pinned Rust 1.94.0 image. Its scratch runtime contains the executable, verified
curl-impersonate, their resolved library closure, certificates, resolver/account
configuration, and redistribution notices. It runs as UID/GID 1000 and ships no
Node, shell, package manager, or compiler. The default Dockerfile and production
Compose file continue selecting the Node runtime.

```bash
docker build -f Dockerfile.native -t arm-rental-production-native:local \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  --build-arg CARGO_LOCK_SHA256="$(sha256sum experiments/rust-replay/Cargo.lock | cut -d ' ' -f 1)" \
  --build-arg PACKAGE_LOCK_SHA256="$(sha256sum package-lock.json | cut -d ' ' -f 1)" .
node experiments/production-image/check.js /tmp/production-native-check \
  arm-rental-production-native:local
```

The check creates only synthetic state and an isolated backup directory. It
executes initialization, validation, backup, restore, and maintenance inside the
non-root, read-only image with networking disabled. It also starts the packaged service against synthetic Telegram, List.am and CBA HTTP peers on host loopback (`--network host` on Linux), probes readiness, checks delivery, stops cleanly and restarts without redelivery. The service uses the packaged curl executable; the report records its hash and version. No production endpoints or credentials are used. The checker then checks the exported
runtime closure and records the image and binary identities. It is lifecycle
acceptance, not a claim of 500-recipient throughput.

For a machine with limited build space, build the executable once with the
pinned development image and reuse its artifact and the existing verified
transport image. This avoids a second Cargo target directory in Docker layers:

```bash
docker run --rm -v "$PWD:/repo" \
  -v /tmp/arm-rental-rust-cargo:/usr/local/cargo/registry \
  -w /repo/experiments/rust-replay arm-rental-rust-replay-build \
  cargo build --locked --release --bin rental-app
node experiments/production-image/build.js /tmp/production-native-build \
  --binary "$PWD/experiments/rust-replay/target/release/rental-app" \
  --registry /tmp/arm-rental-rust-cargo \
  --transport-image arm-rental-transport:local \
  --tag arm-rental-production-native:local
```

The image retains the release bundle’s `package-lock.sha256` label for the host
operations verifier; it identifies the repository’s release tooling lockfile,
not an installed Node runtime. Rust dependencies have their own Cargo lock hash.

The prebuilt assembler supports Linux AMD64 and checks the curl executable's
pinned checksum, gathers locked crate and pinned toolchain notices, and resolves
the closure inside the final filesystem. Its `build.json` records the supplied
binary hash; it does not claim that an arbitrary supplied binary was built from
the current source. Fetch all locked crates before collecting notices.

Native maintenance commands replace the corresponding Node entrypoints when a
native image is explicitly selected:

| Node entrypoint                          | Native command                               |
| ---------------------------------------- | -------------------------------------------- |
| `node src/index.js`                      | `serve`                                      |
| `node src/state-init-cli.js`             | `state:init --data-directory /app/.data`     |
| SQLite validation                        | `state:validate --data-directory /app/.data` |
| Read-only installed-schema inspection    | `state:inspect --data-directory /app/.data`  |
| `node src/recovery-cli.js backup`        | `backup:create`                              |
| `node src/recovery-cli.js validate PATH` | `backup:validate --snapshot PATH`            |
| `node src/recovery-cli.js restore PATH`  | `backup:restore --snapshot PATH`             |
| `node src/maintenance-cli.js report`     | `maintenance:report`                         |
| `node src/recovery-cli.js disk-check`    | `storage:check`                              |
| `node src/browser-cleanup-cli.js`        | `browser:cleanup [--dry-run                  | --apply | --backup-report]` |
| Readiness document for host acceptance   | `health-check --ready --document`            |

Configuration still uses the documented environment variables and fixed
production SQLite identity. Every serving/maintenance writer uses the singleton
lease. Initialization refuses existing state; serving refuses absent state.
Supported schemas 1–5 migrate transactionally to schema 6. Backups remain
compatible with Node manifests, and validation upgrades a staged copy rather
than writing into a recovery point. Restoration needs enough free disk for
temporary restore and rollback copies.

`ops/compose.native.yaml` is an explicit candidate
override for the production Compose shape. Host operations select it only when
the chosen immutable image declares `com.rental-apartments.runtime=rust`; older
published images without that label retain their Node command contract. The
override travels in the checksummed operations bundle. Selecting a native image
in the host release record still requires separate cutover authorization.

## Complete service acceptance

Run the production-schema workload against the immutable candidate image:

```bash
node experiments/production-acceptance/run.js \
  --image arm-rental-production-native:local \
  --output /tmp/production-acceptance-500 --users 500 --phases all
```

The output path must be new. The runner records the immutable image and extracted
binary hashes, seeds 3,281,500 decisions using the independent Node oracle, and
checks real List.am/CBA/Telegram peers, exact messages, retry pacing, fair
progress, interruption and restart. Native commands run inside the read-only
image as UID 1000; peers use host loopback and only synthetic state is mounted.
The fixed 500-recipient workload is sequential: do not run builds or other
benchmarks alongside it. Allow free disk for the database, WAL, exported binary
and reports.

Source pacing is reported separately under the explicitly approved full-service
boundary. Catch-up delivery still uses the original 1.1 tolerance; routine
crawls retain the full-wall 60-second limit. The report also preserves the
original full-wall oracle diagnostic. A failure remains a failure in the
corresponding field. `--binary PATH` supports local diagnosis, and `--users 4`
is diagnostic only. Raw outputs remain outside the repository; the concise
[parity record](rust-parity.md) identifies the accepted build and limitations.

## Replay experiment image

Build the production image only as a source of checksum-verified curl and its
licenses; the assembler copies no Node runtime into the Rust image. Fetch all
locked Rust crates so license collection needs no archived build directory.
Use fresh output directories and keep an image under test on a stable tag.

```bash
docker build --target production -t arm-rental-transport:local \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  --build-arg PACKAGE_LOCK_SHA256="$(sha256sum package-lock.json | cut -d ' ' -f 1)" .
mkdir -p /tmp/arm-rental-rust-notices
for notice in COPYRIGHT LICENSE-APACHE LICENSE-MIT; do
  curl --fail --location --proto '=https' --tlsv1.2 \
    "https://raw.githubusercontent.com/rust-lang/rust/1.94.0/$notice" \
    -o "/tmp/arm-rental-rust-notices/Rust-$notice"
done
node experiments/native-image/build.js /tmp/native-image-build \
  --binary "$PWD/experiments/rust-replay/target/release/rental-replay" \
  --registry /tmp/arm-rental-rust-cargo \
  --toolchain-licenses /tmp/arm-rental-rust-notices \
  --transport-image arm-rental-transport:local \
  --tag arm-rental-native-minimal:local
```

The build script checks Rust notices and curl bytes against pinned hashes and
copies notices from the locked crate sources. It assembles and resolves the
actual executable/library closure inside the image, retaining certificates,
resolver/account configuration and licenses. Bundled SQLite lives in the Rust
executable. No Node, npm, shell, package manager or compiler is shipped.
The image is non-root with a read-only root and explicitly writable state during
acceptance. No historical benchmark file is needed to build or inspect it.

## Lifecycle acceptance and supported state

The [service contract](native-service.md), [maintenance contract](native-maintenance.md)
and [migration contract](native-migration.md) describe current limitations and
operator commands. Maintenance is offline and supports only the designated
interrupted replay state, not arbitrary production SQLite databases. Preserve
source state and use a new destination on retry; never resume an incomplete copy.

With the image above, future acceptance commands are:

```bash
node experiments/native-service/check.js /tmp/native-service-check \
  arm-rental-native-minimal:local
node experiments/native-maintenance/check.js /tmp/native-maintenance-check \
  "$PWD/experiments/rust-replay/target/release/rental-replay" \
  arm-rental-native-minimal:local
```

Migration tests need a genuine supported version-0 executable. Its exact source
is retained in Git; rebuild it into a separate ordinary temporary directory:

```bash
mkdir -p /tmp/native-v0-source
git archive d75fa00a8d277f5a572a239667b1dc8b17d90263 experiments/rust-replay \
  | tar -x -C /tmp/native-v0-source
docker run --rm -w /repo/experiments/rust-replay \
  -v /tmp/native-v0-source:/repo \
  -v /tmp/arm-rental-rust-cargo:/usr/local/cargo/registry \
  arm-rental-rust-replay-build cargo build --locked --release
node experiments/native-migration/check.js /tmp/native-migration-check \
  "$PWD/experiments/rust-replay/target/release/rental-replay" \
  /tmp/native-v0-source/experiments/rust-replay/target/release/rental-replay \
  arm-rental-native-minimal:local
```

These tools generate their own isolated fixtures, state and reports. They check
failure paths, independent output verification and recovery. They do not contact
production Telegram or mount production state. No previous acceptance report is
an input. Backup/migration can require multiple database-sized copies and WAL or
journal files; allow free disk space and retain failed output until investigated.

## Optional resource tooling

The service-only runner now requires `--native-baseline /absolute/baseline.json`
containing the candidate's `binarySha256` and `sourceHashes` map. Generate those
from the current executable/source using the exported helpers in
`experiments/service-replay/common.js`; the runner verifies them against the
image and source before work starts. A historical comparison run is not a default
input. The opt-in live service replay regression requires both
`SERVICE_REPLAY_HOLDER` and `SERVICE_REPLAY_BASELINE`.

The exact-limit harness and its auditor/report generator remain available for
future investigations. They record cache ownership, kernel page rounding, swap,
CPU and external coordinator costs separately and preserve genuine capacity
failures. They are not part of ordinary unit-test execution. Resource requirements
for the complete Rust app must not be inferred from smaller prototype results.
