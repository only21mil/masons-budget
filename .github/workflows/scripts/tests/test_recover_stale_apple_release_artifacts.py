#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "recover_stale_apple_release_artifacts.sh"
)
OWNER_MARKER = ".vogel-vault-release-owner"
OWNER_MAGIC = "vogel-vault-release-state-v1\n"
PROFILE_UUID = "01234567-89AB-CDEF-0123-456789ABCDEF"
PROFILE_EXTENSION = "mobileprovision"


class RecoverStaleAppleReleaseArtifactsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.runner_temp = self.root / "runner-temp"
        self.profile_dir = self.root / "Provisioning Profiles"
        self.fake_bin = self.root / "bin"
        self.search_list_file = self.root / "search-list"
        self.runner_temp.mkdir()
        self.profile_dir.mkdir()
        self.fake_bin.mkdir()
        fake_security = self.fake_bin / "security"
        fake_security.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import os
                import sys
                from pathlib import Path

                state = Path(os.environ["FAKE_SECURITY_SEARCH_LIST"])
                args = sys.argv[1:]
                if args == ["list-keychains", "-d", "user"]:
                    if state.exists():
                        for item in state.read_text(encoding="utf-8").splitlines():
                            print(f'    "{item}"')
                elif args[:4] == ["list-keychains", "-d", "user", "-s"]:
                    state.write_text(
                        "\\n".join(args[4:]) + ("\\n" if args[4:] else ""),
                        encoding="utf-8",
                    )
                elif len(args) == 2 and args[0] == "delete-keychain":
                    Path(args[1]).unlink(missing_ok=True)
                else:
                    print(f"unexpected security invocation: {args}", file=sys.stderr)
                    raise SystemExit(2)
                """
            ),
            encoding="utf-8",
        )
        fake_security.chmod(0o755)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_recovery(self) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.update(
            {
                "RUNNER_TEMP": str(self.runner_temp),
                "PROFILE_DIR": str(self.profile_dir),
                "FAKE_SECURITY_SEARCH_LIST": str(self.search_list_file),
                "PATH": f"{self.fake_bin}{os.pathsep}{environment['PATH']}",
            }
        )
        return subprocess.run(
            ["bash", str(SCRIPT)],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def set_search_list(self, *paths: Path) -> None:
        self.search_list_file.write_text(
            "".join(f"{path}\n" for path in paths),
            encoding="utf-8",
        )

    def search_list(self) -> list[str]:
        if not self.search_list_file.exists():
            return []
        return self.search_list_file.read_text(encoding="utf-8").splitlines()

    def create_owned_run(
        self,
        suffix: str = "123-1-ios",
    ) -> tuple[Path, Path, Path]:
        signing_root = self.runner_temp / f"vogel-vault-signing-{suffix}"
        release_root = self.runner_temp / f"vogel-vault-release-{suffix}"
        signing_root.mkdir()
        release_root.mkdir()
        (signing_root / OWNER_MARKER).write_text(
            OWNER_MAGIC,
            encoding="utf-8",
        )
        (release_root / OWNER_MARKER).write_text(
            OWNER_MAGIC,
            encoding="utf-8",
        )
        keychain = signing_root / "manual-signing.keychain-db"
        keychain.write_bytes(b"run-owned-keychain")
        return signing_root, release_root, keychain

    def write_profile_record(
        self,
        signing_root: Path,
        payload: bytes,
        suffix: str = "123-1-ios",
    ) -> tuple[Path, Path]:
        target = self.profile_dir / f"{PROFILE_UUID}.{PROFILE_EXTENSION}"
        stage = self.profile_dir / f".vogel-vault-profile-{suffix}"
        digest = hashlib.sha256(payload).hexdigest()
        (signing_root / ".vogel-vault-owned-profile").write_text(
            f"{PROFILE_UUID}\t{PROFILE_EXTENSION}\t{digest}\t{stage.name}\n",
            encoding="utf-8",
        )
        return target, stage

    def test_recovers_created_profile_keychain_and_release_root(self) -> None:
        signing_root, release_root, keychain = self.create_owned_run()
        target, _ = self.write_profile_record(signing_root, b"owned-profile")
        target.write_bytes(b"owned-profile")
        (signing_root / ".vogel-vault-profile-created").write_text(
            OWNER_MAGIC,
            encoding="utf-8",
        )
        login_keychain = self.root / "login.keychain-db"
        unrelated_keychain = self.root / "unrelated.keychain-db"
        unrelated_profile = self.profile_dir / "unrelated.mobileprovision"
        unrelated_profile.write_bytes(b"keep-me")
        self.set_search_list(login_keychain, keychain, unrelated_keychain)

        result = self.run_recovery()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(signing_root.exists())
        self.assertFalse(release_root.exists())
        self.assertFalse(target.exists())
        self.assertEqual(unrelated_profile.read_bytes(), b"keep-me")
        self.assertEqual(
            self.search_list(),
            [str(login_keychain), str(unrelated_keychain)],
        )

    def test_recovers_profile_link_interrupted_before_creation_marker(self) -> None:
        signing_root, release_root, keychain = self.create_owned_run()
        target, stage = self.write_profile_record(signing_root, b"owned-profile")
        stage.write_bytes(b"owned-profile")
        os.link(stage, target)
        self.set_search_list(keychain)

        result = self.run_recovery()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(target.exists())
        self.assertFalse(stage.exists())
        self.assertFalse(signing_root.exists())
        self.assertFalse(release_root.exists())
        self.assertEqual(self.search_list(), [])

    def test_preserves_unmarked_lookalikes_and_search_list(self) -> None:
        signing_root = self.runner_temp / "vogel-vault-signing-123-1-ios"
        release_root = self.runner_temp / "vogel-vault-release-123-1-ios"
        signing_root.mkdir()
        release_root.mkdir()
        keychain = signing_root / "manual-signing.keychain-db"
        keychain.write_bytes(b"not-owned")
        self.set_search_list(keychain)

        result = self.run_recovery()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(signing_root.is_dir())
        self.assertTrue(release_root.is_dir())
        self.assertEqual(keychain.read_bytes(), b"not-owned")
        self.assertEqual(self.search_list(), [str(keychain)])

    def test_digest_mismatch_fails_closed_and_preserves_profile(self) -> None:
        signing_root, release_root, keychain = self.create_owned_run()
        target, _ = self.write_profile_record(signing_root, b"expected-profile")
        target.write_bytes(b"host-replaced-profile")
        (signing_root / ".vogel-vault-profile-created").write_text(
            OWNER_MAGIC,
            encoding="utf-8",
        )
        self.set_search_list(keychain)

        result = self.run_recovery()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ownership digest no longer matches", result.stdout)
        self.assertEqual(target.read_bytes(), b"host-replaced-profile")
        self.assertTrue(signing_root.is_dir())
        self.assertTrue(release_root.is_dir())
        self.assertEqual(self.search_list(), [str(keychain)])

    def test_keychain_symlink_fails_closed_before_search_list_mutation(self) -> None:
        signing_root, release_root, keychain = self.create_owned_run()
        keychain.unlink()
        unrelated_keychain = self.root / "unrelated.keychain-db"
        unrelated_keychain.write_bytes(b"host-keychain")
        keychain.symlink_to(unrelated_keychain)
        self.set_search_list(keychain, unrelated_keychain)

        result = self.run_recovery()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsafe run-owned keychain path", result.stdout)
        self.assertTrue(keychain.is_symlink())
        self.assertEqual(unrelated_keychain.read_bytes(), b"host-keychain")
        self.assertTrue(signing_root.is_dir())
        self.assertTrue(release_root.is_dir())
        self.assertEqual(
            self.search_list(),
            [str(keychain), str(unrelated_keychain)],
        )

    def test_recovers_an_owned_orphan_release_root(self) -> None:
        release_root = self.runner_temp / "vogel-vault-release-123-1-macos"
        release_root.mkdir()
        (release_root / OWNER_MARKER).write_text(OWNER_MAGIC, encoding="utf-8")
        (release_root / "partial.pkg").write_bytes(b"partial-release")

        result = self.run_recovery()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(release_root.exists())


if __name__ == "__main__":
    unittest.main()
