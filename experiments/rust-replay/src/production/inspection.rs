//! Read-only state identity used by release rollback compatibility checks.
use super::{
    Result,
    storage::{APPLICATION_ID, TEMPLATE},
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};

pub fn inspect(directory: &Path) -> Result<Value> {
    let root = fs::symlink_metadata(directory)?;
    if !root.is_dir() || root.file_type().is_symlink() {
        return Err("ERR_STATE_DATABASE_PATH".into());
    }
    let path = directory.join("state.sqlite3");
    let file = fs::symlink_metadata(&path)?;
    if !file.is_file() || file.file_type().is_symlink() {
        return Err("ERR_STATE_DATABASE_PATH".into());
    }
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(1))?;
    // A single read snapshot keeps header and binding observations coherent.
    connection.execute_batch("BEGIN")?;
    let count: i64 =
        connection.query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))?;
    if count == 0 {
        return Err("ERR_STATE_DATABASE_SCHEMA_MISSING".into());
    }
    let application: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if application != APPLICATION_ID {
        return Err("ERR_STATE_DATABASE_APPLICATION_ID".into());
    }
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version <= 0 {
        return Err("ERR_STATE_DATABASE_SCHEMA_MISSING".into());
    }
    let metadata_rows: i64 =
        connection.query_row("SELECT count(*) FROM application_metadata", [], |row| {
            row.get(0)
        })?;
    if metadata_rows != 1 {
        return Err("ERR_STATE_DATABASE_METADATA".into());
    }
    let (identity, source): (String, String) = connection.query_row(
        "SELECT database_id,list_url_template FROM application_metadata WHERE singleton=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if identity.is_empty() {
        return Err("ERR_STATE_DATABASE_METADATA".into());
    }
    if source != TEMPLATE {
        return Err("ERR_STATE_DATABASE_TARGET".into());
    }
    connection.execute_batch("COMMIT")?;
    Ok(json!({"stateBackend":"sqlite","stateSchema":version}))
}
