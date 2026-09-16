use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    root: PathBuf,
    dir: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let dir = std::env::temp_dir().join(format!(
            "rust-replay-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        let out = Command::new("node")
            .current_dir(&root)
            .arg("experiments/node-replay/export.js")
            .arg(dir.join("fixtures"))
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        Self { root, dir }
    }
    fn run(&self) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rental-replay"))
            .args(["--fixtures"])
            .arg(self.dir.join("fixtures"))
            .arg("--database")
            .arg(self.dir.join("state.sqlite3"))
            .args(["--users", "4", "--mode", "virtual"])
            .output()
            .unwrap()
    }
    fn verify(&self, result: &Value, valid: bool) {
        let file = self.dir.join("result.json");
        fs::write(&file, serde_json::to_vec(result).unwrap()).unwrap();
        let output = Command::new("node")
            .current_dir(&self.root)
            .arg("experiments/node-replay/verify.js")
            .arg(file)
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            valid,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn replace(&self, file: &str, old: &str, new: &str) {
        let path = self.dir.join("fixtures").join(file);
        fs::write(&path, fs::read_to_string(&path).unwrap().replace(old, new)).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.dir).unwrap();
    }
}
fn result(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn exercise_result(output: Output) -> Value {
    assert_eq!(
        output.status.code(),
        Some(23),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn shared_runner_checks_payloads_order_rates_and_unclean_recovery() {
    let f = Fixture::new();
    let output = Command::new("node")
        .current_dir(&f.root)
        .args([
            "experiments/node-replay/run.js",
            "--runtime",
            "rust",
            "--rust-binary",
            env!("CARGO_BIN_EXE_rental-replay"),
            "--users",
            "4",
            "--mode",
            "virtual",
        ])
        .output()
        .unwrap();
    assert!(
        output.stdout.len() > 65536,
        "runner must flush output beyond pipe buffer: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = result(output);
    f.verify(&result, true);
    let mut wrong = result.clone();
    wrong["phases"][6]["deliveriesByProfile"][0] = serde_json::json!(["100004", "100000"]);
    f.verify(&wrong, false);
    let mut wrong = result.clone();
    wrong["phases"][6]["payloadsByProfile"][1][0]["currency"] = "AMD".into();
    f.verify(&wrong, false);
}
#[test]
fn source_prices_drive_filtering_and_existing_state_is_refused() {
    let f = Fixture::new();
    f.replace("updated-house.html", "500 USD", "501 USD");
    let result = exercise_result(f.run());
    assert_eq!(
        result["phases"][6]["deliveriesByProfile"][1],
        serde_json::json!([])
    );
    f.verify(&result, false);
    let before = fs::read(f.dir.join("state.sqlite3")).unwrap();
    assert!(!f.run().status.success());
    assert_eq!(fs::read(f.dir.join("state.sqlite3")).unwrap(), before);
}
#[test]
fn unknown_currency_fails_closed() {
    let f = Fixture::new();
    f.replace("seed-house.html", "USD", "XYZ");
    let output = f.run();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("missing exchange rate XYZ"));
}
#[test]
fn slower_transport_remains_bounded_and_respects_retry_deadlines() {
    let f = Fixture::new();
    let file = f.dir.join("fixtures/manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    manifest["transport"]["latencyMs"] = 100.into();
    manifest["transport"]["retryAfterMs"] = 2500.into();
    fs::write(&file, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let result = exercise_result(f.run());
    let catchup = &result["phases"][9];
    assert_eq!(catchup["sent"], 32);
    assert_eq!(catchup["retries"], 1);
    assert_eq!(catchup["rateLimitsVerified"], true);
    assert!(catchup["maxInFlight"].as_u64().unwrap() <= 4);
    assert!(catchup["drainMs"].as_f64().unwrap() >= 12000.0);
    assert!(
        result["phases"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "interrupted")
    );
}

#[test]
fn unclean_restart_preserves_prefix_and_drains_suffix() {
    let f = Fixture::new();
    let first = f.run();
    assert_eq!(first.status.code(), Some(23));
    let first: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(
        first["phases"].as_array().unwrap().last().unwrap()["sent"],
        8
    );
    let second = Command::new(env!("CARGO_BIN_EXE_rental-replay"))
        .arg("--fixtures")
        .arg(f.dir.join("fixtures"))
        .arg("--database")
        .arg(f.dir.join("state.sqlite3"))
        .args(["--users", "4", "--stage", "resume"])
        .output()
        .unwrap();
    let second = result(second);
    assert_eq!(second["phases"][0]["sent"], 24);
    assert_eq!(second["resources"]["pendingRows"], 0);
    assert_eq!(second["resources"]["decisionRows"], 26572);
}

#[test]
fn accepted_send_before_ack_can_repeat_after_process_death() {
    let f = Fixture::new();
    let run = |mode| {
        Command::new(env!("CARGO_BIN_EXE_rental-replay"))
            .arg("--fixtures")
            .arg(f.dir.join("fixtures"))
            .arg("--database")
            .arg(f.dir.join("diagnostic.sqlite3"))
            .args(["--diagnostic", mode])
            .output()
            .unwrap()
    };
    assert_eq!(run("accept-before-ack").status.code(), Some(24));
    let recovered = result(run("recover"));
    assert_eq!(recovered["pending"], false);
    assert_eq!(
        fs::read_to_string(f.dir.join("diagnostic.receipts")).unwrap(),
        "400000\n400000\n"
    );
}

#[test]
fn recovery_detects_historical_changes_even_when_group_counts_and_id_sums_match() {
    let f = Fixture::new();
    exercise_result(f.run());
    let db = rusqlite::Connection::open(f.dir.join("state.sqlite3")).unwrap();
    let aggregates = || {
        let mut query = db.prepare("SELECT status,revision,at,count(*),sum(id) FROM decisions WHERE user=0 AND id<400000 GROUP BY status,revision,at ORDER BY status,revision,at").unwrap();
        query
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let before = aggregates();
    db.execute("UPDATE decisions SET status=CASE status WHEN 1 THEN 2 ELSE 1 END WHERE user=0 AND id IN (100008,100012,100009,100011)", []).unwrap();
    assert_eq!(aggregates(), before);
    drop(db);
    let output = Command::new(env!("CARGO_BIN_EXE_rental-replay"))
        .arg("--fixtures")
        .arg(f.dir.join("fixtures"))
        .arg("--database")
        .arg(f.dir.join("state.sqlite3"))
        .args(["--users", "4", "--stage", "resume"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("changed historical decisions"));
}
