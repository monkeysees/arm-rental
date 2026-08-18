import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRollbackStateCompatibility,
  isReleaseStateCompatible,
  validateReleaseStateCompatibility,
} from "../src/release-compatibility.js";

test("release compatibility requires one backend and a valid schema range", () => {
  assert.deepEqual(
    validateReleaseStateCompatibility({
      stateBackend: "json",
      minimumStateSchema: 0,
      maximumStateSchema: 0,
    }),
    {
      stateBackend: "json",
      minimumStateSchema: 0,
      maximumStateSchema: 0,
    },
  );
  assert.equal(
    isReleaseStateCompatible(
      {
        stateBackend: "sqlite",
        minimumStateSchema: 2,
        maximumStateSchema: 4,
      },
      { stateBackend: "sqlite", stateSchema: 3 },
    ),
    true,
  );
  for (const invalid of [
    { stateBackend: "json", minimumStateSchema: 0, maximumStateSchema: 1 },
    { stateBackend: "sqlite", minimumStateSchema: 0, maximumStateSchema: 1 },
    { stateBackend: "sqlite", minimumStateSchema: 2, maximumStateSchema: 1 },
  ]) {
    assert.throws(() => validateReleaseStateCompatibility(invalid), /state/u);
  }
});

test("compatible rollback rejects cross-backend and out-of-range live state", () => {
  const targetMetadata = {
    stateBackend: "sqlite",
    minimumStateSchema: 2,
    maximumStateSchema: 4,
  };
  assert.doesNotThrow(() =>
    assertRollbackStateCompatibility({
      stateStrategy: "compatible",
      targetMetadata,
      liveState: { stateBackend: "sqlite", stateSchema: 3 },
    }),
  );
  for (const liveState of [
    { stateBackend: "json", stateSchema: 0 },
    { stateBackend: "sqlite", stateSchema: 5 },
  ]) {
    assert.throws(
      () =>
        assertRollbackStateCompatibility({
          stateStrategy: "compatible",
          targetMetadata,
          liveState,
        }),
      (error) => error.code === "ERR_RELEASE_STATE_INCOMPATIBLE",
    );
  }
  assert.doesNotThrow(() =>
    assertRollbackStateCompatibility({
      stateStrategy: "restore",
      targetMetadata,
      liveState: { stateBackend: "json", stateSchema: 0 },
    }),
  );
});
