import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const boundary = "native-service-only-v1";
export const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

export function hashes(directory, prefix = "") {
  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "target") return [];
      const relative = path.join(prefix, entry.name);
      const file = path.join(directory, entry.name);
      return entry.isDirectory()
        ? Object.entries(hashes(file, relative))
        : [[relative, hash(file)]];
    }),
  );
}

export function cgroupSample(directory) {
  const read = (file) =>
    readFileSync(path.join(directory, file), "utf8").trim();
  return {
    currentBytes: Number(read("memory.current")),
    peakBytes: Number(read("memory.peak")),
    memoryLimit: Number(read("memory.max")),
    swapLimit: Number(read("memory.swap.max")),
    cpuLimit: read("cpu.max"),
    memoryStat: read("memory.stat"),
    cpuStat: read("cpu.stat"),
    memoryEvents: read("memory.events"),
  };
}
