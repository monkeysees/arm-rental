import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const bootstrap = path.join(repositoryRoot, "infra/hcloud/bootstrap.sh");

async function executable(filename, source) {
  await writeFile(filename, source, { mode: 0o755 });
  await chmod(filename, 0o755);
}

async function fixture(t, scenario = "converged") {
  const root = await mkdtemp(path.join(os.tmpdir(), "rental-hcloud-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  const publicKey = path.join(root, "id_ed25519.pub");
  const secret = path.join(root, "production.env");
  await mkdir(bin);
  await writeFile(publicKey, "ssh-ed25519 AAAATEST operator@example\n");
  await writeFile(
    secret,
    [
      "TELEGRAM_BOT_TOKEN=never-print-this-token",
      "TELEGRAM_OWNER_ID=123",
      "GHCR_IMAGE_REPOSITORY=ghcr.io/example/rental",
      "GHCR_USERNAME=reader",
      "GHCR_READ_TOKEN=never-print-this-ghcr-token",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await executable(
    path.join(bin, "hcloud"),
    `#!/usr/bin/env bash
set -eu
printf 'hcloud %s\\n' "$*" >>"$FAKE_LOG"
kind=\${1:-}
action=\${2:-}
labels='"labels":{"repository":"rental-apartments","role":"application","environment":"production"}'
if [[ $action == list ]]; then
  if [[ $FAKE_SCENARIO == missing ]]; then printf '[]\\n'; exit 0; fi
  if [[ $FAKE_SCENARIO == create && ! -e $FAKE_STATE/$kind ]]; then
    printf '[]\\n'
    exit 0
  fi
  case $kind in
    ssh-key)
      printf '[{"id":1,"name":"rental-apartments-production-ssh","public_key":"ssh-ed25519 AAAATEST operator@example",%s}]\\n' "$labels"
      ;;
    firewall)
      if [[ $FAKE_SCENARIO == drift ]]; then
        rules='[]'; applied='[]'
      else
        rules='[{"direction":"in","protocol":"tcp","port":"22","source_ips":["0.0.0.0/0","::/0"],"description":"Key-only SSH"}]'
        applied='[{"type":"server","server":{"id":4}}]'
        if [[ $FAKE_SCENARIO == create && ! -e $FAKE_STATE/server ]]; then applied='[]'; fi
      fi
      printf '[{"id":2,"name":"rental-apartments-production-firewall","rules":%s,"applied_to":%s,%s}]\\n' "$rules" "$applied" "$labels"
      ;;
    volume)
      server=4
      [[ $FAKE_SCENARIO == drift ]] && server=null
      [[ $FAKE_SCENARIO == create && ! -e $FAKE_STATE/server ]] && server=null
      printf '[{"id":3,"name":"rental-apartments-production-backups","size":20,"location":{"name":"nbg1"},"server":%s,"protection":{"delete":true},%s}]\\n' "$server" "$labels"
      ;;
    server)
      duplicate=''
      if [[ $FAKE_SCENARIO == duplicate ]]; then
        duplicate=',{"id":5,"name":"other-server","server_type":{"name":"cx23"},"location":{"name":"nbg1"},"image":{"id":12345},"public_net":{"ipv4":{"ip":"192.0.2.11"}},"protection":{"delete":true,"rebuild":true},'"$labels"'}'
      fi
      printf '[{"id":4,"name":"rental-apartments-production","server_type":{"name":"cx23"},"location":{"name":"nbg1"},"image":{"id":12345},"public_net":{"ipv4":{"ip":"192.0.2.10"}},"protection":{"delete":true,"rebuild":true},%s}%s]\\n' "$labels" "$duplicate"
      ;;
  esac
  exit 0
fi
if [[ $FAKE_SCENARIO == create && $action == create ]]; then
  if [[ $kind == server ]]; then
    previous=
    for argument in "$@"; do
      if [[ $previous == --user-data-from-file ]]; then
        cp "$argument" "$FAKE_STATE/user-data.yaml"
      fi
      previous=$argument
    done
  fi
  touch "$FAKE_STATE/$kind"
  printf '{"id":99}\\n'
  exit 0
fi
if [[ $action == describe ]]; then
  if [[ $kind == server ]]; then
    protection=true
    [[ $FAKE_SCENARIO == drift ]] && protection=false
    printf '{"id":4,"name":"rental-apartments-production","public_net":{"ipv4":{"ip":"192.0.2.10"}},"protection":{"delete":%s,"rebuild":%s}}\\n' "$protection" "$protection"
  else
    protection=true
    [[ $FAKE_SCENARIO == drift ]] && protection=false
    server=4
    [[ $FAKE_SCENARIO == drift ]] && server=null
    printf '{"id":3,"name":"rental-apartments-production-backups","server":%s,"protection":{"delete":%s}}\\n' "$server" "$protection"
  fi
fi
`,
  );
  await executable(
    path.join(bin, "ssh"),
    `#!/usr/bin/env bash
set -eu
printf 'ssh %s\\n' "$*" >>"$FAKE_LOG"
if [[ "$*" == *rental-host-bootstrap* ]]; then
  tar --extract --gzip --directory "$FAKE_BUNDLE_DIR" --file -
fi
`,
  );
  return {
    log,
    root,
    secret,
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LOG: log,
      FAKE_BUNDLE_DIR: root,
      FAKE_STATE: root,
      FAKE_SCENARIO: scenario,
      HCLOUD_SERVER_TYPE: "cx23",
      HCLOUD_LOCATION: "nbg1",
      HCLOUD_IMAGE_ID: "12345",
      HCLOUD_VOLUME_SIZE_GB: "20",
      HCLOUD_SSH_PUBLIC_KEY_FILE: publicKey,
      HCLOUD_INITIAL_SECRET_FILE: secret,
    },
  };
}

function run(arguments_, environment) {
  return new Promise((resolve) => {
    const child = spawn(bootstrap, arguments_, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("hcloud check is idempotent and transfers only the sanitized bootstrap bundle", async (t) => {
  const setup = await fixture(t);
  const result = await run(["--check"], setup.environment);
  assert.equal(result.status, 0, result.stderr);
  const commands = await readFile(setup.log, "utf8");
  assert.match(commands, /hcloud server list --output json/u);
  assert.match(commands, /ssh .*rental-host-bootstrap --bundle --check/u);
  assert.doesNotMatch(commands, /never-print-this/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /never-print-this/u);
  assert.equal(
    await readFile(path.join(setup.root, "ops/deploy-launcher"), "utf8").then(
      (contents) => contents.includes("BOOTSTRAP_DEPLOY"),
    ),
    true,
  );
  assert.equal(
    await readFile(
      path.join(setup.root, "ops/rentalctl-launcher"),
      "utf8",
    ).then((contents) => contents.includes("BOOTSTRAP_RENTALCTL")),
    true,
  );
});

test("hcloud apply reconciles non-destructive drift in order", async (t) => {
  const setup = await fixture(t, "drift");
  const result = await run([], setup.environment);
  assert.equal(result.status, 0, result.stderr);
  const commands = await readFile(setup.log, "utf8");
  assert.equal(
    commands.match(/rental-host-bootstrap --bundle$/gmu)?.length,
    2,
    "apply must run the transferred helper twice so a self-update takes effect",
  );
  const rule = commands.indexOf("firewall replace-rules");
  const volume = commands.indexOf("volume attach");
  const firewall = commands.indexOf("firewall apply-to-resource");
  const serverProtection = commands.indexOf("server enable-protection");
  const volumeProtection = commands.indexOf("volume enable-protection");
  assert.ok(rule >= 0 && rule < volume);
  assert.ok(volume < firewall && firewall < serverProtection);
  assert.ok(serverProtection < volumeProtection);
  assert.match(
    commands,
    /server enable-protection rental-apartments-production delete rebuild/u,
  );
  assert.match(
    commands,
    /volume enable-protection rental-apartments-production-backups delete/u,
  );
  assert.doesNotMatch(commands, /enable-protection .* --delete/u);
  assert.doesNotMatch(commands, /^hcloud \S+ (delete|rebuild)\b/mu);
});

test("hcloud first-create apply reaches an idempotent second reconciliation", async (t) => {
  const setup = await fixture(t, "create");
  const first = await run([], setup.environment);
  assert.equal(first.status, 0, first.stderr);
  const firstCommands = await readFile(setup.log, "utf8");
  assert.ok(
    firstCommands.indexOf("ssh-key create") <
      firstCommands.indexOf("firewall create"),
  );
  assert.ok(
    firstCommands.indexOf("firewall create") <
      firstCommands.indexOf("volume create"),
  );
  assert.ok(
    firstCommands.indexOf("volume create") <
      firstCommands.indexOf("server create"),
  );
  assert.match(
    firstCommands,
    /ssh .*sudo env RENTAL_BACKUP_DEVICE=\/dev\/disk\/by-id\/scsi-0HC_Volume_3 \/usr\/local\/sbin\/rental-host-bootstrap --bundle/u,
  );
  assert.equal(
    firstCommands.match(/rental-host-bootstrap --bundle$/gmu)?.length,
    2,
  );
  const userData = await readFile(
    path.join(setup.root, "user-data.yaml"),
    "utf8",
  );
  assert.ok(Buffer.byteLength(userData) <= 32_768);
  assert.match(userData, /\/usr\/local\/sbin\/rental-host-bootstrap/u);
  assert.doesNotMatch(userData, /BOOTSTRAP_DEPLOY/u);
  await writeFile(setup.log, "");
  const second = await run([], setup.environment);
  assert.equal(second.status, 0, second.stderr);
  const secondCommands = await readFile(setup.log, "utf8");
  assert.doesNotMatch(
    secondCommands,
    /\b(create|update|attach|replace-rules|apply-to-resource|enable-protection)\b/u,
  );
});

test("hcloud dry-run plans a fresh host without mutation or secret disclosure", async (t) => {
  const setup = await fixture(t, "missing");
  const result = await run(["--dry-run"], setup.environment);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PLAN create server/u);
  const commands = await readFile(setup.log, "utf8");
  assert.doesNotMatch(
    commands,
    /\b(create|update|attach|replace-rules|apply-to-resource|enable-protection)\b/u,
  );
  assert.doesNotMatch(
    `${commands}${result.stdout}${result.stderr}`,
    /never-print-this/u,
  );
});

test("hcloud rejects oversized user data before provider mutation", async (t) => {
  const setup = await fixture(t, "missing");
  await writeFile(
    setup.secret,
    [
      "TELEGRAM_BOT_TOKEN=never-print-this-token",
      "TELEGRAM_OWNER_ID=123",
      "GHCR_IMAGE_REPOSITORY=ghcr.io/example/rental",
      "GHCR_USERNAME=reader",
      `GHCR_READ_TOKEN=${"x".repeat(32_768)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const result = await run([], setup.environment);
  assert.equal(result.status, 65);
  assert.match(result.stderr, /exceeds Hetzner user-data limit/u);
  const commands = await readFile(setup.log, "utf8").catch(() => "");
  assert.doesNotMatch(
    commands,
    /\b(create|update|attach|replace-rules|apply-to-resource|enable-protection)\b/u,
  );
});

test("hcloud reconciliation fails closed on duplicate name-or-label matches", async (t) => {
  const setup = await fixture(t, "duplicate");
  const result = await run(["--check"], setup.environment);
  assert.equal(result.status, 65);
  assert.match(result.stderr, /Refusing ambiguous server reconciliation/u);
  const commands = await readFile(setup.log, "utf8");
  assert.doesNotMatch(commands, /\b(delete|create|update|attach)\b/u);
});

test("cloud-init and host helper retain the production security and receipt contract", async () => {
  const [bootstrapSource, cloudInit, helper, journald] = await Promise.all([
    readFile(path.join(repositoryRoot, "infra/hcloud/bootstrap.sh"), "utf8"),
    readFile(path.join(repositoryRoot, "infra/hcloud/cloud-init.yaml"), "utf8"),
    readFile(
      path.join(repositoryRoot, "infra/hcloud/host-bootstrap.sh"),
      "utf8",
    ),
    readFile(path.join(repositoryRoot, "infra/hcloud/journald.conf"), "utf8"),
  ]);
  assert.match(bootstrapSource, /COPYFILE_DISABLE=1 LC_ALL=C tar --no-xattrs/u);
  assert.match(cloudInit, /ssh_pwauth: false/u);
  assert.match(cloudInit, /disable_root: true/u);
  assert.match(helper, /normalized_mode=\$\{mode#0\}/u);
  assert.match(helper, /remove_appledouble_files/u);
  assert.match(helper, /ops_file_manifest/u);
  assert.match(helper, /sha256sum --zero/u);
  assert.match(helper, /\/etc\/rental-apartments\/env/u);
  assert.match(helper, /chmod 0600/u);
  assert.match(helper, /UUID=\$uuid/u);
  assert.match(helper, /--opt o=bind/u);
  assert.match(helper, /bootstrap-receipt\.json/u);
  assert.match(
    helper,
    /systemctl enable docker\.service rental-apartments\.service/u,
  );
  assert.match(helper, /systemctl is-enabled --quiet/u);
  assert.match(helper, /systemctl is-active --quiet/u);
  assert.match(journald, /Storage=persistent/u);
  assert.match(journald, /MaxRetentionSec=14day/u);
  assert.match(journald, /RateLimitBurst=10000/u);
});
