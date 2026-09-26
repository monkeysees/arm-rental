//! Transform only the unpublished copy. A killed process never changes the source.
use crate::{Result, maintenance::stop_at, schema};
use rusqlite::{Connection, params};

pub const BATCH_ROWS: usize = 8192;

pub fn upgrade(db: &mut Connection, stop: Option<&str>) -> Result<()> {
    let tx = db.transaction()?;
    tx.execute_batch("DROP INDEX pending; ALTER TABLE decisions RENAME TO legacy_decisions")?;
    tx.execute_batch(schema::DECISIONS)?;
    let (mut user, mut id) = (-1_i64, -1_i64);
    loop {
        let rows = tx.execute(
            "INSERT INTO decisions SELECT * FROM legacy_decisions WHERE (user,id)>(?1,?2) ORDER BY user,id LIMIT ?3",
            params![user, id, BATCH_ROWS as i64],
        )?;
        if rows == 0 {
            break;
        }
        stop_at(stop, "during-migration");
        (user, id) = tx.query_row(
            "SELECT user,id FROM decisions ORDER BY user DESC,id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
    }
    // Compare every field and row count through primary-key lookups; no decision table is loaded into RAM.
    let changed: bool = tx.query_row("SELECT (SELECT count(*) FROM legacy_decisions)!=(SELECT count(*) FROM decisions) OR EXISTS(SELECT 1 FROM legacy_decisions old LEFT JOIN decisions new USING(user,id) WHERE new.id IS NULL OR old.status!=new.status OR old.revision!=new.revision OR old.at!=new.at)", [], |r| r.get(0))?;
    if changed {
        return Err("migration changed delivery decisions".into());
    }
    tx.execute_batch("DROP TABLE legacy_decisions")?;
    tx.execute_batch(schema::PENDING)?;
    tx.pragma_update(None, "user_version", schema::VERSION)?;
    tx.pragma_update(None, "application_id", schema::APPLICATION_ID)?;
    stop_at(stop, "before-migration-commit");
    tx.commit()?;
    stop_at(stop, "after-migration");
    Ok(())
}
