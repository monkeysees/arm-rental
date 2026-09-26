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
import { gzipSync, gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";

const {
  values,
  positionals: [output],
} = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(
    ["go-binary", "rust-binary", "go-mod", "rust-registry"].map((key) => [
      key,
      { type: "string" },
    ]),
  ),
});
assert(
  output,
  "Usage: artifacts.js NEW_OUTPUT --go-binary PATH --rust-binary PATH --go-mod CACHE --rust-registry CACHE",
);
for (const key of ["go-binary", "rust-binary", "go-mod", "rust-registry"])
  assert(path.isAbsolute(values[key] ?? ""), `${key} must be absolute`);
mkdirSync(output);
const run = (program, args, options = {}) =>
  execFileSync(program, args, { maxBuffer: 512 * 1024 * 1024, ...options });
const hash = (data) => createHash("sha256").update(data).digest("hex");
const nodeImage = "arm-rental-comparison-node:local";
run(
  "docker",
  [
    "build",
    "--platform",
    "linux/amd64",
    "--target",
    "production",
    "--build-arg",
    `SOURCE_REVISION=${run("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()}`,
    "--build-arg",
    `PACKAGE_LOCK_SHA256=${hash(readFileSync("package-lock.json"))}`,
    "--tag",
    nodeImage,
    ".",
  ],
  { stdio: "inherit" },
);
const manifest = {
  architecture: "linux/amd64",
  revision: run("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  workingTree: run("git", ["status", "--short"], { encoding: "utf8" }).trim(),
  sourceHashes: Object.fromEntries(
    [
      ...readdirSync("src")
        .filter((name) => name.endsWith(".js"))
        .map((name) => `src/${name}`),
      "package.json",
      "package-lock.json",
      "Dockerfile",
      "scripts/assemble-runtime-root",
      "scripts/install-curl-impersonate",
      "scripts/curl-impersonate-version",
      "experiments/runtime-comparison/Dockerfile",
      "experiments/runtime-comparison/artifacts.js",
    ].map((file) => [file, hash(readFileSync(file))]),
  ),
  boundary:
    "Complete runtime images including curl-impersonate, native shared-library closure, certificates and licenses. Native images retain conservative common-library inventory from the minimal Node root but omit Node and application source/dependencies. Prototypes implement only the replay slice.",
  images: {},
};
for (const runtime of ["node", "go", "rust"]) {
  const tag = `arm-rental-comparison-${runtime}:local`;
  if (runtime !== "node") {
    const context = path.join(output, runtime);
    const licenses = path.join(context, "licenses");
    mkdirSync(licenses, { recursive: true });
    cpSync(values[`${runtime}-binary`], path.join(context, "replay"));
    cpSync(
      "experiments/runtime-comparison/Dockerfile",
      path.join(context, "Dockerfile"),
    );
    if (runtime === "go") {
      for (const module of [
        "github.com/mattn/go-sqlite3@v1.14.49",
        "golang.org/x/net@v0.55.0",
      ]) {
        const destination = path.join(licenses, module);
        mkdirSync(destination, { recursive: true });
        cpSync(
          path.join(values["go-mod"], module, "LICENSE"),
          path.join(destination, "LICENSE"),
        );
      }
      writeFileSync(
        path.join(licenses, "Go-LICENSE"),
        run("docker", [
          "run",
          "--rm",
          "--network",
          "none",
          "golang:1.27.1-bookworm@sha256:648f440f42a0958804efb24df176f806f9d353b41f1c0627f666428e40310f6b",
          "cat",
          "/usr/local/go/LICENSE",
        ]),
      );
      cpSync("experiments/go-replay/go.sum", path.join(licenses, "go.sum"));
    } else {
      run(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${process.cwd()}:/repo:ro`,
          "-v",
          `${values["rust-registry"]}:/usr/local/cargo/registry`,
          "-w",
          "/repo/experiments/rust-replay",
          "rust:1.94.0-bookworm@sha256:365468470075493dc4583f47387001854321c5a8583ea9604b297e67f01c5a4f",
          "cargo",
          "fetch",
          "--locked",
        ],
        { stdio: "inherit" },
      );
      const registries = readdirSync(path.join(values["rust-registry"], "src"));
      const lock = readFileSync("experiments/rust-replay/Cargo.lock", "utf8");
      for (const block of lock.split("[[package]]").slice(1)) {
        if (!block.includes('source = "registry+')) continue;
        const name = block.match(/^name = "([^"]+)"/m)[1];
        const version = block.match(/^version = "([^"]+)"/m)[1];
        const directory = registries
          .map((registry) =>
            path.join(
              values["rust-registry"],
              "src",
              registry,
              `${name}-${version}`,
            ),
          )
          .find((directory) => {
            try {
              return readdirSync(directory).length > 0;
            } catch {
              return false;
            }
          });
        assert(directory, `Missing locked crate ${name}-${version}`);
        const destination = path.join(licenses, `${name}-${version}`);
        mkdirSync(destination);
        const notices = readdirSync(directory).filter((name) =>
          /^(license|copying|notice)/i.test(name),
        );
        if (notices.length)
          for (const file of notices)
            cpSync(path.join(directory, file), path.join(destination, file), {
              recursive: true,
            });
        else {
          // Some published crates carry their notices in source headers only.
          cpSync(directory, path.join(destination, "source"), {
            recursive: true,
          });
        }
        cpSync(
          path.join(directory, "Cargo.toml"),
          path.join(destination, "Cargo.toml"),
        );
      }
      cpSync(
        "experiments/rust-replay/Cargo.lock",
        path.join(licenses, "Cargo.lock"),
      );
      for (const [file, sha256] of Object.entries({
        COPYRIGHT:
          "172020dbfd5b53a226dfde77616190a48dcff519b0bc0e6deb91a8450782c4af",
        "LICENSE-APACHE":
          "62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a",
        "LICENSE-MIT":
          "b71bd43a069ca0641a9ecfe585ca7b3c53b5cc1608f8b68321168698e28b5ea1",
      })) {
        const response = await fetch(
          `https://raw.githubusercontent.com/rust-lang/rust/1.94.0/${file}`,
        );
        assert(response.ok, `Rust license download failed: ${file}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(hash(bytes), sha256, `Rust license checksum: ${file}`);
        writeFileSync(path.join(licenses, `Rust-${file}`), bytes);
      }
    }
    run(
      "docker",
      [
        "build",
        "--platform",
        "linux/amd64",
        "--build-arg",
        `RUNTIME=${runtime}`,
        "--tag",
        tag,
        context,
      ],
      { stdio: "inherit" },
    );
  }
  const archive = path.join(output, `${runtime}.tar`);
  run("docker", ["image", "save", "--output", archive, tag]);
  const entries = JSON.parse(
    run("tar", ["-xOf", archive, "manifest.json"], { encoding: "utf8" }),
  );
  assert.equal(entries.length, 1, "Expected one selected image");
  let compressedLayerBytes = 0,
    unpackedLayerTarBytes = 0;
  const layers = entries[0].Layers.map((name) => {
    const bytes = run("tar", ["-xOf", archive, name]);
    const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const raw = compressed ? gunzipSync(bytes) : bytes;
    assert(
      raw.length % 512 === 0 &&
        (raw.subarray(257, 262).toString() === "ustar" ||
          (raw.length >= 1024 && raw.every((byte) => byte === 0))),
      "Unsupported layer compression or tar encoding",
    );
    const gzip = compressed ? bytes : gzipSync(raw, { level: 9 });
    compressedLayerBytes += gzip.length;
    unpackedLayerTarBytes += raw.length;
    return {
      name,
      savedSha256: hash(bytes),
      savedBytes: bytes.length,
      compression: compressed ? "stored gzip" : "normalized gzip level 9",
      compressedBytes: gzip.length,
      unpackedTarBytes: raw.length,
    };
  });
  const inspect = JSON.parse(
    run("docker", ["image", "inspect", tag], { encoding: "utf8" }),
  )[0];
  manifest.images[runtime] = {
    tag,
    imageId: inspect.Id,
    labels: inspect.Config.Labels,
    compressedLayerBytes,
    unpackedLayerTarBytes,
    layers,
    ...(runtime === "node"
      ? {}
      : { binarySha256: hash(readFileSync(values[`${runtime}-binary`])) }),
  };
  writeFileSync(
    path.join(output, "artifacts.json"),
    JSON.stringify(manifest, null, 2),
  );
}
