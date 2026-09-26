use crate::{
    Result,
    model::{Manifest, timestamp},
    store::{Decision, Store},
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};
use std::{fs, path::Path, time::Instant};

pub const SEED_BATCH_ROWS: usize = 8192;
pub const WAL_RETAIN_BYTES: u64 = 4 * 1024 * 1024;

fn contract(m: &Manifest, users: usize) -> Result<String> {
    Ok(serde_json::to_string(&(
        users,
        &m.seed.timestamp,
        &m.seed_decisions.listing_ids,
        &m.seed_decisions.absent_ids,
    ))?)
}

pub fn validate_seed(path: &Path, m: &Manifest, users: usize, complete: bool) -> Result<()> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let input: String =
        db.query_row("SELECT input FROM seed_input WHERE id=1", [], |r| r.get(0))?;
    if input != contract(m, users)? {
        return Err("seed input differs from durable import contract".into());
    }
    let (next, consumed): (usize, bool) = db.query_row(
        "SELECT next_row,consumed FROM seed_progress WHERE id=1",
        [],
        |r| Ok((r.get::<_, u32>(0)? as usize, r.get(1)?)),
    )?;
    let total = users * (m.seed_decisions.listing_ids.len() + m.seed_decisions.absent_ids.len());
    if next > total || consumed || (complete && next != total) {
        return Err("seed is incomplete, invalid, or already consumed by exercise".into());
    }
    Ok(())
}

// Explicit process-death injection is confined to the seed CLI, never delivery.
pub struct SeedStop {
    point: String,
    row: usize,
}
impl SeedStop {
    pub fn parse(value: &str) -> Result<Self> {
        let (point, row) = value
            .split_once(':')
            .ok_or("use POINT:ROW for --seed-stop")?;
        if !["before-commit", "after-commit", "after-checkpoint"].contains(&point) {
            return Err("unknown seed stop point".into());
        }
        Ok(Self {
            point: point.into(),
            row: row.parse()?,
        })
    }
    fn exit_at(stop: Option<&Self>, point: &str, row: usize) {
        if stop.is_some_and(|s| s.point == point && s.row == row) {
            eprintln!("{}", json!({"seedStop": point, "row": row}));
            std::process::exit(25);
        }
    }
}

impl Store {
    pub fn wal_bytes(&self) -> u64 {
        fs::metadata(format!("{}-wal", self.path.display()))
            .map(|m| m.len())
            .unwrap_or(0)
    }

    pub fn checkpoint(&self, boundary: &str) -> Result<()> {
        let before = self.wal_bytes();
        let start = Instant::now();
        let (busy, log, done): (i64, i64, i64) =
            self.db
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?;
        let metric = json!({"operation":"checkpoint", "boundary":boundary,
            "wallMs":start.elapsed().as_secs_f64()*1000.0,"busy":busy,
            "logPages":log,"checkpointedPages":done,"walBeforeBytes":before,"walAfterBytes":self.wal_bytes()});
        if busy != 0 {
            eprintln!("{metric}");
            return Err(
                "checkpoint blocked by reader; stop writes and retry after reader closes".into(),
            );
        }
        self.storage.borrow_mut().push(metric);
        Ok(())
    }

    pub fn seed(&mut self, m: &Manifest, users: usize, stop: Option<&SeedStop>) -> Result<()> {
        let input = contract(m, users)?;
        let existing: Option<String> = self
            .db
            .query_row("SELECT input FROM seed_input WHERE id=1", [], |r| r.get(0))
            .optional()?;
        if let Some(existing) = existing {
            if existing != input {
                return Err("seed input differs from durable import contract".into());
            }
        } else {
            let tx = self.db.transaction()?;
            tx.execute("INSERT INTO seed_input VALUES(1,?)", [&input])?;
            tx.execute("INSERT INTO seed_progress VALUES(1,0,0)", [])?;
            tx.commit()?;
        }
        let (mut next, consumed): (usize, bool) = self.db.query_row(
            "SELECT next_row,consumed FROM seed_progress WHERE id=1",
            [],
            |r| Ok((r.get::<_, u32>(0)? as usize, r.get(1)?)),
        )?;
        if consumed {
            return Err("seed already consumed by exercise".into());
        }
        let per_user = m.seed_decisions.listing_ids.len() + m.seed_decisions.absent_ids.len();
        let total = users * per_user;
        if per_user != m.seed.decisions_per_recipient || per_user == 0 || next > total {
            return Err("invalid seed dimensions or progress".into());
        }
        let stamp = timestamp(&m.seed.timestamp)?;
        let mut batches = 0;
        let mut write_ms = 0.0;
        let mut commit_ms = 0.0;
        let mut max_wal = self.wal_bytes();
        let first = next;
        while next < total {
            // A previous process may have died after commit but before checkpoint.
            if self.wal_bytes() >= WAL_RETAIN_BYTES {
                self.checkpoint("seed-batch")?;
            }
            let end = (next + SEED_BATCH_ROWS).min(total);
            let start = Instant::now();
            let tx = self.db.transaction()?;
            {
                let mut insert = tx.prepare("INSERT INTO decisions VALUES(?,?,?,?,?)")?;
                for offset in next..end {
                    let user = offset / per_user;
                    let index = offset % per_user;
                    let id: i64 = if index < m.seed_decisions.listing_ids.len() {
                        &m.seed_decisions.listing_ids[index]
                    } else {
                        &m.seed_decisions.absent_ids[index - m.seed_decisions.listing_ids.len()]
                    }
                    .parse()?;
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
            // Rows and progress are one durable commit; an uncommitted batch replays in full.
            tx.execute(
                "UPDATE seed_progress SET next_row=? WHERE id=1",
                [end as i64],
            )?;
            write_ms += start.elapsed().as_secs_f64() * 1000.0;
            SeedStop::exit_at(stop, "before-commit", end);
            let start = Instant::now();
            tx.commit()?;
            commit_ms += start.elapsed().as_secs_f64() * 1000.0;
            max_wal = max_wal.max(self.wal_bytes());
            SeedStop::exit_at(stop, "after-commit", end);
            next = end;
            batches += 1;
        }
        self.checkpoint("seed-complete")?;
        SeedStop::exit_at(stop, "after-checkpoint", next);
        self.storage.borrow_mut().push(
            json!({"operation":"seed", "rows":next-first,"totalRows":total,
            "batches":batches,"batchRowLimit":SEED_BATCH_ROWS,"writeMs":write_ms,
            "commitMs":commit_ms,"maxWalBytes":max_wal}),
        );
        Ok(())
    }

    pub fn consume_seed(&mut self) -> Result<()> {
        if self.db.execute(
            "UPDATE seed_progress SET consumed=1 WHERE id=1 AND consumed=0",
            [],
        )? != 1
        {
            return Err("seed already consumed by exercise".into());
        }
        Ok(())
    }

    pub fn storage_report(&self) -> Value {
        json!({"seedBatchRows":SEED_BATCH_ROWS,"walAutocheckpointPages":1000,
            "journalSizeLimitBytes":WAL_RETAIN_BYTES,"synchronous":"FULL","operations":*self.storage.borrow()})
    }
}
