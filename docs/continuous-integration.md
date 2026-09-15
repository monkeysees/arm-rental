# Continuous integration

`Required CI` runs for every pull request and every push to `main`. Repository
branch protection must require both stable check names:

- `Required CI / Required / quality`
- `Required CI / Required / production artifact`

The quality job uses the exact Node release in `.nvmrc`, installs the lockfile
with `npm ci`, runs `npm run check`, independently runs the coverage gate, and
audits production dependencies with
`npm audit --omit=dev --audit-level=high`. The coverage command measures
`src/**/*.js` and fails below 90% lines or 80% branches.

The aggregate production contract is intentionally limited to baseline runner
tools plus Docker, jq, ShellCheck, and systemd-analyze. It uses `grep` for text
contracts instead of relying on optional hosted-image packages such as
ripgrep; its integration test fails if `rg` is invoked. ShellCheck is enforced
at warning severity and above. Its style and informational heuristics are not
release gates because they report false positives for intentional jq programs
and trap callbacks. Systemd verification runs against a temporary filesystem
root with explicit Docker/network stubs and executable placeholders, so clean
runners validate unit dependencies and command declarations without needing the
production host layout. Compose disables environment-file and host-path
resolution during this static render. The validator first asserts and replaces
only the production secret-file path in a temporary Compose copy with an empty
temporary environment file; its normalized model and consistency checks remain
enabled.

Coverage thresholds and the measured source glob live in `package.json` so the
same gate runs locally and in CI. Lowering either threshold or adding an
exclusion is an exception: the pull request must state why the code cannot be
measured, identify the compensating test, and receive explicit reviewer
approval. `test/ci-contract.test.js` pins the current thresholds and source
scope, so an exception cannot be introduced only by changing workflow YAML.
Temporary exceptions must include a removal issue and expiry date in this
document; there are currently no exceptions.

The artifact job builds the Linux AMD64 production image with source revision
and package-lock digest build arguments. The Docker build verifies those
arguments before installing only production dependencies. npm and Corepack are
then removed because the application runs directly with Node and does not need
package-management tooling in production. The job verifies the pinned Node and
curl-impersonate executables and all image labels. Trivy 0.69.3 scans both OS packages and
application libraries and fails on every high or critical finding for which a
fix is available. Findings that Debian marks `affected`, `fix_deferred`, or
`will_not_fix` without publishing a fixed package remain visible to security
review but do not permanently block unrelated releases that cannot remediate
them. The HTTP binary archive is pinned by SHA256 for Linux AMD64 and ARM64, with redistribution licenses retained. The offline image smoke verifies the Safari profile and cookie persistence under the production restrictions. The source revision, runtime versions, and lock digest remain available
as OCI labels for verification. Once these gates complete, the runner discards
the candidate image. The job intentionally does not use `docker save` or
`actions/upload-artifact`: no downstream workflow or host consumes that
archive, and retaining one several-hundred-megabyte copy per pull-request run
would exhaust Actions artifact storage without adding release evidence.

## Production publication

`Publish production` is a separate `workflow_run` workflow. It can run only
after a successful `Required CI` push to `main`, checks out the triggering
workflow's exact `head_sha`, and rebuilds byte-equivalent inputs with the same
pinned Dockerfile arguments. Publication repeats runtime-label validation and
the blocking Trivy scan so no registry object can appear if the published bytes
diverge from the required artifact job.

The workflow uses the single `production-publication` concurrency group with
`cancel-in-progress: false`. Once a run starts publishing, a newer run waits;
it cannot cancel a publisher between immutable-object creation and pointer
advancement.

Registry mutation occurs in this order:

1. authenticate with the workflow-scoped package token;
2. push the exact scanned local image and capture its
   `ghcr.io/<repository>@sha256:<digest>` reference;
3. create and push digest-bound release metadata containing the source
   revision, image digest, package-lock digest, production Compose digest, and
   deterministic operations-bundle digest;
4. create a stopped container from the commandless scratch metadata image with
   an explicit inert command, then extract and compare the published metadata;
   and
5. tag those same local image bytes as `production` and push that discovery
   pointer.

The VPS never deploys the mutable tag. It resolves the pointer, validates the
metadata object and exact Git commit, and renders Compose with the resulting
digest. See [release and rollback](release-and-rollback.md).

All GitHub Actions references use full commit SHAs, and the Trivy binary version
is fixed. Dependabot opens monthly pull requests for npm, Docker, and GitHub
Actions updates. Updates remain subject to both required checks and human
review; no update workflow merges or mutates production automatically.

The vulnerability database download, production image build, Trivy scan, GHCR
push, and registry digest resolution require GitHub-hosted network and package
services. They cannot be fully reproduced by `npm run check`; use the required
hosted jobs and the publication receipt as the release authority.
