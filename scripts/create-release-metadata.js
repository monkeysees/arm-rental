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
        "Usage: create-release-metadata --source-revision SHA --image-archive PATH --output PATH",
      );
    }
    values[name.slice(2)] = value;
  }
  for (const required of ["source-revision", "image-archive", "output"]) {
    if (!values[required]) {
      throw new Error(`Missing required --${required} argument`);
    }
  }
  return values;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function createReleaseMetadata({
  sourceRevision,
  imageArchive,
  rootDirectory = projectRoot,
}) {
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision)) {
    throw new Error("source revision must be a full 40-character Git SHA");
  }

  const [nodeVersionText, dockerfile, packageLock, archive] = await Promise.all(
    [
      readFile(resolve(rootDirectory, ".nvmrc"), "utf8"),
      readFile(resolve(rootDirectory, "Dockerfile"), "utf8"),
      readFile(resolve(rootDirectory, "package-lock.json")),
      readFile(imageArchive),
    ],
  );
  const browserVersion = dockerfile.match(
    /^ARG CHROME_VERSION=(?<version>[0-9.]+)$/mu,
  )?.groups?.version;
  if (!browserVersion) {
    throw new Error("Dockerfile must declare a pinned CHROME_VERSION");
  }

  return {
    schemaVersion: 1,
    sourceRevision,
    nodeVersion: nodeVersionText.trim(),
    browserVersion,
    packageLockSha256: sha256(packageLock),
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
