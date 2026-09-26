use super::{Result, config::Config, lease::Lease};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

fn root(path: &Path) -> Result<fs::Metadata> {
    if path.parent().is_none() || fs::canonicalize(path)? != path {
        return Err("unsafe cleanup directory".into());
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Err("cleanup root is not a directory".into());
    }
    Ok(metadata)
}

fn mounts(candidate: &Path) -> Result<()> {
    let source = fs::read_to_string("/proc/self/mountinfo")?;
    if source.trim().is_empty() {
        return Err("cannot verify profile mount boundaries".into());
    }
    for line in source.lines() {
        let fields: Vec<_> = line.split(' ').collect();
        if fields.len() < 10 || !fields.contains(&"-") || !fields[4].starts_with('/') {
            return Err("cannot verify profile mount boundaries".into());
        }
        let mut decoded = Vec::new();
        let bytes = fields[4].as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'\\'
                && i + 3 < bytes.len()
                && bytes[i + 1..i + 4]
                    .iter()
                    .all(|b| (b'0'..=b'7').contains(b))
            {
                decoded.push(
                    (bytes[i + 1] - b'0') * 64 + (bytes[i + 2] - b'0') * 8 + bytes[i + 3] - b'0',
                );
                i += 4;
            } else {
                decoded.push(bytes[i]);
                i += 1;
            }
        }
        use std::os::unix::ffi::OsStringExt;
        if PathBuf::from(std::ffi::OsString::from_vec(decoded)).starts_with(candidate) {
            return Err("unsafe mounted profile entry".into());
        }
    }
    Ok(())
}

fn inspect(
    path: &Path,
    owner: &fs::Metadata,
    entries: &mut Vec<(PathBuf, fs::Metadata)>,
    top: bool,
) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Err(error) if top && error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        result => result?,
    };
    if metadata.uid() != owner.uid()
        || metadata.dev() != owner.dev()
        || metadata.is_symlink()
        || !(metadata.is_file() || metadata.is_dir())
        || (metadata.is_file() && metadata.nlink() != 1)
        || (top && !metadata.is_dir())
    {
        return Err("unsafe or ambiguously owned profile entry".into());
    }
    if metadata.is_dir() {
        let mut children = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            inspect(&child.path(), owner, entries, false)?;
        }
    }
    entries.push((path.to_owned(), metadata));
    Ok(())
}

fn bytes(path: &Path, device: u64) -> Result<u64> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_symlink()
        || metadata.dev() != device
        || !(metadata.is_file() || metadata.is_dir())
    {
        return Err("unsafe backup entry".into());
    }
    let mut total = metadata.blocks() * 512;
    if metadata.is_dir() {
        for child in fs::read_dir(path)? {
            total += bytes(&child?.path(), device)?;
        }
    }
    Ok(total)
}

pub fn run(config: &Config, mode: &str) -> Result<Value> {
    if mode == "--backup-report" {
        let directory = Path::new(config.text("backupDirectory"));
        let owner = root(directory)?;
        let retained = bytes(directory, owner.dev())?;
        let mut snapshots = Vec::new();
        let mut totals = [0u64; 3];
        for category in ["daily", "weekly", "protected"] {
            let children = match fs::read_dir(directory.join(category)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                result => result?,
            };
            let mut children = children.collect::<std::io::Result<Vec<_>>>()?;
            children.sort_by_key(|entry| entry.file_name());
            for child in children {
                let path = child.path();
                let manifest = match fs::read(path.join("manifest.json")) {
                    Ok(content) => serde_json::from_slice::<Value>(&content).unwrap_or(Value::Null),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
                    Err(error) => return Err(error.into()),
                };
                let browser = manifest["hashes"].as_object().is_some_and(|hashes| {
                    hashes.keys().any(|key| {
                        let key = key.to_lowercase();
                        key.contains("chrome-profile") || key.contains("chromium")
                    })
                });
                let index = if browser {
                    0
                } else if manifest["version"] == 3 {
                    1
                } else {
                    2
                };
                let size = bytes(&path, owner.dev())?;
                totals[index] += size;
                let kind = ["legacy-browser", "browser-free", "legacy-or-unknown"][index];
                snapshots.push(json!({"path":path,"kind":kind,"bytes":size}));
            }
        }
        return Ok(
            json!({"event":"browser-cleanup.backup-usage","retainedBackupBytes":retained,"snapshots":snapshots,"legacyBrowserBytes":totals[0],"browserFreeBytes":totals[1],"legacyOrUnknownBytes":totals[2]}),
        );
    }
    if !["--dry-run", "--apply"].contains(&mode) {
        return Err("invalid browser cleanup option".into());
    }
    let directory = Path::new(config.text("dataDirectory"));
    let owner = root(directory)?;
    if owner.uid() != unsafe { libc::getuid() } {
        return Err("data directory is not owned by the service account".into());
    }
    let _lease = Lease::acquire(directory)?;
    let candidate = directory.join("chrome-profile");
    mounts(&candidate)?;
    let mut entries = Vec::new();
    inspect(&candidate, &owner, &mut entries, true)?;
    let candidate_bytes: u64 = entries
        .iter()
        .map(|(_, metadata)| metadata.blocks() * 512)
        .sum();
    if mode == "--apply" {
        for (path, original) in &entries {
            mounts(&candidate)?;
            let current = fs::symlink_metadata(path)?;
            if current.ino() != original.ino()
                || current.dev() != original.dev()
                || current.uid() != original.uid()
                || current.mode() != original.mode()
                || (current.is_file() && current.nlink() != 1)
            {
                return Err("profile changed during cleanup".into());
            }
            if original.is_dir() {
                fs::remove_dir(path)?;
            } else {
                fs::remove_file(path)?;
            }
        }
    }
    Ok(
        json!({"event":"browser-cleanup.report","mode":if mode=="--apply"{"apply"}else{"dry-run"},"candidate":candidate,"paths":entries.iter().map(|(path,_)|path).collect::<Vec<_>>(),"candidateBytes":candidate_bytes,"reclaimedBytes":if mode=="--apply"{candidate_bytes}else{0},"missing":entries.is_empty()}),
    )
}
