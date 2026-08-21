# Plan — remove the listings/messages JSON state

Written 2026-08-20, after investigating `host_readiness_failure` on `production`
at revision `7af4012`. Re-scoped after two decisions from the owner:

- **Rollback to a pre-SQLite release is not wanted.**
- **Only the listings/messages JSON matters. Meta files are out of scope.**

Status: **in progress** — see [Implementation status](#implementation-status).
No production host state has been changed.

---

## Implementation status

| Step | Work                                                  | State                                                  | Commit    |
| ---- | ----------------------------------------------------- | ------------------------------------------------------ | --------- |
| 1    | Part 1 — delivery hot path (1.1–1.4)                  | **done**                                               | `78e2b64` |
| 2    | Liveness recovery — both defects together             | **done**                                               | `8e905f3` |
| 3    | Part 2 — remove the JSON application-state backend    | **done**                                               | `962e22c` |
| 4    | Re-measure crawl tail and browser timeouts            | blocked — needs Parts 1–3 deployed to production first | —         |
| 5    | Part 3 — remove JSON migration and rollback machinery | not started                                            | —         |
| 6    | Part 4 — the five sentinel files on disk              | **declined** — owner chose to leave them on disk       | —         |

### Owner decisions taken during implementation

- **The `pre-sqlite` snapshot is kept, untouched.**
  `/mnt/rental-apartments-backups/protected/pre-sqlite-2026-08-19T07-32-32-202Z`
  stays on the production host. Part 3 makes it unreadable by this release; it
  remains raw JSON an operator could inspect by hand. No production host state
  was changed.
- **Part 4 is declined.** The five sentinels stay on disk. The plan itself puts
  the value in Parts 1–3 and rates this at 920 bytes, so the fail-closed
  behaviour an old image still gets from them is worth more than the space.
- **Re-measurement (step 4) waits on deployment.** All work here is committed to
  local `main` only.

---

## Scope

**In scope — the five application-state paths and everything that serves them:**

| File                               | Holds                                    |
| ---------------------------------- | ---------------------------------------- |
| `apartments.json`                  | listings                                 |
| `telegram-deliveries.json`         | private per-recipient delivery decisions |
| `telegram-channel-deliveries.json` | channel messages                         |
| `telegram-bot.json`                | Telegram update offset and users         |
| `exchange-rates.json`              | the CBA price snapshot                   |

(The last is not literally listings or messages, but it is one of the five
legacy application-state paths and rides the same interface, so it goes with
them.)

On production all five are already 184-byte `sqlite-migrated` sentinels holding
no data. SQLite has been the live backend since 2026-08-19T07:33:55Z.

**Out of scope — meta files, explicitly not wanted:** `state-backend.json`,
`.singleton.json` / `.singleton.sock`, `.maintenance-history.json`, backup
`manifest.json`, `chrome-profile/.rental-apartments-verification.json`. See
[Meta files](#meta-files--out-of-scope-with-one-unavoidable-touch) for the single
place the work unavoidably touches one.

---

## Why this is the right fix, not a workaround

The in-scope work is not cosmetic — it is the direct cause of the page.

Measured on production, per **single-row** delivery save:

| Step                                                                              | Cost       |
| --------------------------------------------------------------------------------- | ---------- |
| `loadAllDecisions()` — scan 146,353 rows, build objects, validate every timestamp | **876 ms** |
| `sameValue` sweep across all 59 recipients                                        | **421 ms** |
| the actual write                                                                  | 1 row      |
| fsync                                                                             | **2.3 ms** |

≈**1.3 s of blocking JavaScript per notification**, 40–90 times back to back per
delivery burst. Recipients deliver concurrently (`src/crawler.js:580`) while
writes serialise through one chain, so the event loop is blocked
near-continuously for the whole burst.

Captured live, 16:54:09–16:54:53 — seven consecutive readiness probes failing at
~3.26 s each (the 3 s budget in `src/health-check.js:20` plus ~260 ms of
`docker exec` and Node startup), aligned exactly with a delivery burst that
began at 16:54:11:

```
16:54:09 probe=NOT_READY exec_ms=3261 load1=0.69 chromium_cpu=0
16:54:16 probe=NOT_READY exec_ms=3265 load1=1.04 chromium_cpu=0
...
16:54:53 probe=NOT_READY exec_ms=3256 load1=1.88 chromium_cpu=0
```

Two facts to carry into the work:

- **The probe fails by timeout, never by 503.** The application never declared
  itself unready: `/ready` returns 200 with empty `reasons`, its own
  `readiness_failure` alert never fired, `applicationTransitionKeys` is empty.
- **`chromium_cpu=0` throughout.** Browser contention is not required to produce
  the stall. Adding CPU would not have prevented this page.

Rate today: 69 clean monitor evaluations, 6 rescued by the retry, **12 failed
both attempts (~14%)**. Two adjacent failures were a matter of time.

The root cause is that the SQLite backend is still driven through a file-shaped
`loadState(path)` / `saveState(path, wholeState)` interface, which exists only so
the JSON and SQLite backends can be swapped for one another. Removing the JSON
backend is what lets that interface go.

---

## Part 1 — the delivery hot path

This is the whole performance fix. Ship it first; it stands alone.

### 1.1 Give private delivery a per-recipient write path

`src/sqlite-state-access.js:36`:

```js
function savePrivateState(database, repository, state) {
  const previous = repository.loadAllDecisions();   // 876 ms, 146k rows
  ...
  return database.transaction("private_delivery_state_commit", () => {
    for (const recipientId of changedKeys(previousRecipients, nextRecipients)) {
      ...
      if (!next || sameValue(prior, next)) continue; // 421 ms across 59 recipients
```

`src/crawler.js:454` calls `saveState(config.deliveryStateFile, deliveryState)`
once per recipient per item, passing the **entire** state object, because that is
the only shape the interface offers. The comment at `src/crawler.js:428` still
describes the world it came from: _"their independent histories live in one JSON
file."_

Replace the injected `loadState`/`saveState` seam in the delivery path with a
direct repository call writing one recipient's decisions. The repository already
has the primitives — `addDecisions`, `acknowledge`, `removeFilteredDecision`,
`ensureRecipient`, `initializeSelection` — and they already accept
`{ transaction: false }` for composition.

Expected effect: ~1.3 s → single-digit ms per notification. This alone should
retire `host_readiness_failure` and `state_transaction_latency`.

### 1.2 Delete `sameValue` / `canonicalValue` from the delivery path

`src/sqlite-state-access.js:15-30`. Introduced (commit `95bc0f3`) to compare
bounded state commits by meaning rather than key order — a guard that only makes
sense when diffing two whole-state snapshots. After 1.1 there is no snapshot to
diff.

Note this sweep runs _inside_ the transaction, so it is what
`state_transaction_latency` has actually been measuring. The fsync is 2.3 ms;
`PRAGMA synchronous = FULL` (`src/sqlite-database.js:377`) is **not** implicated
and should be left alone.

### 1.3 Fix `loadRecipient()`

`src/sqlite-private-deliveries-repository.js:107` does a full 146k-row scan to
look up one recipient. Only reached from tests today, but it is the same
landmine and 1.1 will want a correct version.

### 1.4 Move the transaction metric to cover the real work

`loadAllDecisions()` runs _outside_ `database.transaction()`, so its 876 ms was
never in the p95 the alert watches — the alert saw 544 ms of a real ~1300 ms.
After 1.1, make the metric bracket the remaining work.

---

## Part 2 — remove the JSON application-state backend

With Part 1 done, nothing on the hot path needs the file-shaped interface.

- `src/application-state.js:22-30` — delete the `selector.backend === "json"`
  branch returning `{ loadState: readState, saveState: writeState }`.
- `src/state-backend.js:8` — drop `"json"` from `BACKENDS`.
- `src/sqlite-state-access.js` — once every caller uses repositories, the whole
  filename-routing module goes (`samePath`, and the `loadState`/`saveState`
  routers at `:182-220`).
- The `loadState`/`saveState` default-parameter seams in `src/crawler.js:87,194`,
  `src/bot.js:831`, `src/channel.js:344`, `src/exchange-rates.js:100`,
  `src/preflight.js:335`.
- `src/preflight.js:92-138` — `stateSpecifications` and `validateExistingState`
  exist to validate JSON files. With SQLite the router already validates rows;
  work out what preflight should assert instead rather than deleting the check
  outright.
- **`observeStateWrites`** (`src/state.js:27`, wired at `src/application.js:67`)
  observes only JSON application-state writes. Production has reported
  `"stateWrites": []` since cutover — it is already dead. Remove it and the
  `stateWrites` field in the status contract with it.

---

## Part 3 — remove the JSON migration and rollback machinery

In scope because all of it exists solely to read or write listings/messages
JSON, and rollback is not wanted. This is the irreversible part; it is also the
part with no runtime benefit, so it should land _after_ Parts 1–2 are proven.

- `src/state-migration.js` (595 lines) and `src/state-migration-cli.js` — the
  JSON→SQLite importer. Production is migrated; after this no host can migrate
  from JSON again.
- `src/release-compatibility.js:1,17` — the `"json"` backend in release
  metadata.
- `ops/lib/deployment.sh:323-343` and `ops/deploy:188-214` — the
  `json-to-sqlite` transition gating.
- `src/recovery.js` — `JSON_BACKUP_VERSION` (`:44`), the manifest-v1 branch and
  `snapshotClass: "pre-sqlite"` handling (`:481-545`, `:596-635`), and
  `validateJsonRecoveryState` (`:197`).
- `src/state-backend.js:128` — `requireBridgeJsonBackend`, and the
  `allowNonJsonBackend` parameter threaded through `src/config.js:443,474`,
  `src/application.js:83`, `src/maintenance-cli.js:13`,
  `src/state-migration-cli.js:22`, `src/recovery-cli.js:33,76`.

**Before doing this, note what it strands:**
`/mnt/rental-apartments-backups/protected/pre-sqlite-2026-08-19T07-32-32-202Z`
is the only copy of the pre-migration state, and after Part 3 nothing in the
tree can read it. Decide deliberately whether to keep or delete the snapshot
itself.

---

## Part 4 — the five files on disk

Deleting the sentinels is **safe for everything currently running**. Verified
against every consumer:

- **The app never reads them.** `src/application.js:159` passes
  `applicationState.loadState` into preflight; in SQLite mode that is the
  repository router (`src/sqlite-state-access.js:184-199`), so preflight
  validates rows, not files. This is why production starts cleanly today despite
  the sentinels being "incompatible" — the file path is never taken.
- **Maintenance never reads them.** `src/maintenance.js:423-431` — the sqlite
  branch reports only `sqliteStateReport` plus `browserVerification`.
- **Backup/recovery never reads them.** `src/recovery.js:285-288` branches to
  `validateSqliteRecoveryState`; `copyData` skips `ENOENT` (`:386`).
- **`ops/` has no references** to any of the five filenames.
- **Nothing recreates them** — `installSentinels` runs only during migration.

What they currently buy, and what is given up: they are the reason an older
pre-SQLite image **fails closed** rather than starting empty. The mechanism is
two adjacent branches in `src/preflight.js`:

```js
if (state === undefined) continue;            // :155  absent  = fresh install, skip
if (!specification.types.has(state?.type))    // :158  present = refuse to start
  throw new StateCompatibilityError(...);
```

With the files gone, an old image reads `undefined`, hits `continue`, passes
preflight, and starts on empty state — re-notifying 2,592 apartments to 59
recipients (~146k sends), re-publishing the channel, and resetting
`update_offset` to 0. Accepted, given rollback is not wanted.

Practical note: deleting them recovers 920 bytes. The value is in Parts 1–3;
these files are an afterthought, and there is no urgency to remove them from
disk at all.

---

## Meta files — out of scope, with one unavoidable touch

Not being changed: `.singleton.json` / `.singleton.sock` (the lock that stops a
second writer opening the database), `.maintenance-history.json` (deliberately
excluded from the growth totals it feeds), backup `manifest.json` (carries the
hashes used to decide whether a snapshot can be trusted at all), and
`chrome-profile/.rental-apartments-verification.json` (travels with the cookies
it describes).

`src/state.js` therefore stays — `readState`/`writeState` provide the atomic,
fsynced, 0600, self-rollback write those files depend on. Its _role_ shrinks to
small control files. Only `observeStateWrites` goes (Part 2).

**The one unavoidable touch — `state-backend.json`.** Not because the file
changes, but because Part 2 changes what happens when it is missing. Today
`parseStateBackendSelector(undefined)` returns an _implicit JSON_ backend
(`src/state-backend.js:68-71`), which currently means an absent selector
silently starts the app on empty state.

Part 2 improves this by accident: with the JSON branch gone,
`src/application-state.js` falls through to SQLite, and the
`databaseId` cross-check at `:38-47` fails against the implicit selector's
`undefined` — so it errors instead of losing data. **Make that explicit rather
than incidental**: have `parseStateBackendSelector(undefined)` throw. One line,
and it closes the only remaining silent-data-loss path.

---

## Separate from the JSON work — still needs fixing

Independent of the state backend; none of this goes away with the work above.

### The liveness recovery has never worked, and fixing it naively is dangerous

Verified on production without signalling anything:

```
WOULD SIGKILL pid 1 -> "/sbin/docker-init -- docker-entrypoint.sh node src/index.js"
```

Two defects that **must be fixed together**:

1. `isApplicationCommand` (`src/health-check.js:49`) matches docker-init, because
   `src/index.js` is its own argv entry in PID 1's command line and `/proc`
   readdir yields `1` before `7`. SIGKILL to a PID-namespace init from inside the
   namespace is discarded by the kernel — hence `RestartCount=0` despite repeated
   liveness failures.
2. `src/health-check.js:86` runs `terminateApplication()` on the **first** failed
   probe. `retries: 2` in `compose.production.yaml:48` governs only the health
   _status_, not the command.

Fix (1) alone and every transient stall SIGKILLs production. The bug is
currently masking itself — it is the only reason these stalls have not been
restarting the container.

### Probe budgets are mistuned

3 s timeout (`src/health-check.js:20`); 5 s retry delay
(`ops/lib/observability.sh:17`), which lands _inside_ the same two-minute burst.
Worth widening as a stopgap if quiet is wanted before Part 1 lands — but it is a
mitigation, and should be returned to sane values afterwards rather than left as
permanent slack.

### Browser protocol timeouts and crawl tail

`Runtime.callFunctionOn timed out` every ~5–10 min; 2 crawl failures/hour (5.9%);
crawl p95 **123 s** against a p50 of 9.6 s. Partly CPU starvation, partly CDP
messages not being pumped while the loop is blocked — so Part 1 should improve
it. **Re-measure after 1.1 before investigating.**

### Capacity

2 vCPU running headless Chromium alongside everything else; Chromium observed at
~150% during crawls with the Node main thread on ~15%, and no container CPU
limits. Real, but demoted: the captured stall reproduced with Chromium at zero.

### Growth

`private_delivery_decisions` ≈ recipients × apartments (59 × 2,592 = 152,928;
actual 146,353, no orphans, so pruning is sound). Bounded today, but every new
recipient adds ~2,592 rows and there are already 82 Telegram users against 59
with decisions. After 1.1 the hot path no longer scales with this — the main
reason Part 1 matters beyond the immediate alert.

---

## Suggested order

1. **Part 1** (1.1 + 1.2 + 1.4 as one change). Retires the page and the latency
   alert. Everything else is optional relative to this.
2. **Liveness recovery**, both defects together. Never ship one half.
3. **Part 2** — including the explicit selector throw.
4. **Re-measure** the crawl tail and browser timeouts; investigate what survives.
5. **Part 3** — irreversible; decide on the `pre-sqlite` snapshot at the same
   time.
6. **Part 4** — whenever; it is 920 bytes.

## Checks before any push

Run the four Required CI steps locally, shellcheck included.
`test/docs-consistency.test.js` validates every tracked `docs/**.md`, so
documentation changes in `docs/architecture.md`, `docs/health-readiness.md`,
`docs/observability.md`, `docs/release-and-rollback.md`, and
`docs/state-recovery.md` must land with the code that invalidates them.

This file sits at the repository root and untracked on purpose: only `README.md`
and `docs/**.md` are in the maintained documentation set, so a plan document here
does not have to satisfy the docs contract.
