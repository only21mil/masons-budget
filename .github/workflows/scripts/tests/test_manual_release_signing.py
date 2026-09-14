#!/usr/bin/env python3
"""Static contract for self-hosted manual Apple releases."""

from __future__ import annotations

import plistlib
import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[4]
DEPLOY = ROOT / ".github/workflows/deploy.yml"
SWIFT = ROOT / ".github/workflows/swift.yml"
EXPORT_OPTIONS = ROOT / "ExportOptions.plist"
spec = importlib.util.spec_from_file_location("mac_validation", ROOT / ".github/workflows/scripts/validate_macos_release.py")
mac_validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mac_validation)


class ManualReleaseSigningTests(unittest.TestCase):
    def test_mac_installer_accepts_documented_names_and_refuses_other_type_or_team(self):
        for name in ("Mac Installer Distribution", "3rd Party Mac Developer Installer"):
            for subject in ("Fixture (384ZGKG4GB)", "384ZGKG4GB"):
                mac_validation.installer_identity(f'  1) {"A" * 40} "{name}: {subject}"')
        for name in ("Developer ID Installer", "Apple Distribution", "3rd Party Mac Developer Application"):
            with self.assertRaises(ValueError):
                mac_validation.installer_identity(f'  1) {"A" * 40} "{name}: Fixture (384ZGKG4GB)"')
        for subject in ("Fixture (WRONGTEAM)", "Fixture (384ZGKG4GB) suffix"):
            with self.assertRaises(ValueError):
                mac_validation.installer_identity(f'  1) {"A" * 40} "3rd Party Mac Developer Installer: {subject}"')
        with self.assertRaises(ValueError):
            mac_validation.installer_identity("0 valid identities found")

    def mac_profile(self):
        return {"UUID": "11111111-2222-3333-4444-555555555555", "TeamIdentifier": [mac_validation.TEAM],
                "Platform": ["OSX"], "Entitlements": {"com.apple.application-identifier":
                f"{mac_validation.TEAM}.{mac_validation.BUNDLE}"}}

    def test_mac_profile_uses_mac_application_key_and_allows_absent_or_false_debug_only(self):
        data = self.mac_profile()
        mac_validation.profile(data)
        for key in ("get-task-allow", "com.apple.security.get-task-allow"):
            data["Entitlements"][key] = False
            mac_validation.profile(data)
            for value in (True, "false", 0, None, []):
                data["Entitlements"][key] = value
                with self.assertRaises(ValueError):
                    mac_validation.profile(data)
            del data["Entitlements"][key]

    def test_mac_profile_refuses_wrong_team_bundle_platform_and_ios_only_key(self):
        for key, value in (("TeamIdentifier", ["WRONGTEAM"]), ("Platform", ["iOS"]), ("UUID", "not-a-uuid"),
                           ("Entitlements", {"com.apple.application-identifier": "384ZGKG4GB.wrong"}),
                           ("Entitlements", {"application-identifier": f"{mac_validation.TEAM}.{mac_validation.BUNDLE}"})):
            data = self.mac_profile()
            data[key] = value
            with self.assertRaises(ValueError):
                mac_validation.profile(data)

    def test_final_signed_entitlements_refuse_debug_or_wrong_team(self):
        data = self.mac_profile()["Entitlements"]
        data["com.apple.developer.team-identifier"] = mac_validation.TEAM
        mac_validation.signed_entitlements(data)
        for key, value in (("com.apple.developer.team-identifier", "WRONGTEAM"),
                           ("com.apple.application-identifier", "384ZGKG4GB.wrong"),
                           ("com.apple.security.get-task-allow", True), ("get-task-allow", "false")):
            broken = copy.deepcopy(data)
            broken[key] = value
            with self.assertRaises(ValueError):
                mac_validation.signed_entitlements(broken)

    def test_exported_package_checks_actual_payload_before_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "export").mkdir()
            (root / "export/app.pkg").write_bytes(b"fixture")
            entitlements = self.mac_profile()["Entitlements"]
            entitlements["com.apple.developer.team-identifier"] = mac_validation.TEAM
            calls = []

            def run(argv):
                calls.append(argv)
                if "--check-signature" in argv:
                    return b"  1. 3rd Party Mac Developer Installer: Fixture (384ZGKG4GB)\n"
                if "--expand-full" in argv:
                    app = Path(argv[-1]) / "component.pkg/Payload/Vogel.app/Contents"
                    app.mkdir(parents=True)
                    (app / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": mac_validation.BUNDLE}))
                if "--entitlements" in argv:
                    return plistlib.dumps(entitlements)
                return b""

            with patch.object(mac_validation, "checked", side_effect=run):
                mac_validation.package(root / "export", root)
            self.assertTrue(any("--verify" in argv and "--strict" in argv for argv in calls))
            self.assertTrue(any("--entitlements" in argv for argv in calls))
        deploy = DEPLOY.read_text()
        self.assertLess(deploy.index("validate_macos_release.py package"), deploy.index("- name: Upload to TestFlight"))
        self.assertIn('python3 .github/workflows/scripts/validate_macos_release.py profile "$DECODED_PROFILE"', deploy)
        # The previously successful iOS validation remains explicit and strict.
        self.assertIn('Print :Entitlements:application-identifier', deploy)
        self.assertIn('[ "$PROFILE_DEBUG" != "false" ]', deploy)

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

    def test_apple_workflows_use_only_the_pinned_xcodegen_path(self) -> None:
        deploy = DEPLOY.read_text(encoding="utf-8")
        swift = SWIFT.read_text(encoding="utf-8")
        generator = (
            ROOT / "scripts" / "regenerate-xcode-project.sh"
        ).read_text(encoding="utf-8")

        for workflow in (deploy, swift):
            self.assertNotIn("brew install xcodegen", workflow)
            self.assertNotIn("xcodegen generate --spec project.yml", workflow)
        self.assertIn(
            "node .github/workflows/scripts/release_check_gate.mjs",
            deploy,
        )
        self.assertIn("scripts/regenerate-xcode-project.sh --check", swift)
        self.assertIn('XCODEGEN_VERSION="2.46.0"', generator)
        self.assertIn('readonly XCODEGEN_SHA256="', generator)

    def test_persistent_runner_cleanup_is_run_scoped_and_restorative(self) -> None:
        deploy = DEPLOY.read_text(encoding="utf-8")

        for fragment in (
            "vogel-vault-signing-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${PLATFORM}",
            "vogel-vault-release-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${PLATFORM}",
            'security list-keychains -d user > "$ORIGINAL_KEYCHAINS_FILE"',
            'security list-keychains -d user -s "${original_keychains[@]}"',
            'security delete-keychain "$KEYCHAIN_PATH"',
            "CREATED_PROFILE=false",
            "recover_stale_apple_release_artifacts.sh",
            ".vogel-vault-release-owner",
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
        self.assertLess(
            deploy.index("recover_stale_apple_release_artifacts.sh"),
            deploy.index(
                'security list-keychains -d user > "$ORIGINAL_KEYCHAINS_FILE"'
            ),
        )

        recovery = (
            ROOT
            / ".github/workflows/scripts/recover_stale_apple_release_artifacts.sh"
        ).read_text(encoding="utf-8")
        self.assertIn(
            'security list-keychains -d user -s "${filtered_keychains[@]}"',
            recovery,
        )
        self.assertIn('if ! is_owned_directory "$signing_root"', recovery)
        self.assertIn('"$target" -ef "$stage"', recovery)
        self.assertNotIn('rm -rf "$HOME', recovery)

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
