#!/usr/bin/env python3
"""Regression contract for the TestFlight manual-signing path."""

from __future__ import annotations

import plistlib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
DEPLOY = ROOT / ".github/workflows/deploy.yml"
PROJECT = ROOT / "MasonsBudget/project.yml"
EXPORT_OPTIONS = ROOT / "ExportOptions.plist"
GENERATED_PROJECT = (
    ROOT / "MasonsBudget/MasonsBudget.xcodeproj/project.pbxproj"
)


class ManualReleaseSigningTests(unittest.TestCase):
    def test_release_configurations_are_manual(self) -> None:
        project = PROJECT.read_text(encoding="utf-8")

        self.assertGreaterEqual(
            project.count("CODE_SIGN_STYLE: Manual"),
            2,
            "both app targets must make their Release configuration manual",
        )
        self.assertGreaterEqual(
            project.count('CODE_SIGN_IDENTITY: "Apple Distribution"'),
            2,
            "both app targets must name the distribution identity explicitly",
        )
        generated = GENERATED_PROJECT.read_text(encoding="utf-8")
        self.assertGreaterEqual(generated.count("CODE_SIGN_STYLE = Manual;"), 2)
        self.assertGreaterEqual(
            generated.count('CODE_SIGN_IDENTITY = "Apple Distribution";'),
            2,
        )

    def test_deploy_cannot_create_signing_assets(self) -> None:
        deploy = DEPLOY.read_text(encoding="utf-8")

        self.assertNotIn(
            "-allowProvisioningUpdates",
            deploy,
            "the release workflow must never authorize xcodebuild to create signing assets",
        )
        self.assertNotIn("-authenticationKeyPath", deploy)
        self.assertIn("vars.APPLE_MANUAL_SIGNING_READY", deploy)
        self.assertIn('CODE_SIGN_STYLE=Manual', deploy)
        self.assertIn('CODE_SIGN_IDENTITY="Apple Distribution"', deploy)
        self.assertIn('PROVISIONING_PROFILE="$PROFILE_UUID"', deploy)
        self.assertIn('PROVISIONING_PROFILE_SPECIFIER="$PROFILE_NAME"', deploy)

    def test_deploy_installs_human_provided_assets(self) -> None:
        deploy = DEPLOY.read_text(encoding="utf-8")

        required_fragments = (
            "APPLE_DISTRIBUTION_CERTIFICATE_P12",
            "APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD",
            "APPLE_IOS_APP_STORE_PROFILE",
            "APPLE_MAC_APP_STORE_PROFILE",
            "APPLE_MAC_INSTALLER_CERTIFICATE_P12",
            "APPLE_MAC_INSTALLER_CERTIFICATE_PASSWORD",
            "security import",
            "security cms -D",
        )
        for fragment in required_fragments:
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, deploy)

    def test_export_is_manual(self) -> None:
        with EXPORT_OPTIONS.open("rb") as handle:
            options = plistlib.load(handle)

        self.assertEqual(options["signingStyle"], "manual")
        self.assertEqual(options["signingCertificate"], "Apple Distribution")
        self.assertEqual(
            options["installerSigningCertificate"],
            "Mac Installer Distribution",
        )


if __name__ == "__main__":
    unittest.main()
