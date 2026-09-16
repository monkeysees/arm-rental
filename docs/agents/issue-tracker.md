# Issue tracker: GitHub

Issues and specs live in monkeysees/arm-rental. Use the gh CLI.

- Publishing a ticket means creating a GitHub issue.
- Read the complete issue body, labels, and comments when fetching a ticket.
- Before GitHub writes, verify Git author/committer and the authenticated
  GitHub writer against the intended repository identity.
- For issue bodies and comments, write a quoted-heredoc temporary file,
  inspect it, and pass it using --body-file.
- Represent blockers with native GitHub issue dependencies. If unavailable,
  list blocking issue references in the ticket body.
- A ticket can start when all its blockers are complete.
- Apply labels using docs/agents/triage-labels.md.

## Pull requests as a triage surface

PRs as a request surface: no.
