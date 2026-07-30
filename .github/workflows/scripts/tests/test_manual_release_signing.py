#!/usr/bin/env python3
"""Static contract for self-hosted manual Apple releases."""

from __future__ import annotations

import plistlib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
DEPLOY = ROOT / ".github/workflows/deploy.yml"
SWIFT = ROOT / ".github/workflows/swift.yml"
EXPORT_OPTIONS = ROOT / "ExportOptions.plist"


class ManualReleaseSigningTests(unittest.TestCase):
    def test_no_github_hosted_macos_route_remains(self) -> None:
        for workflow in (DEPLOY, SWIFT):
            with self.subTest(workflow=workflow.name):
                self.assertNotIn(
                    "runs-on: macos-", workflow.read_text(encoding="utf-8")
                )

    def test_mbp_is_primary_and_mini_is_manual_only(self) -> None:
        deploy = DEPLOY.read_text(encoding="utf-8")
        swift = SWIFT.read_text(encoding="utf-8")
        for workflow in (deploy, swift):
            self.assertIn('"mason-mbp"', workflow)
            self.assertIn('"mason-mini"', workflow)
            self.assertIn("inputs.apple_runner == 'mini'", workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'", swift)

    def test_swift_detector_uses_checkout_history_without_refetching(self) -> None:
        swift = SWIFT.read_text(encoding="utf-8")
        self.assertNotIn("git fetch", swift)
        self.assertIn("github.event.pull_request.base.sha", swift)

    def test_deploy_cannot_create_signing_assets(self) -> None:
        deploy = DEPLOY.read_text(encoding="utf-8")

        self.assertNotIn("-allowProvisioningUpdates", deploy)
        self.assertNotIn("base64 --decode", deploy)
        self.assertIn("/usr/bin/base64 -D", deploy)
        self.assertIn("vars.APPLE_MANUAL_SIGNING_READY", deploy)
        self.assertIn("CODE_SIGN_STYLE=Manual", deploy)
        self.assertIn('CODE_SIGN_IDENTITY="Apple Distribution"', deploy)
        self.assertIn('PROVISIONING_PROFILE_SPECIFIER="$PROFILE_UUID"', deploy)

    def test_persistent_runner_cleanup_is_run_scoped_and_restorative(self) -> None:
        deploy = DEPLOY.read_text(encoding="utf-8")

        for fragment in (
            "vogel-vault-signing-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${PLATFORM}",
            "vogel-vault-release-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${PLATFORM}",
            'security list-keychains -d user > "$ORIGINAL_KEYCHAINS_FILE"',
            'security list-keychains -d user -s "${original_keychains[@]}"',
            'security delete-keychain "$KEYCHAIN_PATH"',
            "CREATED_PROFILE=false",
            "bash .github/workflows/scripts/install_provisioning_profile.sh",
            'if [ "${CREATED_PROFILE:-false}" = "true" ]',
            '"$RUNNER_TEMP"/vogel-vault-signing-*',
            '"$RUNNER_TEMP"/vogel-vault-release-*',
            "API_PRIVATE_KEYS_DIR=$PRIVATE_KEYS_DIR",
        ):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, deploy)

        self.assertNotIn('rm -rf "$HOME/private_keys"', deploy)
        self.assertNotIn(
            'rm -rf "$HOME/Library/MobileDevice/Provisioning Profiles"', deploy
        )
        self.assertNotIn(
            'if [ -n "${INSTALLED_PROFILE_PATH:-}" ]; then\n'
            '            rm -f "$INSTALLED_PROFILE_PATH"',
            deploy,
        )

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
