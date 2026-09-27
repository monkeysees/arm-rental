"""Docker boundary for Node-free acceptance of the packaged Rust application."""

from __future__ import annotations

from contextlib import contextmanager
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import uuid


CONTAINER_UID = 1000
CONTAINER_GID = 1000
DATA_PATH = "/app/.data"
BACKUP_PATH = "/app-backups"
APP_PATH = "/usr/local/bin/rental-app"


def command(
    args: list[str], *, check: bool = True, timeout: int = 60, input_text: str | None = None
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args, input=input_text, capture_output=True, text=True, timeout=timeout, check=False
    )
    if check and result.returncode:
        raise AssertionError(f"Command failed ({result.returncode}): {args!r}\n{result.stderr}\n{result.stdout}")
    return result


class Harness:
    """Run the immutable production image with production filesystem restrictions.

    State mounts are host bind directories so Python's sqlite3 can check durable
    state independently. `host_access` transfers ownership only while the app is
    stopped. GitHub's Linux runner permits passwordless sudo when its UID differs
    from the image's UID 1000.
    """

    def __init__(self, image: str, output: Path):
        self.output = Path(output).resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        # The host runner may have UID 1001; UID 1000 needs traversal to bind
        # mounts below this report directory, but no listing or write access.
        self.output.chmod(0o711)
        inspect = json.loads(command(["docker", "image", "inspect", image]).stdout)[0]
        self.image_id = inspect["Id"]
        self.architecture = inspect["Architecture"]
        config = inspect["Config"]
        assert config["User"] == "1000:1000", "native image must run as UID/GID 1000"
        assert config["Entrypoint"] == [APP_PATH], "unexpected native entrypoint"
        assert config["Labels"]["com.rental-apartments.runtime"] == "rust"
        labels = config["Labels"]
        self.source_revision = labels.get("org.opencontainers.image.revision")
        assert self.source_revision and re.fullmatch(r"[0-9a-f]{40}", self.source_revision), "native image lacks a valid source revision"
        self.source_dirty = labels.get("com.rental-apartments.source.dirty")
        assert self.source_dirty in {"true", "false"}, "native image lacks source dirty identity"
        self.source_input_sha256 = labels.get("com.rental-apartments.source-input.sha256")
        self.cargo_lock_sha256 = labels.get("com.rental-apartments.cargo-lock.sha256")
        assert self.cargo_lock_sha256 and re.fullmatch(r"[0-9a-f]{64}", self.cargo_lock_sha256), "native image lacks Cargo lock identity"
        self._containers: list[str] = []
        self._volumes: list[str] = []
        self.volumes = self._volumes
        extraction = f"rental-native-acceptance-extract-{uuid.uuid4().hex[:12]}"
        command(["docker", "create", "--name", extraction, self.image_id])
        try:
            binary = self.output / "packaged-rental-app"
            command(["docker", "cp", f"{extraction}:{APP_PATH}", str(binary)])
            self.binary_sha256 = sha256(binary.read_bytes()).hexdigest()
            binary.unlink()
        finally:
            command(["docker", "rm", extraction])

    def __enter__(self) -> Harness:
        return self

    def __exit__(self, *_: object) -> None:
        for container in self._containers:
            command(["docker", "rm", "--force", container], check=False)

    def _owner(self, path: Path, uid: int, gid: int) -> None:
        if os.geteuid() == 0:
            command(["chown", "-R", f"{uid}:{gid}", str(path)])
        elif (os.geteuid(), os.getegid()) == (CONTAINER_UID, CONTAINER_GID) == (uid, gid):
            # Only the production UID can skip chown: it owns every file the
            # container creates. A different host UID must reclaim them.
            return
        else:
            command(["sudo", "-n", "chown", "-R", f"{uid}:{gid}", str(path)])

    def new_volume(self) -> str:
        path = self.output / "volumes" / f"state-{len(self._volumes) + 1}"
        path.mkdir(parents=True, mode=0o700, exist_ok=False)
        self._volumes.append(str(path))
        self._owner(path, CONTAINER_UID, CONTAINER_GID)
        return str(path)

    @contextmanager
    def host_access(self, volume: str):
        path = Path(volume).resolve()
        assert str(path) in self._volumes, "unknown synthetic volume"
        self._owner(path, os.geteuid(), os.getegid())
        try:
            yield path
        finally:
            self._owner(path, CONTAINER_UID, CONTAINER_GID)

    def _mounts(self, data_volume: str, backup_volume: str | None) -> list[str]:
        assert data_volume in self._volumes, "unknown synthetic data volume"
        mounts = ["--mount", f"type=bind,src={data_volume},dst={DATA_PATH}"]
        if backup_volume is not None:
            assert backup_volume in self._volumes, "unknown synthetic backup volume"
            mounts += ["--mount", f"type=bind,src={backup_volume},dst={BACKUP_PATH}"]
        return mounts

    def _runtime_args(
        self,
        *,
        data_volume: str,
        backup_volume: str | None,
        env: dict[str, str] | None,
        network: str,
    ) -> list[str]:
        assert network in {"none", "host"}
        variables = {
            "NODE_ENV": "test",
            "TELEGRAM_BOT_TOKEN": "123:synthetic-native-acceptance",
            "TELEGRAM_OWNER_ID": "123",
            "DATA_DIRECTORY": DATA_PATH,
            "CURL_IMPERSONATE_PATH": "/usr/local/bin/curl-impersonate",
            "SQLITE_TMPDIR": "/sqlite-tmp",
            **({"BACKUP_DIRECTORY": BACKUP_PATH} if backup_volume else {}),
            **(env or {}),
        }
        result = [
            "--network", network,
            "--read-only",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--user", "1000:1000",
            "--tmpfs", "/tmp:mode=1777,nosuid,nodev,noexec",
            "--tmpfs", "/sqlite-tmp:mode=0700,uid=1000,gid=1000,nosuid,nodev,noexec",
            *self._mounts(data_volume, backup_volume),
        ]
        for key, value in variables.items():
            assert "\x00" not in key + value
            result += ["--env", f"{key}={value}"]
        return result

    def run_app(
        self,
        args: list[str],
        *,
        data_volume: str,
        backup_volume: str | None = None,
        env: dict[str, str] | None = None,
        network: str = "none",
        check: bool = True,
        timeout: int = 60,
        input_text: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        return command(
            ["docker", "run", "--rm", *(["--interactive"] if input_text is not None else []), *self._runtime_args(data_volume=data_volume, backup_volume=backup_volume, env=env, network=network), self.image_id, *args],
            check=check,
            timeout=timeout,
            input_text=input_text,
        )

    def start_app(
        self,
        args: list[str],
        *,
        data_volume: str,
        backup_volume: str | None = None,
        env: dict[str, str] | None = None,
        network: str = "host",
        name: str | None = None,
    ) -> str:
        name = name or f"rental-native-acceptance-{uuid.uuid4().hex[:12]}"
        result = command(
            ["docker", "run", "--detach", "--name", name, *self._runtime_args(data_volume=data_volume, backup_volume=backup_volume, env=env, network=network), self.image_id, *args]
        )
        container = result.stdout.strip()
        self._containers.append(container)
        return container

    def stop_app(self, container_id: str, timeout: int = 15) -> subprocess.CompletedProcess[str]:
        return command(["docker", "stop", "--time", str(timeout), container_id], check=False, timeout=timeout + 15)

    def logs(self, container_id: str) -> str:
        return command(["docker", "logs", container_id], check=False).stdout

    def inspect(self, container_id: str) -> dict:
        return json.loads(command(["docker", "inspect", container_id]).stdout)[0]

    def exec_app(self, container_id: str, args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
        return command(["docker", "exec", container_id, APP_PATH, *args], check=check)

    def _volume_file(self, volume: str, container_path: str) -> Path:
        for prefix in (DATA_PATH, BACKUP_PATH):
            if container_path.startswith(prefix + "/"):
                relative = Path(container_path[len(prefix) + 1 :])
                assert ".." not in relative.parts
                return Path(volume) / relative
        raise AssertionError("file must be under a synthetic state or backup mount")

    def import_file(self, volume: str, source: Path, container_path: str) -> None:
        with self.host_access(volume):
            destination = self._volume_file(volume, container_path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            destination.chmod(0o600)

    def extract_file(self, volume: str, container_path: str, dest: Path) -> None:
        with self.host_access(volume):
            shutil.copyfile(self._volume_file(volume, container_path), dest)
