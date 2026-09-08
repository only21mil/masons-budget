#!/usr/bin/env python3
"""Public-fixture checks for iOS source, archive, profile and UID boundaries."""
import argparse
import copy
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import re
import sys
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPT / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


ios = module('ios', 'buzz_ios_release.py')
boundary = module('boundary', 'buzz_macos_build_boundary.py')
supervisor = module('supervisor', 'buzz_macos_build_supervisor.py')
ENV = {'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_SHA': 'b' * 40}


def args(root):
    return argparse.Namespace(source='a' * 40, version='0.5.9', build_number='1',
                              input=root / 'unsigned', output=root / 'unsigned', app=root / 'Buzz.app')


def app_fixture(app):
    for path, identifier in ((app, ios.BUNDLE), (app / 'PlugIns/NotificationService.appex', ios.NSE)):
        path.mkdir(parents=True)
        (path / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': identifier,
            'CFBundleShortVersionString': '0.5.9', 'CFBundleVersion': '1',
            'CFBundleSupportedPlatforms': ['iPhoneOS'], 'CFBundleExecutable': 'Runner'}))
        (path / 'Runner').write_bytes(bytes.fromhex('cffaedfe') + b'public-fixture')


def profile(identifier):
    permissions = ios.expected_entitlements(identifier)
    permissions['keychain-access-groups'] = [ios.TEAM + '.*', 'com.apple.token']
    if identifier == ios.BUNDLE:
        # Shape of the actual Apple-generated parent profile, September 7, 2026.
        permissions['com.apple.developer.devicecheck.appattest-environment'] = ['development', 'production']
    permissions['beta-reports-active'] = True
    return {'TeamIdentifier': [ios.TEAM], 'ApplicationIdentifierPrefix': [ios.TEAM],
            'ExpirationDate': datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=30),
            'DeveloperCertificates': [b'public-certificate-fixture'], 'Entitlements': permissions}


class IosReleaseTests(unittest.TestCase):
    def test_exact_parent_and_nse_info(self):
        with tempfile.TemporaryDirectory() as temp:
            a = args(Path(temp)); app_fixture(a.app); ios.app_info(a.app, a)
            path = a.app / 'PlugIns/NotificationService.appex/Info.plist'
            info = plistlib.loads(path.read_bytes()); info['CFBundleVersion'] = '2'
            path.write_bytes(plistlib.dumps(info))
            with self.assertRaisesRegex(ValueError, 'version differs'):
                ios.app_info(a.app, a)

    def test_payload_packages_the_actual_buzz_product(self):
        # Source excerpt preserves the real Release product setting; the test
        # executes the payload's actual pack invocation against that output.
        source_settings = (SCRIPT / 'tests/fixtures/buzz-ios-runner-release.pbxproj').read_text()
        product = re.search(r'PRODUCT_NAME = ([A-Za-z0-9_-]+);', source_settings).group(1)
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, ENV), \
                patch.object(boundary.pwd, 'getpwuid') as user, \
                patch.object(boundary.os, 'getgroups', return_value=[590]):
            user.return_value = boundary.pwd.struct_passwd(('buzzbuild', 'x', 590, 590, '', '/owned', '/bin/bash'))
            root = Path(temp)
            source = root / 'buzz'
            app_fixture(source / 'mobile/build/ios/iphoneos' / (product + '.app'))
            overrides = source / 'mobile/ios/Flutter/AppOverrides.xcconfig'
            overrides.parent.mkdir(parents=True); overrides.write_text(ios.OVERRIDES)
            request = {'arch': 'ios', 'source_sha': 'a' * 40, 'version': '0.5.9', 'build_number': '1'}
            def confined(_root, _request, command, *, cwd):
                if 'pack' not in command:
                    return  # Compilation is replaced by the source-derived fixture.
                options = dict(zip(command[4::2], command[5::2]))
                a = argparse.Namespace(source=options['--source'], version=options['--version'],
                    build_number=options['--build-number'], app=Path(options['--app']),
                    output=Path(options['--output']))
                old = Path.cwd()
                try:
                    os.chdir(cwd); ios.pack(a)
                finally:
                    os.chdir(old)
            with patch.object(boundary, 'confined', side_effect=confined) as invocation:
                boundary.payload(root, request)
            self.assertEqual(invocation.call_count, 2)
            self.assertTrue((root / 'unsigned/unsigned-ios.app.tar.gz').is_file())
            self.assertFalse((source / 'mobile/build/ios/iphoneos/Runner.app').exists())

    def test_archive_roundtrip_and_exact_source_binding(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, ENV):
            root = Path(temp); a = args(root); app_fixture(a.app)
            overrides = root / 'mobile/ios/Flutter/AppOverrides.xcconfig'
            overrides.parent.mkdir(parents=True); overrides.write_text(ios.OVERRIDES)
            old = Path.cwd()
            try:
                os.chdir(root); ios.pack(a)
            finally:
                os.chdir(old)
            archive, _ = ios.check_build(a)
            recovered = ios.common.extract(archive, root / 'recovered')
            ios.app_info(recovered, a)
            a.source = 'c' * 40
            with self.assertRaisesRegex(ValueError, 'receipt differs'):
                ios.check_build(a)

    def test_tampered_archive_stops_before_extract(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, ENV):
            root = Path(temp); a = args(root); a.input.mkdir()
            archive = a.input / 'unsigned-ios.app.tar.gz'; archive.write_bytes(b'original')
            receipt = ios.binding(a); receipt['archive'] = ios.common.record(archive)
            (a.input / 'build-ios.json').write_text(json.dumps(receipt))
            archive.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'receipt differs'):
                ios.check_build(a)

    def test_archive_rejects_symlink_escape(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / 'bad.tar.gz'
            with tarfile.open(archive, 'w:gz') as tf:
                member = tarfile.TarInfo('Buzz.app/link'); member.type = tarfile.SYMTYPE
                member.linkname = '../../outside'; tf.addfile(member)
            with tarfile.open(archive, 'r:gz') as tf:
                with self.assertRaisesRegex(ValueError, 'escaping symlink'):
                    ios.common.safe_members(tf)

    def test_profile_requires_exact_certificate_and_entitlements(self):
        for identifier in (ios.BUNDLE, ios.NSE):
            with self.subTest(identifier=identifier):
                good = profile(identifier)
                signed = ios.profile_check(good, identifier, b'public-certificate-fixture')
                self.assertEqual(signed['keychain-access-groups'], [ios.TEAM + '.' + ios.BUNDLE])
                with self.assertRaisesRegex(ValueError, 'certificate mismatch'):
                    ios.profile_check(good, identifier, b'wrong-certificate')
                for key in ios.expected_entitlements(identifier):
                    bad = copy.deepcopy(good); bad['Entitlements'].pop(key)
                    with self.assertRaises(ValueError):
                        ios.profile_check(bad, identifier, b'public-certificate-fixture')

    def test_app_attest_profile_permission_keeps_signed_entitlement_production(self):
        key = 'com.apple.developer.devicecheck.appattest-environment'
        p = profile(ios.BUNDLE)
        signed = ios.profile_check(p, ios.BUNDLE, b'public-certificate-fixture')
        self.assertEqual(signed[key], 'production')
        for permission in (['development'], [], ['production', False], 'development'):
            p['Entitlements'][key] = permission
            with self.assertRaises(ValueError):
                ios.profile_check(p, ios.BUNDLE, b'public-certificate-fixture')

    def test_profile_rejects_development_expired_wrong_team(self):
        for changed in ({'ProvisionedDevices': ['device']}, {'ProvisionsAllDevices': True},
                        {'TeamIdentifier': ['OTHERTEAM']},
                        {'ExpirationDate': datetime.datetime(2000, 1, 1)}):
            p = profile(ios.BUNDLE); p.update(changed)
            with self.assertRaises(ValueError):
                ios.profile_check(p, ios.BUNDLE, b'public-certificate-fixture')

    def test_ios_request_is_fixed_and_rejects_mac_fields(self):
        request = {'source_sha': 'a' * 40, 'workflow_sha': 'b' * 40, 'version': '0.5.9',
                   'build_number': '1', 'arch': 'ios', 'run_id': '123', 'run_attempt': '1',
                   'output_dir': '/owned/empty'}
        self.assertEqual(supervisor.request_from(io.BytesIO(json.dumps(request).encode())), request)
        for delta in ({'updater_endpoint': 'https://example.com'}, {'bundle': 'com.other.app'},
                      {'build_number': '../escape'}, {'version': '0.5.9-rc.2'}, {'arch': 'simulator'}):
            bad = dict(request, **delta)
            with self.assertRaises(supervisor.BoundaryError):
                supervisor.request_from(io.BytesIO(json.dumps(bad).encode()))

    def test_ios_environment_never_carries_signing_inputs(self):
        request = {key: 'public' for key in boundary.IOS_REQUEST_ENV}
        request['arch'] = 'ios'
        with patch.dict(os.environ, {name: 'private-fixture' for name in ios.SECRETS}, clear=True):
            environment = boundary.build_env(Path('/owned/build'), request)
        self.assertNotIn('private-fixture', str(environment))
        self.assertNotIn('MACOSX_DEPLOYMENT_TARGET', environment)
        self.assertNotIn('BUZZ_UPDATER_PUBLIC_KEY', environment)
        self.assertEqual(environment['HOME'], '/private/var/db/buzz-macos-build-home')
        self.assertEqual(environment['CFFIXED_USER_HOME'], '/private/var/db/buzz-macos-build-home')

    def test_fixed_override_matches_recipe(self):
        recipe = (SCRIPT / 'buzz_ios_build.sh').read_text()
        self.assertIn("<<'CONFIG'\n" + ios.OVERRIDES + 'CONFIG\n', recipe)
        self.assertIn('--no-codesign', recipe)


class XcrunShimTests(unittest.TestCase):
    def test_unsigned_recipe_shim_preserves_every_argument(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'mobile/ios/Flutter').mkdir(parents=True)
            home = root / 'home'; home.mkdir()
            bin_dir = root / 'bin'; bin_dir.mkdir()
            for name, body in [('git', 'printf "%s\\n" ' + 'a' * 40),
                               ('flutter', 'exit 0')]:
                tool = bin_dir / name
                tool.write_text('#!/bin/bash\n' + body + '\n')
                tool.chmod(0o700)
            env = dict(PATH=str(bin_dir) + ':/usr/bin:/bin', HOME=str(home),
                       SOURCE_SHA='a' * 40, VERSION='0.5.9', BUILD_NUMBER='1')
            subprocess.run(['/bin/bash', str(SCRIPT / 'buzz_ios_build.sh')],
                           cwd=root, env=env, check=True, capture_output=True)
            shim = home / 'xcode-tools/xcrun'
            self.assertEqual(shim.stat().st_mode & 0o777, 0o700)
            # Shadow only Bash's exec builtin, capturing the actual generated
            # shim's argv without replacing its absolute /usr/bin/xcrun target.
            capture = 'exec() { printf "%s\\0" "$@"; exit 0; }; shim=$1; shift; source "$shim" "$@"'
            cases = [[], ['--find', 'xcodebuild'], ['--sdk', 'iphoneos', '--find', 'clang'],
                     ['xcodebuild', '-list'],
                     ['xcodebuild', 'space value', '; touch injected', '$(touch injected)', '*']]
            for args in cases:
                with self.subTest(args=args):
                    result = subprocess.run(['/bin/bash', '-c', capture, 'capture', str(shim), *args],
                                            cwd=root, env=env, capture_output=True, check=True)
                    actual = result.stdout.decode().split('\0')[:-1]
                    expected = ['/usr/bin/xcrun', *args]
                    if args and args[0] == 'xcodebuild':
                        expected.insert(2, '-IDEPackageSupportDisableManifestSandbox=YES')
                    self.assertEqual(actual, expected)
            self.assertFalse((root / 'injected').exists())


if __name__ == '__main__':
    unittest.main()
