#!/usr/bin/env python3
"""Exercise the packaged Rust application without a Node process."""

import argparse
import hashlib
import json
from pathlib import Path

from common import Harness
from lifecycle import run_lifecycle
from service import run_service


FIXTURES = Path(__file__).resolve().parent / "fixtures"


def verify_fixtures() -> dict[str, str]:
    manifest = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
    expected = manifest["sha256"]
    actual_files = {
        str(path.relative_to(FIXTURES))
        for path in FIXTURES.rglob("*")
        if path.is_file() and path.name != "manifest.json"
    }
    if actual_files != set(expected):
        raise AssertionError(
            f"fixture manifest mismatch: unlisted={sorted(actual_files - set(expected))}, "
            f"missing={sorted(set(expected) - actual_files)}"
        )
    for name, digest in expected.items():
        path = FIXTURES / name
        if path.resolve().parent != FIXTURES.resolve():
            raise AssertionError(f"nested fixture path is not supported: {name}")
        observed = hashlib.sha256(path.read_bytes()).hexdigest()
        if observed != digest:
            raise AssertionError(f"fixture changed: {name}")
    return expected


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="packaged Rust image or immutable image ID")
    parser.add_argument("--output", required=True, type=Path, help="new absolute result directory")
    parser.add_argument("--expected-revision", help="required OCI source revision")
    parser.add_argument("--require-clean-source", action="store_true")
    args = parser.parse_args()
    if not args.output.is_absolute() or args.output.exists():
        parser.error("--output must name a new absolute directory")
    args.output.mkdir(mode=0o700)

    fixture_hashes = verify_fixtures()
    with Harness(args.image, args.output) as harness:
        if args.expected_revision and harness.source_revision != args.expected_revision:
            raise AssertionError("packaged image revision differs from accepted source")
        if args.require_clean_source and harness.source_dirty != "false":
            raise AssertionError("packaged image does not claim clean source inputs")
        lifecycle = run_lifecycle(harness, FIXTURES)
        service = run_service(harness, FIXTURES)
        report = {
            "type": "rust-production-native-acceptance",
            "version": 1,
            "imageId": harness.image_id,
            "architecture": harness.architecture,
            "binarySha256": harness.binary_sha256,
            "sourceRevision": harness.source_revision,
            "sourceDirty": harness.source_dirty,
            "sourceInputSha256": harness.source_input_sha256,
            "cargoLockSha256": harness.cargo_lock_sha256,
            "fixtureSha256": fixture_hashes,
            "lifecycle": lifecycle,
            "service": service,
            "remainingParityGaps": [
                "The 500-recipient capacity, fairness, and interrupted suffix gate remains issue #47.",
                "This native gate samples private controls and source failures; the retained Node differential suite covers the broader branch matrix until issue #50.",
            ],
        }
    if verify_fixtures() != fixture_hashes:
        raise AssertionError("fixture inputs changed during acceptance")
    (args.output / "report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
