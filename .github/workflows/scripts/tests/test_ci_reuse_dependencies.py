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
import zipfile


class DependencyProofTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="budget-dependency-proof-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "settings.gradle").write_text("rootProject.name = 'proof-fixture'\ninclude 'app', 'domain'\n")
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
        self.lint_engine = self.add_module("lint-engine", dependencies=["lint-core"])
        self.lint_core = self.add_module("lint-core")
        self.lazy_tool = self.add_module("lazy-tool")
        # Model AGP's lazy detached lint classpath without fetching/building AGP.
        # The real project's AGP tasks receive a separate integration check.
        for project in ["app", "domain"]:
            (self.root / project).mkdir()
        (self.root / "app/build.gradle").write_text("""
repositories { maven { url = rootProject.uri('repo') } }
tasks.register('lintReportDebug') {
    ext.lintTool = [classpath: configurations.detachedConfiguration(
        dependencies.create('example:lint-engine:1.0'))]
    doLast { throw new GradleException('Protected lint action executed') }
    finalizedBy 'lintFinalizer'
}
tasks.register('lintFinalizer') {
    doLast { throw new GradleException('Protected finalizer executed') }
}
tasks.register('lintDebug') {
    dependsOn 'lintReportDebug'
    doLast { throw new GradleException('Protected lint root executed') }
}
tasks.register('testDebugUnitTest') {
    doLast { throw new GradleException('Protected app test executed') }
}
""")
        (self.root / "domain/build.gradle").write_text("""
repositories { maven { url = rootProject.uri('repo') } }
tasks.register('test') {
    configurations.create('lazyTool')
    dependencies.add('lazyTool', 'example:lazy-tool:1.0')
    doLast { throw new GradleException('Protected domain test executed') }
}
""")

    def add_module(self, name, *, dependencies=()):
        module = self.root / f"repo/example/{name}/1.0"
        module.mkdir(parents=True)
        artifact = module / f"{name}-1.0.jar"
        artifact.write_bytes(f"{name} dependency bytes".encode())
        dependency_xml = "".join(
            f"<dependency><groupId>example</groupId><artifactId>{dependency}</artifactId>"
            "<version>1.0</version></dependency>" for dependency in dependencies)
        (module / f"{name}-1.0.pom").write_text(
            "<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId>"
            f"<artifactId>{name}</artifactId><version>1.0</version>"
            f"<dependencies>{dependency_xml}</dependencies></project>")
        return artifact

    def collect(self, *, sdk=True, tasks=("ciReuseDependencies",)):
        environment = {**os.environ, "GRADLE_USER_HOME": str(self.root / "gradle-home"),
                       "ANDROID_HOME": str(self.root / "sdk") if sdk else "",
                       "ANDROID_SDK_ROOT": "", "RUNNER_TEMP": str(self.root), "JAVA_TOOL_OPTIONS": ""}
        result = subprocess.run(
            [GRADLE, "--offline", "--no-daemon", "--console=plain", "-p", str(self.root), "-I",
             str(Path(__file__).resolve().parents[1] / "ci_reuse_dependencies.gradle"), *tasks],
            env=environment, capture_output=True, text=True, timeout=90)
        return result

    def add_bom_fixture(self, *, kotlin_jvm=True, multiplatform=False,
                        metadata_usage="kotlin-metadata", metadata_platform="common",
                        metadata_name="debugImplementationDependenciesMetadata"):
        # Plugin markers exercise the project guard without fetching Kotlin.
        # Real Kotlin/Android project collection is a separate integration check.
        with zipfile.ZipFile(self.root / "plugin-markers.jar", "w") as markers:
            plugins = (["jvm"] if kotlin_jvm else []) + (["multiplatform"] if multiplatform else [])
            for plugin in plugins:
                markers.writestr(f"META-INF/gradle-plugins/org.jetbrains.kotlin.{plugin}.properties",
                                 "implementation-class=org.gradle.api.plugins.JavaPlugin\n")
        build = self.root / "build.gradle"
        prefix = "buildscript { dependencies { classpath files('plugin-markers.jar') } }\n"
        if kotlin_jvm:
            prefix += "apply plugin: 'org.jetbrains.kotlin.jvm'\n"
        if multiplatform:
            prefix += "apply plugin: 'org.jetbrains.kotlin.multiplatform'\n"
        build.write_text(prefix + build.read_text() + f"""
configurations {{
    implementation {{ canBeResolved = false }}
    debugImplementation {{ canBeResolved = false }}
    debugCompileClasspath {{
        extendsFrom implementation, debugImplementation
        attributes {{
            attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage, Usage.JAVA_API))
            attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category, Category.LIBRARY))
        }}
    }}
    {metadata_name} {{
        extendsFrom debugImplementation
        attributes {{
            attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage, '{metadata_usage}'))
            attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category, Category.LIBRARY))
            attribute(Attribute.of('org.jetbrains.kotlin.platform.type', String), '{metadata_platform}')
        }}
    }}
}}
dependencies {{
    implementation platform('example:bom:1.0')
    debugImplementation 'example:fixture'
}}
""")
        bom = self.root / "repo/example/bom/1.0"
        bom.mkdir(parents=True)
        (bom / "bom-1.0.pom").write_text(
            "<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId>"
            "<artifactId>bom</artifactId><version>1.0</version><packaging>pom</packaging>"
            "<dependencyManagement><dependencies><dependency><groupId>example</groupId>"
            "<artifactId>fixture</artifactId><version>1.0</version></dependency>"
            "</dependencies></dependencyManagement></project>")

    def assert_collection_refused(self):
        result = self.collect()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / "budget-gradle-context.json").exists())
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

    def test_realized_tools_and_detached_lint_bytes_without_task_actions(self):
        result = self.collect()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        proof = json.loads((self.root / "budget-gradle-context.json").read_text())
        self.assertEqual(proof["taskToolClasspaths"][":app:lintReportDebug"], [
            {"name": artifact.name, "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()}
            for artifact in [self.lint_engine, self.lint_core]])
        self.assertEqual(proof["configurations"][":domain:lazyTool"],
                         ["example:lazy-tool:1.0/lazy-tool-1.0.jar"])
        self.assertEqual(proof["artifacts"]["example:lazy-tool:1.0/lazy-tool-1.0.jar"],
                         hashlib.sha256(self.lazy_tool.read_bytes()).hexdigest())
        self.assertIn(":app:lintFinalizer", proof["protectedTasks"])
        for task in proof["protectedTasks"]:
            self.assertIn(f"> Task {task} SKIPPED", result.stdout)

    def test_missing_detached_lint_engine_clears_stale_proof(self):
        (self.root / "budget-gradle-context.json").write_text('{"stale":true}\n')
        self.lint_engine.unlink()
        result = self.assert_collection_refused()
        self.assertIn("lint-engine-1.0.jar", result.stdout + result.stderr)

    def test_missing_transitive_lint_runtime_refuses_proof(self):
        self.lint_core.unlink()
        result = self.assert_collection_refused()
        self.assertIn("lint-core-1.0.jar", result.stdout + result.stderr)

    def test_missing_lazy_task_configuration_bytes_refuses_proof(self):
        self.lazy_tool.unlink()
        result = self.assert_collection_refused()
        self.assertIn("lazy-tool-1.0.jar", result.stdout + result.stderr)

    def test_empty_lint_classpath_refuses_proof(self):
        build = self.root / "app/build.gradle"
        build.write_text(build.read_text().replace(
            "configurations.detachedConfiguration(\n        dependencies.create('example:lint-engine:1.0'))",
            "files()"))
        result = self.assert_collection_refused()
        self.assertIn("Lint tool classpath missing", result.stdout + result.stderr)

    def test_missing_lint_tool_property_refuses_proof(self):
        build = self.root / "app/build.gradle"
        build.write_text(build.read_text().replace("ext.lintTool", "ext.otherTool"))
        result = self.assert_collection_refused()
        self.assertIn("Protected lint tool classpaths missing", result.stdout + result.stderr)

    def test_missing_protected_root_refuses_proof(self):
        build = self.root / "domain/build.gradle"
        build.write_text(build.read_text().replace("tasks.register('test')", "tasks.register('otherTest')"))
        self.assert_collection_refused()

    def test_mixed_collector_invocation_is_rejected(self):
        result = self.collect(tasks=("ciReuseDependencies", ":app:lintDebug"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exclusive ciReuseDependencies", result.stdout + result.stderr)
        self.assertFalse((self.root / "budget-gradle-context.json").exists())

    def test_excluded_protected_root_refuses_proof(self):
        result = self.collect(tasks=("ciReuseDependencies", "-x", ":domain:test"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Protected task graph incomplete", result.stdout + result.stderr)
        self.assertFalse((self.root / "budget-gradle-context.json").exists())

    def test_non_collector_invocation_keeps_actions_enabled(self):
        build = self.root / "build.gradle"
        build.write_text(build.read_text() + """
tasks.register('ordinaryCheck') {
    doLast { file('ordinary-action').text = 'executed' }
    finalizedBy 'ordinaryFinalizer'
}
tasks.register('ordinaryFinalizer') {
    doLast { file('ordinary-finalizer').text = 'executed' }
}
""")
        result = self.collect(tasks=("ordinaryCheck",))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "ordinary-action").read_text(), "executed")
        self.assertEqual((self.root / "ordinary-finalizer").read_text(), "executed")
        self.assertFalse((self.root / "budget-gradle-context.json").exists())

    def test_jvm_metadata_bucket_without_bom_keeps_resolved_classpath_bytes(self):
        self.add_bom_fixture()
        result = self.collect()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        proof = json.loads((self.root / "budget-gradle-context.json").read_text())
        self.assertEqual(proof["configurations"]["::debugCompileClasspath"],
                         ["example:fixture:1.0/fixture-1.0.jar"])
        self.assertEqual(proof["artifacts"]["example:fixture:1.0/fixture-1.0.jar"],
                         hashlib.sha256(self.artifact.read_bytes()).hexdigest())
        self.assertEqual(proof["excludedMetadata"]["::debugImplementationDependenciesMetadata"], {
            "org.gradle.category": "library", "org.gradle.usage": "kotlin-metadata",
            "org.jetbrains.kotlin.platform.type": "common"})
        self.assertNotIn("::debugImplementationDependenciesMetadata", proof["configurations"])

    def test_missing_bom_on_actual_classpath_refuses_proof(self):
        self.add_bom_fixture()
        build = self.root / "build.gradle"
        build.write_text(build.read_text().replace("implementation platform('example:bom:1.0')", ""))
        result = self.assert_collection_refused()
        self.assertIn("debugCompileClasspath", result.stdout + result.stderr)

    def test_metadata_exclusion_does_not_hide_missing_runtime_bytes(self):
        self.add_bom_fixture()
        self.artifact.unlink()
        self.assert_collection_refused()

    def test_metadata_name_with_runtime_usage_still_resolves(self):
        self.add_bom_fixture(metadata_usage="java-runtime")
        result = self.assert_collection_refused()
        self.assertIn("Could not find example:fixture:.", result.stdout + result.stderr)

    def test_metadata_name_with_jvm_platform_still_resolves(self):
        self.add_bom_fixture(metadata_platform="jvm")
        result = self.assert_collection_refused()
        self.assertIn("Could not find example:fixture:.", result.stdout + result.stderr)

    def test_unrecognized_metadata_configuration_still_resolves(self):
        self.add_bom_fixture(metadata_name="otherMetadataClasspath")
        result = self.assert_collection_refused()
        self.assertIn("Could not find example:fixture:.", result.stdout + result.stderr)

    def test_non_kotlin_project_metadata_still_resolves(self):
        self.add_bom_fixture(kotlin_jvm=False)
        result = self.assert_collection_refused()
        self.assertIn("Could not find example:fixture:.", result.stdout + result.stderr)

    def test_multiplatform_project_metadata_still_resolves(self):
        self.add_bom_fixture(multiplatform=True)
        result = self.assert_collection_refused()
        self.assertIn("Could not find example:fixture:.", result.stdout + result.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gradle", required=True)
    args, remaining = parser.parse_known_args()
    GRADLE = str(Path(args.gradle).resolve())
    unittest.main(argv=[__file__, *remaining])
