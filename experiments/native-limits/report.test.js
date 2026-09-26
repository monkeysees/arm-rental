import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "./report.js";

test("service resume variation excludes separate maintenance resume phases", () => {
  const records = [1, 2, 3]
    .flatMap((repeat) => [
      { label: `mb75-r${repeat}-resume`, wallMs: repeat * 1000 },
      { label: `mb75-r${repeat}-restored-resume`, wallMs: repeat * 10 },
      { label: `mb75-r${repeat}-migrated-resume`, wallMs: repeat * 100 },
    ])
    .map((record) => ({
      ...record,
      measured: true,
      limitBytes: 75000000,
      samples: [],
      health: [],
    }));
  const result = summarize({
    users: 500,
    limitsBytes: [75000000, 50000000],
    records,
    runs: [],
    image: { Id: "test-image" },
    peer: { samples: [] },
  });
  assert.deepEqual(result.limits[0].variation.resume.wallMs, {
    min: 1000,
    median: 2000,
    max: 3000,
  });
  assert.deepEqual(result.limits[0].variation["restored-resume"].wallMs, {
    min: 10,
    median: 20,
    max: 30,
  });
});
