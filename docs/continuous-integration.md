# Continuous integration

`Required CI` runs for every pull request and push to `main`. Branch protection
requires both stable checks:

- `Required CI / Required / quality`
- `Required CI / Required / production artifact`

The quality job uses the pinned Rust 1.94.0 build image. Its `scripts/check`
entrypoint runs Cargo formatting, checking, Clippy and tests, Python standard
library tests, and the production contract. The contract checks shell syntax
and ShellCheck, systemd units, Compose rendering, workflow action pins and
release boundaries. It uses a temporary filesystem root with synthetic
Docker/network dependencies and command placeholders, so the checks do not
need the production host or secrets. The static Compose render substitutes
only a verified production environment-file path in a temporary copy.

The artifact job builds the Linux AMD64 Rust image from exact committed Git
objects with `scripts/native-release.py`. The producer stages a restricted
context and records Cargo lock, source-input, executable, curl and transport
closure digests; it has no Node, npm or package-lock input. The job validates
the native CLI and immutable image labels, runs packaged service, maintenance
and isolated recovery acceptance against local Telegram, List.am and CBA
peers, and checks the 500-recipient capacity contract. The image is non-root,
read-only and shell-free. Tests use disposable synthetic state and make no
production API call.

Trivy 0.69.3 scans OS packages and linked application libraries. Every high
or critical finding with an available fix blocks the image. Debian findings
marked `affected`, `fix_deferred` or `will_not_fix` without a published fix
remain visible for security review. The required job discards its validated
candidate image; publication repeats the build, acceptance and scan rather
than consuming an Actions artifact.

## Production publication

`Publish production` is a separate `workflow_run` workflow. It starts only
after successful required checks on a `main` push and checks out that run's
exact `head_sha`. Publication runs under the single
`production-publication` concurrency group without cancellation. It pushes
the scanned image by immutable GHCR digest, creates schema-3 release metadata
and an operations bundle from the same Git revision, then verifies their
bytes and hashes before advancing the mutable `production` discovery tag.

The schema-3 bundle binds the image digest to Cargo and source-input
provenance, the binary and transport closure, canonical source and transport
manifests, Compose, and an exact Git archive of `ops/` and `infra/systemd/`.
The publisher first checks the transition against the installed host release.
A runtime-capability contraction is held for explicit promotion until its
bridge release has been accepted on the host. The first Rust-only contraction
requires the committed `docs/evidence/issue50-bridge-receipt.json` and verifies
it against the exact currently published bridge before registry push. An
unsupported transition fails
before the discovery pointer moves. The VPS obtains an immutable image and
metadata by digest; it never rebuilds source or deploys the mutable tag.

Workflow actions use full immutable commit pins. Dependabot proposes base
image and GitHub Actions updates as reviewable pull requests and has no
production mutation capability. The build, vulnerability database download,
registry push and digest resolution need hosted network and package services;
local `scripts/check` does not substitute for the hosted results. See the
[release runbook](release-and-rollback.md) for the promotion and deployment
receipts.
