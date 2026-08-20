import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readProjectFile = (file) =>
  readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("production supervision prevents overlapping replicas and bounds restarts", async () => {
  const deployment = await readProjectFile("compose.production.yaml");

  assert.match(deployment, /container_name: rental-apartments-bot/u);
  assert.match(deployment, /replicas: 1/u);
  assert.match(
    deployment,
    /update_config:[\s\S]*?parallelism: 1[\s\S]*?order: stop-first/u,
  );
  assert.match(
    deployment,
    /rollback_config:[\s\S]*?parallelism: 1[\s\S]*?order: stop-first/u,
  );
  assert.match(deployment, /restart: "on-failure:5"/u);
  assert.match(
    deployment,
    /restart_policy:[\s\S]*?condition: on-failure[\s\S]*?max_attempts: 5/u,
  );
  assert.match(deployment, /stop_grace_period: 45s/u);
  assert.match(deployment, /DATA_DIRECTORY: \/app\/\.data/u);
  assert.match(deployment, /rental-apartments-data:\/app\/\.data/u);
  assert.match(deployment, /HEALTH_HOST: 127\.0\.0\.1/u);
  assert.match(
    deployment,
    /healthcheck:[\s\S]*?src\/health-check\.js[\s\S]*?--restart-unresponsive/u,
  );
  // The liveness command derives its own termination threshold and probe
  // budget from these settings, and keeps its consecutive-failure count on the
  // /tmp tmpfs so a replacement container starts a fresh run.
  assert.match(
    deployment,
    /healthcheck:[\s\S]*?interval: 30s[\s\S]*?timeout: 5s[\s\S]*?start_period: 60s[\s\S]*?retries: 2/u,
  );
  assert.match(deployment, /tmpfs:[\s\S]*?- \/tmp:size=\d+,mode=1777/u);
  assert.doesNotMatch(deployment, /^\s+ports:/mu);

  const dockerfile = await readProjectFile("Dockerfile");
  assert.match(
    dockerfile,
    /HEALTHCHECK[\s\S]*?src\/health-check\.js[\s\S]*?--restart-unresponsive/u,
  );
});
