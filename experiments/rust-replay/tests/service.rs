use std::process::Command;

#[test]
fn health_requires_a_live_native_service() {
    let output = Command::new(env!("CARGO_BIN_EXE_rental-replay"))
        .args(["health", "--socket", "/tmp/rental-replay-no-such-socket"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("No such file"));
}
