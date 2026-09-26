import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
const {
  values,
  positionals: [output],
} = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(
    ["binary", "registry", "transport-image", "tag"].map((name) => [
      name,
      { type: "string" },
    ]),
  ),
});
assert(
  output &&
    path.isAbsolute(output) &&
    values.binary &&
    values.registry &&
    values["transport-image"] &&
    values.tag,
  "Usage: build.js NEW_ABSOLUTE_OUTPUT --binary PATH --registry PATH --transport-image IMAGE --tag TAG",
);
const run = (program, args, options = {}) =>
  execFileSync(program, args, { maxBuffer: 128 * 1024 * 1024, ...options });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
mkdirSync(output);
const context = path.join(output, "context");
const licenses = path.join(context, "licenses");
mkdirSync(licenses, { recursive: true });
cpSync(values.binary, path.join(context, "rental-app"));
cpSync("experiments/production-image/assemble", path.join(context, "assemble"));
cpSync(
  "experiments/production-image/Dockerfile.prebuilt",
  path.join(context, "Dockerfile"),
);
function copyFromImage(image, copies) {
  const container = run(
    "docker",
    ["create", "--platform", "linux/amd64", "--entrypoint", "/bin/true", image],
    { encoding: "utf8" },
  ).trim();
  try {
    for (const [source, destination] of copies)
      run("docker", ["cp", `${container}:${source}`, destination]);
  } finally {
    run("docker", ["rm", container]);
  }
}
copyFromImage(values["transport-image"], [
  ["/usr/local/bin/curl-impersonate", path.join(context, "curl-impersonate")],
  [
    "/usr/local/share/licenses/curl-impersonate",
    path.join(licenses, "curl-impersonate"),
  ],
]);
assert.equal(
  sha(readFileSync(path.join(context, "curl-impersonate"))),
  "9775f5c719cc7649d0da41a786ef5e25da886514c547399a6d86b6038f105786",
  "Pinned AMD64 curl executable",
);
const toolchainNotices = path.join(licenses, "rust-toolchain");
mkdirSync(toolchainNotices);
for (const [file, checksum] of Object.entries({
  COPYRIGHT: "172020dbfd5b53a226dfde77616190a48dcff519b0bc0e6deb91a8450782c4af",
  "LICENSE-APACHE":
    "62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a",
  "LICENSE-MIT":
    "b71bd43a069ca0641a9ecfe585ca7b3c53b5cc1608f8b68321168698e28b5ea1",
})) {
  const notice = run("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--proto",
    "=https",
    "--tlsv1.2",
    `https://raw.githubusercontent.com/rust-lang/rust/1.94.0/${file}`,
  ]);
  assert.equal(sha(notice), checksum, `Pinned Rust ${file}`);
  writeFileSync(path.join(toolchainNotices, file), notice);
}
const lock = readFileSync("experiments/rust-replay/Cargo.lock", "utf8");
const registry = path.join(values.registry, "src");
const roots = readdirSync(registry);
for (const block of lock.split("[[package]]").slice(1)) {
  if (!block.includes('source = "registry+')) continue;
  const name = block.match(/^name = "([^"]+)"/m)[1];
  const version = block.match(/^version = "([^"]+)"/m)[1];
  const dirname = `${name}-${version}`;
  const root = roots.find((root) =>
    readdirSync(path.join(registry, root)).includes(dirname),
  );
  assert(root, `Missing locked source/licenses: ${dirname}`);
  const source = path.join(registry, root, dirname);
  const destination = path.join(licenses, "rental-app", dirname);
  mkdirSync(destination, { recursive: true });
  const notices = readdirSync(source).filter((file) =>
    /^(license|copying|notice)/i.test(file),
  );
  for (const file of notices)
    cpSync(path.join(source, file), path.join(destination, file), {
      recursive: true,
    });
  if (!notices.length)
    cpSync(source, path.join(destination, "source"), { recursive: true });
  cpSync(path.join(source, "Cargo.toml"), path.join(destination, "Cargo.toml"));
}
cpSync(
  "experiments/rust-replay/Cargo.lock",
  path.join(licenses, "rental-app", "Cargo.lock"),
);
const revision = run("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(path.join(directory, entry.name))
      : [path.join(directory, entry.name)],
  );
}
const sources = [
  "experiments/rust-replay/Cargo.toml",
  "experiments/rust-replay/Cargo.lock",
  ...sourceFiles("experiments/rust-replay/src"),
  ...sourceFiles("experiments/production-image"),
  "Dockerfile.native",
  "ops/compose.native.yaml",
  "package-lock.json",
  "scripts/install-curl-impersonate",
  "scripts/curl-impersonate-version",
].sort();
const sourceHashes = Object.fromEntries(
  sources.map((file) => [file, sha(readFileSync(file))]),
);
const sourceDirty =
  run("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
const components = {
  sourceDirty,
  packageLockSha256: sha(readFileSync("package-lock.json")),
  sourceHashes,
  sourceTreeSha256: sha(JSON.stringify(sourceHashes)),
  runtime: "rust",
  toolchain: "1.94.0",
  architecture: "linux/amd64",
  sourceRevision: revision,
  cargoLockSha256: sha(lock),
  binarySha256: sha(readFileSync(values.binary)),
  transportImage: JSON.parse(
    run("docker", ["image", "inspect", values["transport-image"]]),
  )[0].Id,
};
writeFileSync(
  path.join(context, "components.json"),
  `${JSON.stringify(components, null, 2)}\n`,
);
run(
  "docker",
  [
    "build",
    "--platform",
    "linux/amd64",
    "--build-arg",
    `SOURCE_REVISION=${revision}`,
    "--build-arg",
    `CARGO_LOCK_SHA256=${components.cargoLockSha256}`,
    "--build-arg",
    `SOURCE_DIRTY=${sourceDirty}`,
    "--build-arg",
    `PACKAGE_LOCK_SHA256=${components.packageLockSha256}`,
    "--tag",
    values.tag,
    context,
  ],
  { stdio: "inherit" },
);
const image = JSON.parse(run("docker", ["image", "inspect", values.tag]))[0];
const result = { ...components, imageId: image.Id, tag: values.tag };
writeFileSync(
  path.join(output, "build.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result));
