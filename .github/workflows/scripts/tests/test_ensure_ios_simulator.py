#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "ensure_ios_simulator.py"
SPEC = importlib.util.spec_from_file_location("ensure_ios_simulator", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SimulatorSelectionTests(unittest.TestCase):
    def test_names_missing_runtime(self) -> None:
        with self.assertRaisesRegex(
            MODULE.SimulatorSetupError,
            "no available iOS simulator runtime is installed",
        ):
            MODULE.select_runtime([])

    def test_selects_latest_available_ios_runtime(self) -> None:
        runtimes = [
            {
                "name": "iOS 26.4",
                "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
                "version": "26.4",
                "isAvailable": True,
            },
            {
                "name": "iOS 26.5",
                "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
                "version": "26.5",
                "isAvailable": True,
            },
            {
                "name": "iOS 27.0",
                "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
                "version": "27.0",
                "isAvailable": False,
            },
        ]

        self.assertEqual(MODULE.select_runtime(runtimes)["version"], "26.5")

    def test_selects_newest_compatible_iphone_type(self) -> None:
        runtime = {
            "name": "iOS 26.5",
            "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
            "version": "26.5",
        }
        device_types = [
            {
                "name": "iPhone 17",
                "identifier": "phone-17",
                "productFamily": "iPhone",
                "minRuntimeVersion": MODULE.encoded_version("26.0"),
                "maxRuntimeVersion": MODULE.encoded_version("26.9"),
            },
            {
                "name": "iPhone 17e",
                "identifier": "phone-17e",
                "productFamily": "iPhone",
                "minRuntimeVersion": MODULE.encoded_version("26.3"),
                "maxRuntimeVersion": MODULE.encoded_version("26.9"),
            },
            {
                "name": "iPhone Future",
                "identifier": "phone-future",
                "productFamily": "iPhone",
                "minRuntimeVersion": MODULE.encoded_version("27.0"),
                "maxRuntimeVersion": MODULE.encoded_version("27.9"),
            },
        ]

        self.assertEqual(
            MODULE.select_device_type(device_types, runtime)["identifier"], "phone-17e"
        )

    def test_names_missing_compatible_iphone_type(self) -> None:
        runtime = {
            "name": "iOS 26.5",
            "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
            "version": "26.5",
        }

        with self.assertRaisesRegex(
            MODULE.SimulatorSetupError,
            "no compatible iPhone simulator device type is installed for iOS 26.5",
        ):
            MODULE.select_device_type([], runtime)

    def test_reuses_only_available_named_device_on_selected_runtime(self) -> None:
        devices = {
            "runtime-old": [
                {"name": "Vogel Vault CI iPhone", "udid": "old", "isAvailable": True}
            ],
            "runtime-current": [
                {
                    "name": "Vogel Vault CI iPhone",
                    "udid": "unavailable",
                    "isAvailable": False,
                },
                {
                    "name": "Vogel Vault CI iPhone",
                    "udid": "current",
                    "isAvailable": True,
                },
            ],
        }

        self.assertEqual(
            MODULE.find_named_device(
                devices, "runtime-current", "Vogel Vault CI iPhone"
            ),
            "current",
        )


if __name__ == "__main__":
    unittest.main()
