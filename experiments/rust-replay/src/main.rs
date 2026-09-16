mod delivery;
mod model;
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
fn replay(directory: &Path, database: &Path, users: usize, mode: &str) -> Result<Value> {
    if ![4, 500].contains(&users) || !["virtual", "wall"].contains(&mode) {
        return Err("use --users 500 (4 diagnostic), --mode virtual|wall".into());
    }
    // Refuse existing state, including dangling symlinks, before SQLite opens it.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(database)?;
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
    let mut store = Store::open(database)?;
    let start = Instant::now();
    let mut results = Vec::new();
    for phase in m.phases.iter().take_while(|p| p.name != "interrupted") {
        for _ in 0..phase.repeats.max(1) {
            let started = Instant::now();
            let mut out = PhaseResult {
                name: phase.name.clone(),
                ..Default::default()
            };
            let changed = store.crawl(read_phase(directory, phase, &m)?)?;
            if phase.action == "deliver" || phase.name == "catchup" {
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
            results.push(out);
            if phase.name == "seed" {
                let started = Instant::now();
                store.seed(&m, users)?;
                results.push(PhaseResult {
                    name: "seed-decisions".into(),
                    wall_ms: elapsed(started),
                    ..Default::default()
                });
            }
        }
    }
    let before = &results
        .last()
        .ok_or("missing phases")?
        .classifications_by_profile;
    store.db.close().map_err(|(_, e)| e)?;
    let mut store = Store::open(database)?;
    let catchup = m
        .phases
        .iter()
        .find(|p| p.name == "catchup")
        .ok_or("missing catchup phase")?;
    let mut out = PhaseResult {
        name: "reopen-unchanged".into(),
        ..Default::default()
    };
    observe(&store, users, &catchup.ids, &mut out)?;
    if &out.classifications_by_profile != before {
        return Err("reopen changed acknowledgements".into());
    }
    let started = Instant::now();
    let changed = store.crawl(read_phase(directory, catchup, &m)?)?;
    store.classify(&m, users, &changed, false, epoch)?;
    out.classification_wall_ms = elapsed(started);
    deliver(&store, &m, users, false, mode == "wall", epoch, &mut out)?;
    if out.sent != 0 {
        return Err("unchanged replay duplicated acknowledgements".into());
    }
    out.wall_ms = elapsed(started);
    results.push(out);
    let count: i64 = store
        .db
        .query_row("SELECT count(*) FROM decisions", [], |r| r.get(0))?;
    if count != (users * (m.seed.decisions_per_recipient + 48)) as i64 {
        return Err("retained decision count changed".into());
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
    let (peak, cpu) = process_resources()?;
    let sqlite: String = store
        .db
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))?;
    Ok(
        json!({"version":1,"status":"passed","scope":"rust-500-slice","runtime":"rust",
        "mode":mode,"workload":{"users":users,"decisionsPerRecipient":m.seed.decisions_per_recipient},
        "phases":results,"restart":{"cleanReopen":true,"acknowledgementsPreserved":true,"unchangedSendsNothing":true},
        "resources":{"wallMs":elapsed(start),"cpuMs":cpu,"processPeakRssBytes":peak,
        "primaryRamBytes":cgroup("memory.peak"),"memoryLimit":cgroup("memory.max"),"swapLimit":cgroup("memory.swap.max"),"cpuLimit":cgroup("cpu.max"),"sqliteVersion":sqlite,"decisionRows":count,
        "databaseBytes":fs::metadata(database)?.len(),"database-walBytes":fs::metadata(format!("{}-wal",database.display())).map(|s| s.len()).unwrap_or(0)}}),
    )
}
fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let (mut fixtures, mut database) = (None, None);
    let (mut users, mut mode) = (500, "virtual".to_owned());
    while let Some(key) = args.next() {
        let value = args.next().ok_or("missing argument value")?;
        match key.as_str() {
            "--fixtures" => fixtures = Some(PathBuf::from(value)),
            "--database" => database = Some(PathBuf::from(value)),
            "--users" => users = value.parse()?,
            "--mode" => mode = value,
            _ => return Err(format!("unknown argument {key}").into()),
        }
    }
    let result = replay(
        &fixtures.ok_or("--fixtures is required")?,
        &database.ok_or("--database is required")?,
        users,
        &mode,
    )?;
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    serde_json::to_writer(&mut stdout, &result)?;
    writeln!(stdout)?;
    stdout.flush()?;
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
