#!/usr/bin/env python3
"""Build and verify the Cargo/source-input production release contract."""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import tomllib


SOURCE_ROOT = Path.cwd()
TOOL_ROOT = Path(__file__).resolve().parent.parent
FIXED_INPUTS = (
    "Dockerfile.native",
    "compose.production.yaml",
    "experiments/production-image/assemble",
    "experiments/production-image/licenses",
    "experiments/rust-replay/Cargo.lock",
    "experiments/rust-replay/Cargo.toml",
    "ops/compose.native.yaml",
    "scripts/curl-impersonate-version",
    "scripts/install-curl-impersonate",
)
SOURCE_PREFIX = "experiments/rust-replay/src/"
SOURCE_LIMIT = 8 * 1024 * 1024
REVISION = re.compile(r"[0-9a-f]{40}\Z")
DIGEST_REFERENCE = re.compile(r"[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}\Z")
SNAPSHOT_NAME = re.compile(r"daily/[A-Za-z0-9][A-Za-z0-9._:-]*\Z")
SAFE_PATH = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./-]*\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")


class ReleaseError(Exception):
    pass


def call(*args: str, cwd: Path | None = None) -> bytes:
    result = subprocess.run(args, cwd=cwd, capture_output=True, check=False)
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise ReleaseError(f"{args[0]} failed ({result.returncode}): {detail}")
    return result.stdout


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReleaseError(message)


def source_revision(revision: str) -> str:
    require(bool(REVISION.fullmatch(revision)), "source revision must be a full Git SHA")
    call("git", "cat-file", "-e", f"{revision}^{{commit}}", cwd=SOURCE_ROOT)
    actual_head = call("git", "rev-parse", "HEAD", cwd=SOURCE_ROOT).decode().strip()
    require(actual_head == revision, "source revision must match checked-out HEAD")
    return revision


def input_files(revision: str) -> dict[str, tuple[bytes, int]]:
    unsupported = call("git", "ls-tree", "-r", "--name-only", revision, "--",
                       ".cargo", "experiments/rust-replay/.cargo",
                       "experiments/rust-replay/build.rs", cwd=SOURCE_ROOT).decode().strip()
    require(not unsupported, f"unsupported Cargo source outside manifest: {unsupported}")
    listing = call("git", "ls-tree", "-r", "-z", revision, "--", SOURCE_PREFIX, *FIXED_INPUTS, cwd=SOURCE_ROOT)
    entries: dict[str, tuple[bytes, int]] = {}
    for line in listing.split(b"\0"):
        if not line:
            continue
        header, raw_path = line.split(b"\t", 1)
        mode, kind, _object = header.decode("ascii").split()
        path = raw_path.decode("utf-8")
        require(kind == "blob" and mode in ("100644", "100755"), f"nonregular source input: {path}")
        require(bool(SAFE_PATH.fullmatch(path)) and ".." not in path, f"unsafe source path: {path}")
        require(path in FIXED_INPUTS or path.startswith(SOURCE_PREFIX), f"unexpected source input: {path}")
        entries[path] = (call("git", "show", f"{revision}:{path}", cwd=SOURCE_ROOT), int(mode[-3:], 8))
    require(set(FIXED_INPUTS) <= set(entries), "required native source input is missing")
    require(any(path.startswith(SOURCE_PREFIX) and path.endswith(".rs") for path in entries), "Rust source is missing")
    require(set(entries) == set(FIXED_INPUTS) | {p for p in entries if p.startswith(SOURCE_PREFIX)}, "native source input set is incomplete")
    cargo_manifest = tomllib.loads(entries["experiments/rust-replay/Cargo.toml"][0].decode())
    require(cargo_manifest.get("package", {}).get("build") in (None, False),
            "custom Cargo build script is outside the source contract")

    def check_paths(value: object) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key == "path":
                    require(isinstance(child, str) and child.startswith("src/")
                            and ".." not in child and f"experiments/rust-replay/{child}" in entries,
                            "Cargo manifest names a path outside the source contract")
                else:
                    check_paths(child)
        elif isinstance(value, list):
            for child in value:
                check_paths(child)

    check_paths(cargo_manifest)
    return dict(sorted(entries.items()))


def write_source_context(revision: str, work_dir: Path) -> dict[str, tuple[bytes, int]]:
    require(not work_dir.exists() or not any(work_dir.iterdir()), "work directory must be empty")
    work_dir.mkdir(parents=True, exist_ok=True)
    files = input_files(revision)
    context = work_dir / "context"
    for name, (content, mode) in files.items():
        destination = context / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        destination.chmod(mode)
    manifest = {
        "schemaVersion": 1,
        "kind": "source-inputs",
        "files": [{"path": name, "sha256": digest(content)} for name, (content, _) in files.items()],
    }
    manifest_bytes = canonical(manifest)
    (work_dir / "source-inputs.json").write_bytes(manifest_bytes)
    source_tar = io.BytesIO()
    with tarfile.open(fileobj=source_tar, mode="w", format=tarfile.GNU_FORMAT) as archive:
        for name, (content, mode) in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mode = mode
            info.mtime = 0
            info.uid = info.gid = 0
            archive.addfile(info, io.BytesIO(content))
    tar_bytes = source_tar.getvalue()
    require(len(tar_bytes) <= SOURCE_LIMIT, "source archive exceeds host verifier bound")
    (work_dir / "source-inputs.tar").write_bytes(tar_bytes)
    generated = context / ".native-release"
    generated.mkdir()
    (generated / "source-inputs.tar").write_bytes(tar_bytes)
    return files


def version_from_inputs(files: dict[str, tuple[bytes, int]]) -> tuple[str, str, int]:
    dockerfile = files["Dockerfile.native"][0].decode()
    copy_lines = [line.strip() for line in dockerfile.splitlines()
                  if re.match(r"\s*(?:COPY|ADD)\s", line, re.I)]
    require(copy_lines == [
        "COPY experiments/rust-replay/Cargo.toml experiments/rust-replay/Cargo.lock ./",
        "COPY experiments/rust-replay/src/ ./src/",
        "COPY scripts/install-curl-impersonate scripts/curl-impersonate-version /curl-install/",
        "COPY experiments/production-image/assemble experiments/production-image/licenses /image/",
        "COPY .native-release/source-inputs.tar /source-inputs.tar",
        "COPY --from=build /runtime/ /",
        "COPY .native-release/components.json /usr/local/share/native-image/components.json",
    ], "native Docker COPY inputs differ from the source manifest contract")
    curl_text = files["scripts/curl-impersonate-version"][0].decode()
    storage = files[f"{SOURCE_PREFIX}production/storage.rs"][0].decode()
    rust = re.findall(r"^FROM rust:([0-9]+\.[0-9]+\.[0-9]+)-bookworm@sha256:[0-9a-f]{64} AS build$", dockerfile, re.M)
    curl = re.findall(r"^CURL_IMPERSONATE_VERSION=([0-9]+\.[0-9]+\.[0-9]+)$", curl_text, re.M)
    schema = re.findall(r"for v in version\+1\.\.=(\d+)", storage)
    require(len(rust) == len(curl) == len(schema) == 1, "native versions or schema cannot be derived uniquely")
    require(f"if version == {schema[0]}" in storage, "Rust schema maximum is inconsistent")
    require(f'com.rental-apartments.state.schema.maximum="{schema[0]}"' in dockerfile, "image schema label is inconsistent")
    return rust[0], curl[0], int(schema[0])


def image_inspect(image: str) -> dict:
    result = json.loads(call("docker", "image", "inspect", "--format", "{{json .}}", image))
    require(isinstance(result, dict) and HASH.fullmatch(result.get("Id", "").removeprefix("sha256:")), "invalid Docker image identity")
    return result


def image_files(image: str, paths: list[str]) -> dict[str, bytes]:
    container = call("docker", "create", image, "/usr/local/bin/rental-app").decode().strip()
    require(bool(container), "Docker did not create an inspection container")
    try:
        with tempfile.TemporaryDirectory(prefix="native-release-cp-") as temporary:
            result = {}
            for index, name in enumerate(paths):
                require(name.startswith("/") and ".." not in name, "unsafe image path")
                destination = Path(temporary) / str(index)
                call("docker", "cp", f"{container}:{name}", str(destination))
                require(destination.is_file() and not destination.is_symlink(), f"image path is not regular: {name}")
                result[name] = destination.read_bytes()
            return result
    finally:
        call("docker", "rm", container)


def closure_paths(image: str, libraries: bytes) -> list[str]:
    paths = libraries.decode("utf-8").splitlines()
    require(bool(paths) and paths == sorted(set(paths)), "image libraries.txt is not canonical")
    require(all(path.startswith("/") and ".." not in path for path in paths), "unsafe library path")
    require(all(path.startswith(("/lib/", "/usr/lib/")) or
                re.fullmatch(r"/lib64/ld-linux-[A-Za-z0-9_-]+\.so\.[0-9]+", path)
                for path in paths), "library path is outside the host transport contract")
    loaders = [path for path in paths if re.fullmatch(r"/lib64/ld-linux-[A-Za-z0-9_-]+\.so\.[0-9]+", path)]
    require(len(loaders) == 1, "native image must declare exactly one loader")
    observed = {loaders[0]}
    for binary in ("/usr/local/bin/rental-app", "/usr/local/bin/curl-impersonate"):
        output = call("docker", "run", "--rm", "--network", "none", "--read-only",
                      "--entrypoint", loaders[0], image, "--list", binary).decode()
        require("not found" not in output, f"missing ELF dependency for {binary}")
        observed.update(re.findall(r"(?:=>\s+|^\s*)(/[A-Za-z0-9_./+\-]+)\s+\(0x[0-9a-f]+\)", output, re.M))
    require(observed == set(paths), "declared libraries differ from independent ELF closure")
    return paths


def payload_data(image: str, source_tar: bytes, cargo_lock: bytes) -> tuple[dict[str, bytes], dict[str, str]]:
    first = image_files(image, [
        "/usr/local/share/native-image/libraries.txt",
        "/usr/local/share/native-image/source-inputs.tar",
        "/usr/local/share/licenses/rental-app/Cargo.lock",
        "/usr/local/bin/rental-app",
    ])
    require(first["/usr/local/share/native-image/source-inputs.tar"] == source_tar, "image source archive differs from Git source")
    require(first["/usr/local/share/licenses/rental-app/Cargo.lock"] == cargo_lock, "image Cargo.lock differs from Git source")
    library_paths = closure_paths(image, first["/usr/local/share/native-image/libraries.txt"])
    transport_paths = [
        "/usr/local/bin/curl-impersonate",
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/nsswitch.conf",
        *library_paths,
    ]
    transport = image_files(image, sorted(set(transport_paths)))
    require(len(transport) == len(set(transport_paths)), "duplicate transport file")
    hashes = {
        "cargoLockSha256": digest(cargo_lock),
        "binarySha256": digest(first["/usr/local/bin/rental-app"]),
        "curlSha256": digest(transport["/usr/local/bin/curl-impersonate"]),
    }
    return transport, hashes


def transport_manifest(transport: dict[str, bytes]) -> bytes:
    return canonical({
        "schemaVersion": 1,
        "kind": "transport-files",
        "files": [{"path": path.removeprefix("/"), "sha256": digest(content)} for path, content in sorted(transport.items())],
    })


def components(revision: str, rust_version: str, curl_version: str, hashes: dict[str, str]) -> bytes:
    return canonical({
        "runtime": "rust",
        "sourceDirty": False,
        "sourceRevision": revision,
        "toolchain": rust_version,
        "curlImpersonateVersion": curl_version,
        **hashes,
    })


def require_final_image(image: str, summary: dict, work_dir: Path) -> None:
    inspected = image_inspect(image)
    require(inspected["Id"] == summary["imageId"], "final image ID changed")
    labels = inspected.get("Config", {}).get("Labels") or {}
    expected = {
        "org.opencontainers.image.revision": summary["sourceRevision"],
        "com.rental-apartments.runtime": "rust",
        "com.rental-apartments.source.dirty": "false",
        "com.rental-apartments.state.backend": "sqlite",
        "com.rental-apartments.state.schema.minimum": "1",
        "com.rental-apartments.state.schema.maximum": str(summary["maximumStateSchema"]),
        "com.rental-apartments.cargo-lock.sha256": summary["cargoLockSha256"],
        "com.rental-apartments.source-inputs.sha256": summary["sourceInputsSha256"],
        "com.rental-apartments.binary.sha256": summary["binarySha256"],
        "com.rental-apartments.curl.sha256": summary["curlSha256"],
        "com.rental-apartments.transport-closure.sha256": summary["transportClosureSha256"],
        "com.rental-apartments.rust-version": summary["rustVersion"],
        "com.rental-apartments.curl-version": summary["curlImpersonateVersion"],
    }
    require(all(labels.get(key) == value for key, value in expected.items()), "final image labels differ from verified payload")
    require("org.opencontainers.image.package-lock.sha256" not in labels, "legacy provenance label in native image")
    context = work_dir / "context"
    source_tar = (work_dir / "source-inputs.tar").read_bytes()
    cargo_lock = (context / "experiments/rust-replay/Cargo.lock").read_bytes()
    transport, hashes = payload_data(image, source_tar, cargo_lock)
    require((work_dir / "transport-files.json").read_bytes() == transport_manifest(transport), "final transport differs from manifest")
    require(all(hashes[key] == summary[key] for key in hashes), "final native payload hash changed")
    extra = image_files(image, ["/usr/local/share/native-image/components.json"])
    require(extra["/usr/local/share/native-image/components.json"] == (work_dir / "components.json").read_bytes(), "final components changed")
    require(digest((work_dir / "source-inputs.json").read_bytes()) == summary["sourceInputsSha256"], "source manifest hash changed")
    require(digest((work_dir / "transport-files.json").read_bytes()) == summary["transportClosureSha256"], "transport manifest hash changed")


def build(revision: str, work_dir: Path, image_tag: str) -> None:
    source_revision(revision)
    require(image_tag and not image_tag.startswith("-"), "image tag is required")
    files = write_source_context(revision, work_dir)
    rust_version, curl_version, max_schema = version_from_inputs(files)
    cargo_lock = files["experiments/rust-replay/Cargo.lock"][0]
    source_tar = (work_dir / "source-inputs.tar").read_bytes()
    payload_tag = f"{image_tag}-payload"
    context = work_dir / "context"
    call("docker", "build", "-f", str(context / "Dockerfile.native"), "--platform", "linux/amd64",
         "--target", "payload", "--build-arg", f"SOURCE_REVISION={revision}",
         "--build-arg", f"CARGO_LOCK_SHA256={digest(cargo_lock)}", "--tag", payload_tag, str(context))
    transport, hashes = payload_data(payload_tag, source_tar, cargo_lock)
    transport_bytes = transport_manifest(transport)
    (work_dir / "transport-files.json").write_bytes(transport_bytes)
    hashes.update({
        "sourceInputsSha256": digest((work_dir / "source-inputs.json").read_bytes()),
        "transportClosureSha256": digest(transport_bytes),
    })
    component_bytes = components(revision, rust_version, curl_version, hashes)
    (work_dir / "components.json").write_bytes(component_bytes)
    (context / ".native-release/components.json").write_bytes(component_bytes)
    arguments = ["docker", "build", "-f", str(context / "Dockerfile.native"), "--platform", "linux/amd64",
                 "--target", "production", "--build-arg", f"PAYLOAD_IMAGE={payload_tag}",
                 "--build-arg", f"SOURCE_REVISION={revision}",
                 "--build-arg", f"CARGO_LOCK_SHA256={hashes['cargoLockSha256']}",
                 "--build-arg", f"SOURCE_INPUTS_SHA256={hashes['sourceInputsSha256']}",
                 "--build-arg", f"BINARY_SHA256={hashes['binarySha256']}",
                 "--build-arg", f"CURL_SHA256={hashes['curlSha256']}",
                 "--build-arg", f"TRANSPORT_CLOSURE_SHA256={hashes['transportClosureSha256']}",
                 "--build-arg", f"RUST_VERSION={rust_version}",
                 "--build-arg", f"CURL_VERSION={curl_version}", "--tag", image_tag, str(context)]
    call(*arguments)
    summary = {
        "sourceRevision": revision,
        "imageTag": image_tag,
        "imageId": image_inspect(image_tag)["Id"],
        "rustVersion": rust_version,
        "curlImpersonateVersion": curl_version,
        "maximumStateSchema": max_schema,
        **hashes,
    }
    require_final_image(image_tag, summary, work_dir)
    (work_dir / "build-summary.json").write_bytes(canonical(summary))


def metadata(revision: str, work_dir: Path, image_reference: str, operations: Path, output_dir: Path) -> None:
    source_revision(revision)
    require(bool(DIGEST_REFERENCE.fullmatch(image_reference)), "image reference must be immutable")
    summary = json.loads((work_dir / "build-summary.json").read_bytes())
    require(summary["sourceRevision"] == revision, "build source revision differs")
    inspected = image_inspect(image_reference)
    require(inspected["Id"] == summary["imageId"], "published digest differs from scanned final image")
    require(image_reference in inspected.get("RepoDigests", []), "immutable digest is not local to the final image")
    require_final_image(image_reference, summary, work_dir)
    require(operations.is_file() and not operations.is_symlink(), "operations archive is missing")
    expected_operations = call("git", "archive", "--format=tar", revision, "ops", "infra/systemd", cwd=SOURCE_ROOT)
    require(operations.read_bytes() == expected_operations, "operations archive differs from source revision")
    require(not output_dir.exists() or not any(output_dir.iterdir()), "metadata output directory must be empty")
    output_dir.mkdir(parents=True, exist_ok=True)
    source_context = work_dir / "context"
    artifacts = {
        "operations.tar": operations.read_bytes(),
        "compose.production.yaml": (source_context / "compose.production.yaml").read_bytes(),
        "source-inputs.json": (work_dir / "source-inputs.json").read_bytes(),
        "transport-files.json": (work_dir / "transport-files.json").read_bytes(),
    }
    for name, content in artifacts.items():
        (output_dir / name).write_bytes(content)
    metadata_object = {
        "schemaVersion": 3,
        "provenanceKind": "cargo-source-v1",
        "runtime": "rust",
        "sourceDirty": False,
        "sourceRevision": revision,
        "imageReference": image_reference,
        "imageDigest": image_reference.split("@", 1)[1],
        "stateBackend": "sqlite",
        "minimumStateSchema": 1,
        "maximumStateSchema": summary["maximumStateSchema"],
        "deployableStateBackends": ["sqlite"],
        "deployableRuntimes": ["node", "rust"],
        "deployableProvenanceContracts": ["legacy-package-lock-v2", "cargo-source-v3"],
        "cutoverRollbackContract": "preserve-live-state-v1",
        "rustVersion": summary["rustVersion"],
        "curlImpersonateVersion": summary["curlImpersonateVersion"],
        **{key: summary[key] for key in ("cargoLockSha256", "sourceInputsSha256", "binarySha256", "curlSha256", "transportClosureSha256")},
        "composeSha256": digest(artifacts["compose.production.yaml"]),
        "operationsBundleSha256": digest(artifacts["operations.tar"]),
    }
    (output_dir / "release-metadata.json").write_bytes(canonical(metadata_object))
    verify(image_reference, output_dir)


def verify(image_reference: str, bundle: Path) -> None:
    require(bool(DIGEST_REFERENCE.fullmatch(image_reference)), "image reference must be immutable")
    metadata_path = bundle / "release-metadata.json"
    declared = json.loads(metadata_path.read_bytes())
    require(declared.get("imageReference") == image_reference, "bundle image reference differs")
    script = 'set -Eeuo pipefail; RENTAL_OPS_STATE_DIR=/tmp/native-release-verifier; source "$1"; DEPLOYMENT_SOURCE_REVISION="$2"; deployment_verify_release "$3" "$4" "$3/release-metadata.json"'
    call("bash", "-c", script, "native-release-verifier", str(TOOL_ROOT / "ops/lib/deployment.sh"),
         declared["sourceRevision"], str(bundle), image_reference)


def transition(current: dict, current_image: str, current_bundle: Path,
               candidate_summary: Path | None, candidate_metadata: Path | None) -> None:
    require((candidate_summary is None) != (candidate_metadata is None), "one candidate contract is required")
    if candidate_summary is not None:
        summary = json.loads(candidate_summary.read_bytes())
        require_final_image(summary["imageTag"], summary, candidate_summary.parent)
        candidate = {
            "schemaVersion": 3,
            "imageReference": summary["imageTag"],
            "sourceRevision": summary["sourceRevision"],
            "runtime": "rust",
            "stateBackend": "sqlite",
            "minimumStateSchema": 1,
            "maximumStateSchema": summary["maximumStateSchema"],
            "deployableProvenanceContracts": ["legacy-package-lock-v2", "cargo-source-v3"],
        }
    else:
        candidate = json.loads(candidate_metadata.read_bytes())
        require(candidate.get("schemaVersion") == 3 and candidate.get("provenanceKind") == "cargo-source-v1",
                "candidate Cargo contract is missing or unknown")
        verify(candidate["imageReference"], candidate_metadata.parent)
    require(candidate.get("runtime") == "rust" and candidate.get("stateBackend") == "sqlite",
            "candidate runtime or backend is unsupported")
    require(current.get("runtime") == "rust" and current.get("stateBackend") == "sqlite"
            and "rust" in current.get("deployableRuntimes", [])
            and "sqlite" in current.get("deployableStateBackends", []),
            "current release cannot deploy Rust/SQLite")
    with tempfile.TemporaryDirectory(prefix="native-transition-") as temporary:
        candidate_file = Path(temporary) / "candidate.json"
        candidate_file.write_bytes(canonical(candidate))
        script = 'set -Eeuo pipefail; RENTAL_OPS_STATE_DIR=/tmp/native-release-verifier; source "$1"; deployment_state_transition "$2" "$3" "$4" "$5" >/dev/null'
        call("bash", "-c", script, "native-transition", str(TOOL_ROOT / "ops/lib/deployment.sh"),
             str(current_bundle / "release-metadata.json"), str(candidate_file),
             current_image, candidate["imageReference"])


def gate(current_image: str, current_bundle: Path, receipt_record: Path,
         candidate_summary: Path | None, candidate_metadata: Path | None) -> bool:
    """Return whether the v2-to-v3 pointer must be held for promotion."""
    verify(current_image, current_bundle)
    current = json.loads((current_bundle / "release-metadata.json").read_bytes())
    inspected = image_inspect(current_image)
    require(current_image in inspected.get("RepoDigests", []), "current pointer is not an exact pulled digest")
    require(current.get("imageReference") == current_image, "current metadata differs from production pointer")
    labels = inspected.get("Config", {}).get("Labels") or {}
    require(labels.get("org.opencontainers.image.revision") == current.get("sourceRevision"), "current image revision differs from metadata")
    require(labels.get("com.rental-apartments.runtime") == "rust" and current.get("runtime") == "rust", "current release is not exact Rust")
    transition(current, current_image, current_bundle, candidate_summary, candidate_metadata)
    if current.get("schemaVersion") == 3:
        require(current.get("provenanceKind") == "cargo-source-v1", "current Cargo contract is unknown")
        return False
    require(current.get("schemaVersion") == 2, "current release has an unknown provenance contract")
    require(current.get("deployableProvenanceContracts") == ["legacy-package-lock-v2", "cargo-source-v3"],
            "current host release does not advertise verified Cargo capability")
    require(receipt_record.is_file() and not receipt_record.is_symlink(), "accepted stage-one host receipt is missing")
    record = json.loads(receipt_record.read_bytes())
    require(set(record) == {"schemaVersion", "sourceRevision", "imageReference", "host", "receipt", "acceptedAt"},
            "accepted host receipt has an unknown shape")
    require(record["schemaVersion"] == 1 and record["sourceRevision"] == current["sourceRevision"]
            and record["imageReference"] == current_image, "accepted host receipt does not match production pointer")
    host = record["host"]
    receipt = record["receipt"]
    require(set(host) == {"sourceRevision", "imageReference", "observedAt"} and
            host["sourceRevision"] == current["sourceRevision"] and host["imageReference"] == current_image,
            "observed host release does not match production pointer")
    require(set(receipt) == {"name", "sha256", "outcome", "completedAt", "snapshot", "sourceRevision", "candidateImage"},
            "host receipt projection has an unknown shape")
    require(receipt["outcome"] == "success" and receipt["sourceRevision"] == current["sourceRevision"]
            and receipt["candidateImage"] == current_image
            and isinstance(receipt["sha256"], str) and bool(HASH.fullmatch(receipt["sha256"]))
            and isinstance(receipt["snapshot"], str) and bool(SNAPSHOT_NAME.fullmatch(receipt["snapshot"]))
            and isinstance(receipt["name"], str)
            and receipt["name"].endswith(f"-success-{current_image.split('@sha256:')[1][:16]}.json")
            and bool(re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-success-[0-9a-f]{16}\.json", receipt["name"])),
            "host receipt is not a matching successful validated deployment")
    times = []
    for timestamp in (receipt["completedAt"], host["observedAt"], record["acceptedAt"]):
        require(isinstance(timestamp, str) and bool(re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z", timestamp)),
                "host acceptance timestamp is invalid")
        try:
            times.append(datetime.fromisoformat(timestamp.replace("Z", "+00:00")))
        except ValueError as error:
            raise ReleaseError("host acceptance timestamp is not a real UTC time") from error
    require(times == sorted(times), "host acceptance predates successful deployment")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build")
    build_parser.add_argument("--source-revision", required=True)
    build_parser.add_argument("--work-dir", type=Path, required=True)
    build_parser.add_argument("--image-tag", required=True)
    metadata_parser = commands.add_parser("metadata")
    metadata_parser.add_argument("--source-revision", required=True)
    metadata_parser.add_argument("--work-dir", type=Path, required=True)
    metadata_parser.add_argument("--image-reference", required=True)
    metadata_parser.add_argument("--operations-bundle", type=Path, required=True)
    metadata_parser.add_argument("--output-dir", type=Path, required=True)
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--image-reference", required=True)
    verify_parser.add_argument("--bundle", type=Path, required=True)
    gate_parser = commands.add_parser("gate")
    gate_parser.add_argument("--current-image", required=True)
    gate_parser.add_argument("--current-bundle", type=Path, required=True)
    gate_parser.add_argument("--receipt-record", type=Path, required=True)
    candidate_contract = gate_parser.add_mutually_exclusive_group(required=True)
    candidate_contract.add_argument("--candidate-summary", type=Path)
    candidate_contract.add_argument("--candidate-metadata", type=Path)
    arguments = parser.parse_args()
    try:
        if arguments.command == "build":
            build(arguments.source_revision, arguments.work_dir, arguments.image_tag)
        elif arguments.command == "metadata":
            metadata(arguments.source_revision, arguments.work_dir, arguments.image_reference,
                     arguments.operations_bundle, arguments.output_dir)
        elif arguments.command == "verify":
            verify(arguments.image_reference, arguments.bundle)
        else:
            held = gate(arguments.current_image, arguments.current_bundle, arguments.receipt_record,
                        arguments.candidate_summary, arguments.candidate_metadata)
            print(f"cutover={'true' if held else 'false'}")
            if "GITHUB_OUTPUT" in os.environ:
                with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
                    output.write(f"cutover={'true' if held else 'false'}\n")
    except (ReleaseError, OSError, KeyError, ValueError, json.JSONDecodeError) as error:
        parser.exit(1, f"native release: {error}\n")


if __name__ == "__main__":
    main()
