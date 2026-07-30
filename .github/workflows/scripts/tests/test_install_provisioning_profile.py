#!/usr/bin/env python3

from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "install_provisioning_profile.sh"
PROFILE_UUID = "01234567-89AB-CDEF-0123-456789ABCDEF"
PROFILE_EXTENSION = "mobileprovision"


class InstallProvisioningProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.profile_dir = self.root / "Provisioning Profiles"
        self.encoded = self.root / "input.mobileprovision"
        self.github_env = self.root / "github-env"
        self.encoded.write_bytes(b"profile-one")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @property
    def installed(self) -> Path:
        return self.profile_dir / f"{PROFILE_UUID}.{PROFILE_EXTENSION}"

    def run_installer(self) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.update(
            {
                "ENCODED_PROFILE": str(self.encoded),
                "PROFILE_DIR": str(self.profile_dir),
                "PROFILE_UUID": PROFILE_UUID,
                "PROFILE_EXTENSION": PROFILE_EXTENSION,
                "GITHUB_ENV": str(self.github_env),
            }
        )
        return subprocess.run(
            ["bash", str(SCRIPT)],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def env_lines(self) -> set[str]:
        if not self.github_env.exists():
            return set()
        return set(self.github_env.read_text(encoding="utf-8").splitlines())

    def test_creates_and_marks_a_new_profile(self) -> None:
        result = self.run_installer()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installed.read_bytes(), b"profile-one")
        self.assertEqual(stat.S_IMODE(self.installed.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.profile_dir.stat().st_mode), 0o700)
        self.assertIn(f"INSTALLED_PROFILE_PATH={self.installed}", self.env_lines())
        self.assertIn("CREATED_PROFILE=true", self.env_lines())

    def test_reuses_an_identical_profile_without_changing_it(self) -> None:
        self.profile_dir.mkdir(parents=True)
        self.profile_dir.chmod(0o710)
        self.installed.write_bytes(b"profile-one")
        self.installed.chmod(0o640)
        parent_before = self.profile_dir.stat()
        before = self.installed.stat()

        result = self.run_installer()

        parent_after = self.profile_dir.stat()
        after = self.installed.stat()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(parent_after.st_ino, parent_before.st_ino)
        self.assertEqual(stat.S_IMODE(parent_after.st_mode), 0o710)
        self.assertEqual(self.installed.read_bytes(), b"profile-one")
        self.assertEqual(after.st_ino, before.st_ino)
        self.assertEqual(stat.S_IMODE(after.st_mode), 0o640)
        self.assertIn("CREATED_PROFILE=false", self.env_lines())

    def test_refuses_to_replace_a_different_profile(self) -> None:
        self.profile_dir.mkdir(parents=True)
        self.installed.write_bytes(b"pre-existing-profile")

        result = self.run_installer()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refusing to replace a different profile", result.stderr)
        self.assertEqual(self.installed.read_bytes(), b"pre-existing-profile")
        self.assertEqual(self.env_lines(), set())

    def test_refuses_a_symlink_profile_directory(self) -> None:
        actual_directory = self.root / "host-owned-profiles"
        actual_directory.mkdir()
        self.profile_dir.symlink_to(actual_directory, target_is_directory=True)

        result = self.run_installer()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a real directory", result.stderr)
        self.assertEqual(list(actual_directory.iterdir()), [])

    def test_refuses_a_regular_file_as_the_profile_directory(self) -> None:
        self.profile_dir.write_bytes(b"host-owned-file")

        result = self.run_installer()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be a real directory", result.stderr)
        self.assertEqual(self.profile_dir.read_bytes(), b"host-owned-file")
        self.assertEqual(self.env_lines(), set())


if __name__ == "__main__":
    unittest.main()
