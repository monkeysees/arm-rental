//! Sanitized operational projection. No payloads, identifiers or upstream errors enter health state.
use super::{Result, config::Config, storage::iso_timestamp};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
const COMPONENTS: [&str; 5] = ["configuration", "storage", "telegram", "list_am", "cba"];
const INTEGRITY: &str = "ERR_LIST_AM_SOURCE_INTEGRITY";
fn iso(now: i64) -> String {
    iso_timestamp(now).expect("valid health clock")
}
fn time(v: &Value) -> Option<i64> {
    v.as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
}
fn component(status: &str, at: Value, code: Option<&str>) -> Value {
    let mut value = json!({"status":status,"updatedAt":at});
    if let Some(code) = code.filter(|s| !s.is_empty()) {
        value["code"] = json!(code);
    }
    value
}
fn safe_code<'a>(code: Option<&'a str>, fallback: &'a str) -> &'a str {
    code.filter(|s| {
        s.len() >= 2
            && s.len() <= 81
            && s.as_bytes()[0].is_ascii_uppercase()
            && s.bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
    })
    .unwrap_or(fallback)
}
fn preflight_component(name: &str) -> &str {
    match name {
        "source_transport" => "list_am",
        "exchange_rates" => "cba",
        "channel" => "telegram",
        "state" | "singleton" => "storage",
        n if COMPONENTS.contains(&n) => n,
        _ => "configuration",
    }
}
pub struct Health {
    version: String,
    started_at: String,
    preflight: Value,
    monitoring: Value,
    exchange_rates: Value,
    private_access: Value,
    components: Value,
    during_crawl: bool,
    challenge_crawls: u64,
    active_alerts: HashSet<String>,
    alerts: Vec<Value>,
    pub crawl_stale_ms: i64,
    pub exchange_rate_stale_ms: i64,
    pub source_challenge_alert_crawls: u64,
}
pub type SharedHealth = Arc<Mutex<Health>>;
impl Health {
    pub fn new(version: &str, started_ms: i64) -> Self {
        let mut components = json!({});
        for name in COMPONENTS {
            components[name] = component("unknown", Value::Null, None);
        }
        Self {
            version: version.into(),
            started_at: iso(started_ms),
            preflight: json!({"status":"pending","completedAt":null}),
            monitoring: json!({"active":false,"channelConfigured":false,"requiredSince":null,"lastSuccessAt":null,"lastFailureAt":null,"consecutiveFailures":0}),
            exchange_rates: json!({"required":false,"fetchedAt":null}),
            private_access: json!({"accessMode":"public","persistedUserCount":0,"authorizedUserCount":0,"suspendedUserCount":0,"activeUserCount":0}),
            components,
            during_crawl: false,
            challenge_crawls: 0,
            active_alerts: HashSet::new(),
            alerts: vec![],
            crawl_stale_ms: 600_000,
            exchange_rate_stale_ms: 172_800_000,
            source_challenge_alert_crawls: 5,
        }
    }
    fn required(&self) -> bool {
        self.monitoring["active"] == true || self.monitoring["channelConfigured"] == true
    }
    fn set_component(&mut self, name: &str, status: &str, code: Option<&str>, now: i64) {
        self.components[name] = component(status, json!(iso(now)), code);
    }
    fn alert(&mut self, name: &str, firing: bool, details: Value) {
        if self.active_alerts.contains(name) == firing {
            return;
        }
        if firing {
            self.active_alerts.insert(name.into());
        } else {
            self.active_alerts.remove(name);
        }
        let mut value = details.as_object().cloned().unwrap_or_default();
        value.insert("name".into(), json!(name));
        value.insert(
            "status".into(),
            json!(if firing { "firing" } else { "resolved" }),
        );
        self.alerts.push(Value::Object(value));
    }
    pub fn take_alerts(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.alerts)
    }
    fn source_success(&mut self, at: i64) {
        self.set_component("list_am", "ok", None, at);
        self.during_crawl = false;
        self.challenge_crawls = 0;
        self.alert(
            "list_am_challenge",
            false,
            json!({"reason":"LIST_AM_CHALLENGE"}),
        );
        self.alert(
            "list_am_source_integrity",
            false,
            json!({"reason":"LIST_AM_SOURCE_INTEGRITY"}),
        );
    }
    pub fn apply(&mut self, method: &str, args: &Value, now: i64) -> Result<()> {
        let value = &args[0];
        let name = value.as_str().unwrap_or("");
        match method {
            "setConfigurationValid" => self.set_component("configuration", "ok", None, now),
            "setConfigurationFailure" => {
                self.set_component(
                    "configuration",
                    "failed",
                    Some(safe_code(value.as_str(), "ERR_CONFIGURATION")),
                    now,
                );
                self.preflight = json!({"status":"failed","completedAt":iso(now)});
                self.alert(
                    "readiness_failure",
                    true,
                    json!({"reason":"PREFLIGHT_FAILED"}),
                );
            }
            "setPreflight" => {
                let status = if value["ready"] == true {
                    "ready"
                } else {
                    value["status"].as_str().unwrap_or("failed")
                };
                self.preflight = json!({"status":status,"completedAt":iso(now)});
                if let Some(checks) = value["checks"].as_object() {
                    for (name, status) in checks {
                        let s = status.as_str().unwrap_or("");
                        if s == "not_run" {
                            continue;
                        }
                        let target = preflight_component(name);
                        let mapped = match s {
                            "passed" => "ok",
                            "skipped" => "skipped",
                            "source_challenge" => "challenge",
                            _ => "failed",
                        };
                        if mapped == "skipped" && self.components[target]["status"] != "unknown" {
                            continue;
                        }
                        self.set_component(target, mapped, None, now);
                    }
                }
                if value["failure"].is_object() {
                    let failure = &value["failure"];
                    let target = preflight_component(failure["component"].as_str().unwrap_or(""));
                    let status = if value["status"] == "source_challenge" {
                        "challenge"
                    } else {
                        "failed"
                    };
                    self.set_component(
                        target,
                        status,
                        Some(safe_code(failure["code"].as_str(), "ERR_PREFLIGHT")),
                        now,
                    );
                    if failure["code"] == "ERR_TELEGRAM_CREDENTIALS" {
                        self.alert("invalid_telegram_credentials", true, json!({}));
                    }
                    if failure["code"] == "ERR_TELEGRAM_CHANNEL_PERMISSIONS" {
                        self.alert("invalid_telegram_channel_permissions", true, json!({}));
                    }
                    if value["status"] == "source_challenge" {
                        self.during_crawl = false;
                        self.challenge_crawls = self.source_challenge_alert_crawls;
                        self.alert(
                            "list_am_challenge",
                            true,
                            json!({"reason":"LIST_AM_CHALLENGE"}),
                        );
                    }
                    if failure["code"] == INTEGRITY {
                        self.alert(
                            "list_am_source_integrity",
                            true,
                            json!({"reason":"LIST_AM_SOURCE_INTEGRITY"}),
                        );
                    }
                } else if value["ready"] == true {
                    self.alert(
                        "list_am_source_integrity",
                        false,
                        json!({"reason":"LIST_AM_SOURCE_INTEGRITY"}),
                    );
                }
            }
            "setMonitoringState" => {
                let before = self.required();
                self.monitoring["active"] = json!(value["active"].as_bool().unwrap_or(false));
                self.monitoring["channelConfigured"] =
                    json!(value["channelConfigured"].as_bool().unwrap_or(false));
                let required = self.required();
                self.exchange_rates["required"] = json!(required);
                if !before && required {
                    self.monitoring["requiredSince"] = json!(iso(now));
                } else if !required {
                    for key in ["requiredSince", "lastSuccessAt", "lastFailureAt"] {
                        self.monitoring[key] = Value::Null;
                    }
                    self.monitoring["consecutiveFailures"] = json!(0);
                }
            }
            "setPrivateAccessState" => {
                self.private_access = json!({"accessMode":match value["accessMode"].as_str(){Some(s)if ["public","owner","allowlist"].contains(&s)=>s,_=>"public"}});
                for key in [
                    "persistedUserCount",
                    "authorizedUserCount",
                    "suspendedUserCount",
                    "activeUserCount",
                ] {
                    self.private_access[key] = json!(
                        value[key]
                            .as_u64()
                            .filter(|v| *v <= 9_007_199_254_740_991)
                            .unwrap_or(0)
                    );
                }
            }
            "recordCrawlSuccess" => {
                let at = value.as_i64().or_else(|| time(value)).unwrap_or(now);
                self.monitoring["lastSuccessAt"] = json!(iso(at));
                self.monitoring["consecutiveFailures"] = json!(0);
                self.set_component("list_am", "ok", None, at);
                self.during_crawl = false;
                self.challenge_crawls = 0;
                self.alert(
                    "list_am_challenge",
                    false,
                    json!({"reason":"LIST_AM_CHALLENGE"}),
                );
                self.alert("five_consecutive_crawl_failures", false, json!({}));
                self.alert(
                    "list_am_source_integrity",
                    false,
                    json!({"reason":"LIST_AM_SOURCE_INTEGRITY"}),
                );
            }
            "recordCrawlFailure" => {
                self.monitoring["lastFailureAt"] = json!(iso(now));
                let failures = self.monitoring["consecutiveFailures"].as_u64().unwrap_or(0) + 1;
                self.monitoring["consecutiveFailures"] = json!(failures);
                if failures >= 5 {
                    self.alert(
                        "five_consecutive_crawl_failures",
                        true,
                        json!({"consecutiveFailures":failures}),
                    );
                }
                let code = args[1].as_str().unwrap_or("ERR_CRAWL");
                if name == "list_am_challenge" {
                    self.set_component("list_am", "challenge", Some("ERR_LIST_AM_CHALLENGE"), now);
                    self.during_crawl = true;
                } else {
                    self.set_component(
                        if COMPONENTS.contains(&name) {
                            name
                        } else {
                            "list_am"
                        },
                        "failed",
                        Some(safe_code(Some(code), "ERR_CRAWL")),
                        now,
                    );
                    if code == INTEGRITY {
                        self.alert(
                            "list_am_source_integrity",
                            true,
                            json!({"reason":"LIST_AM_SOURCE_INTEGRITY"}),
                        );
                    }
                }
                if self.during_crawl {
                    self.during_crawl = false;
                    self.challenge_crawls += 1;
                    if self.challenge_crawls >= self.source_challenge_alert_crawls {
                        self.alert("list_am_challenge",true,json!({"reason":"LIST_AM_CHALLENGE","consecutiveCrawls":self.challenge_crawls}));
                    }
                }
            }
            "recordSourceIntegritySuccess" => {
                self.source_success(value.as_i64().or_else(|| time(value)).unwrap_or(now))
            }
            "recordSourceChallenge" => {
                self.set_component(
                    "list_am",
                    "challenge",
                    Some("ERR_LIST_AM_CHALLENGE"),
                    time(value).unwrap_or(now),
                );
                self.during_crawl = true;
            }
            "recordComponentSuccess" => {
                if COMPONENTS.contains(&name) {
                    self.set_component(name, "ok", None, now);
                }
                if name == "telegram" {
                    self.alert("invalid_telegram_credentials", false, json!({}));
                    self.alert("invalid_telegram_channel_permissions", false, json!({}));
                }
            }
            "recordComponentFailure" => {
                if !COMPONENTS.contains(&name) {
                    return Ok(());
                }
                let code = args[1].as_str();
                self.set_component(
                    name,
                    if args[2]["warning"] == true {
                        "warning"
                    } else {
                        "failed"
                    },
                    Some(safe_code(code, &format!("ERR_{}", name.to_uppercase()))),
                    now,
                );
                if code == Some("ERR_TELEGRAM_CREDENTIALS") {
                    self.alert("invalid_telegram_credentials", true, json!({}));
                }
                if matches!(
                    code,
                    Some("ERR_TELEGRAM_CHANNEL_PERMISSIONS" | "ERR_TELEGRAM_CHANNEL")
                ) {
                    self.alert("invalid_telegram_channel_permissions", true, json!({}));
                }
            }
            "recordExchangeRateSnapshot" => {
                let valid = time(&value["fetchedAt"]).is_some();
                self.exchange_rates["fetchedAt"] = if valid {
                    value["fetchedAt"].clone()
                } else {
                    Value::Null
                };
                self.set_component(
                    "cba",
                    if valid { "ok" } else { "failed" },
                    if valid {
                        None
                    } else {
                        Some("ERR_EXCHANGE_RATES_UNAVAILABLE")
                    },
                    now,
                );
            }
            "recordExchangeRateFailure" => {
                let valid = time(&value["fetchedAt"]).is_some();
                self.exchange_rates["fetchedAt"] = if valid {
                    value["fetchedAt"].clone()
                } else {
                    Value::Null
                };
                self.set_component(
                    "cba",
                    if valid { "warning" } else { "failed" },
                    Some(if valid {
                        "ERR_CBA_REFRESH"
                    } else {
                        "ERR_EXCHANGE_RATES_UNAVAILABLE"
                    }),
                    now,
                );
            }
            "readiness" | "liveness" => {}
            _ => return Err("Unknown health event".into()),
        }
        Ok(())
    }
    pub fn liveness(&self, now: i64) -> Value {
        json!({"status":"live","timestamp":iso(now),"startedAt":self.started_at,"version":self.version})
    }
    pub fn readiness(&mut self, now: i64) -> Value {
        let mut reasons = Vec::<&str>::new();
        let mut warnings = vec![];
        let mut components = self.components.clone();
        if self.preflight["status"] != "ready" {
            reasons.push(if self.preflight["status"] == "pending" {
                "PREFLIGHT_INCOMPLETE"
            } else {
                "PREFLIGHT_FAILED"
            });
        }
        if components["list_am"]["status"] == "challenge" {
            reasons.push("LIST_AM_CHALLENGE");
        }
        if components["list_am"]["code"] == INTEGRITY {
            reasons.push("LIST_AM_SOURCE_INTEGRITY");
        }
        if self.required() {
            if self.monitoring["lastSuccessAt"].is_null() {
                reasons.push("CRAWL_NEVER_SUCCEEDED");
            } else if time(&self.monitoring["lastSuccessAt"])
                .is_some_and(|at| now - at >= self.crawl_stale_ms)
            {
                reasons.push("CRAWL_STALE");
            }
            if self.monitoring["consecutiveFailures"].as_u64().unwrap_or(0) >= 5 {
                reasons.push("CRAWL_FAILURE_THRESHOLD");
            }
            if self.exchange_rates["fetchedAt"].is_null() {
                reasons.push("EXCHANGE_RATES_UNAVAILABLE");
                components["cba"] = component(
                    "failed",
                    components["cba"]["updatedAt"].clone(),
                    Some("ERR_EXCHANGE_RATES_UNAVAILABLE"),
                );
            }
        }
        if time(&self.exchange_rates["fetchedAt"])
            .is_some_and(|at| now - at > self.exchange_rate_stale_ms)
        {
            warnings.push("EXCHANGE_RATES_STALE");
            components["cba"] = component(
                "warning",
                components["cba"]["updatedAt"].clone(),
                Some("WARN_EXCHANGE_RATES_STALE"),
            );
        }
        let alerts: Vec<_> = reasons
            .iter()
            .copied()
            .filter(|reason| {
                *reason != "LIST_AM_CHALLENGE"
                    || self.preflight["status"] != "ready"
                    || self.challenge_crawls >= self.source_challenge_alert_crawls
            })
            .collect();
        if self.preflight["status"] != "pending" {
            self.alert(
                "readiness_failure",
                !alerts.is_empty(),
                json!({"reasons":alerts}),
            );
        }
        self.alert(
            "stale_exchange_rates",
            warnings.contains(&"EXCHANGE_RATES_STALE"),
            json!({"fetchedAt":self.exchange_rates["fetchedAt"]}),
        );
        let mut monitoring = self.monitoring.clone();
        monitoring["required"] = json!(self.required());
        json!({"status":if reasons.is_empty(){"ready"}else{"not_ready"},"ready":reasons.is_empty(),"timestamp":iso(now),"startedAt":self.started_at,"version":self.version,"preflight":self.preflight,"monitoring":monitoring,"exchangeRates":self.exchange_rates,"privateAccess":self.private_access,"components":components,"reasons":reasons,"alertReasons":alerts,"warnings":warnings})
    }
}
pub fn classify_failure(error: &Value, context: &Value) -> &'static str {
    let code = error["code"].as_str().unwrap_or("");
    let name = error["name"].as_str().unwrap_or("");
    if code == "ERR_LIST_AM_CHALLENGE" || name == "ListAmChallengeError" {
        return "list_am_challenge";
    }
    if code == "ERR_TELEGRAM_API" || name == "TelegramApiError" {
        return "telegram";
    }
    if code == "ERR_PREFLIGHT_EXCHANGE_RATES" {
        return "cba";
    }
    if [
        "EACCES",
        "EDQUOT",
        "EIO",
        "ENOSPC",
        "EROFS",
        "ERR_STATE_INVALID_JSON",
    ]
    .contains(&code)
    {
        return "storage";
    }
    match context["component"].as_str() {
        Some("telegram" | "telegram-channel") => "telegram",
        Some("cba") => "cba",
        Some("storage") => "storage",
        Some("configuration") => "configuration",
        _ => "list_am",
    }
}
pub fn contract(v: &Value) -> Result<Value> {
    if v["action"] == "classify" {
        return Ok(json!(classify_failure(&v["error"], &v["context"])));
    }
    let mut now = v["startedMs"].as_i64().ok_or("Missing health clock")?;
    let mut monitor = Health::new(v["version"].as_str().unwrap_or("1.0.0"), now);
    if let Some(value) = v["crawlStaleMs"].as_i64() {
        monitor.crawl_stale_ms = value;
    }
    if let Some(value) = v["exchangeRateStaleMs"].as_i64() {
        monitor.exchange_rate_stale_ms = value;
    }
    if let Some(value) = v["sourceChallengeAlertCrawls"].as_u64() {
        monitor.source_challenge_alert_crawls = value;
    }
    let mut observations = vec![];
    for event in v["events"].as_array().ok_or("Missing health events")? {
        now = event["at"].as_i64().unwrap_or(now);
        monitor.apply(
            event["method"].as_str().ok_or("Missing health method")?,
            event.get("args").unwrap_or(&json!([])),
            now,
        )?;
        observations.push(monitor.readiness(now));
    }
    Ok(
        json!({"observations":observations,"alerts":monitor.take_alerts(),"liveness":monitor.liveness(now)}),
    )
}
pub fn start_server(
    config: &Config,
    monitor: SharedHealth,
    stop: Arc<AtomicBool>,
) -> Result<thread::JoinHandle<()>> {
    let listener = TcpListener::bind((
        config.text("healthHost"),
        config.number("healthPort") as u16,
    ))?;
    listener.set_nonblocking(true)?;
    Ok(thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
                    let _ = stream.set_write_timeout(Some(Duration::from_millis(100)));
                    let mut request = [0; 4096];
                    let count = stream.read(&mut request).unwrap_or(0);
                    let text = String::from_utf8_lossy(&request[..count]);
                    let mut parts = text.split_whitespace();
                    let method = parts.next().unwrap_or("");
                    let path = parts.next().unwrap_or("");
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as i64;
                    let (status, body) = if method != "GET" {
                        (405, json!({"status":"method_not_allowed"}))
                    } else {
                        match path {
                            "/live" => (200, monitor.lock().unwrap().liveness(now)),
                            "/ready" | "/health" => {
                                let body = monitor.lock().unwrap().readiness(now);
                                (if body["ready"] == true { 200 } else { 503 }, body)
                            }
                            _ => (404, json!({"status":"not_found"})),
                        }
                    };
                    let body = format!("{body}\n");
                    let response = format!(
                        "HTTP/1.1 {status} {}\r\nCache-Control: no-store\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        match status {
                            200 => "OK",
                            404 => "Not Found",
                            405 => "Method Not Allowed",
                            _ => "Service Unavailable",
                        },
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(_) => break,
            }
        }
    }))
}
