use crate::{
    Result,
    model::{Listing, Manifest, timestamp},
};
use rusqlite::{Connection, OptionalExtension, params};
use std::{collections::BTreeMap, path::Path, time::Duration};

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
                        if id % 4 == (user % 4) as i64 { 1 } else { 2 },
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
                let mut items: Vec<(Listing, i64, i64)> = Vec::new();
                if catchup {
                    let mut rows = recent.query(params![user as i64, now - 86400000])?;
                    while let Some(row) = rows.next()? {
                        items.push((
                            serde_json::from_str(&row.get::<_, String>(0)?)?,
                            row.get(1)?,
                            0,
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
                        items.push((l.clone(), rev, 0));
                    }
                    items.sort_by(|a, b| (a.0.posted_at, &a.0.id).cmp(&(b.0.posted_at, &b.0.id)));
                }
                let mut matches = 0;
                for (listing, _, status) in items.iter_mut().rev() {
                    *status = if m.recipients.filters_by_group[user % 4].matches(listing) {
                        matches += 1;
                        if catchup && matches > m.initial_delivery_limit {
                            3
                        } else {
                            0
                        }
                    } else {
                        2
                    };
                }
                for (l, rev, status) in items {
                    write.execute(params![user as i64, l.id, status, rev, now])?;
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
                let status: u32 = query.query_row(params![user as i64, id], |r| r.get(0))?;
                let name = ["pending", "notified", "filtered", "skipped"]
                    .get(status as usize)
                    .ok_or("invalid decision")?;
                Ok((id.clone(), name.to_string()))
            })
            .collect()
    }
}
