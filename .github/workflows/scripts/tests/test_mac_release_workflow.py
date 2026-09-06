#!/usr/bin/env python3
"""Portable negative tests for the credential/artifact boundary, not signing proof."""
import argparse
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).resolve().parents[1] / 'buzz_macos_release.py'
spec = importlib.util.spec_from_file_location('release', SCRIPT)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

# Public dummy packet only. No signing keys or cryptographic proof in these tests.
PUBLIC = base64.b64encode(b'untrusted comment: test public key\n' + base64.b64encode(b'Ed' + b'x'*40) + b'\n').decode()
ENV = {'BUZZ_UPDATER_PUBLIC_KEY': PUBLIC, 'BUZZ_UPDATER_ENDPOINT': release.ENDPOINT,
       'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_SHA': 'b'*40}


def make_tar(path, entries):
    with tarfile.open(path, 'w:gz') as tf:
        for name, kind, data in entries:
            member = tarfile.TarInfo(name)
            if kind == 'symlink':
                member.type, member.linkname = tarfile.SYMTYPE, data
            elif kind == 'hardlink':
                member.type, member.linkname = tarfile.LNKTYPE, data
            elif kind == 'fifo':
                member.type = tarfile.FIFOTYPE
            else:
                member.size = len(data)
                member.mode = 0o755
            tf.addfile(member, io.BytesIO(data) if kind == 'file' else None)


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {**ENV, 'RUNNER_TEMP': str(self.root)}, clear=True)
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def args(self):
        return argparse.Namespace(source='a'*40, version='0.5.8', arch='aarch64', input=self.root)

    def test_valid_inputs(self):
        release.inputs(self.args())

    def test_ref_and_shell_injections_refused(self):
        for value in ['main', 'a'*39, 'A'*40, 'a'*40+'\n', '$(touch nope)', '../main']:
            args = self.args()
            args.source = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.inputs(args)

    def test_versions_cannot_escape_paths(self):
        for value in ['../0.5.8', '0.5.8\n', '0.5.8/../../x', '00.5.8', '0.5.8;touch x']:
            args = self.args()
            args.version = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.inputs(args)

    def test_wrong_endpoint_rejected(self):
        os.environ['BUZZ_UPDATER_ENDPOINT'] = 'https://example.com/latest.json'
        with self.assertRaises(ValueError):
            release.inputs(self.args())

    def test_bad_public_key_rejected(self):
        for value in ['', 'not base64', base64.b64encode(b'wrong').decode()]:
            os.environ['BUZZ_UPDATER_PUBLIC_KEY'] = value
            with self.subTest(value=value), self.assertRaises(Exception):
                release.public_key()

    def test_safe_framework_symlinks_extract(self):
        archive = self.root/'app.tar.gz'
        make_tar(archive, [('Buzz.app/Contents/Frameworks/X/Versions/A/X', 'file', b'code'),
                           ('Buzz.app/Contents/Frameworks/X/Versions/Current', 'symlink', 'A'),
                           ('Buzz.app/Contents/Frameworks/X/X', 'symlink', 'Versions/Current/X')])
        app = release.extract(archive, self.root/'extract')
        self.assertEqual((app/'Contents/Frameworks/X/X').read_bytes(), b'code')

    def test_archive_attacks_rejected_before_extraction(self):
        attacks = [
            [('../escape', 'file', b'x')],
            [('/absolute', 'file', b'x')],
            [('Other.app/x', 'file', b'x')],
            [('Buzz.app/x', 'file', b'x'), ('Buzz.app/x', 'file', b'y')],
            [('Buzz.app/x', 'symlink', '/etc/passwd')],
            [('Buzz.app/x', 'symlink', '../../escape')],
            [('Buzz.app/x', 'symlink', 'Contents'), ('Buzz.app/x/y', 'file', b'x')],
            [('Buzz.app/x', 'hardlink', 'Buzz.app/y')],
            [('Buzz.app/x', 'fifo', '')],
            [('Buzz.app/a\\b', 'file', b'x')],
        ]
        for index, entries in enumerate(attacks):
            with self.subTest(entries=entries):
                archive = self.root/f'{index}.tar.gz'
                make_tar(archive, entries)
                destination = self.root/f'extract-{index}'
                with self.assertRaises(ValueError):
                    release.extract(archive, destination)
                self.assertFalse(destination.exists())

    def test_symlink_chain_escape_rejected(self):
        archive = self.root/'app.tar.gz'
        make_tar(archive, [('Buzz.app/d/up', 'symlink', '..'),
                           ('Buzz.app/escape', 'symlink', 'd/up/../outside')])
        with self.assertRaises(ValueError):
            release.extract(archive, self.root/'extract')

    def test_app_identity_and_main_path(self):
        app = self.root/'Buzz.app'
        (app/'Contents/MacOS').mkdir(parents=True)
        (app/'Contents/MacOS/Buzz').write_bytes(b'x')
        info = {'CFBundleIdentifier': 'xyz.block.buzz.app', 'CFBundleShortVersionString': '0.5.8', 'CFBundleExecutable': 'Buzz'}
        (app/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
        release.app_info(app, '0.5.8')
        for key, value in [('CFBundleExecutable', '../../other'), ('CFBundleIdentifier', 'other'), ('CFBundleShortVersionString', '0.5.7')]:
            mutated = {**info, key: value}
            (app/'Contents/Info.plist').write_bytes(plistlib.dumps(mutated))
            with self.assertRaises(ValueError):
                release.app_info(app, '0.5.8')

    def test_tool_environment_drops_credentials_and_hooks(self):
        os.environ.update({'BUZZ_TAURI_SIGNING_PRIVATE_KEY': 'sensitive', 'NODE_OPTIONS': '--require bad', 'DYLD_INSERT_LIBRARIES': '/bad', 'PYTHONPATH': '/bad'})
        clean = release.clean_env()
        self.assertFalse(set(clean) & {'BUZZ_TAURI_SIGNING_PRIVATE_KEY', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH'})

    def test_security_password_only_on_stdin(self):
        with patch.object(release.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b'')) as execute:
            release.security_command(['unlock-keychain', '-p', 'private_sentinel', '/safe/keychain'])
            argv = execute.call_args.args[0]
            self.assertEqual(argv, ['/usr/bin/security', '-i'])
            self.assertIn(b'private_sentinel', execute.call_args.kwargs['input'])
            self.assertNotIn('private_sentinel', repr(argv))

    def test_security_command_injection_rejected(self):
        with self.assertRaises(ValueError):
            release.security_command(['import', 'file\nexport -o /other'])

    def test_failure_does_not_render_secret_output(self):
        with patch.object(release.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'secret', b'secret')):
            with self.assertRaises(RuntimeError) as caught:
                release.security_command(['import', 'safe'])
            self.assertNotIn('secret', str(caught.exception))

    def test_successful_empty_check_has_nonempty_receipt(self):
        with patch.object(release.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b'')):
            log = self.root/'check.txt'
            release.run(['/usr/bin/true'], output=log)
            self.assertEqual(log.read_text(), '\nPASS\n')

    def test_build_binding_rejects_other_run_source_and_key(self):
        args = self.args()
        archive = self.root/'unsigned-aarch64.app.tar.gz'
        archive.write_bytes(b'archive')
        receipt = {'schema':'buzz-macos-build-v1', 'source':args.source, 'version':args.version, 'arch':args.arch,
                   'target':'aarch64-apple-darwin', 'archive':release.record(archive),
                   'updater_public_key_sha256':release.public_key()[1], 'updater_endpoint':release.ENDPOINT,
                   'run_id':'123', 'run_attempt':'1', 'workflow_sha':'b'*40,
                   'entitlements_verifier_sha256':release.sha(SCRIPT.parent/'buzz-verify-macos-entitlements.sh')}
        path = self.root/'build-aarch64.json'
        path.write_text(json.dumps(receipt))
        release.check_build(args)
        for key in ['source', 'run_id', 'run_attempt', 'workflow_sha', 'updater_public_key_sha256']:
            path.write_text(json.dumps({**receipt,key:'wrong'}))
            with self.subTest(key=key), self.assertRaises(ValueError):
                release.check_build(args)

    def test_cleanup_deletes_raw_secrets_on_keychain_delete_failure(self):
        root, _ = release.paths('aarch64')
        root.mkdir()
        for name in ['signing.keychain-db', 'developer-id.p12', 'AuthKey.p8', 'updater.key']:
            (root/name).write_bytes(b'private')
        with patch.object(release, 'run', side_effect=RuntimeError('failed')):
            with self.assertRaises(ValueError):
                release.cleanup('aarch64')
        for name in ['developer-id.p12', 'AuthKey.p8', 'updater.key']:
            self.assertFalse((root/name).exists())
        self.assertTrue((root/'signing.keychain-db').exists())

    def test_cleanup_refuses_unsafe_run_identity(self):
        os.environ['GITHUB_RUN_ID'] = '../other'
        with self.assertRaises(ValueError):
            release.cleanup('aarch64')

    def test_workflow_secret_boundary(self):
        workflow = (SCRIPT.parents[1]/'buzz-macos-release.yml').read_text()
        build, sign = workflow.split('\n  sign:\n')
        self.assertNotIn('secrets.', build)
        self.assertIn('runs-on: macos-15', build)
        self.assertNotIn('repository: only21mil/buzz', sign)
        self.assertNotIn('working-directory: buzz', sign)
        self.assertIn('if: always()', sign)
        self.assertIn('max-parallel: 1', sign)


if __name__ == '__main__':
    unittest.main()
