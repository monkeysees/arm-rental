import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
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
    ["binary", "registry", "toolchain-licenses", "transport-image", "tag"].map(
      (key) => [key, { type: "string" }],
    ),
  ),
});
assert(
  output && values.binary && values.registry && values["toolchain-licenses"],
  "build.js NEW_OUTPUT --binary PATH --registry PATH --toolchain-licenses PATH [--transport-image IMAGE] [--tag TAG]",
);
const run = (program, args, options = {}) =>
  execFileSync(program, args, { maxBuffer: 256 * 1024 * 1024, ...options });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inspect = (tag) =>
  JSON.parse(run("docker", ["image", "inspect", tag]))[0];
const transport = inspect(
  values["transport-image"] ?? "arm-rental-comparison-node:local",
);
const tag = values.tag ?? "arm-rental-native-minimal:local";
mkdirSync(output);
const context = path.join(output, "context");
const licenses = path.join(context, "licenses");
mkdirSync(licenses, { recursive: true });
cpSync(values.binary, path.join(context, "replay"));
const transportContainer = run("docker", ["create", transport.Id], {
  encoding: "utf8",
}).trim();
try {
  run("docker", [
    "cp",
    `${transportContainer}:/usr/local/bin/curl-impersonate`,
    path.join(context, "curl-impersonate"),
  ]);
  run("docker", [
    "cp",
    `${transportContainer}:/usr/local/share/licenses/curl-impersonate`,
    path.join(context, "curl-licenses"),
  ]);
} finally {
  run("docker", ["rm", transportContainer]);
}
assert.equal(
  sha(readFileSync(path.join(context, "curl-impersonate"))),
  "9775f5c719cc7649d0da41a786ef5e25da886514c547399a6d86b6038f105786",
);
for (const file of ["Dockerfile", "assemble"])
  cpSync(`experiments/native-image/${file}`, path.join(context, file));
const lock = readFileSync("experiments/rust-replay/Cargo.lock", "utf8");
const registry = path.join(values.registry, "src");
const crates = [];
for (const block of lock.split("[[package]]").slice(1)) {
  if (!block.includes('source = "registry+')) continue;
  const name = block.match(/^name = "([^"]+)"/m)[1];
  const version = block.match(/^version = "([^"]+)"/m)[1];
  const source = readdirSync(registry)
    .map((folder) => path.join(registry, folder, `${name}-${version}`))
    .find((folder) => {
      try {
        return statSync(folder).isDirectory();
      } catch {
        return false;
      }
    });
  const retained = path.join(
    values["toolchain-licenses"],
    `${name}-${version}`,
  );
  if (!source) {
    assert(
      readFileSync(path.join(retained, "Cargo.toml"), "utf8").includes(
        `version = "${version}"`,
      ),
      `Missing locked license ${name}-${version}`,
    );
    cpSync(retained, path.join(licenses, `${name}-${version}`), {
      recursive: true,
    });
    crates.push({
      name,
      version,
      checksum: block.match(/^checksum = "([^"]+)"/m)[1],
    });
    continue;
  }
  const destination = path.join(licenses, `${name}-${version}`);
  mkdirSync(destination);
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
  crates.push({
    name,
    version,
    checksum: block.match(/^checksum = "([^"]+)"/m)[1],
  });
}
cpSync("experiments/rust-replay/Cargo.lock", path.join(licenses, "Cargo.lock"));
for (const [file, checksum] of Object.entries({
  "Rust-COPYRIGHT":
    "172020dbfd5b53a226dfde77616190a48dcff519b0bc0e6deb91a8450782c4af",
  "Rust-LICENSE-APACHE":
    "62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a",
  "Rust-LICENSE-MIT":
    "b71bd43a069ca0641a9ecfe585ca7b3c53b5cc1608f8b68321168698e28b5ea1",
})) {
  const source = path.join(values["toolchain-licenses"], file);
  assert.equal(sha(readFileSync(source)), checksum);
  cpSync(source, path.join(licenses, file));
}
const components = {
  architecture: "linux/amd64",
  replay: {
    sha256: sha(readFileSync(values.binary)),
    bytes: statSync(values.binary).size,
    toolchain: "rustc 1.94.0",
    bundledSQLite: "3.53.2",
  },
  curl: {
    release: "2.2.2",
    upstreamVersion: "8.21.0-IMPERSONATE",
    transportImageId: transport.Id,
    sha256: "9775f5c719cc7649d0da41a786ef5e25da886514c547399a6d86b6038f105786",
    components:
      "BoringSSL, zlib 1.3.1, brotli 1.2.0, zstd 1.5.7, libidn2 2.3.7, nghttp2 1.63.0, ngtcp2 1.20.0, nghttp3 1.15.0; upstream LICENSE files retained",
  },
  debianInventory:
    "dpkg/status describes packages owning shipped closure/config/certificates; not complete installed packages",
  cargoInventoryScope:
    "Locked dependency provenance and licenses, including build-only and non-Linux dependencies; not a claim all crates are linked runtime components",
  crates,
};
writeFileSync(
  path.join(context, "components.json"),
  JSON.stringify(components, null, 2),
);
run("docker", ["build", "--platform", "linux/amd64", "-t", tag, context], {
  stdio: "inherit",
});
const image = inspect(tag);
const missingLibrary = path.resolve(output, "empty-library");
writeFileSync(missingLibrary, "");
const missingLibraryCheck = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--mount",
    `type=bind,src=${missingLibrary},dst=/lib/x86_64-linux-gnu/libgcc_s.so.1,readonly`,
    image.Id,
    "health",
    "--socket",
    "/tmp/absent.sock",
  ],
  { encoding: "utf8" },
);
assert.equal(
  missingLibraryCheck.status,
  127,
  "Masked library must fail in the actual runtime loader",
);
assert.match(missingLibraryCheck.stderr, /libgcc_s\.so\.1.*file too short/);

const container = run("docker", ["create", image.Id], {
  encoding: "utf8",
}).trim();
try {
  run("docker", ["export", "-o", path.join(output, "rootfs.tar"), container]);
} finally {
  run("docker", ["rm", container]);
}
assert.equal(
  sha(
    run("tar", [
      "-xOf",
      path.join(output, "rootfs.tar"),
      "usr/local/bin/curl-impersonate",
    ]),
  ),
  components.curl.sha256,
);
const fileList = run("tar", ["-tf", path.join(output, "rootfs.tar")], {
  encoding: "utf8",
})
  .trim()
  .split("\n");
assert(
  !fileList.some(
    (file) =>
      /(^|\/)(node|npm|npx|sh|bash|dash|apt|apt-get|dpkg|gcc|cc|cargo|rustc)$/.test(
        file,
      ) && !file.endsWith("/"),
  ),
);
const archive = path.join(output, "image.tar");
run("docker", ["image", "save", "-o", archive, image.Id]);
const saved = JSON.parse(run("tar", ["-xOf", archive, "manifest.json"]));
assert.equal(saved.length, 1);
const layers = saved[0].Layers.map((name) => {
  const stored = run("tar", ["-xOf", archive, name]);
  const compressed = stored[0] === 0x1f && stored[1] === 0x8b;
  const raw = compressed ? gunzipSync(stored) : stored;
  return {
    name,
    storedSha256: sha(stored),
    compressedBytes: (compressed ? stored : gzipSync(raw, { level: 9 })).length,
    compression: compressed ? "stored gzip" : "normalized gzip level 9",
    unpackedTarBytes: raw.length,
  };
});
// Sum regular-file payloads from the exported visible filesystem, excluding tar headers, links and directories.
const visible = run(
  "tar",
  ["-tvf", path.join(output, "rootfs.tar"), "--numeric-owner"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter((line) => line.startsWith("-"))
  .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[2]), 0);
const sourceFiles = [
  "experiments/native-image/build.js",
  "experiments/native-image/build-variants",
  "experiments/native-image/assess.js",
  "experiments/native-image/assemble",
  "experiments/native-image/Dockerfile",
  "experiments/rust-replay/Cargo.toml",
  "experiments/rust-replay/Cargo.lock",
  ...readdirSync("experiments/rust-replay/src")
    .filter((file) => file.endsWith(".rs"))
    .map((file) => `experiments/rust-replay/src/${file}`),
];
writeFileSync(
  path.join(output, "artifacts.json"),
  JSON.stringify(
    {
      missingLibraryCheck: {
        exitCode: missingLibraryCheck.status,
        stderr: missingLibraryCheck.stderr,
        boundary:
          "read-only non-root final image with libgcc replaced by empty bind file",
      },
      architecture: image.Architecture,
      imageId: image.Id,
      tag,
      components,
      layers,
      compressedLayerBytes: layers.reduce(
        (sum, layer) => sum + layer.compressedBytes,
        0,
      ),
      unpackedLayerTarBytes: layers.reduce(
        (sum, layer) => sum + layer.unpackedTarBytes,
        0,
      ),
      visibleRegularFileBytes: visible,
      visibleFilesystemAccounting:
        "sum of regular-file logical lengths in docker export; links/directories/tar padding excluded; not disk allocation",
      sourceHashes: Object.fromEntries(
        sourceFiles.map((file) => [file, sha(readFileSync(file))]),
      ),
      files: fileList,
      libraries: run(
        "tar",
        [
          "-xOf",
          path.join(output, "rootfs.tar"),
          "usr/local/share/native-image/libraries.txt",
        ],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n"),
      debianPackages: run(
        "tar",
        [
          "-xOf",
          path.join(output, "rootfs.tar"),
          "usr/local/share/native-image/debian-packages.txt",
        ],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n"),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    tag,
    imageId: image.Id,
    artifacts: path.join(output, "artifacts.json"),
  }),
);
