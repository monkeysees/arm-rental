# Disposable Rust rollback drill

This drill runs the packaged Rust image against one synthetic SQLite mount and
an independent backup mount. It uses only local HTTP peers and the frozen,
reviewed schema-v5 fixture under `experiments/native-acceptance/fixtures/`.
The image must already be built; no registry or production host is contacted.

```bash
PYTHONDONTWRITEBYTECODE=1 python3 experiments/native-cutover/rust_rollback.py \
  --image "$(docker image inspect --format '{{.Id}}' my-rust-image:local)" \
  --output /tmp/arm-rental-rust-rollback-new-run
```

The output path must be a new absolute directory. The runner upgrades the
populated fixture, validates a fresh snapshot, and starts the Rust service with
a failed Telegram identity check. It verifies that the failed start neither
crawled nor changed SQLite rows. A restart on compatible live state crawls,
preserves the existing acknowledgement and Telegram offset, and acknowledges
one new listing. A second restart sends no duplicate. An explicit restore of
the older snapshot replays that post-snapshot listing, demonstrating why
automatic recovery must prefer compatible live state when safe.

`report.json` records the exact local image ID, source revision, packaged binary
hash, frozen fixture hash, snapshot path and seven completed checks. It contains
no token or peer request body. The exercise uses one image for the failed and
recovered starts. Host systemd, the operations lock, immutable registry
pointer, retained prior image, and deployment receipts need separate host or
controller evidence.
