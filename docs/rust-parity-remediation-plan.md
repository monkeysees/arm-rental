# Rust parity remediation plan

The standalone Rust candidate has five confirmed regressions against the Node
production contract. Resolve them before treating the candidate as ready for a
production cutover. The [parity ledger](rust-parity.md) records the earlier
acceptance run; its passing tests did not exercise these failure boundaries.

The baseline is the current Node implementation in `src/`, together with the
behavior documented in the [README](../README.md), [state maintenance](state-maintenance.md),
and [state recovery](state-recovery.md) runbooks. Use synthetic peers and disposable
SQLite databases for the checks below. Keep the Node oracle independent of Rust
results.

## Fixes and regression checks

1. **Restore the live disk check.** In
   [`rental-app.rs`](../experiments/rust-replay/src/bin/rental-app.rs), remove
   the application singleton requirement from `storage:check` while retaining
   it for `maintenance:report`. Keep the operations lock in `ops/storage-check`;
   that lock serializes host operations without stopping the service. Add a
   process test that holds the application lease, runs the native disk check,
   and proves it reads the filesystem and returns a result rather than
   `ERR_SINGLETON_LOCKED`. Also prove maintenance still refuses a live service.

2. **Restore maintenance exit and event contracts.** Make `storage:check`
   return `0` for healthy storage, `2` for a low disk warning, and `1` for a
   command failure. Make `maintenance:report` return `2` when either state size
   alert is active, `0` when neither is active, and `1` on failure. Emit the
   documented bounded `storage.low_disk` or `storage.disk_ok` observation and
   the matching alert transition; emit `maintenance.report` and the firing or
   resolved state growth alerts. Cover both warning and healthy cases with
   native CLI tests and verify the `ops/storage-check` and `ops/maintain`
   wrappers preserve the exit status. Use an isolated high disk threshold and
   a sparse 256 MiB test database to make the warnings deterministic.

3. **Commit history answers with their Telegram offset.** In
   [`bot.rs`](../experiments/rust-replay/src/production/bot.rs), include the
   history `send` or `skip` decision and the consumed update offset in one
   SQLite transaction. Preserve the current ordering for callbacks whose
   offset is intentionally acknowledged only after a Telegram response. Add
   failure injection at the decision write and immediately before commit: on
   either failure, the offset and decisions must both remain unchanged. After
   restart, replaying the callback must apply its answer exactly once. Cover
   both accepted and declined history.

4. **Drop deleted or inactive recipients before waiting.** In
   [`runtime.rs`](../experiments/rust-replay/src/production/runtime.rs), check
   recipient existence, active state, authorization, and pending deletion
   before deferring a queued delivery job until its retry or rate limit
   deadline. Ensure deletion can wake the scheduler promptly even when no
   other recipient is active. Add a local service test where Telegram returns
   `429 retry_after=60`, the recipient confirms deletion, and the crawl
   completes and starts its next source cycle well before 60 seconds. Check
   that another recipient's delivery continues and no deleted recipient is
   sent or acknowledged.

5. **Use saved source history in startup preflight.** In
   [`runtime.rs`](../experiments/rust-replay/src/production/runtime.rs), pass
   each category's saved first page counts to the same integrity evaluation
   used during crawling. Reuse the stored, validated history rather than an
   empty array. Add a process test with saved apartment counts `[20,20,20]`
   and one valid card on the first page: startup must report
   `FIRST_PAGE_COUNT_DROP`, remain unready, and leave crawl state unchanged.
   A normal first page and a category with no history must still become ready.

## Verification and closeout

- Run the focused Node versus Rust tests for each fix, including process
  restart and injected SQLite failures. The tests must fail against the
  current candidate and pass after the fixes.
- Run the pinned Rust formatting, check, test, Clippy and release build, then
  the repository's Node lint, formatting, full test, coverage and production
  contract gates. Use `RENTAL_APP_BINARY` for the native differential tests;
  see [Rust development](rust-development.md#build-and-regression-checks).
- Repeat packaged service and maintenance acceptance after the CLI and runtime
  changes. Repeat the 500 recipient fairness, durability and capacity run after
  the scheduler change, since removing deferred work changes its timing.
- Record the new source revision, artifact identity and results in the
  [parity ledger](rust-parity.md). Replace the earlier acceptance claim only
  with evidence from the fixed artifact. Production publication and cutover
  remain separate decisions.
