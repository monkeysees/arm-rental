//! Discovery commits only after every fetched page passes source-integrity checks.
use super::{
    Result,
    config::Config,
    source,
    storage::{Database, iso_timestamp},
    transport::{Http, Source, local_endpoint},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

fn original(price: &Value) -> (Option<f64>, Option<&'static str>) {
    if price.get("originalAmount").is_some() {
        (
            price["originalAmount"].as_f64(),
            price["originalCurrency"]
                .as_str()
                .and_then(source::currency_code),
        )
    } else {
        (
            price["amount"].as_f64(),
            price["currency"].as_str().and_then(source::currency_code),
        )
    }
}
fn changed(previous: &Value, observed: &Value) -> bool {
    [
        "title", "location", "rooms", "areaSqM", "floor", "url", "date",
    ]
    .iter()
    .any(|key| {
        if previous[key].is_number() && observed[key].is_number() {
            previous[key].as_f64() != observed[key].as_f64()
        } else {
            previous[key] != observed[key]
        }
    }) || original(&previous["price"]) != original(&observed["price"])
}
pub fn crawl(
    db: &Database,
    config: &Config,
    transport: &mut Source,
    rates: &Value,
    now_ms: i64,
) -> Result<Value> {
    let sources = config.values["listSources"]
        .as_array()
        .ok_or("Missing List.am sources")?;
    let kinds = sources
        .iter()
        .map(|s| s["kind"].as_str().unwrap_or("apartment").to_owned())
        .collect::<Vec<_>>();
    let state = db.load_crawl(&kinds, now_ms)?;
    let initial = state["totalCount"].as_u64().unwrap_or(0) == 0;
    let mut counts = state["sourceIntegrity"]["recentFirstPageCounts"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut changes = BTreeMap::new();
    for mut old in db.find_legacy_prices()? {
        old["price"] = source::normalize_price(&old["price"], rates)?;
        if old["kind"] != "house" {
            old["kind"] = json!("apartment");
        }
        changes.insert(
            old["itemId"].as_str().ok_or("Missing item ID")?.to_owned(),
            old,
        );
    }
    let mut previous = BTreeMap::<String, Value>::new();
    let mut observed = BTreeMap::<String, Value>::new();
    let mut discovered = vec![];
    let mut encountered = HashSet::new();
    let mut order: Vec<(String, Option<i64>)> = vec![];
    let mut summaries = vec![];
    let mut checks = vec![];
    let mut pages = 0;
    let crawl_date = source::format_posting_date(now_ms).ok_or("Invalid crawl clock")?;
    for spec in sources {
        let kind = spec["kind"].as_str().ok_or("Missing source kind")?;
        let template = spec["urlTemplate"]
            .as_str()
            .ok_or("Missing source template")?;
        let watermark = &state["watermarks"][kind];
        let kind_initial = watermark["initialRun"].as_bool().unwrap_or(true);
        let mark = watermark["value"].as_i64();
        let budget = config.number(if kind_initial && !initial {
            "addedCategoryPageCount"
        } else {
            "initialPageCount"
        });
        let prior = counts.get(kind).cloned().unwrap_or(json!([]));
        let mut first_count = None;
        let mut signatures = HashSet::new();
        let mut kind_pages = 0;
        let mut stopped = Value::Null;
        let mut exhausted = false;
        'pages: for page in 1.. {
            if (kind_initial || mark.is_none()) && page > budget {
                break;
            }
            let url = url::Url::parse(&template.replace("{page}", &page.to_string()))?;
            let path = format!(
                "{}{}",
                url.path(),
                url.query().map(|s| format!("?{s}")).unwrap_or_default()
            );
            let response = transport.fetch(&path)?;
            let diagnostics =
                source::parse_and_evaluate(&response.body, kind, page, &prior, now_ms)?;
            checks.push(source::page_summary(&diagnostics, page, kind));
            if page == 1 {
                first_count = diagnostics["parsedCount"].as_u64();
            }
            pages += 1;
            kind_pages += 1;
            let apartments = diagnostics["apartments"]
                .as_array()
                .ok_or("Invalid parser response")?;
            if apartments.is_empty() {
                exhausted = true;
                break;
            }
            let ids = apartments
                .iter()
                .map(|a| a["itemId"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            if !signatures.insert(ids.join(",")) {
                exhausted = true;
                break;
            }
            for (id, value) in db.find_encountered(&ids)?.as_object().unwrap() {
                let mut value = value.clone();
                value["price"] = source::normalize_price(&value["price"], rates)?;
                if value["kind"] != "house" {
                    value["kind"] = json!("apartment");
                }
                previous.insert(id.clone(), value);
            }
            for parsed in apartments {
                let id = parsed["itemId"].as_str().unwrap().to_owned();
                let mut apartment = parsed.clone();
                apartment["kind"] = json!(kind);
                let source_date = parsed["date"]
                    .as_str()
                    .and_then(|s| source::posting_date_ms(s, now_ms));
                if source_date.is_none() {
                    let stored = previous
                        .get(&id)
                        .and_then(|a| a["date"].as_str())
                        .filter(|s| source::posting_date_ms(s, now_ms).is_some());
                    apartment["date"] = json!(stored.unwrap_or(&crawl_date));
                }
                let posted = apartment["date"]
                    .as_str()
                    .and_then(|s| source::posting_date_ms(s, now_ms));
                let known = previous.contains_key(&id);
                if !kind_initial
                    && source_date.is_some()
                    && matches!((posted,mark),(Some(p),Some(m))if p<m)
                {
                    if known && encountered.insert(id.clone()) {
                        order.push((id.clone(), posted));
                        observed.insert(id, apartment);
                    }
                    stopped = watermark["date"].clone();
                    break 'pages;
                }
                if !encountered.insert(id.clone()) {
                    continue;
                }
                order.push((id.clone(), posted));
                if known {
                    observed.insert(id, apartment);
                } else {
                    apartment["price"] = source::normalize_price(&apartment["price"], rates)?;
                    discovered.push(apartment);
                }
            }
        }
        if let Some(n) = first_count {
            let mut history = prior.as_array().cloned().unwrap_or_default();
            history.push(json!(n));
            if history.len() > 5 {
                history.drain(..history.len() - 5);
            }
            counts.insert(kind.to_owned(), json!(history));
        }
        summaries.push(json!({"kind":kind,"initialRun":kind_initial,"pagesParsed":kind_pages,"lastKnownDate":watermark["date"],"stoppedAtKnownDate":stopped,"exhausted":exhausted}));
    }
    let checked = iso_timestamp(now_ms)?;
    let mut updated = vec![];
    for (id, mut item) in observed {
        let old = &previous[&id];
        if !changed(old, &item) {
            continue;
        }
        item["price"] = if original(&old["price"]) != original(&item["price"]) {
            source::normalize_price(&item["price"], rates)?
        } else {
            old["price"].clone()
        };
        item["firstSeenAt"] = old["firstSeenAt"].clone();
        item["lastSeenAt"] = json!(checked);
        item["updatedAt"] = json!(checked);
        updated.push(id.clone());
        changes.insert(id, item);
    }
    let mut fresh = discovered
        .iter()
        .map(|a| a["itemId"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    fresh.extend(updated.iter().cloned());
    for mut item in discovered.iter().cloned() {
        item["firstSeenAt"] = json!(checked);
        item["lastSeenAt"] = json!(checked);
        changes.insert(item["itemId"].as_str().unwrap().to_owned(), item);
    }
    order.sort_by(|a, b| b.1.cmp(&a.1));
    let order: Vec<_> = order.into_iter().map(|v| v.0).collect();
    let metadata = json!({"version":4,"type":"list-am-apartments","urlTemplate":config.values["listUrlTemplate"],"checkedAt":checked,"lastCrawl":{"initialRun":initial,"pagesParsed":pages,"discoveredCount":discovered.len(),"updatedCount":updated.len(),"sources":summaries},"sourceIntegrity":{"recentFirstPageCounts":counts,"lastSuccessfulAt":checked},"changes":changes.into_values().collect::<Vec<_>>(),"encounteredOrder":order});
    let total = db.commit_crawl(&metadata)?;
    Ok(
        json!({"checkedAt":checked,"freshIds":fresh,"sourceIntegrityChecks":checks,"totalCount":total,"lastCrawl":metadata["lastCrawl"]}),
    )
}
pub fn contract(v: &Value) -> Result<Value> {
    let directory = Path::new(v["directory"].as_str().ok_or("Missing directory")?);
    let mut env = v["env"].as_object().cloned().unwrap_or_default();
    env.insert("DATA_DIRECTORY".into(), json!(directory));
    let config = Config::parse(&json!(env), directory)?;
    let db = Database::open(directory, config.values["telegramChannelId"].as_str())?;
    let cookie = directory.join("list-am-cookies.txt");
    if !cookie.exists() {
        fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&cookie)?;
    }
    let http = Http {
        executable: config.text("curlImpersonatePath").into(),
        directory: directory.into(),
        stop: Arc::new(AtomicBool::new(false)),
        timeout_ms: 3000,
    };
    let mut source = Source {
        http,
        origin: local_endpoint(v["endpoint"].as_str().ok_or("Missing source peer")?)?,
        cookie,
        next_request: Instant::now(),
        impersonate: false,
    };
    crawl(
        &db,
        &config,
        &mut source,
        &v["rates"],
        v["nowMs"].as_i64().ok_or("Missing clock")?,
    )
}
