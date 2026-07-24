# Production observability

The application writes newline-delimited JSON to stdout/stderr. It does not
expose a metrics endpoint or accept monitoring traffic. Each record contains
`timestamp`, `severity`, `environment`, `applicationVersion`, `event`, and a
human-readable `message`. Production deployment uses Docker's Fluentd logging
driver; `LOG_COLLECTOR_ADDRESS` must identify an external Fluent Bit or Fluentd
endpoint before Compose will render the service.

## Collection and retention

The collector must forward `rental-apartments.production` records to storage
outside the application host. Configure that destination with a minimum
14-day searchable retention period, TLS and authenticated ingestion on any
non-private collector network, and collector-side disk buffering. Access to
logs is restricted because redaction is defense in depth rather than a reason
to treat logs as public.

Before launch, verify collection with an `application.started` record and
confirm all five required metadata fields are indexed. Then force a harmless
readiness request and confirm the corresponding record can be found by
`applicationVersion`. The deployment is not production-ready if the collector
is unavailable, records remain only in Docker's local storage, or retention is
less than 14 days.

Useful event-backed metrics stay in the private diagnostic stream:

- `crawl.succeeded` includes `crawlId`, `durationMs`, `duration`, `pages`,
  `discovered`, `updated`, `notified`, `filtered`, `channelSent`,
  `channelEdited`, and `total`.
- `crawl.failed` includes `crawlId`, `durationMs`, component, and error.
- `retry.scheduled` includes component, operation, attempt when available, and
  delay. Network and HTTP 5xx delays use bounded exponential backoff with
  jitter; `EXTERNAL_RETRY_MAX_MS` cannot exceed 300000 ms. A success resets the
  sequence. Telegram HTTP 429 uses Telegram's exact `retry_after` instead.
- Channel operation events contain their crawl ID and elapsed duration.
- Repeated identical warnings/errors are emitted once per five-minute window.
  The next emitted occurrence has `suppressedCount`.

## Alert routing

Route every `event=alert.firing` to the on-call notification policy and every
matching `event=alert.resolved` to incident recovery. The record's `alertName`
is the stable routing key. The application directly emits these alert names:

| Alert name                             | Trigger                                                                 | Route                          |
| -------------------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| `readiness_failure`                    | `/ready` is not ready after preflight                                   | on-call, 5-minute urgency      |
| `browser_challenge`                    | List.am verification challenge                                          | on-call, immediate             |
| `invalid_telegram_credentials`         | terminal Telegram authentication rejection                              | on-call, immediate             |
| `invalid_telegram_channel_permissions` | terminal channel access or permission rejection                         | on-call, immediate             |
| `five_consecutive_crawl_failures`      | fifth consecutive failed crawl                                          | on-call, immediate             |
| `stale_exchange_rates`                 | most recent CBA snapshot exceeds 48 hours                               | daytime warning                |
| `backup_failure`                       | `npm run backup` exits unsuccessfully                                   | on-call, immediate             |
| `restore_test_failure`                 | `npm run backup:validate -- <snapshot>` exits unsuccessfully            | on-call, immediate             |
| `low_disk`                             | `npm run storage:check` finds less than configured free-space threshold | on-call before free space <20% |

Configure one collector-side alert, `process_restart_loop`, because a process
cannot reliably observe its own restarts: fire when more than three
`application.started` records for the same deployment occur in ten minutes.
Docker's restart exhaustion and container-unavailable signals should join the
same incident. Route a failed external `/ready` probe after two consecutive
checks to `readiness_failure`; requesting `/ready` also causes the in-process
transition event. Keep `/ready` accessible only through the host's protected
monitoring path.

Run `npm run storage:check` at least hourly, `npm run backup` daily, and
`npm run backup:validate -- <latest-snapshot>` on an isolated restore-test host
weekly. The scheduler must alert on a missing run as well as a non-zero exit;
absence of an expected success record is not observable from inside this
process.

## Response checks

Exercise each alert in staging before production:

1. restart the container four times inside ten minutes;
2. request `/ready` with monitoring stale;
3. use a disposable challenged browser profile;
4. use a revoked test bot token and remove its test-channel permissions;
5. inject five crawl failures;
6. load a snapshot older than 48 hours;
7. run backup and validation against an inaccessible destination;
8. set a test disk threshold above current free space.

Confirm firing and resolved notifications arrive at the on-call route, contain
no token, Telegram API URL credential, owner identifier, apartment payload, or
full health error stack, and link back to the filtered log search.
