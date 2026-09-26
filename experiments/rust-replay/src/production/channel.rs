//! Durable channel classification and per-message acknowledgement.
use super::{
    Result,
    config::Config,
    filters, source,
    storage::{Database, iso_timestamp},
};

use rusqlite::{OptionalExtension, params};

use serde_json::{Value, json};

use sha2::{Digest, Sha256};

fn hash(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn time(v: &Value) -> Option<i64> {
    v.as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|v| v.timestamp_millis())
}

pub fn readmission(a: &Value, e: &Value, f: &Value, now: i64) -> Option<&'static str> {
    if !filters::matches(a, f) {
        return None;
    }

    let after = |key: &str| {
        time(&a[key])
            .zip(time(&e["classifiedAt"]))
            .is_some_and(|(t, c)| t > c && now - t < 86_400_000)
    };

    if e["status"] == "skipped_initial" && after("lastSeenAt") {
        return Some("reencountered");
    }

    if e["status"] != "filtered" {
        return None;
    }

    if after("updatedAt") {
        return Some("updated_match");
    }

    let posted = a["date"]
        .as_str()
        .and_then(|s| source::posting_date_ms(s, now))
        .or_else(|| time(&a["firstSeenAt"]));

    if posted.is_some_and(|t| now - t < 86_400_000) {
        Some("recent_match")
    } else {
        None
    }
}

fn entry(db: &Database, id: &str) -> Result<Option<Value>> {
    Ok(db.connection.query_row("SELECT status,classified_at,reencountered_at,message_id,content_hash,published_at,updated_at FROM channel_deliveries WHERE item_id=?",[id],|r|Ok(json!({
"status":r.get::<_,String>(0)?,"classifiedAt":r.get::<_,String>(1)?,"reencounteredAt":r.get::<_,Option<String>>(2)?,"messageId":r.get::<_,Option<i64>>(3)?,"contentHash":r.get::<_,Option<String>>(4)?,"publishedAt":r.get::<_,Option<String>>(5)?,"updatedAt":r.get::<_,Option<String>>(6)?}
))).optional()?)
}

fn apartment(payload: String, last_seen: Option<String>) -> Result<Value> {
    let mut a: Value = serde_json::from_str(&payload)?;

    if let Some(t) = last_seen {
        a["lastSeenAt"] = json!(t)
    }

    Ok(a)
}

/// Queue source changes atomically before advancing the channel cursor.
pub fn prepare(db: &Database, config: &Config, now: i64) -> Result<Value> {
    let cfg = &config.values;

    let filters = &cfg["channelFilters"];

    let fingerprint = filter_fingerprint(filters)?;

    let at = iso_timestamp(now)?;

    db.transaction(|c|{
let previous:Option<(String,i64)>=c.query_row("SELECT filter_fingerprint,source_sequence FROM channel_state WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
let sequence:i64=c.query_row("SELECT sequence FROM crawl_state WHERE singleton=1",[],|r|r.get(0)).optional()?.unwrap_or(0);
let mut filtered=0;
let mut skipped=0;

 if previous.is_none(){
c.execute("INSERT INTO channel_state(singleton,channel_id,list_url_template,initialized,filter_fingerprint,source_sequence) VALUES(1,?,?,1,?,?)",params![cfg["telegramChannelId"].as_str().ok_or("missing channel")?,super::storage::TEMPLATE,fingerprint,sequence])?;
let mut stmt=c.prepare("SELECT item_id,payload_json,last_seen_at FROM apartments ORDER BY encounter_sequence DESC,encounter_position ASC")?;
let mut rows=stmt.query([])?;
let mut selected=0;
while let Some(row)=rows.next()?{
let id:String=row.get(0)?;
let a=apartment(row.get(1)?,row.get(2)?)?;
let status=if !filters::matches(&a,filters){
filtered+=1;
"filtered"}
else{
selected+=1;
if selected<=cfg["initialDeliveryLimit"].as_u64().unwrap_or(100){
"pending"}
else{
skipped+=1;
"skipped_initial"}
}
;
c.execute("INSERT INTO channel_deliveries(item_id,status,classified_at) VALUES(?,?,?)",params![id,status,at])?;
}
c.execute("INSERT OR IGNORE INTO channel_work(item_id) SELECT a.item_id FROM apartments a JOIN channel_deliveries d USING(item_id) WHERE d.status='pending' ORDER BY a.encounter_sequence ASC,a.encounter_position DESC",[])?;

 }
else if let Some((old,cursor))=previous.as_ref(){
c.execute("INSERT OR IGNORE INTO channel_work(item_id) SELECT a.item_id FROM apartments a LEFT JOIN channel_deliveries d USING(item_id) WHERE a.changed_sequence>? OR (a.encounter_sequence>? AND d.status='skipped_initial') ORDER BY a.encounter_sequence ASC,a.encounter_position DESC",params![cursor,cursor])?;
if old!=&fingerprint {
let mut stmt=c.prepare("SELECT a.item_id,a.payload_json,a.last_seen_at FROM apartments a JOIN channel_deliveries d USING(item_id) WHERE d.status IN ('filtered','skipped_initial') ORDER BY a.encounter_sequence ASC,a.encounter_position DESC")?;
let mut rows=stmt.query([])?;
while let Some(row)=rows.next()? {
let id:String=row.get(0)?;
let a=apartment(row.get(1)?,row.get(2)?)?;
if readmission(&a,&entry(db,&id)?.unwrap(),filters,now).is_some(){
c.execute("INSERT OR IGNORE INTO channel_work(item_id) VALUES(?)",[id])?;
}
}
}
}

 c.execute_batch("CREATE TEMP TABLE channel_work_ordered AS SELECT w.item_id FROM channel_work w JOIN apartments a USING(item_id) ORDER BY a.encounter_sequence ASC,a.encounter_position DESC; DELETE FROM channel_work; INSERT INTO channel_work(item_id) SELECT item_id FROM channel_work_ordered; DROP TABLE channel_work_ordered;")?;
c.execute("UPDATE channel_state SET source_sequence=?,filter_fingerprint=? WHERE singleton=1",params![sequence,fingerprint])?;
Ok(json!({
"filteredCount":filtered,"skippedCount":skipped,"previousFingerprint":previous.map(|p|p.0),"filterFingerprint":fingerprint}
))}
)
}

/// A page remains in durable work until each operation is acknowledged.
pub fn operations(
    db: &Database,
    config: &Config,
    after: i64,
    limit: i64,
    now: i64,
) -> Result<Vec<Value>> {
    let mut stmt=db.connection.prepare("SELECT w.work_id,a.item_id,a.payload_json,a.last_seen_at FROM channel_work w JOIN apartments a USING(item_id) WHERE w.work_id>? ORDER BY w.work_id LIMIT ?")?;

    let rows = stmt
        .query_map(params![after, limit], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut ops = vec![];

    for (work, id, payload, seen) in rows {
        let a = apartment(payload, seen)?;

        let mut e = match entry(db, &id)? {
            Some(e) => e,
            None => {
                let status = if filters::matches(&a, &config.values["channelFilters"]) {
                    "pending"
                } else {
                    "filtered"
                };

                db.connection.execute(
                    "INSERT INTO channel_deliveries(item_id,status,classified_at) VALUES(?,?,?)",
                    params![id, status, iso_timestamp(now)?],
                )?;

                json!({
                "status":status,"classifiedAt":iso_timestamp(now)?}
                )
            }
        };

        if let Some(reason) = readmission(&a, &e, &config.values["channelFilters"], now) {
            db.connection.execute("UPDATE channel_deliveries SET status='pending',reencountered_at=?,message_id=NULL,content_hash=NULL,published_at=NULL,updated_at=NULL WHERE item_id=?",params![a["lastSeenAt"].as_str().map(str::to_owned).unwrap_or(iso_timestamp(now)?),id])?;

            e["status"] = json!("pending");

            e["readmissionReason"] = json!(reason);
        }

        if e["status"] != "pending" && e["status"] != "published" {
            db.connection
                .execute("DELETE FROM channel_work WHERE item_id=?", [&id])?;

            continue;
        }

        let text = filters::format_message(&a, true);

        let content_hash = hash(&text);

        if e["status"] == "published" && e["contentHash"] == content_hash {
            db.connection
                .execute("DELETE FROM channel_work WHERE item_id=?", [&id])?;

            continue;
        }

        let repost = e["status"] == "published"
            && time(&e["publishedAt"]).is_some_and(|t| now - t > 259_200_000);

        let edit = e["status"] == "published" && !repost;

        let mut payload = json!({
        "chat_id":config.values["telegramChannelId"],"text":text,"disable_web_page_preview":true}
        );

        if edit {
            payload["message_id"] = e["messageId"].clone();
        }

        ops.push(json!({
"method":if edit{
"editMessageText"}
else{
"sendMessage"}
,"payload":payload,"workId":work,"itemId":id,"contentHash":content_hash,"publishedAt":if edit{
e["publishedAt"].clone()}
else{
json!(iso_timestamp(now)?)}
,"updatedAt":if edit{
json!(iso_timestamp(now)?)}
else{
Value::Null}
,"operation":if edit{
"edit"}
else if repost{
"repost"}
else{
"send"}
}
));
    }

    Ok(ops)
}

pub fn acknowledge(db: &Database, op: &Value, result: &Value) -> Result<()> {
    let id = op["itemId"]
        .as_str()
        .ok_or("channel operation missing item")?;

    let message = result["message_id"]
        .as_i64()
        .or_else(|| op["payload"]["message_id"].as_i64())
        .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
        .ok_or("Telegram sendMessage returned an invalid message_id")?;

    db.transaction(|c|{
c.execute("UPDATE channel_deliveries SET status='published',message_id=?,content_hash=?,published_at=?,updated_at=? WHERE item_id=?",params![message,op["contentHash"].as_str(),op["publishedAt"].as_str(),op["updatedAt"].as_str(),id])?;
c.execute("DELETE FROM channel_work WHERE item_id=?",[id])?;
Ok(())}
)
}

/// Preserve the baseline JSON field order across the JavaScript/Rust boundary.
pub fn filter_fingerprint(f: &Value) -> Result<String> {
    Ok(hash(&format!(
        "{{\"kinds\":{},\"price\":{{\"min\":{},\"max\":{}}},\"rooms\":{{\"min\":{},\"max\":{}}},\"locations\":{}}}",
        serde_json::to_string(&f["kinds"])?,
        f["price"]["min"],
        f["price"]["max"],
        f["rooms"]["min"],
        f["rooms"]["max"],
        serde_json::to_string(&f["locations"])?
    )))
}

pub fn next_cursor(db: &Database, after: i64, limit: i64) -> Result<Option<i64>> {
    Ok(db.connection.query_row("SELECT max(work_id) FROM (SELECT work_id FROM channel_work WHERE work_id>? ORDER BY work_id LIMIT ?)",params![after,limit],|r|r.get(0))?)
}

pub fn contract(v: Value) -> Result<Value> {
    let config = Config {
        values: v["config"].clone(),
    };

    let db = Database::open(
        std::path::Path::new(v["directory"].as_str().ok_or("directory required")?),
        config.values["telegramChannelId"].as_str(),
    )?;

    let now = v["nowMs"].as_i64().ok_or("nowMs required")?;

    match v["action"].as_str().unwrap_or("prepare") {
        "prepare" => prepare(&db, &config, now),
        "operations" => Ok(json!(operations(
            &db,
            &config,
            v["after"].as_i64().unwrap_or(0),
            v["limit"].as_i64().unwrap_or(100),
            now
        )?)),
        "acknowledge" => {
            acknowledge(&db, &v["operation"], &v["result"])?;
            Ok(json!({
            "ok":true}
            ))
        }
        _ => Err("unknown channel action".into()),
    }
}
