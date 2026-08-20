# Health and readiness operations

The application serves private HTTP probes on `127.0.0.1:8787` by default.
Production configuration accepts only `127.0.0.1` or `::1` for `HEALTH_HOST`;
the Compose service publishes no port. Operators and monitoring agents must
therefore run in the container's network namespace or use another explicitly
access-controlled platform mechanism.

## Endpoints

- `GET /live` returns HTTP 200 only when the Node.js event loop can accept and
  answer a new request. It contains the application version and process
  timestamps.
- `GET /ready` and `GET /health` return HTTP 200 when work can be performed and
  HTTP 503 otherwise. They report sanitized component states for configuration,
  storage, Telegram, browser, List.am, and CBA.

Health output never includes credentials, Telegram owner or channel
identifiers, apartment records, upstream response bodies, error messages, or
stacks.

Readiness first requires a successful startup preflight. When private
monitoring is active or a channel is configured, it also requires at least one
successful crawl. It becomes false at five consecutive crawl failures or once
the last successful crawl is ten minutes old, whichever occurs first. A later
successful crawl resets the failure counter and freshness clock.

A List.am security challenge is a distinct `challenge` browser status with
reason `BROWSER_VERIFICATION_REQUIRED`. Runtime fetching immediately retries
the challenged page once in a fresh Chrome process. If that retry permits the
complete crawl to succeed, the crawl clears the component and emits the
matching alert resolution because it proves that the browser can fetch and
validate the source again. A startup/preflight challenge cannot recover this
way because the runtime-only retry and crawling have not begun; follow
[`browser-operations.md`](browser-operations.md) before restarting the service.
Other stable component statuses distinguish List.am transport/parsing, CBA,
Telegram, storage, browser startup, and configuration failures without copying
their potentially sensitive errors into HTTP.

Any hard source-integrity failure makes readiness false immediately with
`LIST_AM_SOURCE_INTEGRITY`, without waiting for the five-failure or stale-crawl
threshold. A valid observation of every fetched page clears that reason even
if a later state, private-delivery, or channel operation fails. Health output
contains only the stable reason and aggregate component status; inspect the
sanitized `source.integrity.failed` event for the rule and counts.

The CBA component reports `WARN_EXCHANGE_RATES_STALE` after a usable snapshot is
more than 48 hours old. This warning does not by itself disable crawling. If
monitoring requires the currency-conversion service and no usable snapshot
exists, readiness is false with `EXCHANGE_RATES_UNAVAILABLE`.

## Container supervision

The image and Compose definition run this liveness command every 30 seconds:

```sh
node src/health-check.js --restart-unresponsive
```

The command runs outside the application event loop in the same container and
gives the private `/live` endpoint three seconds to answer. That budget is
deliberately shorter than Compose's five-second healthcheck timeout: a failed
probe must be able to record the failure and exit before Docker kills the check
itself, or the recovery below could never advance.

Docker runs this command on every probe, not only on the ones that decide the
reported health status, so the command counts consecutive failures itself and
terminates the application only on the third in a row. Two failed probes
already report the container unhealthy through `retries: 2`, which makes the
kill deliberately one probe behind the alert: the application must have been
unable to answer for two full 30-second intervals — roughly 60 to 75 seconds
including each probe's own budget — before anything is signalled. A single
successful probe ends the run, so a transient event-loop stall recovers without
a restart. The earliest a fresh container can reach three failures is its
90-second probe, 30 seconds past the 60-second start period reserved for
preflight.

The count lives in a private `0700` directory under the container's `/tmp`
tmpfs, which the kernel recreates empty at every container start, so a
replacement container never inherits its predecessor's failures and the count
is never written to the persistent data volume. A missing, unreadable, or
malformed count is treated as no failures at all: a counter that cannot be
trusted never becomes the reason production is killed.

Termination targets the Node process that is executing `src/index.js` — the
executable in `argv[0]` with the script as its first non-option argument. The
container's minimal init is PID 1 and lists the same script among its own
arguments (`/sbin/docker-init -- docker-entrypoint.sh node src/index.js`), and
`/proc` yields it first; it is never the target, both because it fails that
test and because a PID namespace's init cannot receive an unhandled signal
raised inside the namespace. Killing the application makes init exit non-zero
and Docker's bounded `on-failure` policy restarts the container, which is
visible as an increased `RestartCount` and, if it repeats, the
`process_restart_loop` alert.

The Docker healthcheck intentionally does not use readiness: restarting a
responsive process does not remediate missing channel permissions, a browser
challenge, stale crawling, or an unavailable upstream.

Inspect liveness from the deployment host. Only the supervised
`--restart-unresponsive` form keeps the failure count, so a manual probe
neither arms termination nor clears a run already counting towards it:

```sh
docker exec rental-apartments-bot node src/health-check.js
docker inspect --format '{{json .State.Health}}' rental-apartments-bot
```

Inspect readiness without publishing its port. The `--ready` flag reports the
verdict as an exit status; the inline fetch also prints the `reasons` array that
explains a failure:

```sh
docker exec rental-apartments-bot node src/health-check.js --ready
docker exec rental-apartments-bot node -e \
  'fetch("http://127.0.0.1:8787/ready").then(async response => { console.log(await response.text()); process.exitCode = response.ok ? 0 : 1 })'
```

Scheduled monitoring uses the `--ready` form. Passing neither flag probes
`/live`, which answers whether the process is responsive rather than whether it
can crawl, so a running but unready application would report as ready and no
readiness alert would fire.

Monitoring should alert on HTTP 503 and route the returned reason/component
code to the matching runbook. It should never copy environment variables,
state files, or browser diagnostics into probe output.

## Deployment validation

Before rollout, verify the rendered Compose configuration contains no `ports`
or host-network mode and retains the loopback host:

```sh
docker compose --file compose.production.yaml config
docker inspect --format '{{json .NetworkSettings.Ports}}' \
  rental-apartments-bot
```

After startup, wait for the first required crawl, then run both probe commands
above. Integration tests exercise process termination, bounded restart, and
crawl-failure readiness transitions. Do not inject failures or deliberately
interfere with List.am, Telegram, or CBA in production.
