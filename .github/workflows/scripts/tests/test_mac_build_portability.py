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
    print(json.dumps({'packages': [{'name': 'mesh-llm-sdk', 'manifest_path': os.environ['MOCK_MESH'] + '/Cargo.toml'}]}))
elif name == 'python3':
    exec(sys.stdin.read() if sys.argv[1:] == ['-'] else sys.argv[2])
'''


class BuildArgumentsTests(unittest.TestCase):
    def test_both_architectures(self):
        for arch in ('x86_64', 'aarch64'):
            with self.subTest(arch=arch), tempfile.TemporaryDirectory(prefix='buzz build mock ') as temp:
                root = Path(temp)
                source = root / 'buzz'
                desktop = source / 'desktop'
                tauri = desktop / 'src-tauri'
                tauri.mkdir(parents=True)
                (tauri / 'tauri.conf.json').write_text(json.dumps({'version': '0.5.8'}))
                (tauri / 'tauri.release.conf.json').write_text(json.dumps({
                    'bundle': {'createUpdaterArtifacts': True, 'externalBin': ['unchanged']}}))
                mesh = root / 'mesh checkout'
                bindir = root / 'bin'
                bindir.mkdir()
                paths = [bindir / name for name in ('git', 'python3', 'just', 'rustup', 'node', 'cargo', 'pnpm')]
                paths += [source / 'scripts/bundle-sidecars.sh', mesh / 'scripts/prepare-llama.sh',
                          mesh / 'scripts/build-llama.sh']
                for path in paths:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text('#!' + sys.executable + '\n' + MOCK)
                    path.chmod(0o755)
                log = root / 'argv.jsonl'
                env = {**os.environ, 'PATH': str(bindir) + os.pathsep + os.environ['PATH'],
                       'SOURCE_SHA': 'a'*40, 'VERSION': '0.5.8', 'ARCH': arch,
                       'BUZZ_UPDATER_PUBLIC_KEY': 'public-test-only', 'GITHUB_WORKSPACE': str(root),
                       'CALL_LOG': str(log), 'MOCK_MESH': str(mesh)}
                result = subprocess.run([os.environ.get('BUZZ_TEST_BASH', '/bin/bash'), str(SCRIPT)],
                                        cwd=source, env=env, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, universal_newlines=True)
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
