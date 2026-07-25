# Production testing

Production is the only deployed environment. Testing is split between
deterministic CI gates that run without live credentials and post-deploy
verification against the production service. `NODE_ENV=test` exists only for
code tests; it is not a deployment target.

## Deterministic CI integration gates

Every candidate must pass `npm run check` and `npm run test:coverage` before an
image can be published. The suite exercises the production boundaries with
fakes, local HTTP servers, temporary directories, and real child processes:

- browser tests cover Chrome discovery, profile reuse across restarts,
  challenge detection, renderer and protocol failures, and process cleanup;
- state, configuration, preflight, singleton, and recovery tests cover
  restrictive modes, durable atomic writes, incompatible schemas, cross-process
  lease contention, snapshot validation, and exact restore;
- release contract tests reject mutable artifacts, incomplete observation
  windows, non-production environments, and removed commands;
- deployment contract tests inspect the Dockerfile, Compose definition, and
  build context without requiring production credentials.

The hosted workflow additionally runs the production dependency audit, builds
the exact production image, verifies the pinned Node and Chrome executables,
runs image execution checks, and blocks publication on the configured
high/critical vulnerability scan. These gates are reproducible and must make no
Telegram, List.am, or CBA call.

`npm run check:production-contract` is the aggregate deployment gate. On the
Linux CI runner it checks shell syntax and ShellCheck, verifies systemd units,
renders and inspects Compose, checks immutable workflow action pins, rejects
removed secondary-environment paths, and rejects external logging/metrics
servers. Systemd verification uses a temporary root with declared dependency
stubs and command placeholders instead of assuming production paths exist on
the runner. Compose rendering skips production environment-file and host-path
resolution but retains model consistency checks. Fake-command integration tests
prove the aggregator invokes every validator without requiring Docker or
systemd locally.

## Pre-deploy safety boundary

The approved candidate is the immutable digest that passed every CI gate. Before
replacing the running singleton, the deployment process must:

1. verify the digest and production-only Compose contract;
2. stop the current service;
3. create and validate an atomic production snapshot;
4. retain the previous immutable digest and its release bundle;
5. start the candidate stop-first against the unchanged named data volume.

There is no parallel canary or live test bot. A candidate defect can therefore
reach production before verification catches it. Snapshot-backed rollback,
small releases, immutable artifacts, and the single-writer stop-first boundary
are the compensating controls.

## Post-deploy production verification

The deployment is successful only after the candidate:

- completes startup preflight with Telegram authentication and the configured
  channel permission result;
- reports private `/live` and `/ready` checks successfully;
- emits one `crawl.succeeded` event for the deployed digest;
- demonstrates the expected private/channel delivery mode without resending
  acknowledged apartments;
- remains ready for one complete poll interval plus five minutes.

The verifier must use sanitized structured events and private health probes. It
must not print secrets, publish a health port, create test deliveries, reset
state, bypass a List.am challenge, or interfere deliberately with upstream
services.

If any required check fails after mutation, stop the candidate, restore the
verified pre-deploy snapshot, restart the previous immutable digest, and require
readiness. Preserve sanitized failure and rollback evidence for the operations
record. A failed rollback is an incident and must leave the service unit failed
rather than retrying the same quarantined candidate indefinitely.

## Production-only operational checks

Potentially disruptive behavior is tested deterministically in CI. Live
production checks are limited to observing normal behavior or using isolated
data:

- use an isolated temporary restore volume for recovery drills, and never start
  polling or delivery from it;
- validate alert routing with safe evaluator inputs and test notifications,
  without revoking the live token, changing channel permissions, or injecting
  crawl failures;
- perform interactive browser verification only while the production service is
  stopped and holding the same persistent profile;
- retain the CI result, image digest, snapshot manifest, deploy receipt, final
  readiness, crawl ID, and rollback result when applicable.

Refer to [release-and-rollback.md](release-and-rollback.md) for deployment
commands and [state-recovery.md](state-recovery.md) for isolated restore
validation.

## Production recovery acceptance evidence

After provisioning and one verified normal deployment, use the phased
[`production-exercise` runbook](production-exercises.md) to observe:

- an isolated restore drill with no polling or Telegram delivery;
- a deliberately failing published candidate, successful automatic snapshot
  rollback, quarantine, and a subsequent successful quarantine skip;
- recovery of the exact immutable digest after Docker restart and host reboot;
- enabled, successful, non-overdue timers.

The command writes only schema-defined allowlisted fields to a mode-`0600`
receipt. The repository template remains `pending`; deterministic fake-command
tests demonstrate command order and evidence behavior but are not evidence of
a VPS run. Finalization cannot report `observed-pass` while any group is pending
or failed.
