# Plan: restore delivery and close what the outage exposed

List.am redesigned its category cards at about 13:00 UTC on 2026-09-03. The
parser stopped resolving card identities and posting dates, source integrity
failed the crawl, and because startup preflight runs the same check, the
container exited and exhausted its five restarts. Production delivered nothing
from then until the fix below reached the host.

The parser fix was written, tested against the live page, and pushed as
`9b9b649..6d5f41c`. One unrelated blocker stood between a working fix and a
running bot, and closing it is step 1.

## Where things stood

| Fact                       | Value                                            |
| -------------------------- | ------------------------------------------------ |
| Last successful crawl      | 2026-09-03T13:00:03Z                             |
| Container                  | `exited (1)`, restart budget spent               |
| Running revision           | `15b5b15` — the pre-fix code                     |
| `Required CI` on `6d5f41c` | failed at `Scan OS and application dependencies` |
| Published image            | none since 2026-08-23                            |
| Deploy timer               | reporting `noop` / `success` every five minutes  |

Every hour of downtime is permanent data loss, not deferred work: private
delivery only ever sends what List.am posted or changed in the last 24 hours,
so listings the outage spans are already outside the window and will never be
sent unless List.am touches them again.

## Status

| Step                        | State                                    |
| --------------------------- | ---------------------------------------- |
| 1. Unblock the pipeline     | done — `175dc83`                         |
| 2. Confirm recovery         | **open** — waiting on publish and deploy |
| 3. Reconcile a dead service | done — `357e7a9`                         |
| 4. Chromium upgrade         | done — folded into step 1                |
| 5. `state_database_growth`  | done — `a14f24a`                         |
| 6. Two design questions     | deliberately not taken up                |

## 1. Unblock the pipeline — done

`.trivyignore` time-boxed pending Chromium findings with `exp:2026-08-28`,
deliberately, so the exception would re-break the build rather than go stale in
silence. It did exactly that on the first push to `main` since 2026-08-23.

Three things the original plan asserted here were wrong, and checking them
changed the decision:

- **`151.0.7922.169-1~deb12u1` did exist.** It is in snapshot.debian.org, and
  was superseded by `.173` and then by `152.0.7977.75-1~deb12u1`. The file was
  not waiting on an impossible condition; it was waiting on something that
  arrived and moved on.
- **bookworm-security carries `152.0.7977.75-1~deb12u1`, not `.82`.** `.82` is
  the sid/unstable version and is not installable on bookworm.
- **Extending the expiry would not have restored the build.** Trivy reported 16
  HIGH findings against the `151.0.7922.137` pin and only 11 were in the file;
  `CVE-2026-76018` and `CVE-2026-84326/84349/84351/84357` postdated it. No path
  kept the exception at its existing scope.

So the exception was deleted rather than renewed, and the pin moved to
`152.0.7977.75-1~deb12u1` from snapshot `20260904T011450Z`. That required
`puppeteer-core` to move with it — the packaging test asserts the pinned
browser sits in Puppeteer's milestone, and 25.4.0 bundles Chrome 151. 25.10.0
bundles `152.0.7977.75`, the same build Debian ships.

Verified locally before pushing: the image builds, reports
`Chromium 152.0.7977.75 built on Debian GNU/Linux 12 (bookworm)`, passes the
headless browser smoke, and scans to zero HIGH/CRITICAL with no ignorefile.

**Acceptance: `Required CI` green on `main`, `Publish production` publishes a
new digest.**

## 2. Confirm recovery, apartments first and houses second — open

Deployment already gates on ready preflight, healthy probes, one successful
crawl, and continued readiness for one `POLL_INTERVAL_MS` plus five minutes,
and rolls back on its own. No new gate is needed.

A major browser version is exactly the kind of change that can invalidate a
stored List.am verification, so budget for re-running the interactive verifier
per [browser operations](browser-operations.md).

Apartments should otherwise recover on their own. The fixed parser was verified
against the live page: 100 candidates, 0 rejected, integrity **PASS**, and 76 of
the 100 cards on page 1 fall inside the delivery window.

Houses are the open question. Category 1377 answered with
`ERR_BROWSER_VERIFICATION_REQUIRED` on every attempt while apartments succeeded
on every one, so **the house card shape was never observed**. Two things are
unknown: whether houses carry the same redesign (likely, but unconfirmed), and
whether that challenge is transient or persistent.

The parser keeps both the old and new card selectors and matches attributes by
label precisely because of this uncertainty. Once houses are confirmed, the
pre-redesign selector can be dropped.

**Watch for, and do not misread:**

| Signal                       | Expect               | Why it is not a fault             |
| ---------------------------- | -------------------- | --------------------------------- |
| first-page date              | ~99%, not 100%       | some cards genuinely ship no `.d` |
| listings "older" than before | up to ~48h in window | day-granular dates                |
| `crawl.failed` for house     | possible             | challenge, not the parser         |

## 3. Make the deploy timer reconcile a dead service — done

This is the gap that turned a parser bug into a 46-hour outage, and it is
independent of List.am.

`ops/lib/deployment.sh` compared the candidate digest to the running one and,
when they matched, emitted `deployment.noop` with `result: "success"` and exited
0, never asking whether the container was running. Compose's
`restart: "on-failure:5"` had already given up, so nothing else was going to
restart it either.

The noop path now checks liveness first. A container that is healthy, running,
or still inside its healthcheck start period reports noop unchanged; anything
else is restarted via `systemctl restart`, which — unlike start — also covers a
container that is running but wedged. The restart is bounded at three attempts
per hour, and attempts age out of the window rather than clearing on recovery,
so a service that dies every twenty minutes still exhausts its budget.

A spent budget emits `deployment_reconcile_exhausted` and exits non-zero. That
alert is the real deliverable: the failure to fix was never "nobody restarted
it", it was "every operational surface said success while the bot was dead".

**Not done:** the plan also suggested pairing this with a readiness alert that
tracks whether `readiness_failure` ever _stays_ resolved — it fired 13 times
during the outage and self-resolved each time, which is indistinguishable from
noise. That is genuinely separate work and was left out.

## 4. Upgrade Chromium — done as part of step 1

Kept here only to record what it involved, since step 1 absorbed it: the
`Dockerfile` pins, the runtime-metadata assertions in both `quality.yml` and
`publish-production.yml` (the original plan named only the first), the
`puppeteer-core` milestone, the packaging and CI-contract tests, `README.md`,
`docs/architecture.md`, and deleting `.trivyignore`.

## 5. What `state_database_growth` should mean — done

The maintenance timer had exited 2 every week since 2026-08-30 with the
database at 36.8 MiB against a 25 MiB threshold, driven by 245,932
`privateDecisions` rows for 74 recipients, on a disk 26% used with 27 GB free.

The threshold was raised to 256 MiB rather than bounding retention. Daily
snapshots put growth at about 1 MiB/day, so that is roughly seven months of
headroom and about 1% of free disk: routine use will not reach it, and a
tenfold change in growth is visible within weeks.

The WAL keeps the 25 MiB threshold instead of tracking the database. The two are
bounded by different things — the database retains one decision per apartment
per recipient and grows with use, while the WAL is truncated on every
maintenance run, so a large WAL means checkpointing stopped. Sharing one
constant would have made the WAL alert almost unreachable.

## 6. Two design questions — deliberately not taken up

Recorded, not actioned. Neither is a bug and neither should be changed
reactively; both are judgements the outage put a price on.

**One unresolvable anchor fails an entire crawl.** `rejectedCount > 0` is an
absolute rule. It caught the redesign within minutes, which is genuinely
valuable — but it also means a single advertising banner can stop the product,
and List.am decides when banners appear. A ratio, or a small absolute
allowance, would keep the signal without the hair trigger. The counter-argument
is real: a tolerance is a threshold nobody revisits, and identity rejection is
the one signal that says "we no longer understand this page".

**Preflight runs the same check, so a source change is fail-closed.** Refusing
to start is defensible for a bot whose only job is reading List.am. But it
converts "parsing is broken" into "the Telegram bot is entirely unreachable",
including for users only opening their settings, and it is what spent the
restart budget. Consider letting the bot start and serve its Telegram surface
while reporting the source as unhealthy, so degraded is distinguishable from
dead.

## Risks

**Houses may fail after apartments recover.** Because the crawl reads
apartments first and integrity failure aborts the whole crawl, a house-side
failure would take apartments down with it. If that happens, the fastest
mitigation is clearing the house challenge, not touching the parser. That
coupling — one category's source change stopping the other — is itself worth
questioning once service is stable.

**The browser jumped a major version on the same deploy as the parser fix.**
That was the accepted cost of the only path that restored the build. If the
first deploy fails, the two candidate causes are a stale browser verification
and the parser, in that order.

**Both failure modes remain loud.** A card shape this parser cannot read still
raises `ERR_LIST_AM_SOURCE_INTEGRITY` with a typed reason, and a challenge
still raises `ERR_BROWSER_VERIFICATION_REQUIRED` with the `browser.challenge`
event. What the outage showed is that being loud is not enough when the surface
that reports success never checks whether the service is alive. That was step 3,
and it is the one item here that changes the next outage rather than this one.
