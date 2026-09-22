# Changelog

## Unreleased

- Reduce the experimental Rust retained-history working set with a covering revision index, bounded catch-up payload loading and a measured SQLite cache policy, preserving all 500-recipient decisions and recovery behavior.

- Bound experimental Rust seed writes with durable resumable batches, explicit WAL retention/checkpoint policies, and independent storage/recovery measurements while preserving atomic classification and per-message acknowledgements.

- Limit replay workloads and acceptance criteria to 500 recipients, remove larger-population results, and retain the measured 500-recipient evidence.

- Measure unchanged Go and Rust replays in a persistent service-only cgroup with separately accounted external harnesses, exact-byte memory limits, recovery verification, and preserved original comparison results.

- Compare Node, Go, and Rust with correctness-gated repeated workloads, narrower Node history classification, memory attribution, controlled curl transport, and complete experimental runtime artifacts.

- Verify Go and Rust interruption recovery at 500 recipients with durable-prefix checks, acceptance-before-acknowledgement diagnostics, full shared replay verification, and repeated resource measurements.

- Add an isolated Rust 500-recipient replay with compact SQLite decisions, bounded fair delivery, shared verification, clean-reopen checks, and constrained resource measurements.

- Add an isolated Go 500-recipient replay with compact SQLite decisions, fair rate-limited delivery, clean-reopen checks, shared verification, and constrained resource measurements.

- Add an offline 500-recipient Node replay contract, independent result verification, durable restart checks, and repeated constrained-container resource measurements for the runtime experiment.

- Keep Telegram controls available during recoverable startup source failures and retry preflight every minute without exhausting supervisor restarts; begin crawling only after recovery.

- Alert on journal filesystem free space instead of normal retention usage, with the same recovery hysteresis as data and backups.

- Keep firing host readiness alerts active across sampling gaps and container replacements until a fresh probe confirms recovery.

- Preserve distinct and recurring application alert transitions instead of suppressing them as duplicate warnings.

- Send the List.am navigation referrer with category requests to avoid the observed edge challenge while preserving browserless one-minute crawling.

- Validate published image schema labels against the application schema version so upgrades no longer fail a stale publication check.

- Bound private delivery to eight fair concurrent operations, release capacity during rate-limit and retry waits, and keep pending payloads out of recipient queues while preserving deletion and restart recovery.

- Process private and channel deliveries from shared source revisions and durable pending work, preserving history choices, retries, ordering, and snapshot-backed upgrades.
- Compact private delivery history without losing decisions, with an exact-millisecond schema migration and snapshot-safe rollback.
- Persist crawls incrementally with indexed category watermarks, atomic encountered-listing updates, retained ordering, and compatible snapshot recovery.
- Add a production-shaped retained-history benchmark with repeated crawls, delivery recovery, and isolated-container resource measurements.
- Add guarded, dry-run-first cleanup of the retired Chromium profile with separate backup usage reporting and recovery validation.
- Build a minimal production runtime image and verify initialization, recovery, maintenance, health, and shutdown without network access.
- Install the patched PCRE2 runtime library so the Chromium-free image passes the production vulnerability scan.
- Replace Chromium and Puppeteer with pinned Safari-profile HTTP fetching, private cookies, bounded redirects, paced requests, and server-directed retry cooldowns; remove browser verification, sandbox privileges, and profile backups.
- Read private delivery history only for relevant listing IDs, preserving retained decisions and notification behavior while allowing the four-million-decision benchmark to complete within 512 MiB.
- Add an offline resource benchmark with real SQLite and simulated source responses, with delivery recovery checks across process restarts.
- Honor source-challenge grace in host readiness alerts and include specific readiness or probe failure reasons in alerts and status.
- Avoid repeated filtering and date parsing across private recipients, and yield between recipient workers to keep health probes and source I/O responsive.
- Add contact and channel details to the bot welcome text and short profile description.
- Give application SQLite scratch files a dedicated 128 MiB filesystem.
- Fix readiness alerts bypassing the five-crawl grace period for transient runtime source challenges.
