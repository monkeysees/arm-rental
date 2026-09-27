#!/usr/bin/env python3
"""Validated manual Rust deployment and snapshot-backed recovery operations."""
from __future__ import annotations

import contextlib
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
DIGEST = re.compile(r"(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64})\Z")
SNAPSHOT = re.compile(r"/app-backups/(?:daily|weekly)/[a-zA-Z0-9][a-zA-Z0-9._:-]*\Z")
TRUST = {"root": "/var/lib/rental-apartments/releases", "ancestors": ["/", "/var", "/var/lib", "/var/lib/rental-apartments"],
         "rootOwnerAccount": "rental-deploy", "releaseOwnerUid": 0}
LOCK = Path("/var/lib/rental-apartments-ops/operations.lock")
OPTIONS = {"environment", "actor", "image", "previous-image", "snapshot", "poll-interval-ms", "observation-minutes",
           "delivery", "state-strategy", "evidence-file", "compose-file", "target-release"}
USAGE = """Usage: python3 scripts/release-operations.py validate|deploy|rollback
  --environment production --actor IDENTITY
  --image IMMUTABLE_REF --previous-image IMMUTABLE_REF
  --snapshot /app-backups/daily/ID --poll-interval-ms MS
  --observation-minutes MINUTES --delivery private|channel|both
  [--state-strategy compatible|restore] [--target-release ABSOLUTE_DIR]
  [--compose-file PATH] [--evidence-file PATH] [--dry-run]

validate and --dry-run never invoke Docker. Execution acquires the shared
operations lock and requires published, verified Rust artifacts. Compatible
recovery preserves live SQLite; restore explicitly opts into snapshot replay.
"""


def require(condition, message):
    if not condition:
        raise ValueError(message)


def parse_arguments(args):
    require(args and args[0] in ("validate", "deploy", "rollback"), USAGE)
    raw = {"operation": args[0], "dryRun": False}
    index = 1
    while index < len(args):
        name = args[index]
        if name == "--dry-run":
            require(not raw["dryRun"], "Duplicate --dry-run argument")
            raw["dryRun"] = True
            index += 1
            continue
        require(name.startswith("--") and index + 1 < len(args), USAGE)
        key = name[2:]
        require(key in OPTIONS, f"Unknown --{key} argument")
        require(key not in raw, f"Duplicate --{key} argument")
        raw[key] = args[index + 1]
        index += 2
    return raw


def create_release_contract(raw, trust=None):
    trust = dict(TRUST if trust is None else trust)
    def string(name):
        value = raw.get(name)
        require(isinstance(value, str) and value.strip(), f"--{name} is required")
        return value.strip()
    def positive(name):
        value = string(name)
        require(re.fullmatch(r"[1-9][0-9]*", value) and int(value) <= 2**53 - 1,
                f"--{name} must be a positive safe integer")
        return int(value)
    operation = raw.get("operation")
    require(operation in ("validate", "deploy", "rollback"), "operation must be validate, deploy, or rollback")
    environment, actor = string("environment"), string("actor")
    require(environment == "production", "--environment must be production")
    require(len(actor) >= 3 and actor.lower() not in {"unknown", "n/a", "none", "operator", "actor", "automation", "systemd", "github-actions"},
            "--actor must identify the accountable human or automation execution")
    image, previous = string("image"), string("previous-image")
    require(DIGEST.fullmatch(image) and DIGEST.fullmatch(previous), "images must be immutable image IDs or registry digest references")
    require(image != previous, "--image and --previous-image must identify different artifacts")
    snapshot = string("snapshot")
    require(SNAPSHOT.fullmatch(snapshot) and ".snapshot-" not in snapshot,
            "--snapshot must be a published /app-backups/daily|weekly recovery point")
    interval, minutes = positive("poll-interval-ms"), positive("observation-minutes")
    require(minutes * 60000 <= 2**53 - 1 and minutes * 60000 >= interval + 300000,
            "--observation-minutes must cover one full crawl interval plus five minutes")
    delivery = string("delivery")
    require(delivery in ("private", "channel", "both"), "--delivery must be private, channel, or both")
    strategy = raw.get("state-strategy", "compatible")
    require(strategy in ("compatible", "restore"), "--state-strategy must be compatible or restore")
    target = raw.get("target-release")
    if target:
        require(Path(target).is_absolute(), "--target-release must be absolute")
        target = os.path.abspath(target)
        require(str(Path(target).parent) == trust["root"], "--target-release must be a direct child of the trusted releases root")
    return {"schemaVersion": 1, "operation": operation, "environment": environment, "actor": actor,
            "image": image, "previousImage": previous, "snapshot": snapshot, "pollIntervalMs": interval,
            "observationMinutes": minutes, "observationMs": minutes * 60000, "delivery": delivery,
            "stateStrategy": strategy, "composeFile": os.path.abspath(raw.get("compose-file", "compose.production.yaml")),
            "composeFileExplicit": "compose-file" in raw,
            "projectName": "rental-apartments", "targetRelease": target, "releasesRoot": trust["root"],
            "releaseTrust": trust, "evidenceFile": os.path.abspath(raw.get("evidence-file", f".release-evidence/{environment}-{operation}.json")),
            "dryRun": bool(raw.get("dryRun") or operation == "validate")}


def find_release_evidence(log_text, delivery):
    records = []
    for line in log_text.splitlines():
        try:
            value = json.loads(line[line.index("{"):])
            if isinstance(value, dict):
                records.append(value)
        except (ValueError, TypeError):
            pass
    preflight = next((record for record in records if record.get("event") == "startup.preflight.completed"
                      and isinstance(record.get("preflight"), dict)
                      and record["preflight"].get("status") == "ready"
                      and isinstance(record["preflight"].get("checks"), dict)
                      and record["preflight"]["checks"].get("telegram") == "passed"), None)
    crawl = next((record for record in records if record.get("event") == "crawl.succeeded"), None)
    checks = (preflight or {}).get("preflight", {}).get("checks", {})
    return {"ready": bool(preflight and crawl), "preflight": preflight, "crawl": crawl,
            "telegramVerified": checks.get("telegram") == "passed",
            "channelVerified": checks.get("channel") == ("passed" if delivery in ("channel", "both") else "skipped")}


def compatible(metadata, state):
    value = state.get("stateSchema")
    return (state.get("stateBackend") == "sqlite" and type(value) is int
            and metadata["minimumStateSchema"] <= value <= metadata["maximumStateSchema"])


def run(command, env=None):
    result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=300)
    require(result.returncode == 0, f"{command[0]} operation failed with exit status {result.returncode}")
    return result


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ReleaseInterrupted(ValueError):
    pass


@contextlib.contextmanager
def cancellation():
    interrupted = False
    def interrupt(number, _frame):
        nonlocal interrupted
        if not interrupted:
            interrupted = True
            raise ReleaseInterrupted(f"release interrupted by signal {number}")
    previous = {number: signal.signal(number, interrupt) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        yield
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


@contextlib.contextmanager
def operations_lock(path=LOCK):
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        require(stat.S_ISREG(os.fstat(descriptor).st_mode), "operations lock is not a regular file")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("another operation holds the shared operations lock") from error
        yield
    finally:
        os.close(descriptor)


def verify_trusted_target(contract, metadata, reference):
    target = Path(contract["targetRelease"])
    trust = contract["releaseTrust"]
    digest = reference.rsplit("@sha256:", 1)[1]
    require(target.name == f'{metadata["sourceRevision"]}-{digest[:16]}', "target release identity mismatch")
    deploy_uid = pwd.getpwnam(trust["rootOwnerAccount"]).pw_uid
    for path, owner in ([(Path(p), 0) for p in trust["ancestors"]]
                        + [(Path(trust["root"]), deploy_uid), (target, trust["releaseOwnerUid"])]):
        details = path.lstat()
        require(stat.S_ISDIR(details.st_mode) and path.resolve(strict=True) == path
                and details.st_uid == owner and details.st_mode & 0o022 == 0,
                "target release is outside the trusted ownership boundary")


VERIFY_BUNDLE = r'''
set -Eeuo pipefail
image=$1 revision=$2 bundle=$3 library=$4 installed=$5
RENTAL_OPS_STATE_DIR=/var/lib/rental-apartments-ops
source "$library"
DEPLOYMENT_SOURCE_REVISION=$revision
repository=${image%@sha256:*}
deployment_extract_release_bundle "$repository" "$revision" "$bundle"
metadata="$bundle/release-metadata.json"
jq -e '.runtime == "rust" and (.schemaVersion == 2 or .schemaVersion == 3)' "$metadata" >/dev/null
deployment_verify_release "$bundle" "$image" "$metadata"
if [[ -n "$installed" ]]; then
  deployment_verify_existing_release_contents "$installed" "$bundle" "$(jq -r .schemaVersion "$metadata")"
fi
'''


class Release:
    def __init__(self, contract, runner=run, sleep=time.sleep, clock=time.monotonic):
        self.contract, self.runner, self.sleep, self.clock = contract, runner, sleep, clock
        self.bundles = {}
        self.volume = None

    def docker(self, *args, image=None):
        env = dict(os.environ)
        if image is not None:
            env["RENTAL_APARTMENTS_IMAGE"] = image
        return self.runner(["docker", *args], env=env)

    def compose(self, image, *args):
        c = self.contract
        compose = self.bundles[image] / "compose.production.yaml"
        override = compose.parent / "ops/compose.native.yaml"
        require(compose.is_file() and override.is_file(), "verified Rust Compose files are required")
        return self.docker("compose", "--project-name", c["projectName"], "--file", str(compose),
                           "--file", str(override), *args, image=image)

    def image_metadata(self, image):
        labels = json.loads(self.docker("image", "inspect", "--format", "{{json .Config.Labels}}", image).stdout)
        require(labels.get("com.rental-apartments.runtime") == "rust", "only explicitly labeled Rust images are supported")
        source = labels.get("org.opencontainers.image.revision", "")
        require(re.fullmatch("[a-f0-9]{40}", source), "image source revision is invalid")
        values = [labels.get("com.rental-apartments.state.schema." + key, "") for key in ("minimum", "maximum")]
        require(all(isinstance(value, str) and re.fullmatch("[1-9][0-9]*", value) for value in values), "image schema range is invalid")
        low, high = map(int, values)
        require(labels.get("com.rental-apartments.state.backend") == "sqlite" and low <= high <= 2**53 - 1,
                "image must declare a valid SQLite schema range")
        return {"runtime": "rust", "sourceRevision": source, "stateBackend": "sqlite",
                "minimumStateSchema": low, "maximumStateSchema": high}

    def verify_image(self, image, metadata, temporary, target=False):
        reference = image
        if image.startswith("sha256:"):
            digests = json.loads(self.docker("image", "inspect", "--format", "{{json .RepoDigests}}", image).stdout)
            require(isinstance(digests, list) and len(digests) == 1 and DIGEST.fullmatch(digests[0]),
                    "image ID requires one unambiguous published registry digest")
            reference = digests[0]
        installed = self.contract["targetRelease"] if target else None
        if installed:
            verify_trusted_target(self.contract, metadata, reference)
        bundle = Path(temporary) / ("target" if target else "previous")
        bundle.mkdir(mode=0o700)
        self.runner(["bash", "-c", VERIFY_BUNDLE, "verify-rust-release", reference, metadata["sourceRevision"],
                     str(bundle), str(ROOT / "ops/lib/deployment.sh"), installed or ""], env=dict(os.environ))
        with tarfile.open(bundle / "operations.tar", "r:") as archive:
            matches = [member for member in archive.getmembers() if member.name == "ops/compose.native.yaml"]
            require(len(matches) == 1 and matches[0].isfile(), "verified archive lacks a regular Rust Compose override")
            (bundle / "ops").mkdir(mode=0o700)
            with archive.extractfile(matches[0]) as source:
                (bundle / "ops/compose.native.yaml").write_bytes(source.read())
        if target and self.contract["composeFileExplicit"]:
            require(Path(self.contract["composeFile"]).read_bytes() == (bundle / "compose.production.yaml").read_bytes(),
                    "--compose-file differs from the verified target release")
        self.bundles[image] = bundle

    def inspect_compose(self, image):
        configuration = json.loads(self.compose(image, "config", "--format", "json").stdout)
        bot = configuration.get("services", {}).get("bot", {})
        mounts = [m for m in bot.get("volumes", []) if m.get("target") == "/app/.data"]
        require(bot.get("image") == image and bot.get("container_name") == "rental-apartments-bot"
                and bot.get("labels", {}).get("com.rental-apartments.environment") == "production"
                and bot.get("environment", {}).get("NODE_ENV") == "production" and bot.get("read_only") is True
                and bot.get("deploy", {}).get("replicas") == 1
                and bot.get("deploy", {}).get("update_config", {}).get("order") == "stop-first"
                and not bot.get("ports") and not bot.get("cap_add") and "ALL" in bot.get("cap_drop", [])
                and any(value in ("no-new-privileges", "no-new-privileges:true") for value in bot.get("security_opt", []))
                and len(mounts) == 1 and mounts[0].get("type") == "volume",
                "Compose must enforce a read-only singleton, stop-first updates, and one persistent named volume")
        source = mounts[0].get("source")
        volume = configuration.get("volumes", {}).get(source, {}).get("name")
        require(isinstance(volume, str) and volume, "Compose must resolve the persistent volume name")
        backups = [m for m in bot.get("volumes", []) if m.get("target") == "/app-backups"]
        require(len(backups) == 1 and backups[0].get("type") == "volume" and backups[0].get("read_only") is True
                and backups[0].get("source") != source, "independent backup volume must remain read-only")
        return volume

    def inspect_runtime(self, expected=None):
        container = json.loads(self.docker("inspect", "--format", "{{json .}}", "rental-apartments-bot").stdout)
        mounts = [m for m in container.get("Mounts", []) if m.get("Destination") == "/app/.data" and m.get("Type") == "volume"]
        require(container.get("Config", {}).get("Image") == (expected or self.contract["previousImage"])
                and container.get("Config", {}).get("Labels", {}).get("com.rental-apartments.environment") == "production"
                and container.get("State", {}).get("Running") is True and len(mounts) == 1 and mounts[0].get("Name"),
                "running singleton does not match the previous image or persistent data volume")
        return mounts[0]["Name"]

    def inspect_state(self, image=None):
        result = (self.compose(image, "run", "--rm", "--no-deps", "bot", "state:inspect") if image else
                  self.docker("exec", "rental-apartments-bot", "/usr/local/bin/rental-app", "state:inspect"))
        return json.loads(result.stdout)

    def snapshot(self, action, image):
        self.compose(image, "run", "--rm", "--no-deps", "bot", "backup:" + action, "--snapshot", self.contract["snapshot"])

    def stopped(self):
        try:
            value = self.docker("inspect", "--format", "{{.State.Running}}", "rental-apartments-bot").stdout.strip()
        except ReleaseInterrupted:
            raise
        except (ValueError, subprocess.SubprocessError):
            value = self.docker("ps", "--all", "--format", "{{.Names}}", "--filter", "name=^/rental-apartments-bot$").stdout.strip()
            require(value == "", "singleton is still present; refusing recovery overlap")
        else:
            require(value == "false", "singleton is still running; refusing overlap")

    def stop(self, image):
        self.compose(image, "stop", "bot")
        self.stopped()

    def start(self, image):
        self.compose(image, "up", "--detach", "--force-recreate", "bot")
        require(self.inspect_runtime(expected=image) == self.volume,
                "started singleton does not match the verified image and persistent volume")

    def readiness(self):
        result = self.docker("exec", "rental-apartments-bot", "/usr/local/bin/rental-app", "health-check", "--ready", "--json")
        require(json.loads(result.stdout).get("status") == "ready", "service readiness failed")

    def wait_ready(self):
        deadline = self.clock() + 300
        while self.clock() < deadline:
            try:
                self.readiness()
                return
            except ReleaseInterrupted:
                raise
            except (ValueError, subprocess.SubprocessError):
                self.sleep(5)
        raise ValueError("service did not become ready after recovery")

    def observe(self, started):
        deadline = self.clock() + self.contract["observationMs"] / 1000
        evidence = None
        while self.clock() < deadline:
            self.sleep(min(10, max(0, deadline - self.clock())))
            try:
                self.readiness()
                logs = self.docker("logs", "--since", started, "rental-apartments-bot")
                found = find_release_evidence(logs.stdout + "\n" + logs.stderr, self.contract["delivery"])
                if found["ready"] and found["channelVerified"]:
                    evidence = found
            except ReleaseInterrupted:
                raise
            except (ValueError, subprocess.SubprocessError):
                if evidence:
                    raise ValueError("candidate lost readiness during observation")
        require(evidence, "candidate lacks ready preflight, successful crawl, or expected Telegram/channel evidence")
        self.readiness()
        return evidence

    def recover(self, previous_metadata):
        c = self.contract
        self.stop(c["image"])
        preserve = c["stateStrategy"] == "compatible"
        if preserve:
            require(compatible(previous_metadata, self.inspect_state(c["previousImage"])),
                    "previous image cannot serve current SQLite; snapshot restore requires explicit selection")
        else:
            self.snapshot("restore", c["previousImage"])
        try:
            self.start(c["previousImage"])
            self.wait_ready()
        except Exception:
            self.stop(c["previousImage"])
            raise ValueError("previous image recovery failed; its container was stopped")
        return preserve

    def execute(self):
        c = self.contract
        require(not os.path.lexists(c["evidenceFile"]), "evidence file already exists; choose a new path")
        target, previous = self.image_metadata(c["image"]), self.image_metadata(c["previousImage"])
        with tempfile.TemporaryDirectory(prefix="rental-release-") as temporary:
            self.verify_image(c["image"], target, temporary, target=True)
            self.verify_image(c["previousImage"], previous, temporary)
            previous_volume = self.inspect_compose(c["previousImage"])
            target_volume = self.inspect_compose(c["image"])
            self.snapshot("validate", c["image"] if c["operation"] == "rollback" and c["stateStrategy"] == "restore" else c["previousImage"])
            volume = self.inspect_runtime()
            require(volume == previous_volume == target_volume, "candidate would replace the persistent data volume")
            self.volume = volume
            if c["stateStrategy"] == "compatible":
                require(compatible(target, self.inspect_state()), "target does not support live SQLite schema")
            previous_stopped = False
            try:
                self.stop(c["previousImage"])
                previous_stopped = True
                started = utc_now()
                if c["operation"] == "rollback" and c["stateStrategy"] == "restore":
                    self.snapshot("restore", c["image"])
                self.start(c["image"])
                evidence = self.observe(started)
                receipt = {key: c[key] for key in ("schemaVersion", "operation", "environment", "actor", "image", "previousImage",
                           "snapshot", "pollIntervalMs", "observationMinutes", "delivery", "stateStrategy")}
                receipt.update({"retainedPreviousArtifact": True, "dataVolume": volume, "startedAt": started, "completedAt": utc_now(),
                                "preflightStatus": "ready", "telegramVerified": evidence["telegramVerified"],
                                "channelVerified": evidence["channelVerified"], "crawl": {
                                    key: evidence["crawl"][key] for key in ("crawlId", "durationMs", "notified", "channelSent", "channelEdited")
                                    if key in evidence["crawl"]}})
                path = Path(c["evidenceFile"])
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(descriptor, "w") as stream:
                    json.dump(receipt, stream, indent=2)
                    stream.write("\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                return receipt
            except Exception as error:
                if not previous_stopped:
                    # A stop can fail after stopping the service. Recover only
                    # after proving it stopped; never create a second writer.
                    self.stopped()
                    try:
                        self.start(c["previousImage"])
                        self.wait_ready()
                    except Exception:
                        self.stop(c["previousImage"])
                        raise ValueError("stop failed and previous image recovery failed") from error
                    raise ValueError("stop failed; the verified previous image was restarted") from error
                try:
                    preserved = self.recover(previous)
                except Exception as recovery_error:
                    raise ValueError(f"release failed; recovery failed: {recovery_error}. Stop and review the live volume") from error
                action = "compatible live SQLite without snapshot restore" if preserved else "the verified snapshot"
                raise ValueError(f"release failed; previous image restarted using {action}") from error


def main(args=None):
    args = sys.argv[1:] if args is None else args
    if args == ["--help"]:
        print(USAGE)
        return
    contract = create_release_contract(parse_arguments(args))
    if contract["dryRun"]:
        print(json.dumps({"status": "validated", "mutation": "none", "contract": contract,
                          "plan": ["verify both immutable Rust artifacts and release bundles", "validate singleton Compose and snapshot",
                                   "acquire operations lock and confirm persistent volume", "stop and confirm old singleton",
                                   "start target and observe readiness, crawl, and Telegram evidence", "retain predecessor and write sanitized receipt"]}, indent=2))
        return
    with operations_lock(), cancellation():
        receipt = Release(contract).execute()
    print(json.dumps({"status": "completed", "receipt": receipt}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"release operation failed: {error}", file=sys.stderr)
        sys.exit(1)
