use super::{
    Result,
    config::Config,
    lease::{self, Lease},
    source,
    transport::{self, Source},
};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

static CANCELLED: AtomicBool = AtomicBool::new(false);
extern "C" fn cancel(_: libc::c_int) {
    CANCELLED.store(true, Ordering::Relaxed);
}
pub(crate) struct Cancellation {
    pub(crate) stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Cancellation {
    pub(crate) fn start() -> Self {
        CANCELLED.store(false, Ordering::Relaxed);
        unsafe {
            libc::signal(libc::SIGTERM, cancel as *const () as libc::sighandler_t);
            libc::signal(libc::SIGINT, cancel as *const () as libc::sighandler_t);
        }
        let stop = Arc::new(AtomicBool::new(false));
        let signal_stop = stop.clone();
        let worker = thread::spawn(move || {
            while !signal_stop.load(Ordering::Relaxed) {
                if CANCELLED.load(Ordering::Relaxed) {
                    signal_stop.store(true, Ordering::Relaxed);
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
        });
        Self {
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for Cancellation {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub fn source_smoke(config: &Config, origin: Option<&str>) -> Result<Value> {
    let cancellation = Cancellation::start();
    config.validate_startup()?;
    if origin.is_some() && config.text("environmentName") != "test" {
        return Err("source peer override requires NODE_ENV=test".into());
    }
    let origin = origin
        .map(transport::local_endpoint)
        .transpose()?
        .unwrap_or_else(|| "https://www.list.am".into());
    let directory = Path::new(config.text("dataDirectory"));
    let _lease = Lease::acquire(directory)?;
    let cookie = Path::new(config.text("listAmCookieFile"));
    let parent = cookie.parent().ok_or("invalid cookie parent")?;
    lease::secure_directory(parent)?;
    if fs::canonicalize(parent)? != parent {
        return Err("unsafe cookie directory".into());
    }
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(cookie)?;
    fs::set_permissions(cookie, fs::Permissions::from_mode(0o600))?;
    let testing = config.text("environmentName") == "test";
    if !testing {
        let version = std::process::Command::new(config.text("curlImpersonatePath"))
            .args(["--disable", "--version"])
            .output()?;
        if !version.status.success()
            || !String::from_utf8_lossy(&version.stdout).contains("-IMPERSONATE")
        {
            return Err("curl-impersonate is required".into());
        }
    }
    let http = transport::from_config(config, cancellation.stop.clone());
    let mut transport = Source {
        http,
        origin,
        cookie: cookie.into(),
        next_request: Instant::now(),
        impersonate: !testing,
    };
    let mut pages = Vec::new();
    for (kind, category) in [("apartment", 56), ("house", 1377)] {
        let response = transport.fetch(&format!(
            "/ru/category/{category}/1?n=0&cmtype=0&crc=0&gl=2&srt=3"
        ))?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64;
        let parsed = source::parse_page(&response.body, kind, now)?;
        source::evaluate_integrity(&parsed, 1, &json!([]))?;
        pages.push(source::page_summary(&parsed, 1, kind));
    }
    Ok(json!({"pages":pages}))
}
