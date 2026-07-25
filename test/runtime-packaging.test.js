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
  const [workflow, dockerfile] = await Promise.all([
    readProjectFile(".github/workflows/quality.yml"),
    readProjectFile("Dockerfile"),
  ]);
  const chromeVersion = dockerfile.match(
    /^ARG CHROME_VERSION=(?<version>[0-9.]+)$/mu,
  )?.groups?.version;

  assert.equal(chromeVersion, "150.0.7871.124");
  assert.equal(
    chromeVersion.split(".")[0],
    PUPPETEER_REVISIONS.chrome.split(".")[0],
  );
  assert.match(dockerfile, /RUN npm ci --omit=dev\b/u);
  assert.doesNotMatch(dockerfile, /\bnpm install\b/u);
  assert.match(dockerfile, /--install-deps/u);
  assert.match(
    dockerfile,
    /rm -rf[\s\S]*?\/usr\/local\/lib\/node_modules\/npm[\s\S]*?\/usr\/local\/lib\/node_modules\/corepack/u,
  );
  assert.match(
    dockerfile,
    /rm -f \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx \/usr\/local\/bin\/corepack/u,
  );
  assert.match(dockerfile, /sed 's\/\[\[:space:\]\]\*\$\/\//u);
  assert.match(
    dockerfile,
    /Google Chrome \$\{CHROME_VERSION\}[\s\S]*?Google Chrome for Testing \$\{CHROME_VERSION\}/u,
  );
  assert.match(workflow, /sed 's\/\[\[:space:\]\]\*\$\/\//u);
  assert.match(
    workflow,
    /Google Chrome 150\.0\.7871\.24[\s\S]*?Google Chrome for Testing 150\.0\.7871\.24/u,
  );
  assert.match(workflow, /run: npm ci/u);
  assert.match(workflow, /run: npm run check/u);
});
