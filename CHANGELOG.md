# Changelog

## Unreleased

- Match desktop Chrome's reduced user-agent format while preserving full-version client hints, and remove the redundant JavaScript webdriver override.
- Honor browser-challenge grace in host readiness alerts and include specific readiness or probe failure reasons in alerts and status.
- Avoid repeated filtering and date parsing across private recipients, and yield between recipient workers to keep health probes and browser I/O responsive.
- Present the installed Chromium version to List.am in the user agent and client hints; remove the separate browser identity pin and `BROWSER_USER_AGENT_VERSION` override.
- Update pinned Chromium to 152.0.7977.82 to fix CVE-2026-85049 and restore the production image security scan.
- Add contact and channel details to the bot welcome text and short profile description.
- Give application SQLite scratch files a dedicated 128 MiB filesystem, separate from Chrome's 128 MiB temporary storage.
- Fix readiness alerts bypassing the five-crawl grace period for transient runtime browser challenges.
