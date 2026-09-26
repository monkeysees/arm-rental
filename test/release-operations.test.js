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
      source.indexOf("await stopAndConfirm("),
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
    "docs/source-operations.md",
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
    "source access",
    "Restore persistent state",
    "Malformed, incompatible",
    "Stale crawling",
    "Telegram private or channel",
    "Stale singleton lock",
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

async function manualReleaseFixture(
  t,
  {
    candidateRuntime,
    previousRuntime,
    operation = "deploy",
    stateStrategy = "compatible",
    schema = 6,
    maximumSchema = 6,
    failCandidate = false,
  },
) {
  const { mkdtemp, mkdir, writeFile, chmod, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "manual-release-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const fixture = {
    candidate: completeArguments.image,
    previous: completeArguments["previous-image"],
    candidateRuntime,
    previousRuntime,
    schema,
    maximumSchema,
    failCandidate,
  };
  await writeFile(path.join(root, "fixture.json"), JSON.stringify(fixture));
  await writeFile(
    path.join(bin, "docker"),
    `#!${process.execPath}\n` +
      String.raw`
const fs = require("node:fs");
const root = process.env.FAKE_DOCKER_ROOT;
const fixture = JSON.parse(fs.readFileSync(root + "/fixture.json", "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(root + "/calls.jsonl", JSON.stringify({ args, image: process.env.RENTAL_APARTMENTS_IMAGE }) + "\n");
function print(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
if (args[0] === "image") {
  const candidate = args.at(-1) === fixture.candidate;
  const runtime = candidate ? fixture.candidateRuntime : fixture.previousRuntime;
  print({ "com.rental-apartments.state.backend": "sqlite", "com.rental-apartments.state.schema.minimum": "1", "com.rental-apartments.state.schema.maximum": String(candidate ? fixture.maximumSchema : 6), ...(runtime === undefined ? {} : { "com.rental-apartments.runtime": runtime }) });
} else if (args[0] === "inspect") {
  if (args.includes("{{.State.Running}}")) process.stdout.write("false\n");
  else print({ Config: { Image: fixture.previous, Labels: { "com.rental-apartments.environment": "production" } }, State: { Running: true }, Mounts: [{ Destination: "/app/.data", Type: "volume", Name: "rental-apartments-data" }] });
} else if (args[0] === "compose") {
  if (args.includes("config")) print({ services: { bot: { container_name: "rental-apartments-bot", labels: { "com.rental-apartments.environment": "production" }, environment: { NODE_ENV: "production" }, read_only: true, deploy: { replicas: 1, update_config: { order: "stop-first" } }, volumes: [{ target: "/app/.data", type: "volume" }] } } });
  else if (args.includes("up") && fixture.failCandidate && process.env.RENTAL_APARTMENTS_IMAGE === fixture.candidate) process.exit(17);
  else print({ ok: true });
} else if (args[0] === "exec") {
  if (args.includes("state:inspect") || args.some((arg) => arg.includes("PRAGMA user_version"))) print({ stateBackend: "sqlite", stateSchema: fixture.schema });
  else print({ ready: true });
} else if (args[0] === "logs") {
  print({ event: "startup.preflight.completed", preflight: { status: "ready", checks: { telegram: "passed", channel: "passed" } } });
  print({ event: "crawl.succeeded", crawlId: "native-crawl", notified: 1, channelSent: 1, channelEdited: 0 });
} else process.exit(90);
`,
  );
  await chmod(path.join(bin, "docker"), 0o755);
  await writeFile(
    path.join(root, "clock.mjs"),
    `const OriginalDate = Date; let clock = OriginalDate.now(); globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }; const originalTimer = setTimeout; globalThis.setTimeout = (fn, ms, ...args) => { clock += Number(ms) || 0; return originalTimer(fn, 0, ...args); };`,
  );
  const script = new URL("../scripts/release-operations.js", import.meta.url)
    .pathname;
  const args = [
    "--import",
    path.join(root, "clock.mjs"),
    script,
    operation,
    "--environment",
    "production",
    "--actor",
    "test:manual-release",
    "--image",
    fixture.candidate,
    "--previous-image",
    fixture.previous,
    "--snapshot",
    completeArguments.snapshot,
    "--poll-interval-ms",
    "60000",
    "--observation-minutes",
    "6",
    "--delivery",
    "both",
    "--state-strategy",
    stateStrategy,
    "--evidence-file",
    path.join(root, "evidence.json"),
  ];
  const run = () =>
    executeFile(process.execPath, args, {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_DOCKER_ROOT: root,
      },
    });
  const calls = async () =>
    (await readFile(path.join(root, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
  return { run, calls };
}

test("manual release uses Rust image commands and retains unlabeled Node rollback tooling", async (t) => {
  const fixture = await manualReleaseFixture(t, { candidateRuntime: "rust" });
  await fixture.run();
  const calls = await fixture.calls();
  const validation = calls.find(({ args }) => args.includes("backup:validate"));
  assert.deepEqual(validation.args.slice(-5), [
    "npm",
    "run",
    "backup:validate",
    "--",
    completeArguments.snapshot,
  ]);
  const starts = calls.filter(({ args }) => args.includes("up"));
  assert.equal(starts.length, 1);
  assert.ok(
    starts[0].args.some((arg) => arg.endsWith("ops/compose.native.yaml")),
  );
  const probes = calls.filter(({ args }) => args[0] === "exec");
  assert.ok(probes.length > 0);
  for (const probe of probes)
    assert.deepEqual(probe.args.slice(2), [
      "/usr/local/bin/rental-app",
      "health-check",
      "--ready",
      "--json",
    ]);
});

test("manual rollback inspects live Rust state without a writer and runs retained Node readiness", async (t) => {
  const fixture = await manualReleaseFixture(t, {
    previousRuntime: "rust",
    operation: "rollback",
  });
  await fixture.run();
  const calls = await fixture.calls();
  const inspection = calls.findIndex(({ args }) =>
    args.includes("state:inspect"),
  );
  const stop = calls.findIndex(({ args }) => args.includes("stop"));
  assert.ok(inspection >= 0 && inspection < stop);
  assert.deepEqual(calls[inspection].args, [
    "exec",
    "rental-apartments-bot",
    "/usr/local/bin/rental-app",
    "state:inspect",
  ]);
  const validation = calls.find(({ args }) => args.includes("backup:validate"));
  assert.deepEqual(validation.args.slice(-3), [
    "backup:validate",
    "--snapshot",
    completeArguments.snapshot,
  ]);
  const start = calls.find(({ args }) => args.includes("up"));
  assert.ok(!start.args.some((arg) => arg.endsWith("ops/compose.native.yaml")));
  assert.ok(
    calls.some(
      ({ args }) =>
        args[0] === "exec" && args[2] === "node" && args[3] === "-e",
    ),
  );
});

test("manual runner rejects unknown runtimes and incompatible live schemas before stopping", async (t) => {
  for (const options of [
    { candidateRuntime: "python" },
    { previousRuntime: "rust", operation: "rollback", maximumSchema: 5 },
  ]) {
    const fixture = await manualReleaseFixture(t, options);
    await assert.rejects(fixture.run());
    assert.ok(
      !(await fixture.calls()).some(({ args }) => args.includes("stop")),
    );
  }
});

test("manual failed rollout restores and probes the retained Rust image with its own tooling", async (t) => {
  const fixture = await manualReleaseFixture(t, {
    candidateRuntime: "node",
    previousRuntime: "rust",
    failCandidate: true,
  });
  await assert.rejects(fixture.run(), /previous image were restored/u);
  const calls = await fixture.calls();
  const restore = calls.find(({ args }) => args.includes("backup:restore"));
  assert.deepEqual(restore.args.slice(-3), [
    "backup:restore",
    "--snapshot",
    completeArguments.snapshot,
  ]);
  assert.equal(restore.image, completeArguments["previous-image"]);
  const starts = calls.filter(({ args }) => args.includes("up"));
  assert.equal(starts.length, 2);
  assert.ok(
    starts[1].args.some((arg) => arg.endsWith("ops/compose.native.yaml")),
  );
  assert.equal(starts[1].image, completeArguments["previous-image"]);
  assert.deepEqual(calls.at(-1).args.slice(2), [
    "/usr/local/bin/rental-app",
    "health-check",
    "--ready",
    "--json",
  ]);
});
