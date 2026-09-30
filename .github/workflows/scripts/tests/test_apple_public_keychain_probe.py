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
            Path(args[-1]).touch()
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


if __name__ == "__main__":
    unittest.main()
