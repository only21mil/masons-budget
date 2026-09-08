#!/usr/bin/env python3
"""Trusted iOS artifact handoff, signing and upload. Never executes Buzz code."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from collections import namedtuple
import datetime
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shutil
import sys
import tarfile

SCRIPT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('buzz_mac_artifacts', SCRIPT / 'buzz_macos_release.py')
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
require, run = common.require, common.run
TEAM = '384ZGKG4GB'
BUNDLE = 'com.sats21m.buzz'
NSE = BUNDLE + '.NotificationService'
GROUP = 'group.' + BUNDLE
SECRETS = ('APPLE_DISTRIBUTION_CERTIFICATE_P12', 'APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD',
           'BUZZ_IOS_APP_STORE_PROFILE', 'BUZZ_IOS_NSE_APP_STORE_PROFILE',
           'ASC_API_KEY_P8', 'ASC_KEY_ID', 'ASC_ISSUER_ID')
OVERRIDES = ('BUNDLE_IDENTIFIER = ' + BUNDLE + '\nAPP_DISPLAY_NAME = Buzz\n'
             'BUZZ_DEVELOPMENT_TEAM = ' + TEAM + '\nBUZZ_APP_GROUP_IDENTIFIER = ' + GROUP + '\n'
             'BUZZ_KEYCHAIN_ACCESS_GROUP = ' + BUNDLE + '\n'
             'BUZZ_IOS_PUSH_ENVIRONMENT = production\nBUZZ_APP_ATTEST_ENVIRONMENT = production\n')


# Original unsigned execution, supplied only by a trusted recovery caller. The
# ordinary CLI has no origin override and continues binding its current run.
BuildOrigin = namedtuple('BuildOrigin', ['run_id', 'run_attempt', 'workflow_sha'])


def inputs(args):
    require(re.fullmatch(r'[0-9a-f]{40}', args.source), 'invalid source SHA')
    require(re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', args.version), 'invalid iOS version')
    require(re.fullmatch(r'[1-9][0-9]{0,8}', args.build_number), 'invalid build number')


def app_info(app, args):
    for target, identifier in ((app, BUNDLE), (app / 'PlugIns/NotificationService.appex', NSE)):
        require(target.is_dir() and not target.is_symlink(), 'missing exact app/extension')
        info = plistlib.loads((target / 'Info.plist').read_bytes())
        require(info.get('CFBundleIdentifier') == identifier, 'bundle identity differs')
        require(info.get('CFBundleShortVersionString') == args.version and
                info.get('CFBundleVersion') == args.build_number, 'bundle version differs')
        require(info.get('CFBundleSupportedPlatforms') == ['iPhoneOS'], 'not a device build')
        executable = info.get('CFBundleExecutable', '')
        require(re.fullmatch(r'[A-Za-z0-9_-]+', executable), 'invalid executable name')
        require((target / executable).is_file(), 'missing executable')
    require({p.name for p in (app / 'PlugIns').iterdir()} == {'NotificationService.appex'}, 'unexpected extension')


def binding(args):
    origin = getattr(args, 'build_origin', None)
    if origin is None:
        origin = BuildOrigin(os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT'], os.environ['GITHUB_SHA'])
    require(isinstance(origin, BuildOrigin) and re.fullmatch(r'[1-9][0-9]{0,19}', origin.run_id)
            and re.fullmatch(r'[1-9][0-9]{0,19}', origin.run_attempt)
            and re.fullmatch(r'[0-9a-f]{40}', origin.workflow_sha), 'invalid original build identity')
    return {'schema': 'buzz-ios-build-v1', 'source': args.source, 'version': args.version,
            'build_number': args.build_number, 'bundle': BUNDLE, 'extension': NSE, 'team': TEAM,
            'overrides_sha256': common.hashlib.sha256(OVERRIDES.encode()).hexdigest(),
            'run_id': origin.run_id, 'run_attempt': origin.run_attempt,
            'workflow_sha': origin.workflow_sha}


def pack(args):
    inputs(args)
    app_info(args.app, args)
    require(Path('mobile/ios/Flutter/AppOverrides.xcconfig').read_text() == OVERRIDES, 'override differs')
    args.output.mkdir(mode=0o700)
    archive = args.output / 'unsigned-ios.app.tar.gz'
    with tarfile.open(archive, 'w:gz', dereference=False) as tf:
        tf.add(args.app, arcname='Buzz.app')
    with tarfile.open(archive, 'r:gz') as tf:
        common.safe_members(tf)
    receipt = binding(args)
    receipt['archive'] = common.record(archive)
    common.write_json(args.output / 'build-ios.json', receipt)


def check_build(args):
    inputs(args)
    require(not args.input.is_symlink(), 'unsafe input directory')
    archive = args.input / 'unsigned-ios.app.tar.gz'
    receipt_path = args.input / 'build-ios.json'
    require(receipt_path.is_file() and not receipt_path.is_symlink(), 'unsafe receipt')
    receipt = json.loads(receipt_path.read_text())
    expected = binding(args)
    expected['archive'] = common.record(archive)
    require(receipt == expected, 'unsigned receipt differs')
    return archive, receipt


def paths():
    run_id, attempt = os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT']
    require(re.fullmatch(r'[1-9][0-9]{0,19}', run_id) and re.fullmatch(r'[1-9][0-9]{0,19}', attempt), 'invalid run identity')
    root = Path(os.environ['RUNNER_TEMP']) / f'buzz-ios-signing-{run_id}-{attempt}'
    return root, Path.cwd() / 'signed-ios'


def prepare(args):
    archive, _ = check_build(args)
    root, output = paths()
    require(not os.path.lexists(root) and not os.path.lexists(output), 'stale release workspace')
    root.mkdir(mode=0o700)
    app = common.extract(archive, root / 'Payload')
    app_info(app, args)
    output.mkdir(mode=0o700)


def expected_entitlements(identifier):
    result = {'application-identifier': TEAM + '.' + identifier,
              'com.apple.developer.team-identifier': TEAM,
              'get-task-allow': False,
              'keychain-access-groups': [TEAM + '.' + BUNDLE],
              'com.apple.security.application-groups': [GROUP]}
    if identifier == BUNDLE:
        result.update({'aps-environment': 'production',
                       'com.apple.developer.devicecheck.appattest-environment': 'production',
                       'com.apple.developer.usernotifications.communication': True})
    return result


def profile_check(profile, identifier, certificate):
    require(profile.get('TeamIdentifier') == [TEAM] and profile.get('ApplicationIdentifierPrefix') == [TEAM], 'profile team differs')
    expiry = profile.get('ExpirationDate')
    require(isinstance(expiry, datetime.datetime) and expiry.replace(tzinfo=datetime.timezone.utc) > datetime.datetime.now(datetime.timezone.utc), 'profile expired')
    require('ProvisionedDevices' not in profile and not profile.get('ProvisionsAllDevices'), 'profile is not App Store')
    require(certificate in profile.get('DeveloperCertificates', []), 'profile certificate mismatch')
    permissions = profile.get('Entitlements', {})
    wanted = expected_entitlements(identifier)
    for key, value in wanted.items():
        actual = permissions.get(key)
        if key == 'keychain-access-groups':
            require(isinstance(actual, list) and all(v in actual or TEAM + '.*' in actual for v in value), 'profile keychain group differs')
        elif key == 'com.apple.developer.devicecheck.appattest-environment' and isinstance(actual, list):
            # Apple profiles authorize a set; the signed app still gets only production.
            require(all(type(item) is str for item in actual) and value in actual, 'profile App Attest permission differs')
        else:
            require(type(actual) is type(value) and actual == value, 'profile entitlement differs: ' + key)
    require(permissions.get('beta-reports-active') is True, 'profile lacks TestFlight reporting')
    wanted['beta-reports-active'] = True
    return wanted


@contextmanager
def hosted_keychain(keychain):
    # Each job has its own VM. No source process ever runs on the signing VM.
    require(os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'hosted signing VM required')
    def current():
        raw = run(['/usr/bin/security', 'list-keychains', '-d', 'user'])
        require(len(raw) <= 65536, 'keychain list exceeds bound')
        paths = []
        for line in raw.decode().splitlines():
            require(line.startswith('    "') and line.endswith('"'), 'invalid keychain list')
            paths.append(line[5:-1])
        return paths
    before = current()
    added = [*before, str(keychain)] if str(keychain) not in before else before
    try:
        common.security_command(['list-keychains', '-d', 'user', '-s', *added])
        require(current() == added, 'signing keychain visibility differs')
        yield
    finally:
        common.security_command(['list-keychains', '-d', 'user', '-s', *before])
        require(current() == before, 'keychain restoration differs')


def sign(args):
    require(os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'hosted signing VM required')
    archive, receipt = check_build(args)
    root, output = paths()
    app = root / 'Payload/Buzz.app'
    app_info(app, args)
    private = {name: os.environ.pop(name, '') for name in SECRETS[:4]}
    require(all(private.values()), 'missing protected iOS signing input')
    require(root.is_dir() and not root.is_symlink() and output.is_dir(), 'prepare must pass')
    p12 = root / 'distribution.p12'
    p12.write_bytes(base64.b64decode(private[SECRETS[0]], validate=True)); p12.chmod(0o600)
    keychain = root / 'signing.keychain-db'
    password = secrets.token_urlsafe(36)
    common.security_command(['create-keychain', '-p', password, str(keychain)])
    run(['/usr/bin/security', 'set-keychain-settings', '-lut', '7200', str(keychain)])
    common.security_command(['unlock-keychain', '-p', password, str(keychain)])
    common.security_command(['import', str(p12), '-k', str(keychain), '-P', private[SECRETS[1]], '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'])
    common.security_command(['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, str(keychain)])
    identities = run(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning', str(keychain)]).decode()
    found = re.findall(r'\b([0-9A-F]{40}) "((?:Apple Distribution|iPhone Distribution): [^"\n]+ \(' + TEAM + r'\))"', identities)
    require(len(found) == 1, 'expected one Distribution identity on approved team')
    identity, identity_name = found[0]
    # Match profiles against the exact imported certificate, not only its team.
    cert_pem = run(['/usr/bin/security', 'find-certificate', '-a', '-p', str(keychain)])
    blocks = re.findall(b'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', cert_pem, re.S)
    certificates = [run(['/usr/bin/openssl', 'x509', '-outform', 'DER'], input_data=pem) for pem in blocks]
    matching = [der for der in certificates if common.hashlib.sha1(der).hexdigest().upper() == identity]
    require(len(matching) == 1, 'imported certificate identity differs')
    certificate = matching[0]
    profiles = {}
    for identifier, target, field in ((BUNDLE, app, SECRETS[2]), (NSE, app / 'PlugIns/NotificationService.appex', SECRETS[3])):
        profile_file = target / 'embedded.mobileprovision'
        require(not profile_file.is_symlink(), 'unsafe embedded profile')
        profile_file.write_bytes(base64.b64decode(private[field], validate=True))
        profile = plistlib.loads(run(['/usr/bin/security', 'cms', '-D', '-i', str(profile_file)]))
        entitlements = profile_check(profile, identifier, certificate)
        ent_file = root / ('runner-entitlements.plist' if identifier == BUNDLE else 'nse-entitlements.plist')
        ent_file.write_bytes(plistlib.dumps(entitlements))
        profiles[identifier] = {'uuid': profile['UUID'], 'sha256': common.sha(profile_file), 'entitlements': entitlements}
    macho = []
    for path in app.rglob('*'):
        if path.is_file() and not path.is_symlink():
            with path.open('rb') as stream:
                if stream.read(4) in common.MACHO:
                    macho.append(path)
    require(macho, 'no Mach-O code')
    for path in macho:
        require(run(['/usr/bin/lipo', '-archs', str(path)]).decode().split() == ['arm64'], 'unexpected device architecture')
    nse = app / 'PlugIns/NotificationService.appex'
    targets = set(macho + [p for p in app.rglob('*') if p.is_dir() and not p.is_symlink() and p.suffix in ('.framework', '.bundle')])
    with hosted_keychain(keychain):
        for path in sorted(targets, key=lambda p: len(p.parts), reverse=True):
            run(['/usr/bin/codesign', '--force', '--sign', identity, '--keychain', str(keychain), '--timestamp=none', str(path)])
        for target, ent_file in ((nse, root / 'nse-entitlements.plist'), (app, root / 'runner-entitlements.plist')):
            run(['/usr/bin/codesign', '--force', '--sign', identity, '--keychain', str(keychain), '--timestamp=none', '--entitlements', str(ent_file), str(target)])
            run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(target)])
            actual = plistlib.loads(run(['/usr/bin/codesign', '--display', '--entitlements', '-', str(target)]))
            require(actual == plistlib.loads(ent_file.read_bytes()), 'signed entitlements differ')
    ipa = output / f'Buzz_{args.version}_{args.build_number}.ipa'
    run(['/usr/bin/ditto', '-c', '-k', '--keepParent', str(root / 'Payload'), str(ipa)])
    common.write_json(output / 'ios-release.json', {'schema': 'buzz-ios-release-v1', 'build': receipt,
                      'ipa': common.record(ipa), 'certificate_sha256': common.hashlib.sha256(certificate).hexdigest(),
                      'identity': identity_name, 'profiles': profiles, 'unsigned_archive_sha256': common.sha(archive)})


def upload(args):
    _, output = paths()
    receipt = json.loads((output / 'ios-release.json').read_text())
    require(receipt['build'] == json.loads((args.input / 'build-ios.json').read_text()), 'release source binding differs')
    check_build(args)
    ipa = output / f'Buzz_{args.version}_{args.build_number}.ipa'
    require(receipt['ipa'] == common.record(ipa), 'signed IPA changed')
    root, _ = paths()
    private = {name: os.environ.pop(name, '') for name in SECRETS[4:]}
    require(all(private.values()), 'missing retained ASC authentication')
    require(re.fullmatch(r'[A-Z0-9]{10}', private['ASC_KEY_ID']), 'invalid key ID')
    require(re.fullmatch(r'[0-9a-fA-F-]{36}', private['ASC_ISSUER_ID']), 'invalid issuer')
    key = private['ASC_API_KEY_P8'].strip().encode()
    if not key.startswith(b'-----BEGIN PRIVATE KEY-----'):
        key = base64.b64decode(key, validate=True)
    key_path = root / ('AuthKey_' + private['ASC_KEY_ID'] + '.p8')
    key_path.write_bytes(key); key_path.chmod(0o600)
    run(['/usr/bin/xcrun', 'altool', '--upload-app', '-f', str(ipa), '-t', 'ios',
         '--apiKey', private['ASC_KEY_ID'], '--apiIssuer', private['ASC_ISSUER_ID']],
        extra={'API_PRIVATE_KEYS_DIR': str(root)}, confidential=True)
    common.write_json(output / 'upload.json', {'schema': 'buzz-ios-upload-v1', 'ipa': common.record(ipa),
                      'source': args.source, 'version': args.version, 'build_number': args.build_number,
                      'upload_command_succeeded': True, 'processing_verified': False, 'installed_verified': False})


def cleanup():
    root, _ = paths()
    if not root.exists():
        return
    require(root.is_dir() and not root.is_symlink(), 'unsafe cleanup root')
    failed = False
    if (root / 'signing.keychain-db').exists():
        try:
            run(['/usr/bin/security', 'delete-keychain', str(root / 'signing.keychain-db')])
        except RuntimeError:
            failed = True
    for path in [root / 'distribution.p12', *root.glob('AuthKey_*.p8')]:
        path.unlink(missing_ok=True)
    require(not failed, 'could not remove run keychain')
    shutil.rmtree(root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['inputs', 'pack', 'prepare', 'sign', 'upload', 'cleanup'])
    parser.add_argument('--source', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--build-number', required=True)
    parser.add_argument('--app', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--input', type=Path, default=Path('unsigned'))
    args = parser.parse_args()
    inputs(args)
    if args.action == 'cleanup':
        cleanup()
    else:
        globals()[args.action](args)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Buzz iOS release operation failed; inspect the failed stage without exposing protected inputs.', file=sys.stderr)
        sys.exit(1)
