#!/usr/bin/python3
"""Operator-only prepare/install/upgrade/remove for the reviewed MBP build boundary.

Never granted to the GitHub runner via sudoers. Installation requires a separately
reviewed bundle manifest digest. This tool does not install development tools.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import grp
import shutil
import signal
import stat
import subprocess
import sys

INSTALL = Path('/usr/local/libexec/buzz-macos-build')
STATE = Path('/private/var/db/buzz-macos-build')
BUILD_HOME = Path('/private/var/db/buzz-macos-build-home')
SUDOERS = Path('/private/etc/sudoers.d/buzz-macos-build')
BUILDER_UID = 590
BUILDER_GID = 590
FILES = ('buzz_macos_build_supervisor.py', 'buzz_macos_build_boundary.py',
         'buzz_macos_build.sh', 'buzz_macos_build.sb', 'buzz_macos_release.py',
         'buzz-verify-macos-entitlements.sh', 'buzz_ios_build.sh', 'buzz_ios_release.py')
RULE = 'm5mbp ALL=(root) NOPASSWD: /usr/bin/python3 -I /usr/local/libexec/buzz-macos-build/buzz_macos_build_supervisor.py\n'
ENV = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8'}

def require(ok, message):
    if not ok:
        raise RuntimeError(message)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def command(argv):
    return subprocess.run(argv, env=ENV, check=True, capture_output=True, timeout=30).stdout

def protected(path):
    for item in (path, *path.parents):
        info = item.lstat()
        if sys.platform == 'darwin':
            require('+' not in command(['/bin/ls', '-lde', str(item)]).decode().split()[0], 'extended ACL on installation parent')
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'operator must resolve unprotected installation parent: ' + str(item))

def read_regular(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size < 2**20, 'invalid bundle file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(2**20)
        return data
    finally:
        os.close(fd)

def prepare(checkout, commit, bundle):
    require(os.geteuid() != 0, 'prepare must run as the operator without root')
    require(command(['/usr/bin/git', '-C', str(checkout), 'rev-parse', 'HEAD']).decode().strip() == commit,
            'checkout must be at the exact reviewed commit')
    require(not command(['/usr/bin/git', '-C', str(checkout), 'status', '--porcelain']), 'checkout must be clean')
    bundle.mkdir(mode=0o700)
    hashes = {}
    for name in FILES:
        data = command(['/usr/bin/git', '-C', str(checkout), 'show', commit + ':.github/workflows/scripts/' + name])
        (bundle / name).write_bytes(data)
        hashes[name] = digest(data)
    manifest = {'schema': 2, 'workflow_sha': commit, 'files': hashes}
    data = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    (bundle / 'bundle.json').write_bytes(data)
    print('bundle_manifest_sha256=' + digest(data))

def load_bundle(bundle, expected):
    manifest_bytes = read_regular(bundle / 'bundle.json')
    require(digest(manifest_bytes) == expected, 'bundle manifest differs from reviewed digest')
    manifest = json.loads(manifest_bytes)
    require(set(manifest) == {'schema', 'workflow_sha', 'files'} and manifest['schema'] == 2
            and set(manifest['files']) == set(FILES), 'invalid bundle manifest')
    require(len(manifest['workflow_sha']) == 40 and all(c in '0123456789abcdef' for c in manifest['workflow_sha']), 'invalid workflow commit')
    payload = {}
    for name in FILES:
        data = read_regular(bundle / name)
        require(digest(data) == manifest['files'][name], 'bundle file hash mismatch')
        payload[name] = data
    return manifest, payload

def create_file(path, data, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
        os.fchmod(fd, mode)
        os.fchown(fd, 0, 0)
        os.fsync(fd)
    finally:
        os.close(fd)

def publish_rule():
    # Publication and validation form one revocable step, including interrupted writes.
    signals = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM)
    previous = {sig: signal.getsignal(sig) for sig in signals}
    created = False
    def interrupted(_signum, _frame):
        raise InterruptedError('sudo rule publication interrupted')
    try:
        for sig in signals:
            signal.signal(sig, interrupted)
        require(not os.path.lexists(SUDOERS), 'sudo rule appeared before publication')
        created = True
        create_file(SUDOERS, RULE.encode(), 0o440)
        command(['/usr/sbin/visudo', '-c'])
    except BaseException:
        for sig in signals:
            signal.signal(sig, signal.SIG_IGN)
        if created and os.path.lexists(SUDOERS):
            SUDOERS.unlink()
        raise
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)

def absent_identity():
    for query, key in ((pwd.getpwnam, 'buzzbuild'), (pwd.getpwuid, BUILDER_UID),
                       (grp.getgrnam, 'buzzbuild'), (grp.getgrgid, BUILDER_GID)):
        try:
            query(key)
        except KeyError:
            continue
        raise RuntimeError('dedicated account or numeric UID/GID already exists; no adoption permitted')

def home_receipt():
    protected(BUILD_HOME.parent)
    fd = os.open(BUILD_HOME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(info.st_uid == info.st_gid == 590 and stat.S_IMODE(info.st_mode) == 0o700
                and not getattr(info, 'st_flags', 0), 'unsafe dedicated builder home')
        if sys.platform == 'darwin':
            require('+' not in command(['/bin/ls', '-lde', str(BUILD_HOME)]).decode().split()[0], 'builder home ACL changed')
        return {'path': str(BUILD_HOME), 'identity': [info.st_dev, info.st_ino, info.st_uid,
                info.st_gid, stat.S_IMODE(info.st_mode), getattr(info, 'st_flags', 0)]}
    finally:
        os.close(fd)

def create_home():
    protected(BUILD_HOME.parent)
    require(not os.path.lexists(BUILD_HOME), 'preexisting builder home; no adoption permitted')
    BUILD_HOME.mkdir(mode=0o700)
    os.chown(BUILD_HOME, 590, 590)
    return home_receipt()

def require_empty_home(expected):
    require(home_receipt() == expected, 'builder home identity changed')
    fd = os.open(BUILD_HOME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require([info.st_dev, info.st_ino] == expected['identity'][:2] and not os.listdir(fd),
                'builder home not empty; reviewed recovery required')
    finally:
        os.close(fd)

def installed_file(path, mode):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
            and stat.S_IMODE(info.st_mode) == mode and info.st_nlink == 1
            and not getattr(info, 'st_flags', 0), 'installed file identity changed')
    if sys.platform == 'darwin':
        require('+' not in command(['/bin/ls', '-lde', str(path)]).decode().split()[0], 'installed file ACL changed')
    return read_regular(path)

def account_attributes():
    # Public directory-service attributes only; never read a password or key.
    result = {}
    for name in ('UniqueID', 'PrimaryGroupID', 'UserShell', 'NFSHomeDirectory',
                 'AuthenticationAuthority', 'GeneratedUID', 'IsHidden'):
        raw = command(['/usr/bin/dscl', '.', '-read', '/Users/buzzbuild', name]).decode().strip()
        prefix = name + ':'
        require(raw.startswith(prefix), 'unexpected account attribute format')
        result[name] = raw[len(prefix):].strip()
    require(result['UniqueID'] == '590' and result['PrimaryGroupID'] == '590'
            and result['UserShell'] == '/usr/bin/false' and result['IsHidden'] == '1'
            and result['AuthenticationAuthority'] == ';DisabledUser;'
            and bool(result['GeneratedUID']), 'dedicated account attributes changed')
    require(grp.getgrnam('buzzbuild').gr_gid == 590
            and not any(group.gr_gid != 590 and 'buzzbuild' in group.gr_mem for group in grp.getgrall()),
            'dedicated group identity changed')
    return result

def upgrade(bundle, expected, from_commit, from_manifest):
    """One schema-1 to schema-2 transition; preserve the existing disabled account."""
    require(sys.platform == 'darwin' and os.geteuid() == 0, 'upgrade requires an approved macOS root operator')
    os.umask(0o077)
    manifest, payload = load_bundle(bundle, expected)
    for directory in (INSTALL, STATE, SUDOERS.parent, BUILD_HOME.parent):
        protected(directory)
    old_bytes = installed_file(STATE / 'installation.json', 0o600)
    require(digest(old_bytes) == from_manifest, 'predecessor manifest differs from reviewed digest')
    old = json.loads(old_bytes)
    require(set(old) == {'schema', 'workflow_sha', 'files', 'builder_uid', 'builder_gid', 'caller_uid'}
            and old['schema'] == 1 and old['workflow_sha'] == from_commit and set(old['files']) == set(FILES)
            and old['builder_uid'] == old['builder_gid'] == 590 and old['caller_uid'] == 501,
            'unsupported predecessor; exact legacy installation required')
    require(installed_file(INSTALL / 'installation.json', 0o644) == old_bytes, 'installation receipts differ')
    require(set(os.listdir(INSTALL)) == set(FILES) | {'installation.json'}, 'unexpected predecessor payload')
    for name in FILES:
        require(digest(installed_file(INSTALL / name, 0o644)) == old['files'][name], 'predecessor payload changed')
    require(installed_file(SUDOERS, 0o440) == RULE.encode(), 'predecessor sudo rule changed')
    require(installed_file(STATE / 'sudoers.candidate', 0o440) == RULE.encode(), 'predecessor sudo candidate changed')
    require(set(os.listdir(STATE)) == {'installation.json', 'sudoers.candidate', 'supervisor.lock'},
            'predecessor roots or partial operation require reviewed recovery')
    installed_file(STATE / 'supervisor.lock', 0o600)
    require(not os.path.lexists(BUILD_HOME), 'preexisting builder home; no adoption permitted')
    account = account_attributes()
    require(account['NFSHomeDirectory'] == '/var/empty' and pwd.getpwnam('m5mbp').pw_uid == 501,
            'predecessor home or caller changed')
    lock = os.open(STATE / 'supervisor.lock', os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Import only the already verified, root-controlled installed supervisor.
        sys.dont_write_bytecode = True
        spec = importlib.util.spec_from_file_location('installed_predecessor', INSTALL / 'buzz_macos_build_supervisor.py')
        predecessor = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(predecessor)
        require(not predecessor.uid_processes(590), 'dedicated UID active; upgrade refused')
        SUDOERS.unlink()
        # Receipt precedes any new-home or account mutation; failed upgrades stay revoked.
        preimage = {'from_manifest_sha256': from_manifest, 'from_manifest': old,
                    'to_bundle_sha256': expected, 'account': account, 'new_home_preimage': 'absent'}
        create_file(STATE / 'upgrade-preimage.json', (json.dumps(preimage, sort_keys=True, indent=2) + '\n').encode(), 0o600)
        predecessor.stop_builder(590)
        manifest.update(builder_uid=590, builder_gid=590, caller_uid=501, builder_home=create_home())
        command(['/usr/bin/dscl', '.', '-create', '/Users/buzzbuild', 'NFSHomeDirectory', str(BUILD_HOME)])
        require(account_attributes() == dict(account, NFSHomeDirectory=str(BUILD_HOME)),
                'unexpected account delta; entry remains revoked')
        require(pwd.getpwnam('buzzbuild').pw_dir == str(BUILD_HOME), 'registered builder home readback differs')
        require_empty_home(manifest['builder_home'])
        for name, data in payload.items():
            (INSTALL / name).unlink()
            create_file(INSTALL / name, data, 0o644)
        receipt = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
        for path, mode in ((INSTALL / 'installation.json', 0o644), (STATE / 'installation.json', 0o600)):
            path.unlink()
            create_file(path, receipt, mode)
        for name in FILES:
            require(digest(installed_file(INSTALL / name, 0o644)) == manifest['files'][name], 'new payload readback differs')
        require(installed_file(INSTALL / 'installation.json', 0o644) == receipt
                and installed_file(STATE / 'installation.json', 0o600) == receipt, 'new receipt readback differs')
        require_empty_home(manifest['builder_home'])
        require(not predecessor.uid_processes(590), 'dedicated UID restarted; entry remains revoked')
        command(['/usr/sbin/visudo', '-cf', str(STATE / 'sudoers.candidate')])
        publish_rule()
        print('upgraded_workflow_sha=' + manifest['workflow_sha'])
    finally:
        os.close(lock)

def install(bundle, expected):
    require(sys.platform == 'darwin' and os.geteuid() == 0, 'install requires an approved macOS root operator')
    os.umask(0o077)
    manifest, payload = load_bundle(bundle, expected)
    caller = pwd.getpwnam('m5mbp')
    require(caller.pw_uid >= 500 and caller.pw_uid != BUILDER_UID, 'unexpected caller identity')
    absent_identity()
    require(all(str(BUILDER_UID) not in row.split() for row in
                command(['/bin/ps', '-axo', 'ruid=,uid=']).decode().splitlines()), 'reserved UID has live processes')
    for parent in (INSTALL.parent, STATE.parent, SUDOERS.parent):
        if not parent.exists() and parent in (INSTALL.parent, SUDOERS.parent):
            protected(parent.parent)
            parent.mkdir(mode=0o755)
            parent.chmod(0o755)
        protected(parent)
    for path in (INSTALL, STATE, SUDOERS, BUILD_HOME):
        require(not os.path.lexists(path), 'preexisting installation must be reviewed and removed first')
    for program in ('/usr/bin/python3', '/usr/bin/sandbox-exec', '/usr/bin/git', '/usr/bin/curl',
                    '/usr/bin/openssl', '/usr/bin/xcrun', '/usr/bin/pkill', '/bin/ps', '/bin/bash'):
        require(os.access(program, os.X_OK), 'missing system tool: ' + program)
    command(['/usr/bin/xcrun', '--find', 'clang'])
    require(shutil.rmtree.avoids_symlink_attacks, 'safe cleanup unavailable')
    # Create a receipt before account changes so partial setup remains inspectable.
    STATE.mkdir(mode=0o711)
    STATE.chmod(0o711)
    manifest.update(builder_uid=BUILDER_UID, builder_gid=BUILDER_GID, caller_uid=caller.pw_uid,
                    builder_home=create_home())
    create_file(STATE / 'installation.json', (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode(), 0o600)
    command(['/usr/bin/dscl', '.', '-create', '/Groups/buzzbuild'])
    command(['/usr/bin/dscl', '.', '-create', '/Groups/buzzbuild', 'PrimaryGroupID', str(BUILDER_GID)])
    command(['/usr/bin/dscl', '.', '-create', '/Users/buzzbuild'])
    for key, value in (('UniqueID', str(BUILDER_UID)), ('PrimaryGroupID', str(BUILDER_GID)),
                       ('UserShell', '/usr/bin/false'), ('NFSHomeDirectory', str(BUILD_HOME)),
                       ('IsHidden', '1'), ('AuthenticationAuthority', ';DisabledUser;'), ('Password', '*')):
        command(['/usr/bin/dscl', '.', '-create', '/Users/buzzbuild', key, value])
    account = pwd.getpwnam('buzzbuild')
    require(account.pw_uid == BUILDER_UID and account.pw_gid == BUILDER_GID and account.pw_shell == '/usr/bin/false'
            and account.pw_dir == str(BUILD_HOME), 'account verification failed')
    require(not any(group.gr_gid != BUILDER_GID and 'buzzbuild' in group.gr_mem for group in grp.getgrall()), 'unexpected supplementary membership')
    INSTALL.mkdir(mode=0o755)
    INSTALL.chmod(0o755)
    for name, data in payload.items():
        create_file(INSTALL / name, data, 0o644)
    create_file(INSTALL / 'installation.json', (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode(), 0o644)
    # Validate the exact rule as a root-only candidate, then publish last.
    rule_candidate = STATE / 'sudoers.candidate'
    create_file(rule_candidate, RULE.encode(), 0o440)
    command(['/usr/sbin/visudo', '-cf', str(rule_candidate)])
    publish_rule()
    print('installed_workflow_sha=' + manifest['workflow_sha'])

def remove(expected_commit):
    require(sys.platform == 'darwin' and os.geteuid() == 0, 'remove requires an approved macOS root operator')
    protected(STATE)
    manifest = json.loads(read_regular(STATE / 'installation.json'))
    require(manifest['workflow_sha'] == expected_commit and manifest['builder_uid'] == BUILDER_UID
            and manifest['builder_gid'] == BUILDER_GID, 'rollback receipt mismatch')
    # Revoke entry first. Refuse unknown files and all live UID processes.
    if os.path.lexists(SUDOERS):
        require(read_regular(SUDOERS) == RULE.encode(), 'sudoers rule changed; operator reconciliation required')
        SUDOERS.unlink()
    result = command(['/bin/ps', '-axo', 'ruid=,uid=']).decode()
    require(all(str(BUILDER_UID) not in row.split() for row in result.splitlines()), 'live build UID; do not delete account')
    require(set(os.listdir(STATE)) <= {'installation.json', 'sudoers.candidate', 'supervisor.lock', 'upgrade-preimage.json'}, 'remaining build roots require reviewed recovery')
    account = pwd.getpwnam('buzzbuild')
    require(account.pw_uid == BUILDER_UID and account.pw_gid == BUILDER_GID
            and account.pw_shell == '/usr/bin/false', 'account identity changed')
    require(manifest['schema'] in (1, 2), 'unknown installed schema')
    if manifest['schema'] == 2:
        require(account.pw_dir == str(BUILD_HOME), 'registered builder home changed')
        require_empty_home(manifest['builder_home'])
    else:
        require(account.pw_dir == '/var/empty' and not os.path.lexists(BUILD_HOME), 'legacy home preimage changed')
    if INSTALL.exists():
        protected(INSTALL)
        require(set(os.listdir(INSTALL)) == set(FILES) | {'installation.json'}, 'installation file set changed')
        for name in FILES:
            require(digest(read_regular(INSTALL / name)) == manifest['files'][name], 'installation bytes changed')
        shutil.rmtree(INSTALL)
    command(['/usr/bin/dscl', '.', '-delete', '/Users/buzzbuild'])
    command(['/usr/bin/dscl', '.', '-delete', '/Groups/buzzbuild'])
    if manifest['schema'] == 2:
        require_empty_home(manifest['builder_home'])
        BUILD_HOME.rmdir()
    shutil.rmtree(STATE)
    command(['/usr/sbin/visudo', '-c'])
    print('removed_workflow_sha=' + expected_commit)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--checkout', type=Path, required=True)
    p.add_argument('--commit', required=True)
    p.add_argument('--bundle', type=Path, required=True)
    p = sub.add_parser('install')
    p.add_argument('--bundle', type=Path, required=True)
    p.add_argument('--manifest-sha256', required=True)
    p = sub.add_parser('remove')
    p.add_argument('--commit', required=True)
    p = sub.add_parser('upgrade')
    p.add_argument('--bundle', type=Path, required=True)
    p.add_argument('--manifest-sha256', required=True)
    p.add_argument('--from-commit', required=True)
    p.add_argument('--from-manifest-sha256', required=True)
    args = parser.parse_args()
    if args.action == 'prepare':
        prepare(args.checkout, args.commit, args.bundle)
    elif args.action == 'install':
        install(args.bundle, args.manifest_sha256)
    elif args.action == 'upgrade':
        upgrade(args.bundle, args.manifest_sha256, args.from_commit, args.from_manifest_sha256)
    else:
        remove(args.commit)
