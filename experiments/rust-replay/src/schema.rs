//! Version 0 is the exact unversioned #40 schema; version 1 enforces decision domains.
use crate::Result;
use rusqlite::Connection;

pub const VERSION: i64 = 1;
pub const APPLICATION_ID: i64 = 0x5252504c;
pub const LEGACY_DECISIONS: &str = "CREATE TABLE decisions(user INTEGER NOT NULL,id INTEGER NOT NULL,status INTEGER NOT NULL,revision INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(user,id)) WITHOUT ROWID, STRICT";
pub const DECISIONS: &str = "CREATE TABLE decisions(user INTEGER NOT NULL CHECK(user>=0),id INTEGER NOT NULL CHECK(id>=0),status INTEGER NOT NULL CHECK(status BETWEEN 0 AND 3),revision INTEGER NOT NULL CHECK(revision>=1),at INTEGER NOT NULL,PRIMARY KEY(user,id)) WITHOUT ROWID, STRICT";
pub const PENDING: &str = "CREATE INDEX pending ON decisions(user,status,id) WHERE status=0";
const BASE: &str = "CREATE TABLE seed_input(id INTEGER PRIMARY KEY CHECK(id=1),input TEXT NOT NULL) STRICT;
CREATE TABLE seed_progress(id INTEGER PRIMARY KEY CHECK(id=1),next_row INTEGER NOT NULL,consumed INTEGER NOT NULL) STRICT;
CREATE TABLE listings(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL,posted INTEGER NOT NULL) STRICT;
CREATE INDEX recent_revision ON listings(posted,id,revision);";

pub fn version(db: &Connection) -> Result<i64> {
    Ok(db.pragma_query_value(None, "user_version", |r| r.get(0))?)
}
fn objects(db: &Connection) -> Result<Vec<(String, String)>> {
    Ok(db
        .prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}
fn create(db: &Connection, version: i64) -> Result<()> {
    db.execute_batch(BASE)?;
    db.execute_batch(if version == 0 {
        LEGACY_DECISIONS
    } else {
        DECISIONS
    })?;
    db.execute_batch(PENDING)?;
    db.pragma_update(None, "user_version", version)?;
    db.pragma_update(
        None,
        "application_id",
        if version == 0 { 0 } else { APPLICATION_ID },
    )?;
    Ok(())
}
pub fn validate(db: &Connection, expected_version: i64, recovery: bool) -> Result<()> {
    let actual = version(db)?;
    if actual != expected_version {
        return Err(format!("unsupported native schema version {actual}; expected {expected_version}; use offline migrate for version 0 to 1").into());
    }
    let app: i64 = db.pragma_query_value(None, "application_id", |r| r.get(0))?;
    if app
        != if expected_version == 0 {
            0
        } else {
            APPLICATION_ID
        }
    {
        return Err("incompatible native application ID".into());
    }
    let expected = Connection::open_in_memory()?;
    create(&expected, expected_version)?;
    if recovery {
        expected.execute_batch(crate::RECOVERY_SCHEMA)?;
    }
    if objects(db)? != objects(&expected)? {
        return Err("incompatible native replay schema".into());
    }
    Ok(())
}
pub fn open(db: &Connection) -> Result<()> {
    let count: i64 = db.query_row("SELECT count(*) FROM sqlite_schema", [], |r| r.get(0))?;
    let app: i64 = db.pragma_query_value(None, "application_id", |r| r.get(0))?;
    if count == 0 && version(db)? == 0 && app == 0 {
        db.execute_batch("BEGIN IMMEDIATE")?;
        create(db, VERSION)?;
        db.execute_batch("COMMIT")?;
        return Ok(());
    }
    validate_current(db)
}

pub fn validate_current(db: &Connection) -> Result<()> {
    let recovery: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='recovery')",
        [],
        |r| r.get(0),
    )?;
    validate(db, VERSION, recovery)
}
