# Changelog

## Unreleased

- Install the patched PCRE2 runtime library so the Chromium-free image passes the production vulnerability scan.
- Replace Chromium and Puppeteer with pinned Safari-profile HTTP fetching, private cookies, bounded redirects, paced requests, and server-directed retry cooldowns; remove browser verification, sandbox privileges, and profile backups.
- Read private delivery history only for relevant listing IDs, preserving retained decisions and notification behavior while allowing the four-million-decision benchmark to complete within 512 MiB.
- Add an offline resource benchmark for 1,000 active monitorings, real SQLite and simulated source responses, with delivery recovery checks across process restarts.
- Honor source-challenge grace in host readiness alerts and include specific readiness or probe failure reasons in alerts and status.
- Avoid repeated filtering and date parsing across private recipients, and yield between recipient workers to keep health probes and source I/O responsive.
- Add contact and channel details to the bot welcome text and short profile description.
- Give application SQLite scratch files a dedicated 128 MiB filesystem.
- Fix readiness alerts bypassing the five-crawl grace period for transient runtime source challenges.
