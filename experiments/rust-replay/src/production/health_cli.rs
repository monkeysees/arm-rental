use super::Result;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    time::{Duration, Instant},
};

fn probe(ready: bool, document: bool) -> Result<(u16, Value)> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let host = std::env::var("HEALTH_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    if !["127.0.0.1", "::1"].contains(&host.as_str()) {
        return Err("HEALTH_HOST must be loopback".into());
    }
    let port: u16 = std::env::var("HEALTH_PORT")
        .unwrap_or_else(|_| "8787".into())
        .parse()?;
    if port == 0 {
        return Err("invalid health port".into());
    }
    let address = SocketAddr::new(host.parse::<IpAddr>()?, port);
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(3)).map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                "READINESS_PROBE_TIMEOUT"
            } else {
                "READINESS_PROBE_FAILED"
            }
        })?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    write!(
        stream,
        "GET {} HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n\r\n",
        if ready { "/ready" } else { "/live" }
    )?;
    let mut bytes = Vec::new();
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("READINESS_PROBE_TIMEOUT")?;
        stream.set_read_timeout(Some(remaining))?;
        let mut chunk = [0u8; 4096];
        let count = stream.read(&mut chunk).map_err(|error| {
            if matches!(
                error.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ) {
                "READINESS_PROBE_TIMEOUT"
            } else {
                "READINESS_PROBE_FAILED"
            }
        })?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > 65536 {
            return Err("READINESS_RESPONSE_INVALID".into());
        }
    }
    if bytes.len() > 65536 {
        return Err("READINESS_RESPONSE_INVALID".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "READINESS_RESPONSE_INVALID")?;
    let (headers, body) = text
        .split_once("\r\n\r\n")
        .ok_or("READINESS_RESPONSE_INVALID")?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or("READINESS_RESPONSE_INVALID")?
        .parse()?;
    if !ready {
        return Ok((status, Value::Null));
    }
    let value: Value = serde_json::from_str(body).map_err(|_| "READINESS_RESPONSE_INVALID")?;
    let valid = |field: &Value| {
        field.as_array().is_some_and(|items| {
            items.len() <= 8
                && items.iter().all(|item| {
                    item.as_str().is_some_and(|s| {
                        !s.is_empty()
                            && s.len() <= 80
                            && s.as_bytes()[0].is_ascii_uppercase()
                            && s.bytes()
                                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                    })
                })
        })
    };
    if !value["ready"].is_boolean() || !valid(&value["reasons"]) || !valid(&value["alertReasons"]) {
        return Err("READINESS_RESPONSE_INVALID".into());
    }
    let reasons = value["reasons"].as_array().unwrap();
    let alerts = value["alertReasons"].as_array().unwrap();
    let ready = value["ready"].as_bool().unwrap();
    if ready != reasons.is_empty()
        || status != if ready { 200 } else { 503 }
        || !alerts.iter().all(|r| reasons.contains(r))
        || !reasons
            .iter()
            .all(|r| r == "LIST_AM_CHALLENGE" || alerts.contains(r))
    {
        return Err("READINESS_RESPONSE_INVALID".into());
    }
    if document {
        return Ok((status, value));
    }
    Ok((
        status,
        json!({"status":if ready{"ready"}else{"not_ready"},"reasons":reasons,"alertReasons":alerts}),
    ))
}
fn counter() -> Result<PathBuf> {
    let directory = std::env::var("DATA_DIRECTORY").unwrap_or_else(|_| ".data".into());
    let hash = Sha256::digest(directory.as_bytes());
    let key: String = hash[..8].iter().map(|byte| format!("{byte:02x}")).collect();
    let parent = std::env::temp_dir().join(format!("rental-apartments-health-{key}"));
    super::lease::secure_directory(&parent)?;
    Ok(parent.join("consecutive-liveness-failures"))
}
fn terminate() -> Result<()> {
    let own = std::env::current_exe()?;
    let directory = std::env::var("DATA_DIRECTORY").unwrap_or_else(|_| ".data".into());
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        if pid <= 1 || pid == std::process::id() {
            continue;
        }
        let root = entry.path();
        if fs::read_link(root.join("exe")).ok().as_ref() != Some(&own) {
            continue;
        }
        let Ok(args) = fs::read(root.join("cmdline")) else {
            continue;
        };
        let mut args = args.split(|b| *b == 0);
        args.next();
        if args.next() != Some(b"serve".as_slice()) {
            continue;
        }
        let Ok(env) = fs::read(root.join("environ")) else {
            continue;
        };
        let data = env
            .split(|b| *b == 0)
            .find_map(|value| value.strip_prefix(b"DATA_DIRECTORY="));
        if data.unwrap_or(b".data") != directory.as_bytes() {
            continue;
        }
        if unsafe { libc::kill(pid as i32, libc::SIGKILL) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        return Ok(());
    }
    Err("Application process was not found".into())
}
pub fn run(args: &[String]) -> Result<bool> {
    if args.iter().any(|arg| {
        !["--ready", "--json", "--document", "--restart-unresponsive"].contains(&arg.as_str())
    }) {
        return Err("unknown health-check option".into());
    }
    let ready = args.iter().any(|a| a == "--ready");
    let document = args.iter().any(|a| a == "--document");
    if document && !ready {
        return Err("--document requires --ready".into());
    }
    let print = document || args.iter().any(|a| a == "--json");
    let restart = !ready && args.iter().any(|a| a == "--restart-unresponsive");
    let result = probe(ready, document);
    let okay = result.as_ref().is_ok_and(|(status, _)| *status == 200);
    if ready && print {
        let summary = result.map(|(_, value)| value).unwrap_or_else(|error| {
            let text = error.to_string();
            let code = if ["READINESS_PROBE_TIMEOUT", "READINESS_RESPONSE_INVALID"]
                .contains(&text.as_str())
            {
                text.as_str()
            } else {
                "READINESS_PROBE_FAILED"
            };
            json!({"status":"not_ready","reasons":[code],"alertReasons":[code]})
        });
        println!("{summary}");
    }
    if restart {
        let file = counter()?;
        if okay {
            let _ = fs::remove_file(file);
        } else {
            let count = fs::read_to_string(&file)
                .ok()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(0)
                .saturating_add(1);
            let mut handle = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&file)?;
            handle.set_permissions(fs::Permissions::from_mode(0o600))?;
            writeln!(handle, "{count}")?;
            handle.sync_all()?;
            if count >= 3 {
                terminate()?;
            }
        }
    }
    Ok(okay)
}
