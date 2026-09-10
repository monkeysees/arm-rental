# Changelog

## Unreleased

- Present the installed Chromium version to List.am in the user agent and client hints; remove the separate browser identity pin and `BROWSER_USER_AGENT_VERSION` override.
- Update pinned Chromium to 152.0.7977.82 to fix CVE-2026-85049 and restore the production image security scan.
- Add contact and channel details to the bot welcome text and short profile description.
- Give application SQLite scratch files a dedicated 128 MiB filesystem, separate from Chrome's 128 MiB temporary storage.
- Fix readiness alerts bypassing the five-crawl grace period for transient runtime browser challenges.
