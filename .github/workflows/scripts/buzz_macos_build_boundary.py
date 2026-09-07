#!/usr/bin/env python3
"""Workflow client and unprivileged payload for the MBP build supervisor.

The dedicated build UID is the process/credential boundary. Seatbelt additionally
confines source/dependency writes and host file/IPC access. Never use it alone
under the signing UID: macOS permits same-UID KERN_PROCARGS2 environment reads.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys

SCRIPT = Path(__file__).resolve().parent
INSTALLED = Path('/usr/local/libexec/buzz-macos-build')
PAYLOAD_FILES = ('buzz_macos_build_boundary.py', 'buzz_macos_build_supervisor.py',
                 'buzz_macos_build.sh', 'buzz_macos_build.sb', 'buzz_macos_release.py',
                 'buzz-verify-macos-entitlements.sh', 'buzz_ios_build.sh', 'buzz_ios_release.py')
REQUEST_ENV = {
    'source_sha': 'SOURCE_SHA', 'version': 'VERSION', 'arch': 'ARCH',
    'updater_public_key': 'BUZZ_UPDATER_PUBLIC_KEY', 'updater_endpoint': 'BUZZ_UPDATER_ENDPOINT',
    'run_id': 'GITHUB_RUN_ID', 'run_attempt': 'GITHUB_RUN_ATTEMPT', 'workflow_sha': 'GITHUB_SHA',
}

IOS_REQUEST_ENV = {key: value for key, value in REQUEST_ENV.items()
                   if key not in ('updater_public_key', 'updater_endpoint')}
IOS_REQUEST_ENV['build_number'] = 'BUILD_NUMBER'

def request_env(arch):
    return IOS_REQUEST_ENV if arch == 'ios' else REQUEST_ENV

def build_env(root: Path, request: dict) -> dict[str, str]:
    env = {env_key: request[key] for key, env_key in request_env(request['arch']).items()}
    env.update(HOME=str(root / 'home'), TMPDIR=str(root / 'tmp') + '/',
               PATH='/usr/bin:/bin:/usr/sbin:/sbin', LANG='en_US.UTF-8', SHELL='/bin/bash',
               GITHUB_WORKSPACE=str(root), BUZZ_CONTROLLER=str(SCRIPT),
               CARGO_HOME=str(root / 'home/.cargo'), RUSTUP_HOME=str(root / 'home/.rustup'),
               XDG_CACHE_HOME=str(root / 'home/.cache'), CMAKE_POLICY_VERSION_MINIMUM='3.5',
               MACOSX_DEPLOYMENT_TARGET='10.15', CMAKE_OSX_DEPLOYMENT_TARGET='10.15')
    # Avoid CoreFoundation consulting the real user's text-encoding preference.
    env['__CF_USER_TEXT_ENCODING'] = f'0x{os.getuid():X}:0:0'
    if request['arch'] == 'ios':
        # CocoaPods is an existing approved Homebrew tool on the MBP.
        env['PATH'] = '/opt/homebrew/bin:' + env['PATH']
        env.pop('MACOSX_DEPLOYMENT_TARGET')
        env.pop('CMAKE_OSX_DEPLOYMENT_TARGET')
    return env


def sandbox_command(root: Path, command: list[str]) -> list[str]:
    return ['/usr/bin/sandbox-exec', '-D', 'BUILD_ROOT=' + str(root),
            '-D', 'CONTROLLER=' + str(SCRIPT), '-f', str(SCRIPT / 'buzz_macos_build.sb'),
            *command]


def confined(root: Path, request: dict, command: list[str], *, cwd: Path) -> None:
    # The privileged supervisor owns the UID, process cleanup, and build tree.
    subprocess.run(sandbox_command(root, command), cwd=cwd, env=build_env(root, request),
                   close_fds=True, check=True)


def payload(root: Path, request: dict) -> None:
    if pwd.getpwuid(os.geteuid()).pw_name != 'buzzbuild' or os.getuid() != os.geteuid():
        raise RuntimeError('payload requires the dedicated buzzbuild account')
    if set(os.getgroups()) & {0, 80}:
        raise RuntimeError('build account must not belong to wheel or admin')
    # Only public exact-source Git operations happen here, all inside Seatbelt.
    confined(root, request, ['/bin/bash', '--noprofile', '--norc', '-euc', '''
mkdir buzz
cd buzz
git init --quiet
git remote add origin https://github.com/only21mil/buzz.git
git -c credential.helper= fetch --depth 1 origin "$SOURCE_SHA"
git checkout --quiet --detach FETCH_HEAD
source bin/activate-hermit
if [[ "$ARCH" == ios ]]; then
  exec /bin/bash "$BUZZ_CONTROLLER/buzz_ios_build.sh"
fi
exec /bin/bash "$BUZZ_CONTROLLER/buzz_macos_build.sh"
'''], cwd=root)
    arch = request['arch']
    if arch == 'ios':
        confined(root, request, ['/usr/bin/python3', '-I', str(SCRIPT / 'buzz_ios_release.py'), 'pack',
                 '--app', 'mobile/build/ios/iphoneos/Runner.app', '--output', '../unsigned',
                 '--source', request['source_sha'], '--version', request['version'],
                 '--build-number', request['build_number']], cwd=root / 'buzz')
        return
    confined(root, request, ['/usr/bin/python3', '-I', str(SCRIPT / 'buzz_macos_release.py'), 'pack',
                           '--app', f'desktop/src-tauri/target/{arch}-apple-darwin/release/bundle/macos/Buzz.app',
                           '--output', '../unsigned', '--source', request['source_sha'],
                           '--version', request['version'], '--arch', arch], cwd=root / 'buzz')


def no_acl(path: Path) -> None:
    listing = subprocess.check_output(['/bin/ls', '-lde', str(path)], text=True)
    if len(listing.splitlines()) != 1 or '+' in listing.split()[0]:
        raise RuntimeError('build supervisor installation has an extended ACL')


def verify_installation() -> None:
    for directory in (INSTALLED, *INSTALLED.parents):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('build supervisor installation is not protected')
        no_acl(directory)
    for name in PAYLOAD_FILES:
        installed = INSTALLED / name
        info = installed.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('build supervisor payload is not protected')
        no_acl(installed)
        if hashlib.sha256(installed.read_bytes()).digest() != hashlib.sha256((SCRIPT / name).read_bytes()).digest():
            raise RuntimeError('installed build supervisor differs from the exact workflow checkout')


def client() -> None:
    if pwd.getpwuid(os.geteuid()).pw_name != 'm5mbp':
        raise RuntimeError('workflow must run on the MBP signing runner')
    verify_installation()
    request = {key: os.environ[env_key] for key, env_key in request_env(os.environ['ARCH']).items()}
    if (request['arch'] not in ('aarch64', 'x86_64', 'ios') or
            any(not re.fullmatch(r'[1-9][0-9]{0,19}', request[key])
                for key in ('run_id', 'run_attempt'))):
        raise RuntimeError('invalid build output identity')
    name = f"unsigned-{request['run_id']}-{request['run_attempt']}-{request['arch']}"
    output = Path(os.environ['GITHUB_WORKSPACE']).resolve(strict=True) / name
    output.mkdir(mode=0o700)  # Fail closed on every stale file, directory, or link.
    request['output_dir'] = str(output)
    subprocess.run(['/usr/bin/sudo', '-n', '/usr/bin/python3', '-I',
                    str(INSTALLED / 'buzz_macos_build_supervisor.py')],
                   input=json.dumps(request).encode(), check=True,
                   env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8'})


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--payload':
        payload(Path(sys.argv[2]).resolve(strict=True), json.load(sys.stdin))
    elif len(sys.argv) == 1:
        client()
    else:
        raise SystemExit('invalid build boundary invocation')
