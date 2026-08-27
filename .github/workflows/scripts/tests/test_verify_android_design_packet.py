#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "verify_android_design_packet.py"
SPEC = importlib.util.spec_from_file_location("verify_android_design_packet", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AndroidDesignPacketTests(unittest.TestCase):
    def populate(self, directory: Path, names: set[str] | frozenset[str]) -> None:
        for name in names:
            (directory / name).touch()

    def test_accepts_complete_packet(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            packet_dir = Path(directory)
            self.populate(packet_dir, MODULE.EXPECTED_PNGS)

            self.assertEqual([], MODULE.verify(packet_dir))

    def test_rejects_missing_png(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            packet_dir = Path(directory)
            missing = min(MODULE.EXPECTED_PNGS)
            self.populate(packet_dir, MODULE.EXPECTED_PNGS - {missing})

            errors = MODULE.verify(packet_dir)
            self.assertTrue(any(f"missing PNGs (1): {missing}" in error for error in errors))

    def test_rejects_unexpected_png(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            packet_dir = Path(directory)
            self.populate(packet_dir, MODULE.EXPECTED_PNGS | {"unexpected.png"})

            errors = MODULE.verify(packet_dir)
            self.assertTrue(
                any("unexpected PNGs (1): unexpected.png" in error for error in errors)
            )

    def test_rejects_empty_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            errors = MODULE.verify(Path(directory))

            self.assertTrue(any("missing PNGs (64)" in error for error in errors))

    def test_rejects_duplicate_basename(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            packet_dir = Path(directory)
            self.populate(packet_dir, MODULE.EXPECTED_PNGS)
            duplicate = min(MODULE.EXPECTED_PNGS)
            nested = packet_dir / "nested"
            nested.mkdir()
            (nested / duplicate).touch()

            errors = MODULE.verify(packet_dir)
            self.assertTrue(
                any(f"duplicate PNG basenames (1): {duplicate}" in error for error in errors)
            )


if __name__ == "__main__":
    unittest.main()
