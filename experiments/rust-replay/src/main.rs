mod bulk;
mod delivery;
mod maintenance;
mod model;
mod service;
mod store;
use delivery::{PhaseResult, deliver, elapsed, observe};
use model::{Listing, Manifest, Phase, parse_page, timestamp};
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::Instant,
};
use store::Store;
pub const RECOVERY_SCHEMA: &str = "CREATE TABLE recovery(drain REAL NOT NULL,stamp REAL NOT NULL) STRICT; CREATE TABLE history(digest TEXT NOT NULL) STRICT";

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn read_phase(directory: &Path, phase: &Phase, m: &Manifest) -> Result<Vec<Listing>> {
    let mut list = Vec::new();
    for kind in ["apartment", "house"] {
        let page = phase.pages.get(kind).ok_or("missing category page")?;
        list.extend(parse_page(
            &fs::read_to_string(directory.join(page))?,
            kind,
            m,
        )?);
    }
    Ok(list)
}
fn cgroup(name: &str) -> Value {
    fs::read_to_string(format!("/sys/fs/cgroup/{name}"))
        .map(|s| {
            s.trim()
                .parse::<u64>()
                .map_or_else(|_| json!(s.trim()), |v| json!(v))
        })
        .unwrap_or(Value::Null)
}
fn process_resources() -> Result<(u64, f64)> {
    let status = fs::read_to_string("/proc/self/status")?;
    let peak: u64 = status
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .ok_or("missing RSS")?
        .split_whitespace()
        .next()
        .ok_or("missing RSS value")?
        .parse()?;
    let sched = fs::read_to_string("/proc/self/schedstat")?;
    let nanos: f64 = sched
        .split_whitespace()
        .next()
        .ok_or("missing CPU time")?
        .parse()?;
    Ok((peak * 1024, nanos / 1e6))
}
fn unix_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        * 1000.0
}
fn memory() -> Value {
    let rss = fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .parse::<u64>()
        .unwrap()
        * 1024;
    json!({"rss":rss})
}
fn snapshot(phase: &str) -> Result<Value> {
    Ok(
        json!({"phase":phase,"processRssBytes":memory()["rss"],"processPeakRssBytes":process_resources()?.0,"cgroupCurrentBytes":cgroup("memory.current"),"cgroupStat":cgroup("memory.stat")}),
    )
}
// DefaultHasher is deterministic within this pinned executable. Stream every ordered
// integer field rather than aggregate IDs, so reassigned rows change the fingerprint.
fn history_digest(store: &Store) -> Result<String> {
    use std::hash::Hasher;
    let mut digest = std::collections::hash_map::DefaultHasher::new();
    let mut query = store.db.prepare(
        "SELECT user,id,status,revision,at FROM decisions WHERE id<400000 ORDER BY user,id",
    )?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        for column in 0..5 {
            digest.write(&row.get::<_, i64>(column)?.to_le_bytes());
        }
    }
    Ok(format!("{:016x}", digest.finish()))
}
fn verify_history(store: &Store) -> Result<()> {
    let expected: String = store
        .db
        .query_row("SELECT digest FROM history", [], |r| r.get(0))?;
    if history_digest(store)? != expected {
        return Err("recovery changed historical decisions".into());
    }
    Ok(())
}
fn replay(
    directory: &Path,
    database: &Path,
    users: usize,
    mode: &str,
    stage: &str,
    seed_stop: Option<&bulk::SeedStop>,
    clean_exit: bool,
) -> Result<Value> {
    let entered_at = unix_ms();
    if ![4, 500].contains(&users)
        || !["virtual", "wall"].contains(&mode)
        || ![
            "exercise",
            "resume",
            "seed",
            "seed-resume",
            "exercise-seeded",
        ]
        .contains(&stage)
    {
        return Err(
            "use --users 500 (4 diagnostic), --mode virtual|wall, --stage exercise|resume|seed|seed-resume|exercise-seeded".into(),
        );
    }
    if ["exercise", "seed"].contains(&stage) {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(database)?;
    } else if !database.is_file() {
        return Err("resume requires existing database".into());
    }
    let m: Manifest = serde_json::from_str(&fs::read_to_string(directory.join("manifest.json"))?)?;
    let t = &m.transport;
    if m.version != 1
        || m.recipients.filters_by_group.len() != 4
        || t.global_attempts_per_second <= 0.0
        || t.recipient_messages_per_minute <= 0.0
        || t.recipient_burst < 1.0
        || t.latency_ms < 0.0
        || t.retry_after_ms < 0.0
        || t.retry_recipients_modulo == 0
        || t.max_attempts < 2
    {
        return Err("unsupported replay contract".into());
    }
    let epoch = timestamp(&m.clock_epoch)?;
    if ["seed-resume", "exercise-seeded"].contains(&stage) {
        bulk::validate_seed(database, &m, users, stage == "exercise-seeded")?;
    }
    let mut store = Store::open(database)?;
    let start = Instant::now();
    if ["seed", "seed-resume"].contains(&stage) {
        if stage == "seed" {
            let phase = m
                .phases
                .iter()
                .find(|p| p.name == "seed")
                .ok_or("missing seed phase")?;
            store.crawl(read_phase(directory, phase, &m)?)?;
        }
        store.seed(&m, users, seed_stop)?;
        return Ok(
            json!({"status":"seeded","rows":users*m.seed.decisions_per_recipient,
            "storage":store.storage_report(),"wallMs":elapsed(start),"snapshot":snapshot("seed-complete")?}),
        );
    }
    let stage = if stage == "exercise-seeded" {
        "exercise"
    } else {
        stage
    };
    let mut snapshots = vec![snapshot("open")?];
    let mut results = Vec::new();
    let mut offset = 0.0;
    if stage == "resume" {
        verify_history(&store)?;
        let interrupted = m
            .phases
            .iter()
            .find(|p| p.name == "interrupted")
            .ok_or("missing interrupted")?;
        let listings = read_phase(directory, interrupted, &m)?;
        for user in 0..users {
            let states = store.classifications(user, &interrupted.ids)?;
            let mut matching: Vec<_> = listings
                .iter()
                .filter(|l| {
                    interrupted.ids.contains(&l.id)
                        && m.recipients.filters_by_group[user % 4].matches(l)
                })
                .collect();
            matching.sort_by(|a, b| (a.posted_at, &a.id).cmp(&(b.posted_at, &b.id)));
            for (i, l) in matching.iter().enumerate() {
                if states.get(&l.id).map(String::as_str)
                    != Some(if i < 2 { "notified" } else { "pending" })
                {
                    return Err("restart lost acknowledged prefix or pending suffix".into());
                }
            }
        }
        let (drain, stamp): (f64, f64) =
            store
                .db
                .query_row("SELECT drain,stamp FROM recovery", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?;
        offset = drain
            + if mode == "wall" {
                (entered_at - stamp).max(0.0)
            } else {
                1000.0
            };
    }
    for phase in &m.phases {
        let resume_phase = ["resumed", "drained", "returning"].contains(&phase.name.as_str());
        if (stage == "resume") != resume_phase {
            continue;
        }
        for _ in 0..phase.repeats.max(1) {
            let started = Instant::now();
            let cpu = process_resources()?.1;
            let mut out = PhaseResult {
                name: phase.name.clone(),
                memory_before: memory(),
                queue_age_offset_ms: if phase.name == "resumed" { offset } else { 0.0 },
                ..Default::default()
            };
            let changed = store.crawl(read_phase(directory, phase, &m)?)?;
            if phase.action == "deliver"
                || ["catchup", "interrupted", "resumed"].contains(&phase.name.as_str())
            {
                store.classify(&m, users, &changed, phase.name == "catchup", epoch)?;
                out.classification_wall_ms = elapsed(started);
                deliver(
                    &store,
                    &m,
                    users,
                    phase.name == "catchup",
                    mode == "wall",
                    epoch,
                    &mut out,
                )?;
                observe(&store, users, &phase.ids, &mut out)?;
            }
            out.wall_ms = elapsed(started);
            out.throughput_per_second =
                (mode == "wall").then(|| out.sent as f64 * 1000.0 / out.wall_ms);
            out.wall_messages_per_second = out.throughput_per_second;
            out.cpu_ms = process_resources()?.1 - cpu;
            out.memory_after = memory();
            out.sampled_peak_rss_bytes = process_resources()?.0;
            snapshots.push(snapshot(&phase.name)?);
            results.push(out);
            if phase.name == "seed" {
                let started = Instant::now();
                let cpu = process_resources()?.1;
                let before = memory();
                store.seed(&m, users, None)?;
                store.consume_seed()?;
                snapshots.push(snapshot("seed-decisions")?);
                results.push(PhaseResult {
                    name: "seed-decisions".into(),
                    wall_ms: elapsed(started),
                    cpu_ms: process_resources()?.1 - cpu,
                    memory_before: before,
                    memory_after: memory(),
                    sampled_peak_rss_bytes: process_resources()?.0,
                    ..Default::default()
                });
            }
        }
    }
    let count: i64 = store
        .db
        .query_row("SELECT count(*) FROM decisions", [], |r| r.get(0))?;
    let pending: i64 =
        store
            .db
            .query_row("SELECT count(*) FROM decisions WHERE status=0", [], |r| {
                r.get(0)
            })?;
    if count != (users * (m.seed.decisions_per_recipient + 80)) as i64 {
        return Err("retained decision count changed".into());
    }
    if pending
        != if stage == "exercise" {
            (users * 6) as i64
        } else {
            0
        }
    {
        return Err("pending suffix count changed".into());
    }
    let first = m
        .seed_decisions
        .absent_ids
        .first()
        .ok_or("missing absent history")?;
    let last = m.seed_decisions.absent_ids.last().unwrap();
    let (absent,invalid): (i64,i64) = store.db.query_row("SELECT count(*),coalesce(sum(CASE WHEN at!=? OR revision!=1 OR status!=CASE WHEN id%4=user%4 THEN 1 ELSE 2 END THEN 1 ELSE 0 END),0) FROM decisions WHERE id BETWEEN ? AND ?",rusqlite::params![timestamp(&m.seed.timestamp)?,first,last],|r| Ok((r.get(0)?,r.get(1)?)))?;
    if absent != (users * m.seed_decisions.absent_ids.len()) as i64 || invalid != 0 {
        return Err("absent decisions changed".into());
    }
    if stage == "resume" {
        verify_history(&store)?;
    }
    let drain = results
        .last()
        .map(|r| {
            r.drain_ms
                + if mode == "wall" {
                    r.classification_wall_ms
                } else {
                    0.0
                }
        })
        .unwrap_or(0.0);
    if stage == "exercise" {
        store.db.execute_batch(RECOVERY_SCHEMA)?;
        store
            .db
            .execute("INSERT INTO history VALUES(?)", [history_digest(&store)?])?;
    }
    let interrupted_at = unix_ms();
    if stage == "exercise" {
        store.db.execute(
            "INSERT INTO recovery VALUES(?,?)",
            rusqlite::params![drain, interrupted_at],
        )?;
    }
    let (peak, cpu) = process_resources()?;
    let sqlite: String = store
        .db
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))?;
    let result = json!({"version":1,"status":"passed","scope":"rust-full-contract","runtime":"rust",
        "mode":mode,"workload":{"users":users,"decisionsPerRecipient":m.seed.decisions_per_recipient},
        "phases":results,"restart":{"uncleanExitCode":23,"acknowledgedPrefixPreserved":stage=="resume","unsentSuffixDelivered":stage=="resume"},
        "storage":store.storage_report(),
        "resources":{"memorySnapshots":snapshots,"wallMs":elapsed(start),"cpuMs":cpu,"processPeakRssBytes":peak,
        "interruptionDrainMs":drain,"interruptedAtUnixMs":interrupted_at,
        "primaryRamBytes":cgroup("memory.peak"),"memoryLimit":cgroup("memory.max"),"swapLimit":cgroup("memory.swap.max"),"cpuLimit":cgroup("cpu.max"),"sqliteVersion":sqlite,"decisionRows":count,"pendingRows":pending,
        "databaseBytes":fs::metadata(database)?.len(),"database-walBytes":fs::metadata(format!("{}-wal",database.display())).map(|s| s.len()).unwrap_or(0)}});
    // The exercise process exits without SQLite destructors or a clean checkpoint.
    if stage == "exercise" && !clean_exit {
        std::mem::forget(store);
    }
    Ok(result)
}
fn diagnostic(directory: &Path, database: &Path, mode: &str) -> Result<Value> {
    let m: Manifest = serde_json::from_str(&fs::read_to_string(directory.join("manifest.json"))?)?;
    let mut store = Store::open(database)?;
    if mode == "checkpoint" {
        store.checkpoint("diagnostic")?;
        return Ok(store.storage_report());
    }
    if mode == "accept-before-ack" {
        let phase = m.phases.iter().find(|p| p.name == "interrupted").unwrap();
        let listing = read_phase(directory, phase, &m)?
            .into_iter()
            .find(|l| l.id == phase.ids[0])
            .unwrap();
        let changed = store.crawl(vec![listing])?;
        store.classify(&m, 1, &changed, false, timestamp(&m.clock_epoch)?)?;
    } else if mode != "recover" {
        return Err("unknown diagnostic".into());
    }
    let listing = store.next(0)?.ok_or("diagnostic has no pending send")?;
    let path = database.with_extension("receipts");
    let mut receipt = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(receipt, "{}", listing.id)?;
    receipt.sync_all()?;
    if mode == "accept-before-ack" {
        std::process::exit(24);
    }
    store.acknowledge(0, &listing.id, timestamp(&m.clock_epoch)?)?;
    Ok(json!({"accepted":listing.id,"pending":store.next(0)?.is_some()}))
}
fn run() -> Result<()> {
    if maintenance::dispatch()? || service::dispatch()? {
        return Ok(());
    }
    let mut args = std::env::args().skip(1);
    let (mut fixtures, mut database) = (None, None);
    let (mut users, mut mode) = (500, "virtual".to_owned());
    let mut stage = "exercise".to_owned();
    let mut diagnostic_mode = None;
    let mut seed_stop = None;
    while let Some(key) = args.next() {
        let value = args.next().ok_or("missing argument value")?;
        match key.as_str() {
            "--fixtures" => fixtures = Some(PathBuf::from(value)),
            "--database" => database = Some(PathBuf::from(value)),
            "--users" => users = value.parse()?,
            "--mode" => mode = value,
            "--stage" => stage = value,
            "--diagnostic" => diagnostic_mode = Some(value),
            "--seed-stop" => seed_stop = Some(bulk::SeedStop::parse(&value)?),
            _ => return Err(format!("unknown argument {key}").into()),
        }
    }
    if seed_stop.is_some()
        && (diagnostic_mode.is_some() || !["seed", "seed-resume"].contains(&stage.as_str()))
    {
        return Err("--seed-stop requires --stage seed or seed-resume without diagnostics".into());
    }
    let fixtures = fixtures.ok_or("--fixtures is required")?;
    let database = database.ok_or("--database is required")?;
    let result = if let Some(ref diagnostic_mode) = diagnostic_mode {
        diagnostic(&fixtures, &database, diagnostic_mode)?
    } else {
        replay(
            &fixtures,
            &database,
            users,
            &mode,
            &stage,
            seed_stop.as_ref(),
            false,
        )?
    };
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    serde_json::to_writer(&mut stdout, &result)?;
    writeln!(stdout)?;
    stdout.flush()?;
    if ["exercise", "exercise-seeded"].contains(&stage.as_str()) && diagnostic_mode.is_none() {
        std::process::exit(23);
    }
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
