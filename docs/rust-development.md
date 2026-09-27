# Rust development

`rental-app` is the production service. Its modules live under
[`experiments/rust-replay/src/production/`](../experiments/rust-replay/src/production/),
and its CLI is
[`experiments/rust-replay/src/bin/rental-app.rs`](../experiments/rust-replay/src/bin/rental-app.rs).
The crate path retains its experimental name as part of the exact Git-object
release producer contract; it is the maintained Rust application. The older
`rental-replay` binary and Node comparison reports are historical test
provenance, not deployment entrypoints.

## Local checks and service

Use Rust 1.94.0 with Cargo, Python 3.11 or newer, Git, Docker, Bash, jq, GNU
tar, coreutils, ShellCheck and Linux `systemd-analyze`. The pinned Rust build image is
[`Dockerfile.build`](../experiments/rust-replay/Dockerfile.build). From the
repository root on Linux, run the same local checks as Required CI:

```sh
scripts/check
```

The entrypoint runs Cargo formatting, checking, Clippy and tests, Python
standard-library tests, and the production contract. Required CI also builds,
scans and exercises the complete production image. It uses only synthetic
Telegram, List.am and CBA peers; no production credential or state is needed.

To run the service locally, install the pinned curl-impersonate executable,
copy `.env.example` to a private `.env`, and set a bot token and owner ID. Load
that file into the shell, initialize a database only on first installation,
and serve:

```sh
sudo scripts/install-curl-impersonate /usr/local
cp .env.example .env
set -a
. ./.env
set +a
cargo run --locked --manifest-path experiments/rust-replay/Cargo.toml \
  --bin rental-app -- state:init
cargo run --locked --manifest-path experiments/rust-replay/Cargo.toml \
  --bin rental-app -- serve
```

On later starts, omit `state:init`. The Rust configuration still uses the
public `NODE_ENV` variable name for `development`, `test` and `production`.
The first command creating state refuses an existing database; serving refuses
an absent or incompatible one. Supported schemas 1–5 upgrade transactionally
to schema 6. See [state recovery](state-recovery.md) before any restore.

## Production image and provenance

Build a schema-3 candidate from the exact checked-out Git revision into a new
empty work directory:

```sh
release_work="$(mktemp -d /tmp/arm-rental-native-release.XXXXXX)"
python3 scripts/native-release.py build \
  --source-revision "$(git rev-parse HEAD)" \
  --work-dir "$release_work" \
  --image-tag arm-rental-production-native:local
```

The producer extracts an allowlist of committed Git objects rather than
reading arbitrary working-tree files. Dirty or untracked bytes cannot enter
the build context; `source.dirty=false` describes the committed inputs, not the
entire checkout. It builds the payload with locked Cargo dependencies and
finalizes a scratch image containing `rental-app`, checksum-verified
curl-impersonate, the required shared-library closure, CA certificates and
licenses. The final image runs as UID/GID 1000 with no Node, npm, shell,
package manager or compiler. Its Cargo lock, source-input, executable, curl
and transport hashes are carried in labels and `components.json`. Metadata
binds those hashes to the immutable registry digest, source and transport
manifests, Compose, and the exact Git operations archive. See the
[release runbook](release-and-rollback.md#cargo-provenance-transition-49).

Inspect the local image without starting the application:

```sh
docker image inspect --format '{{json .Config.Labels}}' \
  arm-rental-production-native:local
docker run --rm --entrypoint /usr/local/bin/curl-impersonate \
  arm-rental-production-native:local --version
```

## Packaged acceptance

Use new absolute output directories. The native lifecycle acceptance runner
starts the packaged service with synthetic local Telegram, List.am and CBA
peers, checks source and delivery behavior, validates the sealed runtime,
backs up and restores isolated SQLite state, and verifies shutdown/restart:

```sh
acceptance_parent="$(mktemp -d /tmp/arm-rental-native-acceptance.XXXXXX)"
python3 experiments/native-acceptance/run.py \
  --image arm-rental-production-native:local \
  --output "$acceptance_parent/report" \
  --expected-revision "$(git rev-parse HEAD)" --require-clean-source
```

The 500-recipient capacity gate is separate and should run without another
build or benchmark competing for resources:

```sh
capacity_parent="$(mktemp -d /tmp/arm-rental-native-capacity.XXXXXX)"
python3 experiments/native-capacity/run.py \
  --image arm-rental-production-native:local \
  --output "$capacity_parent/report" \
  --users 500 \
  --expected-revision "$(git rev-parse HEAD)" --require-clean-source
```

The capacity runner seeds 3,281,500 decisions, including 3,277,500 immutable historical rows, in disposable SQLite
state and checks ordering, durable acknowledgements, bounded concurrency,
retry behavior, interruption/restart and the 24-hour source activity edge.
`--users 4` is diagnostic only. Both runners record image, binary and fixture
identities in their reports and neither contacts production. Their fixture
contracts are documented in [native acceptance](../experiments/native-acceptance/README.md)
and [native capacity](../experiments/native-capacity/README.md).

## Operator commands

The packaged CLI exposes `serve`, `state:init`, `state:validate`,
`state:inspect`, `backup:create`, `backup:validate --snapshot DIR`,
`backup:restore --snapshot DIR`, `maintenance:report`, `storage:check`,
`source:smoke`, `browser:cleanup`, and `health-check --ready`. Run backup,
restore and source smoke through the reviewed host operations wrapper with the
service stopped where the singleton lease requires it. The current host
procedures are in [operational runbooks](operational-runbooks.md),
[source operations](source-operations.md), and [health and readiness](health-readiness.md).

The frozen Node differential oracle, prototype image assemblers and older
resource experiments are retained only as dated design evidence in Git history
and the [parity ledger](rust-parity.md). They are not current build, release or
recovery instructions.
