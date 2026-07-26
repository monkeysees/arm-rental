# Sanitized List.am fixture contract

These fixtures retain reviewed List.am container, promoted-card, regular-card,
and field-wrapper shapes. All listing identities and text are synthetic. Raw
captures must never be committed.

To refresh a fixture, save the source capture outside the repository, then run:

```sh
node scripts/sanitize-list-am-fixture.js /secure/path/source.html \
  test/fixtures/list-am-real-shape/regular-page.html
```

Review the result for structure only, update its SHA-256 in `manifest.json`,
and run `node --test test/list-am-fixture.test.js`. The contract rejects
unreviewed files, checksum drift, external URLs, email addresses, phone-like
numbers, scripts, forms, media, non-synthetic item IDs outside the reserved
`999999990000000`–`999999990999999` fixture namespace, unreviewed classes, and
forbidden secret or identity markers.
