# Sanitized List.am fixture contract

These fixtures retain reviewed List.am container, promoted-card, regular-card,
and field-wrapper shapes. All listing identities and text are synthetic. Raw
captures must never be committed.

`regular-page-redesign.html` is the shape List.am published on 2026-09-03:
cards are `a.category-data-list-card__destination`, the location has its own
`.l` element, the attribute line separates rooms, area, and floor with "·",
and the date names a calendar day. It also keeps the advertising banner and
the pagination anchors that sit among the cards, because a card selector that
matches those is what stopped the crawl. `regular-page.html` is the shape the
categories carried before it.

To refresh a fixture, save the source capture outside the repository, then run:

```sh
node scripts/sanitize-list-am-fixture.js /secure/path/source.html \
  test/fixtures/list-am-real-shape/regular-page-redesign.html
```

Review the result for structure only, update its SHA-256 in `manifest.json`,
and run `node --test test/list-am-fixture.test.js`. The contract rejects
unreviewed files, checksum drift, external URLs, email addresses, phone-like
numbers, scripts, forms, media, non-synthetic item IDs outside the reserved
`999999990000000`–`999999990999999` fixture namespace, unreviewed classes, and
forbidden secret or identity markers.
