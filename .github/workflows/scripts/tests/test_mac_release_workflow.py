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
import stat
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

    def test_published_modes_under_private_umask(self):
        archive = self.root/'app.tar.gz'
        with tarfile.open(archive, 'w:gz') as tf:
            for name, mode, kind in [('Buzz.app', 0o700, tarfile.DIRTYPE),
                                     ('Buzz.app/Contents/MacOS/Buzz', 0o700, tarfile.REGTYPE),
                                     ('Buzz.app/Contents/Resources/data', 0o600, tarfile.REGTYPE)]:
                member = tarfile.TarInfo(name)
                member.type, member.mode = kind, mode
                member.size = 0 if kind == tarfile.DIRTYPE else 1
                tf.addfile(member, io.BytesIO(b'x') if member.isfile() else None)
        old_umask = os.umask(0o077)
        try:
            secret_root = self.root/'private'
            secret_root.mkdir(mode=0o700)
            private_file = secret_root/'AuthKey.p8'
            private_file.write_bytes(b'nonsecret fixture')
            destination = secret_root/'extracted'
            app = release.extract(archive, destination)
        finally:
            os.umask(old_umask)
        for path in [app, *app.rglob('*')]:
            expected = 0o755 if path.is_dir() or path.name == 'Buzz' else 0o644
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), expected, str(path))
        for path in [secret_root, destination]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(private_file.stat().st_mode), 0o600)

    def test_notary_failure_retains_bounded_safe_causes(self):
        for error, expected in [(b'HTTP 401: invalid credentials', 'Authentication'),
                                (b'The Internet connection appears to be offline', 'Network'),
                                (b'Timed out waiting for submission', 'timed out')]:
            with self.subTest(error=error):
                result = subprocess.CompletedProcess([], 1, b'', error+b' private_sentinel --issuer argv_sentinel')
                with patch.object(release.subprocess, 'run', return_value=result):
                    with self.assertRaises(ValueError):
                        release.notarize(self.root/'app.zip', 'app', 'aarch64', self.root, ['--key-id', 'argv_sentinel'])
                retained = (self.root/'aarch64-notary-app-diagnostics.json').read_text()
                self.assertIn(expected, retained)
                self.assertNotIn('private_sentinel', retained)
                self.assertNotIn('argv_sentinel', retained)
                self.assertEqual(json.loads(retained)['exit_code'], 1)
                self.assertFalse((self.root/'aarch64-notary-app-submission.json').exists())
        result = subprocess.CompletedProcess([], 1, b'x'*100000, b'timeout '+b'y'*100000)
        diagnostic = release.notary_diagnostics(result)
        self.assertTrue(diagnostic['scan_truncated'])
        self.assertLess(len(json.dumps(diagnostic)), 2000)

    def test_notary_success_preserves_publisher_receipt_contract(self):
        submission_id = '12345678-1234-1234-1234-123456789abc'
        data = {'id': submission_id, 'status': 'Accepted', 'message': 'private_sentinel'}
        result = subprocess.CompletedProcess([], 0, json.dumps(data).encode(), b'argv_sentinel')
        def fetch_log(argv):
            Path(argv[-1]).write_text(json.dumps({'jobId': submission_id, 'status': 'Accepted'}))
        with patch.object(release.subprocess, 'run', return_value=result), patch.object(release, 'run', side_effect=fetch_log):
            receipt = release.notarize(self.root/'app.zip', 'app', 'aarch64', self.root, [])
        self.assertEqual(set(receipt), {'id', 'status', 'submission', 'log'})
        self.assertEqual(receipt['status'], 'Accepted')
        for kind in ['submission', 'log']:
            self.assertEqual(set(receipt[kind]), {'name', 'sha256', 'size'})
            self.assertEqual(release.record(self.root/receipt[kind]['name']), receipt[kind])
        self.assertNotIn('sentinel', ''.join(path.read_text() for path in self.root.glob('*-notary-*.json')))

    def test_sleep_during_notary_wait_reunlocks_before_dmg_signing(self):
        args = self.args()
        root, output = self.root/'private', self.root/'signed'
        app = root/'extracted/Buzz.app'
        app.mkdir(parents=True)
        output.mkdir()
        (app/'Buzz').write_bytes(bytes.fromhex('feedfacf'))
        private = {name: 'fixture' for name in release.SECRET_NAMES}
        private.update({'BUZZ_DEVELOPER_ID_P12_B64': base64.b64encode(b'fixture').decode(),
                        'BUZZ_DEVELOPER_ID_P12_PASSWORD': 'p'*32, 'ASC_KEY_ID': 'A'*10,
                        'ASC_ISSUER_ID': '1'*36, 'ASC_API_KEY_P8': '-----BEGIN PRIVATE KEY-----\nfixture'})
        events = []
        locked = False
        class ReachedDmgSigning(Exception):
            pass
        def execute(argv, **kwargs):
            nonlocal locked
            events.append((argv, kwargs))
            if argv == ['/usr/bin/security', '-i'] and b'"unlock-keychain"' in kwargs['input_data']:
                self.assertTrue(kwargs['confidential'])
                self.assertNotIn('password_sentinel', repr(argv))
                self.assertIn(b'password_sentinel', kwargs['input_data'])
                locked = False
            if 'find-identity' in argv:
                return ('A'*40+' "Developer ID Application: Fixture ('+release.TEAM+')"').encode()
            if '-archs' in argv:
                return b'arm64'
            if '--extract-certificates' in argv:
                Path(argv[argv.index('--extract-certificates')+1]+'0').write_bytes(b'certificate')
            if '-subject' in argv:
                return ('Developer ID Application: Fixture '+release.TEAM).encode()
            if argv[0] == '/usr/bin/hdiutil':
                self.assertEqual(stat.S_IMODE((root/'dmg-content').stat().st_mode), 0o755)
            if '--sign' in argv and argv[-1].endswith('.dmg'):
                self.assertFalse(locked, 'sleep left the keychain locked')
                self.assertEqual(events[-2][0], ['/usr/bin/security', '-i'])
                raise ReachedDmgSigning()
            if kwargs.get('output'):
                kwargs['output'].write_bytes(b'PASS')
            return b''
        def wait_and_sleep(*_args):
            nonlocal locked
            locked = True
            return {}
        with patch.dict(os.environ, private), patch.object(release, 'paths', return_value=(root, output)), \
             patch.object(release, 'check_build', return_value=(self.root/'archive', {})), \
             patch.object(release, 'app_info'), patch.object(release.secrets, 'token_urlsafe', return_value='password_sentinel'), \
             patch.object(release, 'run', side_effect=execute), patch.object(release, 'notarize', side_effect=wait_and_sleep):
            with self.assertRaises(ReachedDmgSigning):
                release.sign(args)
        commands = [argv for argv, _ in events]
        self.assertIn(['/usr/bin/security', 'set-keychain-settings', '-lut', '7200', str(root/'signing.keychain-db')], commands)
        self.assertFalse(any('default-keychain' in argv or 'list-keychains' in argv for argv in commands))

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
