#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import os
import subprocess
import unittest
from pathlib import Path

import yaml


SCRIPT = Path(__file__).resolve().parents[1] / "apple_changed_tree.py"
SPEC = importlib.util.spec_from_file_location("apple_changed_tree", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
WORKFLOW = SCRIPT.parents[1] / "swift.yml"


class AppleBuildGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.job = yaml.safe_load(WORKFLOW.read_text())["jobs"]["swift"]

    def job_runs(self, *, apple: str, project: str, changes: str = "success") -> bool:
        # Evaluate the workflow's actual boolean condition for a same-repo PR.
        values = {
            "always()": True,
            "github.repository": "only21mil/masons-budget",
            "github.event_name": "pull_request",
            "github.event.pull_request.head.repo.full_name": "only21mil/masons-budget",
            "needs.changes.result": changes,
            "needs.changes.outputs.apple": apple,
            "needs.project-consistency.result": project,
        }
        expression = self.job["if"]
        for key, value in values.items():
            expression = expression.replace(key, repr(value))
        expression = expression.replace("&&", "and").replace("||", "or")
        return bool(eval(f"({expression})", {"__builtins__": {}}, {}))

    def test_apple_changes_run_even_when_project_consistency_did_not_pass(self) -> None:
        self.assertIn("project-consistency", self.job["needs"])
        for result in ("success", "failure", "cancelled", "skipped"):
            with self.subTest(project=result):
                self.assertTrue(self.job_runs(apple="true", project=result))

    def test_metadata_only_changes_still_skip(self) -> None:
        self.assertFalse(self.job_runs(apple="false", project="skipped"))

    def test_detector_failure_still_runs(self) -> None:
        self.assertTrue(self.job_runs(apple="", project="failure", changes="failure"))

    def test_first_step_fails_before_checkout_unless_project_consistency_passed(self) -> None:
        step = self.job["steps"][0]
        self.assertNotIn("if", step)
        self.assertFalse(step.get("continue-on-error", False))
        self.assertFalse(self.job.get("continue-on-error", False))
        self.assertEqual(
            step["env"]["PROJECT_CONSISTENCY_RESULT"],
            "${{ needs.project-consistency.result }}",
        )
        for result in ("success", "failure", "cancelled", "skipped", ""):
            with self.subTest(project=result):
                completed = subprocess.run(
                    ["bash", "-e", "-c", step["run"]],
                    env={**os.environ, "PROJECT_CONSISTENCY_RESULT": result},
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(completed.returncode, 0 if result == "success" else 1)
                if result != "success":
                    self.assertIn("::error::", completed.stdout)


class AppleChangedTreeTests(unittest.TestCase):
    def test_android_only_change_does_not_allocate_apple(self) -> None:
        self.assertFalse(
            MODULE.requires_apple(
                [
                    "android/app/src/main/kotlin/Example.kt",
                    "android/app/src/test/kotlin/ExampleTest.kt",
                ]
            )
        )

    def test_apple_source_allocates_apple(self) -> None:
        path = "MasonsBudget/MasonsBudget/App/MasonsBudgetApp.swift"
        self.assertTrue(MODULE.requires_apple([path]))

    def test_visibility_fixture_allocates_apple(self) -> None:
        self.assertTrue(
            MODULE.requires_apple(
                ["shared/domain/fixtures/visibility-cases.json"]
            )
        )

    def test_simulator_provisioning_script_allocates_apple(self) -> None:
        self.assertTrue(
            MODULE.requires_apple(
                [".github/workflows/scripts/ensure_ios_simulator.py"]
            )
        )

    def test_reuse_proof_changes_allocate_apple(self) -> None:
        for path in (
            ".github/workflows/scripts/protected_ci_reuse.py",
            ".github/workflows/scripts/tests/test_protected_ci_reuse.py",
        ):
            self.assertTrue(MODULE.requires_apple([path]))

    def test_unrelated_shared_file_does_not_allocate_apple(self) -> None:
        self.assertFalse(
            MODULE.requires_apple(["shared/domain/src/writeContract.ts"])
        )


if __name__ == "__main__":
    unittest.main()
