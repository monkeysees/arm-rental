# Minimal native runtime image

Issue [#42](https://github.com/monkeysees/arm-rental/issues/42) packages the Rust
service, replay, backup/restore and populated migration in a fresh scratch root.
This is an offline Linux AMD64 experiment on `experiment/22-runtime-comparison`;
production runtime and deployment are unchanged. Resource evidence is local x86-64,
not Raspberry Pi performance.

The assembler begins with exactly two executables: the current Rust workload and
the retained curl-impersonate 2.2.2 release. It resolves their transitive `ldd`
closure in the pinned Rust 1.94.0 Debian Bookworm image, copies those libraries,
and resolves both executables again with the loader **inside the completed root**.
An unsuccessful `ldd` or any `not found` line aborts before root creation. Two
regression tests cover those cases. An actual final-image negative control masks
`libgcc_s.so.1` with an empty read-only bind file and requires loader exit 127;
the host cannot silently supply a missing image dependency.

The result ships glibc's loader, libc, libm, libdl, libpthread and libgcc_s.
Bundled SQLite 3.53.2 is part of the Rust executable. No separate SQLite shared
library is required. Debian certificates, `nsswitch.conf`, passwd/group entries,
os-release and component licenses remain. Docker supplies container-specific
hosts/resolver files at execution. The service uses UID/GID 1000 and the acceptance
harness enforces read-only root, no capabilities and isolated writable state.
Export inspection finds no Node, npm, shell, package manager or compiler.

`/var/lib/dpkg/status` describes only packages owning copied libraries,
certificates and configuration: base-files, ca-certificates, libc6 and libgcc-s1.
It is a component inventory, not a claim that complete Debian packages are
installed. The complete Cargo lock graph and license notices are retained under
`/usr/local/share/licenses/replay`; `components.json` explicitly distinguishes
this provenance from linked runtime components. In particular, target-specific
and build-only Cargo dependencies do not become shipped runtime libraries.
Curl's upstream notices cover its statically included dependencies; its packaged
SHA-256 remains `9775f5c719cc7649d0da41a786ef5e25da886514c547399a6d86b6038f105786`.
No conservative Node inventory or Node license bundle is inherited.

## Reproduce

Use the retained caches/license material from the
[runtime artifact recipe](runtime-comparison.md#reproduce), pinned Rust compiler
from [Rust replay](rust-replay-slice.md), and Node 24.18.0 for the external harness.
Run from the repository root. Every output directory must be new. The build
context is a small generated directory, so Cargo target files and unrelated
repository content never enter the image build context.

```bash
docker run --rm --network none -v "$PWD:/repo" \
  -v /tmp/arm-rental-rust-cargo:/usr/local/cargo/registry \
  -w /repo/experiments/rust-replay arm-rental-rust-replay-build \
  cargo build --release --locked --offline
node experiments/native-image/build.js /tmp/native-image-artifact \
  --binary "$PWD/experiments/rust-replay/target/release/rental-replay" \
  --registry /tmp/arm-rental-rust-cargo \
  --toolchain-licenses /tmp/arm-rental-issue34-artifacts/rust/licenses \
  --transport-image arm-rental-comparison-node:local \
  --tag arm-rental-native-minimal:local
node --test experiments/native-image/assemble.test.js
experiments/native-image/build-variants /tmp/native-size-variants
node experiments/native-image/assess.js /tmp/native-size-variants /tmp/native-size-results
```

`--transport-image` is inspected to an immutable ID before extracting only curl
and its license directory. Curl bytes and Rust toolchain notices are checked
against known hashes. Rust crate licenses are copied from locked registry sources;
retained matching-version license directories cover target-only crates not
installed in the local Linux cache. Fetch the full locked graph first when
reproducing without those retained directories. The assembler base is pinned by
manifest digest; it contributes no shell/build-tool files to the scratch root.

Keep a dedicated tag for an image under test: a BuildKit rebuild can change the
attestation/index ID even when filesystem layers remain byte-identical. The first
smoke attempt lost an untagged old image ID during a packaging rebuild; final
acceptance uses an additional frozen tag and the final immutable ID.

## Artifact and acceptance record

The final image is `arm-rental-native-minimal:local`, frozen additionally as
`arm-rental-issue42-frozen:local`, ID
`sha256:34daefd8180fc986d7f82b4dd27ef068413e1db3f0f0a52be45af2edf1262484`.
Its [artifact manifest](benchmarks/native-image/artifacts.json) includes executable
and source hashes, dependency inventory, layer hashes, exported paths and the
runtime loader negative control.

| Accounting boundary                                                 |      Bytes |
| ------------------------------------------------------------------- | ---------: |
| Compressed layers (normalized gzip level 9 when save emits raw tar) | 14,843,484 |
| Unpacked layer tar (including tar metadata/padding)                 | 40,619,008 |
| Visible regular-file logical lengths in exported final filesystem   | 40,311,750 |

These are three distinct quantities. Visible size excludes link/directory
entries and filesystem allocation; compressed size excludes image config,
manifests, attestations and transfer framing. It is not a registry-network byte
measurement. Export tar and image-save tar stay in the selected output directory;
only their measured inventory and hashes belong in the repository.

The service smoke exercises local transport with cookies, native health,
shutdown, interrupted replay/recovery and an independent oracle in the actual
non-root read-only image. Maintenance acceptance adds native backup/restore and
populated migration. See the retained acceptance records and
[native limits](native-limits.md) for execution boundaries and limitations.

## Artifact-size assessment

The [assessment](benchmarks/native-image/size-assessment/assessment.json) identifies separately
rebuilt Rust and Go binaries, with one sequential 500-recipient virtual
replay/recovery correctness gate for each. The service image retains the normal
Cargo release build; size variants are experiment artifacts, not silently adopted
runtime changes. The stripped Rust assessment baseline is rebuilt with line
information and a GNU debuglink; it is separately hashed from the default image
binary.

| Rebuilt executable | Binary bytes | gzip level-9 bytes | Single acceptance wall seconds |
| ------------------ | -----------: | -----------------: | -----------------------------: |
| rust-default       |    4,250,672 |          1,904,972 |                          8.433 |
| rust-size          |    2,933,536 |          1,306,824 |                         10.755 |
| go-default         |    9,218,256 |          6,003,187 |                         31.624 |
| go-stripped        |    5,275,088 |          2,419,151 |                         32.109 |

Rust's size profile saves 31.0% of executable bytes, with a slower single
acceptance observation; Go stripping saves 42.8%, with similar single-run wall
time. These are executable savings, not image-layer measurements. Retain the
normal Rust profile pending repeated workload-specific performance measurements.
The [build record](benchmarks/native-image/size-assessment/build.json) identifies
all full/debug/runtime binaries and source inputs. The image manifest keeps
measured builder hashes separately from final reporting-helper hashes; final
Dockerfile, assembler and runtime source hashes match measured inputs.

Rust compares normal `opt-level=3` against `opt-level=z`, thin LTO and one codegen
unit. Both use `debug=1`, extract DWARF with `objcopy --only-keep-debug`, strip the
runtime executable and retain its external debuglink. An actual `addr2line` check
recovers a source location via that external file. Optimization can inline/merge
frames, and level-1 debug information does not retain complete local-variable
inspection. The `.full` and `.debug` artifacts are outside the runtime image.

Go compares the normal `-trimpath -buildvcs=false` build with a rebuilt
`-ldflags='-s -w'` executable. The full original and extracted DWARF are retained.
The assessment requires identical `.text` hashes and addresses before using that
retained full build to symbolize addresses from the stripped rebuild. GNU
`addr2line` resolves the separate DWARF symbol but reports `go.go:?` for its
source line; Go's native `addr2line` recovers `main.go:282` from the full build.
The first assessment stopped on an overstrong GNU-tool source-line assertion;
the corrected fresh run records this limitation. Go runtime traceback tables
remain, but debugger symbol/type/local-variable inspection is reduced without
external DWARF. The build recipe also repeats the ELF section-extraction step
used to compare Go text; artifact hashes identify those post-inspection bytes. These artifacts implement the older Go replay workload, not the
Rust native service/maintenance commands.

The recorded wall observations include container startup, fixture export,
synthetic SQLite state, virtual replay and oracle coordination. They run
sequentially with one CPU and 512 MiB (no swap); an external Node coordinator
shares that test container. They are single acceptance observations, not repeated
performance benchmarks, and cannot establish a small throughput improvement.

## Architecture limits

Only Linux AMD64 image assembly and execution are validated. Rust's bundled
SQLite build and Go's CGO SQLite dependency require a matching native C compiler,
linker and libc for ARM. The pinned curl release has a separate ARM64 asset and
checksum; this builder deliberately verifies the AMD64 curl hash and requests
`linux/amd64`. Supporting ARM requires architecture-aware transport verification,
matching executable/compiler targets, a rebuilt library closure and real ARM
smoke/resource acceptance. An emulator or cross-compiled executable alone would
not establish Raspberry Pi performance. No ARM artifact is asserted here.

## Final image lifecycle acceptance

The frozen image passed all seven [service checks](benchmarks/native-image/service/acceptance.json),
all 25 [backup/restore checks](benchmarks/native-image/maintenance/acceptance.json),
and all 39 [populated-migration checks](benchmarks/native-image/migration/acceptance.json).
The service tests cover cookie-protected local transport, malformed/oversized
responses, health, shutdown and pending-work recovery. Maintenance tests cover
safe destination publication, interrupted copies and retries. Migration tests
cover all eight interruption boundaries, source preservation, populated-table
fingerprints and old-binary rollback. The independent replay oracle verifies all
3,321,500 decisions and the acknowledged-prefix/pending-suffix contract; deliberately
reordered output is rejected.

All execute non-root with a read-only root filesystem and local/offline peers.
The maintenance harness mounts the executable extracted from this exact image;
its SHA-256 `fb5c71b794178f178254585bab56b9d85546f303703302f7ff026762f3b193b6`
matches the packaged binary. No extra libraries or runtime tools are mounted.
The genuine version-0 generator remains outside the candidate acceptance identity
and is explicitly recorded in migration evidence.

After building and freezing the image, reproduce these checks with new directories:

```bash
image=arm-rental-issue42-frozen:local
node experiments/native-service/check.js /tmp/native-image-service "$image"
docker create --name native-image-extract "$image"
docker cp native-image-extract:/usr/local/bin/replay /tmp/native-image-replay
docker rm native-image-extract
node experiments/native-maintenance/check.js /tmp/native-image-maintenance \
  /tmp/native-image-replay "$image"
node experiments/native-migration/check.js /tmp/native-image-migration \
  /tmp/native-image-replay /tmp/arm-rental-41/legacy-replay "$image"
```

Build the legacy executable from the exact revision and commands in
[native migration](native-migration.md#reproduction-and-resource-boundary).
These are image-functionality checks at 512 MiB, not repeated resource benchmarks;
the separate [75 MB/50 MB assessment](native-limits.md) supplies that evidence.
The initial migration smoke's missing-image failure is retained as an infrastructure
failure, followed by complete acceptance against the frozen image. Synthetic SQLite
files were removed after successful checks; raw reports and their recorded hashes
remain, and no production state was accessed.
