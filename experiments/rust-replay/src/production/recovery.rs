//! Immutable SQLite snapshots and staged, rollback-capable restoration.
use super::{
    Result,
    config::Config,
    storage::{Database, iso_timestamp},
};

use rusqlite::Connection;

use serde_json::{Value, json};

use sha2::{Digest, Sha256};

use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn unique(root: &Path, label: &str) -> PathBuf {
    root.join(format!(
        ".{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

fn channel(config: &Config) -> Option<&str> {
    let s = config.text("telegramChannelId");

    if s.is_empty() { None } else { Some(s) }
}

fn absolute(path: &Path) -> Result<PathBuf> {
    let input = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };

    let mut result = PathBuf::new();

    for c in input.components() {
        match c {
            std::path::Component::ParentDir => {
                result.pop();
            }

            std::path::Component::CurDir => {}

            _ => result.push(c),
        }
    }

    Ok(result)
}

fn destination(config: &Config) -> Result<PathBuf> {
    let text = config.text("backupDirectory");

    if text.is_empty() {
        return Err("BACKUP_DIRECTORY must be configured".into());
    }

    let backup = absolute(Path::new(text))?;

    let data = absolute(Path::new(config.text("dataDirectory")))?;

    if backup.starts_with(&data) || data.starts_with(&backup) {
        return Err(
            "BACKUP_DIRECTORY must be independent of DATA_DIRECTORY and may not contain it".into(),
        );
    }

    Ok(backup)
}

fn mkdir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;

    let metadata = fs::symlink_metadata(path)?;

    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Unsafe snapshot directory".into());
    }

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;

    Ok(())
}

fn sync_directory(path: &Path) -> Result<()> {
    match fs::File::open(path)?.sync_all() {
        Ok(()) => Ok(()),
        Err(e) if matches!(e.raw_os_error(), Some(libc::EINVAL) | Some(libc::ENOTSUP)) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn copy_file(source: &Path, target: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(source)?;

    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(format!("Unsafe snapshot file: {}", source.display()).into());
    }

    if let Some(parent) = target.parent() {
        mkdir(parent)?;
    }

    let mut input = fs::File::open(source)?;

    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(target)?;

    std::io::copy(&mut input, &mut output)?;

    output.sync_all()?;

    Ok(())
}

fn walk(root: &Path) -> Result<Vec<PathBuf>> {
    let meta = fs::symlink_metadata(root)?;

    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("Unsafe snapshot directory".into());
    }

    let mut entries = fs::read_dir(root)?
        .map(|e| e.map(|e| e.path()))
        .collect::<std::io::Result<Vec<_>>>()?;

    entries.sort();

    let mut result = vec![];

    for path in entries {
        let meta = fs::symlink_metadata(&path)?;

        if meta.file_type().is_symlink() {
            return Err("Snapshot contains an unsafe symbolic link".into());
        }

        if meta.is_dir() {
            result.extend(walk(&path)?);
        } else if meta.is_file() {
            result.push(path);
        } else {
            return Err("Snapshot contains unsupported entry".into());
        }
    }

    Ok(result)
}

fn clone_tree(source: &Path, target: &Path) -> Result<()> {
    mkdir(target)?;

    for file in walk(source)? {
        copy_file(&file, &target.join(file.strip_prefix(source)?))?;
    }

    sync_tree(target)
}

fn sync_tree(root: &Path) -> Result<()> {
    for entry in fs::read_dir(root)? {
        let p = entry?.path();

        if fs::symlink_metadata(&p)?.is_dir() {
            sync_tree(&p)?;
        } else {
            fs::File::open(&p)?.sync_all()?;
        }
    }

    sync_directory(root)
}

fn hashes(root: &Path) -> Result<Value> {
    let mut result = serde_json::Map::new();

    for file in walk(root)? {
        let mut input = fs::File::open(&file)?;

        let mut hash = Sha256::new();

        let mut buffer = [0u8; 65536];

        loop {
            let n = input.read(&mut buffer)?;

            if n == 0 {
                break;
            }

            hash.update(&buffer[..n]);
        }

        let relative = file
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");

        result.insert(
            relative,
            json!(
                hash.finalize()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            ),
        );
    }

    Ok(Value::Object(result))
}

fn summary(config: &Config, root: &Path) -> Result<Value> {
    let db = Database::open(root, channel(config))?;

    let result = db.validate()?;

    db.checkpoint()?;

    Ok(result)
}

fn sentinel_paths(config: &Config) -> Result<Vec<PathBuf>> {
    let data = Path::new(config.text("dataDirectory"));

    [
        "apartmentsStateFile",
        "deliveryStateFile",
        "telegramStateFile",
        "exchangeRatesStateFile",
        "channelDeliveryStateFile",
    ]
    .iter()
    .map(|key| {
        let source = Path::new(config.text(key));

        Ok(source.strip_prefix(data)?.to_owned())
    })
    .collect()
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;

    let serialized = if value["type"] == "rental-apartments-backup" {
        let mut fields = vec![];

        for key in [
            "present",
            "applicationId",
            "userVersion",
            "databaseId",
            "listUrlTemplate",
            "channelId",
            "apartments",
            "privateRecipients",
            "privateDecisions",
            "channelDeliveries",
            "telegramUsers",
            "exchangeRateSnapshots",
            "updateOffset",
        ] {
            fields.push(format!(
                "{}:{}",
                serde_json::to_string(key)?,
                serde_json::to_string(&value["summary"]["database"][key])?
            ));
        }

        format!(
            "{{\"type\":\"rental-apartments-backup\",\"version\":3,\"createdAt\":{},\"summary\":{{\"database\":{{{}}}}},\"hashes\":{}}}",
            serde_json::to_string(&value["createdAt"])?,
            fields.join(","),
            serde_json::to_string(&value["hashes"])?
        )
    } else {
        serde_json::to_string_pretty(value)?
    };

    file.write_all(serialized.as_bytes())?;

    file.write_all(b"\n")?;

    file.sync_all()?;

    Ok(())
}

fn retain(root: &Path, count: usize) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }

    let mut entries = fs::read_dir(root)?
        .filter_map(|r| r.ok())
        .filter(|e| {
            e.file_type().is_ok_and(|t| t.is_dir())
                && !e.file_name().to_string_lossy().starts_with('.')
        })
        .map(|e| e.path())
        .collect::<Vec<_>>();

    entries.sort();

    entries.reverse();

    for path in entries.into_iter().skip(count) {
        fs::remove_dir_all(path)?;
    }

    Ok(())
}

/// Caller holds the same singleton lease as the serving process.
pub fn create_snapshot(config: &Config, now_ms: i64) -> Result<Value> {
    let daily_retention = config.number("backupDailyRetention") as usize;

    let weekly_retention = config.number("backupWeeklyRetention") as usize;

    if daily_retention < 7 || weekly_retention < 4 {
        return Err("Backup retention must be at least seven daily and four weekly".into());
    }

    let backup = destination(config)?;

    mkdir(&backup)?;

    let temporary = unique(&backup, "snapshot");

    let result = (|| -> Result<Value> {
        mkdir(&temporary)?;

        let data = temporary.join("data");

        mkdir(&data)?;

        let source_root = Path::new(config.text("dataDirectory"));

        let source = summary(config, source_root)?;

        for relative in sentinel_paths(config)? {
            let path = source_root.join(&relative);

            if fs::symlink_metadata(&path).is_ok() {
                copy_file(&path, &data.join(&relative))?;
            }
        }

        let db = Database::open(source_root, channel(config))?;

        let target = data.join("state.sqlite3");

        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&target)?;

        db.connection.backup("main", &target, None)?;

        db.checkpoint()?;

        drop(db);

        let copied = summary(config, &data)?;

        if copied != source {
            return Err("Snapshot counts changed while copying state".into());
        }

        sync_tree(&data)?;

        let created = iso_timestamp(now_ms)?;

        let manifest = json!({
        "type":"rental-apartments-backup","version":3,"createdAt":created,"summary":copied,"hashes":hashes(&data)?}
        );

        write_json(&temporary.join("manifest.json"), &manifest)?;

        sync_directory(&temporary)?;

        let id = created.replace([':', '.'], "-");

        let daily = backup.join("daily");

        mkdir(&daily)?;

        let published = daily.join(&id);

        if published.exists() {
            return Err("Snapshot already exists".into());
        }

        fs::rename(&temporary, &published)?;

        sync_directory(&daily)?;

        let mut output = json!({
        "snapshot":published,"summary":copied}
        );

        if (now_ms.div_euclid(86_400_000) + 4).rem_euclid(7) == 0 {
            let weekly = backup.join("weekly");

            mkdir(&weekly)?;

            let temp_week = unique(&backup, "weekly");

            let destination = weekly.join(&id);

            let cloned = clone_tree(&published, &temp_week).and_then(|_| {
                fs::rename(&temp_week, &destination)?;

                sync_directory(&weekly)
            });

            if cloned.is_err() {
                let _ = fs::remove_dir_all(&temp_week);
            }

            cloned?;

            output["weeklySnapshot"] = json!(destination);
        }

        retain(&daily, daily_retention)?;

        retain(&backup.join("weekly"), weekly_retention)?;

        Ok(output)
    })();

    if temporary.exists() {
        let _ = fs::remove_dir_all(&temporary);
    }

    result
}

/// Validation upgrades only a writable staged copy;
/// The archive remains immutable.
pub fn validate_snapshot(config: &Config, snapshot: &Path) -> Result<Value> {
    let manifest_path = snapshot.join("manifest.json");

    let meta = fs::symlink_metadata(&manifest_path)?;

    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("Unsafe backup manifest".into());
    }

    let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path)?)?;

    if manifest["type"] == "rental-apartments-backup"
        && (manifest["version"] == 1 || manifest["snapshotClass"] == "pre-sqlite")
    {
        return Err(
            "Backup predates the SQLite cutover and cannot be restored by this release".into(),
        );
    }

    if manifest["type"] != "rental-apartments-backup"
        || !matches!(manifest["version"].as_i64(), Some(2 | 3))
        || manifest.get("snapshotClass").is_some()
        || manifest.get("summary").is_none()
        || manifest.get("hashes").is_none()
        || chrono::DateTime::parse_from_rfc3339(manifest["createdAt"].as_str().unwrap_or(""))
            .is_err()
    {
        return Err("Backup manifest is incompatible".into());
    }

    let root = snapshot.join("data");

    if hashes(&root)? != manifest["hashes"] {
        return Err("Backup content checksum failed".into());
    }

    let data = Path::new(config.text("dataDirectory"));

    mkdir(data)?;

    let stage = unique(data, "validate-stage");

    let result = (|| -> Result<Value> {
        mkdir(&stage)?;

        for name in ["state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm"] {
            let source = root.join(name);

            if fs::symlink_metadata(&source).is_ok() {
                copy_file(&source, &stage.join(name))?;
            }
        }

        let archived = Connection::open_with_flags(
            stage.join("state.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;

        let version: i64 = archived.pragma_query_value(None, "user_version", |r| r.get(0))?;

        drop(archived);

        let current = summary(config, &stage)?;

        let mut archived_summary = current.clone();

        archived_summary["database"]["userVersion"] = json!(version);

        let expected = if manifest["version"] == 2 {
            json!({
            "database":manifest["summary"]["database"]}
            )
        } else {
            manifest["summary"].clone()
        };

        if archived_summary != expected {
            return Err(
                "Backup schema counts or Telegram update offset do not match its manifest".into(),
            );
        }

        Ok(json!({
        "manifest":manifest,"summary":current}
        ))
    })();

    let cleanup = fs::remove_dir_all(&stage);

    match result {
        Ok(v) => {
            cleanup?;

            Ok(v)
        }

        Err(e) => Err(e),
    }
}

/// Caller holds the singleton lease until installation or rollback completes.
pub fn restore_snapshot(config: &Config, snapshot: &Path) -> Result<Value> {
    let backup = destination(config)?;

    let snapshot = absolute(snapshot)?;

    if !snapshot.starts_with(&backup) {
        return Err("The snapshot must be inside BACKUP_DIRECTORY".into());
    }

    let validated = validate_snapshot(config, &snapshot)?;

    let data = Path::new(config.text("dataDirectory"));

    let stage = unique(data, "restore-stage");

    let rollback = unique(data, "restore-rollback");

    let mut installed = Vec::new();

    let mut moved = Vec::new();

    let outcome = (|| -> Result<Value> {
        clone_tree(&snapshot.join("data"), &stage)?;

        summary(config, &stage)?;

        mkdir(&rollback)?;

        let mut targets = sentinel_paths(config)?;

        targets
            .extend(["state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm"].map(PathBuf::from));

        targets.push(
            Path::new(config.text("listAmCookieFile"))
                .strip_prefix(data)?
                .to_owned(),
        );

        for relative in targets {
            let target = data.join(&relative);

            let source = stage.join(&relative);

            let old = rollback.join(&relative);

            if let Some(parent) = target.parent() {
                mkdir(parent)?;
            }

            if fs::symlink_metadata(&target).is_ok() {
                if let Some(parent) = old.parent() {
                    mkdir(parent)?;
                }

                fs::rename(&target, &old)?;

                moved.push((target.clone(), old));
            }

            if fs::symlink_metadata(&source).is_ok() {
                fs::rename(&source, &target)?;

                installed.push(target);
            }
        }

        let restored = summary(config, data)?;

        if restored != validated["summary"] {
            return Err("Restored state does not match the validated backup".into());
        }

        for path in &installed {
            if path.exists() {
                fs::File::open(path)?.sync_all()?;

                if let Some(parent) = path.parent() {
                    sync_directory(parent)?;
                }
            }
        }

        sync_directory(data)?;

        Ok(json!({
        "snapshot":snapshot,"summary":restored}
        ))
    })();

    let mut rollback_errors = vec![];

    if outcome.is_err() {
        for path in installed.iter().rev() {
            if let Err(e) = fs::remove_file(path) {
                rollback_errors.push(e.to_string());
            }
        }

        for (target, old) in moved.iter().rev() {
            if let Err(e) = fs::rename(old, target) {
                rollback_errors.push(e.to_string());
            }
        }
    }

    let _ = fs::remove_dir_all(&stage);

    if rollback_errors.is_empty() {
        let _ = fs::remove_dir_all(&rollback);

        outcome
    } else {
        Err(format!(
            "Restore failed and prior state rollback was incomplete; preserve {}: {}",
            rollback.display(),
            rollback_errors.join("; ")
        )
        .into())
    }
}

pub fn disk_check(directory: &Path, warning_threshold: f64) -> Result<Value> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(directory.as_os_str().as_bytes())?;

    let mut statistics = std::mem::MaybeUninit::<libc::statvfs>::uninit();

    if unsafe { libc::statvfs(path.as_ptr(), statistics.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }

    let s = unsafe { statistics.assume_init() };

    let total = s.f_blocks as f64 * s.f_frsize as f64;

    let free = s.f_bavail as f64 * s.f_frsize as f64;

    let fraction = if total == 0.0 { 0.0 } else { free / total };

    Ok(json!({
    "status":if fraction<warning_threshold{
    "warning"}
    else{
    "ok"}
    ,"freeBytes":free as u64,"totalBytes":total as u64,"freeFraction":fraction,"warningThreshold":warning_threshold}
    ))
}

fn regular_bytes(path: &Path) -> Result<u64> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e.into()),
        Ok(m) if m.is_file() && !m.file_type().is_symlink() => Ok(m.len()),
        Ok(_) => Err("Managed state is not a safe regular file".into()),
    }
}

/// Caller holds the serving singleton lease, so checkpoint and samples are consistent.
pub fn maintenance(config: &Config, now_ms: i64) -> Result<Value> {
    let root = Path::new(config.text("dataDirectory"));

    let history_path = root.join(".maintenance-history.json");

    regular_bytes(&history_path)?;

    let previous = if history_path.exists() {
        let v: Value = serde_json::from_slice(&fs::read(&history_path)?)?;

        if v["type"] != "rental-apartments-maintenance-history"
            || v["version"] != 1
            || v["managedBytes"]
                .as_u64()
                .is_none_or(|n| n > 9_007_199_254_740_991)
            || chrono::DateTime::parse_from_rfc3339(v["sampledAt"].as_str().unwrap_or("")).is_err()
        {
            return Err("Maintenance history has an incompatible schema".into());
        }

        Some(v)
    } else {
        None
    };

    let db = Database::open(root, channel(config))?;

    let summary = db.validate()?;

    db.checkpoint()?;

    let database_bytes = regular_bytes(&root.join("state.sqlite3"))?;

    let wal_bytes = regular_bytes(&root.join("state.sqlite3-wal"))?;

    let bytes = database_bytes + wal_bytes;

    let mut state = json!({
    "name":"sqlite","stateFile":"state.sqlite3","present":true,"bytes":bytes,"databaseBytes":database_bytes,"walBytes":wal_bytes,"schemaVersion":6,"status":if bytes>=512*1024*1024{
    "critical"}
    else if bytes>=256*1024*1024{
    "warning"}
    else{
    "ok"}
    }
    );

    let mut entries = 0u64;

    for key in [
        "apartments",
        "privateRecipients",
        "privateDecisions",
        "channelDeliveries",
        "telegramUsers",
        "exchangeRateSnapshots",
    ] {
        state[key] = summary["database"][key].clone();

        if key != "privateRecipients" {
            entries += state[key].as_u64().unwrap_or(0);
        }
    }

    state["entryCount"] = json!(entries);

    state["updateOffset"] = summary["database"]["updateOffset"].clone();

    let cookie = regular_bytes(Path::new(config.text("listAmCookieFile")))?;

    let managed = bytes + cookie;

    let mut growth = json!({
    "bytes":null,"percent":null}
    );

    if let Some(v) = previous {
        let before = v["managedBytes"].as_u64().unwrap();

        let change = managed as i64 - before as i64;

        growth["previousSampledAt"] = v["sampledAt"].clone();

        growth["previousManagedBytes"] = json!(before);

        growth["bytes"] = json!(change);

        if before != 0 {
            growth["percent"] = json!(change as f64 / before as f64 * 100.0);
        }
    }

    let mut alerts = vec![];

    if bytes >= 256 * 1024 * 1024 {
        alerts.push(json!({
        "alertName":"state_database_growth","bytes":bytes,"thresholdBytes":256*1024*1024}
        ));
    }

    if wal_bytes >= 25 * 1024 * 1024 {
        alerts.push(json!({
        "alertName":"state_wal_growth","bytes":wal_bytes,"thresholdBytes":25*1024*1024}
        ));
    }

    let sampled = iso_timestamp(now_ms)?;

    let report = json!({
    "type":"rental-apartments-maintenance-report","version":1,"sampledAt":sampled,"stateFiles":[state],"httpSession":{
    "bytes":cookie}
    ,"managedStorage":{
    "bytes":managed,"stateBytes":bytes,"growth":growth}
    ,"disk":disk_check(root,config.get("diskFreeWarningFraction").as_f64().unwrap_or(0.2))?,"alerts":alerts}
    );

    let temporary = unique(root, "maintenance-history");

    let saved=write_json(&temporary,&json!({
"type":"rental-apartments-maintenance-history","version":1,"sampledAt":sampled,"managedBytes":managed}
)).and_then(|_|{
fs::rename(&temporary,&history_path)?;
sync_directory(root)}
);

    if saved.is_err() {
        let _ = fs::remove_file(&temporary);
    }

    saved?;

    Ok(report)
}
