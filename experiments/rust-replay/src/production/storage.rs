//! Production SQLite identity, migrations and durable repository operations.
use super::Result;

use rusqlite::{Connection, OptionalExtension, params};

use serde_json::{Value, json};

use std::{
    fs,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const TEMPLATE: &str =
    "https://www.list.am/ru/category/56/{page}?n=0&cmtype=0&crc=0&gl=2&srt=3";

pub const APPLICATION_ID: i64 = 0x41524d52;

pub struct Database {
    pub connection: Connection,
    pub filename: PathBuf,
    history: std::cell::RefCell<History>,
}

#[derive(Default)]
struct History {
    sequence: Option<i64>,
    apartments: Vec<Value>,
    updated_ids: String,
    filters: std::collections::VecDeque<(String, String)>,
}

fn fail<T>(code: &str) -> Result<T> {
    Err(code.to_owned().into())
}

pub fn now_iso() -> String {
    iso_timestamp(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64,
    )
    .unwrap()
}

// Civil calendar conversion supports the complete JavaScript Date domain.
fn days(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);

    let era = y.div_euclid(400);

    let yo = y - era * 400;

    let m = month + if month > 2 { -3 } else { 9 };

    era * 146097 + yo * 365 + yo / 4 - yo / 100 + (153 * m + 2) / 5 + day - 1 - 719468
}

pub fn iso_timestamp(ms: i64) -> Result<String> {
    if !(-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&ms) {
        return fail("invalid canonical ISO timestamp");
    }

    let d = ms.div_euclid(86400000) + 719468;

    let era = d.div_euclid(146097);

    let doe = d - era * 146097;

    let yo = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;

    let mut y = yo + era * 400;

    let doy = doe - (365 * yo + yo / 4 - yo / 100);

    let mp = (5 * doy + 2) / 153;

    let day = doy - (153 * mp + 2) / 5 + 1;

    let month = mp + if mp < 10 { 3 } else { -9 };

    y += i64::from(month <= 2);

    let t = ms.rem_euclid(86400000);

    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else {
        format!("{}{:#06}", if y < 0 { "-" } else { "+" }, y.abs())
    };

    Ok(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        t / 3600000,
        t / 60000 % 60,
        t / 1000 % 60,
        t % 1000
    ))
}

pub fn iso_milliseconds(s: &str) -> Result<i64> {
    let offset = if s.starts_with(['+', '-']) { 7 } else { 4 };

    if !s.is_ascii() || s.len() != offset + 20 {
        return fail("invalid canonical ISO timestamp");
    }

    let number = |a, b| -> Result<i64> { Ok(s[a..b].parse()?) };

    let y = number(0, offset)?;

    let m = number(offset + 1, offset + 3)?;

    let d = number(offset + 4, offset + 6)?;

    let h = number(offset + 7, offset + 9)?;

    let mi = number(offset + 10, offset + 12)?;

    let sec = number(offset + 13, offset + 15)?;

    let milli = number(offset + 16, offset + 19)?;

    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 59 {
        return fail("invalid canonical ISO timestamp");
    }

    let ms = days(y, m, d) * 86400000 + h * 3600000 + mi * 60000 + sec * 1000 + milli;

    if iso_timestamp(ms)? != s {
        return fail("invalid canonical ISO timestamp");
    }

    Ok(ms)
}

impl Database {
    pub fn initialize(directory: &Path, channel: Option<&str>) -> Result<Self> {
        Self::connect(directory, channel, true)
    }

    pub fn open(directory: &Path, channel: Option<&str>) -> Result<Self> {
        Self::connect(directory, channel, false)
    }

    fn connect(directory: &Path, channel: Option<&str>, create: bool) -> Result<Self> {
        if !directory.exists() {
            fs::create_dir_all(directory)?;

            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        }

        let meta = fs::symlink_metadata(directory)?;

        if !meta.is_dir() || meta.file_type().is_symlink() {
            return fail("ERR_STATE_DATABASE_PATH");
        }

        let filename = directory.join("state.sqlite3");

        let exists = fs::symlink_metadata(&filename).is_ok();

        if create && exists {
            return fail("ERR_STATE_ALREADY_INITIALIZED");
        }

        if !create && !exists {
            return fail("ERR_STATE_DATABASE_ABSENT");
        }

        if create {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&filename)?;
        } else {
            let m = fs::symlink_metadata(&filename)?;

            if !m.is_file() || m.file_type().is_symlink() {
                return fail("ERR_STATE_DATABASE_PATH");
            }

            if m.permissions().mode() & 0o777 != 0o600 {
                return fail("ERR_STATE_DATABASE_MODE");
            }
        }

        let opened = (|| -> Result<Self> {
            let connection = Connection::open_with_flags(
                &filename,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                    | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
            )?;

            connection.busy_timeout(std::time::Duration::from_secs(5))?;

            if rusqlite::version_number() < 3_051_003 {
                return fail("ERR_STATE_DATABASE_SQLITE_VERSION");
            }

            let app: i64 = connection.pragma_query_value(None, "application_id", |r| r.get(0))?;

            let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;

            if !create && app != APPLICATION_ID {
                return fail("ERR_STATE_DATABASE_APPLICATION_ID");
            }

            if !create && version == 0 {
                return fail("ERR_STATE_DATABASE_SCHEMA_MISSING");
            }

            if version > 6 {
                return fail("ERR_STATE_DATABASE_SCHEMA_NEWER");
            }

            let channel = channel.filter(|s| !s.is_empty());

            if !create {
                let binding:Option<(String,Option<String>)>=connection.query_row("SELECT list_url_template,channel_id FROM application_metadata WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;

                match binding {
                    None => return fail("ERR_STATE_DATABASE_METADATA"),
                    Some((template, c)) if template != TEMPLATE || c.as_deref() != channel => {
                        return fail("ERR_STATE_DATABASE_TARGET");
                    }

                    _ => (),
                }
            }

            if create {
                connection.pragma_update(None, "application_id", APPLICATION_ID)?;
            }

            let journal: String =
                connection.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;

            if journal != "wal" {
                return fail("ERR_STATE_DATABASE_JOURNAL_MODE");
            }

            connection.execute_batch(
                "PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
            )?;

            let db = Self {
                connection,
                filename: filename.clone(),
                history: std::cell::RefCell::new(History::default()),
            };

            db.migrate(version)?;

            if create {
                let id: String =
                    db.connection
                        .query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;

                db.connection.execute("INSERT INTO application_metadata(singleton,database_id,list_url_template,channel_id,created_at) VALUES(1,?,?,?,?)",params![id,TEMPLATE,channel,now_iso()])?;

                db.connection.execute(
                    "INSERT INTO telegram_state(singleton,update_offset) VALUES(1,0)",
                    [],
                )?;
            }

            let pending: bool = db.connection.query_row(
                "SELECT compaction_pending=1 FROM application_metadata WHERE singleton=1",
                [],
                |r| r.get(0),
            )?;

            if pending {
                db.connection.execute_batch("VACUUM; UPDATE application_metadata SET compaction_pending=0 WHERE singleton=1;")?;
            }

            db.validate()?;

            Ok(db)
        })();

        if opened.is_err() && create {
            for suffix in ["", "-wal", "-shm"] {
                let _ = fs::remove_file(format!("{}{suffix}", filename.display()));
            }
        }

        opened
    }

    pub fn transaction<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        self.transaction_named("repository", f)
    }

    pub fn transaction_named<T>(
        &self,
        operation: &str,
        f: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        let started = std::time::Instant::now();

        let before = self.connection.total_changes();

        let result: Result<T> = (|| {
            self.connection.execute_batch("BEGIN IMMEDIATE")?;

            let result = f(&self.connection).and_then(|v| {
                self.connection.execute_batch("COMMIT")?;

                Ok(v)
            });

            if result.is_err() {
                let _ = self.connection.execute_batch("ROLLBACK");
            }

            result
        })();

        let completed = result.is_ok();

        let outcome = if completed { "completed" } else { "failed" };

        let mut metric = json!({
            "event": format!("state.transaction.{outcome}"),
            "timestamp": now_iso(),
            "severity": if completed { "info" } else { "error" },
            "environment": std::env::var("NODE_ENV").unwrap_or_else(|_| "development".into()),
            "applicationVersion": "1.0.0",
            "message": "State database transaction",
            "component": "storage",
            "operation": operation,
            "rowsChanged": if completed { self.connection.total_changes().saturating_sub(before) } else { 0 },
            "durationMs": started.elapsed().as_secs_f64() * 1000.0,
            "databaseBytes": fs::metadata(&self.filename).map(|m|m.len()).unwrap_or(0),
            "walBytes": fs::metadata(format!("{}-wal",self.filename.display())).map(|m|m.len()).unwrap_or(0),
            "schemaVersion": 6,
            "outcome": outcome
        });
        if let Err(error) = &result {
            let mut code = "ERR_STATE_DATABASE_OPERATION";
            if let Some(rusqlite::Error::SqliteFailure(sqlite, _)) =
                error.downcast_ref::<rusqlite::Error>()
            {
                metric["sqliteResultCode"] = json!(sqlite.extended_code);
                code = match sqlite.extended_code & 0xff {
                    5 => "ERR_STATE_DATABASE_BUSY",
                    19 => "ERR_STATE_DATABASE_CONSTRAINT",
                    _ => code,
                };
            }
            metric["errorCode"] = json!(code);
        }

        use std::io::Write;

        let _ = writeln!(std::io::stderr().lock(), "{metric}");

        result
    }

    fn migrate(&self, version: i64) -> Result<()> {
        if version == 6 {
            return Ok(());
        }

        self.transaction_named("schema_migrate",|c|{

  for v in version+1..=6 {
match v {

   1=>c.execute_batch(include_str!("storage/v1.sql"))?,2=>c.execute_batch(include_str!("storage/v2.sql"))?,
   3=>{
c.execute_batch(include_str!("storage/v3-0.sql"))?;
let order:Option<String>=c.query_row("SELECT apartment_order_json FROM crawl_state WHERE singleton=1",[],|r|r.get(0)).optional()?;
let order:Vec<String>=serde_json::from_str(order.as_deref().unwrap_or("[]"))?;
let mut stmt=c.prepare("SELECT item_id,payload_json FROM apartments")?;
let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
let positions:std::collections::HashMap<_,_>=order.iter().enumerate().map(|(i,s)|(s,i)).collect();
if positions.len()!=rows.len()||order.len()!=rows.len(){
return fail("Apartment order must contain every apartment exactly once");
}
for(id,payload)in rows{
let pos=positions.get(&id).ok_or("Apartment order is missing an item")?;
let p:Value=serde_json::from_str(&payload)?;
let(bucket,key)=date_index(p["date"].as_str());
c.execute("UPDATE apartments SET kind=?,date_bucket=?,posting_date_key=?,posting_date=?,encounter_position=?,last_seen_at=? WHERE item_id=?",params![kind(&p),bucket,key,p["date"].as_str(),*pos as i64,p["lastSeenAt"].as_str(),id])?;
}
c.execute_batch(include_str!("storage/v3-1.sql"))?;
}
,
   4=>{
c.execute_batch(include_str!("storage/v4.sql"))?;
{
let mut stmt=c.prepare("SELECT recipient_id,item_id,status,decided_at FROM private_delivery_decisions")?;
let mut rows=stmt.query([])?;
while let Some(row)=rows.next()?{
let status:String=row.get(2)?;
let code=match status.as_str(){
"notified"=>0,"skipped"=>1,"filtered"=>2,_=>return fail("Invalid private decision")}
;
let timestamp:String=row.get(3)?;
c.execute("INSERT INTO private_delivery_decisions_compact VALUES(?,?,?,?)",params![row.get::<_,String>(0)?,row.get::<_,String>(1)?,code,iso_milliseconds(&timestamp)?])?;
}
}
c.execute_batch("DROP TABLE private_delivery_decisions; ALTER TABLE private_delivery_decisions_compact RENAME TO private_delivery_decisions; ALTER TABLE application_metadata ADD COLUMN compaction_pending INTEGER NOT NULL DEFAULT 1 CHECK(compaction_pending IN (0,1));")?;
}
,
   5=>c.execute_batch(include_str!("storage/v5-0.sql"))?,6=>c.execute_batch(include_str!("storage/v6-0.sql"))?,_=>unreachable!()}

   c.execute("INSERT INTO schema_migrations VALUES(?,?,?)",params![v,now_iso(),std::env::var("SOURCE_REVISION").unwrap_or_else(|_|"development".into())])?;
c.pragma_update(None,"user_version",v)?;

  }
 if c.prepare("PRAGMA foreign_key_check")?.exists([])?{
return fail("ERR_STATE_DATABASE_FOREIGN_KEYS");
}
Ok(())}
)
    }

    pub fn checkpoint(&self) -> Result<()> {
        let busy: i64 = self
            .connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))?;

        if busy != 0 {
            return fail("ERR_STATE_DATABASE_CHECKPOINT_BUSY");
        }

        Ok(())
    }

    pub fn validate(&self) -> Result<Value> {
        let results = self
            .connection
            .prepare("PRAGMA integrity_check")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        if results != ["ok"] {
            return fail("ERR_STATE_DATABASE_INTEGRITY");
        }

        if self
            .connection
            .prepare("PRAGMA foreign_key_check")?
            .exists([])?
        {
            return fail("ERR_STATE_DATABASE_FOREIGN_KEYS");
        }

        let mut summary = json!({
        "present":true,"applicationId":APPLICATION_ID,"userVersion":6}
        );

        for (key, table) in [
            ("apartments", "apartments"),
            ("privateRecipients", "private_recipients"),
            ("privateDecisions", "private_delivery_decisions"),
            ("channelDeliveries", "channel_deliveries"),
            ("telegramUsers", "telegram_users"),
            ("exchangeRateSnapshots", "exchange_rate_state"),
        ] {
            summary[key] = json!(self.connection.query_row(
                &format!("SELECT count(*) FROM {table}"),
                [],
                |r| r.get::<_, i64>(0)
            )?);
        }

        let(id,template,channel):(String,String,Option<String>)=self.connection.query_row("SELECT database_id,list_url_template,channel_id FROM application_metadata WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;

        summary["databaseId"] = json!(id);

        summary["listUrlTemplate"] = json!(template);

        summary["channelId"] = json!(channel);

        summary["updateOffset"] = self.load_telegram()?["updateOffset"].clone();

        Ok(json!({
        "database":summary}
        ))
    }
}

fn kind(p: &Value) -> &str {
    if p["kind"] == "house" {
        "house"
    } else {
        "apartment"
    }
}

fn identifier(v: &Value) -> Result<String> {
    match v {
        Value::String(s) if !s.is_empty() => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        _ => fail("Identifier must be nonempty"),
    }
}

fn safe_id(v: &Value, positive: bool) -> Result<i64> {
    let n = v.as_i64().ok_or("ID must be an integer")?;

    if n < i64::from(positive) || n > 9_007_199_254_740_991 {
        return fail("ID must be a safe integer");
    }

    Ok(n)
}

fn object(v: &Value) -> Result<&serde_json::Map<String, Value>> {
    v.as_object().ok_or_else(|| "Expected JSON object".into())
}

fn canonical(v: &Value) -> Result<&str> {
    let s = v.as_str().ok_or("Expected canonical timestamp")?;

    iso_milliseconds(s)?;

    Ok(s)
}

fn checked_user(v: &Value) -> Result<()> {
    safe_id(&v["chatId"], true)?;

    for key in ["active", "sendInitialApartments"] {
        if !v[key].is_boolean() {
            return fail("Invalid Telegram user boolean");
        }
    }

    if !v["pendingFilterInput"].is_null()
        && v["pendingFilterInput"] != "price"
        && v["pendingFilterInput"] != "rooms"
    {
        return fail("Invalid pending filter input");
    }

    if let Some(at) = v.get("deletionPendingAt") {
        canonical(at)?;

        if v["active"] != false || !v["pendingFilterInput"].is_null() {
            return fail("Invalid pending deletion");
        }
    }

    let f = object(&v["filters"])?;

    if f.len() != 4
        || !["kinds", "price", "rooms", "locations"]
            .iter()
            .all(|k| f.contains_key(*k))
    {
        return fail("Invalid stored filter keys");
    }

    let normalized = super::filters::normalize_filters(&v["filters"]);

    for key in ["price", "rooms"] {
        let range = object(&f[key])?;

        if range.len() != 2 || !range.contains_key("min") || !range.contains_key("max") {
            return fail("Invalid stored range");
        }

        for bound in ["min", "max"] {
            let b = &range[bound];

            if b.is_null() != normalized[key][bound].is_null()
                || b.as_f64() != normalized[key][bound].as_f64()
            {
                return fail("Invalid stored range bound");
            }
        }
    }

    if f["kinds"] != normalized["kinds"] || f["locations"] != normalized["locations"] {
        return fail("Invalid stored filter selections");
    }

    Ok(())
}

impl Database {
    pub fn load_user(&self, id: i64) -> Result<Option<Value>> {
        let mut statement=self.connection.prepare_cached("SELECT chat_id,active,send_initial_apartments,filters_json,pending_filter_input,deletion_pending_at FROM telegram_users WHERE chat_id=?")?;
        let mut rows = statement.query([id])?;
        rows.next()?.map(read_user).transpose()
    }

    pub fn update_offset_value(&self) -> Result<i64> {
        let offset = self.connection.query_row(
            "SELECT update_offset FROM telegram_state WHERE singleton=1",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        safe_id(&json!(offset), false)?;
        Ok(offset)
    }

    pub fn pending_deletions(&self) -> Result<Vec<i64>> {
        let mut statement=self.connection.prepare_cached("SELECT chat_id FROM telegram_users WHERE deletion_pending_at IS NOT NULL ORDER BY chat_id")?;
        Ok(statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn load_telegram(&self) -> Result<Value> {
        let (offset, legacy): (i64, Option<i64>) = self.connection.query_row(
            "SELECT update_offset,legacy_recipient_id FROM telegram_state WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        safe_id(&json!(offset), false)?;

        let mut users = serde_json::Map::new();

        let mut stmt=self.connection.prepare("SELECT chat_id,active,send_initial_apartments,filters_json,pending_filter_input,deletion_pending_at FROM telegram_users ORDER BY chat_id")?;

        let mut rows = stmt.query([])?;

        while let Some(r) = rows.next()? {
            let user = read_user(r)?;
            users.insert(user["chatId"].as_i64().unwrap().to_string(), user);
        }

        let mut state = json!({
        "version":3,"type":"telegram-bot","updateOffset":offset,"users":users}
        );

        if let Some(id) = legacy {
            safe_id(&json!(id), true)?;

            state["legacyRecipientId"] = json!(id.to_string());
        }

        Ok(state)
    }

    fn write_user(c: &Connection, user: &Value) -> Result<()> {
        checked_user(user)?;

        c.execute("INSERT INTO telegram_users(chat_id,active,send_initial_apartments,filters_json,pending_filter_input,deletion_pending_at) VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET active=excluded.active,send_initial_apartments=excluded.send_initial_apartments,filters_json=excluded.filters_json,pending_filter_input=excluded.pending_filter_input,deletion_pending_at=excluded.deletion_pending_at",params![user["chatId"].as_i64(),user["active"].as_bool(),user["sendInitialApartments"].as_bool(),serde_json::to_string(&user["filters"])?,user["pendingFilterInput"].as_str(),user["deletionPendingAt"].as_str()])?;

        Ok(())
    }

    pub fn save_telegram(&self, state: &Value) -> Result<()> {
        if state["version"] != 3 || state["type"] != "telegram-bot" {
            return fail("Invalid Telegram state");
        }

        let offset = safe_id(&state["updateOffset"], false)?;

        let users = object(&state["users"])?;

        for (key, user) in users {
            checked_user(user)?;

            if user["chatId"].as_i64().unwrap().to_string() != *key {
                return fail("Telegram user key mismatch");
            }
        }

        let previous = self.load_telegram()?;

        if previous.get("legacyRecipientId") != state.get("legacyRecipientId") {
            return fail("Legacy recipient identity may change only during migration or deletion");
        }

        let old = object(&previous["users"])?;

        let keys: std::collections::BTreeSet<_> = old.keys().chain(users.keys()).collect();

        let changed: Vec<_> = keys
            .into_iter()
            .filter(|k| old.get(*k) != users.get(*k))
            .collect();

        if changed.len() > 1 {
            return fail("One Telegram state commit may mutate at most one user");
        }

        self.transaction_named("telegram_update_commit", |c| {
            if let Some(key) = changed.first() {
                if let Some(user) = users.get(*key) {
                    Self::write_user(c, user)?;
                } else {
                    c.execute(
                        "DELETE FROM telegram_users WHERE chat_id=?",
                        params![key.parse::<i64>()?],
                    )?;
                }
            }

            c.execute(
                "UPDATE telegram_state SET update_offset=? WHERE singleton=1",
                [offset],
            )?;

            Ok(())
        })
    }

    pub fn save_user(&self, user: &Value) -> Result<()> {
        self.transaction_named("telegram_user_save", |c| Self::write_user(c, user))
    }

    pub fn update_offset(&self, offset: i64) -> Result<()> {
        safe_id(&json!(offset), false)?;

        self.transaction_named("telegram_update_offset", |c| {
            c.execute(
                "UPDATE telegram_state SET update_offset=? WHERE singleton=1",
                [offset],
            )?;

            Ok(())
        })
    }

    pub fn delete_user_data(&self, id: i64) -> Result<Value> {
        safe_id(&json!(id), true)?;

        self.transaction_named("telegram_user_data_delete",|c|{
if c.prepare("SELECT 1 FROM sqlite_temp_schema WHERE name='private_delivery_batch'")?.exists([])?{
c.execute("DELETE FROM private_delivery_batch WHERE recipient_id=?",[id.to_string()])?;
}
let recipient=c.execute("DELETE FROM private_recipients WHERE recipient_id=?",[id.to_string()])?;
let user=c.execute("DELETE FROM telegram_users WHERE chat_id=?",[id])?;
c.execute("UPDATE telegram_state SET legacy_recipient_id=NULL WHERE singleton=1 AND legacy_recipient_id=?",[id])?;
Ok(json!({
"userDeleted":user,"recipientDeleted":recipient}
))}
)
    }

    pub fn exchange_rates(&self) -> Result<Option<Value>> {
        let raw: Option<String> = self
            .connection
            .query_row(
                "SELECT snapshot_json FROM exchange_rate_state WHERE singleton=1",
                [],
                |r| r.get(0),
            )
            .optional()?;

        raw.map(|s| {
            let v = serde_json::from_str(&s)?;

            validate_rates(&v)?;

            Ok(v)
        })
        .transpose()
    }

    pub fn save_exchange_rates(&self, value: &Value) -> Result<()> {
        validate_rates(value)?;

        self.transaction_named("exchange_rates_save",|c|{
c.execute("INSERT INTO exchange_rate_state VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET snapshot_json=excluded.snapshot_json",[serde_json::to_string(value)?])?;
Ok(())}
)
    }

    pub fn find_encountered(&self, ids: &[String]) -> Result<Value> {
        let mut out = serde_json::Map::new();

        let mut stmt=self.connection.prepare("SELECT item_id,payload_json,last_seen_at FROM apartments WHERE item_id IN (SELECT value FROM json_each(?))")?;

        let mut rows = stmt.query([serde_json::to_string(ids)?])?;

        while let Some(r) = rows.next()? {
            let id: String = r.get(0)?;

            out.insert(id, apartment_row(r, 1, 2)?);
        }

        Ok(Value::Object(out))
    }

    pub fn load_apartments(&self) -> Result<Option<Value>> {
        let meta:Option<(String,String,String,i64)>=self.connection.query_row("SELECT checked_at,last_crawl_json,source_integrity_json,total_count FROM crawl_state WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;

        let Some((checked, last, integrity, count)) = meta else {
            return Ok(None);
        };

        iso_milliseconds(&checked)?;

        let integrity: Value = serde_json::from_str(&integrity)?;

        validate_integrity(&integrity)?;

        let mut items = serde_json::Map::new();

        let mut order = vec![];

        let mut stmt=self.connection.prepare("SELECT item_id,payload_json,last_seen_at FROM apartments ORDER BY encounter_sequence DESC,encounter_position ASC")?;

        let mut rows = stmt.query([])?;

        while let Some(r) = rows.next()? {
            let id: String = r.get(0)?;

            let v = apartment_row(r, 1, 2)?;

            if identifier(&v["itemId"])? != id {
                return fail("Apartment payload item ID mismatch");
            }

            order.push(id.clone());

            items.insert(id, v);
        }

        if count != order.len() as i64 {
            return fail("Apartment count does not match crawl metadata");
        }

        Ok(Some(json!({
        "version":4,"type":"list-am-apartments","urlTemplate":TEMPLATE,"checkedAt":checked,"lastCrawl":serde_json::from_str::<Value>(&last)?,"sourceIntegrity":integrity,"apartments":items,"apartmentOrder":order}
        )))
    }

    pub fn commit_crawl(&self, crawl: &Value) -> Result<i64> {
        let checked = canonical(&crawl["checkedAt"])?;

        let changes = crawl["changes"]
            .as_array()
            .ok_or("Crawl changes must be array")?;

        let order = crawl["encounteredOrder"]
            .as_array()
            .ok_or("Crawl encounter order must be array")?;

        let ids = order.iter().map(identifier).collect::<Result<Vec<_>>>()?;

        if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() {
            return fail("Encounter order must contain unique IDs");
        }

        validate_integrity(&crawl["sourceIntegrity"])?;

        object(&crawl["lastCrawl"])?;

        self.transaction_named("crawl_commit",|c|{
let(seq,mut count):(i64,i64)=c.query_row("SELECT sequence,total_count FROM crawl_state WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.unwrap_or((0,0));
let seq=seq+1;
for p in changes{
object(p)?;
let id=identifier(&p["itemId"])?;
let exists=c.query_row("SELECT 1 FROM apartments WHERE item_id=?",[&id],|r|r.get::<_,i64>(0)).optional()?.is_some();
if !exists{
count+=1;
}
let(bucket,key)=date_index(p["date"].as_str());
c.execute("INSERT INTO apartments(item_id,payload_json,kind,date_bucket,posting_date_key,posting_date,changed_sequence) VALUES(?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET payload_json=excluded.payload_json,kind=excluded.kind,date_bucket=excluded.date_bucket,posting_date_key=excluded.posting_date_key,posting_date=excluded.posting_date,changed_sequence=excluded.changed_sequence",params![id,serde_json::to_string(p)?,kind(p),bucket,key,p["date"].as_str(),seq])?;
}

 for(pos,id)in ids.iter().enumerate(){
if c.execute("UPDATE apartments SET encounter_sequence=?,encounter_position=?,last_seen_at=? WHERE item_id=?",params![seq,pos as i64,checked,id])?!=1{
return fail("Encounter must name a retained listing");
}
}

 c.execute("INSERT INTO crawl_state(singleton,checked_at,last_crawl_json,source_integrity_json,sequence,total_count) VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET checked_at=excluded.checked_at,last_crawl_json=excluded.last_crawl_json,source_integrity_json=excluded.source_integrity_json,sequence=excluded.sequence,total_count=excluded.total_count",params![checked,serde_json::to_string(&crawl["lastCrawl"])?,serde_json::to_string(&crawl["sourceIntegrity"])?,seq,count])?;
Ok(count)}
)
    }
}

fn apartment_row(r: &rusqlite::Row<'_>, payload: usize, last: usize) -> Result<Value> {
    let mut p: Value = serde_json::from_str(&r.get::<_, String>(payload)?)?;

    object(&p)?;

    if let Some(at) = r.get::<_, Option<String>>(last)? {
        p["lastSeenAt"] = json!(at);
    }

    Ok(p)
}

fn validate_integrity(v: &Value) -> Result<()> {
    let o = object(v)?;

    if o.keys()
        .any(|k| k != "recentFirstPageCounts" && k != "lastSuccessfulAt")
    {
        return fail("Invalid source integrity keys");
    }

    if let Some(at) = o.get("lastSuccessfulAt") {
        canonical(at)?;
    }

    for (k, v) in object(&v["recentFirstPageCounts"])? {
        if k != "apartment" && k != "house" {
            return fail("Invalid source integrity kind");
        }

        let counts = v.as_array().ok_or("Invalid source integrity history")?;

        if counts.len() > 5 {
            return fail("Source integrity history exceeds limit");
        }

        for count in counts {
            safe_id(count, false)?;
        }
    }

    Ok(())
}

fn validate_rates(v: &Value) -> Result<()> {
    if v["version"] != 1 || v["type"] != "cba-exchange-rates" || v["baseCurrency"] != "AMD" {
        return fail("Invalid exchange-rate snapshot");
    }

    let date = v["effectiveDate"]
        .as_str()
        .ok_or("Invalid effective date")?;

    if date.len() != 10
        || date.as_bytes()[4] != b'-'
        || date.as_bytes()[7] != b'-'
        || !date
            .chars()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return fail("Invalid effective date");
    }

    chrono::DateTime::parse_from_rfc3339(
        v["fetchedAt"].as_str().ok_or("Invalid fetched timestamp")?,
    )?;

    for code in ["USD", "EUR", "RUB"] {
        for key in ["amount", "rate"] {
            if v["rates"][code][key]
                .as_f64()
                .is_none_or(|n| !n.is_finite() || n <= 0.)
            {
                return fail("Invalid exchange-rate quote");
            }
        }
    }

    Ok(())
}

fn date_index(date: Option<&str>) -> (String, Option<i64>) {
    let value = super::source::posting_date_index(
        date.unwrap_or(""),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64,
    );

    (
        value["bucket"].as_str().unwrap_or("fixed").to_string(),
        value["key"].as_i64(),
    )
}

impl Database {
    pub fn load_recipient(&self, id: &str, ids: &[String]) -> Result<Option<Value>> {
        let initial: Option<bool> = self
            .connection
            .query_row(
                "SELECT initial_selection_applied FROM private_recipients WHERE recipient_id=?",
                [id],
                |r| r.get(0),
            )
            .optional()?;

        let Some(initial) = initial else {
            return Ok(None);
        };

        let mut value = json!({
        "notified":{
        }
        ,"skipped":{
        }
        ,"filtered":{
        }
        ,"initialSelectionApplied":initial}
        );

        let mut stmt=self.connection.prepare("SELECT item_id,status,decided_at FROM private_delivery_decisions WHERE recipient_id=? AND item_id IN (SELECT value FROM json_each(?)) ORDER BY item_id")?;

        let mut rows = stmt.query(params![id, serde_json::to_string(ids)?])?;

        while let Some(r) = rows.next()? {
            let item: String = r.get(0)?;

            let status: i64 = r.get(1)?;

            let key = match status {
                0 => "notified",
                1 => "skipped",
                2 => "filtered",
                _ => return fail("ERR_STATE_DATABASE_DOMAIN_INVALID"),
            };

            value[key][item] = json!(iso_timestamp(r.get(2)?)?);
        }

        Ok(Some(value))
    }

    pub fn request_selection(&self, id: &str) -> Result<()> {
        if id.is_empty() {
            return fail("Recipient ID must be nonempty");
        }

        self.transaction_named("private_selection_request",|c|{
c.execute("INSERT INTO private_recipients(recipient_id,initial_selection_applied) VALUES(?,0) ON CONFLICT(recipient_id) DO UPDATE SET initial_selection_applied=0",[id])?;
Ok(())}
)
    }

    pub fn initialize_selection(&self, id: &str, selection: &Value) -> Result<usize> {
        if id.is_empty() {
            return fail("Recipient ID must be nonempty");
        }

        let mut decisions = vec![];

        let mut seen = std::collections::HashSet::new();

        for (status, key) in [(1, "skipped"), (2, "filtered")] {
            if let Some(v) = selection.get(key) {
                for (item, at) in object(v)? {
                    if item.is_empty() || !seen.insert(item.clone()) {
                        return fail("Initial private delivery statuses cannot overlap");
                    }

                    decisions.push((item.clone(), status, iso_milliseconds(canonical(at)?)?));
                }
            }
        }

        let released = selection
            .get("released")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut ids = vec![];

        for v in released {
            let item = identifier(&v)?;

            if seen.contains(&item) {
                return fail("Released apartment cannot also be classified");
            }

            ids.push(item);
        }

        self.transaction_named("private_delivery_initialize",|c|{
c.execute("INSERT INTO private_recipients(recipient_id,initial_selection_applied) VALUES(?,1) ON CONFLICT(recipient_id) DO UPDATE SET initial_selection_applied=1",[id])?;
for item in &ids{
c.execute("DELETE FROM private_delivery_decisions WHERE recipient_id=? AND item_id=? AND status=2",params![id,item])?;
}
for(item,status,at)in &decisions{
c.execute("INSERT INTO private_delivery_decisions VALUES(?,?,?,?) ON CONFLICT(recipient_id,item_id) DO UPDATE SET status=excluded.status,decided_at=excluded.decided_at",params![id,item,status,at])?;
}
Ok(decisions.len()+ids.len())}
)
    }

    pub fn acknowledge_private(&self, id: &str, item: &str, at: &str) -> Result<()> {
        let ms = iso_milliseconds(at)?;

        if id.is_empty() || item.is_empty() {
            return fail("Nonempty delivery IDs required");
        }

        self.transaction_named("private_delivery_acknowledge",|c|{
ensure_recipient(c,id)?;
c.execute("INSERT INTO private_delivery_decisions VALUES(?,?,0,?) ON CONFLICT(recipient_id,item_id) DO UPDATE SET status=0,decided_at=excluded.decided_at",params![id,item,ms])?;
Ok(())}
)
    }

    pub fn classify_private(&self, id: &str, status: &str, decisions: &Value) -> Result<usize> {
        let code = match status {
            "skipped" => 1,
            "filtered" => 2,
            _ => return fail("Unsupported private delivery status"),
        };

        let entries = object(decisions)?
            .iter()
            .map(|(k, v)| Ok((k, iso_milliseconds(canonical(v)?)?)))
            .collect::<Result<Vec<_>>>()?;

        self.transaction_named("private_delivery_classify", |c| {
            ensure_recipient(c, id)?;

            for (item, at) in &entries {
                c.execute(
                    "INSERT INTO private_delivery_decisions VALUES(?,?,?,?)",
                    params![id, item, code, at],
                )?;
            }

            Ok(entries.len())
        })
    }

    pub fn remove_filtered_decision(&self, id: &str, item: &str) -> Result<usize> {
        self.transaction_named("private_delivery_readmit",|c|{
let n=c.execute("DELETE FROM private_delivery_decisions WHERE recipient_id=? AND item_id=? AND status=2",params![id,item])?;
if n>0{
c.execute("INSERT OR REPLACE INTO private_delivery_work(recipient_id,item_id) VALUES(?,?)",params![id,item])?;
}
Ok(n)}
)
    }

    pub fn decline_history(&self, id: &str, decisions: &Value) -> Result<usize> {
        let entries = object(decisions)?
            .iter()
            .map(|(k, v)| Ok((k, iso_milliseconds(canonical(v)?)?)))
            .collect::<Result<Vec<_>>>()?;

        self.transaction_named("private_delivery_decline",|c|{
ensure_recipient(c,id)?;
for(item,at)in &entries{
c.execute("INSERT INTO private_delivery_decisions VALUES(?,?,1,?) ON CONFLICT(recipient_id,item_id) DO UPDATE SET status=1,decided_at=excluded.decided_at",params![id,item,at])?;
}
Ok(entries.len())}
)
    }

    pub fn load_private_candidates(&self, id: &str, filters: &Value) -> Result<Value> {
        let normalized = super::filters::normalize_filters(filters);

        let filters = &normalized;

        let fingerprint = filter_fingerprint(filters)?;

        self.transaction_named("private_delivery_prepare",|c|{
ensure_recipient(c,id)?;
let(initial,cursor,stored):(bool,Option<i64>,Option<String>)=c.query_row("SELECT initial_selection_applied,source_cursor,filter_fingerprint FROM private_recipients WHERE recipient_id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
let seq:i64=c.query_row("SELECT sequence FROM crawl_state WHERE singleton=1",[],|r|r.get(0)).optional()?.unwrap_or(0);
if cursor.is_none()||!initial||stored.as_deref()!=Some(&fingerprint){
let (matching,updated)=self.matching_history(seq,&fingerprint,filters)?;
c.execute("INSERT OR IGNORE INTO private_delivery_work(recipient_id,item_id) SELECT ?,a.item_id FROM apartments a LEFT JOIN private_delivery_decisions d ON d.recipient_id=? AND d.item_id=a.item_id WHERE d.item_id IS NULL OR (d.status=2 AND a.item_id IN (SELECT value FROM json_each(?))) OR (d.status=0 AND a.item_id IN (SELECT value FROM json_each(?)))",params![id,id,matching,updated])?;
}
else if cursor.is_some_and(|value| value < seq){
c.execute("INSERT OR IGNORE INTO private_delivery_work(recipient_id,item_id) SELECT ?,item_id FROM apartments WHERE changed_sequence>?",params![id,cursor])?;
}
if cursor!=Some(seq)||stored.as_deref()!=Some(&fingerprint){
c.execute("UPDATE private_recipients SET source_cursor=?,filter_fingerprint=? WHERE recipient_id=?",params![seq,fingerprint,id])?;
}
let mut items=serde_json::Map::new();
let mut order=vec![];
let mut work=vec![];
let mut stmt=c.prepare("SELECT w.work_id,a.item_id,a.payload_json,a.last_seen_at FROM private_delivery_work w JOIN apartments a ON a.item_id=w.item_id WHERE w.recipient_id=? ORDER BY a.encounter_sequence DESC,a.encounter_position ASC")?;
let mut rows=stmt.query([id])?;
while let Some(r)=rows.next()?{
let item:String=r.get(1)?;
order.push(item.clone());
work.push(r.get::<_,i64>(0)?);
items.insert(item,apartment_row(r,2,3)?);
}
let any=c.prepare("SELECT 1 FROM apartments LIMIT 1")?.exists([])?;
Ok(json!({
"apartments":items,"apartmentOrder":order,"workIds":work,"hasStoredApartments":any}
))}
)
    }

    pub fn retain_pending(&self, id: &str, items: &[String], work: &[i64]) -> Result<usize> {
        for n in work {
            safe_id(&json!(n), true)?;
        }

        self.transaction_named("private_delivery_pending",|c|Ok(c.execute("DELETE FROM private_delivery_work WHERE recipient_id=? AND work_id IN (SELECT value FROM json_each(?)) AND item_id NOT IN (SELECT value FROM json_each(?))",params![id,serde_json::to_string(work)?,serde_json::to_string(items)?])?))
    }

    pub fn prepare_batch(&self, id: &str, items: &Value) -> Result<()> {
        let items = items.as_array().ok_or("Batch must be array")?;

        self.connection.execute_batch("CREATE TEMP TABLE IF NOT EXISTS private_delivery_batch(recipient_id TEXT NOT NULL,position INTEGER NOT NULL,item_id TEXT NOT NULL,work_id INTEGER,PRIMARY KEY(recipient_id,position)) WITHOUT ROWID;")?;

        self.transaction_named("private_delivery_batch", |c| {
            c.execute(
                "DELETE FROM private_delivery_batch WHERE recipient_id=?",
                [id],
            )?;

            for (pos, item) in items.iter().enumerate() {
                c.execute(
                    "INSERT INTO private_delivery_batch VALUES(?,?,?,?)",
                    params![
                        id,
                        pos as i64,
                        identifier(&item["itemId"])?,
                        item["workId"].as_i64()
                    ],
                )?;
            }

            Ok(())
        })
    }

    pub fn next_batch_item(&self, id: &str) -> Result<Option<Value>> {
        let mut stmt=self.connection.prepare("SELECT b.position,b.work_id,a.payload_json,a.last_seen_at FROM private_delivery_batch b JOIN apartments a ON a.item_id=b.item_id WHERE b.recipient_id=? ORDER BY b.position LIMIT 1")?;

        let mut rows = stmt.query([id])?;

        if let Some(r) = rows.next()? {
            Ok(Some(json!({
            "position":r.get::<_,i64>(0)?,"workId":r.get::<_,Option<i64>>(1)?,"apartment":apartment_row(r,2,3)?}
            )))
        } else {
            Ok(None)
        }
    }

    pub fn acknowledge_batch_item(&self, id: &str, item: &Value, at: &str) -> Result<()> {
        let ms = iso_milliseconds(at)?;

        let listing = identifier(&item["apartment"]["itemId"])?;

        self.transaction_named("private_delivery_acknowledge",|c|{
ensure_recipient(c,id)?;
c.execute("INSERT INTO private_delivery_decisions VALUES(?,?,0,?) ON CONFLICT(recipient_id,item_id) DO UPDATE SET status=0,decided_at=excluded.decided_at",params![id,listing,ms])?;
c.execute("DELETE FROM private_delivery_work WHERE recipient_id=? AND work_id=?",params![id,item["workId"].as_i64()])?;
c.execute("DELETE FROM private_delivery_batch WHERE recipient_id=? AND position=?",params![id,item["position"].as_i64()])?;
Ok(())}
)
    }
}

fn ensure_recipient(c: &Connection, id: &str) -> Result<()> {
    if id.is_empty() {
        return fail("Recipient ID must be nonempty");
    }

    c.execute("INSERT INTO private_recipients(recipient_id,initial_selection_applied) VALUES(?,0) ON CONFLICT(recipient_id) DO NOTHING",[id])?;

    Ok(())
}

impl Database {
    fn matching_history(
        &self,
        sequence: i64,
        fingerprint: &str,
        filters: &Value,
    ) -> Result<(String, String)> {
        let mut history = self.history.borrow_mut();

        if history.sequence != Some(sequence) {
            let mut stmt = self
                .connection
                .prepare("SELECT payload_json,last_seen_at,item_id,json_extract(payload_json,'$.updatedAt') IS NOT NULL FROM apartments")?;

            let mut rows = stmt.query([])?;

            let mut apartments = vec![];
            let mut updated_ids: Vec<String> = vec![];

            while let Some(row) = rows.next()? {
                apartments.push(apartment_row(row, 0, 1)?);
                // Preserve SQLite's exact missing/null predicate while parsing once per crawl.
                if row.get::<_, bool>(3)? {
                    updated_ids.push(row.get(2)?);
                }
            }

            history.updated_ids = serde_json::to_string(&updated_ids)?;
            history.apartments = apartments;

            history.filters.clear();

            history.sequence = Some(sequence);
        }

        if let Some((_, ids)) = history.filters.iter().find(|(key, _)| key == fingerprint) {
            return Ok((ids.clone(), history.updated_ids.clone()));
        }

        let ids = history
            .apartments
            .iter()
            .filter(|p| super::filters::matches(p, filters))
            .map(|p| identifier(&p["itemId"]))
            .collect::<Result<Vec<_>>>()?;

        let encoded = serde_json::to_string(&ids)?;

        if history.filters.len() == 8 {
            history.filters.pop_front();
        }

        history
            .filters
            .push_back((fingerprint.to_owned(), encoded.clone()));

        Ok((encoded, history.updated_ids.clone()))
    }

    pub fn clear_batches(&self) -> Result<()> {
        self.connection.execute_batch("CREATE TEMP TABLE IF NOT EXISTS private_delivery_batch(recipient_id TEXT NOT NULL,position INTEGER NOT NULL,item_id TEXT NOT NULL,work_id INTEGER,PRIMARY KEY(recipient_id,position)) WITHOUT ROWID; DELETE FROM private_delivery_batch;")?;

        *self.history.borrow_mut() = History::default();

        Ok(())
    }
}

impl Database {
    pub fn find_legacy_prices(&self) -> Result<Vec<Value>> {
        let mut stmt=self.connection.prepare("SELECT payload_json,last_seen_at FROM apartments WHERE json_type(payload_json,'$.price.amountAmd') IS NULL")?;

        let mut rows = stmt.query([])?;

        let mut found = vec![];

        while let Some(row) = rows.next()? {
            found.push(apartment_row(row, 0, 1)?);
        }

        Ok(found)
    }

    pub fn load_crawl(&self, kinds: &[String], reference_ms: i64) -> Result<Value> {
        let metadata:Option<(String,String,String,i64)>=self.connection.query_row("SELECT checked_at,last_crawl_json,source_integrity_json,total_count FROM crawl_state WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;

        let mut value = if let Some((checked, last, integrity, count)) = metadata {
            json!({
            "version":4,"type":"list-am-apartments","urlTemplate":TEMPLATE,"checkedAt":checked,"lastCrawl":serde_json::from_str::<Value>(&last)?,"sourceIntegrity":serde_json::from_str::<Value>(&integrity)?,"totalCount":count}
            )
        } else {
            json!({
            "totalCount":0}
            )
        };

        let cutoff_date = iso_timestamp(reference_ms + 86_400_001)?;

        let offset = if cutoff_date.starts_with(['+', '-']) {
            7
        } else {
            4
        };

        let month: i64 = cutoff_date[offset + 1..offset + 3].parse()?;

        let day: i64 = cutoff_date[offset + 4..offset + 6].parse()?;

        let cutoff = (month - 1) * 32 + day;

        let mut watermarks = serde_json::Map::new();

        for kind in kinds {
            let initial = !self
                .connection
                .prepare("SELECT 1 FROM apartments WHERE kind=? LIMIT 1")?
                .exists([kind])?;

            let mut candidates = vec![];

            for bucket in ["fixed", "relative"] {
                if let Some(date)=self.connection.query_row("SELECT posting_date FROM apartments WHERE kind=? AND date_bucket=? AND posting_date_key IS NOT NULL ORDER BY posting_date_key DESC LIMIT 1",params![kind,bucket],|r|r.get::<_,Option<String>>(0)).optional()?.flatten(){
candidates.push(date);
}
            }

            for (mut upper, lower) in [(cutoff, -1), (400, cutoff)] {
                for _ in 0..2 {
                    let candidate:Option<(String,i64)>=self.connection.query_row("SELECT posting_date,posting_date_key FROM apartments WHERE kind=? AND date_bucket='annual' AND posting_date_key<=? AND posting_date_key>? ORDER BY posting_date_key DESC LIMIT 1",params![kind,upper,lower],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;

                    let Some((date, key)) = candidate else { break };

                    if super::source::posting_date_ms(&date, reference_ms).is_some() {
                        candidates.push(date);

                        break;
                    }

                    upper = key - 1;
                }
            }

            let latest = candidates
                .into_iter()
                .filter_map(|date| {
                    super::source::posting_date_ms(&date, reference_ms).map(|stamp| (date, stamp))
                })
                .max_by_key(|(_, stamp)| *stamp);

            watermarks.insert(
                kind.clone(),
                match latest {
                    Some((date, stamp)) => json!({
                    "initialRun":initial,"date":date,"value":stamp}
                    ),
                    None => json!({
                    "initialRun":initial,"date":null,"value":null}
                    ),
                },
            );
        }

        value["watermarks"] = Value::Object(watermarks);

        Ok(value)
    }
}

impl Database {
    pub fn validate_domains(&self) -> Result<()> {
        self.load_telegram()?;

        self.exchange_rates()?;

        let invalid:i64=self.connection.query_row("SELECT count(*) FROM private_delivery_decisions WHERE typeof(decided_at)<>'integer' OR decided_at NOT BETWEEN -8640000000000000 AND 8640000000000000 OR status NOT IN(0,1,2)",[],|r|r.get(0))?;

        if invalid != 0 {
            return fail("ERR_STATE_DATABASE_DOMAIN_INVALID");
        }

        let metadata:Option<(String,String,i64)>=self.connection.query_row("SELECT checked_at,source_integrity_json,total_count FROM crawl_state WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;

        if let Some((checked, integrity, total)) = metadata {
            iso_milliseconds(&checked)?;

            validate_integrity(&serde_json::from_str(&integrity)?)?;

            let count: i64 =
                self.connection
                    .query_row("SELECT count(*) FROM apartments", [], |r| r.get(0))?;

            if count != total {
                return fail("Apartment count does not match crawl metadata");
            }

            let mut stmt = self
                .connection
                .prepare("SELECT item_id,payload_json FROM apartments")?;

            let mut rows = stmt.query([])?;

            while let Some(r) = rows.next()? {
                let id: String = r.get(0)?;

                let value: Value = serde_json::from_str(&r.get::<_, String>(1)?)?;

                object(&value)?;

                if identifier(&value["itemId"])? != id {
                    return fail("Apartment payload item ID mismatch");
                }
            }
        }

        let bad_channel:i64=self.connection.query_row("SELECT count(*) FROM channel_state c JOIN application_metadata m ON m.singleton=c.singleton WHERE c.channel_id IS NOT m.channel_id OR c.list_url_template<>m.list_url_template OR c.initialized<>1 OR length(c.filter_fingerprint)<>64 OR c.filter_fingerprint GLOB '*[^a-f0-9]*'",[],|r|r.get(0))?;

        if bad_channel != 0 {
            return fail("ERR_STATE_DATABASE_DOMAIN_INVALID");
        }

        let mut stmt=self.connection.prepare("SELECT status,classified_at,reencountered_at,message_id,content_hash,published_at,updated_at FROM channel_deliveries")?;

        let mut rows = stmt.query([])?;

        while let Some(row) = rows.next()? {
            let status: String = row.get(0)?;

            iso_milliseconds(&row.get::<_, String>(1)?)?;

            if let Some(at) = row.get::<_, Option<String>>(2)? {
                iso_milliseconds(&at)?;
            }

            let message: Option<i64> = row.get(3)?;

            let hash: Option<String> = row.get(4)?;

            let published: Option<String> = row.get(5)?;

            let updated: Option<String> = row.get(6)?;

            if status == "published" {
                safe_id(&json!(message), true)?;

                let hash = hash.ok_or("Published channel hash missing")?;

                if hash.len() != 64
                    || !hash
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    return fail("Invalid channel content hash");
                }

                iso_milliseconds(&published.ok_or("Published timestamp missing")?)?;

                if let Some(at) = updated {
                    iso_milliseconds(&at)?;
                }
            } else if !["pending", "filtered", "skipped_initial"].contains(&status.as_str())
                || message.is_some()
                || hash.is_some()
                || published.is_some()
                || updated.is_some()
            {
                return fail("Invalid unpublished channel entry");
            }
        }

        Ok(())
    }
}

fn read_user(row: &rusqlite::Row<'_>) -> Result<Value> {
    let mut filters: Value = serde_json::from_str(&row.get::<_, String>(3)?)?;
    if filters.get("kinds").is_none() {
        filters["kinds"] = json!(["apartment"]);
    }
    let mut user = json!({"chatId":row.get::<_,i64>(0)?,"active":row.get::<_,bool>(1)?,"sendInitialApartments":row.get::<_,bool>(2)?,"filters":filters,"pendingFilterInput":row.get::<_,Option<String>>(4)?});
    if let Some(at) = row.get::<_, Option<String>>(5)? {
        user["deletionPendingAt"] = json!(at);
    }
    checked_user(&user)?;
    Ok(user)
}

fn filter_fingerprint(filters: &Value) -> Result<String> {
    let number = |v: &Value| -> String {
        if let Some(n) = v.as_f64() {
            if n.fract() == 0.0 && n.abs() < 1e21 {
                format!("{n:.0}")
            } else {
                v.to_string()
            }
        } else {
            "null".to_owned()
        }
    };

    Ok(format!(
        "{{\"kinds\":{},\"price\":{{\"min\":{},\"max\":{}}},\"rooms\":{{\"min\":{},\"max\":{}}},\"locations\":{}}}",
        serde_json::to_string(&filters["kinds"])?,
        number(&filters["price"]["min"]),
        number(&filters["price"]["max"]),
        number(&filters["rooms"]["min"]),
        number(&filters["rooms"]["max"]),
        serde_json::to_string(&filters["locations"])?
    ))
}
