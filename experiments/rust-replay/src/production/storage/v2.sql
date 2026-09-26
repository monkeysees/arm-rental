
  UPDATE apartments
    SET payload_json = json_set(payload_json, '$.kind', 'apartment')
    WHERE json_extract(payload_json, '$.kind') IS NULL;

  UPDATE telegram_users
    SET filters_json = json_set(filters_json, '$.kinds', json_array('apartment'))
    WHERE json_extract(filters_json, '$.kinds') IS NULL;

  UPDATE crawl_state
    SET source_integrity_json = json_set(
      source_integrity_json,
      '$.recentFirstPageCounts',
      json_object(
        'apartment',
        json(json_extract(source_integrity_json, '$.recentFirstPageCounts'))
      )
    )
    WHERE json_type(source_integrity_json, '$.recentFirstPageCounts') = 'array';
