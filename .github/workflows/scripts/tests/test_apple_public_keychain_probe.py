"""Exercise public probe failure/rollback using fake security, never a keychain."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "public_probe", Path(__file__).resolve().parents[1] / "apple_public_keychain_probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class FakeSecurity:
    def __init__(self, user=()):
        self.user = list(user)
        self.dynamic = ["/public/original-dynamic.keychain"]
        self.fail_verify = False
        self.fail_restore = False
        self.implicit_pass = True
        self.operations = []
        self.created_keychains = []

    def __call__(self, args):
        command = args[0]
        self.operations.append(command)
        stdout, stderr, code = "", "", 0
        if command == "list-keychains":
            if "-s" in args:
                values = args[args.index("-s") + 1:]
                if self.fail_restore and not any("public-only" in p for p in values):
                    return subprocess.CompletedProcess([], 1, "", "")
                self.user = values
            else:
                values = self.user if args[-1] == "user" else self.dynamic
                stdout = "\n".join('"' + p + '"' for p in values)
        elif command == "default-keychain":
            code, stderr = 1, "A default keychain could not be found."
        elif command == "create-keychain":
            Path(args[-1]).write_bytes(b"kych\x00\x01\x00\x00public fixture")
            self.created_keychains.append(args[-1])
        elif command == "find-certificate":
            explicit = args[-1].endswith("public-only.keychain-db")
            visible = explicit or any("public-only" in p for p in self.user)
            if visible:
                stdout = "SHA-256 hash: " + probe.G3.upper()
        elif command == "verify-cert":
            if self.fail_verify:
                self.fail_verify = False
                raise probe.ProbeError("fixture-interrupted")
            code = 0 if "-k" in args or self.implicit_pass else 1
            stderr = "" if code == 0 else "Cert Verify Result: No error."
        elif command == "delete-keychain":
            Path(args[-1]).unlink()
        return subprocess.CompletedProcess([], code, stdout, stderr)


class PublicKeychainProbeTests(unittest.TestCase):
    def execute(self, fake):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "owned-public-fixture"
            temp = Path(directory) / "runner-temp/owned-public-fixture"
            temp.parent.mkdir()
            result = probe.probe(root, temp, {}, fake)
            return result, root.exists()

    def test_exact_order_empty_and_nonempty_search_lists_restored(self):
        for original in ([], ["/public/b.keychain", "/public/a keychain"]):
            with self.subTest(original=original):
                fake = FakeSecurity(original)
                result, remains = self.execute(fake)
                self.assertTrue(result["test_completed"])
                self.assertEqual(fake.user, original)
                self.assertTrue(result["cleanup"]["default_unchanged"])
                self.assertTrue(result["cleanup"]["dynamic_unchanged"])
                self.assertFalse(remains)
                self.assertNotIn("set-key-partition-list", fake.operations)

    def test_implicit_failure_explicit_success_retained_as_diagnostic(self):
        fake = FakeSecurity()
        fake.implicit_pass = False
        result, remains = self.execute(fake)
        self.assertTrue(result["test_completed"])
        self.assertFalse(result["checks"]["ios_implicit"]["passed"])
        self.assertTrue(result["checks"]["ios_explicit"]["passed"])
        self.assertEqual(result["checks"]["ios_implicit"]["exit_code"], 1)
        self.assertFalse(remains)

    def test_interruption_after_prepend_restores_prior_state(self):
        original = ["/public/original.keychain"]
        fake = FakeSecurity(original)
        fake.fail_verify = True
        result, remains = self.execute(fake)
        self.assertFalse(result["test_completed"])
        self.assertEqual(result["failed_step"], "fixture-interrupted")
        self.assertEqual(fake.user, original)
        self.assertTrue(result["cleanup"]["search_list_restored"])
        self.assertFalse(remains)

    def test_failed_restore_retains_state_for_always_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "owned-public-fixture"
            temp = Path(directory) / "runner-temp/owned-public-fixture"
            temp.parent.mkdir()
            fake = FakeSecurity(["/public/original.keychain"])
            fake.fail_restore = True
            result = probe.probe(root, temp, {}, fake)
            self.assertTrue(result["cleanup"]["failed"])
            self.assertTrue((root / "original-state.json").is_file())
            fake.fail_restore = False
            self.assertTrue(probe.cleanup(root, fake)["search_list_restored"])
            self.assertFalse(root.exists())

    def test_runner_temp_wipe_cannot_erase_failed_rollback_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "recovery/owned-public-fixture"
            root.parent.mkdir()
            temp = Path(directory) / "runner-temp/owned-public-fixture"
            temp.parent.mkdir()
            original = ["/public/original.keychain"]
            fake = FakeSecurity(original)
            fake.fail_restore = True
            result = probe.probe(root, temp, {}, fake)
            self.assertTrue(result["cleanup"]["failed"])
            import shutil
            shutil.rmtree(temp.parent)  # Model the GitHub runner end-of-job wipe.
            self.assertTrue((root / "original-state.json").is_file())
            fake.fail_restore = False
            self.assertTrue(probe.cleanup(root, fake)["search_list_restored"])
            self.assertEqual(fake.user, original)
            self.assertFalse(root.exists())

    def test_unowned_and_symlink_roots_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "unowned"
            root.mkdir()
            with self.assertRaises(probe.ProbeError):
                probe.cleanup(root, FakeSecurity())
            link = Path(directory) / "link"
            link.symlink_to(root)
            with self.assertRaises(probe.ProbeError):
                probe.cleanup(link, FakeSecurity())
            self.assertTrue(root.is_dir())

    def test_unsupported_policy_exit_zero_is_not_success(self):
        def fake(args):
            return subprocess.CompletedProcess([], 0, "...certificate verification successful.",
                                               "*** policy creation failed for fixture")
        result = probe.verify_leaf(fake, "ios48-cert0", "codeSign")
        self.assertFalse(result["passed"])
        self.assertFalse(result["policy_valid"])

    def test_stdout_policy_failure_is_not_a_false_pass(self):
        result = probe.verify_leaf(lambda args: subprocess.CompletedProcess(
            [], 0, "*** policy creation failed", ""), "ios48-cert0", "codeSign")
        self.assertFalse(result["passed"])
        self.assertIn("unsupported-policy", result["stderr_classes"])

    def test_public_error_from_stdout_is_retained_and_bounded(self):
        message = "Cert Verify Result: unable to build chain\n" + "x" * 5000
        result = probe.verify_leaf(lambda args: subprocess.CompletedProcess(
            [], 1, message, ""), "ios48-cert0", "codeSign")
        self.assertFalse(result["passed"])
        self.assertIn("missing-chain", result["stderr_classes"])
        self.assertEqual(len(result["public_validation_message"]), 4096)

    def test_certificate_mode_only_verifies_owned_public_copies(self):
        calls = []
        def verify(args):
            calls.append(args)
            for index, value in enumerate(args):
                if value == "-c":
                    path = Path(args[index + 1])
                    self.assertTrue(path.exists())
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            return subprocess.CompletedProcess([], 1 if args.count("-c") == 1 else 0,
                                               "public validation result", "")
        result = probe.certificate_probe({name: b"public" for name in probe.EXPECTED}, verify)
        self.assertEqual(len(calls), 4)
        self.assertEqual({args[0] for args in calls}, {"verify-cert"})
        self.assertTrue(all("-L" in args and "-k" not in args for args in calls))
        self.assertFalse(result["checks"]["installer_leaf"]["passed"])
        self.assertTrue(result["checks"]["installer_supplied_g3"]["passed"])
        self.assertFalse(result["security_state_changes"])
        self.assertTrue(result["owned_public_copies_removed"])
        self.assertTrue(all(not Path(args[i + 1]).exists() for args in calls
                            for i, value in enumerate(args) if value == "-c"))

    def test_locations_restore_after_each_owned_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "recovery/fixture"
            temp, standard = base / "runner-temp", base / "Library/Keychains"
            for parent in (root.parent, temp, standard):
                parent.mkdir(parents=True)
            original = ["/public/b.keychain", "/public/a keychain"]
            fake = FakeSecurity(original)
            result = probe.location_probe(root, temp, standard, {}, fake)
            self.assertTrue(result["test_completed"])
            self.assertEqual(list(result["locations"]), ["runner-temp", "standard"])
            self.assertEqual(fake.user, original)
            self.assertEqual(len(fake.created_keychains), 2)
            self.assertTrue(fake.created_keychains[0].startswith(str(temp) + "/"))
            self.assertTrue(fake.created_keychains[1].startswith(str(standard) + "/"))
            self.assertFalse(result["locations"]["runner-temp"]["apple_standard_path_rule_matches"])
            self.assertTrue(result["locations"]["standard"]["apple_standard_path_rule_matches"])
            self.assertEqual(result["locations"]["standard"]["keychain_header_prefix_hex"],
                             b"kych\x00\x01\x00\x00".hex())
            self.assertGreater(result["locations"]["standard"]["keychain_file_size_bytes"], 8)
            self.assertEqual(result["before_state_sha256"], result["final_state_sha256"])
            self.assertTrue(all(phase["cleanup"]["search_list_restored"]
                                for phase in result["locations"].values()))
            self.assertFalse(list(root.parent.iterdir()))
            self.assertFalse(list(temp.iterdir()))
            self.assertFalse(list(standard.iterdir()))

    def test_locations_stop_before_second_phase_when_restore_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "recovery/fixture"
            temp, standard = base / "runner-temp", base / "Library/Keychains"
            for parent in (root.parent, temp, standard):
                parent.mkdir(parents=True)
            fake = FakeSecurity(["/public/original.keychain"])
            fake.fail_restore = True
            result = probe.location_probe(root, temp, standard, {}, fake)
            self.assertFalse(result["test_completed"])
            self.assertEqual(list(result["locations"]), ["runner-temp"])
            self.assertEqual(len(fake.created_keychains), 1)
            self.assertFalse(list(standard.iterdir()))
            fake.fail_restore = False
            for _, owned, _ in probe.location_paths(root, temp, standard):
                probe.cleanup(owned, fake)
            self.assertEqual(fake.user, ["/public/original.keychain"])

    def test_locations_preserve_preexisting_or_symlink_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "recovery/fixture"
            temp, standard = base / "runner-temp", base / "Library/Keychains"
            for parent in (root.parent, temp, standard):
                parent.mkdir(parents=True)
            existing = standard / "fixture-standard"
            existing.mkdir()
            fake = FakeSecurity()
            with self.assertRaises(probe.ProbeError):
                probe.location_probe(root, temp, standard, {}, fake)
            self.assertFalse(fake.operations)
            self.assertTrue(existing.exists())
            existing.rmdir()
            existing.symlink_to(temp, target_is_directory=True)
            with self.assertRaises(probe.ProbeError):
                probe.location_probe(root, temp, standard, {}, fake)
            self.assertTrue(existing.is_symlink())


if __name__ == "__main__":
    unittest.main()
