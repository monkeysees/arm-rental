"""Compare packaged Rust domain and bot behavior with frozen Node outputs."""

from __future__ import annotations

from collections import Counter
from hashlib import sha256
import json
from pathlib import Path

from common import Harness


ROOT = Path(__file__).resolve().parents[2]
HTML_ROOT = ROOT / "test" / "fixtures" / "list-am-real-shape"


def run_contract(harness: Harness, fixtures_dir: Path) -> dict:
    frozen = json.loads((fixtures_dir / "contract-expected.json").read_text(encoding="utf-8"))
    cases = frozen["cases"]
    assert len(cases) == 122, "frozen Node contract matrix changed"
    assert len({case["name"] for case in cases}) == len(cases), "duplicate contract case"
    inputs = []
    for case in cases:
        request = dict(case["input"])
        if "htmlFixture" in case:
            path = ROOT / case["htmlFixture"]
            assert path.parent == HTML_ROOT and path.is_file(), "unreviewed HTML fixture"
            content = path.read_bytes()
            assert sha256(content).hexdigest() == case["htmlSha256"], "HTML fixture changed"
            request["html"] = content.decode("utf-8")
        inputs.append(request)

    volume = harness.new_volume()
    result = harness.run_app(
        ["contract"],
        data_volume=volume,
        input_text="".join(json.dumps(value, ensure_ascii=False) + "\n" for value in inputs),
        timeout=120,
    )
    actual = [json.loads(line) for line in result.stdout.splitlines()]
    assert len(actual) == len(cases), f"expected {len(cases)} contract responses, got {len(actual)}"
    for case, response in zip(cases, actual, strict=True):
        expected = case["expected"]
        comparison = case.get("comparison", "exact")
        if comparison == "error-present":
            assert isinstance(expected.get("error"), str), case["name"]
            assert isinstance(response.get("error"), str) and response["error"], case["name"]
            if case["name"].startswith("config-invalid-"):
                assert case["input"]["env"]["TELEGRAM_BOT_TOKEN"] not in json.dumps(response), case["name"]
        elif comparison == "state-and-operations":
            assert response.get("state") == expected["state"], f"{case['name']}: state differs"
            assert response.get("operations") == expected["operations"], f"{case['name']}: Telegram operations differ"
            assert isinstance(response.get("outcomes"), list), f"{case['name']}: missing update outcomes"
            assert len(response["outcomes"]) == len(case["input"]["updates"]), case["name"]
        else:
            assert comparison == "exact", f"unknown comparison: {comparison}"
            assert response == expected, f"{case['name']}: result differs from frozen Node baseline"

    groups = Counter(case["name"].split("-", 1)[0] for case in cases)
    return {
        "status": "passed",
        "caseCount": len(cases),
        "groups": dict(sorted(groups.items())),
        "nodeSourceRevision": frozen["provenance"]["nodeSourceRevision"],
        "nodeRuntime": frozen["provenance"]["nodeRuntime"],
    }
