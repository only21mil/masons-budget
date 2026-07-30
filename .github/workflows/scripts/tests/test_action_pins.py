#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "check_action_pins.py"
SPEC = importlib.util.spec_from_file_location("check_action_pins", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ActionPinTests(unittest.TestCase):
    def scan(self, workflow: str) -> list[str]:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "check.yml"
            path.write_text(workflow, encoding="utf-8")
            return MODULE.scan(path)

    def test_accepts_full_sha_and_non_repository_references(self) -> None:
        sha = "0123456789abcdef0123456789abcdef01234567"
        errors = self.scan(
            "\n".join(
                (
                    f"      - uses: actions/checkout@{sha} # v7.0.1",
                    "      - uses: ./.github/workflows/local.yml",
                    "      - uses: docker://alpine:3.22",
                )
            )
        )
        self.assertEqual([], errors)

    def test_rejects_tag_branch_and_short_sha_references(self) -> None:
        errors = self.scan(
            "\n".join(
                (
                    "      - uses: actions/checkout@v7",
                    "      - uses: actions/setup-node@main",
                    "      - uses: actions/cache@0123456789abcdef",
                )
            )
        )
        self.assertEqual(3, len(errors))
        self.assertTrue(all("mutable" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
