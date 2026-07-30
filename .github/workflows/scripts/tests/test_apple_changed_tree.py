#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "apple_changed_tree.py"
SPEC = importlib.util.spec_from_file_location("apple_changed_tree", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


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

    def test_apple_sources_and_project_files_allocate_apple(self) -> None:
        for path in (
            "MasonsBudget/MasonsBudget/App/MasonsBudgetApp.swift",
            "Package.swift",
            "Tests/VogelVaultCoreTests/VoiceParserTests.swift",
        ):
            with self.subTest(path=path):
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

    def test_unrelated_shared_file_does_not_allocate_apple(self) -> None:
        self.assertFalse(
            MODULE.requires_apple(["shared/domain/src/writeContract.ts"])
        )


if __name__ == "__main__":
    unittest.main()
