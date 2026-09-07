#!/usr/bin/python3
"""Fixed sudo entrypoint. Never imports or executes workflow-controlled code as root."""
import base64
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

INSTALL = Path('/usr/local/libexec/buzz-macos-build')
STATE = Path('/private/var/db/buzz-macos-build')
CALLER = 'm5mbp'
BUILDER = 'buzzbuild'
FILES = ('buzz_macos_build_supervisor.py', 'buzz_macos_build_boundary.py',
         'buzz_macos_build.sh', 'buzz_macos_build.sb', 'buzz_macos_release.py',
         'buzz-verify-macos-entitlements.sh')
FIELDS = {'source_sha', 'version', 'arch', 'updater_public_key', 'updater_endpoint',
          'run_id', 'run_attempt', 'workflow_sha', 'output_dir'}
ENV = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8',
       'LC_ALL': 'en_US.UTF-8'}

class BoundaryError(Exception):
    pass

def require(ok, message):
    if not ok:
        raise BoundaryError(message)

def kernel_groups():
    # On macOS Python getgroups() returns directory-service access groups, not
    # the credentials changed by setgroups(). libc reports the kernel groups;
    # Darwin includes the primary GID even after supplementary groups are cleared.
    function = ctypes.CDLL(None, use_errno=True).getgroups
    function.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint)]
    function.restype = ctypes.c_int
    count = function(0, None)
    require(0 <= count <= 1024, 'cannot read kernel groups')
    groups = (ctypes.c_uint * max(count, 1))()
    require(function(count, groups) == count, 'kernel groups changed during read')
    return list(groups)[:count]

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON key')
        result[key] = value
    return result

def request_from(stream):
    raw = stream.read(16385)
    require(len(raw) <= 16384, 'request too large')
    request = json.loads(raw, object_pairs_hook=unique_object)
    require(type(request) is dict and set(request) == FIELDS, 'invalid request fields')
    require(all(type(v) is str for v in request.values()), 'request values must be strings')
    for name in ('source_sha', 'workflow_sha'):
        require(re.fullmatch(r'[0-9a-f]{40}', request[name]), 'invalid commit')
    require(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?', request['version'])
            and len(request['version']) < 100, 'invalid version')
    require(request['arch'] in ('aarch64', 'x86_64'), 'invalid architecture')
    for name in ('run_id', 'run_attempt'):
        require(re.fullmatch(r'[1-9][0-9]{0,19}', request[name]), 'invalid run identity')
    require(re.fullmatch(r'[A-Za-z0-9+/=]{20,2048}', request['updater_public_key']), 'invalid public key')
    require(request['updater_endpoint'] == 'https://github.com/only21mil/buzz/releases/download/buzz-desktop-latest/latest.json',
            'invalid updater endpoint')
    require(request['output_dir'].startswith('/') and len(request['output_dir']) < 1024, 'invalid output directory')
    return request

def open_directory(path):
    """Walk each component without following symlinks, including parent components."""
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, 'unsafe directory path')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise

def no_acl(path):
    if sys.platform == 'darwin':
        result = subprocess.run(['/bin/ls', '-lde', str(path)], env=ENV,
                                check=True, capture_output=True, text=True, timeout=10)
        require('+' not in result.stdout.split()[0], 'extended ACL on protected path')

def root_path(path, directory=False):
    """Every ancestor must resist replacement by the build UID or the caller."""
    for item in reversed((path, *path.parents)):
        info = item.lstat()
        no_acl(item)
        require(info.st_uid == 0 and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode),
                'installation/state path is not root controlled')
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'wrong installed file type')
    return info

def installed_manifest():
    root_path(INSTALL, True)
    root_path(STATE, True)
    root_path(INSTALL / 'installation.json')
    manifest = json.loads((INSTALL / 'installation.json').read_text())
    require(set(manifest) == {'schema', 'workflow_sha', 'files', 'builder_uid', 'builder_gid', 'caller_uid'}, 'invalid installation receipt')
    require(manifest['schema'] == 1 and set(manifest['files']) == set(FILES), 'invalid installed file list')
    for name in FILES:
        root_path(INSTALL / name)
        require(hashlib.sha256((INSTALL / name).read_bytes()).hexdigest() == manifest['files'][name], 'installed payload hash mismatch')
    return manifest

def caller_output(path, uid):
    fd = open_directory(path)
    try:
        info = os.fstat(fd)
        require(info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700, 'output directory must be caller-owned mode 0700')
        require(not os.listdir(fd), 'output directory is not empty')
        return fd
    except BaseException:
        os.close(fd)
        raise

def uid_processes(uid):
    result = subprocess.run(['/bin/ps', '-axo', 'pid=,ruid=,uid='], env=ENV,
                            check=True, capture_output=True, text=True, timeout=10)
    found = []
    for line in result.stdout.splitlines():
        fields = line.split()
        require(len(fields) == 3 and all(v.isdigit() for v in fields), 'cannot attest process ownership')
        pid, real, effective = map(int, fields)
        if uid in (real, effective):
            found.append(pid)
    return found

def stop_builder(uid, child_pid=None):
    require(uid == 590, 'cleanup requires the dedicated build UID')
    # pkill matches the UID at kill time, avoiding root kill-by-stale-PID races.
    for _ in range(30):
        for selector in ('-U', '-u'):
            result = subprocess.run(['/usr/bin/pkill', '-KILL', selector, str(uid), '.'], env=ENV,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            require(result.returncode in (0, 1), 'cannot terminate dedicated build UID')
        if child_pid is not None:
            try:
                os.waitpid(child_pid, os.WNOHANG)
            except ChildProcessError:
                pass
        # Killing distnoted alone lets launchd restart it after empty ps reads.
        # Retire only this task-owned user domain after killing source processes.
        # Do not `launchctl print user/590`: that query recreates the user domain.
        result = subprocess.run(['/bin/launchctl', 'bootout', 'user/590'], env=ENV,
                                capture_output=True, timeout=10)
        require(result.returncode == 0, 'cannot retire dedicated build user domain')
        if not uid_processes(uid):
            time.sleep(0.1)
            if not uid_processes(uid):
                return
        time.sleep(0.1)
    raise BoundaryError('dedicated build UID still has processes; export prohibited')

def export_files(root, output_fd, uid, caller_uid, caller_gid, arch):
    source_fd = open_directory(root / 'unsigned')
    created = []
    try:
        names = (f'unsigned-{arch}.app.tar.gz', f'build-{arch}.json')
        require(set(os.listdir(source_fd)) == set(names), 'unexpected build output files')
        for name, limit in zip(names, (4 * 1024**3, 1024**2)):
            incoming = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd)
            try:
                info = os.fstat(incoming)
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == uid
                        and 0 < info.st_size <= limit, 'unsafe build output')
                outgoing = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                   0o600, dir_fd=output_fd)
                created.append(name)
                try:
                    remaining = info.st_size
                    while remaining:
                        chunk = os.read(incoming, min(1024**2, remaining))
                        require(bool(chunk), 'short build output')
                        offset = 0
                        while offset < len(chunk):
                            offset += os.write(outgoing, chunk[offset:])
                        remaining -= len(chunk)
                    require(not os.read(incoming, 1), 'build output changed during export')
                    os.fsync(outgoing)
                    os.fchown(outgoing, caller_uid, caller_gid)
                finally:
                    os.close(outgoing)
            finally:
                os.close(incoming)
    except BaseException:
        for name in created:
            try:
                os.unlink(name, dir_fd=output_fd)
            except FileNotFoundError:
                pass
        raise
    finally:
        os.close(source_fd)

def drain_log(fd, tail):
    # Fixed work per poll prevents a continuously writing child from hiding timeout.
    for _ in range(16):
        try:
            chunk = os.read(fd, 16384)
        except BlockingIOError:
            break
        if not chunk:
            break
        tail.extend(chunk)
        del tail[:-65536]

def report_log(tail):
    if tail:
        # Base64 cannot inject GitHub workflow commands or terminal control bytes.
        print('Buzz unsigned diagnostic tail (base64): ' + base64.b64encode(tail).decode('ascii'), file=sys.stderr)

def execute(root, request, builder):
    read_fd, write_fd = os.pipe()
    log_read, log_write = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(write_fd)
            os.dup2(read_fd, 0)
            os.close(read_fd)
            # Do not inherit runner pipes, sockets, terminal, credentials, or root FDs.
            os.close(log_read)
            os.dup2(log_write, 1)
            os.dup2(log_write, 2)
            os.closerange(3, max(256, *map(int, os.listdir('/dev/fd'))) + 1)
            os.setsid()
            os.setgroups([])
            os.setgid(builder.pw_gid)
            os.setuid(builder.pw_uid)
            require(os.getuid() == builder.pw_uid and os.geteuid() == builder.pw_uid
                    and set(kernel_groups()) <= {builder.pw_gid}, 'failed privilege drop')
            os.chdir(root)
            env = dict(ENV, HOME=str(root / 'home'), TMPDIR=str(root / 'tmp') + '/',
                       USER=BUILDER, LOGNAME=BUILDER)
            os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', str(INSTALL / 'buzz_macos_build_boundary.py'),
                                        '--payload', str(root)], env)
        except BaseException:
            os._exit(125)
    os.close(read_fd)
    os.close(log_write)
    os.set_blocking(log_read, False)
    tail = bytearray()
    try:
        payload = json.dumps(request).encode()
        require(len(payload) < 16384, 'payload too large')
        with os.fdopen(write_fd, 'wb') as stream:
            stream.write(payload)
        deadline = time.monotonic() + 7200
        while time.monotonic() < deadline:
            drain_log(log_read, tail)
            found, status = os.waitpid(pid, os.WNOHANG)
            if found:
                drain_log(log_read, tail)
                require(os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, 'unsigned build failed')
                return
            time.sleep(0.25)
        raise BoundaryError('unsigned build timed out')
    except BaseException:
        drain_log(log_read, tail)
        report_log(tail)
        raise
    finally:
        try:
            stop_builder(builder.pw_uid, pid)
            try:
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass
        finally:
            os.close(log_read)

def main():
    require(sys.platform == 'darwin' and os.geteuid() == 0 and len(sys.argv) == 1, 'fixed macOS root entrypoint only')
    os.umask(0o077)
    # Sudo is the sole attestation source; no caller identity comes from JSON.
    caller = pwd.getpwnam(CALLER)
    require(os.environ.get('SUDO_UID') == str(caller.pw_uid) and caller.pw_uid != 0, 'unauthorized caller')
    os.environ.clear()
    os.environ.update(ENV)
    manifest = installed_manifest()
    builder = pwd.getpwnam(BUILDER)
    require(builder.pw_uid == manifest['builder_uid'] and builder.pw_gid == manifest['builder_gid']
            and caller.pw_uid == manifest['caller_uid'] and builder.pw_uid >= 500
            and builder.pw_uid != caller.pw_uid and builder.pw_shell == '/usr/bin/false', 'host identity changed')
    signal.alarm(10)
    try:
        request = request_from(sys.stdin.buffer)
    finally:
        signal.alarm(0)
    require(request['workflow_sha'] == manifest['workflow_sha'], 'workflow/host installation mismatch')
    output_fd = caller_output(request['output_dir'], caller.pw_uid)
    lock_fd = os.open(STATE / 'supervisor.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    root = None
    try:
        lock_info = os.fstat(lock_fd)
        require(lock_info.st_uid == 0 and stat.S_IMODE(lock_info.st_mode) == 0o600
                and stat.S_ISREG(lock_info.st_mode) and lock_info.st_nlink == 1, 'unsafe lock')
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(not uid_processes(builder.pw_uid), 'dedicated build UID already active; operator recovery required')
        root = Path(tempfile.mkdtemp(prefix='build-', dir=STATE))
        for directory in (root, root / 'home', root / 'tmp'):
            if directory != root:
                directory.mkdir(mode=0o700)
            os.chown(directory, builder.pw_uid, builder.pw_gid)
        execute(root, request, builder)
        # execute has killed and attested all UID descendants before any root file reads.
        export_files(root, output_fd, builder.pw_uid, caller.pw_uid, caller.pw_gid, request['arch'])
    finally:
        if root is not None:
            # A failed drain preserves the root for operator recovery and fails closed.
            stop_builder(builder.pw_uid)
            require(shutil.rmtree.avoids_symlink_attacks, 'safe tree cleanup unavailable')
            shutil.rmtree(root)
        os.close(lock_fd)
        os.close(output_fd)

def interrupted(_signum, _frame):
    raise BoundaryError('supervisor interrupted')

if __name__ == '__main__':
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM):
        signal.signal(sig, interrupted)
    try:
        main()
    except BaseException:
        # Never echo attacker-controlled values, process arguments, or inherited secrets.
        print('Buzz unsigned build boundary failed; no signing is authorized.', file=sys.stderr)
        sys.exit(1)
