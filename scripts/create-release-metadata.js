import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(
        "Usage: create-release-metadata --source-revision SHA (--image-archive PATH | --image-reference REPO@DIGEST --operations-bundle PATH) --output PATH",
      );
    }
    values[name.slice(2)] = value;
  }
  for (const required of ["source-revision", "output"]) {
    if (!values[required]) {
      throw new Error(`Missing required --${required} argument`);
    }
  }
  if (Boolean(values["image-archive"]) === Boolean(values["image-reference"])) {
    throw new Error(
      "Exactly one of --image-archive or --image-reference is required",
    );
  }
  if (values["image-reference"] && !values["operations-bundle"]) {
    throw new Error("--operations-bundle is required with --image-reference");
  }
  return values;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function createReleaseMetadata({
  sourceRevision,
  imageArchive,
  imageReference,
  operationsBundle,
  rootDirectory = projectRoot,
}) {
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision)) {
    throw new Error("source revision must be a full 40-character Git SHA");
  }

  if (Boolean(imageArchive) === Boolean(imageReference)) {
    throw new Error("provide exactly one image archive or image reference");
  }
  if (
    imageReference &&
    !/^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u.test(imageReference)
  ) {
    throw new Error(
      "image reference must contain an immutable registry digest",
    );
  }
  if (imageReference && !operationsBundle) {
    throw new Error("operations bundle is required for registry publication");
  }

  const reads = [
    readFile(resolve(rootDirectory, ".nvmrc"), "utf8"),
    readFile(resolve(rootDirectory, "Dockerfile"), "utf8"),
    readFile(resolve(rootDirectory, "package-lock.json")),
    imageArchive ? readFile(imageArchive) : Promise.resolve(undefined),
    imageReference
      ? readFile(resolve(rootDirectory, "compose.production.yaml"))
      : Promise.resolve(undefined),
    operationsBundle ? readFile(operationsBundle) : Promise.resolve(undefined),
  ];
  const [
    nodeVersionText,
    dockerfile,
    packageLock,
    archive,
    compose,
    operations,
  ] = await Promise.all(reads);
  const curlImpersonateVersion = dockerfile.match(
    /^ARG CURL_IMPERSONATE_VERSION=(?<version>[0-9.]+)$/mu,
  )?.groups?.version;
  if (!curlImpersonateVersion) {
    throw new Error(
      "Dockerfile must declare a pinned CURL_IMPERSONATE_VERSION",
    );
  }

  const common = {
    schemaVersion: 1,
    sourceRevision,
    stateBackend: "sqlite",
    // The range this image can serve, not the schema it writes: it opens a
    // database still at schema 1 and migrates it to 3 on the first open, so a
    // host running any supported schema is deployable; rollback below 3 needs a restore.
    minimumStateSchema: 1,
    maximumStateSchema: 3,
    // What this release's own deployer will accept as a candidate, which is
    // not the same as the backend it runs. The host deploys the next candidate
    // with the operations bundle it is already running, so the publisher uses
    // this to refuse advancing the pointer past a release that cannot deploy
    // what comes next. A bridge release carrying cutover machinery lists both
    // backends; every other release lists only the one its verifier accepts.
    deployableStateBackends: ["sqlite"],
    nodeVersion: nodeVersionText.trim(),
    curlImpersonateVersion,
    packageLockSha256: sha256(packageLock),
  };
  if (imageReference) {
    return {
      ...common,
      schemaVersion: 2,
      imageReference,
      imageDigest: imageReference.slice(imageReference.indexOf("@") + 1),
      composeSha256: sha256(compose),
      operationsBundleSha256: sha256(operations),
    };
  }
  return {
    ...common,
    imageArchive: {
      file: basename(imageArchive),
      sha256: sha256(archive),
    },
  };
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const metadata = await createReleaseMetadata({
    sourceRevision: arguments_["source-revision"],
    imageArchive: arguments_["image-archive"],
    imageReference: arguments_["image-reference"],
    operationsBundle: arguments_["operations-bundle"],
  });
  await writeFile(
    arguments_.output,
    `${JSON.stringify(metadata, undefined, 2)}\n`,
    { flag: "wx" },
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
