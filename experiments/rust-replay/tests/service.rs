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

#[test]
fn failed_fixture_setup_does_not_leave_a_control_socket() {
    let directory =
        std::env::temp_dir().join(format!("native-service-setup-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("fixtures"), "occupied").unwrap();
    let socket = directory.join("control.sock");
    let output = Command::new(env!("CARGO_BIN_EXE_rental-replay"))
        .arg("serve")
        .arg("--socket")
        .arg(&socket)
        .arg("--directory")
        .arg(&directory)
        .args(["--url", "http://127.0.0.1:1"])
        .output()
        .unwrap();
    let stale_socket = socket.exists();
    std::fs::remove_dir_all(directory).unwrap();
    assert!(!output.status.success());
    assert!(
        !stale_socket,
        "failed initialization left a stale control socket"
    );
}
