
    ALTER TABLE apartments ADD COLUMN kind TEXT NOT NULL DEFAULT 'apartment' CHECK(kind IN ('apartment', 'house'));
    ALTER TABLE apartments ADD COLUMN date_bucket TEXT NOT NULL DEFAULT 'fixed' CHECK(date_bucket IN ('fixed', 'relative', 'annual'));
    ALTER TABLE apartments ADD COLUMN posting_date_key INTEGER;
    ALTER TABLE apartments ADD COLUMN posting_date TEXT;
    ALTER TABLE apartments ADD COLUMN encounter_sequence INTEGER NOT NULL DEFAULT 0 CHECK(encounter_sequence >= 0);
    ALTER TABLE apartments ADD COLUMN encounter_position INTEGER NOT NULL DEFAULT 0 CHECK(encounter_position >= 0);
    ALTER TABLE apartments ADD COLUMN last_seen_at TEXT;
    ALTER TABLE crawl_state ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence >= 0);
    ALTER TABLE crawl_state ADD COLUMN total_count INTEGER NOT NULL DEFAULT 0 CHECK(total_count >= 0);
