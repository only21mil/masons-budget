#!/usr/bin/python3
"""Fixed sudo entrypoint. Never imports or executes workflow-controlled code as root."""
import base64
import ctypes
import contextlib
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
BUILD_HOME = Path('/private/var/db/buzz-macos-build-home')
CALLER = 'm5mbp'
BUILDER = 'buzzbuild'
FILES = ('buzz_macos_build_supervisor.py', 'buzz_macos_build_boundary.py',
         'buzz_macos_build.sh', 'buzz_macos_build.sb', 'buzz_macos_release.py',
         'buzz-verify-macos-entitlements.sh', 'buzz_ios_build.sh', 'buzz_ios_release.py')
FIELDS = {'source_sha', 'version', 'arch', 'updater_public_key', 'updater_endpoint',
          'run_id', 'run_attempt', 'workflow_sha', 'output_dir'}
IOS_FIELDS = (FIELDS - {'updater_public_key', 'updater_endpoint'}) | {'build_number'}
ENV = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8',
       'LC_ALL': 'en_US.UTF-8'}
PHASE = 'entry'
FAILURES = []
RECORDED_ERRORS = []

class BoundaryError(Exception):
    pass

def require(ok, message):
    if not ok:
        raise BoundaryError(message)

def phase(name):
    global PHASE
    PHASE = name

def record_failure(error, *, operation=None, category=None):
    if any(error is previous for previous in RECORDED_ERRORS) or len(FAILURES) >= 4:
        return
    RECORDED_ERRORS.append(error)
    allowed = {'BoundaryError', 'PermissionError', 'FileNotFoundError', 'FileExistsError',
               'BlockingIOError', 'OSError', 'CalledProcessError', 'TimeoutExpired',
               'ValueError', 'KeyError', 'TypeError', 'JSONDecodeError', 'InterruptedError'}
    name = type(error).__name__
    detail = {'phase': PHASE, 'class': name if name in allowed else 'other_exception'}
    for key in ('errno', 'returncode'):
        value = getattr(error, key, None)
        if type(value) is int and -(2**31) <= value < 2**31:
            detail[key] = value
    operations = {'ancestor_validation', 'directory_walk', 'acl_check', 'listdir',
                  'stat', 'open', 'fstat', 'close', 'rmdir', 'unlink'}
    categories = {'home', 'directory', 'regular_file', 'symlink', 'other_entry', 'unclassified_entry'}
    if operation in operations and category in categories:
        detail.update(operation=operation, category=category)
        euid = os.geteuid()
        if type(euid) is int and 0 <= euid < 2**32:
            detail['euid'] = euid
    FAILURES.append(detail)


def home_call(operation, category, function, *args, **kwargs):
    """Record only fixed HOME operation labels; propagate the original error."""
    try:
        return function(*args, **kwargs)
    except BaseException as error:
        record_failure(error, operation=operation, category=category)
        raise

@contextlib.contextmanager
def cleanup_signals():
    # Finish mandatory cleanup before reporting cancellation. Do not replace an
    # error already unwinding through the caller's finally block.
    unwinding = sys.exc_info()[0] is not None
    cancelled = False
    def defer_cancellation(_signum, _frame):
        nonlocal cancelled
        cancelled = True
    signals = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM)
    previous = {sig: signal.getsignal(sig) for sig in signals}
    try:
        for sig in signals:
            signal.signal(sig, defer_cancellation)
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    # A cleanup error propagates past this point without being replaced.
    if cancelled and not unwinding:
        raise BoundaryError('supervisor interrupted')

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
    require(type(request) is dict, 'invalid request object')
    fields = IOS_FIELDS if request.get('arch') == 'ios' else FIELDS
    require(set(request) == fields, 'invalid request fields')
    require(all(type(v) is str for v in request.values()), 'request values must be strings')
    for name in ('source_sha', 'workflow_sha'):
        require(re.fullmatch(r'[0-9a-f]{40}', request[name]), 'invalid commit')
    require(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?', request['version'])
            and len(request['version']) < 100, 'invalid version')
    require(request['arch'] in ('aarch64', 'x86_64', 'ios'), 'invalid architecture')
    for name in ('run_id', 'run_attempt'):
        require(re.fullmatch(r'[1-9][0-9]{0,19}', request[name]), 'invalid run identity')
    if request['arch'] == 'ios':
        require(re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', request['version']), 'invalid iOS version')
        require(re.fullmatch(r'[1-9][0-9]{0,8}', request['build_number']), 'invalid iOS build number')
    else:
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

def darwin_scratch_parent(builder):
    """Ask the OS as the fixed build UID; never accept a caller-supplied path."""
    require(builder.pw_uid == builder.pw_gid == 590, 'scratch requires dedicated UID/GID')
    def drop():
        os.setgroups([])
        os.setgid(builder.pw_gid)
        os.setuid(builder.pw_uid)
    paths = []
    for key in ('DARWIN_USER_TEMP_DIR', 'DARWIN_USER_CACHE_DIR'):
        result = subprocess.run(['/usr/bin/getconf', key], preexec_fn=drop, cwd='/', env=ENV,
                                close_fds=True, check=True, capture_output=True, text=True, timeout=10)
        paths.append(result.stdout.strip())
    return scratch_parent_from_paths(*paths)

def scratch_parent_from_paths(temp, cache):
    pattern = r'/(?:private/)?var/folders/([a-z0-9]{2})/([a-z0-9_]{20,64})/T/'
    match = re.fullmatch(pattern, temp)
    require(match is not None and cache == temp[:-2] + 'C/', 'unexpected Darwin scratch paths')
    return Path('/private/var/folders') / match[1] / match[2]

def scratch_identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid,
            stat.S_IMODE(info.st_mode), getattr(info, 'st_flags', 0))

def home_directory(expected):
    """Open only the installed home inode beneath root-controlled ancestors."""
    require(type(expected) is dict and set(expected) == {'path', 'identity'}
            and expected['path'] == str(BUILD_HOME), 'invalid builder home receipt')
    identity = expected['identity']
    require(type(identity) is list and len(identity) == 6
            and all(type(value) is int for value in identity)
            and identity[2:] == [590, 590, 0o700, 0], 'invalid builder home identity')
    home_call('ancestor_validation', 'home', root_path, BUILD_HOME.parent, True)
    fd = home_call('directory_walk', 'home', open_directory, BUILD_HOME)
    try:
        home_call('acl_check', 'home', no_acl, BUILD_HOME)
        info = home_call('fstat', 'home', os.fstat, fd)
        require(list(scratch_identity(info)) == identity, 'builder home identity changed')
        return fd
    except BaseException:
        home_call('close', 'home', os.close, fd)
        raise

def clear_builder_home(expected):
    """Called after UID drain under the lock; preserve the fixed home inode."""
    fd = home_directory(expected)
    device = expected['identity'][0]
    def clear(directory, path, category):
        for name in home_call('listdir', category, os.listdir, directory):
            info = home_call('stat', 'unclassified_entry', os.stat, name,
                             dir_fd=directory, follow_symlinks=False)
            require(info.st_uid == info.st_gid == 590 and info.st_dev == device
                    and not getattr(info, 'st_flags', 0), 'unsafe builder home entry')
            entry_category = ('directory' if stat.S_ISDIR(info.st_mode) else
                              'symlink' if stat.S_ISLNK(info.st_mode) else
                              'regular_file' if stat.S_ISREG(info.st_mode) else 'other_entry')
            home_call('acl_check', entry_category, no_acl, path / name)
            if stat.S_ISDIR(info.st_mode):
                child = home_call('open', 'directory', os.open, name,
                                  os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                try:
                    opened = home_call('fstat', 'directory', os.fstat, child)
                    require(scratch_identity(opened) == scratch_identity(info), 'builder home entry replaced')
                    clear(child, path / name, 'directory')
                finally:
                    home_call('close', 'directory', os.close, child)
                home_call('rmdir', 'directory', os.rmdir, name, dir_fd=directory)
            else:
                require(stat.S_ISLNK(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink == 1),
                        'special or multiply linked builder home entry')
                home_call('unlink', entry_category, os.unlink, name, dir_fd=directory)
        require(not home_call('listdir', category, os.listdir, directory), 'incomplete builder home cleanup')
    try:
        clear(fd, BUILD_HOME, 'home')
        info = home_call('fstat', 'home', os.fstat, fd)
        require(list(scratch_identity(info)) == expected['identity'], 'builder home changed during cleanup')
        checked = home_directory(expected)
        home_call('close', 'home', os.close, checked)
    finally:
        home_call('close', 'home', os.close, fd)

def scratch_snapshot(parent, uid, gid):
    """Attest the OS-owned ancestry and fixed, exclusively task-owned skeleton."""
    require(uid == gid == 590, 'scratch requires dedicated UID/GID')
    root_path(parent.parent, True)
    result = {}
    for relative, mode in (('.', 0o755), ('T', 0o700), ('C', 0o700),
                           ('T/com.apple.trustd', 0o700)):
        path = parent / relative
        if relative == 'T/com.apple.trustd' and not path.exists():
            continue
        fd = open_directory(path)
        try:
            info = os.fstat(fd)
            no_acl(path)
            require(info.st_uid == uid and info.st_gid == gid
                    and stat.S_IMODE(info.st_mode) == mode, 'unsafe Darwin scratch skeleton')
            result[relative] = scratch_identity(info)
        finally:
            os.close(fd)
    return result

def clear_darwin_scratch(parent, expected, uid, gid):
    # Call only under the supervisor lock after attesting an empty build UID.
    # macOS protects T/C and T/com.apple.trustd with sunlnk: retain those inodes
    # and flags. Never restore protected timestamps or carry source caches over.
    actual = scratch_snapshot(parent, uid, gid)
    require(all(actual.get(key) == value for key, value in expected.items()),
            'Darwin scratch skeleton changed')
    protected = {'T', 'C', 'T/com.apple.trustd'}
    def clear(fd, relative):
        for name in os.listdir(fd):
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            child = relative + '/' + name
            flags = getattr(info, 'st_flags', 0)
            require(not flags or child in protected, 'unexpected protected scratch entry')
            if stat.S_ISDIR(info.st_mode):
                nested = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    require(scratch_identity(os.fstat(nested)) == scratch_identity(info),
                            'scratch entry replaced')
                    clear(nested, child)
                finally:
                    os.close(nested)
                if child not in protected:
                    os.rmdir(name, dir_fd=fd)
            else:
                # Unlink links themselves; never follow source-controlled targets.
                os.unlink(name, dir_fd=fd)
    for relative in ('T', 'C'):
        fd = open_directory(parent / relative)
        try:
            require(scratch_identity(os.fstat(fd)) == actual[relative], 'scratch root replaced')
            clear(fd, relative)
        finally:
            os.close(fd)
    after = scratch_snapshot(parent, uid, gid)
    require(after == actual, 'Darwin scratch skeleton changed during cleanup')
    return after

def installed_manifest():
    root_path(INSTALL, True)
    root_path(STATE, True)
    root_path(INSTALL / 'installation.json')
    manifest = json.loads((INSTALL / 'installation.json').read_text())
    require(set(manifest) == {'schema', 'workflow_sha', 'files', 'builder_uid', 'builder_gid', 'caller_uid', 'builder_home'}, 'invalid installation receipt')
    require(manifest['schema'] == 2 and set(manifest['files']) == set(FILES), 'invalid installed file list')
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

def execute(root, request, builder, darwin_parent):
    read_fd, write_fd = os.pipe()
    log_read, log_write = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            phase('child_descriptors')
            os.close(write_fd)
            os.dup2(read_fd, 0)
            os.close(read_fd)
            # Do not inherit runner pipes, sockets, terminal, credentials, or root FDs.
            os.close(log_read)
            os.dup2(log_write, 1)
            os.dup2(log_write, 2)
            os.closerange(3, max(256, *map(int, os.listdir('/dev/fd'))) + 1)
            phase('child_privilege_drop')
            os.setsid()
            os.setgroups([])
            os.setgid(builder.pw_gid)
            os.setuid(builder.pw_uid)
            require(os.getuid() == builder.pw_uid and os.geteuid() == builder.pw_uid
                    and set(kernel_groups()) <= {builder.pw_gid}, 'failed privilege drop')
            os.chdir(root)
            env = dict(ENV, HOME=str(BUILD_HOME), CFFIXED_USER_HOME=str(BUILD_HOME), TMPDIR=str(root / 'tmp') + '/',
                       USER=BUILDER, LOGNAME=BUILDER, BUZZ_DARWIN_ROOT=str(darwin_parent))
            phase('child_fixed_exec')
            os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', str(INSTALL / 'buzz_macos_build_boundary.py'),
                                        '--payload', str(root)], env)
        except BaseException as error:
            record_failure(error)
            print('Buzz unsigned child metadata: ' + json.dumps(FAILURES, sort_keys=True), file=sys.stderr, flush=True)
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
    except BaseException as error:
        record_failure(error)
        drain_log(log_read, tail)
        report_log(tail)
        raise
    finally:
        try:
            with cleanup_signals():
                phase('child_cleanup_drain')
                stop_builder(builder.pw_uid, pid)
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass
        except BaseException as error:
            record_failure(error)
            raise
        finally:
            os.close(log_read)

def main():
    phase('entry')
    require(sys.platform == 'darwin' and os.geteuid() == 0 and len(sys.argv) == 1, 'fixed macOS root entrypoint only')
    os.umask(0o077)
    # Sudo is the sole attestation source; no caller identity comes from JSON.
    caller = pwd.getpwnam(CALLER)
    require(os.environ.get('SUDO_UID') == str(caller.pw_uid) and caller.pw_uid != 0, 'unauthorized caller')
    os.environ.clear()
    os.environ.update(ENV)
    phase('manifest')
    manifest = installed_manifest()
    phase('account_identity')
    builder = pwd.getpwnam(BUILDER)
    require(builder.pw_uid == manifest['builder_uid'] and builder.pw_gid == manifest['builder_gid']
            and caller.pw_uid == manifest['caller_uid'] and builder.pw_uid >= 500
            and builder.pw_uid != caller.pw_uid and builder.pw_shell == '/usr/bin/false'
            and builder.pw_dir == str(BUILD_HOME), 'host identity changed')
    phase('request')
    signal.alarm(10)
    try:
        request = request_from(sys.stdin.buffer)
    finally:
        signal.alarm(0)
    phase('workflow_identity')
    require(request['workflow_sha'] == manifest['workflow_sha'], 'workflow/host installation mismatch')
    phase('output_directory')
    output_fd = caller_output(request['output_dir'], caller.pw_uid)
    phase('lock_open')
    lock_fd = os.open(STATE / 'supervisor.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    root = None
    darwin_parent = None
    scratch = None
    scratch_started = False
    home_started = False
    try:
        phase('lock_identity')
        lock_info = os.fstat(lock_fd)
        require(lock_info.st_uid == 0 and stat.S_IMODE(lock_info.st_mode) == 0o600
                and stat.S_ISREG(lock_info.st_mode) and lock_info.st_nlink == 1, 'unsafe lock')
        phase('lock_acquire')
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        phase('uid_empty')
        require(not uid_processes(builder.pw_uid), 'dedicated build UID already active; operator recovery required')
        phase('home_identity')
        home_fd = home_directory(manifest['builder_home'])
        os.close(home_fd)
        home_started = True
        scratch_started = True
        phase('scratch_discovery')
        darwin_parent = darwin_scratch_parent(builder)
        # getconf can activate task-owned system services; drain before touching caches.
        phase('initial_drain')
        stop_builder(builder.pw_uid)
        phase('initial_home_clear')
        clear_builder_home(manifest['builder_home'])
        phase('scratch_snapshot')
        scratch = scratch_snapshot(darwin_parent, builder.pw_uid, builder.pw_gid)
        phase('initial_scratch_clear')
        scratch = clear_darwin_scratch(darwin_parent, scratch, builder.pw_uid, builder.pw_gid)
        phase('root_prepare')
        root = Path(tempfile.mkdtemp(prefix='build-', dir=STATE))
        for directory in (root, root / 'tmp'):
            if directory != root:
                directory.mkdir(mode=0o700)
            os.chown(directory, builder.pw_uid, builder.pw_gid)
        phase('payload_execution')
        execute(root, request, builder, darwin_parent)
        # No source descendants or cache state may survive into artifact export.
        phase('post_payload_home_clear')
        clear_builder_home(manifest['builder_home'])
        phase('post_payload_scratch_clear')
        scratch = clear_darwin_scratch(darwin_parent, scratch, builder.pw_uid, builder.pw_gid)
        phase('export')
        export_files(root, output_fd, builder.pw_uid, caller.pw_uid, caller.pw_gid, request['arch'])
    except BaseException as error:
        record_failure(error)
        raise
    finally:
        try:
            with cleanup_signals():
                if scratch_started or home_started:
                    # Failed cleanup preserves owned state and prohibits success.
                    phase('final_drain')
                    stop_builder(builder.pw_uid)
                    if home_started:
                        phase('final_home_clear')
                        clear_builder_home(manifest['builder_home'])
                    if scratch is not None:
                        phase('final_scratch_clear')
                        clear_darwin_scratch(darwin_parent, scratch, builder.pw_uid, builder.pw_gid)
                if root is not None:
                    phase('final_root_clear')
                    require(shutil.rmtree.avoids_symlink_attacks, 'safe tree cleanup unavailable')
                    shutil.rmtree(root)
        except BaseException as error:
            record_failure(error)
            raise
        finally:
            os.close(lock_fd)
            os.close(output_fd)

def interrupted(_signum, _frame):
    raise BoundaryError('supervisor interrupted')

if __name__ == '__main__':
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM):
        signal.signal(sig, interrupted)
    try:
        main()
    except BaseException as error:
        # Never echo attacker-controlled values, process arguments, or inherited secrets.
        record_failure(error)
        print('Buzz unsigned build boundary failed; no signing is authorized.', file=sys.stderr)
        print('Buzz unsigned boundary metadata: ' + json.dumps(FAILURES, sort_keys=True), file=sys.stderr)
        sys.exit(1)
