import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

for (const [name, output, code] of [
  ["failed ldd", "loader inspection failed", 9],
  ["unresolved library with successful ldd", "libmissing.so => not found", 0],
]) {
  test(`native assembly rejects ${name} before writing a root`, () => {
    const temporary = mkdtempSync(path.join(os.tmpdir(), "native-closure-"));
    try {
      writeFileSync(
        path.join(temporary, "ldd"),
        `#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${code}\n`,
        { mode: 0o755 },
      );
      const root = path.join(temporary, "root");
      const result = spawnSync(
        "bash",
        ["experiments/native-image/assemble", root],
        {
          env: { ...process.env, PATH: `${temporary}:${process.env.PATH}` },
          encoding: "utf8",
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(output));
      assert.equal(existsSync(root), false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
