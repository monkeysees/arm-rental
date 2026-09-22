use crate::{
    Result,
    model::{Listing, Manifest},
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const HISTORY_PAYLOAD_LIMIT: usize = 128;
const WRITE_DECISION: &str = "INSERT INTO decisions VALUES(?,?,?,?,?) ON CONFLICT(user,id) DO UPDATE SET status=excluded.status,revision=excluded.revision,at=excluded.at";

fn classify_history(
    tx: &Transaction<'_>,
    m: &Manifest,
    users: usize,
    now: i64,
) -> Result<(usize, usize)> {
    let mut recent = tx.prepare("SELECT l.id,l.revision FROM listings l LEFT JOIN decisions d ON d.user=? AND d.id=l.id WHERE l.posted>=? AND (d.revision IS NULL OR d.revision!=l.revision) ORDER BY l.posted DESC,l.id DESC")?;
    let mut payload = tx.prepare("SELECT payload FROM listings WHERE id=?")?;
    let mut write = tx.prepare(WRITE_DECISION)?;
    let mut cache: HashMap<i64, Listing> = HashMap::new();
    let (mut decoded, mut peak) = (0, 0);
    for user in 0..users {
        // Finish the decision-dependent cursor before mutating its source table.
        let keys = recent
            .query_map(params![user as i64, now - 86400000], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut matches = 0;
        for (id, revision) in keys {
            if !cache.contains_key(&id) {
                if cache.len() == HISTORY_PAYLOAD_LIMIT {
                    cache.clear();
                }
                let text: String = payload.query_row([id], |r| r.get(0))?;
                cache.insert(id, serde_json::from_str(&text)?);
                decoded += 1;
                peak = peak.max(cache.len());
            }
            let status = if m.recipients.filters_by_group[user % 4].matches(&cache[&id]) {
                matches += 1;
                if matches > m.initial_delivery_limit {
                    Decision::Skipped
                } else {
                    Decision::Pending
                }
            } else {
                Decision::Filtered
            };
            write.execute(params![user as i64, id, status as i64, revision, now])?;
        }
    }
    // Listings cannot change within this transaction; no cache survives a crawl.
    Ok((decoded, peak))
}

#[derive(Clone, Copy)]
#[repr(i64)]
pub(crate) enum Decision {
    Pending = 0,
    Notified = 1,
    Filtered = 2,
    Skipped = 3,
}
impl Decision {
    fn name(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Notified => "notified",
            Self::Filtered => "filtered",
            Self::Skipped => "skipped",
        }
    }
    fn from_code(code: i64) -> Result<Self> {
        [Self::Pending, Self::Notified, Self::Filtered, Self::Skipped]
            .into_iter()
            .find(|status| *status as i64 == code)
            .ok_or_else(|| "invalid decision".into())
    }
}

pub struct Store {
    pub db: Connection,
    pub path: PathBuf,
    pub storage: std::cell::RefCell<Vec<serde_json::Value>>,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        // A rejected read-write connection can checkpoint a committed WAL on close.
        // Validate existing state read-only before acquiring any writable connection.
        if path.metadata().is_ok_and(|m| m.len() > 0) {
            let existing =
                Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            crate::schema::validate_current(&existing)?;
        }
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        crate::schema::open(&db)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=4194304; PRAGMA cache_size=-512;")?;
        Ok(Self {
            db,
            path: path.to_path_buf(),
            storage: std::cell::RefCell::new(Vec::new()),
        })
    }
    pub fn crawl(&mut self, list: Vec<Listing>) -> Result<Vec<Listing>> {
        let started = Instant::now();
        let tx = self.db.transaction()?;
        let mut changed = Vec::new();
        {
            let mut read = tx.prepare_cached("SELECT payload,revision FROM listings WHERE id=?")?;
            let mut write = tx.prepare_cached("INSERT INTO listings VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,posted=excluded.posted")?;
            for listing in list {
                let payload = serde_json::to_string(&listing)?;
                let old: Option<(String, i64)> = read
                    .query_row([&listing.id], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()?;
                if old.as_ref().is_some_and(|(p, _)| p == &payload) {
                    continue;
                }
                let revision = old.map_or(1, |(_, r)| r + 1);
                write.execute(params![listing.id, payload, revision, listing.posted_at])?;
                changed.push(listing);
            }
        }
        let write_ms = started.elapsed().as_secs_f64() * 1000.0;
        let committed = Instant::now();
        tx.commit()?;
        self.storage.borrow_mut().push(serde_json::json!({"operation":"crawl","rows":changed.len(),"writeMs":write_ms,"commitMs":committed.elapsed().as_secs_f64()*1000.0,"walBytes":self.wal_bytes()}));
        if self.wal_bytes() >= crate::bulk::WAL_RETAIN_BYTES {
            self.checkpoint("crawl")?;
        }
        Ok(changed)
    }
    pub fn classify(
        &mut self,
        m: &Manifest,
        users: usize,
        changed: &[Listing],
        catchup: bool,
        now: i64,
    ) -> Result<()> {
        let started = Instant::now();
        let tx = self.db.transaction()?;
        let initial_changes = tx.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))?;
        let (decoded, peak) = if catchup {
            classify_history(&tx, m, users, now)?
        } else {
            let mut revision = tx.prepare("SELECT revision FROM listings WHERE id=?")?;
            let mut previous =
                tx.prepare("SELECT revision FROM decisions WHERE user=? AND id=?")?;
            let mut write = tx.prepare(WRITE_DECISION)?;
            for user in 0..users {
                let mut items: Vec<(Listing, i64, Decision)> = Vec::new();
                for l in changed {
                    if l.posted_at < now - 86400000 {
                        continue;
                    }
                    let rev: i64 = revision.query_row([&l.id], |r| r.get(0))?;
                    let old: Option<i64> = previous
                        .query_row(params![user as i64, l.id], |r| r.get(0))
                        .optional()?;
                    if old == Some(rev) {
                        continue;
                    }
                    items.push((l.clone(), rev, Decision::Pending));
                }
                items.sort_by(|a, b| (a.0.posted_at, &a.0.id).cmp(&(b.0.posted_at, &b.0.id)));
                for (listing, _, status) in items.iter_mut().rev() {
                    *status = if m.recipients.filters_by_group[user % 4].matches(listing) {
                        Decision::Pending
                    } else {
                        Decision::Filtered
                    };
                }
                for (l, rev, status) in items {
                    write.execute(params![user as i64, l.id, status as i64, rev, now])?;
                }
            }
            (0, 0)
        };
        let rows =
            tx.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))? - initial_changes;
        let write_ms = started.elapsed().as_secs_f64() * 1000.0;
        let committed = Instant::now();
        tx.commit()?;
        self.storage.borrow_mut().push(serde_json::json!({"operation":"classify","rows":rows,"writeMs":write_ms,"commitMs":committed.elapsed().as_secs_f64()*1000.0,"walBytes":self.wal_bytes(),"historyPayloadsDecoded":decoded,"peakHistoryPayloads":peak}));
        if self.wal_bytes() >= crate::bulk::WAL_RETAIN_BYTES {
            self.checkpoint("classification-before-delivery")?;
        }
        Ok(())
    }
    pub fn next(&self, user: usize) -> Result<Option<Listing>> {
        let payload: Option<String> = self.db.prepare_cached("SELECT l.payload FROM decisions d JOIN listings l ON l.id=d.id WHERE d.user=? AND d.status=0 ORDER BY l.posted,l.id LIMIT 1")?.query_row([user as i64], |r| r.get(0)).optional()?;
        payload.map(|p| Ok(serde_json::from_str(&p)?)).transpose()
    }
    pub fn acknowledge(&self, user: usize, id: &str, now: i64) -> Result<()> {
        if self
            .db
            .prepare_cached(
                "UPDATE decisions SET status=1,at=? WHERE user=? AND id=? AND status=0",
            )?
            .execute(params![now, user as i64, id])?
            != 1
        {
            return Err("acknowledgement must change one pending decision".into());
        }
        if self.wal_bytes() >= crate::bulk::WAL_RETAIN_BYTES {
            self.checkpoint("acknowledgement")?;
        }
        Ok(())
    }
    pub fn classifications(&self, user: usize, ids: &[String]) -> Result<BTreeMap<String, String>> {
        let mut query = self
            .db
            .prepare_cached("SELECT status FROM decisions WHERE user=? AND id=?")?;
        ids.iter()
            .map(|id| {
                let status: i64 = query.query_row(params![user as i64, id], |r| r.get(0))?;
                let name = Decision::from_code(status)?.name();
                Ok((id.clone(), name.to_string()))
            })
            .collect()
    }
}
