# Production recovery exercises

This runbook gathers allowlisted evidence for the final production recovery
checks. The repository contains no claim that these checks ran on a real VPS.
The checked-in
[`production-exercise-evidence.template.json`](production-exercise-evidence.template.json)
is deliberately `pending`; an authorized operator creates a separate
mode-`0600` observation file on the production host.

`ops/production-exercise` never reads the production environment file and never
copies raw command output or journal records into evidence. It records only
immutable image references, unit results, health states, timer timestamps,
exercise timestamps, boot IDs, and boolean assertions described by
[`production-exercise-evidence.schema.json`](production-exercise-evidence.schema.json).

## Prerequisites and change record

Before the window:

- obtain approval for a production restore drill, Docker restart, host reboot,
  and a deliberately failing deployment candidate;
- retain a recent validated production snapshot and confirm no other operation
  holds `/var/lib/rental-apartments-ops/operations.lock`;
- publish a candidate whose startup verification fails safely, without state
  migration or intentional Telegram/List.am side effects, and advance the
  authorized production discovery pointer to that digest;
- record the current immutable digest as `PREVIOUS_IMAGE` and the failing
  digest as `FAILED_IMAGE`; neither value may be a mutable tag;
- keep a second SSH session and the provider console available for reboot
  recovery.

Do not create a failing candidate by corrupting the production state, revoking
credentials, changing Telegram permissions, disabling the backup mount, or
interfering with an upstream service. The exercise command does not mutate the
registry pointer; publication authorization remains separate.

Create the observation file on the protected operations filesystem:

```sh
install -d -m 0700 /var/lib/rental-apartments-ops/exercises
sudo /opt/rental-apartments/current/ops/production-exercise init \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json \
  --actor human:OWNER \
  --host-alias production-vps
```

Expected result: a mode-`0600` JSON file with `evidenceKind` set to
`production-observation`, every exercise `pending`, and no completion time.

## Isolated restore drill

```sh
sudo /opt/rental-apartments/current/ops/production-exercise restore-drill \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json
```

Expected result: `restoreDrill.status` is `observed-pass`, the unit result and
terminal event are successful, and duration is below the unit's bounded
runtime. The underlying drill uses a networkless temporary volume and removes
only its labeled resources. On failure, leave the evidence as
`observed-fail`, inspect `rental-restore-drill.service`, and follow
[persistent-state recovery](state-recovery.md); do not attach the temporary
volume to the bot.

## Failed deployment and automatic rollback

Confirm the currently active image still equals the reviewed previous digest,
then run:

```sh
sudo /opt/rental-apartments/current/ops/production-exercise \
  failed-deployment \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json \
  --candidate "$FAILED_IMAGE" \
  --previous "$PREVIOUS_IMAGE"
```

The first deploy service invocation must fail after candidate verification,
write a failed receipt, restore the snapshot and previous digest, regain
readiness, and quarantine the candidate. The harness then invokes the deploy
service again and requires a successful quarantine skip. This proves the timer
does not loop through the bad digest and leaves the intentional failure cleared
before timer-freshness evaluation.

Expected result: rollback is `completed`, the previous immutable digest is
restored and healthy, the quarantine file exists, and
`quarantinedRetrySkipped` is true. A failed rollback is an incident: keep the
unit failed, do not clear quarantine, use the provider console if readiness is
lost, and follow [release and rollback](release-and-rollback.md).

## Docker and host restart recovery

The Docker phase is disruptive and proves the service returns the same digest:

```sh
sudo /opt/rental-apartments/current/ops/production-exercise docker-restart \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json
```

Expected result: Docker, `rental-apartments.service`, and container health are
active/healthy, and the before/after digests match.

The host phase is deliberately split across boots. The explicit acknowledgement
prevents an accidental reboot:

```sh
sudo /opt/rental-apartments/current/ops/production-exercise reboot-before \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json \
  --request-reboot
```

After SSH returns on the new boot:

```sh
sudo /opt/rental-apartments/current/ops/production-exercise reboot-after \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json
```

Expected result: boot IDs differ, image digests match, and Docker, the
application unit, and container health are ready. If the host does not return,
use the provider console. If Docker returns but the bot does not, inspect
`systemctl status rental-apartments.service` and the bounded journal without
editing the immutable-image record.

## Timer freshness and finalization

Run freshness only after the quarantine-skip invocation:

```sh
sudo /opt/rental-apartments/current/ops/production-exercise timers \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json
sudo /opt/rental-apartments/current/ops/production-exercise finalize \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json
sudo /opt/rental-apartments/current/ops/production-exercise validate \
  --evidence /var/lib/rental-apartments-ops/exercises/production.json
```

Every required timer must be enabled, have a future trigger, report a
successful last service result, and remain inside its schedule-specific age
limit. A newly installed timer with no prior trigger remains `pending`; missing,
disabled, overdue, or failed timers become `observed-fail`.

`finalize` produces `observed-pass` only when all five exercise groups passed.
Any observed failure produces `observed-fail`; incomplete work stays `pending`
with no completion time. Review the JSON against its schema, retain it with the
deployment receipts under the root-only operations directory, and attach only
that sanitized file—not raw logs or the environment file—to the launch record.
