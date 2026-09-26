use super::{Result, config::Config};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const LIMIT: u64 = 8 * 1024 * 1024;
static REQUEST_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub status: u16,
    pub retry_after_ms: Option<u64>,
    pub description: String,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} (HTTP {})", self.code, self.status)
    }
}
impl std::error::Error for Failure {}

pub fn wait(stop: &AtomicBool, duration: Duration) -> Result<()> {
    let start = Instant::now();
    loop {
        if stop.load(Ordering::Relaxed) {
            return Err("operation cancelled".into());
        }
        let remaining = duration.saturating_sub(start.elapsed());
        if remaining.is_zero() {
            return Ok(());
        }
        thread::sleep(remaining.min(Duration::from_millis(20)));
    }
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Child(std::process::Child);
impl std::ops::Deref for Child {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for Child {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[derive(Clone)]
pub struct Http {
    pub executable: PathBuf,
    pub directory: PathBuf,
    pub stop: Arc<AtomicBool>,
    pub timeout_ms: u64,
}
pub struct Response {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}
fn quoted(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t")
    )
}
impl Http {
    pub fn request(
        &self,
        url: &str,
        body: Option<&str>,
        headers: &[(&str, &str)],
        cookies: Option<&Path>,
        impersonate: bool,
    ) -> Result<Response> {
        if self.stop.load(Ordering::Relaxed) {
            return Err("operation cancelled".into());
        }
        let parsed = url::Url::parse(url)?;
        if !["https", "http"].contains(&parsed.scheme())
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("invalid HTTP endpoint".into());
        }
        let id = REQUEST_ID.fetch_add(1, Ordering::Relaxed);
        let directory = self
            .directory
            .join(format!(".native-http-{}-{id}", std::process::id()));
        fs::create_dir(&directory)?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        let temporary = Temporary(directory);
        let body_path = temporary.0.join("body");
        let headers_path = temporary.0.join("headers");
        for path in [&body_path, &headers_path] {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)?;
        }
        let mut config = format!(
            "silent\ncompressed\nproto = {}\nurl = {}\nmax-time = {}\nmax-filesize = {LIMIT}\noutput = {}\ndump-header = {}\n",
            quoted("=http,https"),
            quoted(url),
            self.timeout_ms as f64 / 1000.0,
            quoted(body_path.to_str().ok_or("invalid response path")?),
            quoted(headers_path.to_str().ok_or("invalid headers path")?)
        );
        if impersonate {
            config.push_str("impersonate = safari2601\nreferer = \"https://www.list.am/ru/\"\n");
        }
        if let Some(cookie) = cookies {
            let path = quoted(cookie.to_str().ok_or("invalid cookie path")?);
            config.push_str(&format!("cookie = {path}\ncookie-jar = {path}\n"));
        }
        if let Some(body) = body {
            config.push_str(&format!("request = POST\ndata-binary = {}\n", quoted(body)));
        }
        for (name, value) in headers {
            config.push_str(&format!(
                "header = {}\n",
                quoted(&format!("{name}: {value}"))
            ));
        }
        let mut child = Child(
            Command::new(&self.executable)
                .args(["--disable", "--config", "-"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| "could not start HTTP executable")?,
        );
        let write_result = child
            .stdin
            .take()
            .ok_or("missing HTTP input")?
            .write_all(config.as_bytes());
        if write_result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("could not configure HTTP request".into());
        }
        let start = Instant::now();
        let status = loop {
            if self.stop.load(Ordering::Relaxed)
                || start.elapsed() > Duration::from_millis(self.timeout_ms.saturating_add(1000))
                || fs::metadata(&body_path)?.len() > LIMIT
                || fs::metadata(&headers_path)?.len() > 64 * 1024
            {
                let _ = child.kill();
                let _ = child.wait();
                return Err("HTTP request cancelled, timed out or exceeded byte bound".into());
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => thread::sleep(Duration::from_millis(5)),
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("HTTP subprocess failed".into());
                }
            }
        };
        if !status.success() {
            return Err(Box::new(Failure {
                code: "ERR_HTTP_TRANSPORT",
                status: 0,
                retry_after_ms: None,
                description: String::new(),
            }));
        }
        let mut body = String::new();
        fs::File::open(&body_path)?
            .take(LIMIT + 1)
            .read_to_string(&mut body)?;
        if body.len() as u64 > LIMIT {
            return Err("HTTP response exceeds byte bound".into());
        }
        let mut raw_headers = String::new();
        fs::File::open(&headers_path)?
            .take(64 * 1024 + 1)
            .read_to_string(&mut raw_headers)?;
        if raw_headers.len() > 64 * 1024 {
            return Err("HTTP headers exceed byte bound".into());
        }
        let block = raw_headers
            .split("\r\n\r\n")
            .filter(|block| block.starts_with("HTTP/"))
            .last()
            .ok_or("missing HTTP response status")?;
        let mut lines = block.lines();
        let status = lines
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .ok_or("invalid HTTP response status")?
            .parse()?;
        let mut headers = BTreeMap::new();
        for line in lines {
            let (name, value) = line
                .split_once(':')
                .ok_or("invalid HTTP response headers")?;
            headers.insert(name.to_ascii_lowercase(), value.trim().to_string());
        }
        Ok(Response {
            status,
            headers,
            body,
        })
    }
}

#[derive(Clone)]
pub struct Telegram {
    pub http: Http,
    pub endpoint: String,
    pub retry_base_ms: u64,
    pub retry_max_ms: u64,
}
impl Telegram {
    pub fn call(&self, method: &str, payload: &Value, max_attempts: u32) -> Result<Value> {
        if !method.bytes().all(|b| b.is_ascii_alphanumeric()) || method.is_empty() {
            return Err("invalid Telegram method".into());
        }
        for attempt in 0..max_attempts.max(1) {
            let reply = self.http.request(
                &format!("{}/{method}", self.endpoint),
                Some(&payload.to_string()),
                &[("content-type", "application/json")],
                None,
                false,
            );
            let failure = match reply {
                Ok(response) => {
                    let value: Value = serde_json::from_str(&response.body).unwrap_or(Value::Null);
                    if (200..300).contains(&response.status) && value["ok"] == true {
                        return Ok(value["result"].clone());
                    }
                    let description = value["description"].as_str().unwrap_or("").to_string();
                    let lower = description.to_lowercase();
                    if (method == "editMessageText" && lower.contains("message is not modified"))
                        || (method == "answerCallbackQuery"
                            && (lower.contains("query is too old")
                                || lower.contains("query id is invalid")))
                    {
                        return Ok(Value::Null);
                    }
                    Failure {
                        code: "ERR_TELEGRAM_API",
                        status: response.status,
                        retry_after_ms: if response.status == 429 {
                            Some(
                                value["parameters"]["retry_after"]
                                    .as_u64()
                                    .unwrap_or(1)
                                    .max(1)
                                    .saturating_mul(1000),
                            )
                        } else {
                            None
                        },
                        description,
                    }
                }
                Err(error) => {
                    if self.http.stop.load(Ordering::Relaxed) {
                        return Err(error);
                    }
                    Failure {
                        code: "ERR_HTTP_TRANSPORT",
                        status: 0,
                        retry_after_ms: None,
                        description: String::new(),
                    }
                }
            };
            if attempt + 1 >= max_attempts
                || (failure.status != 0 && failure.status != 429 && failure.status < 500)
            {
                return Err(Box::new(failure));
            }
            let delay = failure.retry_after_ms.unwrap_or_else(|| {
                self.retry_base_ms
                    .saturating_mul(1_u64 << attempt.min(20))
                    .min(self.retry_max_ms)
            });
            wait(&self.http.stop, Duration::from_millis(delay))?;
        }
        Err("Telegram attempts exhausted".into())
    }
}

pub struct Source {
    pub http: Http,
    pub origin: String,
    pub cookie: PathBuf,
    pub next_request: Instant,
    pub impersonate: bool,
}
impl Source {
    pub fn fetch(&mut self, path: &str) -> Result<Response> {
        wait(
            &self.http.stop,
            self.next_request.saturating_duration_since(Instant::now()),
        )?;
        let result = self.fetch_inner(path);
        self.next_request = Instant::now() + Duration::from_secs(2);
        result
    }
    fn fetch_inner(&self, path: &str) -> Result<Response> {
        let metadata = fs::symlink_metadata(&self.cookie)?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.len() > LIMIT
        {
            return Err("unsafe List.am cookie file".into());
        }
        fs::set_permissions(&self.cookie, fs::Permissions::from_mode(0o600))?;
        let id = REQUEST_ID.fetch_add(1, Ordering::Relaxed);
        let temporary = Temporary(
            self.http
                .directory
                .join(format!(".native-cookie-{}-{id}", std::process::id())),
        );
        fs::create_dir(&temporary.0)?;
        fs::set_permissions(&temporary.0, fs::Permissions::from_mode(0o700))?;
        let cookie = temporary.0.join("cookies");
        fs::copy(&self.cookie, &cookie)?;
        let origin = url::Url::parse(&self.origin)?;
        let mut url = origin.join(path)?;
        let start = Instant::now();
        for redirect in 0..=5 {
            if url.origin() != origin.origin()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("List.am redirect crossed origin".into());
            }
            let remaining = self
                .http
                .timeout_ms
                .saturating_sub(start.elapsed().as_millis() as u64);
            if remaining == 0 {
                return Err("List.am request timed out".into());
            }
            let mut request = self.http.clone();
            request.timeout_ms = remaining;
            let response =
                request.request(url.as_str(), None, &[], Some(&cookie), self.impersonate)?;
            let text = response.body.to_lowercase();
            if response
                .headers
                .get("cf-mitigated")
                .is_some_and(|s| s.eq_ignore_ascii_case("challenge"))
                || ((text.contains("/cdn-cgi/challenge-platform/") || text.contains("_cf_chl_opt"))
                    && [
                        "just a moment",
                        "verify you are human",
                        "checking your browser",
                        "enable javascript and cookies",
                    ]
                    .iter()
                    .any(|marker| text.contains(marker)))
            {
                return Err(Box::new(Failure {
                    code: "ERR_LIST_AM_CHALLENGE",
                    status: response.status,
                    retry_after_ms: retry_after(&response.headers),
                    description: String::new(),
                }));
            }
            if [301, 302, 303, 307, 308].contains(&response.status)
                && let Some(location) = response.headers.get("location")
            {
                if redirect == 5 {
                    return Err("List.am redirect limit exceeded".into());
                }
                url = url.join(location)?;
                continue;
            }
            let details = fs::symlink_metadata(&cookie)?;
            if !details.is_file() || details.nlink() != 1 || details.len() > LIMIT {
                return Err("unsafe List.am response cookies".into());
            }
            fs::set_permissions(&cookie, fs::Permissions::from_mode(0o600))?;
            fs::rename(&cookie, &self.cookie)?;
            if !(200..300).contains(&response.status) {
                return Err(Box::new(Failure {
                    code: "ERR_LIST_AM_TRANSPORT",
                    status: response.status,
                    retry_after_ms: retry_after(&response.headers),
                    description: String::new(),
                }));
            }
            return Ok(response);
        }
        Err("List.am redirect limit exceeded".into())
    }
}
fn retry_after(headers: &BTreeMap<String, String>) -> Option<u64> {
    let value = headers.get("retry-after")?;
    if let Ok(seconds) = value.parse::<u64>() {
        return seconds.checked_mul(1000);
    }
    let time = chrono::DateTime::parse_from_rfc2822(value)
        .ok()?
        .timestamp_millis();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    (time >= now).then_some((time - now) as u64)
}

pub fn local_endpoint(value: &str) -> Result<String> {
    let url = url::Url::parse(value)?;
    if url.scheme() != "http"
        || ![Some("127.0.0.1"), Some("[::1]")].contains(&url.host_str())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("test peers must use loopback HTTP".into());
    }
    Ok(value.trim_end_matches('/').to_string())
}

pub fn from_config(config: &Config, stop: Arc<AtomicBool>) -> Http {
    Http {
        executable: config.text("curlImpersonatePath").into(),
        directory: config.text("dataDirectory").into(),
        stop,
        timeout_ms: config.number("timeoutMs"),
    }
}
pub fn contract(value: &Value) -> Result<Value> {
    let endpoint = local_endpoint(value["endpoint"].as_str().ok_or("missing test endpoint")?)?;
    let http = Http {
        executable: value["executable"]
            .as_str()
            .unwrap_or("/usr/bin/curl")
            .into(),
        directory: value["directory"]
            .as_str()
            .ok_or("missing test directory")?
            .into(),
        stop: Arc::new(AtomicBool::new(false)),
        timeout_ms: 3000,
    };
    Telegram {
        http,
        endpoint,
        retry_base_ms: 10,
        retry_max_ms: 100,
    }
    .call(
        value["method"].as_str().unwrap_or("getMe"),
        value.get("payload").unwrap_or(&json!({})),
        4,
    )
}
