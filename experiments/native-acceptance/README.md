# Native production acceptance fixtures

This directory supplies read-only inputs and expected results for the packaged
`rental-app` acceptance checks. The runner creates disposable state and local
HTTP peers. It must not import the Node application, run a Node process, or use
the candidate Rust application to generate expected values.

## Provenance

The frozen Node production source is commit
`b5a4f09cebf62999af06e35e8f132c9e9dc45e12` on `main`. Its schema and formatting
sources were byte-identical to the working branch at fixture capture and
review (`git diff --quiet b5a4f09cebf62999af06e35e8f132c9e9dc45e12 --`
followed by the paths below returned zero). The `src/` paths below refer to
that archived Node source, which is no longer in the active tree.

`fixtures/schema-v1-populated.sql` uses the Node `SCHEMA_V1` physical schema
from the archived `src/sqlite-schema.js`.
The inserted identities and history decisions were hand-authored synthetic
data. Versions 2–5 were obtained by applying, in order, the Node baseline's
version-2 SQL and `migrateIncrementalCrawl`, `migrateCompactDecisions`, and
`migrateIncrementalPrivate` functions, then exporting each completed SQLite
database as plain SQL. No Rust migration or output was used to make these
inputs. The scripts explicitly set application ID and schema version, contain
the same two listings, one recipient, three decisions (including an absent
listing), an exchange-rate snapshot, and update offset 42. Version 1's filter
and source-integrity records lack housing kinds; the Node version-2 migration
adds them. Versions 4 and 5 have completed the Node decision compaction.

`fixtures/expected.json` records the reviewed post-upgrade state: application
and target identity, schema ledger, retained IDs, decision status codes and
exact millisecond timestamps, exchange rate, and update offset. Its values
come from the synthetic input and the documented Node schema contract, not
from running Rust. The source URL template is the exact Node target identity
in `src/target.js`; changing it must be an explicit compatibility decision.
The `rowsBySourceVersion` section was captured by opening each frozen SQL input
with the frozen Node baseline under Node 24.18.0 and exporting every column of
all 14 application tables after its upgrade. The only normalized values are
`applied_at` and `source_revision` in migration-ledger rows created after the
input schema version; the runner still validates their timestamp syntax and
nonempty revision. Ledger rows already present in the SQL input stay exact.

`fixtures/service-expected.json` records a separate two-card service scenario:
an apartment priced at 100,000 AMD, a house priced at 500 USD with a fixed
400 AMD/USD CBA quote, private chat 123, and channel `@test_channel`. Exact
Telegram text was produced once with the frozen Node
`formatApartmentMessage`, `formatChannelApartmentMessage`, and
`normalizeApartmentPrice` implementations in `src/telegram.js`,
`src/channel.js`, and `src/prices.js`, then reviewed and committed. The U+00A0
grouping space in the AMD price and the channel hashtags are intentional.
The expected channel edit changes only the apartment title and keeps its
publication identity. The house is a private delivery and is excluded from
the apartment-only channel.

`fixtures/contract-expected.json` freezes 122 inputs and Node outputs from the
existing Rust differential scenarios for source parsing, posting dates, CBA
rates and prices, filters, source integrity, configuration, Russian message
formatting, and four complete Telegram update conversations. The outputs were
captured with Node v24.18.0 from pure Node source files at the frozen
`b5a4f09cebf62999af06e35e8f132c9e9dc45e12` revision; those files are
byte-identical at capture time. The two large sanitized HTML inputs remain in
`test/fixtures/list-am-real-shape/` and are bound by SHA-256 in each case.
Invalid configurations and a missing Regular Ads section intentionally compare
error presence and token redaction because the Rust CLI uses safe error codes
rather than Node's prose. Telegram cases compare exact Node state and Bot API
operations; the Rust-only outcome array is checked structurally.

## Integrity and use

`fixtures/manifest.json` contains a SHA-256 digest for every other file in
`fixtures/`. A runner must verify that the listed names are the complete file
set and that every digest matches before it creates state or starts the app.
It must load the SQL and JSON as fixed inputs and write all generated databases,
peer traffic, and reports outside the fixture directory. CI must fail on a
missing, extra, or changed fixture; it must never refresh expected results from
candidate output. An intentional baseline change requires a reviewed diff of
the affected fixture, its derivation, and the manifest in one change.

For each schema input, create a fresh mode-0700 directory and mode-0600
`state.sqlite3`, execute its SQL with SQLite, and run packaged
`rental-app state:validate`. Assert the version-6 state against
`expected.json`, including every row and the absence of additional rows.
Run wrong-target, wrong-application-ID, and newer-schema checks on separate
copies and verify that rejection leaves the source unchanged. The service
scenario uses only synthetic local List.am, CBA, and Telegram peers; assert
the observed HTTP payloads and durable state against `service-expected.json`.
Feed the frozen contract cases to the packaged app's `contract` command in one
newline-delimited stream and compare every response before the service scenario.

These fixtures cover every supported upgrade entry version and a
representative retained-state shape. The separate, frozen
`experiments/native-capacity/` gate covers the 500-recipient contract. The
native runner's report identifies the source revision, packaged image digest,
binary hash, fixture hashes, and complementary native checks. The process,
delivery, crawl, lifecycle and Rust rollback checks are separate commands in
the Node-free development and CI gate.
