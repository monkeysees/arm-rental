import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const projectRoot = new URL("../", import.meta.url).pathname;
const cleanup = join(projectRoot, "ops/image-cleanup");
const digest = (character) =>
  `ghcr.io/example/arm-rental@sha256:${character.repeat(64)}`;
const imageId = (character) => `sha256:${character.repeat(64)}`;

async function executable(filename, contents) {
  await writeFile(filename, contents);
  await chmod(filename, 0o755);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "rental-image-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const state = join(root, "state");
  await execute("mkdir", ["-p", bin, state]);
  const current = digest("a");
  const previous = digest("b");
  const oldest = digest("c");
  const revisions = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
  await writeFile(
    join(state, "current-image.env"),
    `RENTAL_APARTMENTS_IMAGE=${current}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(state, "deployment-retention.json"),
    JSON.stringify({
      schemaVersion: 1,
      minimumRetainedReleases: 3,
      retainedReleases: [current, previous, oldest].map(
        (candidateImage, index) => ({
          candidateImage,
          sourceRevision: revisions[index],
          completedAt: `2026-07-2${7 - index}T12:00:00Z`,
        }),
      ),
    }),
    { mode: 0o600 },
  );

  const ids = {
    current: imageId("1"),
    previous: imageId("2"),
    oldest: imageId("3"),
    stale: imageId("4"),
    currentMetadata: imageId("5"),
    previousMetadata: imageId("6"),
    oldestMetadata: imageId("7"),
    staleMetadata: imageId("8"),
    unrelated: imageId("9"),
  };
  const application = (id, revision, reference) => ({
    Id: id,
    Size: 1_000_000_000,
    RepoTags: [],
    RepoDigests: [reference],
    Config: {
      Labels: {
        "org.opencontainers.image.title": "rental-apartments-bot",
        "org.opencontainers.image.revision": revision,
      },
    },
  });
  const metadata = (id, revision) => ({
    Id: id,
    Size: 250_000,
    RepoTags: [`ghcr.io/example/arm-rental:metadata-${revision}`],
    RepoDigests: [],
    Config: { Labels: {} },
  });
  const inventory = join(root, "inventory.json");
  await writeFile(
    inventory,
    JSON.stringify([
      application(ids.current, revisions[0], current),
      application(ids.previous, revisions[1], previous),
      application(ids.oldest, revisions[2], oldest),
      application(ids.stale, "d".repeat(40), digest("d")),
      metadata(ids.currentMetadata, revisions[0]),
      metadata(ids.previousMetadata, revisions[1]),
      metadata(ids.oldestMetadata, revisions[2]),
      metadata(ids.staleMetadata, "d".repeat(40)),
      {
        Id: ids.unrelated,
        Size: 500_000_000,
        RepoTags: ["example/unrelated:latest"],
        RepoDigests: [],
        // A real Docker inspect includes large configuration objects. Keep the
        // fixture above common ARG_MAX values so inventory must be streamed.
        Config: { Labels: { large: "x".repeat(2_500_000) } },
      },
    ]),
  );

  await executable(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
if [[ $1 == image && $2 == inspect && $3 == --format ]]; then
  case $5 in
    '${current}') printf '%s\n' '${ids.current}' ;;
    '${previous}') printf '%s\n' '${ids.previous}' ;;
    '${oldest}') printf '%s\n' '${ids.oldest}' ;;
    'ghcr.io/example/arm-rental:metadata-${revisions[0]}') printf '%s\n' '${ids.currentMetadata}' ;;
    'ghcr.io/example/arm-rental:metadata-${revisions[1]}') printf '%s\n' '${ids.previousMetadata}' ;;
    'ghcr.io/example/arm-rental:metadata-${revisions[2]}') printf '%s\n' '${ids.oldestMetadata}' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [[ $1 == image && $2 == inspect ]]; then
  jq . "$FAKE_IMAGE_INVENTORY"
  exit 0
fi
if [[ $1 == image && $2 == ls ]]; then
  jq -r '.[].Id' "$FAKE_IMAGE_INVENTORY"
  exit 0
fi
if [[ $1 == image && $2 == rm ]]; then
  shift 2
  [[ $1 == -- ]]
  shift
  for id in "$@"; do
    printf '%s\n' "$id" >>"$FAKE_REMOVED_IMAGES"
    temporary=$(mktemp "$FAKE_IMAGE_INVENTORY.XXXXXX")
    jq --arg id "$id" 'map(select(.Id != $id))' \
      "$FAKE_IMAGE_INVENTORY" >"$temporary"
    mv "$temporary" "$FAKE_IMAGE_INVENTORY"
  done
  exit 0
fi
if [[ $1 == container && $2 == ls ]]; then
  printf '%s\n' rental-apartments-bot-id
  exit 0
fi
if [[ $1 == container && $2 == inspect ]]; then
  printf '%s\n' '[{"Image":"${ids.current}"}]'
  exit 0
fi
if [[ $1 == inspect && $2 == --format && $3 == '{{.Image}}' ]]; then
  printf '%s\n' '${ids.current}'
  exit 0
fi
if [[ $1 == inspect && $2 == --format=* ]]; then
  printf '%s\n' healthy
  exit 0
fi
exit 9
`,
  );
  await executable(
    join(bin, "systemd-cat"),
    '#!/bin/sh\ncat >>"$FAKE_SYSTEMD_LOG"\n',
  );
  await executable(
    join(bin, "flock"),
    '#!/bin/sh\nexit "${FAKE_FLOCK_STATUS:-0}"\n',
  );
  await executable(
    join(bin, "df"),
    "#!/bin/sh\nprintf 'Avail\\n10000000000\\n'\n",
  );

  return {
    root,
    state,
    ids,
    removed: join(root, "removed-images"),
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RENTAL_OPS_STATE_DIR: state,
      RENTAL_OPS_LOCK_FILE: join(state, "operations.lock"),
      RENTAL_IMAGE_ENV_FILE: join(state, "current-image.env"),
      RENTAL_DEPLOYMENT_RETENTION_FILE: join(
        state,
        "deployment-retention.json",
      ),
      RENTAL_READY_ATTEMPTS: "1",
      FAKE_DOCKER_LOG: join(root, "docker.log"),
      FAKE_IMAGE_INVENTORY: inventory,
      FAKE_REMOVED_IMAGES: join(root, "removed-images"),
      FAKE_SYSTEMD_LOG: join(root, "systemd.log"),
    },
  };
}

test("image cleanup dry-run and apply preserve rollback images and remove only managed stale images", async (t) => {
  const host = await fixture(t);
  const dryRun = await execute(cleanup, ["--dry-run"], {
    env: host.environment,
  });
  const plan = JSON.parse(dryRun.stdout);
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.removalCount, 2);
  assert.deepEqual(
    plan.removals.map(({ id }) => id),
    [host.ids.stale, host.ids.staleMetadata],
  );
  await assert.rejects(readFile(host.removed, "utf8"), { code: "ENOENT" });

  const applied = await execute(cleanup, [], { env: host.environment });
  assert.deepEqual(JSON.parse(applied.stdout), {
    result: "success",
    removedImageCount: 2,
    candidateVirtualBytes: 1_000_250_000,
    reclaimedBytes: 0,
    availableBytes: 10_000_000_000,
  });
  assert.deepEqual((await readFile(host.removed, "utf8")).trim().split("\n"), [
    host.ids.stale,
    host.ids.staleMetadata,
  ]);
  const calls = await readFile(host.environment.FAKE_DOCKER_LOG, "utf8");
  assert.doesNotMatch(
    calls,
    /system prune|image prune|container rm|volume rm/u,
  );
  const logs = await readFile(host.environment.FAKE_SYSTEMD_LOG, "utf8");
  assert.match(logs, /"event":"image\.cleanup\.planned"/u);
  assert.match(logs, /"event":"image\.cleanup\.completed"/u);
  assert.match(logs, /"event":"image-cleanup\.completed"/u);
});

test("image cleanup fails closed when retention does not protect the current image", async (t) => {
  const host = await fixture(t);
  const retentionFile = host.environment.RENTAL_DEPLOYMENT_RETENTION_FILE;
  const retention = JSON.parse(await readFile(retentionFile, "utf8"));
  retention.retainedReleases.reverse();
  await writeFile(retentionFile, JSON.stringify(retention), { mode: 0o600 });

  await assert.rejects(
    execute(cleanup, ["--dry-run"], { env: host.environment }),
    (error) =>
      error.code === 65 &&
      error.stderr.includes(
        "Deployment retention index is invalid or does not protect current",
      ),
  );
  await assert.rejects(readFile(host.removed, "utf8"), { code: "ENOENT" });
});

test("migration-protected bridge releases remain outside ordinary image pruning", async (t) => {
  const host = await fixture(t);
  const retentionFile = host.environment.RENTAL_DEPLOYMENT_RETENTION_FILE;
  const retention = JSON.parse(await readFile(retentionFile, "utf8"));
  retention.schemaVersion = 2;
  retention.retainedReleases = retention.retainedReleases.slice(0, 2);
  retention.protectedReleases = [
    {
      candidateImage: digest("c"),
      sourceRevision: "c".repeat(40),
      protectedSnapshot:
        "/mnt/rental-apartments-backups/protected/pre-sqlite-bridge",
      protectedAt: "2026-08-18T12:00:00Z",
    },
  ];
  await writeFile(retentionFile, JSON.stringify(retention), { mode: 0o600 });

  const dryRun = await execute(cleanup, ["--dry-run"], {
    env: host.environment,
  });
  const plan = JSON.parse(dryRun.stdout);
  assert.equal(plan.removalCount, 2);
  assert.equal(plan.protectedReleases.length, 1);
  assert.equal(plan.protectedReleases[0].candidateImage, digest("c"));
});
