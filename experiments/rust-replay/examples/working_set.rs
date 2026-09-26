//! Read-only query profiling against an isolated synthetic replay database.
#[allow(dead_code)]
#[path = "../src/model.rs"]
mod model;
use rusqlite::{Connection, OpenFlags, StatementStatus, ffi, params};
use serde_json::{Value, json};
use std::{collections::HashMap, time::Instant};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn cache(db: &Connection) -> Result<Value> {
    let mut fields = serde_json::Map::new();
    for (name, code) in [
        ("usedBytes", ffi::SQLITE_DBSTATUS_CACHE_USED),
        ("hits", ffi::SQLITE_DBSTATUS_CACHE_HIT),
        ("misses", ffi::SQLITE_DBSTATUS_CACHE_MISS),
        ("writes", ffi::SQLITE_DBSTATUS_CACHE_WRITE),
    ] {
        let (mut current, mut high) = (0, 0);
        // The connection owns this handle and remains alive throughout the call.
        let rc = unsafe { ffi::sqlite3_db_status(db.handle(), code, &mut current, &mut high, 0) };
        if rc != ffi::SQLITE_OK {
            return Err(format!("sqlite3_db_status failed: {rc}").into());
        }
        fields.insert(name.into(), json!(current));
    }
    Ok(fields.into())
}
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 5 {
        return Err("working_set SYNTHETIC_DATABASE CUTOFF_MS USERS CACHE_KIB".into());
    }
    let cutoff: i64 = args[2].parse()?;
    let users: i64 = args[3].parse()?;
    let kib: i64 = args[4].parse()?;
    if users <= 0 || kib <= 0 {
        return Err("users and cache KiB must be positive".into());
    }
    let open = || -> Result<Connection> {
        let db = Connection::open_with_flags(&args[1], OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        db.pragma_update(None, "cache_size", -kib)?;
        Ok(db)
    };
    let db = open()?;
    let mut sizes = db.prepare(
        "SELECT name,sum(pgsize),sum(payload),sum(unused) FROM dbstat GROUP BY name ORDER BY name",
    )?;
    let sizes = sizes.query_map([], |r| Ok(json!({"name":r.get::<_,String>(0)?,"bytes":r.get::<_,i64>(1)?,"payloadBytes":r.get::<_,i64>(2)?,"unusedBytes":r.get::<_,i64>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let queries = [
        (
            "history",
            "SELECT user,id,status,revision,at FROM decisions WHERE id<400000 ORDER BY user,id",
        ),
        (
            "payloads",
            "SELECT l.payload,l.revision FROM listings l LEFT JOIN decisions d ON d.user=? AND d.id=l.id WHERE l.posted>=? AND (d.revision IS NULL OR d.revision!=l.revision) ORDER BY l.posted,l.id",
        ),
        (
            "keys",
            "SELECT l.id,l.revision FROM listings l LEFT JOIN decisions d ON d.user=? AND d.id=l.id WHERE l.posted>=? AND (d.revision IS NULL OR d.revision!=l.revision) ORDER BY l.posted DESC,l.id DESC",
        ),
        (
            "next",
            "SELECT l.payload FROM decisions d JOIN listings l ON l.id=d.id WHERE d.user=? AND d.status=0 ORDER BY l.posted,l.id LIMIT 1",
        ),
        (
            "next-key",
            "SELECT payload FROM listings WHERE id=(SELECT l.id FROM decisions d JOIN listings l ON l.id=d.id WHERE d.user=? AND d.status=0 ORDER BY l.posted,l.id LIMIT 1)",
        ),
    ];
    let mut results = Vec::new();
    for (name, sql) in queries {
        let db = open()?;
        let bindings: Vec<i64> = match name {
            "history" => vec![],
            "next" | "next-key" => vec![0],
            _ => vec![0, cutoff],
        };
        let mut explain = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
        let plan = explain
            .query_map(rusqlite::params_from_iter(&bindings), |r| {
                r.get::<_, String>(3)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let before = cache(&db)?;
        let start = Instant::now();
        let mut query = db.prepare(sql)?;
        let mut payload = db.prepare("SELECT payload FROM listings WHERE id=?")?;
        let (mut count, mut decoded, mut bytes, mut peak_payloads) = (0u64, 0u64, 0u64, 0usize);
        let mut cached: HashMap<i64, model::Listing> = HashMap::new();
        let mut digest = 0i64;
        for user in 0..if name == "history" { 1 } else { users } {
            let bindings: Vec<i64> = match name {
                "history" => vec![],
                "next" | "next-key" => vec![user],
                _ => vec![user, cutoff],
            };
            let mut rows = query.query(rusqlite::params_from_iter(bindings))?;
            let mut retained = Vec::new();
            while let Some(row) = rows.next()? {
                count += 1;
                if name == "history" {
                    for col in 0..5 {
                        digest = digest.wrapping_add(row.get::<_, i64>(col)?);
                    }
                    continue;
                }
                if name == "keys" {
                    let id: i64 = row.get(0)?;
                    if cached.contains_key(&id) {
                        continue;
                    }
                    if cached.len() == 128 {
                        cached.clear();
                    }
                    let text: String = payload.query_row(params![id], |r| r.get(0))?;
                    bytes += text.len() as u64;
                    cached.insert(id, serde_json::from_str::<model::Listing>(&text)?);
                    peak_payloads = peak_payloads.max(cached.len());
                } else {
                    let text: String = row.get(0)?;
                    bytes += text.len() as u64;
                    retained.push(serde_json::from_str::<model::Listing>(&text)?);
                    peak_payloads = peak_payloads.max(retained.len());
                }
                decoded += 1;
            }
            std::hint::black_box(&retained);
        }
        std::hint::black_box(digest);
        results.push(json!({"name":name,"sql":sql,"plan":plan,"rows":count,"decodedPayloads":decoded,"decodedBytes":bytes,"peakDecodedPayloads":peak_payloads,"wallMs":start.elapsed().as_secs_f64()*1000.0,"cacheBefore":before,"cacheAfter":cache(&db)?,"fullscanSteps":query.get_status(StatementStatus::FullscanStep),"sorts":query.get_status(StatementStatus::Sort),"vmSteps":query.get_status(StatementStatus::VmStep)}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"database":args[1],"users":users,"cutoffMs":cutoff,"cacheKiB":kib,"sqliteVersion":rusqlite::version(),"sizes":sizes,"queries":results})
        )?
    );
    Ok(())
}
