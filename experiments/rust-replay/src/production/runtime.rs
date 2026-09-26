use super::{
    Result,
    bot::{self, Bot},
    channel,
    config::Config,
    filters,
    health::{self, Health, SharedHealth},
    lease::{self, Lease},
    private, source,
    storage::{Database, iso_timestamp},
    transport::{self, Http, Source, Telegram},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, OpenOptions},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn event(name: &str, fields: Value) {
    let mut value = fields.as_object().cloned().unwrap_or_default();
    value.insert(
        "timestamp".into(),
        json!(iso_timestamp(now_ms()).unwrap_or_default()),
    );
    value.insert(
        "severity".into(),
        json!(if name.ends_with("failed") || name == "alert.firing" {
            "warn"
        } else {
            "info"
        }),
    );
    value.insert("applicationVersion".into(), json!("1.0.0"));
    value.insert(
        "environment".into(),
        json!(std::env::var("NODE_ENV").unwrap_or_else(|_| "development".into())),
    );
    value.insert("message".into(), json!(name));
    value.insert("event".into(), json!(name));
    println!("{}", Value::Object(value));
}
fn observe(health: &SharedHealth, method: &str, args: Value) {
    let mut health = health.lock().unwrap();
    if health.apply(method, &args, now_ms()).is_err() {
        event("health.observation.failed", json!({"method":method}));
    }
    for alert in health.take_alerts() {
        let mut fields = alert.clone();
        fields["alertName"] = alert["name"].clone();
        event(
            if alert["status"] == "resolved" {
                "alert.resolved"
            } else {
                "alert.firing"
            },
            fields,
        );
    }
}
type SharedDatabase = Arc<Mutex<Database>>;
type Gates = Arc<Mutex<HashMap<i64, Arc<Mutex<()>>>>>;
type Cancellations = Arc<Mutex<HashMap<i64, Arc<AtomicBool>>>>;
fn gate(gates: &Gates, id: i64) -> Arc<Mutex<()>> {
    let mut gates = gates.lock().unwrap();
    gates.retain(|_, gate| Arc::strong_count(gate) > 1);
    gates.entry(id).or_default().clone()
}
fn terminal(error: &(dyn std::error::Error + Send + Sync + 'static)) -> bool {
    error.downcast_ref::<transport::Failure>().is_some_and(|f| {
        [400, 401, 403].contains(&f.status)
            && [
                "unauthorized",
                "forbidden",
                "chat not found",
                "not enough rights",
                "bot was blocked",
                "need administrator rights",
            ]
            .iter()
            .any(|s| f.description.to_lowercase().contains(s))
    })
}
fn fail_runtime(fatal: &AtomicBool, stop: &AtomicBool) {
    fatal.store(true, Ordering::Relaxed);
    stop.store(true, Ordering::Relaxed);
}
fn deactivate(db: &Database, id: i64) -> Result<()> {
    if let Some(mut user) = db.load_user(id)? {
        user["active"] = json!(false);
        db.save_user(&user)?;
    }
    Ok(())
}
fn send_operations(
    telegram: &Telegram,
    db: &SharedDatabase,
    operations: Vec<Value>,
    unavailable: &mut HashSet<i64>,
) -> Result<()> {
    for op in operations {
        let method = op["method"].as_str().ok_or("missing Telegram method")?;
        if let Err(error) = telegram.call(method, &op["payload"], 4) {
            if op["ignoreError"] == true {
                continue;
            }
            if ["sendMessage", "editMessageText"].contains(&method)
                && terminal(error.as_ref())
                && op["payload"]["chat_id"].as_i64().is_some_and(|id| id > 0)
            {
                unavailable.insert(op["payload"]["chat_id"].as_i64().unwrap());
            } else {
                return Err(error);
            }
        }
        if let Some(offset) = op["ackOffset"].as_i64() {
            db.lock().unwrap().update_offset(offset)?;
        }
    }
    Ok(())
}
fn recover_deletions(
    bot: &mut Bot,
    db: &SharedDatabase,
    gates: &Gates,
    telegram: &Telegram,
) -> Result<()> {
    let ids = db.lock().unwrap().pending_deletions()?;
    for id in ids {
        let guard = gate(gates, id);
        let _guard = guard.lock().unwrap();
        let operation = bot.complete_deletion(&db.lock().unwrap(), id)?;
        // Removing data does not depend on delivery of the completion receipt.
        if telegram
            .call("sendMessage", &operation["payload"], 4)
            .is_err()
        {
            event("telegram.deletion.receipt_failed", json!({}));
        }
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
fn poll_thread(
    config: Config,
    db: SharedDatabase,
    gates: Gates,
    telegram: Telegram,
    stop: Arc<AtomicBool>,
    fatal: Arc<AtomicBool>,
    health: SharedHealth,
    cancellations: Cancellations,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut bot = Bot::new();
        while !stop.load(Ordering::Relaxed) {
            if recover_deletions(&mut bot, &db, &gates, &telegram).is_err() {
                fail_runtime(&fatal, &stop);
                break;
            }
            let offset = match db.lock().unwrap().update_offset_value() {
                Ok(offset) => offset,
                Err(_) => {
                    fail_runtime(&fatal, &stop);
                    break;
                }
            };
            let mut poll = telegram.clone();
            poll.http.timeout_ms =
                (config.number("telegramPollTimeoutSeconds") + 10).saturating_mul(1000);
            let updates=match poll.call("getUpdates",&json!({"offset":offset,"timeout":config.number("telegramPollTimeoutSeconds"),"allowed_updates":["message","callback_query"]}),4){
                Ok(v)=>v,
                Err(error)=>{
                    if terminal(error.as_ref()){event("telegram.poll.failed",json!({"code":"ERR_TELEGRAM_CREDENTIALS","terminal":true}));fail_runtime(&fatal,&stop);break;}
                    if !stop.load(Ordering::Relaxed){observe(&health,"recordComponentFailure",json!(["telegram","ERR_TELEGRAM_API"]));let _=transport::wait(&stop,Duration::from_millis(config.number("externalRetryBaseMs")));}
                    continue;
                }
            };
            let mut unavailable = HashSet::new();
            let result = (|| -> Result<()> {
                for update in updates.as_array().ok_or("invalid Telegram updates")? {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let id = update["message"]["chat"]["id"]
                        .as_i64()
                        .or_else(|| update["callback_query"]["message"]["chat"]["id"].as_i64())
                        .unwrap_or(0);
                    let operations =
                        match bot.handle_update(&mut db.lock().unwrap(), &config, update, now_ms())
                        {
                            Ok(v) => v,
                            Err(error) => {
                                fail_runtime(&fatal, &stop);
                                return Err(error);
                            }
                        };
                    let mut outgoing = Vec::new();
                    for op in operations {
                        if op["method"] == "deleteUserData" {
                            if let Some(cancel) = cancellations.lock().unwrap().get(&id) {
                                cancel.store(true, Ordering::Relaxed);
                            }
                        } else {
                            outgoing.push(op);
                        }
                    }
                    send_operations(&telegram, &db, outgoing, &mut unavailable)?;
                }
                Ok(())
            })();
            // Also recover markers when a later update in this batch failed.
            if !stop.load(Ordering::Relaxed)
                && recover_deletions(&mut bot, &db, &gates, &telegram).is_err()
            {
                fail_runtime(&fatal, &stop);
            }
            for id in unavailable {
                let guard = gate(&gates, id);
                let _guard = guard.lock().unwrap();
                if deactivate(&db.lock().unwrap(), id).is_err() {
                    fail_runtime(&fatal, &stop);
                }
            }
            match result {
                Ok(()) => observe(&health, "recordComponentSuccess", json!(["telegram"])),
                Err(error) => {
                    if error.downcast_ref::<rusqlite::Error>().is_some() || terminal(error.as_ref())
                    {
                        fail_runtime(&fatal, &stop);
                    }
                    if !stop.load(Ordering::Relaxed) {
                        observe(
                            &health,
                            "recordComponentFailure",
                            json!(["telegram", "ERR_TELEGRAM_API"]),
                        );
                        let _ = transport::wait(
                            &stop,
                            Duration::from_millis(config.number("externalRetryBaseMs")),
                        );
                    }
                }
            }
        }
    })
}

struct Job {
    id: i64,
    phase: u8,
    due: Instant,
    attempts: u32,
    consumed: bool,
    cancelled: bool,
    count: usize,
}
struct Bucket {
    tokens: f64,
    at: Instant,
}
#[derive(Default)]
struct Scheduler {
    buckets: HashMap<i64, Bucket>,
}
impl Scheduler {
    #[allow(clippy::too_many_arguments)]
    fn deliver(
        &mut self,
        db: &SharedDatabase,
        config: &Config,
        telegram: &Telegram,
        gates: &Gates,
        fresh: &HashSet<String>,
        stop: &Arc<AtomicBool>,
        fatal: &Arc<AtomicBool>,
        cancellations: &Cancellations,
    ) -> Result<Value> {
        let users = db.lock().unwrap().load_telegram()?["users"]
            .as_object()
            .ok_or("missing users")?
            .values()
            .filter(|u| {
                u["active"] == true
                    && u.get("deletionPendingAt").is_none()
                    && u["chatId"].as_i64().is_some_and(|id| config.authorized(id))
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut jobs = VecDeque::new();
        for user in users {
            jobs.push_back(Job {
                id: user["chatId"].as_i64().unwrap(),
                phase: 0,
                due: Instant::now(),
                attempts: 0,
                consumed: false,
                cancelled: false,
                count: 0,
            });
        }
        let (sender, receiver) = mpsc::channel::<(Job, Result<bool>)>();
        let mut running = 0;
        let notified = Arc::new(AtomicUsize::new(0));
        let (mut filtered, mut skipped, mut readmitted) = (0, 0, 0);
        let mut failure: Option<Box<dyn std::error::Error + Send + Sync>> = None;
        while !jobs.is_empty() || running > 0 {
            while let Ok((mut job, result)) = receiver.try_recv() {
                running -= 1;
                match result {
                    Ok(false) => {
                        if job.cancelled {
                            self.buckets.remove(&job.id);
                        }
                    }
                    Ok(true) => {
                        let announced = job.phase == 1;
                        if announced {
                            job.phase = 2;
                        }
                        job.attempts = 0;
                        job.consumed = false;
                        job.due = Instant::now();
                        if announced {
                            // Complete first listing progress before classifying another recipient.
                            jobs.push_front(job);
                        } else {
                            jobs.push_back(job);
                        }
                    }
                    Err(error) => {
                        job.attempts += 1;
                        let retry = error
                            .downcast_ref::<transport::Failure>()
                            .filter(|f| f.status == 0 || f.status == 429 || f.status >= 500);
                        if job.attempts < 4 && retry.is_some() && !stop.load(Ordering::Relaxed) {
                            let delay = retry.and_then(|f| f.retry_after_ms).unwrap_or_else(|| {
                                config
                                    .number("externalRetryBaseMs")
                                    .saturating_mul(1 << job.attempts.saturating_sub(1))
                                    .min(config.number("externalRetryMaxMs"))
                            });
                            job.due = Instant::now() + Duration::from_millis(delay);
                            jobs.push_back(job);
                        } else {
                            failure.get_or_insert(error);
                            event(
                                "telegram.private.failed",
                                json!({"reason":"external_failure"}),
                            );
                        }
                    }
                }
            }
            if stop.load(Ordering::Relaxed) {
                for cancel in cancellations.lock().unwrap().values() {
                    cancel.store(true, Ordering::Relaxed);
                }
                jobs.clear();
                if running == 0 {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
                continue;
            }
            let count = jobs.len();
            let mut progressed = false;
            for _ in 0..count {
                if running >= 8 {
                    break;
                }
                let mut job = jobs.pop_front().unwrap();
                if job.due > Instant::now() {
                    jobs.push_back(job);
                    continue;
                }
                if job.phase == 0 {
                    let classification_started = Instant::now();
                    let classified = (|| -> Result<Option<private::Batch>> {
                        let guard = gate(gates, job.id);
                        let _guard = guard.lock().unwrap();
                        let database = db.lock().unwrap();
                        let Some(user) = database.load_user(job.id)? else {
                            return Ok(None);
                        };
                        if user["active"] != true
                            || !config.authorized(job.id)
                            || user.get("deletionPendingAt").is_some()
                        {
                            return Ok(None);
                        }
                        Ok(Some(private::classify(
                            &database,
                            config,
                            &user,
                            fresh,
                            now_ms(),
                        )?))
                    })();
                    match classified {
                        Ok(Some(batch)) => {
                            event(
                                "private.classification.completed",
                                json!({"count":batch.count,"announce":batch.announce,"durationMs":classification_started.elapsed().as_millis()}),
                            );
                            filtered += batch.filtered;
                            skipped += batch.skipped;
                            readmitted += batch.readmitted;
                            if batch.count > 0 {
                                job.count = batch.count;
                                job.phase = if batch.announce { 1 } else { 2 };
                                // Start one send while subsequent recipients classify.
                                jobs.push_front(job);
                            }
                        }
                        Ok(_) => (),
                        Err(error) => {
                            failure.get_or_insert(error);
                            fail_runtime(fatal, stop);
                            break;
                        }
                    }
                    progressed = true;
                    continue;
                }
                // Announcements and listings spend the same product-rate bucket.
                if !job.consumed {
                    let now = Instant::now();
                    let bucket = self.buckets.entry(job.id).or_insert(Bucket {
                        tokens: 5.0,
                        at: now,
                    });
                    let elapsed = now.duration_since(bucket.at).as_secs_f64();
                    bucket.tokens = (bucket.tokens
                        + elapsed * config.number("telegramPrivateDeliveriesPerMinute") as f64
                            / 60.0)
                        .min(5.0);
                    bucket.at = now;
                    if bucket.tokens < 1.0 {
                        job.due = now
                            + Duration::from_secs_f64(
                                (1.0 - bucket.tokens) * 60.0
                                    / config.number("telegramPrivateDeliveriesPerMinute") as f64,
                            );
                        jobs.push_back(job);
                        continue;
                    }
                    bucket.tokens -= 1.0;
                    job.consumed = true;
                }
                let tx = sender.clone();
                let database = db.clone();
                let mut tg = telegram.clone();
                let recipient_gate = gate(gates, job.id);
                let cfg = config.clone();
                let fatal = fatal.clone();
                let stop = stop.clone();
                let notified = notified.clone();
                let cancel = Arc::new(AtomicBool::new(false));
                cancellations.lock().unwrap().insert(job.id, cancel.clone());
                let cancellations = cancellations.clone();
                tg.http.stop = cancel.clone();
                running += 1;
                progressed = true;
                thread::spawn(move || {
                    let result = (|| -> Result<bool> {
                        let _guard = recipient_gate.lock().unwrap();
                        let (payload, item) = {
                            let db = database.lock().unwrap();
                            let Some(user) = db.load_user(job.id)? else {
                                return Ok(false);
                            };
                            if user["active"] != true
                                || !cfg.authorized(job.id)
                                || user.get("deletionPendingAt").is_some()
                            {
                                return Ok(false);
                            }
                            if job.phase == 1 {
                                (
                                    json!({"chat_id":job.id,"text":bot::announcement(job.count),"disable_web_page_preview":true}),
                                    None,
                                )
                            } else {
                                let Some(item) = db.next_batch_item(&job.id.to_string())? else {
                                    return Ok(false);
                                };
                                (
                                    json!({"chat_id":job.id,"text":filters::format_message(&item["apartment"],false),"disable_web_page_preview":true}),
                                    Some(item),
                                )
                            }
                        };
                        if let Err(error) = tg.call("sendMessage", &payload, 1) {
                            if cancel.load(Ordering::Relaxed) {
                                return Ok(false);
                            }
                            if terminal(error.as_ref()) {
                                deactivate(&database.lock().unwrap(), job.id)?;
                                event(
                                    "telegram.private.deactivated",
                                    json!({"reason":"private_unavailable"}),
                                );
                                return Ok(false);
                            }
                            return Err(error);
                        }
                        if fatal.load(Ordering::Relaxed) {
                            return Err("storage failure stopped acknowledgements".into());
                        }
                        if let Some(item) = item {
                            let db = database.lock().unwrap();
                            if db
                                .load_user(job.id)?
                                .is_none_or(|user| user.get("deletionPendingAt").is_some())
                            {
                                return Ok(false);
                            }
                            if fatal.load(Ordering::Relaxed) {
                                return Err("storage failure stopped acknowledgements".into());
                            }
                            if let Err(error) = db.acknowledge_batch_item(
                                &job.id.to_string(),
                                &item,
                                &iso_timestamp(now_ms())?,
                            ) {
                                fail_runtime(&fatal, &stop);
                                return Err(error);
                            }
                            notified.fetch_add(1, Ordering::Relaxed);
                            // Retiring here avoids spending a token on an empty follow-up job.
                            return Ok(db.next_batch_item(&job.id.to_string())?.is_some());
                        }
                        Ok(true)
                    })();
                    if result
                        .as_ref()
                        .err()
                        .is_some_and(|error| error.downcast_ref::<transport::Failure>().is_none())
                        && !stop.load(Ordering::Relaxed)
                    {
                        fail_runtime(&fatal, &stop);
                    }
                    job.cancelled = cancel.load(Ordering::Relaxed);
                    cancellations.lock().unwrap().remove(&job.id);
                    let _ = tx.send((job, result));
                });
            }
            if !progressed {
                thread::sleep(Duration::from_millis(5));
            }
        }
        if !fatal.load(Ordering::Relaxed) {
            db.lock().unwrap().clear_batches()?;
        }
        self.buckets
            .retain(|_, bucket| bucket.at.elapsed() < Duration::from_secs(900));
        if let Some(error) = failure {
            Err(error)
        } else {
            Ok(
                json!({"notified":notified.load(Ordering::Relaxed),"filtered":filtered,"skipped":skipped,"readmitted":readmitted}),
            )
        }
    }
}
fn channel_delivery(
    db: &Database,
    config: &Config,
    telegram: &Telegram,
    stop: &AtomicBool,
    crawl_id: &str,
    started: Instant,
) -> Result<Value> {
    if config.get("telegramChannelId").is_null() {
        return Ok(json!({"sentCount":0,"editedCount":0}));
    }
    channel::prepare(db, config, now_ms())?;
    let mut after = 0;
    let mut failure = None;
    let (mut sent, mut edited) = (0, 0);
    while let Some(next) = channel::next_cursor(db, after, 100)? {
        for mut operation in channel::operations(db, config, after, 100, now_ms())? {
            if stop.load(Ordering::Relaxed) {
                return Err("channel delivery cancelled".into());
            }
            let mut result = telegram.call(
                operation["method"]
                    .as_str()
                    .ok_or("invalid channel operation")?,
                &operation["payload"],
                4,
            );
            let missing = result
                .as_ref()
                .err()
                .and_then(|e| e.downcast_ref::<transport::Failure>())
                .is_some_and(|e| {
                    [
                        "message to edit not found",
                        "message not found",
                        "message_id_invalid",
                    ]
                    .iter()
                    .any(|v| e.description.to_lowercase().contains(v))
                });
            if operation["method"] == "editMessageText" && missing {
                operation["payload"]
                    .as_object_mut()
                    .unwrap()
                    .remove("message_id");
                operation["method"] = json!("sendMessage");
                // Replacing a missing edit preserves the original publication age.
                result = telegram.call("sendMessage", &operation["payload"], 4);
            }
            match result {
                Ok(result) => {
                    if stop.load(Ordering::Relaxed) {
                        return Err("channel acknowledgement cancelled".into());
                    }
                    channel::acknowledge(db, &operation, &result)?;
                    event(
                        "channel.operation.completed",
                        json!({"operation":if missing{"replace"}else{operation["operation"].as_str().unwrap_or("send")},"outcome":"success","crawlId":crawl_id,"durationMs":started.elapsed().as_millis()}),
                    );
                    if operation["operation"] == "edit" {
                        edited += 1
                    } else {
                        sent += 1
                    }
                }
                Err(error) => {
                    event(
                        "channel.operation.failed",
                        json!({"operation":operation["operation"],"outcome":"failed","crawlId":crawl_id,"durationMs":started.elapsed().as_millis(),"error":{"code":"ERR_TELEGRAM_API","status":error.downcast_ref::<transport::Failure>().map(|failure|failure.status)}}),
                    );
                    if terminal(error.as_ref()) {
                        return Err(error);
                    }
                    failure.get_or_insert(error);
                }
            }
        }
        after = next;
    }
    if let Some(error) = failure {
        Err(error)
    } else {
        Ok(json!({"sentCount":sent,"editedCount":edited}))
    }
}
const SOAP: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><soap:Body><ExchangeRatesLatest xmlns=\"http://www.cba.am/\" /></soap:Body></soap:Envelope>";
fn rates(
    db: &Database,
    http: &Http,
    url: &str,
    next: &mut i64,
    health: &SharedHealth,
    config: &Config,
) -> Result<Value> {
    let current = db.exchange_rates()?;
    let now = now_ms();
    if current.is_none() && now < *next {
        return Err("CBA snapshot unavailable during refresh cooldown".into());
    }
    if let Some(value) = &current {
        let fetched = value["fetchedAt"]
            .as_str()
            .and_then(|s| super::storage::iso_milliseconds(s).ok())
            .unwrap_or(0);
        if *next == 0 {
            observe(health, "recordExchangeRateSnapshot", json!([value]));
            *next = fetched + 86_400_000;
        }
        if now < fetched + 86_400_000 || now < *next {
            return Ok(value.clone());
        }
    }
    let mut result: Result<Value> = Err("CBA request not attempted".into());
    for attempt in 0..4 {
        result = (|| -> Result<Value> {
            let response = http.request(
                url,
                Some(SOAP),
                &[
                    ("content-type", "text/xml; charset=utf-8"),
                    ("SOAPAction", "http://www.cba.am/ExchangeRatesLatest"),
                ],
                None,
                false,
            )?;
            if !(200..300).contains(&response.status) {
                return Err(Box::new(transport::Failure {
                    code: "ERR_CBA_FETCH",
                    status: response.status,
                    retry_after_ms: None,
                    description: String::new(),
                }));
            }
            let value = source::parse_rates(&response.body, &iso_timestamp(now_ms())?)?;
            db.save_exchange_rates(&value)?;
            Ok(value)
        })();
        let retry = result
            .as_ref()
            .err()
            .and_then(|e| e.downcast_ref::<transport::Failure>())
            .is_some_and(|f| f.status == 0 || f.status == 429 || f.status >= 500);
        if !retry || attempt == 3 || http.stop.load(Ordering::Relaxed) {
            break;
        }
        let delay = config
            .number("externalRetryBaseMs")
            .saturating_mul(1 << attempt)
            .min(config.number("externalRetryMaxMs"));
        transport::wait(&http.stop, Duration::from_millis(delay))?;
    }
    match result {
        Ok(value) => {
            *next = now + 86_400_000;
            observe(health, "recordExchangeRateSnapshot", json!([value]));
            observe(health, "recordComponentSuccess", json!(["cba"]));
            Ok(value)
        }
        Err(error) => {
            *next = now + 3_600_000;
            event(
                "cba.refresh.failed",
                json!({"usingStoredRates":current.is_some()}),
            );
            observe(health, "recordExchangeRateFailure", json!([current]));
            current.ok_or(error)
        }
    }
}

pub fn serve(config: Config, options: &HashMap<String, String>) -> Result<()> {
    let cancellation = super::operations::Cancellation::start();
    let testing = config.text("environmentName") == "test";
    if !testing && !options.is_empty() {
        return Err("local peer overrides require NODE_ENV=test".into());
    }
    let endpoint = |key: &str, default: String| -> Result<String> {
        options
            .get(key)
            .map(|value| transport::local_endpoint(value))
            .unwrap_or(Ok(default))
    };
    let telegram_url = endpoint(
        "--telegram-endpoint",
        format!(
            "https://api.telegram.org/bot{}",
            config.text("telegramBotToken")
        ),
    )?;
    let source_origin = endpoint("--source-origin", "https://www.list.am".to_string())?;
    let cba_url = endpoint(
        "--cba-endpoint",
        "https://api.cba.am/exchangerates.asmx".to_string(),
    )?;
    config.validate_startup()?;
    let directory = Path::new(config.text("dataDirectory"));
    lease::secure_directory(directory)?;
    let _lease = Lease::acquire(directory)?;
    let crawl_db = Database::open(directory, config.get("telegramChannelId").as_str())?;
    crawl_db.validate_domains()?;
    let mut channel_db = if config.get("telegramChannelId").is_null() {
        None
    } else {
        Some(Database::open(
            directory,
            config.get("telegramChannelId").as_str(),
        )?)
    };
    let db = Arc::new(Mutex::new(Database::open(
        directory,
        config.get("telegramChannelId").as_str(),
    )?));
    let cookie = Path::new(config.text("listAmCookieFile"));
    lease::secure_directory(cookie.parent().ok_or("missing cookie parent")?)?;
    if fs::canonicalize(cookie.parent().unwrap())? != cookie.parent().unwrap() {
        return Err("cookie directory resolves through a symlink".into());
    }
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(cookie)?;
    fs::set_permissions(cookie, fs::Permissions::from_mode(0o600))?;
    if !testing {
        let version = std::process::Command::new(config.text("curlImpersonatePath"))
            .args(["--disable", "--version"])
            .output()?;
        if !version.status.success()
            || !String::from_utf8_lossy(&version.stdout).contains("-IMPERSONATE")
        {
            return Err("curl-impersonate is required".into());
        }
    }
    let stop = cancellation.stop.clone();
    let fatal = Arc::new(AtomicBool::new(false));
    let http = transport::from_config(&config, stop.clone());
    let telegram = Telegram {
        http: http.clone(),
        endpoint: telegram_url,
        retry_base_ms: config.number("externalRetryBaseMs"),
        retry_max_ms: config.number("externalRetryMaxMs"),
    };
    let verification = (|| -> Result<()> {
        let identity = telegram.call("getMe", &json!({}), 4)?;
        if identity["is_bot"] != true || identity["id"].as_i64().is_none_or(|id| id <= 0) {
            return Err("Telegram identity is invalid".into());
        }
        if let Some(id) = config.get("telegramChannelId").as_str() {
            let chat = telegram.call("getChat", &json!({"chat_id":id}), 4)?;
            let member = telegram.call(
                "getChatMember",
                &json!({"chat_id":id,"user_id":identity["id"]}),
                4,
            )?;
            if chat["type"] != "channel"
                || !(member["status"] == "creator"
                    || (member["status"] == "administrator"
                        && member["can_post_messages"] == true
                        && member["can_edit_messages"] == true))
            {
                return Err("Telegram channel permissions are insufficient".into());
            }
        }
        Ok(())
    })();
    verification?;
    let health = Arc::new(Mutex::new(Health::new("1.0.0", now_ms())));
    observe(&health, "setConfigurationValid", json!([]));
    observe(&health, "recordComponentSuccess", json!(["state"]));
    observe(&health, "recordComponentSuccess", json!(["telegram"]));
    let health_worker = health::start_server(&config, health.clone(), stop.clone())?;
    let gates: Gates = Arc::new(Mutex::new(HashMap::new()));
    let cancellations: Cancellations = Arc::new(Mutex::new(HashMap::new()));
    let poll = poll_thread(
        config.clone(),
        db.clone(),
        gates.clone(),
        telegram.clone(),
        stop.clone(),
        fatal.clone(),
        health.clone(),
        cancellations.clone(),
    );
    let metadata_tg = telegram.clone();
    let metadata_stop = stop.clone();
    let metadata = thread::spawn(move || {
        while !metadata_stop.load(Ordering::Relaxed) {
            let mut okay = true;
            for op in bot::metadata_operations() {
                if metadata_tg
                    .call(op["method"].as_str().unwrap(), &op["payload"], 4)
                    .is_err()
                {
                    okay = false;
                    break;
                }
            }
            if okay {
                event("telegram.metadata.synchronized", json!({}));
                break;
            }
            event("telegram.metadata.failed", json!({}));
            let _ = transport::wait(&metadata_stop, Duration::from_secs(3600));
        }
    });
    let mut source = Source {
        http,
        origin: source_origin,
        cookie: cookie.to_path_buf(),
        next_request: Instant::now(),
        impersonate: !testing,
    };
    let mut scheduler = Scheduler::default();
    let next_rates = Arc::new(Mutex::new(0));
    let rates_db = Database::open(directory, config.get("telegramChannelId").as_str())?;
    let rates_http = source.http.clone();
    let rates_url = cba_url.clone();
    let rates_next = next_rates.clone();
    let rates_stop = stop.clone();
    let rates_fatal = fatal.clone();
    let rates_health = health.clone();
    let rates_config = config.clone();
    let rates_worker = thread::spawn(move || {
        while !rates_stop.load(Ordering::Relaxed) {
            let result = rates(
                &rates_db,
                &rates_http,
                &rates_url,
                &mut rates_next.lock().unwrap(),
                &rates_health,
                &rates_config,
            );
            if result
                .as_ref()
                .err()
                .is_some_and(|e| e.downcast_ref::<rusqlite::Error>().is_some())
            {
                fail_runtime(&rates_fatal, &rates_stop);
                break;
            }
            let _ = transport::wait(&rates_stop, Duration::from_secs(60));
        }
    });
    let mut preflight = false;
    let mut failures = 0_u32;
    let mut result: Result<()> = Ok(());
    while !stop.load(Ordering::Relaxed) {
        let mut monitoring = false;
        let mut failure_component = "cba";
        let run = (|| -> Result<()> {
            let rates = rates(
                &crawl_db,
                &source.http,
                &cba_url,
                &mut next_rates.lock().unwrap(),
                &health,
                &config,
            )?;
            failure_component = "list_am";
            if !preflight {
                let saved = crawl_db.load_apartments()?;
                for (kind, category) in [("apartment", 56), ("house", 1377)] {
                    let reply = source.fetch(&format!(
                        "/ru/category/{category}/1?n=0&cmtype=0&crc=0&gl=2&srt=3"
                    ))?;
                    let diagnostics = source::parse_page(&reply.body, kind, now_ms())?;
                    let prior = saved
                        .as_ref()
                        .and_then(|state| {
                            state["sourceIntegrity"]["recentFirstPageCounts"].get(kind)
                        })
                        .unwrap_or(&Value::Null);
                    source::evaluate_integrity(&diagnostics, 1, prior)?;
                }
                preflight = true;
                observe(
                    &health,
                    "setPreflight",
                    json!([{"ready":true,"checks":{"configuration":"passed","state":"passed","telegram":"passed","source_transport":"passed","list_am":"passed","exchange_rates":"passed"}}]),
                );
                event(
                    "startup.preflight.completed",
                    json!({"preflight":{"ready":true,"status":"ready","checks":{"storage":"passed","state":"passed","singleton":"passed","telegram":"passed","channel":if config.get("telegramChannelId").is_null(){"skipped"}else{"passed"},"source_transport":"passed","list_am":"passed","exchange_rates":"passed"}}}),
                );
            }
            let users = db.lock().unwrap().load_telegram()?;
            let users = users["users"].as_object().ok_or("missing users")?;
            let authorized = users
                .values()
                .filter(|u| u["chatId"].as_i64().is_some_and(|id| config.authorized(id)))
                .count();
            let active = users
                .values()
                .filter(|u| {
                    u["active"] == true
                        && u.get("deletionPendingAt").is_none()
                        && u["chatId"].as_i64().is_some_and(|id| config.authorized(id))
                })
                .count();
            monitoring = active > 0 || !config.get("telegramChannelId").is_null();
            observe(
                &health,
                "setPrivateAccessState",
                json!([{"accessMode":config.get("telegramAccessMode"),"persistedUserCount":users.len(),"authorizedUserCount":authorized,"suspendedUserCount":users.len()-authorized,"activeUserCount":active}]),
            );
            observe(
                &health,
                "setMonitoringState",
                json!([{"active":active>0,"channelConfigured":!config.get("telegramChannelId").is_null()}]),
            );
            if monitoring {
                let crawl_started = Instant::now();
                let crawl_id = fs::read_to_string("/proc/sys/kernel/random/uuid")?
                    .trim()
                    .to_string();
                event("crawl.started", json!({"crawlId":crawl_id}));
                let crawl = super::crawl::crawl(&crawl_db, &config, &mut source, &rates, now_ms())?;
                let fresh: HashSet<String> =
                    serde_json::from_value(crawl.get("freshIds").cloned().unwrap_or(json!([])))?;
                observe(&health, "recordSourceIntegritySuccess", json!([]));
                for (index, check) in crawl["sourceIntegrityChecks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    let mut fields = check.clone();
                    fields["sourcePage"] = fields["page"].clone();
                    fields["page"] = json!(index + 1);
                    fields["crawlId"] = json!(crawl_id);
                    fields["phase"] = json!("runtime");
                    event("source.integrity.checked", fields);
                }
                failure_component = "telegram";
                // Channel publication runs independently of private rate waits.
                let (private_result, channel_result) =
                    thread::scope(|scope| -> Result<(Result<Value>, Result<Value>)> {
                        let config_ref = &config;
                        let telegram_ref = &telegram;
                        let fatal_ref = &fatal;
                        let stop_ref = &stop;
                        let crawl_ref = &crawl_id;
                        let channel_worker = channel_db.as_mut().map(|database| {
                            scope.spawn(move || {
                                let result = channel_delivery(
                                    database,
                                    config_ref,
                                    telegram_ref,
                                    stop_ref,
                                    crawl_ref,
                                    crawl_started,
                                );
                                if result.as_ref().err().is_some_and(|error| {
                                    terminal(error.as_ref())
                                        || error.downcast_ref::<transport::Failure>().is_none()
                                }) && !stop_ref.load(Ordering::Relaxed)
                                {
                                    fail_runtime(fatal_ref, stop_ref);
                                }
                                result
                            })
                        });
                        let private_result = scheduler.deliver(
                            &db,
                            &config,
                            &telegram,
                            &gates,
                            &fresh,
                            &stop,
                            &fatal,
                            &cancellations,
                        );
                        let channel_result = if let Some(worker) = channel_worker {
                            worker.join().map_err(|_| "channel worker panicked")?
                        } else {
                            Ok(json!({"sentCount":0,"editedCount":0}))
                        };
                        Ok((private_result, channel_result))
                    })?;
                let private = private_result?;
                let channel = channel_result?;
                if stop.load(Ordering::Relaxed) {
                    return Err("crawl cancelled before completion".into());
                }
                observe(&health, "recordCrawlSuccess", json!([]));
                event(
                    "crawl.succeeded",
                    json!({"crawlId":crawl_id,"durationMs":crawl_started.elapsed().as_millis(),"duration":crawl_started.elapsed().as_millis(),"pages":crawl["lastCrawl"]["pagesParsed"],"pagesParsed":crawl["lastCrawl"]["pagesParsed"],"discovered":crawl["lastCrawl"]["discoveredCount"],"discoveredCount":crawl["lastCrawl"]["discoveredCount"],"updated":crawl["lastCrawl"]["updatedCount"],"updatedCount":crawl["lastCrawl"]["updatedCount"],"notified":private["notified"],"notifiedCount":private["notified"],"filtered":private["filtered"],"filteredCount":private["filtered"],"readmitted":private["readmitted"],"readmittedCount":private["readmitted"],"skippedCount":private["skipped"],"channelSent":channel["sentCount"],"channelEdited":channel["editedCount"],"total":crawl["totalCount"],"totalCount":crawl["totalCount"],"status":if crawl["lastCrawl"]["initialRun"]==true{"initial-crawl"}else if crawl["lastCrawl"]["discoveredCount"].as_u64().unwrap_or(0)>0{"new-apartments"}else if crawl["lastCrawl"]["updatedCount"].as_u64().unwrap_or(0)>0{"updated-apartments"}else{"unchanged"}}),
                );
            }
            Ok(())
        })();
        let delay = match run {
            Ok(()) => {
                failures = 0;
                if monitoring {
                    let fraction = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .subsec_nanos() as f64
                        / 1_000_000_000.;
                    (config.number("pollIntervalMs") as f64 * (0.8 + 0.4 * fraction))
                        .round()
                        .max(1.) as u64
                } else {
                    100
                }
            }
            Err(error) => {
                if fatal.load(Ordering::Relaxed) {
                    result = Err(error);
                    break;
                }
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                if error.downcast_ref::<rusqlite::Error>().is_some() {
                    fail_runtime(&fatal, &stop);
                    result = Err(error);
                    break;
                }
                failures = failures.saturating_add(1);
                let transport = error.downcast_ref::<transport::Failure>();
                let challenge = transport.is_some_and(|f| f.code == "ERR_LIST_AM_CHALLENGE");
                let integrity = error.downcast_ref::<source::IntegrityError>().is_some();
                let reason = error
                    .downcast_ref::<source::IntegrityError>()
                    .map(|error| error.reason.as_str());
                let code = if challenge {
                    "ERR_LIST_AM_CHALLENGE"
                } else if integrity {
                    "ERR_LIST_AM_SOURCE_INTEGRITY"
                } else {
                    "ERR_EXTERNAL_FAILURE"
                };
                if challenge {
                    observe(&health, "recordSourceChallenge", json!([]));
                }
                observe(
                    &health,
                    "recordCrawlFailure",
                    json!([
                        if challenge {
                            "list_am_challenge"
                        } else {
                            failure_component
                        },
                        code
                    ]),
                );
                if !preflight {
                    event(
                        "startup.preflight.completed",
                        json!({"preflight":{"ready":false,"status":if challenge{"source_challenge"}else{"failed"},"failure":{"component":failure_component,"code":code,"reason":reason}}}),
                    );
                    observe(
                        &health,
                        "setPreflight",
                        json!([{"ready":false,"status":if challenge{"source_challenge"}else{"failed"},"failure":{"component":failure_component,"code":code}}]),
                    );
                }
                event(
                    "runtime.failed",
                    json!({"component":failure_component,"reason":code}),
                );
                let retry = transport.and_then(|f| f.retry_after_ms).unwrap_or(0);
                let backoff = config
                    .number("externalRetryBaseMs")
                    .saturating_mul(1_u64 << failures.saturating_sub(1).min(20))
                    .min(config.number("externalRetryMaxMs"));
                retry
                    .max(backoff)
                    .max(if challenge || transport.is_some_and(|f| f.status == 429) {
                        config.number("pollIntervalMs")
                    } else {
                        0
                    })
            }
        };
        let _ = transport::wait(&stop, Duration::from_millis(delay));
    }
    stop.store(true, Ordering::Relaxed);
    for worker in [poll, metadata, health_worker, rates_worker] {
        if worker.join().is_err() {
            fatal.store(true, Ordering::Relaxed);
        }
    }
    db.lock().unwrap().checkpoint()?;
    crawl_db.checkpoint()?;
    event("runtime.stopped", json!({}));
    if fatal.load(Ordering::Relaxed) {
        Err("runtime stopped after a fatal state or Telegram credential failure".into())
    } else {
        result
    }
}
