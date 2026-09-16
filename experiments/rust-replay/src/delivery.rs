use crate::{
    Result,
    model::{Listing, Manifest},
    store::Store,
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseResult {
    pub name: String,
    pub sent: usize,
    pub announcements: usize,
    pub retries: usize,
    pub attempts: usize,
    pub recipients_asserted: usize,
    pub classified_recipients: usize,
    pub deliveries_by_profile: Vec<Vec<String>>,
    pub payloads_by_profile: Vec<Vec<Listing>>,
    pub classifications_by_profile: Vec<BTreeMap<String, String>>,
    pub classification_wall_ms: f64,
    pub wall_ms: f64,
    pub drain_ms: f64,
    pub first_progress_max_ms: f64,
    pub max_in_flight: usize,
    pub rate_limits_verified: bool,
    pub failures: usize,
    pub queue_age_p50_ms: f64,
    pub queue_age_p95_ms: f64,
    pub queue_age_max_ms: f64,
    pub throughput_per_second: Option<f64>,
    pub queue_age_offset_ms: f64,
    pub queue_age_ms: serde_json::Value,
    pub first_recipient_progress_ms: serde_json::Value,
    pub wall_messages_per_second: Option<f64>,
    pub cpu_ms: f64,
    pub memory_before: serde_json::Value,
    pub memory_after: serde_json::Value,
    pub sampled_peak_rss_bytes: u64,
}
struct Recipient {
    tokens: f64,
    refilled: f64,
    ready: f64,
    announcement: bool,
    retried: bool,
    done: bool,
    attempts: usize,
    sent: Vec<Listing>,
    history: Vec<(f64, bool)>,
}
struct Flight {
    user: usize,
    listing: Option<Listing>,
    end: f64,
    retry: bool,
    failed: bool,
}
pub fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

// Only simulated transport occupies slots; rate and retry waits retain deadlines.
pub fn deliver(
    store: &Store,
    m: &Manifest,
    users: usize,
    catchup: bool,
    wall: bool,
    now: i64,
    out: &mut PhaseResult,
) -> Result<()> {
    let t = &m.transport;
    let interrupt = out.name == "interrupted";
    let mut ages = Vec::new();
    let mut first = Vec::new();
    let mut states: Vec<_> = (0..users)
        .map(|_| Recipient {
            tokens: t.recipient_burst,
            refilled: 0.0,
            ready: 0.0,
            announcement: catchup,
            retried: false,
            done: false,
            attempts: 0,
            sent: Vec::new(),
            history: Vec::new(),
        })
        .collect();
    let start = Instant::now();
    let (mut clock, mut global, mut last_attempt) = (0.0, 0.0, f64::NEG_INFINITY);
    let (mut cursor, mut finished) = (0, 0);
    let mut flights: Vec<Flight> = Vec::new();
    while finished < users || !flights.is_empty() {
        if wall {
            clock = elapsed(start);
        }
        let mut pending = Vec::new();
        for f in flights.drain(..) {
            if f.end > clock {
                pending.push(f);
                continue;
            }
            let r = &mut states[f.user];
            if f.failed {
                r.done = true;
                finished += 1;
                out.failures += 1;
                continue;
            }
            if f.retry {
                r.retried = true;
                r.ready = clock + t.retry_after_ms;
                out.retries += 1;
                continue;
            }
            r.ready = clock;
            r.attempts = 0;
            if let Some(l) = f.listing {
                store.acknowledge(f.user, &l.id, now)?;
                if r.sent.is_empty() {
                    out.first_progress_max_ms = out.first_progress_max_ms.max(clock);
                    first.push(
                        clock
                            + if wall {
                                out.classification_wall_ms
                            } else {
                                0.0
                            },
                    );
                }
                ages.push(
                    out.queue_age_offset_ms
                        + clock
                        + if wall {
                            out.classification_wall_ms
                        } else {
                            0.0
                        },
                );
                r.sent.push(l);
                out.sent += 1;
            } else {
                r.announcement = false;
                out.announcements += 1;
            }
        }
        flights = pending;
        let mut next = flights.iter().map(|f| f.end).fold(f64::INFINITY, f64::min);
        let mut launched = false;
        // Ready retries with no progress must not wait another full recipient sweep.
        if let Some(user) = states
            .iter()
            .position(|r| !r.done && r.retried && r.sent.is_empty() && r.ready <= clock)
        {
            cursor = user;
        }
        for _ in 0..users {
            if flights.len() >= 8 {
                break;
            }
            if clock < global {
                next = next.min(global);
                break;
            }
            let user = cursor;
            cursor = (cursor + 1) % users;
            let r = &mut states[user];
            if r.done {
                continue;
            }
            if r.ready > clock {
                next = next.min(r.ready);
                continue;
            }
            let mut listing = store.next(user)?;
            if listing.is_none() && !r.announcement {
                r.done = true;
                finished += 1;
                continue;
            }
            r.tokens = (r.tokens
                + (clock - r.refilled) * t.recipient_messages_per_minute / 60000.0)
                .min(t.recipient_burst);
            r.refilled = clock;
            // Floating-point refill can land a few ulps below one at a deadline.
            if r.attempts == 0 && r.tokens + 1e-9 < 1.0 {
                r.ready = clock + (1.0 - r.tokens) * 60000.0 / t.recipient_messages_per_minute;
                next = next.min(r.ready);
                continue;
            }
            if clock - last_attempt + 1e-6 < 1000.0 / t.global_attempts_per_second {
                return Err("global rate exceeded".into());
            }
            last_attempt = clock;
            r.history.push((clock, r.attempts > 0));
            if r.attempts == 0 {
                r.tokens = (r.tokens - 1.0).max(0.0);
            }
            r.attempts += 1;
            if r.attempts > t.max_attempts {
                return Err("retry budget exceeded".into());
            }
            if r.announcement {
                listing = None;
            }
            let retry = catchup
                && listing.is_some()
                && r.sent.is_empty()
                && user % t.retry_recipients_modulo == 0
                && !r.retried;
            flights.push(Flight {
                user,
                listing,
                end: clock + t.latency_ms,
                retry,
                failed: interrupt && r.sent.len() == 2,
            });
            r.ready = f64::INFINITY;
            global = clock + 1000.0 / t.global_attempts_per_second;
            out.attempts += 1;
            out.max_in_flight = out.max_in_flight.max(flights.len());
            launched = true;
            break;
        }
        if finished == users && flights.is_empty() {
            break;
        }
        if launched {
            continue;
        }
        if !next.is_finite() {
            return Err("scheduler deadlock".into());
        }
        if wall {
            let delay = next - elapsed(start);
            if delay > 0.0 {
                std::thread::sleep(Duration::from_secs_f64(delay / 1000.0));
            }
        } else {
            clock = next;
        }
    }
    out.drain_ms = clock;
    out.queue_age_ms = distribution(ages);
    out.queue_age_p50_ms = out.queue_age_ms["p50"].as_f64().unwrap();
    out.queue_age_p95_ms = out.queue_age_ms["p95"].as_f64().unwrap();
    out.queue_age_max_ms = out.queue_age_ms["max"].as_f64().unwrap();
    out.first_recipient_progress_ms = distribution(first);
    out.wall_messages_per_second = wall.then(|| out.sent as f64 / (elapsed(start) / 1000.0));
    for (user, r) in states.into_iter().enumerate() {
        let mut logical = Vec::new();
        for (i, &(at, retry)) in r.history.iter().enumerate() {
            if retry {
                if i == 0 || at - r.history[i - 1].0 + 1e-6 < t.latency_ms + t.retry_after_ms {
                    return Err("retry deadline violated".into());
                }
            } else {
                logical.push(at);
            }
        }
        for (i, first) in logical.iter().enumerate() {
            for (j, last) in logical.iter().enumerate().skip(i) {
                if (j - i + 1) as f64
                    > t.recipient_burst
                        + (last - first) * t.recipient_messages_per_minute / 60000.0
                        + 1e-6
                {
                    return Err("recipient rate exceeded".into());
                }
            }
        }
        if user < 4 {
            out.deliveries_by_profile
                .push(r.sent.iter().map(|l| l.id.clone()).collect());
            out.payloads_by_profile.push(r.sent);
        } else if r.sent != out.payloads_by_profile[user % 4] {
            return Err(format!("recipient {user} payload/order differs").into());
        }
        out.recipients_asserted += 1;
    }
    out.rate_limits_verified = true;
    Ok(())
}
pub fn observe(store: &Store, users: usize, ids: &[String], out: &mut PhaseResult) -> Result<()> {
    out.classifications_by_profile.clear();
    out.classified_recipients = 0;
    for user in 0..users {
        let decisions = store.classifications(user, ids)?;
        if user < 4 {
            out.classifications_by_profile.push(decisions);
        } else if decisions != out.classifications_by_profile[user % 4] {
            return Err(format!("recipient {user} classifications differ").into());
        }
        out.classified_recipients += 1;
    }
    Ok(())
}

fn distribution(mut values: Vec<f64>) -> serde_json::Value {
    values.sort_by(f64::total_cmp);
    let at = |p: f64| {
        values
            .get(((values.len() as f64 * p).ceil() as usize).saturating_sub(1))
            .copied()
            .unwrap_or(0.0)
    };
    serde_json::json!({"p50":at(0.5),"p95":at(0.95),"p99":at(0.99),"max":at(1.0)})
}
