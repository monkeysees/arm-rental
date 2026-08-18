import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";

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

test("production packaging installs locked dependencies and a patched browser in Puppeteer's milestone", async () => {
  const [workflow, publishWorkflow, dockerfile] = await Promise.all([
    readProjectFile(".github/workflows/quality.yml"),
    readProjectFile(".github/workflows/publish-production.yml"),
    readProjectFile("Dockerfile"),
  ]);
  const chromeVersion = dockerfile.match(
    /^ARG CHROME_VERSION=(?<version>[0-9.]+)$/mu,
  )?.groups?.version;

  assert.equal(chromeVersion, "151.0.7922.137");
  assert.equal(
    chromeVersion.split(".")[0],
    PUPPETEER_REVISIONS.chrome.split(".")[0],
  );
  assert.match(dockerfile, /RUN npm ci --omit=dev\b/u);
  assert.doesNotMatch(dockerfile, /\bnpm install\b/u);
  assert.match(
    dockerfile,
    /"chromium=\$\{CHROMIUM_PACKAGE_VERSION\}"[\s\S]*?"chromium-sandbox=\$\{CHROMIUM_PACKAGE_VERSION\}"/u,
  );
  assert.match(dockerfile, /root:root:4755/u);
  assert.match(
    dockerfile,
    /rm -rf[\s\S]*?\/usr\/local\/lib\/node_modules\/npm[\s\S]*?\/usr\/local\/lib\/node_modules\/corepack/u,
  );
  assert.match(
    dockerfile,
    /rm -f \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx \/usr\/local\/bin\/corepack/u,
  );
  assert.match(
    dockerfile,
    /dpkg-query --show --showformat='\$\{Version\}' chromium[\s\S]*?dpkg-query --show --showformat='\$\{Version\}' chromium-sandbox/u,
  );
  assert.match(workflow, /sed 's\/\[\[:space:\]\]\*\$\/\//u);
  assert.match(
    workflow,
    /Chromium 151\.0\.7922\.137 built on Debian GNU\/Linux 12 \(bookworm\)/u,
  );
  assert.match(
    publishWorkflow,
    /org\.opencontainers\.image\.chrome\.version[\s\S]*?151\.0\.7922\.137/u,
  );
  assert.match(workflow, /run: npm ci/u);
  assert.match(workflow, /run: npm run check/u);
});
