import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readProjectFile = (file) =>
  readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("development, CI, and production use the same pinned Node release", async () => {
  const [packageText, lockText, nvmVersion, workflow, dockerfile] =
    await Promise.all([
      readProjectFile("package.json"),
      readProjectFile("package-lock.json"),
      readProjectFile(".nvmrc"),
      readProjectFile(".github/workflows/quality.yml"),
      readProjectFile("Dockerfile"),
    ]);
  const packageJson = JSON.parse(packageText);
  const packageLock = JSON.parse(lockText);
  const nodeVersion = nvmVersion.trim();

  assert.equal(packageJson.engines.node, nodeVersion);
  assert.equal(packageLock.packages[""].engines.node, nodeVersion);
  assert.match(workflow, /node-version-file: \.nvmrc/u);
  assert.match(
    dockerfile,
    new RegExp(`ARG NODE_VERSION=${nodeVersion}\\b`, "u"),
  );
  assert.match(
    dockerfile,
    /node:\$\{NODE_VERSION\}-bookworm-slim@sha256:[a-f0-9]{64}/u,
  );
});

test("production packaging verifies the pinned HTTP binary and removes build tools", async () => {
  const [workflow, publishWorkflow, dockerfile, installer, versions] =
    await Promise.all([
      readProjectFile(".github/workflows/quality.yml"),
      readProjectFile(".github/workflows/publish-production.yml"),
      readProjectFile("Dockerfile"),
      readProjectFile("scripts/install-curl-impersonate"),
      readProjectFile("scripts/curl-impersonate-version"),
    ]);
  assert.match(dockerfile, /ARG CURL_IMPERSONATE_VERSION=2\.2\.2/u);
  assert.match(dockerfile, /RUN npm ci --omit=dev\b/u);
  assert.doesNotMatch(dockerfile, /chromium|puppeteer|SYS_ADMIN/iu);
  assert.match(dockerfile, /apt-get purge --yes --auto-remove curl/u);
  assert.match(dockerfile, /\/usr\/local\/lib\/node_modules\/npm/u);
  assert.match(installer, /sha256sum --check --status/u);
  assert.match(installer, /LICENSE\*/u);
  assert.match(versions, /CURL_IMPERSONATE_AMD64_SHA256=[a-f0-9]{64}/u);
  assert.match(versions, /CURL_IMPERSONATE_ARM64_SHA256=[a-f0-9]{64}/u);
  assert.match(workflow, /curl 8\.21\.0-IMPERSONATE/u);
  assert.match(publishWorkflow, /image\.curl-impersonate\.version/u);
});
