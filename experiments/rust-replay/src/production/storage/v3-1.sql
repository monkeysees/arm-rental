
    UPDATE crawl_state SET total_count = (SELECT count(*) FROM apartments);
    ALTER TABLE crawl_state DROP COLUMN apartment_order_json;
    CREATE INDEX apartments_watermark_idx ON apartments(kind, date_bucket, posting_date_key DESC);
    CREATE INDEX apartments_encounter_order_idx ON apartments(encounter_sequence DESC, encounter_position ASC);
    CREATE INDEX apartments_legacy_price_idx ON apartments(item_id)
      WHERE json_type(payload_json, '$.price.amountAmd') IS NULL;
