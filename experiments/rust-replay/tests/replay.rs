use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
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
#[test]
fn shared_runner_checks_payloads_order_rates_and_clean_reopen() {
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
    let result = result(f.run());
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
fn refuses_stress_population_until_recovery_followup() {
    let output = Command::new(env!("CARGO_BIN_EXE_rental-replay"))
        .args([
            "--fixtures",
            "/missing",
            "--database",
            "/missing/state.sqlite3",
            "--users",
            "1000",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("use --users 500"));
    assert!(!Path::new("/missing/state.sqlite3").exists());
}

#[test]
fn slower_transport_remains_bounded_and_respects_retry_deadlines() {
    let f = Fixture::new();
    let file = f.dir.join("fixtures/manifest.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    manifest["transport"]["latencyMs"] = 100.into();
    manifest["transport"]["retryAfterMs"] = 2500.into();
    fs::write(&file, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let result = result(f.run());
    let catchup = &result["phases"][9];
    assert_eq!(catchup["sent"], 32);
    assert_eq!(catchup["retries"], 1);
    assert_eq!(catchup["rateLimitsVerified"], true);
    assert!(catchup["maxInFlight"].as_u64().unwrap() <= 4);
    assert!(catchup["drainMs"].as_f64().unwrap() >= 12000.0);
    f.verify(&result, true);
}
