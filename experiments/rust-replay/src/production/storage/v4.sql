
  CREATE TABLE private_delivery_decisions_compact (
    recipient_id TEXT NOT NULL,
    item_id TEXT NOT NULL CHECK(length(item_id) > 0),
    status INTEGER NOT NULL CHECK(status IN (0, 1, 2)),
    decided_at INTEGER NOT NULL CHECK(decided_at BETWEEN -8640000000000000 AND 8640000000000000),
    PRIMARY KEY(recipient_id, item_id),
    FOREIGN KEY(recipient_id) REFERENCES private_recipients(recipient_id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
