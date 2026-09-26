# Disposable Node-to-Rust cutover drill

This drill tests the packaged Node rollback image and packaged Rust candidate on
one synthetic SQLite data mount. It does not read production credentials, pull
from a registry, move the `production` pointer, or contact the VPS. Rust
containers contact temporary HTTP peers on local loopback; the Node service
contacts those same peers through a local TLS proxy. Use immutable local image
IDs or locally built tags:

```bash
docker build --platform linux/amd64 --target production \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  --build-arg PACKAGE_LOCK_SHA256="$(sha256sum package-lock.json | cut -d ' ' -f 1)" \
  --tag arm-rental-cutover-node:local .
docker build -f Dockerfile.native --platform linux/amd64 --target production \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  --build-arg SOURCE_DIRTY=false \
  --build-arg CARGO_LOCK_SHA256="$(sha256sum experiments/rust-replay/Cargo.lock | cut -d ' ' -f 1)" \
  --build-arg PACKAGE_LOCK_SHA256="$(sha256sum package-lock.json | cut -d ' ' -f 1)" \
  --tag arm-rental-cutover-native:local .
python3 experiments/native-cutover/run.py \
  --node-image arm-rental-cutover-node:local \
  --native-image arm-rental-cutover-native:local \
  --output /tmp/arm-rental-cutover-new-run
```

The output path must be new and absolute. The runner checks the images' runtime
and SQLite labels, seeds the frozen Node schema-v5 fixture, gives it a current
synthetic CBA snapshot, and uses the Node image to migrate and create a validated
predeploy backup on a separate mount. It then proves that a Rust candidate with
a failing Telegram identity preflight cannot crawl, restores the matching Node
snapshot and checks every database row, and starts the accepted Rust candidate
on the same data mount. Readiness, source integrity, crawl success, a new
acknowledged private delivery, the prior Node acknowledgement, and Telegram
offset continuity are checked against local peers. The Node service is started
after each restore through a local TLS proxy for its fixed HTTPS origins;
unproxied requests to those origins resolve to loopback and cannot reach live
services. It must become ready, crawl, and retain the prior Node acknowledgement
and Telegram offset. The runner also restarts Node directly on compatible live
schema-6 state after Rust has acknowledged a new listing, then compares that
with a restore from the older predeploy snapshot.

`report.json` contains image IDs, source and binary identity, fixture hash,
snapshot path and passed checks. It contains no tokens or peer request bodies.
Keep the report from the final accepted candidate image as review evidence. The
host's systemd units, operations lock, mounted backup filesystem, running bridge
revision, discovery pointer, and live delivery receipts require separate host
verification and operator-approved promotion.

The predeploy snapshot predates any work accepted by Rust. In the disposable
drill, Node did not resend that new work when restarted against the live
schema-6 state, but it **did resend it after restoring the predeploy snapshot**.
The current unattended `ops/deploy` failure path always restores that snapshot
before restarting Node. Keep the prior Node image and snapshot for recovery,
and review this duplicate risk explicitly before authorizing a live cutover.
This drill does not establish duplicate-free rollback after Rust has sent new
work.
