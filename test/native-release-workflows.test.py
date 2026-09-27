"""Required CI and release ordering for the Rust-only publication contract."""

from __future__ import annotations

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"


class RustOnlyWorkflowTest(unittest.TestCase):
    def test_required_ci_exercises_native_artifact_and_rollback_without_node(self) -> None:
        workflow = (WORKFLOWS / "quality.yml").read_text()
        for required in (
            "cargo fmt --check", "cargo check --locked --all-targets",
            "cargo clippy --locked --all-targets", "cargo test --locked",
            "scripts/check --already-built", "native-acceptance/run.py",
            "native-capacity/run.py", "--users 500",
            "native-release-producer.test.py", "native-cutover/rust_rollback.py",
            "Scan native OS and linked application dependencies",
        ):
            self.assertIn(required, workflow)
        self.assertLess(workflow.index("native-capacity/run.py"),
                        workflow.index("native-release-producer.test.py"),
                        "the 500-user disk gate must precede the second Docker build")
        for forbidden in ("actions/setup-node", "npm ci", "npm run", "package-lock.json",
                          "--entrypoint node", "--node-image", "rental-apartments-bot:ci"):
            self.assertNotIn(forbidden, workflow)

    def test_publication_checks_accepted_bridge_before_any_push(self) -> None:
        workflow = (WORKFLOWS / "publish-production.yml").read_text()
        for required in ("scripts/native-release.py build", "scripts/native-release.py metadata",
                         "scripts/native-release.py verify", "scripts/native-release.py gate",
                         "docs/evidence/issue50-bridge-receipt.json"):
            self.assertIn(required, workflow)
        self.assertLess(workflow.index("--retirement-receipt-record"), workflow.index("docker push"))
        self.assertLess(workflow.index("Scan candidate before publication"), workflow.index("docker push"))
        self.assertIn("steps.transition.outputs.cutover == 'false'", workflow)
        self.assertIn("steps.transition.outputs.cutover == 'true'", workflow)
        for forbidden in ("actions/setup-node", "npm ", "node scripts/", "package-lock.json",
                          "PRODUCTION_RUNTIME", "check-production-transition.js"):
            self.assertNotIn(forbidden, workflow)

    def test_promotion_rechecks_exact_rust_contract_before_pointer(self) -> None:
        workflow = (WORKFLOWS / "promote-production.yml").read_text()
        self.assertIn("deployed_bridge_revision", workflow)
        self.assertIn("deployed_bridge_digest", workflow)
        self.assertIn("test \"$CANDIDATE_RUNTIME\" = rust", workflow)
        self.assertIn("test \"$CURRENT_RUNTIME\" = rust", workflow)
        self.assertIn("docs/evidence/issue50-bridge-receipt.json", workflow)
        self.assertLess(workflow.index("scripts/native-release.py gate"), workflow.index("docker push"))
        for forbidden in ("actions/setup-node", "node scripts/", "check-production-transition.js"):
            self.assertNotIn(forbidden, workflow)


if __name__ == "__main__":
    unittest.main()
