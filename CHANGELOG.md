# Changelog

## Unreleased

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
- Add an offline resource benchmark for 1,000 active monitorings, real SQLite and simulated source responses, with delivery recovery checks across process restarts.
- Honor source-challenge grace in host readiness alerts and include specific readiness or probe failure reasons in alerts and status.
- Avoid repeated filtering and date parsing across private recipients, and yield between recipient workers to keep health probes and source I/O responsive.
- Add contact and channel details to the bot welcome text and short profile description.
- Give application SQLite scratch files a dedicated 128 MiB filesystem.
- Fix readiness alerts bypassing the five-crawl grace period for transient runtime source challenges.
