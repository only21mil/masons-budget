#!/usr/bin/env python3
"""Lock credential-minting tools and tests to automatic Clients CI coverage."""

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
CLIENTS_WORKFLOW = ROOT / ".github" / "workflows" / "clients.yml"
WORKFLOW_LINT = ROOT / ".github" / "workflows" / "workflow-lint.yml"

CREDENTIAL_TESTS = (
    "scripts/tests/mint-android-read-bootstrap.test.mjs",
    "scripts/tests/build-android-read-bootstrap.test.mjs",
    "scripts/tests/mint-linux-device-pairing.test.mjs",
    "scripts/tests/mint-mobile-pairing-slots.test.mjs",
)
CREDENTIAL_TOOLS = (
    "scripts/mint-android-read-bootstrap.mjs",
    "scripts/build-android-read-bootstrap.mjs",
    "scripts/mint-linux-device-pairing.mjs",
    "scripts/mint-mobile-pairing-slots.mjs",
)


def workflow_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def tooling_path_pattern(source: str) -> re.Pattern[str]:
    match = re.search(r"^\s*\[tooling\]='([^']+)'$", source, re.MULTILINE)
    if match is None:
        raise AssertionError("clients.yml has no tooling detector pattern")
    return re.compile(match.group(1))


def wide_path_pattern(source: str) -> re.Pattern[str]:
    match = re.search(r"grep -qE '([^']+)' && wide=true", source)
    if match is None:
        raise AssertionError("clients.yml has no wide detector pattern")
    return re.compile(match.group(1))


def job_body(source: str, job_name: str) -> str:
    match = re.search(
        rf"^  {re.escape(job_name)}:\n(?P<body>.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)",
        source,
        re.MULTILINE | re.DOTALL,
    )
    if match is None:
        raise AssertionError(f"clients.yml has no {job_name} job")
    return match.group("body")


class CredentialToolingRoutingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.clients = workflow_text(CLIENTS_WORKFLOW)

    def test_each_tool_and_test_activates_the_tooling_tree(self) -> None:
        pattern = tooling_path_pattern(self.clients)
        for changed_path in CREDENTIAL_TOOLS + CREDENTIAL_TESTS + (
            ".github/workflows/android-read-bootstrap.yml",
            "android/app/build.gradle.kts",
        ):
            with self.subTest(changed_path=changed_path):
                self.assertIsNotNone(pattern.fullmatch(changed_path))

        for unrelated_path in (
            "scripts/mint-unrelated.mjs",
            "scripts/tests/mint-unrelated.test.mjs",
            "docs/credential-tooling.md",
        ):
            with self.subTest(unrelated_path=unrelated_path):
                self.assertIsNone(pattern.fullmatch(unrelated_path))

    def test_workflow_changes_activate_every_detected_tree(self) -> None:
        pattern = wide_path_pattern(self.clients)
        for changed_path in (
            ".github/workflows/clients.yml",
            ".github/workflows/scripts/protected_ci_reuse.py",
            ".github/workflows/scripts/tests/test_protected_ci_reuse.py",
            "package.json",
            "package-lock.json",
            "shared/domain/src/index.ts",
            "convex/dataFiles.ts",
        ):
            with self.subTest(changed_path=changed_path):
                self.assertIsNotNone(pattern.search(changed_path))

    def test_detector_exports_and_fails_open_for_tooling(self) -> None:
        self.assertIn("tooling: ${{ steps.filter.outputs.tooling }}", self.clients)
        self.assertRegex(
            self.clients,
            r"(?s)verify_all\(\) \{.*?for t in linux android tooling; do",
        )
        self.assertRegex(self.clients, r"for t in linux android tooling; do")

        body = job_body(self.clients, "credential-tooling")
        self.assertIn("needs: changes", body)
        self.assertIn("needs.changes.result != 'success'", body)
        self.assertIn("needs.changes.outputs.tooling == 'true'", body)

    def test_job_runs_every_credential_test_without_bound_secrets(self) -> None:
        body = job_body(self.clients, "credential-tooling")
        self.assertIn("node --test", body)
        for test_path in CREDENTIAL_TESTS:
            with self.subTest(test_path=test_path):
                self.assertIn(test_path, body)
        self.assertNotIn("secrets.", body)

    def test_workflow_policy_test_is_automatic(self) -> None:
        lint = workflow_text(WORKFLOW_LINT)
        self.assertIn(
            "python3 .github/workflows/scripts/tests/test_clients_credential_tooling.py",
            lint,
        )


if __name__ == "__main__":
    unittest.main()
