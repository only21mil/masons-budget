#!/usr/bin/env python3
"""Portable boundary checks and real Seatbelt denial probes on the MBP."""
import importlib.util
import os
from pathlib import Path
import subprocess
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("boundary", SCRIPT / "buzz_macos_build_boundary.py")
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)


class BoundaryTests(unittest.TestCase):
    def test_environment_omits_credentials_and_hooks(self):
        request = {key: 'public-only' for key in boundary.REQUEST_ENV}
        with patch.dict(os.environ, {'BUZZ_DEVELOPER_ID_P12_B64': 'private-canary',
                        'PATH': '/evil', 'HOME': '/real-home', 'PYTHONPATH': '/evil',
                        'NODE_OPTIONS': '--require /evil', 'GITHUB_ENV': '/runner-command'}, clear=True):
            env = boundary.build_env(Path('/scratch'), request)
        self.assertEqual(env['HOME'], '/scratch/home')
        self.assertEqual(env['CFFIXED_USER_HOME'], '/scratch/home')
        self.assertNotIn('private-canary', str(env))
        for key in ('NODE_OPTIONS', 'PYTHONPATH', 'GITHUB_ENV'):
            self.assertNotIn(key, env)
        self.assertEqual(env['PATH'], '/usr/bin:/bin:/usr/sbin:/sbin')
        self.assertEqual(env['SHELL'], '/bin/bash')

    def test_sandbox_requires_supervisor_scratch_parameter(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(KeyError):
                boundary.sandbox_command(Path('/owned/build'), ['/usr/bin/true'])
        with patch.dict(os.environ, BUZZ_DARWIN_ROOT='/owned/darwin'):
            argv = boundary.sandbox_command(Path('/owned/build'), ['/usr/bin/true'])
        self.assertIn('DARWIN_ROOT=/owned/darwin', argv)

    def test_payload_refuses_signing_uid_before_execution(self):
        with patch.object(boundary.pwd, 'getpwuid') as user, patch.object(boundary, 'confined') as run:
            user.return_value.pw_name = 'm5mbp'
            with self.assertRaisesRegex(RuntimeError, 'dedicated buzzbuild'):
                boundary.payload(Path('/scratch'), {})
            run.assert_not_called()

    def test_client_refuses_missing_installation_before_sudo(self):
        with patch.object(boundary.pwd, 'getpwuid') as user, patch.object(boundary, 'INSTALLED', Path('/does-not-exist')), patch.object(boundary.subprocess, 'run') as run:
            user.return_value.pw_name = 'm5mbp'
            with self.assertRaises(FileNotFoundError):
                boundary.client()
            run.assert_not_called()

    def test_two_architectures_and_rerun_have_distinct_create_only_outputs(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(boundary, 'verify_installation'), \
                patch.object(boundary.pwd, 'getpwuid') as user, \
                patch.object(boundary.subprocess, 'run') as run:
            user.return_value.pw_name = 'm5mbp'
            env = {key: 'public-only' for key in boundary.REQUEST_ENV.values()}
            env.update(GITHUB_WORKSPACE=temp, GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1', ARCH='aarch64')
            with patch.dict(os.environ, env, clear=True):
                boundary.client()
                os.environ['ARCH'] = 'x86_64'
                boundary.client()
                os.environ['GITHUB_RUN_ATTEMPT'] = '2'
                boundary.client()
                with self.assertRaises(FileExistsError):
                    boundary.client()
                os.environ['GITHUB_RUN_ID'] = '../escape'
                with self.assertRaisesRegex(RuntimeError, 'output identity'):
                    boundary.client()
            self.assertEqual(run.call_count, 3)
            self.assertEqual(set(os.listdir(temp)), {'unsigned-123-1-aarch64',
                                                     'unsigned-123-1-x86_64', 'unsigned-123-2-x86_64'})

    def test_routing_is_mbp_only_and_serialized(self):
        text = (SCRIPT.parent / "buzz-macos-release.yml").read_text()
        self.assertEqual(text.count("runs-on: [self-hosted, macOS, ARM64, macbook-pro-m5]"), 2)
        self.assertEqual(text.count("max-parallel: 1"), 2)
        self.assertNotIn("macos-15", text)
        self.assertNotIn("mac-mini", text)
        self.assertNotIn("inputs.runner", text)
        self.assertIn("needs: build", text)
        self.assertNotIn("activate-hermit@", text)

    @unittest.skipUnless(sys.platform == "darwin", "requires actual macOS Seatbelt")
    def test_real_seatbelt_denials_and_system_tools(self):
        with tempfile.TemporaryDirectory() as temp:
            parent = Path(temp).resolve()
            root = parent / "sandbox"
            root.mkdir()
            (root / "home").mkdir()
            (root / "tmp").mkdir()
            canary = parent / "private-canary"
            canary.write_text("must remain outside the sandbox")
            listener = socket.socket(socket.AF_UNIX)
            self.addCleanup(listener.close)
            listener.bind(str(parent / "ipc.sock"))
            listener.listen(1)
            code = '''import os, pathlib, subprocess
root, private, controller, parent_pid, ipc = __import__('sys').argv[1:]
pathlib.Path(root, 'allowed').write_text('yes')
for path, mode in [(private, 'r'), (private, 'w'), (controller + '/write-probe', 'w'),
                   ('/System/Volumes/Data' + private, 'r')]:
    try:
        open(path, mode)
    except PermissionError:
        pass
    else:
        raise AssertionError('sandbox allowed protected file access')
assert subprocess.run(['/bin/kill', '-0', parent_pid]).returncode != 0
try:
    __import__('socket').socket(__import__('socket').AF_UNIX).connect(ipc)
except PermissionError:
    pass
else:
    raise AssertionError('sandbox allowed outside Unix socket access')
import ctypes
lib = ctypes.CDLL(None)
bootstrap = ctypes.c_uint.in_dll(lib, 'bootstrap_port').value
for name in ['com.apple.securityd', 'com.apple.cfprefsd.daemon', 'com.apple.coreservices.launchservicesd']:
    port = ctypes.c_uint(0)
    assert lib.bootstrap_look_up(bootstrap, name.encode(), ctypes.byref(port)) != 0
for command in [['/usr/bin/git', '--version'], ['/usr/bin/xcrun', '--find', 'clang'],
                ['/usr/bin/xcrun', '--find', 'metal'], ['/usr/bin/curl', '--version']]:
    assert subprocess.run(command).returncode == 0
'''
            request = {key: 'public-only' for key in boundary.REQUEST_ENV}
            with patch.dict(os.environ, BUZZ_DARWIN_ROOT=str(root / 'darwin')):
                boundary.confined(root, request, ["/usr/bin/python3", "-I", "-c", code, str(root),
                                    str(canary), str(SCRIPT), str(os.getpid()), str(parent / "ipc.sock")], cwd=root)
            self.assertTrue((root / "allowed").is_file())
            self.assertEqual(canary.read_text(), "must remain outside the sandbox")


if __name__ == "__main__":
    unittest.main()
