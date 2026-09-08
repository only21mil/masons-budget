"""Search-list restoration checks using synthetic paths and an in-memory host."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("visibility_driver", Path(__file__).resolve().parents[1] / "buzz_macos_release_recovery.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class VisibilityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "run"
        self.root.mkdir(mode=0o700)
        self.keychain = self.root / "signing.keychain-db"
        self.keychain.touch()
        self.marker = self.root / "search-list-preimage.json"
        self.before = ['/fixture/A keychain', '/fixture/with"quotes\\backslash', '/fixture/A keychain']
        self.current = list(self.before)
        self.writes = []
        self.output = io.StringIO()
        self.enterContext(contextlib.redirect_stdout(self.output))
        self.enterContext(patch.object(driver, "user_search_list", side_effect=lambda: list(self.current)))
        self.enterContext(patch.object(driver, "security_command", side_effect=self.set_list))
        self.enterContext(patch.object(driver, "paths", return_value=(self.root, self.root / "signed")))

    def set_list(self, words):
        self.assertEqual(words[:4], ["list-keychains", "-d", "user", "-s"])
        self.current = words[4:]
        self.writes.append(list(self.current))
        return b""

    def delete_keychain(self, argv, **kwargs):
        self.assertEqual(argv, ["/usr/bin/security", "delete-keychain", str(self.keychain)])
        self.current = [p for p in self.current if p != str(self.keychain)]
        self.keychain.unlink()
        return b""

    def test_exact_order_duplicates_and_unusual_path_bytes_restore_on_success_and_failure(self):
        for exception in (None, RuntimeError, KeyboardInterrupt):
            with self.subTest(exception=exception):
                try:
                    with driver.visible_signing_keychain(self.keychain):
                        self.assertEqual(self.current, [*self.before, str(self.keychain)])
                        self.assertEqual(json.loads(self.marker.read_text()), driver.search_list_digest(self.before))
                        self.assertEqual(self.marker.stat().st_mode & 0o777, 0o600)
                        self.assertNotIn("/fixture", self.marker.read_text())
                        if exception:
                            raise exception("synthetic failure")
                except (RuntimeError, KeyboardInterrupt):
                    self.assertIsNotNone(exception)
                self.assertEqual(self.current, self.before)
                self.assertTrue(self.marker.exists())
        self.assertNotIn("/fixture", self.output.getvalue())

    def test_empty_list_restored_with_empty_set(self):
        self.current = []
        with driver.visible_signing_keychain(self.keychain):
            self.assertEqual(self.current, [str(self.keychain)])
        self.assertEqual(self.current, [])
        self.assertEqual(self.writes[-1], [])

    def test_insertion_failure_after_mutation_still_restores(self):
        def fail_after_set(words):
            self.set_list(words)
            if str(self.keychain) in self.current:
                raise RuntimeError("synthetic insertion failure")
        with patch.object(driver, "security_command", side_effect=fail_after_set):
            with self.assertRaises(RuntimeError):
                with driver.visible_signing_keychain(self.keychain):
                    self.fail("signing cannot run after insertion failure")
        self.assertEqual(self.current, self.before)
        self.assertTrue(self.marker.exists())

    def test_concurrent_edit_not_overwritten_and_separate_cleanup_fails(self):
        for filename in ("developer-id.p12", "AuthKey.p8", "updater.key"):
            (self.root / filename).write_text("SYNTHETIC-SECRET")
        with self.assertRaises(ValueError):
            with driver.visible_signing_keychain(self.keychain):
                self.current.insert(0, "/fixture/concurrent-keychain")
        self.assertEqual(len(self.writes), 1)
        with patch.object(driver, "run", side_effect=self.delete_keychain):
            with self.assertRaisesRegex(ValueError, "restoration unproven"):
                driver.cleanup("aarch64")
        self.assertEqual(self.current, ["/fixture/concurrent-keychain", *self.before])
        self.assertTrue(self.marker.exists())
        for filename in ("developer-id.p12", "AuthKey.p8", "updater.key"):
            self.assertFalse((self.root / filename).exists())
        self.assertNotIn("/fixture", self.output.getvalue())

    def test_separate_cleanup_recovers_hard_kill_boundaries_by_full_digest(self):
        # Durable state after kill before insertion, after insertion, or after
        # restoration but before marker removal. No in-memory preimage supplied.
        for stage in ("before", "inserted", "restored"):
            with self.subTest(stage=stage):
                self.root.mkdir(mode=0o700, exist_ok=True)
                self.keychain.touch()
                self.marker.write_text(json.dumps(driver.search_list_digest(self.before)))
                self.current = [*self.before, str(self.keychain)] if stage == "inserted" else list(self.before)
                with patch.object(driver, "run", side_effect=self.delete_keychain):
                    driver.cleanup("aarch64")
                self.assertEqual(self.current, self.before)
                self.assertFalse(self.root.exists())

    def test_failed_restoration_is_recoverable_by_cleanup(self):
        def fail_restore(words):
            if str(self.keychain) not in words:
                raise RuntimeError("synthetic restoration failure")
            return self.set_list(words)
        with patch.object(driver, "security_command", side_effect=fail_restore):
            with self.assertRaises(RuntimeError):
                with driver.visible_signing_keychain(self.keychain):
                    pass
        self.assertTrue(self.marker.exists())
        with patch.object(driver, "run", side_effect=self.delete_keychain):
            driver.cleanup("aarch64")
        self.assertEqual(self.current, self.before)
        self.assertFalse(self.root.exists())

    def test_runner_signals_unwind_signing_and_cleanup(self):
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            self.addCleanup(signal.signal, sig, signal.getsignal(sig))
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            with self.subTest(signal=sig):
                self.root.mkdir(mode=0o700, exist_ok=True)
                self.keychain.touch()
                def sign(_args):
                    with driver.visible_signing_keychain(self.keychain):
                        os.kill(os.getpid(), sig)
                        self.fail("signing must stop on cancellation")
                with patch.object(driver, "sign", side_effect=sign), patch.object(driver, "run", side_effect=self.delete_keychain), patch.object(sys, "argv", ["driver", "sign", "--arch", "aarch64"]), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(driver.main(), 1)
                self.assertEqual(self.current, self.before)
                self.assertFalse(self.root.exists())

    def test_cleanup_rejects_reordered_or_lost_unrelated_entries(self):
        for changed in (list(reversed(self.before[:2])), self.before[:2], self.before[1:]):
            with self.subTest(changed=changed):
                self.keychain.touch()
                self.marker.write_text(json.dumps(driver.search_list_digest(self.before)))
                self.current = [*changed, str(self.keychain)]
                with patch.object(driver, "run", side_effect=self.delete_keychain):
                    with self.assertRaisesRegex(ValueError, "restoration unproven"):
                        driver.cleanup("aarch64")
                self.assertEqual(self.current, changed)
                self.assertTrue(self.marker.exists())

    def test_marker_corruption_cannot_report_cleanup_success(self):
        self.marker.write_text("{partial")
        with patch.object(driver, "run", side_effect=self.delete_keychain):
            with self.assertRaisesRegex(ValueError, "restoration unproven"):
                driver.cleanup("aarch64")
        self.assertTrue(self.marker.exists())

    def test_repeated_cancellation_is_deferred_until_restore_finishes(self):
        previous = signal.getsignal(signal.SIGTERM)
        with self.assertRaisesRegex(ValueError, "interrupted during cleanup"):
            with driver.finish_cleanup():
                os.kill(os.getpid(), signal.SIGTERM)
                os.kill(os.getpid(), signal.SIGTERM)
                self.current = ["cleanup completed"]
        self.assertEqual(self.current, ["cleanup completed"])
        self.assertEqual(signal.getsignal(signal.SIGTERM), previous)

    def test_preexisting_membership_or_unresolved_marker_refuses_mutation(self):
        self.current.append(str(self.keychain))
        with self.assertRaises(ValueError):
            with driver.visible_signing_keychain(self.keychain):
                self.fail("must refuse preexisting membership")
        self.current = list(self.before)
        self.marker.write_text("{}")
        with self.assertRaises(ValueError):
            with driver.visible_signing_keychain(self.keychain):
                self.fail("must refuse unresolved marker")
        self.assertEqual(self.writes, [])

    def test_drift_between_app_and_dmg_windows_refuses_second_insertion(self):
        with driver.visible_signing_keychain(self.keychain):
            pass
        self.current.append("/fixture/concurrent-between-windows")
        prior_writes = len(self.writes)
        with self.assertRaisesRegex(ValueError, "restoration unproven"):
            with driver.visible_signing_keychain(self.keychain):
                self.fail("second window must not start after drift")
        self.assertEqual(len(self.writes), prior_writes)


class NativeFormatTests(unittest.TestCase):
    def test_parser_preserves_native_literal_paths(self):
        paths = ['/fixture/with space', '/fixture/quote"and\\backslash', '/fixture/with space']
        native = "".join('    "' + p + '"\n' for p in paths).encode()
        with patch.object(driver, "run", return_value=native):
            self.assertEqual(driver.user_search_list(), paths)
        for invalid in (b'"/missing-indent"\n', b'    "relative"\n', b'    "/control\x00"\n', b'x'*65537):
            with patch.object(driver, "run", return_value=invalid):
                with self.assertRaises(ValueError):
                    driver.user_search_list()

    def test_native_warning_cannot_silently_drop_an_unreadable_entry(self):
        result = subprocess.CompletedProcess([], 0, b'    "/fixture/one"\n', b"SYNTHETIC PRIVATE PATH WARNING")
        with patch.object(driver.subprocess, "run", return_value=result), contextlib.redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(ValueError):
                driver.user_search_list()
        self.assertNotIn("SYNTHETIC", output.getvalue())

    def test_search_list_paths_only_enter_confidential_stdin(self):
        with patch.object(driver, "run", return_value=b"") as command:
            driver.security_command(["list-keychains", "-d", "user", "-s", '/fixture/quote"and\\space path'])
        self.assertEqual(command.call_args.args[0], ["/usr/bin/security", "-i"])
        self.assertTrue(command.call_args.kwargs["confidential"])
        self.assertEqual(command.call_args.kwargs["phase"], "keychain-search-list-write")


if __name__ == "__main__":
    unittest.main()
