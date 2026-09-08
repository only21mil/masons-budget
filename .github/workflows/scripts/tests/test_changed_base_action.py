#!/usr/bin/env python3
"""Behavioural tests for the shared changed-base composite action.

Buzz issue bbb8ed64db7407247318597e8613ca2e989404fafd1f1438c554bd78610d6020
(GitHub mirror only21mil/buzz#190): every Clients CI pull request run fetched
its base ref through a checkout made with persist-credentials: false, failed
with "could not read Username for 'https://github.com'", and verified every
tree even though the full-history checkout had already fetched the base
branch. These tests run the action's shell body against real git fixtures.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import yaml

ACTION = Path(__file__).resolve().parents[3] / "actions" / "changed-base" / "action.yml"
REAL_GIT = shutil.which("git")
FETCH_ATTEMPTS = 3


def action_script():
    step = yaml.safe_load(ACTION.read_text())["runs"]["steps"][0]
    return step["run"], sorted(step["env"])


class Fixture:
    """A bare upstream with main and a feature branch, plus a CI-style checkout."""

    def __init__(self, root, *, depth=None):
        self.root = Path(root)
        self.upstream = self.root / "upstream.git"
        self.author = self.root / "author"
        self.checkout = self.root / "checkout"
        self.shims = self.root / "shims"
        self.fetch_log = self.root / "fetches.log"
        self.sleep_log = self.root / "sleeps.log"
        self.fail_fetches = self.root / "fail-fetches"
        self.git(["init", "-q", "--bare", str(self.upstream)], cwd=self.root)
        self.git(["clone", "-q", str(self.upstream), str(self.author)], cwd=self.root)
        self.commit("shared/domain/a.ts", "one", "main one")
        self.git(["branch", "-M", "main"], cwd=self.author)
        self.commit("docs/readme.md", "two", "main two")
        self.git(["push", "-q", "origin", "main"], cwd=self.author)
        self.main_tip = self.rev("main", cwd=self.author)
        self.git(["checkout", "-q", "-b", "feature"], cwd=self.author)
        self.commit("linux/src/b.ts", "feature", "feature change")
        self.git(["push", "-q", "origin", "feature"], cwd=self.author)
        self.feature_tip = self.rev("feature", cwd=self.author)
        clone = ["clone", "-q"]
        if depth:
            clone += ["--depth", str(depth), "--branch", "feature", "--no-single-branch"]
        self.git([*clone, f"file://{self.upstream}", str(self.checkout)], cwd=self.root)
        if depth:
            self.head = self.rev("HEAD", cwd=self.checkout)
        else:
            # Pull request runs check out refs/pull/N/merge: the base tip with
            # the candidate merged on top.
            self.git(["checkout", "-q", "--detach", "origin/main"], cwd=self.checkout)
            self.git(["-c", "user.name=t", "-c", "user.email=t@example.com", "merge", "-q", "--no-ff",
                      "-m", "merge candidate", "origin/feature"], cwd=self.checkout)
            self.head = self.rev("HEAD", cwd=self.checkout)
        self.write_shims()

    def git(self, args, *, cwd, check=True):
        return subprocess.run([REAL_GIT, *args], cwd=cwd, check=check, capture_output=True, text=True)

    def rev(self, ref, *, cwd):
        return self.git(["rev-parse", ref], cwd=cwd).stdout.strip()

    def commit(self, path, content, message):
        target = self.author / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        self.git(["add", path], cwd=self.author)
        self.git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", message], cwd=self.author)

    def write_shims(self):
        """Count fetches and sleeps; optionally fail the first N fetches."""
        self.shims.mkdir()
        git = self.shims / "git"
        git.write_text(
            "#!/bin/bash\n"
            "if [ \"$1\" = fetch ]; then\n"
            f"  printf '%s\\n' \"$*\" >> '{self.fetch_log}'\n"
            f"  if [ -f '{self.fail_fetches}' ] && [ \"$(wc -l < '{self.fetch_log}')\" -le \"$(cat '{self.fail_fetches}')\" ]; then\n"
            "    echo 'fatal: simulated transient fetch failure' >&2\n"
            "    exit 128\n"
            "  fi\n"
            "fi\n"
            f"exec '{REAL_GIT}' \"$@\"\n")
        git.chmod(0o755)
        sleep = self.shims / "sleep"
        sleep.write_text(f"#!/bin/bash\nprintf '%s\\n' \"$1\" >> '{self.sleep_log}'\n")
        sleep.chmod(0o755)

    def break_origin(self):
        self.git(["remote", "set-url", "origin", str(self.root / "missing.git")], cwd=self.checkout)

    def drop_local_base(self):
        self.git(["update-ref", "-d", "refs/remotes/origin/main"], cwd=self.checkout)

    def fetches(self):
        return self.fetch_log.read_text().splitlines() if self.fetch_log.exists() else []

    def sleeps(self):
        return self.sleep_log.read_text().splitlines() if self.sleep_log.exists() else []

    def run(self, **inputs):
        script, names = action_script()
        env = {name: "" for name in names}
        env.update({"EVENT_NAME": "pull_request", "EVENT_REF": "refs/pull/1/merge", "HEAD_SHA": self.head,
                    "PUSH_FORCED": "false", "MAIN_PUSH_POLICY": "use-range"})
        env.update(inputs)
        self.assertEnv(env, names)
        temp = self.root / "runner-temp"
        temp.mkdir(exist_ok=True)
        output = self.root / "github-output"
        output.write_text("")
        env.update({"RUNNER_TEMP": str(temp), "GITHUB_OUTPUT": str(output), "HOME": str(self.root),
                    "PATH": f"{self.shims}:{os.environ['PATH']}"})
        result = subprocess.run(["bash", "-c", script], cwd=self.checkout, env=env, capture_output=True, text=True)
        outputs = {}
        for line in output.read_text().splitlines():
            key, _, value = line.partition("=")
            outputs[key] = value
        notices = [line for line in result.stdout.splitlines() if line.startswith("::")]
        return result, outputs, notices

    @staticmethod
    def assertEnv(env, names):
        assert sorted(env) == names, (sorted(env), names)


class ChangedBaseActionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def fixture(self, **kwargs):
        return Fixture(self.directory.name, **kwargs)

    def assert_range(self, fixture, result, outputs):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs["verify-all"], "false", (outputs, result.stdout, result.stderr))
        self.assertEqual(outputs["base"], fixture.main_tip)
        self.assertEqual(outputs["head"], fixture.head)
        self.assertEqual(Path(outputs["changed-files"]).read_text().split(), ["linux/src/b.ts"])

    def assert_verify_all(self, result, outputs):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs, {"verify-all": "true", "base": "", "head": "", "changed-files": ""}, result.stdout)

    def test_base_ref_present_in_checkout_needs_no_fetch(self):
        # The run 34251050185 shape: full-history checkout, credentials not
        # persisted, so any fetch fails; origin/main is already local.
        fixture = self.fixture()
        fixture.break_origin()
        result, outputs, notices = fixture.run(BASE_REF="main")
        self.assert_range(fixture, result, outputs)
        self.assertEqual(fixture.fetches(), [])
        self.assertTrue(any("without a fetch" in line for line in notices), notices)

    def test_missing_base_ref_fetch_retries_with_backoff_then_succeeds(self):
        fixture = self.fixture()
        fixture.drop_local_base()
        fixture.fail_fetches.write_text("2")
        result, outputs, notices = fixture.run(BASE_REF="main")
        self.assert_range(fixture, result, outputs)
        self.assertEqual(len(fixture.fetches()), 3)
        self.assertEqual(fixture.sleeps(), ["2", "4"])
        self.assertTrue(any("attempt 3" in line for line in notices), notices)

    def test_exhausted_base_ref_fetch_verifies_every_tree(self):
        fixture = self.fixture()
        fixture.drop_local_base()
        fixture.break_origin()
        result, outputs, notices = fixture.run(BASE_REF="main")
        self.assert_verify_all(result, outputs)
        self.assertEqual(len(fixture.fetches()), FETCH_ATTEMPTS)
        self.assertEqual(fixture.sleeps(), ["2", "4"])
        self.assertTrue(any(f"after {FETCH_ATTEMPTS} fetch attempts" in line for line in notices), notices)

    def test_base_sha_present_in_checkout_needs_no_fetch(self):
        fixture = self.fixture()
        fixture.break_origin()
        result, outputs, _ = fixture.run(BASE_SHA=fixture.main_tip, BASE_REF="main")
        self.assert_range(fixture, result, outputs)
        self.assertEqual(fixture.fetches(), [])

    def test_base_sha_absent_from_checkout_falls_back_to_base_ref(self):
        fixture = self.fixture()
        fixture.break_origin()
        result, outputs, _ = fixture.run(BASE_SHA="1" * 40, BASE_REF="main")
        self.assert_range(fixture, result, outputs)
        self.assertEqual(fixture.fetches(), [])

    def test_missing_and_malformed_bases_verify_every_tree(self):
        fixture = self.fixture()
        for inputs in ({}, {"BASE_SHA": "deadbeef"}, {"BASE_SHA": "0" * 40}, {"BASE_SHA": "1" * 40}):
            with self.subTest(inputs=inputs):
                result, outputs, _ = fixture.run(**inputs)
                self.assert_verify_all(result, outputs)
        self.assertEqual(fixture.fetches(), [])

    def test_shallow_checkout_without_shared_history_verifies_every_tree(self):
        fixture = self.fixture(depth=1)
        result, outputs, _ = fixture.run(BASE_SHA=fixture.main_tip, BASE_REF="main")
        self.assert_verify_all(result, outputs)
        self.assertEqual(fixture.fetches(), [])

    def test_shallow_checkout_with_unrelated_fetched_base_verifies_every_tree(self):
        fixture = self.fixture(depth=1)
        fixture.drop_local_base()
        result, outputs, _ = fixture.run(BASE_REF="main")
        self.assert_verify_all(result, outputs)
        self.assertEqual(len(fixture.fetches()), 1)


if __name__ == "__main__":
    unittest.main()
