# Production runtime image

The `production` target assembles a shell-free `scratch` image. A separate build
stage retains the digest-pinned Node 24.18.0 Debian image, npm, the snapshot-pinned
Debian installer, and checksum verification for curl-impersonate 2.2.2. Only the
Node and curl executables, their architecture-specific shared-library closure,
production npm dependencies, application source, CA certificate bundle, account
and resolver configuration, and redistribution licenses enter the final image.
No installation or download happens at runtime.

`scripts/assemble-runtime-root` resolves libraries inside the build stage. It
supports the installer's AMD64 and ARM64 inputs without hardcoded library paths.
The final image retains Debian release identification and the exact installed
package records for libc6, libgcc-s1, libstdc++6, ca-certificates, and base-files,
so vulnerability scanning includes the shipped operating-system components.
Node's license, curl's bundled licenses, Debian component copyright notices,
and referenced common licenses remain available. Keep the library closure,
package inventory, and license notices aligned when changing native inputs.

The image preserves UID/GID 1000 (`node`), the healthcheck and Node entrypoint,
source revision and lockfile digest labels, and SQLite compatibility metadata.
Compose continues to enforce a read-only root, dropped capabilities, bounded
writable mounts, and graceful stop behavior. The image has no shell, npm, or
package manager: recovery and maintenance commands use `node src/…` directly,
as the host operations scripts already do. See [state recovery](state-recovery.md)
and [release operations](release-and-rollback.md).

## Build and deterministic acceptance

```sh
docker build --platform linux/amd64 --target production \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  --build-arg PACKAGE_LOCK_SHA256="$(sha256sum package-lock.json | cut -d ' ' -f 1)" \
  --tag rental-apartments-bot:local .
scripts/smoke-production-runtime-image rental-apartments-bot:local
npm run check:production-contract
```

Both required CI and publication run the runtime smoke gate before image
scanning. Its containers use `--network none`, a non-root user, a read-only
root, dropped capabilities, and small isolated tmpfs mounts. It exercises the
real curl executable against loopback HTTP with cookie persistence, all recovery
CLI entrypoints (initialization, backup, validation, exact restore, disk check,
and maintenance), health probes, source-category parsing, successful application
preflight and graceful shutdown with real SQLite and singleton ownership, and
fail-closed startup without state. Telegram, List.am, and CBA responses are
fixtures at the external-service boundaries; this does not claim live production
acceptance. The same pinned Trivy OS/library HIGH/CRITICAL gate remains in both
workflows. An unsupported-OS result is not valid evidence of a clean OS scan.

## Measured size comparison

Local AMD64 builds on 2026-09-15 used the same pinned native and production npm
inputs. The baseline was built from revision
`8a56400b9b4bd11c459aa33e843ea49fa3729451` before the Dockerfile change.

| Measurement                      |    Baseline | Minimal runtime | Reduction |
| -------------------------------- | ----------: | --------------: | --------: |
| Compressed OCI layer bytes       |  97,227,014 |      60,714,879 |     37.6% |
| Uncompressed OCI layer tar bytes | 282,841,088 |     168,718,336 |     40.3% |
| Layers                           |          13 |               5 |         8 |

The local tags were `rental-apartments-bot:issue21-before` and
`rental-apartments-bot:issue21-after`. Each was exported with `docker save`;
the measurements sum the selected AMD64 manifest's layer blob sizes and the
lengths of their decompressed tar streams. Compressed bytes approximate a cold
pull's layer transfer; manifests/configuration add a small overhead. Uncompressed
layer tar bytes include tar headers and lower-layer files later hidden or
removed, and are not the final visible filesystem's file-byte total.

On this Docker containerd store, `docker image ls` displayed about 398 MB and
232 MB of combined local disk usage, while inspect `Size` described compressed
content. Do not label either number as pure unpacked filesystem size. Shared
base layers, existing cached content, filesystem allocation, and retained build
cache change actual incremental disk usage and transfer. The scratch runtime
shares no Debian/Node base layers with unrelated images. Smaller image storage
and transfer do not imply an equivalent reduction in running RAM.

The AMD64 runtime smoke, production contract, and Trivy 0.69.3 gates passed.
Trivy identified Debian 12.15 and five runtime package records, with no fixable
HIGH/CRITICAL findings. ARM64 inputs and architecture-independent assembly are
preserved; this host had no ARM64 execution support, so ARM64 execution was not
measured here. The supported production publication target remains AMD64.
