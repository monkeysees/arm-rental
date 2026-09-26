import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createReleaseMetadata } from "../scripts/create-release-metadata.js";
import { SQLITE_SCHEMA_VERSION } from "../src/sqlite-schema.js";

const readProjectFile = (file) =>
  readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("required CI gates quality and an ephemeral production candidate", async () => {
  const [workflow, packageText, dockerfile, httpSmoke] = await Promise.all([
    readProjectFile(".github/workflows/quality.yml"),
    readProjectFile("package.json"),
    readProjectFile("Dockerfile"),
    readProjectFile("scripts/smoke-production-http-image"),
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
    /scripts\/smoke-production-runtime-image rental-apartments-bot:ci/u,
  );
  // Publication performs its own gated GHCR push. Retaining a Docker archive
  // here wastes Actions storage and is not part of the deployment handoff.
  assert.doesNotMatch(workflow, /docker save rental-apartments-bot:ci/u);
  assert.doesNotMatch(workflow, /actions\/upload-artifact@/u);

  assert.match(httpSmoke, /--user node/u);
  assert.match(httpSmoke, /--read-only/u);
  assert.match(httpSmoke, /--cap-drop ALL/u);
  assert.match(httpSmoke, /--security-opt no-new-privileges/u);
  assert.match(httpSmoke, /createServer/u);
  assert.doesNotMatch(httpSmoke, /SYS_ADMIN|Xvfb|--no-sandbox/u);

  assert.match(packageJson.scripts["test:coverage"], /test-coverage-lines=90/u);
  assert.match(
    packageJson.scripts["test:coverage"],
    /test-coverage-branches=80/u,
  );
  assert.match(
    packageJson.scripts["test:coverage"],
    /test-coverage-include='src\/\*\*\/\*\.js'/u,
  );

  assert.match(
    dockerfile,
    new RegExp(
      `com.rental-apartments.state.schema.maximum="${SQLITE_SCHEMA_VERSION}"`,
      "u",
    ),
  );
  for (const label of [
    "org.opencontainers.image.revision",
    "org.opencontainers.image.node.version",
    "org.opencontainers.image.curl-impersonate.version",
    "org.opencontainers.image.package-lock.sha256",
    "com.rental-apartments.state.backend",
    "com.rental-apartments.state.schema.minimum",
    "com.rental-apartments.state.schema.maximum",
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
    stateBackend: "sqlite",
    minimumStateSchema: 1,
    maximumStateSchema: SQLITE_SCHEMA_VERSION,
    deployableStateBackends: ["sqlite"],
    runtime: "node",
    deployableRuntimes: ["node", "rust"],
    nodeVersion: nodeVersion.trim(),
    curlImpersonateVersion: "2.2.2",
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
  assert.equal(metadata.stateBackend, "sqlite");
  assert.equal(metadata.minimumStateSchema, 1);
  assert.equal(metadata.maximumStateSchema, SQLITE_SCHEMA_VERSION);
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
  assert.match(workflow, /com\.rental-apartments\.state\.backend/u);
  assert.match(workflow, /com\.rental-apartments\.state\.schema\.minimum/u);
  assert.match(workflow, /com\.rental-apartments\.state\.schema\.maximum/u);
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

  // The pointer may only move after the transition has been classified, and
  // never on its own across a state-backend cutover.
  const transition = workflow.indexOf(
    "name: Classify the state transition against production",
  );
  assert.ok(transition > metadata && transition < production);
  assert.match(workflow, /scripts\/check-production-transition\.js/u);
  assert.match(
    workflow,
    /if: steps\.transition\.outputs\.cutover != 'true'/u,
    "a cutover must not advance the pointer automatically",
  );
  // Absent current metadata reads as an unguarded first publish, so only a
  // missing manifest may produce it.
  assert.match(workflow, /manifest unknown/u);
  assert.match(
    workflow,
    /Refusing to advance the /u,
    "an unreadable production pointer must not retire the transition guard",
  );
});

test("a state backend cutover reaches production only by confirmed promotion", async () => {
  const workflow = await readProjectFile(
    ".github/workflows/promote-production.yml",
  );

  assert.match(workflow, /workflow_dispatch/u);
  assert.match(workflow, /deployed_bridge_revision/u);
  assert.match(workflow, /group: production-publication/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /scripts\/check-production-transition\.js/u);

  const confirm = workflow.indexOf(
    "name: Require the confirmed bridge to be the release production runs",
  );
  const compatible = workflow.indexOf(
    "name: Confirm the running release can deploy the candidate",
  );
  const advance = workflow.indexOf(
    "name: Advance production discovery pointer",
  );
  assert.ok(
    confirm > 0 && confirm < compatible && compatible < advance,
    "confirm the host, then compatibility, and only then move the pointer",
  );
});

test("the publisher refuses a candidate the running release cannot deploy", async () => {
  const { classifyProductionTransition } =
    await import("../scripts/check-production-transition.js");

  // The incident: a SQLite release published while a plain JSON release was
  // current. Its verifier accepted only JSON, so every poll failed silently.
  const refused = classifyProductionTransition({
    current: { stateBackend: "json", sourceRevision: "f".repeat(40) },
    candidate: { stateBackend: "sqlite" },
  });
  assert.equal(refused.allowed, false);
  assert.equal(refused.cutover, true);
  assert.match(refused.reason, /deploys only json/u);

  // The bridge release declares that it can deploy the next backend, so the
  // publish succeeds, but the pointer still waits for a confirmed promotion.
  const bridged = classifyProductionTransition({
    current: {
      stateBackend: "json",
      deployableStateBackends: ["json", "sqlite"],
    },
    candidate: { stateBackend: "sqlite" },
  });
  assert.equal(bridged.allowed, true);
  assert.equal(bridged.cutover, true);

  // Ordinary same-backend releases are untouched by any of this.
  const ordinary = classifyProductionTransition({
    current: { stateBackend: "sqlite", deployableStateBackends: ["sqlite"] },
    candidate: { stateBackend: "sqlite" },
  });
  assert.equal(ordinary.allowed, true);
  assert.equal(ordinary.cutover, false);

  const oldNodeRelease = classifyProductionTransition({
    current: { stateBackend: "sqlite", sourceRevision: "f".repeat(40) },
    candidate: { stateBackend: "sqlite", runtime: "rust" },
  });
  assert.equal(oldNodeRelease.allowed, false);
  assert.equal(oldNodeRelease.cutover, true);
  assert.match(oldNodeRelease.reason, /deploys only node/u);

  const runtimeBridge = classifyProductionTransition({
    current: {
      stateBackend: "sqlite",
      runtime: "node",
      deployableRuntimes: ["node", "rust"],
    },
    candidate: { stateBackend: "sqlite", runtime: "rust" },
  });
  assert.equal(runtimeBridge.allowed, true);
  assert.equal(runtimeBridge.cutover, true);

  assert.throws(
    () =>
      classifyProductionTransition({
        current: { stateBackend: "sqlite" },
        candidate: { stateBackend: "sqlite", runtime: "unknown" },
      }),
    /unsupported candidate runtime/u,
  );

  const firstPublish = classifyProductionTransition({
    current: undefined,
    candidate: { stateBackend: "sqlite" },
  });
  assert.equal(firstPublish.allowed, true);
  assert.equal(firstPublish.cutover, false);
});

test("declared deployable backends are the ones this release's verifier accepts", async (t) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "deployable-backends-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const archivePath = join(temporaryDirectory, "production-image.tar.gz");
  await writeFile(archivePath, "deterministic image archive");
  const [metadata, library] = await Promise.all([
    createReleaseMetadata({
      sourceRevision: "a".repeat(40),
      imageArchive: archivePath,
    }),
    readProjectFile("ops/lib/deployment.sh"),
  ]);

  // The publisher trusts this field when deciding whether the pointer may
  // advance past a release. Deriving it from the verifier that actually
  // refuses candidates keeps a widened field from promising a cutover the
  // host would reject on every poll, and a forgotten one from stranding a
  // bridge release that can perform it.
  const verifier = library.slice(
    library.indexOf("\ndeployment_verify_release() {"),
    library.indexOf("\ndeployment_validate_compose() {"),
  );
  assert.ok(verifier.includes("jq"), "the release verifier must be readable");
  const accepted = [
    ...new Set(
      [...verifier.matchAll(/\.stateBackend == "(?<backend>[a-z]+)"/gu)].map(
        (match) => match.groups.backend,
      ),
    ),
  ];
  assert.ok(
    accepted.length > 0,
    "the verifier must constrain the state backend",
  );
  assert.deepEqual(
    metadata.deployableStateBackends.toSorted(),
    accepted.toSorted(),
  );
});

test("publication accepts the current SQLite image schema and rejects a mismatched label", async () => {
  const workflow = await readProjectFile(
    ".github/workflows/publish-production.yml",
  );
  const step = workflow
    .split("      - name: Verify pinned runtime and OCI provenance\n")[1]
    ?.split("\n      - name:")[0];
  const script = step?.split("        run: |\n")[1]?.replace(/^ {10}/gmu, "");
  assert.ok(script, "publication must verify image provenance before pushing");
  const docker = `
    docker() {
      case "$*" in
        *org.opencontainers.image.revision*) printf '%s\\n' "$SOURCE_REVISION" ;;
        *org.opencontainers.image.node.version*) cat .nvmrc ;;
        *org.opencontainers.image.curl-impersonate.version*) printf '%s\\n' '2.2.2' ;;
        *org.opencontainers.image.package-lock.sha256*) sha256sum package-lock.json | cut -d ' ' -f 1 ;;
        *com.rental-apartments.state.backend*) printf '%s\\n' sqlite ;;
        *com.rental-apartments.state.schema.minimum*) printf '%s\\n' 1 ;;
        *com.rental-apartments.state.schema.maximum*) printf '%s\\n' "$TEST_SCHEMA_MAXIMUM" ;;
        *--entrypoint*node*) printf 'v%s\\n' "$(cat .nvmrc)" ;;
        *) return 99 ;;
      esac
    }
  `;
  const verify = (maximum) =>
    execFileSync(
      "/bin/bash",
      ["--noprofile", "--norc", "-eu", "-c", `${docker}\n${script}`],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          PATH: process.env.PATH,
          SOURCE_REVISION: "a".repeat(40),
          TEST_SCHEMA_MAXIMUM: String(maximum),
        },
        stdio: "pipe",
      },
    );
  assert.doesNotThrow(() => verify(SQLITE_SCHEMA_VERSION));
  assert.throws(() => verify(SQLITE_SCHEMA_VERSION - 1));
});
