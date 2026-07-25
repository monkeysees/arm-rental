import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createReleaseMetadata } from "../scripts/create-release-metadata.js";

const readProjectFile = (file) =>
  readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("required CI gates quality, production security, and an immutable artifact", async () => {
  const [workflow, packageText, dockerfile, browserSmoke] = await Promise.all([
    readProjectFile(".github/workflows/quality.yml"),
    readProjectFile("package.json"),
    readProjectFile("Dockerfile"),
    readProjectFile("scripts/smoke-production-browser-image"),
  ]);
  const packageJson = JSON.parse(packageText);
  const actionReferences = [
    ...workflow.matchAll(/^\s*uses:\s+\S+@(?<revision>\S+)/gmu),
  ];

  assert.ok(actionReferences.length >= 4);
  for (const reference of actionReferences) {
    assert.match(reference.groups.revision, /^[a-f0-9]{40}$/u);
  }

  assert.match(workflow, /name: Required \/ quality/u);
  assert.match(workflow, /name: Required \/ production artifact/u);
  assert.match(workflow, /run: npm ci/u);
  assert.match(workflow, /run: npm run check/u);
  assert.match(workflow, /run: npm run test:coverage/u);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/u);
  assert.match(workflow, /vuln-type: os,library/u);
  assert.match(workflow, /severity: HIGH,CRITICAL/u);
  assert.match(workflow, /ignore-unfixed: true/u);
  assert.match(workflow, /exit-code: 1/u);
  assert.match(
    workflow,
    /scripts\/smoke-production-browser-image rental-apartments-bot:ci/u,
  );
  assert.match(workflow, /docker save rental-apartments-bot:ci/u);
  assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40}/u);

  assert.match(browserSmoke, /platform != linux\/amd64/u);
  assert.match(browserSmoke, /--user node/u);
  assert.match(browserSmoke, /--read-only/u);
  assert.match(browserSmoke, /--cap-add SYS_ADMIN/u);
  assert.match(browserSmoke, /browserDumpIo: true/u);
  assert.match(browserSmoke, /run_browser_smoke headless true/u);
  assert.match(browserSmoke, /run_browser_smoke headful false/u);
  assert.doesNotMatch(browserSmoke, /--no-sandbox/u);

  assert.match(packageJson.scripts["test:coverage"], /test-coverage-lines=90/u);
  assert.match(
    packageJson.scripts["test:coverage"],
    /test-coverage-branches=80/u,
  );
  assert.match(
    packageJson.scripts["test:coverage"],
    /test-coverage-include='src\/\*\*\/\*\.js'/u,
  );

  for (const label of [
    "org.opencontainers.image.revision",
    "org.opencontainers.image.node.version",
    "org.opencontainers.image.chrome.version",
    "org.opencontainers.image.package-lock.sha256",
  ]) {
    assert.ok(dockerfile.includes(label), `missing image label ${label}`);
  }
});

test("dependency automation can only propose reviewed pull requests", async () => {
  const dependabot = await readProjectFile(".github/dependabot.yml");

  for (const ecosystem of ["npm", "docker", "github-actions"]) {
    assert.match(
      dependabot,
      new RegExp(`package-ecosystem: ${ecosystem}`, "u"),
    );
  }
  assert.doesNotMatch(dependabot, /auto-merge|deploy|production/iu);
});

test("release manifest binds the deployable image to its complete inputs", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "release-metadata-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const archive = Buffer.from("deterministic image archive");
  const archivePath = join(temporaryDirectory, "production-image.tar.gz");
  await writeFile(archivePath, archive);

  const metadata = await createReleaseMetadata({
    sourceRevision: "a".repeat(40),
    imageArchive: archivePath,
  });
  const [nodeVersion, packageLock] = await Promise.all([
    readProjectFile(".nvmrc"),
    readProjectFile("package-lock.json"),
  ]);

  assert.deepEqual(metadata, {
    schemaVersion: 1,
    sourceRevision: "a".repeat(40),
    nodeVersion: nodeVersion.trim(),
    browserVersion: "150.0.7871.181",
    packageLockSha256: createHash("sha256").update(packageLock).digest("hex"),
    imageArchive: {
      file: "production-image.tar.gz",
      sha256: createHash("sha256").update(archive).digest("hex"),
    },
  });
  await assert.rejects(
    createReleaseMetadata({
      sourceRevision: "main",
      imageArchive: archivePath,
    }),
    /full 40-character Git SHA/u,
  );
});

test("published release metadata binds the scanned registry digest and host bundle", async (t) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "published-metadata-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const operations = Buffer.from("exact operational bundle");
  const operationsPath = join(temporaryDirectory, "operations.tar");
  await writeFile(operationsPath, operations);
  const imageReference = `ghcr.io/example/arm-rental@sha256:${"d".repeat(64)}`;

  const metadata = await createReleaseMetadata({
    sourceRevision: "b".repeat(40),
    imageReference,
    operationsBundle: operationsPath,
  });
  const [packageLock, compose] = await Promise.all([
    readProjectFile("package-lock.json"),
    readProjectFile("compose.production.yaml"),
  ]);

  assert.equal(metadata.schemaVersion, 2);
  assert.equal(metadata.imageReference, imageReference);
  assert.equal(metadata.imageDigest, `sha256:${"d".repeat(64)}`);
  assert.equal(
    metadata.packageLockSha256,
    createHash("sha256").update(packageLock).digest("hex"),
  );
  assert.equal(
    metadata.composeSha256,
    createHash("sha256").update(compose).digest("hex"),
  );
  assert.equal(
    metadata.operationsBundleSha256,
    createHash("sha256").update(operations).digest("hex"),
  );
  await assert.rejects(
    createReleaseMetadata({
      sourceRevision: "b".repeat(40),
      imageReference: "ghcr.io/example/arm-rental:production",
      operationsBundle: operationsPath,
    }),
    /immutable registry digest/u,
  );
});

test("production publication advances discovery only after scan, push, and metadata", async () => {
  const workflow = await readProjectFile(
    ".github/workflows/publish-production.yml",
  );
  const scan = workflow.indexOf("name: Scan candidate before publication");
  const push = workflow.indexOf(
    "name: Push immutable candidate and capture scanned digest",
  );
  const metadata = workflow.indexOf(
    "name: Publish digest-bound release metadata",
  );
  const production = workflow.indexOf(
    "name: Advance production discovery pointer",
  );

  assert.ok(
    scan > 0 && scan < push && push < metadata && metadata < production,
  );
  assert.match(workflow, /workflow_run\.conclusion == 'success'/u);
  assert.match(workflow, /workflow_run\.head_branch == 'main'/u);
  assert.match(workflow, /group: production-publication/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /image-ref: rental-apartments-bot:publication/u);
  assert.match(workflow, /docker push "\$METADATA_TAG"/u);
  assert.match(
    workflow,
    /docker create "\$METADATA_TAG" \/release\/release-metadata\.json/u,
  );
  for (const artifact of [
    "release-metadata.json",
    "operations.tar",
    "compose.production.yaml",
    "package-lock.json",
  ]) {
    assert.match(
      workflow,
      new RegExp(artifact.replaceAll(".", String.raw`\.`), "u"),
    );
  }
  assert.match(workflow, /COPY release\/ \/release\//u);
  assert.match(workflow, /docker push "\$IMAGE_REPOSITORY:production"/u);
  assert.doesNotMatch(
    workflow.slice(0, production),
    /docker push "\$IMAGE_REPOSITORY:production"/u,
  );
});
