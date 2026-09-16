use crate::{
    Result,
    model::{Listing, Manifest, timestamp},
};
use rusqlite::{Connection, OptionalExtension, params};
use std::{collections::BTreeMap, path::Path, time::Duration};

#[derive(Clone, Copy)]
#[repr(i64)]
enum Decision {
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
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS listings(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL,posted INTEGER NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS decisions(user INTEGER NOT NULL,id INTEGER NOT NULL,status INTEGER NOT NULL,revision INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(user,id)) WITHOUT ROWID, STRICT;
            CREATE INDEX IF NOT EXISTS pending ON decisions(user,status,id) WHERE status=0;
            CREATE INDEX IF NOT EXISTS recent ON listings(posted,id);")?;
        Ok(Self { db })
    }
    pub fn crawl(&mut self, list: Vec<Listing>) -> Result<Vec<Listing>> {
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
        tx.commit()?;
        Ok(changed)
    }
    pub fn seed(&mut self, m: &Manifest, users: usize) -> Result<()> {
        let stamp = timestamp(&m.seed.timestamp)?;
        let tx = self.db.transaction()?;
        {
            let mut insert = tx.prepare("INSERT INTO decisions VALUES(?,?,?,?,?)")?;
            for user in 0..users {
                for id in m
                    .seed_decisions
                    .listing_ids
                    .iter()
                    .chain(&m.seed_decisions.absent_ids)
                {
                    let id: i64 = id.parse()?;
                    insert.execute(params![
                        user as i64,
                        id,
                        (if id % 4 == (user % 4) as i64 {
                            Decision::Notified
                        } else {
                            Decision::Filtered
                        }) as i64,
                        1,
                        stamp
                    ])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn classify(
        &mut self,
        m: &Manifest,
        users: usize,
        changed: &[Listing],
        catchup: bool,
        now: i64,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        {
            let mut recent = tx.prepare("SELECT l.payload,l.revision FROM listings l LEFT JOIN decisions d ON d.user=? AND d.id=l.id WHERE l.posted>=? AND (d.revision IS NULL OR d.revision!=l.revision) ORDER BY l.posted,l.id")?;
            let mut revision = tx.prepare("SELECT revision FROM listings WHERE id=?")?;
            let mut previous =
                tx.prepare("SELECT revision FROM decisions WHERE user=? AND id=?")?;
            let mut write = tx.prepare("INSERT INTO decisions VALUES(?,?,?,?,?) ON CONFLICT(user,id) DO UPDATE SET status=excluded.status,revision=excluded.revision,at=excluded.at")?;
            for user in 0..users {
                let mut items: Vec<(Listing, i64, Decision)> = Vec::new();
                if catchup {
                    let mut rows = recent.query(params![user as i64, now - 86400000])?;
                    while let Some(row) = rows.next()? {
                        items.push((
                            serde_json::from_str(&row.get::<_, String>(0)?)?,
                            row.get(1)?,
                            Decision::Pending,
                        ));
                    }
                } else {
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
                }
                let mut matches = 0;
                for (listing, _, status) in items.iter_mut().rev() {
                    *status = if m.recipients.filters_by_group[user % 4].matches(listing) {
                        matches += 1;
                        if catchup && matches > m.initial_delivery_limit {
                            Decision::Skipped
                        } else {
                            Decision::Pending
                        }
                    } else {
                        Decision::Filtered
                    };
                }
                for (l, rev, status) in items {
                    write.execute(params![user as i64, l.id, status as i64, rev, now])?;
                }
            }
        }
        tx.commit()?;
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
