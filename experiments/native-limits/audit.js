import assert from "node:assert/strict";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateNativeCapacity } from "./capacity.js";
import { verifyReplayResult } from "../node-replay/verify.js";
import { hash, hashes } from "../service-replay/common.js";

export function audit(directory) {
  const original = path.join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(original));
  assert(
    manifest.finishedAt && manifest.status !== "running",
    "Measurements must be complete before audit",
  );
  assert.equal(manifest.runs.length, 6);
  assert.deepEqual(manifest.limitsBytes, [75000000, 50000000]);
  assert.deepEqual(
    manifest.runs.map((run) => [run.limitBytes, run.repeat]),
    [75000000, 50000000].flatMap((bytes) =>
      [1, 2, 3].map((repeat) => [bytes, repeat]),
    ),
  );
  assert.equal(manifest.runtimeSourceImageId, manifest.image.Id);
  assert.deepEqual(
    hashes("experiments/rust-replay"),
    manifest.sourceHashes,
    "measured native source changed",
  );
  const components = JSON.parse(
    readFileSync(
      path.join(
        directory,
        "runtime-source/usr/local/share/native-image/components.json",
      ),
    ),
  );
  for (const [file, component] of [
    ["/usr/local/bin/replay", components.replay],
    ["/usr/local/bin/curl-impersonate", components.curl],
  ])
    assert.equal(
      manifest.runtimeFiles.find((entry) => entry.path === file)?.sha256,
      component.sha256,
    );

  const oracleInputSha256 = {};
  function verifyRecord(run, suffix, expected = 0) {
    const record = manifest.records.find(
      (entry) => entry.label === `${run.label}-${suffix}`,
    );
    assert(record, `missing phase ${suffix}`);
    assert.equal(
      manifest.records.filter((entry) => entry.label === record.label).length,
      1,
    );
    assert.equal(record.measured, true);
    assert.equal(record.passed, true);
    assert.equal(record.exitCode, expected);
    assert.equal(record.finalState.ExitCode, expected);
    assert.equal(record.finalState.Running, false);
    assert.equal(record.finalState.OOMKilled, false);
    assert(
      !record.waitError && !record.samplingError && !record.cleanupAfterError,
    );
    assert.equal(record.config.Memory, run.limitBytes);
    assert.equal(record.config.MemorySwap, run.limitBytes);
    assert.equal(record.config.NanoCpus, 1000000000);
    assert.equal(record.config.ReadonlyRootfs, true);
    assert.equal(record.runtimeSourceImageId, manifest.image.Id);
    assert.equal(
      record.runtimeIdentity,
      "private byte-identical files from frozen image",
    );
    assert(record.command.includes(manifest.image.Id));
    const user = record.command[record.command.indexOf("--user") + 1];
    assert.match(
      user,
      /^[1-9][0-9]*:[0-9]+$/,
      "non-root numeric runtime identity",
    );
    assert(record.samples.length > 0);
    for (const sample of record.samples) {
      assert.equal(
        sample.memoryLimit,
        Math.floor(run.limitBytes / manifest.pageBytes) * manifest.pageBytes,
      );
      assert.equal(sample.swapLimit, 0);
      assert.equal(sample.cpuLimit, "100000 100000");
      assert(!/^oom(?:_kill|_group_kill)? [1-9]/m.test(sample.memoryEvents));
      for (const proc of sample.processes)
        assert.match(
          proc.command,
          /^(\/usr\/local\/bin\/(replay|curl-impersonate)( |$)|runc (init|--root \/var\/run\/docker\/runtime-runc\/moby )|$)/,
          "unexpected process in native cgroup",
        );
    }
    assert(record.cacheEviction.records.length > 0);
    assert(
      record.cacheEviction.records.every(
        (entry) => entry.residentPagesAfter === 0,
      ),
    );
    const bindings = record.config.Binds.map((binding) => {
      const [source, destination, mode] = binding.split(":");
      return { source, destination, mode };
    });
    for (const file of manifest.runtimeFiles) {
      const matches = bindings.filter(
        (binding) => binding.destination === file.path,
      );
      assert.equal(matches.length, 1, `runtime destination ${file.path}`);
      const binding = matches[0];
      assert.equal(binding.mode, "ro");
      assert.equal(
        binding.source,
        path.join(directory, run.label, "runtime", file.path.slice(1)),
      );
      assert.equal(hash(binding.source), file.sha256);
      const copied = statSync(binding.source);
      const source = statSync(
        path.join(directory, "runtime-source", file.path.slice(1)),
      );
      assert(
        copied.dev !== source.dev || copied.ino !== source.ino,
        "runtime inode must be private",
      );
      assert(
        record.cacheEviction.records.some(
          (entry) => entry.file === path.join("runtime", file.path.slice(1)),
        ),
      );
    }
    const fixtures = bindings.find(
      (binding) => binding.destination === "/fixtures",
    );
    assert.equal(fixtures?.mode, "ro");
    assert.equal(
      fixtures.source,
      path.join(directory, run.label, "input-fixtures"),
    );
    assert.deepEqual(hashes(fixtures.source), manifest.fixtureHashes);
    for (const file of Object.keys(manifest.fixtureHashes))
      assert(
        record.cacheEviction.records.some(
          (entry) => entry.file === path.join("input-fixtures", file),
        ),
      );
    return record;
  }
  function verifyResult(run, kind) {
    const filename = `${run.label}-${kind}-result.json`;
    oracleInputSha256[filename] = hash(path.join(directory, filename));
    const result = JSON.parse(
      readFileSync(path.join(directory, `${run.label}-${kind}-result.json`)),
    );
    assert.equal(result.workload.users, 500);
    verifyReplayResult(result);
    const wrong = structuredClone(result);
    wrong.phases
      .find((phase) => phase.name === "fresh")
      .deliveriesByProfile[0].reverse();
    assert.throws(() => verifyReplayResult(wrong));
    return result;
  }
  const runs = manifest.runs.map((originalRun) => {
    const run = {
      ...originalRun,
      originalServicePassed: originalRun.servicePassed,
      originalServiceError: originalRun.serviceError,
      servicePassed: false,
      maintenancePassed: false,
      migrationPassed: false,
      auditErrors: {},
    };
    delete run.serviceError;
    delete run.capacity;
    try {
      assert.equal(
        manifest.records.filter(
          (record) =>
            record.measured && record.label.startsWith(`${run.label}-`),
        ).length,
        7,
        "all seven measured phases required",
      );
      for (const suffix of ["maintenance-seed", "legacy-seed"]) {
        const preparation = manifest.records.filter(
          (record) => record.label === `${run.label}-${suffix}`,
        );
        assert.equal(preparation.length, 1);
        assert.equal(preparation[0].measured, false);
        assert.equal(preparation[0].passed, true);
        assert.equal(preparation[0].exitCode, 23);
      }
    } catch (error) {
      run.auditErrors.structure = error.message;
    }
    try {
      const exercise = verifyRecord(run, "exercise", 137);
      const resume = verifyRecord(run, "resume");
      assert.equal(exercise.forcedStop.signal, "SIGKILL");
      assert.equal(exercise.forcedStop.boundary, "durable pending-restart");
      assert(exercise.health.some((entry) => entry.text === "ok active"));
      assert(
        exercise.health.some((entry) => entry.text === "ok pending-restart"),
      );
      assert(resume.health.some((entry) => entry.text === "ok drained"));
      assert(
        exercise.samples.some((sample) =>
          sample.processes.some((proc) =>
            proc.command.includes("curl-impersonate"),
          ),
        ),
      );
      const result = verifyResult(run, "service");
      assert.equal(result.mode, "wall");
      run.capacity = evaluateNativeCapacity({
        users: 500,
        mode: "wall",
        phases: result.phases,
        primaryRamBytes: Math.max(
          ...exercise.samples.map((sample) => sample.peakBytes),
          ...resume.samples.map((sample) => sample.peakBytes),
        ),
      });
      run.capacity.withinRequestedMemoryLimit = [
        ...exercise.samples,
        ...resume.samples,
      ].every((sample) => sample.memoryLimit <= run.limitBytes);
      run.servicePassed = Object.values(run.capacity).every(
        (value) => typeof value !== "boolean" || value,
      );
      run.serviceOraclePassed = true;
    } catch (error) {
      run.auditErrors.service = error.message;
    }
    try {
      for (const suffix of ["backup", "restore", "restored-resume"])
        verifyRecord(run, suffix);
      verifyResult(run, "maintenance");
      run.maintenancePassed = true;
    } catch (error) {
      run.auditErrors.maintenance = error.message;
    }
    try {
      for (const suffix of ["migration", "migrated-resume"])
        verifyRecord(run, suffix);
      assert.equal(run.legacySourceHashes.length, 2);
      assert(
        run.legacySourceHashes.every((value) => /^[a-f0-9]{64}$/.test(value)),
      );
      verifyResult(run, "migration");
      run.migrationPassed = true;
    } catch (error) {
      run.auditErrors.migration = error.message;
    }
    run.verificationStatus =
      Object.keys(run.auditErrors).length === 0 ? "passed" : "failed";
    run.passed =
      run.verificationStatus === "passed" &&
      run.servicePassed &&
      run.maintenancePassed &&
      run.migrationPassed;
    return run;
  });
  return {
    status: runs.every((run) => run.passed) ? "passed" : "failed",
    verificationStatus: runs.every((run) => run.verificationStatus === "passed")
      ? "passed"
      : "failed",
    sourceHashes: manifest.sourceHashes,
    harnessHashes: hashes("experiments/native-limits"),
    originalHarnessHashes: manifest.harnessHashes,
    originalManifestSha256: hash(original),
    oracleInputSha256,
    correctionDescription:
      "Reporting-only correction: native recipientsAsserted and classificationWallMs + firstProgressMaxMs are adapted to the unchanged shared capacity contract. Original measurements, failures and thresholds remain unchanged. All completed outputs, oracle negative controls and cgroup/runtime/cache boundaries are independently rechecked.",
    runs,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], "Usage: audit.js COMPLETED_ACCEPTANCE_DIRECTORY");
  const directory = path.resolve(process.argv[2]);
  const result = audit(directory);
  writeFileSync(
    path.join(directory, "audit.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: result.status,
      runs: result.runs.map((run) => ({
        label: run.label,
        passed: run.passed,
        auditErrors: run.auditErrors,
      })),
    }),
  );
  process.exitCode = result.status === "passed" ? 0 : 1;
}
