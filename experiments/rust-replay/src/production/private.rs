//! Consent-aware private classification;
//! Delivery acknowledgement remains per message.
use super::{
    Result,
    config::Config,
    filters, source,
    storage::{Database, iso_timestamp},
};

use serde_json::{Value, json};

use std::collections::{HashMap, HashSet};

pub struct Batch {
    pub count: usize,
    pub announce: bool,
    pub filtered: usize,
    pub skipped: usize,
    pub readmitted: usize,
}

fn decision(recipient: &Value, status: &str, item: &str) -> bool {
    recipient[status].get(item).is_some()
}

fn updated_after(a: &Value, at: &Value, now: i64) -> bool {
    let parse = |v: &Value| {
        v.as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|v| v.timestamp_millis())
    };
    parse(&a["updatedAt"])
        .zip(parse(at))
        .is_some_and(|(updated, decided)| updated > decided && now - updated < 86_400_000)
}

pub fn classify(
    db: &Database,
    config: &Config,
    user: &Value,
    fresh_ids: &HashSet<String>,
    now: i64,
) -> Result<Batch> {
    let id = user["chatId"]
        .as_i64()
        .ok_or("private user needs chatId")?
        .to_string();
    let filter = filters::normalize_filters(&user["filters"]);
    let candidates = db.load_private_candidates(&id, &filter)?;
    let apartments = &candidates["apartments"];
    let order: Vec<String> = serde_json::from_value(candidates["apartmentOrder"].clone())?;
    let work: Vec<i64> = serde_json::from_value(candidates["workIds"].clone())?;
    let mut recipient = db.load_recipient(&id, &order)?.unwrap_or(json!({
    "initialSelectionApplied":false,"notified":{
    }
    ,"skipped":{
    }
    ,"filtered":{
    }
    }
    ));
    let at = iso_timestamp(now)?;
    let mut selection_applied = false;
    let (mut filtered_count, mut skipped_count, mut readmitted_count) = (0, 0, 0);

    if !recipient["initialSelectionApplied"]
        .as_bool()
        .unwrap_or(false)
        && (!order.is_empty() || candidates["hasStoredApartments"] == true)
    {
        let selectable: Vec<&String> = order
            .iter()
            .filter(|item| {
                !decision(&recipient, "notified", item)
                    && !decision(&recipient, "skipped", item)
                    && filters::matches(&apartments[*item], &filter)
                    && source::within_activity(&apartments[*item], now)
            })
            .collect();
        let limit = if user["sendInitialApartments"] == false {
            0
        } else {
            config.values["initialDeliveryLimit"]
                .as_u64()
                .unwrap_or(100) as usize
        };
        let selected: HashSet<&String> = selectable.iter().take(limit).copied().collect();
        let released: Vec<String> = selected
            .iter()
            .filter(|item| decision(&recipient, "filtered", item))
            .map(|s| (*s).clone())
            .collect();
        let mut skipped = json!({});
        let mut filtered = json!({});

        for item in &selectable {
            if !selected.contains(item) {
                skipped[*item] = json!(at);
            }
        }

        for item in &order {
            if !decision(&recipient, "notified", item)
                && !decision(&recipient, "skipped", item)
                && !decision(&recipient, "filtered", item)
                && !filters::matches(&apartments[item], &filter)
            {
                filtered[item] = json!(at);
            }
        }

        filtered_count += filtered.as_object().unwrap().len();
        skipped_count += skipped.as_object().unwrap().len();
        readmitted_count += released.len();
        db.initialize_selection(
            &id,
            &json!({
            "released":released,"skipped":skipped,"filtered":filtered}
            ),
        )?;

        for item in &released {
            recipient["filtered"].as_object_mut().unwrap().remove(item);
        }

        for (item, time) in skipped.as_object().unwrap() {
            recipient["skipped"][item] = time.clone();
            recipient["filtered"].as_object_mut().unwrap().remove(item);
        }

        for (item, time) in filtered.as_object().unwrap() {
            recipient["filtered"][item] = time.clone();
        }

        recipient["initialSelectionApplied"] = json!(true);
        selection_applied = true;
    }

    for item in &order {
        if decision(&recipient, "filtered", item)
            && updated_after(&apartments[item], &recipient["filtered"][item], now)
            && filters::matches(&apartments[item], &filter)
        {
            db.remove_filtered_decision(&id, item)?;
            readmitted_count += 1;
            recipient["filtered"].as_object_mut().unwrap().remove(item);
        }
    }

    let mut filtered = json!({});
    for item in &order {
        if !decision(&recipient, "notified", item)
            && !decision(&recipient, "skipped", item)
            && !decision(&recipient, "filtered", item)
            && !filters::matches(&apartments[item], &filter)
        {
            filtered[item] = json!(at);
        }
    }

    if !filtered.as_object().unwrap().is_empty() {
        db.classify_private(&id, "filtered", &filtered)?;
        filtered_count += filtered.as_object().unwrap().len();
        for (item, time) in filtered.as_object().unwrap() {
            recipient["filtered"][item] = time.clone();
        }
    }

    let pending: Vec<String> = order
        .iter()
        .rev()
        .filter(|item| {
            let a = &apartments[*item];
            if !source::within_activity(a, now) {
                return false;
            }
            if decision(&recipient, "notified", item) {
                updated_after(a, &recipient["notified"][*item], now) && filters::matches(a, &filter)
            } else {
                !decision(&recipient, "skipped", item) && !decision(&recipient, "filtered", item)
            }
        })
        .cloned()
        .collect();

    db.retain_pending(&id, &pending, &work)?;
    let work_by_item: HashMap<&String, i64> = order.iter().zip(work.iter().copied()).collect();
    let items: Vec<Value> = pending
        .iter()
        .map(|item| {
            json!({
            "itemId":item,"workId":work_by_item.get(item)}
            )
        })
        .collect();
    db.prepare_batch(&id, &json!(items))?;
    Ok(Batch {
        count: pending.len(),
        filtered: filtered_count,
        skipped: skipped_count,
        readmitted: readmitted_count,
        announce: selection_applied || pending.iter().any(|id| !fresh_ids.contains(id)),
    })
}

pub fn contract(v: Value) -> Result<Value> {
    let config = Config {
        values: v["config"].clone(),
    };
    let db = Database::open(
        std::path::Path::new(v["directory"].as_str().ok_or("directory required")?),
        config.values["telegramChannelId"].as_str(),
    )?;
    let fresh: HashSet<String> =
        serde_json::from_value(v.get("freshIds").cloned().unwrap_or(json!([])))?;
    let batch = classify(
        &db,
        &config,
        &v["user"],
        &fresh,
        v["nowMs"].as_i64().ok_or("nowMs required")?,
    )?;
    Ok(json!({
    "count":batch.count,"announce":batch.announce,"next":db.next_batch_item(&v["user"]["chatId"].as_i64().unwrap().to_string())?}
    ))
}
