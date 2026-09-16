import { readFileSync, statSync } from "node:fs";
export function cgroup(name) {
  try {
    return readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim();
  } catch {
    return null;
  }
}
export function memory() {
  return {
    ...process.memoryUsage(),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    serviceCurrentBytes: Number(cgroup("memory.current")) || null,
    servicePeakBytes: Number(cgroup("memory.peak")) || null,
  };
}
export function size(filename) {
  try {
    return statSync(filename).size;
  } catch {
    return 0;
  }
}
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries(
    [
      ["p50", 0.5],
      ["p95", 0.95],
      ["max", 1],
    ].map(([name, quantile]) => [
      name,
      sorted[Math.ceil(sorted.length * quantile) - 1] ?? 0,
    ]),
  );
}
