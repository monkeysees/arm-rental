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
    fn stage(&self, users: &str, stage: &str, extra: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rental-replay"))
            .arg("--fixtures")
            .arg(self.dir.join("fixtures"))
            .arg("--database")
            .arg(self.dir.join("state.sqlite3"))
            .args(["--users", users, "--mode", "virtual", "--stage", stage])
            .args(extra)
            .output()
            .unwrap()
    }
    fn verify_seeded_recovery(&self, users: &str, expected_rows: u64) {
        let exercise = exercise_result(self.stage(users, "exercise-seeded", &[]));
        let mut resumed = result(self.stage(users, "resume", &[]));
        assert_eq!(resumed["resources"]["decisionRows"], expected_rows);
        assert_eq!(resumed["resources"]["pendingRows"], 0);
        let mut phases = exercise["phases"].as_array().unwrap().clone();
        phases.extend(resumed["phases"].as_array().unwrap().iter().cloned());
        resumed["phases"] = phases.into();
        self.verify(&resumed, true);
        let reused = self.stage(users, "exercise-seeded", &[]);
        assert_eq!(reused.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&reused.stderr).contains("already consumed"));
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

#[test]
fn seed_stop_is_rejected_for_diagnostics_before_creating_state() {
    let f = Fixture::new();
    let output = f.stage(
        "4",
        "seed",
        &[
            "--diagnostic",
            "checkpoint",
            "--seed-stop",
            "before-commit:8192",
        ],
    );
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("--seed-stop"));
    assert!(!f.dir.join("state.sqlite3").exists());
}

#[test]
fn repeated_seed_crashes_preserve_the_complete_five_hundred_recipient_contract() {
    let f = Fixture::new();
    for (stage, point) in [
        ("seed", "before-commit:8192"),
        ("seed-resume", "after-commit:8192"),
        ("seed-resume", "before-commit:16384"),
        ("seed-resume", "before-commit:16384"),
    ] {
        let output = f.stage("500", stage, &["--seed-stop", point]);
        assert_eq!(
            output.status.code(),
            Some(25),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let premature = f.stage("500", "exercise-seeded", &[]);
        assert_eq!(premature.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&premature.stderr).contains("incomplete"));
    }
    let changed_users = f.stage("4", "seed-resume", &[]);
    assert_eq!(changed_users.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&changed_users.stderr).contains("seed input differs"));
    let manifest_file = f.dir.join("fixtures/manifest.json");
    let original = fs::read(&manifest_file).unwrap();
    let mut changed: Value = serde_json::from_slice(&original).unwrap();
    changed["seed"]["timestamp"] = "2026-09-01T00:00:00.000Z".into();
    fs::write(&manifest_file, serde_json::to_vec(&changed).unwrap()).unwrap();
    let changed_input = f.stage("500", "seed-resume", &[]);
    assert_eq!(changed_input.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&changed_input.stderr).contains("seed input differs"));
    fs::write(manifest_file, original).unwrap();
    let checkpointed = f.stage(
        "500",
        "seed-resume",
        &["--seed-stop", "after-checkpoint:3281500"],
    );
    assert_eq!(
        checkpointed.status.code(),
        Some(25),
        "{}",
        String::from_utf8_lossy(&checkpointed.stderr)
    );
    for _ in 0..2 {
        let completed = result(f.stage("500", "seed-resume", &[]));
        assert_eq!(completed["status"], "seeded");
        assert_eq!(completed["rows"], 3_281_500);
        let writes = completed["storage"]["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["operation"] == "seed")
            .unwrap();
        assert_eq!(writes["rows"], 0);
    }
    f.verify_seeded_recovery("500", 3_321_500);
}

#[test]
fn blocked_seed_checkpoint_stops_writes_and_resumes_after_reader_closes() {
    let f = Fixture::new();
    let stopped = f.stage("4", "seed", &["--seed-stop", "after-commit:8192"]);
    assert_eq!(stopped.status.code(), Some(25));
    let reader = rusqlite::Connection::open_with_flags(
        f.dir.join("state.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    // An independent reader pins a snapshot while the CLI continues the import.
    reader
        .execute_batch("BEGIN; SELECT id FROM decisions LIMIT 1;")
        .unwrap();
    let blocked = f.stage("4", "seed-resume", &[]);
    assert_eq!(blocked.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&blocked.stderr);
    assert!(stderr.contains("checkpoint blocked by reader"), "{stderr}");
    let observation: Value = serde_json::from_str(stderr.lines().next().unwrap()).unwrap();
    assert_eq!(observation["busy"], 1);
    drop(reader);
    let completed = result(f.stage("4", "seed-resume", &[]));
    assert_eq!(completed["status"], "seeded");
    f.verify_seeded_recovery("4", 26_572);
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

#[test]
fn five_hundred_recipients_make_first_progress_within_shared_deadline() {
    let f = Fixture::new();
    let output = Command::new(env!("CARGO_BIN_EXE_rental-replay"))
        .arg("--fixtures")
        .arg(f.dir.join("fixtures"))
        .arg("--database")
        .arg(f.dir.join("state.sqlite3"))
        .args(["--users", "500", "--mode", "virtual"])
        .output()
        .unwrap();
    let value = exercise_result(output);
    let phase = value["phases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "catchup")
        .unwrap();
    let first = phase["firstProgressMaxMs"].as_f64().unwrap();
    assert!(
        first <= 6605.5,
        "last recipient first progress took {first}ms"
    );
    assert_eq!(phase["rateLimitsVerified"], true);
    assert_eq!(phase["recipientsAsserted"], 500);
}

#[test]
fn catchup_beyond_the_payload_cache_keeps_selection_and_recovery() {
    let f = Fixture::new();
    result(f.stage("4", "seed", &[]));
    // Source updates make 160 older cards eligible in addition to the 40 new ones.
    for id in 100100..100260 {
        f.replace(
            if id % 2 == 0 {
                "seed-apartment.html"
            } else {
                "seed-house.html"
            },
            &format!("Replay rental {id}</div>"),
            &format!("Replay rental {id} changed</div>"),
        );
    }
    let manifest_file = f.dir.join("fixtures/manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_file).unwrap()).unwrap();
    manifest["phases"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|p| p["name"] == "catchup")
        .unwrap()["ids"]
        .as_array_mut()
        .unwrap()
        .push("100100".into());
    fs::write(manifest_file, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let value = exercise_result(f.stage("4", "exercise-seeded", &[]));
    let catchup = value["phases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "catchup")
        .unwrap();
    assert_eq!(
        catchup["deliveriesByProfile"][0],
        serde_json::json!([
            "300008", "300012", "300016", "300020", "300024", "300028", "300032", "300036"
        ])
    );
    assert_eq!(catchup["classificationsByProfile"][0]["100100"], "skipped");
    assert_eq!(catchup["classificationsByProfile"][1]["100100"], "filtered");
    assert_eq!(catchup["sent"], 32);
    let observation = value["storage"]["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["historyPayloadsDecoded"].as_u64().unwrap_or(0) > 0)
        .unwrap();
    assert!(observation["peakHistoryPayloads"].as_u64().unwrap() <= 128);
    assert!(observation["historyPayloadsDecoded"].as_u64().unwrap() >= 200);
    let resumed = result(f.stage("4", "resume", &[]));
    assert_eq!(resumed["resources"]["decisionRows"], 26_572);
    assert_eq!(resumed["resources"]["pendingRows"], 0);
    assert_eq!(resumed["phases"][0]["sent"], 24);
}

#[test]
fn native_backup_restores_acknowledgements_and_rejects_reuse() {
    let f = Fixture::new();
    let first = exercise_result(f.run());
    let maintenance = |command: &str, database: PathBuf, output: Option<PathBuf>| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_rental-replay"));
        child.arg(command).arg("--database").arg(database);
        if let Some(output) = output {
            child.arg("--output").arg(output);
        }
        child.output().unwrap()
    };
    let backup = f.dir.join("backup");
    result(maintenance(
        "backup",
        f.dir.join("state.sqlite3"),
        Some(backup.clone()),
    ));
    result(maintenance("validate", backup.join("state.sqlite3"), None));
    let restored = f.dir.join("restored");
    result(maintenance(
        "restore",
        backup.join("state.sqlite3"),
        Some(restored.clone()),
    ));
    assert!(
        !maintenance(
            "restore",
            backup.join("state.sqlite3"),
            Some(restored.clone())
        )
        .status
        .success()
    );
    let mut resumed = result(
        Command::new(env!("CARGO_BIN_EXE_rental-replay"))
            .arg("--fixtures")
            .arg(f.dir.join("fixtures"))
            .arg("--database")
            .arg(restored.join("state.sqlite3"))
            .args(["--users", "4", "--stage", "resume"])
            .output()
            .unwrap(),
    );
    let mut phases = first["phases"].as_array().unwrap().clone();
    phases.extend(resumed["phases"].as_array().unwrap().iter().cloned());
    resumed["phases"] = phases.into();
    f.verify(&resumed, true);
    assert!(
        !maintenance(
            "backup",
            restored.join("state.sqlite3"),
            Some(f.dir.join("completed"))
        )
        .status
        .success()
    );
    assert!(!f.dir.join("completed").exists());
}

#[test]
fn maintenance_interruptions_never_publish_partial_state_and_retry_safely() {
    let f = Fixture::new();
    exercise_result(f.run());
    for command in ["backup", "restore"] {
        for point in [
            "during-copy",
            "after-copy",
            "before-publish",
            "after-publish",
        ] {
            let output = f.dir.join(format!("{command}-{point}"));
            let run = |destination: &PathBuf, stop: bool| {
                let mut child = Command::new(env!("CARGO_BIN_EXE_rental-replay"));
                child
                    .arg(command)
                    .arg("--database")
                    .arg(f.dir.join("state.sqlite3"))
                    .arg("--output")
                    .arg(destination);
                if stop {
                    child.args(["--stop", point]);
                }
                child.output().unwrap()
            };
            assert_eq!(run(&output, true).status.code(), Some(26));
            let published = output.join("state.sqlite3");
            assert_eq!(published.exists(), point == "after-publish");
            if published.exists() {
                result(
                    Command::new(env!("CARGO_BIN_EXE_rental-replay"))
                        .arg("validate")
                        .arg("--database")
                        .arg(published)
                        .output()
                        .unwrap(),
                );
            }
            assert!(!run(&output, false).status.success());
            result(run(&f.dir.join(format!("{command}-{point}-retry")), false));
        }
    }
}

#[test]
fn maintenance_rejects_corruption_incompatibility_and_symlinks_without_output() {
    let f = Fixture::new();
    exercise_result(f.run());
    let source = f.dir.join("state.sqlite3");
    result(
        Command::new(env!("CARGO_BIN_EXE_rental-replay"))
            .arg("backup")
            .arg("--database")
            .arg(&source)
            .arg("--output")
            .arg(f.dir.join("good"))
            .output()
            .unwrap(),
    );
    let good = f.dir.join("good/state.sqlite3");
    for mutation in [
        "corrupt",
        "schema",
        "hidden-schema",
        "history",
        "acknowledgement",
        "symlink",
    ] {
        let bad = f.dir.join(format!("{mutation}.sqlite3"));
        if mutation == "symlink" {
            std::os::unix::fs::symlink(&good, &bad).unwrap();
        } else {
            fs::copy(&good, &bad).unwrap();
            if mutation == "corrupt" {
                fs::OpenOptions::new()
                    .write(true)
                    .open(&bad)
                    .unwrap()
                    .set_len(8192)
                    .unwrap();
            } else {
                let db = rusqlite::Connection::open(&bad).unwrap();
                db.execute_batch(if mutation == "schema" {
                    "ALTER TABLE decisions ADD COLUMN unexpected INTEGER"
                } else if mutation == "hidden-schema" {
                    "CREATE TABLE sqliteX_extra(value INTEGER)"
                } else if mutation == "acknowledgement" {
                    "UPDATE decisions SET status=CASE status WHEN 0 THEN 1 ELSE 0 END WHERE user=0 AND id IN (400000,400008)"
                } else {
                    "UPDATE decisions SET status=3 WHERE user=0 AND id=100008"
                })
                .unwrap();
            }
        }
        let destination = f.dir.join(format!("rejected-{mutation}"));
        for command in ["validate", "restore"] {
            let mut child = Command::new(env!("CARGO_BIN_EXE_rental-replay"));
            child.arg(command).arg("--database").arg(&bad);
            if command == "restore" {
                child.arg("--output").arg(&destination);
            }
            assert!(
                !child.output().unwrap().status.success(),
                "accepted {mutation}"
            );
        }
        assert!(!destination.exists());
    }
}
