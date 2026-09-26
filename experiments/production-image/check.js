import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkService } from "./service-check.js";

const [output, image] = process.argv.slice(2);
assert(
  output && path.isAbsolute(output) && image,
  "Usage: check.js NEW_ABSOLUTE_OUTPUT IMAGE",
);
mkdirSync(output);
// Docker seeds each volume from the image's UID-1000 directories. A hosted
// runner may have a different UID, so its mode-0700 bind directories are not
// writable by the actual non-root container under test.
const volumes = [];
process.on("exit", () => {
  if (volumes.length > 0)
    spawnSync("docker", ["volume", "rm", "--force", ...volumes], {
      stdio: "ignore",
    });
});
const data = execFileSync("docker", ["volume", "create"], {
  encoding: "utf8",
}).trim();
volumes.push(data);
const backup = execFileSync("docker", ["volume", "create"], {
  encoding: "utf8",
}).trim();
volumes.push(backup);
const inspect = JSON.parse(
  execFileSync("docker", ["image", "inspect", image], { encoding: "utf8" }),
)[0];
assert.equal(inspect.Config.User, "1000:1000");
assert.equal(inspect.Config.Labels["com.rental-apartments.runtime"], "rust");
assert.deepEqual(inspect.Config.Entrypoint, ["/usr/local/bin/rental-app"]);
const common = [
  "run",
  "--rm",
  "--network",
  "none",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--tmpfs",
  "/tmp:mode=1777,nosuid,nodev,noexec",
  "--tmpfs",
  "/sqlite-tmp:mode=0700,uid=1000,gid=1000,nosuid,nodev,noexec",
  "--mount",
  `type=volume,src=${data},dst=/app/.data`,
  "--mount",
  `type=volume,src=${backup},dst=/app-backups`,
  "-e",
  "NODE_ENV=test",
  "-e",
  "TELEGRAM_BOT_TOKEN=123:local-test",
  "-e",
  "TELEGRAM_OWNER_ID=123",
  "-e",
  "DATA_DIRECTORY=/app/.data",
  "-e",
  "BACKUP_DIRECTORY=/app-backups",
];
function run(args, ok = true) {
  const result = spawnSync("docker", [...common, image, ...args], {
    encoding: "utf8",
  });
  if (ok) assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0);
  return result;
}
run(["state:validate", "--data-directory", "/app/.data"], false);
run(["state:init", "--data-directory", "/app/.data"]);
const initialized = JSON.parse(
  run(["state:validate", "--data-directory", "/app/.data"]).stdout,
);
assert.equal(initialized.database.userVersion, 6);
run(["state:init", "--data-directory", "/app/.data"], false);
const snapshot = JSON.parse(run(["backup:create"]).stdout).snapshot;
const validated = JSON.parse(
  run(["backup:validate", "--snapshot", snapshot]).stdout,
);
assert.deepEqual(validated.summary, initialized);
run(["backup:restore", "--snapshot", snapshot]);
const maintenance = JSON.parse(run(["maintenance:report"]).stdout);
assert.equal(maintenance.stateFiles[0].schemaVersion, 6);
const emptyLibrary = path.join(output, "empty-library");
writeFileSync(emptyLibrary, "");
const masked = spawnSync(
  "docker",
  [
    ...common,
    "--mount",
    `type=bind,src=${emptyLibrary},dst=/lib/x86_64-linux-gnu/libgcc_s.so.1,readonly`,
    image,
    "state:validate",
    "--data-directory",
    "/app/.data",
  ],
  { encoding: "utf8" },
);
assert.equal(
  masked.status,
  127,
  "Final-image loader must reject a missing required library",
);
assert.match(masked.stderr, /libgcc_s\.so\.1.*file too short/);
const container = execFileSync("docker", ["create", image], {
  encoding: "utf8",
}).trim();
const tar = path.join(output, "rootfs.tar");
try {
  execFileSync("docker", ["export", "-o", tar, container]);
} finally {
  execFileSync("docker", ["rm", container]);
}
const files = execFileSync("tar", ["-tf", tar], { encoding: "utf8" })
  .trim()
  .split("\n");
assert(
  !files.some(
    (file) =>
      /(^|\/)(node|npm|npx|sh|bash|dash|apt|apt-get|dpkg|gcc|cc|cargo|rustc|chromium|chromium-browser|chrome|google-chrome|headless_shell)$/.test(
        file,
      ) && !file.endsWith("/"),
  ),
);
assert(files.includes("usr/local/bin/rental-app"));
assert(
  files.some((file) =>
    file.startsWith("usr/local/share/licenses/rust-toolchain/"),
  ),
);
const binary = execFileSync("tar", ["-xOf", tar, "usr/local/bin/rental-app"], {
  maxBuffer: 64 * 1024 * 1024,
});
const curl = execFileSync(
  "tar",
  ["-xOf", tar, "usr/local/bin/curl-impersonate"],
  {
    maxBuffer: 64 * 1024 * 1024,
  },
);
const curlSha256 = createHash("sha256").update(curl).digest("hex");
// This is the extracted AMD64 executable from the checksum-pinned 2.2.2 archive.
if (inspect.Architecture === "amd64")
  assert.equal(
    curlSha256,
    "9775f5c719cc7649d0da41a786ef5e25da886514c547399a6d86b6038f105786",
  );
const curlVersion = execFileSync(
  "docker",
  [
    ...common,
    "--entrypoint",
    "/usr/local/bin/curl-impersonate",
    image,
    "--version",
  ],
  { encoding: "utf8" },
).trim();
assert.match(curlVersion, /^curl /);
const service = await checkService(image, common);
writeFileSync(path.join(output, "service.log"), service.logs.join("\n"));
const report = {
  type: "rental-production-image-check",
  version: 1,
  imageId: inspect.Id,
  architecture: inspect.Architecture,
  curlSha256,
  curlVersion,
  binarySha256: createHash("sha256").update(binary).digest("hex"),
  checks: [
    "non-root",
    "read-only",
    "offline-maintenance-no-network",
    "shellless",
    "init",
    "validate",
    "backup",
    "restore",
    "maintenance",
    "missing-library-failure",
    ...service.checks,
  ],
  snapshot,
  summary: initialized,
};
writeFileSync(
  path.join(output, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));
