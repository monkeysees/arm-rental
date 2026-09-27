#!/usr/bin/env python3
"""Node-free configuration and maintained-document consistency checks."""

import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote
import unittest


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "experiments/rust-replay/src/production/configuration.json"
ACCESS = (
    "TELEGRAM_ACCESS_MODE", "TELEGRAM_ALLOWED_USER_IDS",
    "TELEGRAM_USER_UPDATES_PER_MINUTE", "TELEGRAM_PRIVATE_DELIVERIES_PER_MINUTE",
)
INLINE_ROOTS = ("src/", "test/", "scripts/", "ops/", "infra/", "docs/")
INLINE_FILES = {".env.example", ".nvmrc", "AGENTS.MD", "Dockerfile", "README.md",
                "compose.production.yaml", "eslint.config.js", "package.json", "package-lock.json"}
ACTIVE_INLINE = {
    "README.md", "docs/architecture.md", "docs/continuous-integration.md",
    "docs/deployment-from-scratch.md", "docs/rust-development.md",
}
def tracked() -> set[str]:
    result = subprocess.run(["git", "ls-files", "--cached", "-z", "--"], cwd=ROOT,
                            capture_output=True, check=True)
    return {name.decode() for name in result.stdout.split(b"\0") if name}


def path_index(names: set[str]) -> set[str]:
    result = set(names)
    for name in names:
        parent = Path(name).parent
        while parent != Path("."):
            result.add(parent.as_posix())
            parent = parent.parent
    return result


def checked_in(path: Path, names: set[str]) -> bool:
    try:
        relative = path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return False
    return relative in path_index(names) and path.exists()


def inline_path(value: str) -> str | None:
    if value in INLINE_FILES:
        return value
    if value.startswith(INLINE_ROOTS) and re.fullmatch(r"[A-Za-z0-9._/-]+/?", value):
        return value
    return None


class Documentation(unittest.TestCase):
    def test_configuration_example_and_readme_match_rust_catalog(self):
        catalog = json.loads(CATALOG.read_text())
        self.assertEqual(len({entry["name"] for entry in catalog}), len(catalog))
        example = (ROOT / ".env.example").read_text()
        readme = (ROOT / "README.md").read_text()
        section = readme.split("## Configuration\n", 1)
        self.assertEqual(len(section), 2, "README Configuration table is missing")
        table = section[1].split("\n## ", 1)[0]
        assignments: dict[str, list[str]] = {}
        for name, value in re.findall(r"^([A-Z][A-Z0-9_]*)=(.*)$", example, re.M):
            assignments.setdefault(name, []).append(value)
        rows: dict[str, list[str]] = {}
        for name, value in re.findall(r"^\| `([A-Z][A-Z0-9_]*)`\s+\|\s+([^|]+)\|", table, re.M):
            rows.setdefault(name, []).append(value.strip().strip("`"))
        expected_names = {entry["name"] for entry in catalog}
        self.assertEqual(set(assignments), expected_names, ".env.example supported names differ")
        self.assertEqual(set(rows), expected_names, "README supported names differ")
        for entry in catalog:
            name = entry["name"]
            example_default = "" if entry.get("required") or "defaultValue" not in entry else str(entry["defaultValue"])
            readme_default = ("required" if entry.get("required") else
                              entry.get("defaultDescription") or
                              ("blank" if entry.get("defaultValue") == "" else str(entry.get("defaultValue"))))
            self.assertEqual(assignments[name], [example_default], name)
            self.assertEqual(rows[name], [readme_default], name)

    def test_maintained_markdown_links_resolve_to_reviewed_paths(self):
        names = tracked()
        for filename in sorted(name for name in names if name == "README.md" or
                               (name.startswith("docs/") and name.endswith(".md"))):
            path = ROOT / filename
            if not path.is_file():
                continue
            contents = path.read_text()
            for raw in re.findall(r"!?\[[^\]]*\]\(([^)]+)\)", contents):
                target = raw.strip().strip("<>").split()[0].split("#", 1)[0]
                if not target or re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I):
                    continue
                resolved = (path.parent / unquote(target)).resolve()
                self.assertTrue(checked_in(resolved, names), f"{filename}: {raw} is not tracked and present")
            if filename in ACTIVE_INLINE:
                for value in re.findall(r"`([^`\r\n]+)`", contents):
                    referenced = inline_path(value)
                    if referenced:
                        self.assertTrue(checked_in(ROOT / referenced, names),
                                        f"{filename}: {referenced} is not tracked and present")

    def test_untracked_paths_do_not_become_checked_in_implicitly(self):
        names = {"README.md", "docs/tracked.md", "docs/guides/introduction.md"}
        self.assertFalse(checked_in(ROOT / "docs/untracked.md", names))
        self.assertTrue(checked_in(ROOT / "README.md", names))
        self.assertTrue(checked_in(ROOT / "docs", names))
        self.assertIn("docs/guides", path_index(names))
        self.assertFalse(checked_in(ROOT / "docs/guides", names))

    def test_access_docs_keep_modes_defaults_and_owner_route(self):
        files = (".env.example", "README.md", "docs/deployment-from-scratch.md", "docs/architecture.md")
        for filename in files:
            contents = (ROOT / filename).read_text()
            for mode in ("public", "owner", "allowlist"):
                self.assertRegex(contents, rf"\b{mode}\b", filename)
            self.assertRegex(contents, r"(?i)defaults? to [`]?public[`]?", filename)
            self.assertRegex(contents, r"(?i)server-alert recipient", filename)
            self.assertRegex(contents, r"(?i)no private-user\s+admission\s+(?:cap|limit)", filename)
            self.assertRegex(contents, r"(?i)at least one", filename)
            self.assertRegex(contents, r"(?i)non-owner", filename)
            self.assertRegex(contents, r"(?i)(?:do\s+not|must\s+not)[^.]{0,80}(?:repeat|repeated)", filename)
        deployment = (ROOT / files[2]).read_text()
        for name in ACCESS:
            self.assertRegex(deployment, rf"(?m)^{name}=", name)
        architecture = (ROOT / files[3]).read_text()
        for removed in ("src/staging-guard.js", "src/staging-smoke.js", "src/staging-soak.js"):
            self.assertNotIn(removed, architecture)
        self.assertNotRegex(architecture, r"(?i)Fluentd-compatible|Production Compose requires an external collector")


if __name__ == "__main__":
    unittest.main(verbosity=2)
