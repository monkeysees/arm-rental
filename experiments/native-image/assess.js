import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { verifyReplayResult } from "../node-replay/verify.js";
const [variants, output] = process.argv.slice(2);
assert(variants && output, "assess.js VARIANTS NEW_OUTPUT");
mkdirSync(output);
const digest = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const manifest = {
  architecture: "linux/amd64",
  boundary:
    "Single sequential 500-recipient virtual replay/recovery acceptance per variant, one CPU/512MiB no swap, external Node oracle. Wall time includes container startup and synthetic fixture setup; not a repeated performance benchmark or Pi measurement.",
  variants: [],
};
for (const [name, runtime] of [
  ["rust-default", "rust"],
  ["rust-size", "rust"],
  ["go-default", "go"],
  ["go-stripped", "go"],
]) {
  const binary = path.resolve(variants, name);
  const started = performance.now();
  const result = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=384m",
      "-v",
      `${process.cwd()}:/repo:ro`,
      "-v",
      `${binary}:/replay:ro`,
      "-w",
      "/repo",
      "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
      "node",
      "experiments/node-replay/run.js",
      "--users",
      "500",
      "--mode",
      "virtual",
      "--runtime",
      runtime,
      `--${runtime}-binary`,
      "/replay",
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const wallSeconds = (performance.now() - started) / 1000;
  verifyReplayResult(JSON.parse(result));
  writeFileSync(path.join(output, `${name}.json`), result);
  const sections = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${path.resolve(variants)}:/variants:ro`,
      "arm-rental-rust-replay-build",
      "readelf",
      "-S",
      `/variants/${name}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(sections.status, 0);
  const item = {
    name,
    runtime,
    binarySha256: digest(binary),
    binaryBytes: statSync(binary).size,
    gzipLevel9BinaryBytes: gzipSync(readFileSync(binary), { level: 9 }).length,
    wallSeconds,
    oraclePassed: true,
    resultSha256: digest(path.join(output, `${name}.json`)),
    hasEmbeddedDebugInfo: sections.stdout.includes(".debug_info"),
    hasSymbolTable: sections.stdout.includes(".symtab"),
  };
  if (runtime === "rust") {
    const debug = `${binary}.debug`;
    const diagnosis = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${path.resolve(variants)}:/variants:ro`,
        "arm-rental-rust-replay-build",
        "sh",
        "-c",
        'address="$(nm -C "$1" | awk \'/ [tT] rental_replay::main$/ {print $1}\')"; test -n "$address"; addr2line -f -e "$2" "$address"',
        "sh",
        `/variants/${name}.full`,
        `/variants/${name}`,
      ],
      { encoding: "utf8" },
    );
    assert.match(diagnosis, /\.rs:[1-9][0-9]*/);
    item.externalSymbols = {
      bytes: statSync(debug).size,
      sha256: digest(debug),
      symbolization: diagnosis,
      boundary:
        "GNU debuglink finds external line tables; optimized/inlined frames and local-variable inspection remain limited by debug=1 and optimization",
    };
  }
  if (runtime === "go") {
    const diagnosis = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${path.resolve(variants)}:/variants:ro`,
        "arm-rental-rust-replay-build",
        "sh",
        "-c",
        'address="$(nm /variants/go-default | awk \'/ [tT] main.main$/ {print $1}\')"; test -n "$address"; addr2line -f -e /variants/go-default.debug "$address"',
      ],
      { encoding: "utf8" },
    );
    assert.match(diagnosis, /main\.main/);
    const nativeDiagnosis = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${path.resolve(variants)}:/variants:ro`,
        "golang:1.27.1-bookworm@sha256:648f440f42a0958804efb24df176f806f9d353b41f1c0627f666428e40310f6b",
        "sh",
        "-c",
        'address="$(nm /variants/go-default | awk \'/ [tT] main.main$/ {print $1}\')"; printf "0x%s\\n" "$address" | go tool addr2line /variants/go-default',
      ],
      { encoding: "utf8" },
    );
    assert.match(nativeDiagnosis, /main\.go:[1-9][0-9]*/);
    const defaultText = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${path.resolve(variants)}:/variants:ro`,
        "arm-rental-rust-replay-build",
        "sh",
        "-c",
        'objcopy --dump-section .text=/tmp/text "$1" /tmp/copy; sha256sum /tmp/text; readelf -WS "$1" | grep " .text "',
        "sh",
        `/variants/${name}`,
      ],
      { encoding: "utf8" },
    );
    item.textSection = defaultText;
    item.externalSymbols = {
      sha256: digest(path.join(variants, "go-default.debug")),
      bytes: statSync(path.join(variants, "go-default.debug")).size,
      symbolization: diagnosis,
      nativeSymbolizationUsingFullBuild: nativeDiagnosis,
      boundary:
        "GNU addr2line resolves the external symbol but not a source line (go.go:?). Go native addr2line recovers source from the retained full build. Full unstripped build and separate DWARF retained. Identical .text hash/address checked for this stripped rebuild; Go runtime traceback tables remain, external debugger local-variable/type inspection loses DWARF without symbols.",
    };
  }
  manifest.variants.push(item);
  writeFileSync(
    path.join(output, "assessment.json"),
    JSON.stringify(manifest, null, 2),
  );
  console.log(
    `${name}: ${item.binaryBytes} bytes, ${wallSeconds.toFixed(3)} s, oracle passed`,
  );
}

assert.equal(
  manifest.variants[2].textSection,
  manifest.variants[3].textSection,
  "Go stripped text bytes and virtual address must match retained external symbols",
);
