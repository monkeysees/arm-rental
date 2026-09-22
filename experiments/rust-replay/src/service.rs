//! Offline lifecycle adapter. The fixture peer and oracle are external processes.
use crate::{Result, model::Manifest};
use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    thread,
    time::Duration,
};

static STOP: AtomicBool = AtomicBool::new(false);
const LIMIT: u64 = 8 * 1024 * 1024;
extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TransportStats {
    requests: usize,
    completed: usize,
    cancelled: usize,
    largest_body_bytes: u64,
    sampled_child_peak_rss_bytes: u64,
}
struct Transport {
    base: String,
    directory: PathBuf,
    stats: Arc<Mutex<TransportStats>>,
}
impl Transport {
    fn fetch(&self, name: &str) -> Result<bool> {
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
            || name.starts_with('.')
        {
            return Err("fixture filename must be a plain basename".into());
        }
        if STOP.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let temporary = self.directory.join("response.partial");
        let cookie = self.directory.join("cookies.txt");
        let mut child = Command::new("/usr/local/bin/curl-impersonate")
            .args([
                "--impersonate",
                "safari2601",
                "--silent",
                "--fail",
                "--noproxy",
                "*",
                "--proto",
                "=http",
                "--max-time",
                "5",
                "--max-filesize",
                &LIMIT.to_string(),
                "--cookie",
            ])
            .arg(&cookie)
            .arg("--cookie-jar")
            .arg(&cookie)
            .arg("--output")
            .arg(&temporary)
            .arg(format!("{}/{}", self.base, name))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        self.stats.lock().unwrap().requests += 1;
        let status = loop {
            if let Ok(status) = fs::read_to_string(format!("/proc/{}/status", child.id()))
                && let Some(kib) = status
                    .lines()
                    .find_map(|l| l.strip_prefix("VmHWM:"))
                    .and_then(|s| s.split_whitespace().next())
                    .and_then(|s| s.parse::<u64>().ok())
            {
                let mut stats = self.stats.lock().unwrap();
                stats.sampled_child_peak_rss_bytes =
                    stats.sampled_child_peak_rss_bytes.max(kib * 1024);
            }
            if STOP.load(Ordering::Relaxed) {
                let _ = child.kill();
                child.wait()?;
                let _ = fs::remove_file(&temporary);
                self.stats.lock().unwrap().cancelled += 1;
                return Ok(false);
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => thread::sleep(Duration::from_millis(5)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error.into());
                }
            }
        };
        if !status.success() {
            let _ = fs::remove_file(&temporary);
            return Err(format!("curl failed for {name}: {status}").into());
        }
        let size = fs::metadata(&temporary)?.len();
        if size > LIMIT {
            fs::remove_file(&temporary)?;
            return Err("response exceeds byte bound".into());
        }
        if name == "probe" && fs::read(&temporary)? != b"native-fixture-ok\n" {
            return Err("fixture probe body mismatch".into());
        }
        fs::rename(&temporary, self.directory.join(name))?;
        let mut stats = self.stats.lock().unwrap();
        stats.completed += 1;
        stats.largest_body_bytes = stats.largest_body_bytes.max(size);
        Ok(true)
    }
}

pub fn dispatch() -> Result<bool> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let Some(command) = args.first() else {
        return Ok(false);
    };
    if !["serve", "health", "shutdown"].contains(&command.as_str()) {
        return Ok(false);
    }
    let mut options = std::collections::BTreeMap::new();
    let mut pairs = args[1..].chunks_exact(2);
    for pair in &mut pairs {
        if ![
            "--socket",
            "--directory",
            "--url",
            "--users",
            "--mode",
            "--stage",
        ]
        .contains(&pair[0].as_str())
            || options.insert(pair[0].as_str(), pair[1].as_str()).is_some()
        {
            return Err("unknown or repeated service option".into());
        }
    }
    if !pairs.remainder().is_empty() {
        return Err("missing service option value".into());
    }
    let socket = Path::new(*options.get("--socket").ok_or("--socket required")?);
    if command != "serve" {
        let mut stream = UnixStream::connect(socket)?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        stream.write_all(if command == "health" {
            b"health\n"
        } else {
            b"shutdown\n"
        })?;
        let mut reply = String::new();
        stream.take(1024).read_to_string(&mut reply)?;
        print!("{reply}");
        if !reply.starts_with("ok ") {
            return Err("service is not ready".into());
        }
        return Ok(true);
    }
    let directory = PathBuf::from(*options.get("--directory").ok_or("--directory required")?);
    let base = *options.get("--url").ok_or("--url required")?;
    let authority = base
        .strip_prefix("http://")
        .ok_or("only local HTTP fixture peers are supported")?;
    let (host, port) = authority.split_once(':').ok_or("fixture port required")?;
    if !["127.0.0.1", "fixture"].contains(&host) || port.parse::<u16>().is_err() {
        return Err("only local fixture peers are supported".into());
    }
    let users = options.get("--users").unwrap_or(&"500").parse()?;
    let mode = *options.get("--mode").unwrap_or(&"wall");
    let stage = *options.get("--stage").unwrap_or(&"exercise");
    if !["exercise", "resume"].contains(&stage) {
        return Err("service stage must be exercise or resume".into());
    }
    fs::create_dir_all(&directory)?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    let fixture_directory = directory.join("fixtures");
    fs::create_dir_all(&fixture_directory)?;
    let listener = UnixListener::bind(socket)?;
    listener.set_nonblocking(true)?;
    // The handler only sets an atomic flag; all cleanup occurs in ordinary threads.
    unsafe {
        libc::signal(libc::SIGTERM, stop as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, stop as *const () as libc::sighandler_t);
    }
    let state = Arc::new(AtomicU8::new(0));
    let done = Arc::new(AtomicBool::new(false));
    let control_state = state.clone();
    let control_done = done.clone();
    let control = thread::spawn(move || {
        while !control_done.load(Ordering::Relaxed) {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
                let _ = stream.set_write_timeout(Some(Duration::from_millis(100)));
                let mut request = [0; 32];
                let count = stream.read(&mut request).unwrap_or(0);
                let reply = if &request[..count] == b"shutdown\n" {
                    STOP.store(true, Ordering::Relaxed);
                    "ok draining\n"
                } else if &request[..count] != b"health\n" {
                    "fail command\n"
                } else if STOP.load(Ordering::Relaxed) {
                    "fail draining\n"
                } else {
                    match control_state.load(Ordering::Relaxed) {
                        1 => "ok active\n",
                        2 => "ok pending-restart\n",
                        3 => "ok drained\n",
                        _ => "fail fetching-or-failed\n",
                    }
                };
                let _ = stream.write_all(reply.as_bytes());
            } else {
                thread::sleep(Duration::from_millis(5));
            }
        }
    });
    let stats = Arc::new(Mutex::new(TransportStats::default()));
    let transport = Transport {
        base: base.into(),
        directory: fixture_directory,
        stats: stats.clone(),
    };
    let outcome = (|| -> Result<()> {
        if !transport.fetch("manifest.json")? {
            return Ok(());
        }
        let manifest: Manifest =
            serde_json::from_slice(&fs::read(transport.directory.join("manifest.json"))?)?;
        let names: std::collections::BTreeSet<_> = manifest
            .phases
            .iter()
            .flat_map(|p| p.pages.values())
            .collect();
        if names.len() > 64 {
            return Err("too many fixture pages".into());
        }
        for name in names {
            if !transport.fetch(name)? {
                return Ok(());
            }
        }
        if !transport.fetch("probe")? {
            return Ok(());
        }
        state.store(1, Ordering::Relaxed);
        let monitor_state = state.clone();
        let monitor = thread::spawn(move || -> std::result::Result<(), String> {
            while !STOP.load(Ordering::Relaxed) {
                if let Err(error) = transport.fetch("probe") {
                    monitor_state.store(0, Ordering::Relaxed);
                    STOP.store(true, Ordering::Relaxed);
                    return Err(error.to_string());
                }
                for _ in 0..20 {
                    if STOP.load(Ordering::Relaxed) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(5));
                }
            }
            Ok(())
        });
        let result = crate::replay(
            &directory.join("fixtures"),
            &directory.join("state.sqlite3"),
            users,
            mode,
            stage,
            None,
            true,
        );
        if result.is_ok() && !STOP.load(Ordering::Relaxed) {
            state.store(if stage == "exercise" { 2 } else { 3 }, Ordering::Relaxed);
        }
        if result.is_err() {
            STOP.store(true, Ordering::Relaxed);
        }
        let written = (|| -> Result<()> {
            if let Ok(ref value) = result {
                fs::write(
                    directory.join(format!("{stage}.json")),
                    serde_json::to_vec(value)?,
                )?;
            }
            Ok(())
        })();
        if written.is_err() {
            STOP.store(true, Ordering::Relaxed);
        }
        while !STOP.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(5));
        }
        let monitored = monitor.join().map_err(|_| "transport monitor panicked")?;
        result?;
        written?;
        monitored.map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
        Ok(())
    })();
    STOP.store(true, Ordering::Relaxed);
    state.store(0, Ordering::Relaxed);
    done.store(true, Ordering::Relaxed);
    control.join().map_err(|_| "control thread panicked")?;
    fs::remove_file(socket)?;
    fs::write(
        directory.join(format!("{stage}-transport.json")),
        serde_json::to_vec_pretty(
            &json!({"transport":*stats.lock().unwrap(),"maxCurlConcurrency":1,"maxResponseBytes":LIMIT,"status":if outcome.is_ok() {"stopped"} else {"failed"}}),
        )?,
    )?;
    outcome?;
    Ok(true)
}
