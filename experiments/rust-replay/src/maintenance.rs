use crate::{Result, cgroup, process_resources, store::Store, verify_history};
use rusqlite::{
    Connection, OpenFlags,
    backup::{Backup, StepResult},
};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn regular(path: &Path) -> Result<()> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err("database must be a regular file, not a symlink".into());
    }
    Ok(())
}
fn open(path: &Path) -> Result<Connection> {
    regular(path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
        if sidecar.symlink_metadata().is_ok() {
            regular(&sidecar)?;
        }
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA cache_size=-512; PRAGMA temp_store=FILE; PRAGMA query_only=ON; BEGIN")?;
    Ok(db)
}
fn validate(db: Connection, path: &Path, version: i64) -> Result<(Connection, Value)> {
    crate::schema::validate(&db, version, true)?;
    let integrity: String = db.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(format!("corrupt database: {integrity}").into());
    }
    let invalid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM decisions WHERE user<0 OR id<0 OR status NOT BETWEEN 0 AND 3 OR revision<1) OR EXISTS(SELECT 1 FROM listings WHERE revision<1 OR NOT json_valid(payload)) OR (SELECT count(*) FROM recovery)!=1 OR (SELECT count(*) FROM history)!=1 OR (SELECT count(*) FROM seed_input)!=1 OR (SELECT count(*) FROM seed_progress WHERE consumed=1)!=1", [], |r| r.get(0))?;
    if invalid {
        return Err("invalid native replay state".into());
    }
    // This offline schema belongs to the frozen 4/500-recipient replay contract.
    // Check each acknowledgement, not just pending totals, before publishing a copy.
    let users: i64 = db.query_row(
        "SELECT json_extract(input,'$[0]') FROM seed_input",
        [],
        |r| r.get(0),
    )?;
    let incompatible: bool = db.query_row(
        "SELECT
        (SELECT count(*) FROM decisions)!=?1*6643
        OR (SELECT count(*) FROM decisions WHERE status=0)!=?1*6
        OR EXISTS(SELECT 1 FROM decisions WHERE user<0 OR user>=?1 OR id>=400032)
        OR (SELECT count(*) FROM decisions WHERE id>=400000)!=?1*32
        OR EXISTS(SELECT 1 FROM decisions WHERE id>=400000 AND status!=CASE
            WHEN id%4!=user%4 THEN 2 WHEN id<400008 THEN 1 ELSE 0 END)
        OR EXISTS(SELECT 1 FROM seed_progress WHERE next_row!=?1*6563 OR consumed!=1)",
        [users],
        |r| r.get(0),
    )?;
    if ![4, 500].contains(&users) || incompatible {
        return Err("maintenance requires the frozen 4/500-recipient interrupted exercise boundary with its acknowledged prefix and pending suffix; completed resume is unsupported".into());
    }
    let store = Store {
        db,
        path: path.to_path_buf(),
        storage: Default::default(),
    };
    verify_history(&store)?;
    let rows: i64 = store
        .db
        .query_row("SELECT count(*) FROM decisions", [], |r| r.get(0))?;
    let pending: i64 =
        store
            .db
            .query_row("SELECT count(*) FROM decisions WHERE status=0", [], |r| {
                r.get(0)
            })?;
    Ok((store.db, json!({"decisionRows":rows,"pendingRows":pending})))
}
pub(crate) fn stop_at(stop: Option<&str>, boundary: &str) {
    if stop == Some(boundary) {
        eprintln!("maintenance interruption at {boundary}");
        std::process::exit(26);
    }
}
fn bytes(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

pub fn dispatch() -> Result<bool> {
    let mut args = std::env::args().skip(1);
    let Some(command) = args.next() else {
        return Ok(false);
    };
    if !["backup", "validate", "restore", "migrate"].contains(&command.as_str()) {
        return Ok(false);
    }
    let (mut database, mut output, mut stop) = (None, None, None);
    while let Some(key) = args.next() {
        let value = args.next().ok_or("missing maintenance argument value")?;
        match key.as_str() {
            "--database" if database.is_none() => database = Some(PathBuf::from(value)),
            "--output" if output.is_none() => output = Some(PathBuf::from(value)),
            "--stop" if stop.is_none() => stop = Some(value),
            _ => return Err(format!("unknown or duplicate maintenance argument {key}").into()),
        }
    }
    if command == "validate" && (output.is_some() || stop.is_some()) {
        return Err("validate takes only --database".into());
    }
    if stop.as_deref().is_some_and(|s| {
        ![
            "before-copy",
            "during-copy",
            "during-migration",
            "before-migration-commit",
            "after-migration",
            "after-copy",
            "before-publish",
            "after-publish",
        ]
        .contains(&s)
    }) {
        return Err("unknown maintenance interruption boundary".into());
    }
    if command != "validate" && output.is_none() {
        return Err("--output NEW_DIRECTORY is required".into());
    }
    if command != "migrate"
        && stop
            .as_deref()
            .is_some_and(|s| s.contains("migration") || s == "before-copy")
    {
        return Err("migration interruption boundary requires migrate".into());
    }
    let database = database.ok_or("--database is required")?;
    let start = Instant::now();
    let source_bytes = bytes(&database);
    let wal_bytes = bytes(&PathBuf::from(format!("{}-wal", database.display())));
    let source_version = if command == "migrate" {
        0
    } else {
        crate::schema::VERSION
    };
    let (source, counts) = validate(open(&database)?, &database, source_version)?;
    stop_at(stop.as_deref(), "before-copy");
    let mut destination_bytes = 0;
    if let Some(output) = output {
        fs::DirBuilder::new().mode(0o700).create(&output)?;
        fs::File::open(
            output
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )?
        .sync_all()?;
        let temporary = output.join("incomplete.sqlite3");
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        let mut target = Connection::open(&temporary)?;
        target.execute_batch("PRAGMA cache_size=-512; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE")?;
        {
            let copy = Backup::new(&source, &mut target)?;
            loop {
                let progress = copy.step(128)?;
                stop_at(stop.as_deref(), "during-copy");
                match progress {
                    StepResult::Done => break,
                    StepResult::More => (),
                    _ => {
                        return Err(
                            "backup busy or locked; stop service and retry into a new directory"
                                .into(),
                        );
                    }
                }
            }
        }
        stop_at(stop.as_deref(), "after-copy");
        // A backup of a WAL source may inherit WAL mode; publish one closed file.
        target.execute_batch("PRAGMA journal_mode=DELETE")?;
        if command == "migrate" {
            crate::migration::upgrade(&mut target, stop.as_deref())?;
        }
        target.close().map_err(|(_, e)| e)?;
        let (checked, _) = validate(open(&temporary)?, &temporary, crate::schema::VERSION)?;
        drop(checked);
        fs::File::open(&temporary)?.sync_all()?;
        stop_at(stop.as_deref(), "before-publish");
        let published = output.join("state.sqlite3");
        fs::hard_link(&temporary, &published)?;
        fs::File::open(&output)?.sync_all()?;
        stop_at(stop.as_deref(), "after-publish");
        fs::remove_file(&temporary)?;
        fs::File::open(&output)?.sync_all()?;
        destination_bytes = bytes(&published);
    }
    let (rss, cpu) = process_resources()?;
    println!(
        "{}",
        json!({"version":1,"operation":command,"status":"passed","state":counts,
        "wallMs":start.elapsed().as_secs_f64()*1000.0,"cpuMs":cpu,"processPeakRssBytes":rss,
        "cgroupPeakBytes":cgroup("memory.peak"),"sourceDatabaseBytes":source_bytes,"sourceWalBytes":wal_bytes,
        "sourceVersion":source_version,"targetVersion":crate::schema::VERSION,
        "migrationBatchRows":crate::migration::BATCH_ROWS,"destinationDatabaseBytes":destination_bytes,"copyPagesPerStep":128,"cacheKiBPerConnection":512,
        "peakDiskBudgetBytes":source_bytes+wal_bytes+destination_bytes+if command == "migrate" { source_bytes+4*1024*1024 } else { 1024*1024 }})
    );
    Ok(true)
}
