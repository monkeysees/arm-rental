use super::{Result, storage::now_iso};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime},
};

pub struct Lease {
    directory: PathBuf,
    identity: (u64, u64),
    owner: Value,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
fn live(path: &Path) -> Result<bool> {
    match UnixStream::connect(path) {
        Ok(stream) => {
            stream.set_read_timeout(Some(Duration::from_millis(250)))?;
            let mut owner = Vec::new();
            let _ = stream.take(4096).read_to_end(&mut owner);
            Ok(true)
        }
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}
pub fn secure_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    let details = fs::symlink_metadata(path)?;
    if !details.is_dir() || details.file_type().is_symlink() {
        return Err("persistent path must be a real directory".into());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
impl Lease {
    pub fn acquire(directory: &Path) -> Result<Self> {
        secure_directory(directory)?;
        let directory = fs::canonicalize(directory)?;
        let socket = directory.join(".singleton.sock");
        if socket.as_os_str().len() > 100 {
            return Err("data directory exceeds singleton socket path limit".into());
        }
        let recovery = directory.join(".singleton-recovery");
        let listener = loop {
            match UnixListener::bind(&socket) {
                Ok(listener) => break listener,
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                    if live(&socket)? {
                        return Err("ERR_SINGLETON_LOCKED".into());
                    }
                    match fs::create_dir(&recovery) {
                        Ok(()) => {
                            let recovered = (|| -> Result<()> {
                                if !live(&socket)? {
                                    match fs::remove_file(&socket) {
                                        Ok(()) => (),
                                        Err(error)
                                            if error.kind() == std::io::ErrorKind::NotFound => {}
                                        Err(error) => return Err(error.into()),
                                    }
                                }
                                Ok(())
                            })();
                            let _ = fs::remove_dir(&recovery);
                            recovered?;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                            let details = fs::symlink_metadata(&recovery)?;
                            if !details.is_dir() || details.file_type().is_symlink() {
                                return Err("unsafe singleton recovery path".into());
                            }
                            if SystemTime::now()
                                .duration_since(details.modified()?)
                                .unwrap_or_default()
                                > Duration::from_secs(10)
                            {
                                let _ = fs::remove_dir(&recovery);
                            }
                            thread::sleep(Duration::from_millis(50));
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
                Err(error) => return Err(error.into()),
            }
        };
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
        let details = fs::symlink_metadata(&socket)?;
        let owner = json!({"id":format!("{}-{}",std::process::id(),now_iso()),"pid":std::process::id(),"hostname":fs::read_to_string("/proc/sys/kernel/hostname")?.trim(),"startedAt":now_iso()});
        let metadata = directory.join(format!(".singleton.{}.tmp", std::process::id()));
        let write = (|| -> Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&metadata)?;
            file.write_all(owner.to_string().as_bytes())?;
            file.sync_all()?;
            fs::rename(&metadata, directory.join(".singleton.json"))?;
            Ok(())
        })();
        if let Err(error) = write {
            let _ = fs::remove_file(&socket);
            let _ = fs::remove_file(&metadata);
            return Err(error);
        }
        listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let reply = owner.to_string();
        let worker = thread::spawn(move || {
            while !worker_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut client, _)) => {
                        let _ = client.set_write_timeout(Some(Duration::from_millis(100)));
                        let _ = client.write_all(reply.as_bytes());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            directory,
            identity: (details.dev(), details.ino()),
            owner,
            stop,
            worker: Some(worker),
        })
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let socket = self.directory.join(".singleton.sock");
        if fs::symlink_metadata(&socket).is_ok_and(|m| (m.dev(), m.ino()) == self.identity) {
            let _ = fs::remove_file(socket);
        }
        let metadata = self.directory.join(".singleton.json");
        if fs::read_to_string(&metadata)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .is_some_and(|value| value["id"] == self.owner["id"])
        {
            let _ = fs::remove_file(metadata);
        }
    }
}
