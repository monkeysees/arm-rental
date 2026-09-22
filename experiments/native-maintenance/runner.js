import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
const execute = promisify(execFile);

export async function createRunner(output, binary, image) {
  mkdirSync(path.join(output, "scratch-temp"));
  const records = [];
  const imageId = (
    await execute("docker", ["image", "inspect", image, "--format", "{{.Id}}"])
  ).stdout.trim();
  function disk() {
    const seen = new Set();
    const sizes = {
      databaseBytes: 0,
      walBytes: 0,
      temporaryBytes: 0,
      otherBytes: 0,
    };
    function visit(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "fixtures") continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(file);
          continue;
        }
        const stat = statSync(file);
        const inode = `${stat.dev}:${stat.ino}`;
        if (seen.has(inode)) continue;
        seen.add(inode);
        const key = entry.name.endsWith("-wal")
          ? "walBytes"
          : entry.name.startsWith("incomplete") ||
              entry.name.endsWith("-journal") ||
              dir.endsWith("scratch-temp")
            ? "temporaryBytes"
            : entry.name.endsWith(".sqlite3")
              ? "databaseBytes"
              : "otherBytes";
        sizes[key] += stat.size;
      }
    }
    visit(output);
    return {
      ...sizes,
      totalBytes: Object.values(sizes).reduce((a, b) => a + b, 0),
    };
  }
  async function run(label, args, expected = 0, executable = binary) {
    const command = [
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
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--env",
      "SQLITE_TMPDIR=/state/scratch-temp",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "-v",
      `${output}:/state`,
      "-v",
      `${executable}:/usr/local/bin/replay:ro`,
      imageId,
      ...args,
    ];
    const before = disk();
    let peak = before;
    const categoryPeaks = { ...before };
    function samplePeak(sample) {
      for (const key of Object.keys(sample))
        categoryPeaks[key] = Math.max(categoryPeaks[key], sample[key]);
      if (sample.totalBytes > peak.totalBytes) peak = sample;
    }
    const timer = setInterval(() => {
      try {
        const sample = disk();
        samplePeak(sample);
      } catch {
        /* Files can disappear between SQLite close and sampling. */
      }
    }, 10);
    let stdout,
      stderr,
      code = 0;
    try {
      ({ stdout, stderr } = await execute("docker", command, {
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (error) {
      ({ stdout, stderr, code } = error);
    } finally {
      clearInterval(timer);
    }
    assert.equal(code, expected, `${label}: ${stderr}`);
    const value = stdout.trim() ? JSON.parse(stdout) : null;
    const after = disk();
    samplePeak(after);
    records.push({
      label,
      command: ["docker", ...command],
      exitCode: code,
      stderr,
      before,
      after,
      sampledPeakDisk: peak,
      sampledCategoryPeaks: categoryPeaks,
    });
    if (value)
      writeFileSync(
        path.join(output, `${label}.json`),
        JSON.stringify(value, null, 2) + "\n",
      );
    return value;
  }

  return { run, records, imageId };
}
