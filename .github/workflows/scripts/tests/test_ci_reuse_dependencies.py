#!/usr/bin/env python3
"""Offline Gradle collector checks. Pass --gradle /path/to/installed/gradle."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class DependencyProofTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="budget-dependency-proof-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "settings.gradle").write_text("rootProject.name = 'proof-fixture'\n")
        (self.root / "build.gradle").write_text(
            "repositories { maven { url = uri('repo') } }\n"
            "configurations { proof }\n"
            "dependencies { proof 'example:fixture:1.0' }\n")
        module = self.root / "repo/example/fixture/1.0"
        module.mkdir(parents=True)
        self.artifact = module / "fixture-1.0.jar"
        self.artifact.write_bytes(b"original dependency bytes")
        (module / "fixture-1.0.pom").write_text(
            "<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId>"
            "<artifactId>fixture</artifactId><version>1.0</version></project>")
        plugins = self.root / "gradle-home/caches/modules-2/files-2.1"
        plugins.mkdir(parents=True)
        (plugins / "plugin.jar").write_bytes(b"plugin bytes")
        sdk = self.root / "sdk/platforms/fixture"
        sdk.mkdir(parents=True)
        (sdk / "source.properties").write_text("Pkg.Revision=1\n")

    def collect(self, *, sdk=True):
        environment = {**os.environ, "GRADLE_USER_HOME": str(self.root / "gradle-home"),
                       "ANDROID_HOME": str(self.root / "sdk") if sdk else "",
                       "ANDROID_SDK_ROOT": "", "RUNNER_TEMP": str(self.root), "JAVA_TOOL_OPTIONS": ""}
        result = subprocess.run(
            [GRADLE, "--offline", "--no-daemon", "--console=plain", "-p", str(self.root), "-I",
             str(Path(__file__).resolve().parents[1] / "ci_reuse_dependencies.gradle"), "ciReuseDependencies"],
            env=environment, capture_output=True, text=True, timeout=90)
        return result

    def test_exact_resolved_bytes_and_plugin_sdk_inputs(self):
        result = self.collect()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        proof = json.loads((self.root / "budget-gradle-context.json").read_text())
        self.assertEqual(proof["artifacts"]["example:fixture:1.0/fixture-1.0.jar"],
                         hashlib.sha256(self.artifact.read_bytes()).hexdigest())
        self.assertEqual(proof["configurations"]["::proof"], ["example:fixture:1.0/fixture-1.0.jar"])
        self.assertTrue(proof["pluginCache"])
        self.assertTrue(proof["sdkPackages"])

    def test_missing_sdk_refuses_to_emit_proof(self):
        result = self.collect(sdk=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "budget-gradle-context.json").exists())

    def test_missing_external_dependency_refuses_to_emit_proof(self):
        self.artifact.unlink()
        result = self.collect()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "budget-gradle-context.json").exists())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gradle", required=True)
    args, remaining = parser.parse_known_args()
    GRADLE = str(Path(args.gradle).resolve())
    unittest.main(argv=[__file__, *remaining])
