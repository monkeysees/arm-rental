import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

import {
  createReleaseContract,
  findReleaseEvidence,
} from "../scripts/release-operations.js";

const executeFile = promisify(execFile);
const digest = (name, character) => `${name}@sha256:${character.repeat(64)}`;
const completeArguments = {
  operation: "deploy",
  environment: "production",
  actor: "Alex Operator",
  image: digest("registry.example/bot", "a"),
  "previous-image": digest("registry.example/bot", "b"),
  snapshot: "/app-backups/daily/2026-07-25T00:00:00.000Z",
  "poll-interval-ms": "60000",
  "observation-minutes": "6",
  delivery: "both",
  "state-strategy": "restore",
  dryRun: true,
};

test("release contract requires immutable artifacts and a complete observation window", () => {
  const contract = createReleaseContract(completeArguments);
  assert.equal(contract.observationMs, 360_000);
  assert.equal(contract.dryRun, true);

  for (const [change, expected] of [
    [{ image: "registry.example/bot:latest" }, /immutable image/u],
    [{ actor: "unknown" }, /human or automation/u],
    [{ snapshot: "/app-backups/.snapshot-temporary" }, /published/u],
    [{ "observation-minutes": "5" }, /crawl interval plus five minutes/u],
  ]) {
    assert.throws(
      () => createReleaseContract({ ...completeArguments, ...change }),
      expected,
    );
  }
});

test("release contract is production-only and validation does not invoke Docker", async () => {
  assert.throws(
    () =>
      createReleaseContract({
        ...completeArguments,
        environment: "staging",
      }),
    /environment must be production/iu,
  );
  assert.throws(
    () =>
      createReleaseContract({
        ...completeArguments,
        operation: "rehearse",
      }),
    /operation must be validate, deploy, or rollback/iu,
  );

  const script = new URL("../scripts/release-operations.js", import.meta.url);
  const { stdout } = await executeFile(process.execPath, [
    script.pathname,
    "validate",
    "--environment",
    "production",
    "--actor",
    "Alex Operator",
    "--image",
    digest("registry.example/bot", "a"),
    "--previous-image",
    digest("registry.example/bot", "b"),
    "--snapshot",
    "/app-backups/daily/2026-07-25T00:00:00.000Z",
    "--poll-interval-ms",
    "60000",
    "--observation-minutes",
    "6",
    "--delivery",
    "channel",
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "validated");
  assert.equal(result.mutation, "none");
  assert.equal(result.contract.environment, "production");
  assert.equal(result.contract.projectName, "rental-apartments");
  assert.match(result.plan.join("\n"), /stop old container/iu);
  assert.match(result.plan.join("\n"), /retain the previous image/iu);

  const source = await readFile(script, "utf8");
  assert.match(source, /assertRollbackStateCompatibility/u);
  assert.ok(
    source.indexOf("assertRollbackStateCompatibility") <
      source.indexOf("await stopAndConfirm(contract)"),
    "compatible rollback must fail before stopping the live service",
  );

  await assert.rejects(
    executeFile(process.execPath, [script.pathname, "rehearse"]),
    /Usage:/u,
  );
});

test("release evidence requires ready preflight, crawl, and expected channel behavior", () => {
  const logs = [
    {
      event: "startup.preflight.completed",
      preflight: {
        status: "ready",
        checks: { telegram: "passed", channel: "passed" },
      },
    },
    {
      event: "crawl.succeeded",
      crawlId: "crawl-1",
      durationMs: 100,
      notified: 0,
      channelSent: 0,
      channelEdited: 0,
    },
  ]
    .map(JSON.stringify)
    .join("\n");

  assert.deepEqual(findReleaseEvidence(logs, "channel"), {
    ready: true,
    preflight: JSON.parse(logs.split("\n")[0]),
    crawl: JSON.parse(logs.split("\n")[1]),
    telegramVerified: true,
    channelVerified: true,
  });
  assert.equal(findReleaseEvidence(logs, "private").channelVerified, false);
  assert.equal(
    findReleaseEvidence(
      logs.replace("crawl.succeeded", "crawl.failed"),
      "channel",
    ).ready,
    false,
  );
});

test("production Compose preserves independent data and backup volumes", async () => {
  const compose = await readFile(
    new URL("../compose.production.yaml", import.meta.url),
    "utf8",
  );
  assert.match(compose, /- rental-apartments-data:\/app\/\.data/u);
  assert.match(compose, /- rental-apartments-backups:\/app-backups/u);
  assert.match(compose, /com\.rental-apartments\.environment: production/u);
  assert.doesNotMatch(compose, /DEPLOYMENT_ENVIRONMENT/u);
  assert.match(
    compose,
    /rental-apartments-backups:\s+name: rental-apartments-backups\s+external: true/su,
  );
  assert.match(compose, /order: stop-first/u);
  assert.doesNotMatch(compose, /order: start-first/u);
});

test("operations index covers every required runbook and each canonical page is actionable", async () => {
  const files = [
    "docs/deployment-from-scratch.md",
    "docs/release-and-rollback.md",
    "docs/token-rotation.md",
    "docs/browser-operations.md",
    "docs/state-recovery.md",
    "docs/startup-preflight.md",
    "docs/runtime-incidents.md",
    "docs/state-maintenance.md",
  ];
  const entries = await Promise.all(
    files.map(async (file) => [
      file,
      await readFile(new URL(`../${file}`, import.meta.url), "utf8"),
    ]),
  );
  for (const [file, runbook] of entries) {
    for (const required of [
      /prerequisite/iu,
      /safe check|safe snapshot check/iu,
      /```sh/u,
      /expected/iu,
      /recover|restore/iu,
      /rollback|pre-change|retained/iu,
      /escalat/iu,
    ]) {
      assert.match(runbook, required, `${file} is missing ${required}`);
    }
  }

  const index = await readFile(
    new URL("../docs/operational-runbooks.md", import.meta.url),
    "utf8",
  );
  for (const topic of [
    "Fresh production launch",
    "Deploy and rollback",
    "Rotate Telegram token",
    "browser verification",
    "Restore persistent state",
    "Malformed, incompatible",
    "Stale crawling",
    "Telegram private or channel",
    "Stale singleton or Chrome lock",
    "Low disk or growing state",
  ]) {
    assert.match(index, new RegExp(topic, "iu"));
  }

  const launchRunbook = await readFile(
    new URL("../docs/deployment-from-scratch.md", import.meta.url),
    "utf8",
  );
  for (const required of [
    /Where commands run/u,
    /Required CI/u,
    /Publish production/u,
    /infra\/hcloud\/bootstrap\.sh --check/u,
    /rentalctl status/u,
    /production-exercise finalize/u,
    /Subsequent deployments/u,
  ]) {
    assert.match(launchRunbook, required);
  }

  for (const entrypoint of [
    "README.md",
    "docs/architecture.md",
    "docs/operational-runbooks.md",
  ]) {
    const content = await readFile(
      new URL(`../${entrypoint}`, import.meta.url),
      "utf8",
    );
    assert.match(
      content,
      /deployment-from-scratch\.md/u,
      `${entrypoint} does not identify the canonical launch runbook`,
    );
  }
});
