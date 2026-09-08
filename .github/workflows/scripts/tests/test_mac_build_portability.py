#!/usr/bin/env python3
"""Execute the real build driver with inert tools, including on Mac Bash 3.2.

BUZZ_TEST_BASH selects the shell; BUZZ_TEST_BUILD_SCRIPT permits an exact
baseline regression run. No compiler, package installer, or signer executes.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(os.environ.get('BUZZ_TEST_BUILD_SCRIPT',
              str(Path(__file__).resolve().parents[1] / 'buzz_macos_build.sh')))
MOCK = '''import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps([name] + sys.argv[1:]) + '\\n')
if name == 'git':
    print(os.environ['SOURCE_SHA'])
elif name == 'cargo' and sys.argv[1] == 'metadata':
    print(os.environ['MOCK_METADATA'])
elif name == 'python3':
    exec(sys.stdin.read() if sys.argv[1:] == ['-'] else sys.argv[2])
'''


class BuildArgumentsTests(unittest.TestCase):
    def test_both_architectures(self):
        for arch in ('x86_64', 'aarch64'):
            with self.subTest(arch=arch):
                self.run_driver(arch)

    def test_invalid_mesh_layouts_stop_before_dependency_scripts(self):
        for case in ('absent-package', 'duplicate-package', 'local-package', 'other-repository',
                     'unpinned-source', 'package-root', 'relative-manifest', 'missing-manifest',
                     'missing-workspace', 'missing-prepare', 'missing-build', 'nonexecutable-build',
                     'symlink-script', 'directory-script'):
            with self.subTest(case=case):
                self.run_driver('aarch64', invalid=case)

    def run_driver(self, arch, invalid=None):
        with tempfile.TemporaryDirectory(prefix='buzz build mock ') as temp:
            root = Path(temp)
            source = root / 'buzz'
            desktop = source / 'desktop'
            tauri = desktop / 'src-tauri'
            tauri.mkdir(parents=True)
            (tauri / 'tauri.conf.json').write_text(json.dumps({'version': '0.5.20'}))
            (tauri / 'tauri.release.conf.json').write_text(json.dumps({
                'bundle': {'createUpdaterArtifacts': True, 'externalBin': ['unchanged']}}))
            mesh = root / 'mesh checkout'
            manifest = mesh / 'crates/mesh-llm-sdk/Cargo.toml'
            manifest.parent.mkdir(parents=True)
            manifest.write_text('[package]\nname = "mesh-llm-sdk"\nversion = "0.74.0"\n')
            (mesh / 'Cargo.toml').write_text('[workspace]\nmembers = ["crates/mesh-llm-sdk"]\n')
            bindir = root / 'bin'
            bindir.mkdir()
            paths = [bindir / name for name in ('git', 'python3', 'just', 'rustup', 'node', 'cargo', 'pnpm')]
            paths += [source / 'scripts/bundle-sidecars.sh', mesh / 'scripts/prepare-llama.sh',
                      mesh / 'scripts/build-llama.sh']
            for path in paths:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('#!' + sys.executable + '\n' + MOCK)
                path.chmod(0o755)
            package = {'name': 'mesh-llm-sdk', 'manifest_path': str(manifest),
                       'source': 'git+https://github.com/Mesh-LLM/mesh-llm.git?tag=v0.74.0#'
                                 'e60b2fe43aa05271569fbeff2a457133aef456a1'}
            packages = [package]
            if invalid == 'absent-package':
                packages = []
            elif invalid == 'duplicate-package':
                packages.append(dict(package))
            elif invalid == 'local-package':
                package['source'] = None
            elif invalid == 'other-repository':
                package['source'] = package['source'].replace('Mesh-LLM', 'other-owner')
            elif invalid == 'unpinned-source':
                package['source'] = package['source'].split('#')[0]
            elif invalid == 'package-root':
                package['manifest_path'] = str(mesh / 'Cargo.toml')
            elif invalid == 'relative-manifest':
                package['manifest_path'] = 'crates/mesh-llm-sdk/Cargo.toml'
            elif invalid == 'missing-manifest':
                manifest.unlink()
            elif invalid == 'missing-workspace':
                (mesh / 'Cargo.toml').unlink()
            elif invalid in ('missing-prepare', 'missing-build'):
                (mesh / 'scripts' / (invalid.removeprefix('missing-') + '-llama.sh')).unlink()
            elif invalid == 'nonexecutable-build':
                (mesh / 'scripts/build-llama.sh').chmod(0o644)
            elif invalid in ('symlink-script', 'directory-script'):
                script = mesh / 'scripts/build-llama.sh'
                script.unlink()
                if invalid == 'symlink-script':
                    script.symlink_to(mesh / 'scripts/prepare-llama.sh')
                else:
                    script.mkdir()
            log = root / 'argv.jsonl'
            env = {**os.environ, 'PATH': str(bindir) + os.pathsep + os.environ['PATH'],
                   'SOURCE_SHA': 'a'*40, 'VERSION': '0.5.20', 'ARCH': arch,
                   'BUZZ_UPDATER_PUBLIC_KEY': 'public-test-only', 'GITHUB_WORKSPACE': str(root),
                   'CALL_LOG': str(log), 'MOCK_METADATA': json.dumps({'packages': packages})}
            result = subprocess.run([os.environ.get('BUZZ_TEST_BASH', '/bin/bash'), str(SCRIPT)],
                                    cwd=source, env=env, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, universal_newlines=True)
            if invalid:
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('mesh', result.stderr)
                actual = [json.loads(line) for line in log.read_text().splitlines()]
                self.assertFalse(any(row[0] in ('prepare-llama.sh', 'build-llama.sh', 'pnpm') for row in actual), actual)
                return
            self.assertEqual(result.returncode, 0, result.stderr)
            target = arch + '-apple-darwin'
            expected = [
                ['git', 'rev-parse', 'HEAD'], ['python3', '-'], ['just', 'desktop-install-ci'],
                ['rustup', 'target', 'add', target], ['node', 'scripts/build-release-config.mjs'],
                ['python3', '-'], ['cargo', 'build', '--locked', '--release', '--target', target,
                '-p', 'buzz-acp', '-p', 'buzz-agent', '-p', 'buzz-backend-kubernetes',
                '-p', 'buzz-dev-mcp', '-p', 'git-credential-nostr', '-p', 'buzz-cli'],
                ['bundle-sidecars.sh', target]]
            if arch == 'aarch64':
                expected += [['cargo', 'fetch', '--locked', '--manifest-path', 'desktop/src-tauri/Cargo.toml'],
                             ['cargo', 'metadata', '--locked', '--features', 'mesh-llm', '--format-version', '1', '--manifest-path', 'desktop/src-tauri/Cargo.toml'],
                             ['python3', '-c', SCRIPT.read_text().split("| python3 -c '", 1)[1].split("')", 1)[0]],
                             ['prepare-llama.sh', 'pinned'],
                             ['build-llama.sh', '-DCMAKE_OSX_DEPLOYMENT_TARGET=10.15']]
            expected += [['pnpm', 'tauri', 'build', '--verbose', '--no-sign', '--target', target,
                          '--bundles', 'app'] + (['--features', 'mesh-llm'] if arch == 'aarch64' else []) +
                         ['--config', 'src-tauri/tauri.release.conf.json']]

            actual = [json.loads(line) for line in log.read_text().splitlines()]
            if arch == 'aarch64':
                offset = next(i for i, row in enumerate(actual) if row[:2] == ['cargo', 'fetch']) + 1
                actual[offset:offset+2] = sorted(actual[offset:offset+2])
            self.assertEqual(actual, expected)
            self.assertEqual(json.loads((tauri / 'tauri.release.conf.json').read_text()),
                             {'bundle': {'createUpdaterArtifacts': False, 'externalBin': ['unchanged']}})


if __name__ == '__main__':
    unittest.main()
