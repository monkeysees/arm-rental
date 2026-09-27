import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const image = `ghcr.io/example/arm-rental@sha256:${"a".repeat(64)}`;
const revision = "b".repeat(40);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "deploy-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "bundle");
  const imageRoot = join(root, "image");
  const sources = join(root, "sources");
  const operations = join(root, "operations");
  const bin = join(root, "bin");
  await Promise.all(
    [bundle, imageRoot, sources, operations, bin].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const sourceContents = {
    "Dockerfile.native": `FROM rust:1.94.0-bookworm@sha256:${"f".repeat(64)} AS build\n`,
    "compose.production.yaml": "services: {bot: {}}\n",
    "experiments/rust-replay/Cargo.toml": "[package]\nname='example'\n",
    "experiments/rust-replay/Cargo.lock": "# locked crates\n",
    "experiments/rust-replay/src/main.rs": "fn main() {}\n",
    "experiments/rust-replay/src/production/configuration.json": "{}\n",
    "experiments/rust-replay/src/production/storage/001.sql":
      "CREATE TABLE example (id INTEGER);\n",
    "experiments/production-image/assemble": "#!/bin/bash\n",
    "experiments/production-image/licenses": "#!/bin/bash\n",
    "ops/compose.native.yaml": "services: {bot: {user: '1000:1000'}}\n",
    "scripts/install-curl-impersonate": "#!/bin/bash\n",
    "scripts/curl-impersonate-version":
      "# pinned assets\nCURL_IMPERSONATE_VERSION=2.2.2\nCURL_IMPERSONATE_AMD64_SHA256=example\n",
  };
  const sourcePaths = Object.keys(sourceContents).sort();
  for (const [path, contents] of Object.entries(sourceContents)) {
    const destination = join(sources, path);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, contents);
  }
  const sourceManifest = {
    files: sourcePaths.map((path) => ({
      path,
      sha256: sha(sourceContents[path]),
    })),
    kind: "source-inputs",
    schemaVersion: 1,
  };
  const sourceManifestText = `${JSON.stringify(sourceManifest)}\n`;
  await writeFile(join(bundle, "source-inputs.json"), sourceManifestText);
  await execute("tar", [
    "--create",
    `--file=${join(imageRoot, "source-inputs.tar")}`,
    "--directory",
    sources,
    ...sourcePaths,
  ]);

  const transportContents = {
    "etc/nsswitch.conf": "hosts: files dns\n",
    "etc/ssl/certs/ca-certificates.crt": "certificate\n",
    "lib/x86_64-linux-gnu/libssl.so.3": "library\n",
    "lib64/ld-linux-x86-64.so.2": "dynamic loader\n",
    "usr/local/bin/curl-impersonate": "curl executable\n",
  };
  const transportPaths = Object.keys(transportContents).sort();
  for (const [path, contents] of Object.entries(transportContents)) {
    const destination = join(imageRoot, path);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, contents);
  }
  const transportManifestText = `${JSON.stringify({
    files: transportPaths.map((path) => ({
      path,
      sha256: sha(transportContents[path]),
    })),
    kind: "transport-files",
    schemaVersion: 1,
  })}\n`;
  await writeFile(join(bundle, "transport-files.json"), transportManifestText);
  await mkdir(join(imageRoot, "usr/local/bin"), { recursive: true });
  await mkdir(join(imageRoot, "usr/local/share/licenses/rental-app"), {
    recursive: true,
  });
  await mkdir(join(imageRoot, "usr/local/share/native-image"), {
    recursive: true,
  });
  await writeFile(
    join(imageRoot, "usr/local/bin/rental-app"),
    "Rust executable\n",
  );
  await writeFile(
    join(imageRoot, "usr/local/share/licenses/rental-app/Cargo.lock"),
    sourceContents["experiments/rust-replay/Cargo.lock"],
  );
  await writeFile(
    join(imageRoot, "usr/local/share/native-image/libraries.txt"),
    "/lib/x86_64-linux-gnu/libssl.so.3\n/lib64/ld-linux-x86-64.so.2\n",
  );
  await writeFile(
    join(imageRoot, "usr/local/share/native-image/source-inputs.tar"),
    await readFile(join(imageRoot, "source-inputs.tar")),
  );
  await writeFile(
    join(bundle, "compose.production.yaml"),
    sourceContents["compose.production.yaml"],
  );
  await mkdir(join(operations, "ops"), { recursive: true });
  await mkdir(join(operations, "ops/lib"), { recursive: true });
  await mkdir(join(operations, "infra/systemd"), { recursive: true });
  await writeFile(
    join(operations, "ops/compose.native.yaml"),
    sourceContents["ops/compose.native.yaml"],
  );
  await writeFile(join(operations, "ops/service"), "#!/bin/bash\n", {
    mode: 0o755,
  });
  await writeFile(
    join(operations, "ops/lib/provenance.sh"),
    await readFile(new URL("../ops/lib/provenance.sh", import.meta.url)),
  );
  await writeFile(join(operations, "infra/systemd/bot.service"), "[Unit]\n");
  await execute("tar", [
    "--create",
    `--file=${join(bundle, "operations.tar")}`,
    "--directory",
    operations,
    "ops",
    "infra",
  ]);

  const metadata = {
    schemaVersion: 3,
    provenanceKind: "cargo-source-v1",
    runtime: "rust",
    sourceDirty: false,
    rustVersion: "1.94.0",
    curlImpersonateVersion: "2.2.2",
    deployableStateBackends: ["sqlite"],
    deployableRuntimes: ["node", "rust"],
    cutoverRollbackContract: "preserve-live-state-v1",
    deployableProvenanceContracts: [
      "legacy-package-lock-v2",
      "cargo-source-v3",
    ],
    imageReference: image,
    imageDigest: image.split("@")[1],
    sourceRevision: revision,
    stateBackend: "sqlite",
    minimumStateSchema: 1,
    maximumStateSchema: 6,
    cargoLockSha256: sha(sourceContents["experiments/rust-replay/Cargo.lock"]),
    sourceInputsSha256: sha(sourceManifestText),
    binarySha256: sha("Rust executable\n"),
    curlSha256: sha(transportContents["usr/local/bin/curl-impersonate"]),
    transportClosureSha256: sha(transportManifestText),
    composeSha256: sha(sourceContents["compose.production.yaml"]),
    operationsBundleSha256: sha(await readFile(join(bundle, "operations.tar"))),
  };
  const metadataPath = join(bundle, "release-metadata.json");
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
  await writeFile(
    join(imageRoot, "usr/local/share/native-image/components.json"),
    `${JSON.stringify({
      binarySha256: metadata.binarySha256,
      cargoLockSha256: metadata.cargoLockSha256,
      curlImpersonateVersion: metadata.curlImpersonateVersion,
      curlSha256: metadata.curlSha256,
      runtime: "rust",
      sourceDirty: false,
      sourceInputsSha256: metadata.sourceInputsSha256,
      sourceRevision: revision,
      toolchain: metadata.rustVersion,
      transportClosureSha256: metadata.transportClosureSha256,
    })}\n`,
  );
  const labels = {
    "org.opencontainers.image.revision": revision,
    "com.rental-apartments.runtime": "rust",
    "com.rental-apartments.source.dirty": "false",
    "com.rental-apartments.rust-version": metadata.rustVersion,
    "com.rental-apartments.curl-version": metadata.curlImpersonateVersion,
    "com.rental-apartments.state.backend": "sqlite",
    "com.rental-apartments.state.schema.minimum": "1",
    "com.rental-apartments.state.schema.maximum": "6",
    "com.rental-apartments.cargo-lock.sha256": metadata.cargoLockSha256,
    "com.rental-apartments.source-inputs.sha256": metadata.sourceInputsSha256,
    "com.rental-apartments.binary.sha256": metadata.binarySha256,
    "com.rental-apartments.curl.sha256": metadata.curlSha256,
    "com.rental-apartments.transport-closure.sha256":
      metadata.transportClosureSha256,
  };
  const labelsPath = join(root, "labels.json");
  await writeFile(labelsPath, `${JSON.stringify(labels)}\n`);
  const docker = join(bin, "docker");
  await writeFile(
    docker,
    `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $1 == inspect ]]; then
  jq -r '.["com.rental-apartments.runtime"] // "<no value>"' "$LABELS_JSON"
elif [[ $1 == image && $2 == inspect ]]; then
  if [[ $4 == '{{json .Config.Labels}}' ]]; then
    cat "$LABELS_JSON"
  else
    label=$(printf '%s' "$4" | cut -d '"' -f2)
    jq -r --arg key "$label" '.[$key] // "<no value>"' "$LABELS_JSON"
  fi
elif [[ $1 == create ]]; then
  printf 'fake-container\\n'
elif [[ $1 == cp ]]; then
  source=$(printf '%s' "$2" | cut -d : -f2-)
  cp -- "$IMAGE_ROOT/$source" "$3"
elif [[ $1 == rm ]]; then
  exit 0
else
  exit 90
fi
`,
    { mode: 0o755 },
  );
  await chmod(docker, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    LABELS_JSON: labelsPath,
    IMAGE_ROOT: imageRoot,
  };
  const verify = () =>
    execute(
      "bash",
      [
        "-c",
        `
    set -Eeuo pipefail
    DEPLOYMENT_SOURCE_REVISION=$1
    RENTAL_OPS_STATE_DIR=$2
    source ops/lib/deployment.sh
    deployment_verify_release "$3" "$4" "$5"
  `,
        "v3-verify-test",
        revision,
        root,
        bundle,
        image,
        metadataPath,
      ],
      {
        cwd: new URL("..", import.meta.url),
        env,
      },
    );
  return {
    root,
    bundle,
    imageRoot,
    sources,
    sourcePaths,
    operations,
    metadata,
    metadataPath,
    labels,
    labelsPath,
    env,
    verify,
  };
}

test("Cargo/source-input release verifies exact native payload without package-lock", async (t) => {
  const f = await fixture(t);
  await assert.doesNotReject(f.verify());
  assert.equal(f.metadata.packageLockSha256, undefined);
});

test("legacy Rust release advertises Cargo capability only with its archived verifier", async (t) => {
  const f = await fixture(t);
  const lock = '{"lockfileVersion":3}\n';
  await writeFile(join(f.bundle, "package-lock.json"), lock);
  const legacy = {
    schemaVersion: 2,
    imageReference: image,
    imageDigest: image.split("@")[1],
    sourceRevision: revision,
    stateBackend: "sqlite",
    runtime: "rust",
    minimumStateSchema: 1,
    maximumStateSchema: 6,
    packageLockSha256: sha(lock),
    composeSha256: f.metadata.composeSha256,
    operationsBundleSha256: f.metadata.operationsBundleSha256,
    deployableProvenanceContracts: [
      "legacy-package-lock-v2",
      "cargo-source-v3",
    ],
  };
  f.labels["org.opencontainers.image.package-lock.sha256"] =
    legacy.packageLockSha256;
  await writeFile(f.labelsPath, JSON.stringify(f.labels));
  await writeFile(f.metadataPath, JSON.stringify(legacy));
  await assert.doesNotReject(f.verify());
  await writeFile(
    join(f.operations, "ops/lib/provenance.sh"),
    "#!/bin/bash\n# mismatched verifier\n",
  );
  await execute("tar", [
    "--create",
    `--file=${join(f.bundle, "operations.tar")}`,
    "--directory",
    f.operations,
    "ops",
    "infra",
  ]);
  legacy.operationsBundleSha256 = sha(
    await readFile(join(f.bundle, "operations.tar")),
  );
  await writeFile(f.metadataPath, JSON.stringify(legacy));
  await assert.rejects(f.verify(), (error) => error.code === 65);
});

test("Cargo/source-input release rejects mixed, missing, and mismatched provenance", async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.metadata);
  for (const change of [
    { packageLockSha256: "f".repeat(64) },
    { provenanceKind: "unknown" },
    { runtime: "node" },
    { rustVersion: "0.0.0" },
    { curlImpersonateVersion: "0.0.0" },
    { sourceDirty: true },
    { deployableStateBackends: ["json"] },
    { deployableRuntimes: ["rust"] },
    { cutoverRollbackContract: "unknown" },
    { cargoLockSha256: "f".repeat(64) },
    { sourceInputsSha256: "f".repeat(64) },
    { binarySha256: "f".repeat(64) },
    { curlSha256: "f".repeat(64) },
    { transportClosureSha256: "f".repeat(64) },
    { minimumStateSchema: 0 },
    { composeSha256: "f".repeat(64) },
    { operationsBundleSha256: "f".repeat(64) },
    { unknownProvenanceClaim: "accepted" },
  ]) {
    await writeFile(f.metadataPath, JSON.stringify({ ...original, ...change }));
    await assert.rejects(f.verify(), (error) => error.code === 65);
  }
  await writeFile(f.metadataPath, JSON.stringify(original));
  await writeFile(
    join(f.imageRoot, "usr/local/bin/rental-app"),
    "changed binary\n",
  );
  await assert.rejects(f.verify(), (error) => error.code === 65);
  await writeFile(
    join(f.imageRoot, "usr/local/bin/rental-app"),
    "Rust executable\n",
  );
  f.labels["org.opencontainers.image.package-lock.sha256"] = "";
  await writeFile(f.labelsPath, JSON.stringify(f.labels));
  await assert.rejects(f.verify(), (error) => error.code === 65);
});

test("Cargo/source-input release rejects missing transport and source payload", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.imageRoot, "lib/x86_64-linux-gnu/libssl.so.3"),
    "changed library\n",
  );
  await assert.rejects(f.verify(), (error) => error.code === 65);
  await writeFile(
    join(f.imageRoot, "lib/x86_64-linux-gnu/libssl.so.3"),
    "library\n",
  );
  const manifestPath = join(f.bundle, "source-inputs.json");
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.files = manifest.files.filter(
    ({ path }) => path !== "Dockerfile.native",
  );
  await writeFile(manifestPath, JSON.stringify(manifest));
  const metadata = structuredClone(f.metadata);
  metadata.sourceInputsSha256 = sha(await readFile(manifestPath));
  await writeFile(f.metadataPath, JSON.stringify(metadata));
  f.labels["com.rental-apartments.source-inputs.sha256"] =
    metadata.sourceInputsSha256;
  await writeFile(f.labelsPath, JSON.stringify(f.labels));
  await assert.rejects(f.verify(), (error) => error.code === 65);
});

test("Cargo/source-input release checks JSON, SQL, and the dynamic loader", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(
      f.sources,
      "experiments/rust-replay/src/production/configuration.json",
    ),
    '{"changed":true}\n',
  );
  await execute("tar", [
    "--create",
    `--file=${join(f.imageRoot, "usr/local/share/native-image/source-inputs.tar")}`,
    "--directory",
    f.sources,
    ...f.sourcePaths,
  ]);
  await assert.rejects(f.verify(), (error) => error.code === 65);
  await writeFile(
    join(
      f.sources,
      "experiments/rust-replay/src/production/configuration.json",
    ),
    "{}\n",
  );
  await writeFile(
    join(f.sources, "experiments/rust-replay/src/production/storage/001.sql"),
    "DROP TABLE example;\n",
  );
  await execute("tar", [
    "--create",
    `--file=${join(f.imageRoot, "usr/local/share/native-image/source-inputs.tar")}`,
    "--directory",
    f.sources,
    ...f.sourcePaths,
  ]);
  await assert.rejects(f.verify(), (error) => error.code === 65);
  await writeFile(
    join(f.sources, "experiments/rust-replay/src/production/storage/001.sql"),
    "CREATE TABLE example (id INTEGER);\n",
  );
  await execute("tar", [
    "--create",
    `--file=${join(f.imageRoot, "usr/local/share/native-image/source-inputs.tar")}`,
    "--directory",
    f.sources,
    ...f.sourcePaths,
  ]);
  await writeFile(
    join(f.imageRoot, "lib64/ld-linux-x86-64.so.2"),
    "damaged loader\n",
  );
  await assert.rejects(f.verify(), (error) => error.code === 65);
});

test("cached Cargo release is reverified before reuse, including script mode and artifact set", async (t) => {
  const f = await fixture(t);
  const releases = join(f.root, "releases");
  await mkdir(releases);
  const fetch = () =>
    execute(
      "bash",
      [
        "-c",
        `
    set -Eeuo pipefail
    DEPLOYMENT_SOURCE_REVISION=$1
    RENTAL_OPS_STATE_DIR=$2
    RENTAL_RELEASES_ROOT=$3
    source ops/lib/deployment.sh
    deployment_fetch_release "$4" "$1" "$5" "$6"
  `,
        "v3-cache-test",
        revision,
        f.root,
        releases,
        image,
        f.metadataPath,
        f.bundle,
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: f.env,
      },
    );
  const staged = (await fetch()).stdout.trim();
  assert.equal((await fetch()).stdout.trim(), staged);
  await chmod(join(staged, "ops/service"), 0o640);
  await assert.rejects(fetch(), (error) => error.code === 65);
  await chmod(join(staged, "ops/service"), 0o750);
  await writeFile(
    join(staged, "package-lock.json"),
    "unexpected legacy input\n",
  );
  await assert.rejects(fetch(), (error) => error.code === 65);
  await rm(join(staged, "package-lock.json"));
  await writeFile(join(staged, "release-metadata.json"), "{}\n");
  await assert.rejects(fetch(), (error) => error.code === 65);
});

test("host transition accepts a deployed v2 verifier bridge and refuses provenance downgrade", async (t) => {
  const f = await fixture(t);
  const legacyImage = `ghcr.io/example/arm-rental@sha256:${"c".repeat(64)}`;
  const legacyPath = join(f.root, "legacy.json");
  const markedPath = join(f.root, "marked.json");
  const legacy = {
    schemaVersion: 2,
    imageReference: legacyImage,
    sourceRevision: "d".repeat(40),
    stateBackend: "sqlite",
    runtime: "rust",
    minimumStateSchema: 1,
    maximumStateSchema: 6,
    deployableProvenanceContracts: [
      "legacy-package-lock-v2",
      "cargo-source-v3",
    ],
  };
  const transition = (
    previousPath,
    candidatePath,
    previousImage,
    candidateImage,
  ) =>
    execute(
      "bash",
      [
        "-c",
        `
      set -Eeuo pipefail
      RENTAL_OPS_STATE_DIR=$1
      source ops/lib/deployment.sh
      deployment_state_transition "$2" "$3" "$4" "$5"
    `,
        "v3-transition-test",
        f.root,
        previousPath,
        candidatePath,
        previousImage,
        candidateImage,
      ],
      {
        cwd: new URL("..", import.meta.url),
      },
    );
  await writeFile(legacyPath, JSON.stringify(legacy));
  await writeFile(markedPath, JSON.stringify(legacy));
  assert.equal(
    (
      await transition(legacyPath, f.metadataPath, legacyImage, image)
    ).stdout.trim(),
    "sqlite-to-sqlite",
  );
  delete legacy.deployableProvenanceContracts;
  await writeFile(legacyPath, JSON.stringify(legacy));
  await assert.rejects(
    transition(legacyPath, f.metadataPath, legacyImage, image),
    (error) => error.code === 65 && /cannot verify Cargo/u.test(error.stderr),
  );
  await assert.rejects(
    transition(f.metadataPath, legacyPath, image, legacyImage),
    (error) => error.code === 65 && /downgrade/u.test(error.stderr),
  );
  await assert.rejects(
    transition(markedPath, legacyPath, legacyImage, legacyImage),
    (error) =>
      error.code === 65 &&
      /removes the deployed Cargo provenance/u.test(error.stderr),
  );
  const deploy = await readFile(
    new URL("../ops/deploy", import.meta.url),
    "utf8",
  );
  assert.ok(
    deploy.indexOf("deployment_state_transition ") <
      deploy.indexOf("ops_stop_application\n"),
  );
});
