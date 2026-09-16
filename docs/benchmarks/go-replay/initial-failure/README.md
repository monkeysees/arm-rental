# Initial diagnostic failure

The initial 500-recipient virtual run on September 16, 2026 passed the Go
runner's internal shared behavior verifier but emitted only 65,536 bytes of JSON
before an explicit Node exit truncated stdout. The measurement coordinator
correctly marked the run failed. `manifest.json` records the command, environment,
times, and parse error; `truncated-output.txt` retains the incomplete bytes.
This is diagnostic evidence, not a resource or capacity result.

The wall run started by that sequence was canceled. A subsequent virtual
diagnostic was canceled while redundant pre-deadline payload queries were
removed. The focused Go contract test then caught a fractional-token virtual-clock
stall introduced by the changed event schedule; refill tolerance and an
independent transport-rate audit resolve it. Later full passes were superseded
by the final repeat sequence so the primary cgroup sample also includes the
coordinator's post-worker verification. Only the sibling `final/` directory
contains accepted resource evidence.
