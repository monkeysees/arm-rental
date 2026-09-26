import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hash, hashes } from "./common.js";
import { verifyReplayResult } from "../node-replay/verify.js";

const [output, sqliteSource] = process.argv.slice(2);
assert(
  path.isAbsolute(output ?? "") && path.isAbsolute(sqliteSource ?? ""),
  "Usage: profile-sqlite.js /ABSOLUTE/NEW_OUTPUT /ABSOLUTE/libsqlite3-sys-0.38.2",
);
const root = process.cwd();
const baseline = "619b55f7df3f644e8ff782eb92945095d9dee0dc";
const command = (program, args) =>
  execFileSync(program, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
const replaceOnce = (source, before, after) => {
  assert.equal(
    source.split(before).length,
    2,
    "instrumentation anchor changed",
  );
  return source.replace(before, after);
};
mkdirSync(output);
const sqlite = path.join(output, "sqlite");
cpSync(sqliteSource, sqlite, { recursive: true });
assert.match(
  readFileSync(path.join(sqlite, "Cargo.toml"), "utf8"),
  /version = "0\.38\.2"/,
);
const amalgamation = path.join(sqlite, "sqlite3/sqlite3.c");
const originalSqliteHash = hash(amalgamation);
let source = readFileSync(amalgamation, "utf8");
const start = source.lastIndexOf("SQLITE_API int sqlite3_wal_checkpoint_v2(");
const end = source.indexOf("SQLITE_API int sqlite3_wal_checkpoint(", start);
assert(start > 0 && end > start);
let checkpoint = source.slice(start, end);
checkpoint = replaceOnce(
  checkpoint,
  "  int iDb;                        /* Schema to checkpoint */",
  `  int iDb;                        /* Schema to checkpoint */
  struct timespec profileStart, profileEnd;
  clock_gettime(CLOCK_MONOTONIC, &profileStart);`,
);
checkpoint = replaceOnce(
  checkpoint,
  "  sqlite3_mutex_leave(db->mutex);\n  return rc;",
  `  sqlite3_mutex_leave(db->mutex);
  clock_gettime(CLOCK_MONOTONIC, &profileEnd);
  fprintf(stderr, "{\\"checkpointProfile\\":{\\"mode\\":%d,\\"rc\\":%d,\\"wallMs\\":%.6f}}\\n",
    eMode, rc, (profileEnd.tv_sec-profileStart.tv_sec)*1000.0 +
    (profileEnd.tv_nsec-profileStart.tv_nsec)/1000000.0);
  return rc;`,
);
source = `${source.slice(0, start)}#include <time.h>\n${checkpoint}${source.slice(end)}`;
writeFileSync(amalgamation, source);
const manifest = {
  purpose:
    "Supplemental write/checkpoint latency; instrumented, virtual transport, not RAM or capacity evidence",
  baseline,
  candidateRevision: command("git", ["rev-parse", "HEAD"]).trim(),
  candidateWorkingTree: command("git", ["status", "--short"]).trim(),
  scriptSha256: hash("experiments/service-replay/profile-sqlite.js"),
  originalSqliteHash,
  instrumentedSqliteHash: hash(amalgamation),
  buildImage: command("docker", [
    "image",
    "inspect",
    "arm-rental-rust-replay-build",
    "--format",
    "{{.Id}}",
  ]).trim(),
  runImage: command("docker", [
    "image",
    "inspect",
    "node:24.18.0-bookworm-slim",
    "--format",
    "{{.Id}}",
  ]).trim(),
  kernel: command("uname", ["-a"]).trim(),
  cpu: command("lscpu", []),
  variants: {},
  runs: [],
};
const save = () =>
  writeFileSync(
    path.join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
save();
// Only generated copies are instrumented. Registry cache and repository sources stay intact.
for (const variant of ["before", "after"]) {
  const directory = path.join(output, variant);
  mkdirSync(directory);
  writeFileSync(path.join(directory, "package.json"), '{"type":"module"}\n');
  cpSync(
    "experiments/node-replay",
    path.join(directory, "experiments/node-replay"),
    { recursive: true },
  );
  const files = command("git", [
    "ls-tree",
    "-r",
    "--name-only",
    variant === "before" ? baseline : "HEAD",
    "--",
    "experiments/rust-replay",
  ])
    .trim()
    .split("\n");
  const native = path.join(directory, "experiments/rust-replay");
  for (const file of files) {
    const target = path.join(directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      variant === "before"
        ? command("git", ["show", `${baseline}:${file}`])
        : readFileSync(path.join(root, file)),
    );
  }
  const inputHashes = hashes(native);
  if (variant === "before") {
    const store = path.join(native, "src/store.rs");
    let code = readFileSync(store, "utf8");
    const begin = code.indexOf("    pub fn seed(");
    const finish = code.indexOf("    pub fn classify(", begin);
    let seed = code.slice(begin, finish);
    seed = replaceOnce(
      seed,
      "        let tx = self.db.transaction()?;",
      "        let profile_start = std::time::Instant::now();\n        let tx = self.db.transaction()?;",
    );
    seed = replaceOnce(
      seed,
      "        tx.commit()?;",
      `        let write_ms = profile_start.elapsed().as_secs_f64()*1000.0;
        let commit_started = std::time::Instant::now();
        tx.commit()?;
        let commit_ms = commit_started.elapsed().as_secs_f64()*1000.0;
        eprintln!("{}", serde_json::json!({"writeProfile":{"operation":"seed","rows":users*m.seed.decisions_per_recipient,"writeMs":write_ms,"commitMs":commit_ms}}));`,
    );
    code = code.slice(0, begin) + seed + code.slice(finish);
    writeFileSync(store, code);
  }
  const cargo = path.join(native, "Cargo.toml");
  writeFileSync(
    cargo,
    `${readFileSync(cargo, "utf8")}\n[patch.crates-io]\nlibsqlite3-sys = { path = "/profile/sqlite" }\n`,
  );
  const buildArgs = [
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${output}:/profile`,
    "-v",
    `${path.resolve(sqliteSource, "../../..")}:/usr/local/cargo/registry:ro`,
    "-e",
    "CARGO_TARGET_DIR=/profile/target",
    "-w",
    `/profile/${variant}/experiments/rust-replay`,
    manifest.buildImage,
    "cargo",
    "build",
    "--offline",
    "--release",
  ];
  console.error(`Building instrumented ${variant}`);
  execFileSync("docker", buildArgs, { stdio: "inherit" });
  const binary = path.join(output, `${variant}-replay`);
  cpSync(path.join(output, "target/release/rental-replay"), binary);
  manifest.variants[variant] = {
    inputHashes,
    sourceHashes: hashes(native),
    binarySha256: hash(binary),
    buildArgs,
  };
  save();
}
for (const variant of ["before", "after"]) {
  for (let repeat = 1; repeat <= 3; repeat++) {
    const name = `${variant}-${repeat}`;
    const args = [
      "run",
      "--rm",
      "--network",
      "none",
      "--cpus",
      "1",
      "--memory",
      "536870912",
      "--memory-swap",
      "536870912",
      "-v",
      `${output}:/profile:ro`,
      "-w",
      `/profile/${variant}`,
      manifest.runImage,
      "node",
      "experiments/node-replay/run.js",
      "--runtime",
      "rust",
      "--rust-binary",
      `/profile/${variant}-replay`,
      "--users",
      "500",
      "--mode",
      "virtual",
    ];
    console.error(`Profiling ${name}`);
    const process = spawnSync("docker", args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    writeFileSync(path.join(output, `${name}.json`), process.stdout ?? "");
    writeFileSync(path.join(output, `${name}.log`), process.stderr ?? "");
    const run = {
      name,
      args,
      exitCode: process.status,
      sha256: hash(path.join(output, `${name}.json`)),
      stderrSha256: hash(path.join(output, `${name}.log`)),
    };
    manifest.runs.push(run);
    save();
    assert.equal(
      process.status,
      0,
      `${name} failed: ${process.error ?? process.stderr}`,
    );
    const result = JSON.parse(process.stdout);
    verifyReplayResult(result);
    const observations = process.stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const checkpoints = observations
      .filter((o) => o.checkpointProfile)
      .map((o) => o.checkpointProfile);
    assert(checkpoints.length > 0);
    for (const check of checkpoints) assert.equal(check.rc, 0);
    const seed =
      variant === "before"
        ? observations.find((o) => o.writeProfile).writeProfile
        : result.workers[0].storage.operations.find(
            (o) => o.operation === "seed",
          );
    run.seed = seed;
    run.checkpoints = Object.fromEntries(
      [0, 3].map((mode) => {
        const samples = checkpoints
          .filter((c) => c.mode === mode)
          .map((c) => c.wallMs);
        return [
          mode === 0 ? "passive" : "truncate",
          {
            count: samples.length,
            totalMs: samples.reduce((sum, ms) => sum + ms, 0),
            maxMs: samples.length ? Math.max(...samples) : 0,
          },
        ];
      }),
    );
    run.behavior = "passed";
    save();
  }
}
