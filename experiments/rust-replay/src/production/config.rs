use super::Result;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

pub const TEMPLATE: &str =
    "https://www.list.am/ru/category/56/{page}?n=0&cmtype=0&crc=0&gl=2&srt=3";
pub const HOUSE_TEMPLATE: &str =
    "https://www.list.am/ru/category/1377/{page}?n=0&cmtype=0&crc=0&gl=2&srt=3";

#[derive(Clone)]
pub struct Config {
    pub values: Value,
}

fn resolve(cwd: &Path, value: &str) -> PathBuf {
    let input = cwd.join(value);
    let mut output = PathBuf::new();
    for part in input.components() {
        match part {
            Component::ParentDir => {
                output.pop();
            }
            Component::CurDir => {}
            _ => output.push(part),
        }
    }
    output
}

fn number(text: &str) -> Result<f64> {
    let text = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            return Ok(u64::from_str_radix(digits, radix).map_err(|_| "invalid number")? as f64);
        }
    }
    if text.is_empty() {
        return Ok(0.0);
    }
    Ok(text.parse::<f64>().map_err(|_| "invalid number")?)
}

fn integer(text: &str, name: &str, min: u64, max: u64) -> Result<Value> {
    let number = number(text).map_err(|_| format!("{name} must be an integer"))?;
    if !number.is_finite() || number.fract() != 0.0 || number < min as f64 || number > max as f64 {
        return Err(format!("{name} must be an integer from {min} through {max}").into());
    }
    Ok(json!(number as u64))
}

impl Config {
    pub fn validate_startup(&self) -> Result<()> {
        use std::{
            fs::{self, OpenOptions},
            io::Write,
            os::unix::fs::{OpenOptionsExt, PermissionsExt},
        };
        let directory = Path::new(self.text("dataDirectory"));
        super::lease::secure_directory(directory)?;
        let canonical = fs::canonicalize(directory)?;
        for key in [
            "apartmentsStateFile",
            "deliveryStateFile",
            "channelDeliveryStateFile",
            "exchangeRatesStateFile",
            "telegramStateFile",
            "listAmCookieFile",
        ] {
            let file = Path::new(self.text(key));
            let parent = file.parent().ok_or("invalid managed path")?;
            super::lease::secure_directory(parent)?;
            let real = fs::canonicalize(parent)?;
            if !real.starts_with(&canonical) {
                return Err(format!("{key} resolves outside DATA_DIRECTORY").into());
            }
            match fs::symlink_metadata(file) {
                Ok(metadata) => {
                    if !metadata.is_file() || metadata.file_type().is_symlink() {
                        return Err(format!("{key} is not a safe regular file").into());
                    }
                    fs::set_permissions(file, fs::Permissions::from_mode(0o600))?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(error.into()),
            }
        }
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let probe = directory.join(format!(
            ".configuration-write-probe.{}-{nonce}",
            std::process::id()
        ));
        let renamed = probe.with_extension("renamed");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&probe)?;
        let result = (|| -> Result<()> {
            file.write_all(b"persistent storage probe\n")?;
            file.sync_all()?;
            drop(file);
            fs::rename(&probe, &renamed)?;
            fs::remove_file(&renamed)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&probe);
            let _ = fs::remove_file(&renamed);
        }
        result
    }
    pub fn get(&self, key: &str) -> &Value {
        &self.values[key]
    }
    pub fn text(&self, key: &str) -> &str {
        self.get(key).as_str().unwrap_or("")
    }
    pub fn number(&self, key: &str) -> u64 {
        self.get(key).as_u64().unwrap_or(0)
    }
    pub fn authorized(&self, id: i64) -> bool {
        id > 0
            && (self.get("telegramOwnerId").as_i64() == Some(id)
                || self.text("telegramAccessMode") == "public"
                || self
                    .get("telegramAllowedUserIds")
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|value| value.as_i64() == Some(id))))
    }
    pub fn from_environment() -> Result<Self> {
        // Read only known configuration names; unrelated environment secrets stay untouched.
        let catalog: Vec<Value> = serde_json::from_str(include_str!("configuration.json"))?;
        let mut env = json!({});
        for entry in catalog {
            let name = entry["name"]
                .as_str()
                .ok_or("invalid configuration catalog")?;
            if let Ok(value) = std::env::var(name) {
                env[name] = json!(value);
            }
        }
        Self::parse(&env, &std::env::current_dir()?)
    }
    pub fn parse(env: &Value, cwd: &Path) -> Result<Self> {
        let catalog: Vec<Value> = serde_json::from_str(include_str!("configuration.json"))?;
        let supplied = |name: &str| env[name].as_str().filter(|value| !value.is_empty());
        let mode = supplied("NODE_ENV").unwrap_or("development").trim();
        if !["development", "test", "production"].contains(&mode) {
            return Err("NODE_ENV is invalid".into());
        }
        let directory = resolve(cwd, supplied("DATA_DIRECTORY").unwrap_or(".data"));
        if directory.parent().is_none() {
            return Err("DATA_DIRECTORY must not be the filesystem root".into());
        }
        let mut values = json!({});
        for entry in &catalog {
            let name = entry["name"].as_str().ok_or("invalid configuration name")?;
            let key = entry["configKey"]
                .as_str()
                .ok_or("invalid configuration key")?;
            if (entry["required"] == true
                || (mode == "production" && entry["productionExplicit"] == true))
                && supplied(name).is_none_or(|value| value.trim().is_empty())
            {
                return Err(format!("{name} is required").into());
            }
            let default_path = entry["relativeToDataDirectory"]
                .as_str()
                .map(|path| directory.join(path));
            let raw = supplied(name)
                .or_else(|| default_path.as_ref().and_then(|path| path.to_str()))
                .or_else(|| entry["defaultValue"].as_str())
                .unwrap_or("");
            let kind = entry["type"].as_str().unwrap_or("");
            values[key] = match kind {
                "positive safe integer" => integer(raw, name, 1, 9_007_199_254_740_991)?,
                "bounded integer" => {
                    let (min, max) = match name {
                        "TELEGRAM_USER_UPDATES_PER_MINUTE" => (5, 120),
                        "TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE" => (1, 30),
                        "EXTERNAL_RETRY_MAX_MS" => (1, 300_000),
                        "BACKUP_DAILY_RETENTION" => (7, 9_007_199_254_740_991),
                        "BACKUP_WEEKLY_RETENTION" => (4, 9_007_199_254_740_991),
                        _ => return Err("unknown bounded configuration".into()),
                    };
                    integer(raw, name, min, max)?
                }
                "TCP port" => integer(raw, name, 1, 65535)?,
                "percentage" => {
                    let value = number(raw).map_err(|_| "invalid disk warning percentage")?;
                    if !value.is_finite() || value <= 0.0 || value >= 100.0 {
                        return Err("invalid disk warning percentage".into());
                    }
                    json!(value)
                }
                "path" if name == "CURL_IMPERSONATE_PATH" => json!(raw.trim()),
                "path" if name == "BACKUP_DIRECTORY" && raw.trim().is_empty() => Value::Null,
                "path" => json!(resolve(cwd, raw)),
                "positive safe integer list" => {
                    let mut ids = Vec::new();
                    let mut seen = HashSet::new();
                    if !raw.trim().is_empty() {
                        for item in raw.split(',').map(str::trim) {
                            if item.starts_with('0')
                                || item.is_empty()
                                || !item.bytes().all(|b| b.is_ascii_digit())
                            {
                                return Err(
                                    "TELEGRAM_ALLOWED_USER_IDS must contain unique positive IDs"
                                        .into(),
                                );
                            }
                            let value = integer(item, name, 1, 9_007_199_254_740_991)?;
                            if !seen.insert(value.to_string()) {
                                return Err(
                                    "TELEGRAM_ALLOWED_USER_IDS contains duplicate IDs".into()
                                );
                            }
                            ids.push(value);
                        }
                    }
                    json!(ids)
                }
                _ => json!(raw.trim()),
            };
        }
        let access = values["telegramAccessMode"].as_str().unwrap_or("");
        let ids = values["telegramAllowedUserIds"]
            .as_array()
            .ok_or("invalid allowed IDs")?;
        if !["public", "owner", "allowlist"].contains(&access)
            || (access == "allowlist") == ids.is_empty()
            || ids.contains(&values["telegramOwnerId"])
        {
            return Err("Invalid Telegram access policy".into());
        }
        let channel = values["telegramChannelId"].as_str().unwrap_or("");
        if !channel.is_empty()
            && !regex::Regex::new(r"(?i)^@[a-z][a-z0-9_]{4,31}$")?.is_match(channel)
        {
            return Err("TELEGRAM_CHANNEL_ID must be a public Telegram username".into());
        }
        if channel.is_empty() {
            values["telegramChannelId"] = Value::Null;
        }
        if !["127.0.0.1", "::1"].contains(&values["healthHost"].as_str().unwrap_or("")) {
            return Err("HEALTH_HOST must be loopback".into());
        }
        if values["externalRetryBaseMs"].as_u64() > values["externalRetryMaxMs"].as_u64() {
            return Err("EXTERNAL_RETRY_BASE_MS exceeds EXTERNAL_RETRY_MAX_MS".into());
        }
        if mode == "production"
            && !Path::new(values["curlImpersonatePath"].as_str().unwrap_or("")).is_absolute()
        {
            return Err("CURL_IMPERSONATE_PATH must be absolute in production".into());
        }
        let keys = [
            "apartmentsStateFile",
            "deliveryStateFile",
            "channelDeliveryStateFile",
            "exchangeRatesStateFile",
            "telegramStateFile",
            "listAmCookieFile",
        ];
        let reserved = [
            "state.sqlite3",
            "state.sqlite3-wal",
            "state.sqlite3-shm",
            ".maintenance-history.json",
            ".singleton.json",
            ".singleton.sock",
            ".singleton-recovery",
        ];
        let mut paths: Vec<PathBuf> = Vec::new();
        for key in keys {
            let path = PathBuf::from(values[key].as_str().ok_or("invalid path")?);
            if path == directory
                || !path.starts_with(&directory)
                || (path.parent() == Some(directory.as_path())
                    && path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .is_some_and(|name| reserved.contains(&name)))
                || paths
                    .iter()
                    .any(|previous| path.starts_with(previous) || previous.starts_with(&path))
            {
                return Err(format!("{key} conflicts with a managed runtime path").into());
            }
            paths.push(path);
        }
        if let Some(backup) = values["backupDirectory"].as_str() {
            let backup = Path::new(backup);
            if backup.starts_with(&directory) || directory.starts_with(backup) {
                return Err("BACKUP_DIRECTORY must be independent".into());
            }
        } else {
            values.as_object_mut().unwrap().remove("backupDirectory");
        }
        values["listUrlTemplate"] = json!(TEMPLATE);
        values["listSources"] = json!([{"kind":"apartment","urlTemplate":TEMPLATE},{"kind":"house","urlTemplate":HOUSE_TEMPLATE}]);
        values["diskFreeWarningFraction"] =
            json!(values["diskFreeWarningPercent"].as_f64().unwrap() / 100.0);
        values
            .as_object_mut()
            .unwrap()
            .remove("diskFreeWarningPercent");
        values["channelFilters"] = super::filters::parse_channel(
            values["channelFilterPriceAmd"].as_str().unwrap_or(""),
            values["channelFilterRooms"].as_str().unwrap_or(""),
            values["channelFilterLocations"].as_str().unwrap_or(""),
        )?;
        for key in [
            "channelFilterPriceAmd",
            "channelFilterRooms",
            "channelFilterLocations",
        ] {
            values.as_object_mut().unwrap().remove(key);
        }
        Ok(Self { values })
    }
}
