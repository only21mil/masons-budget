#!/usr/bin/python3
"""One-use MBP rmdir experiment. Operator installation is never a sudoers entry."""
import contextlib
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import signal
import stat
import subprocess
import sys
import time
import types

INSTALL = Path('/usr/local/libexec/buzz-macos-build')
STATE = Path('/private/var/db/buzz-macos-build')
HOME_PATH = Path('/private/var/db/buzz-macos-build-home')
TARGET = INSTALL / 'buzz_macos_build_supervisor.py'
PACKET = Path('/private/var/db/buzz-home-rmdir-diagnostic-20260908')
BACKUP = PACKET / 'supervisor.original.py'
STAGED = PACKET / 'diagnostic.py'
ATTEMPT = PACKET / 'ATTEMPT'
SWAP = INSTALL / '.buzz-home-rmdir-diagnostic-swap'
SUDOERS = Path('/private/etc/sudoers.d/buzz-macos-build')
ORIGINAL_SHA = 'c0d6fcd6d5922b61353e07e4402932099efa8004803c8d09305e2273237a3ef7'
RECEIPT_SHA = '5a60649f517e6b8db3463e53c5e1af2740107dc19b45410d5be6d3959c84e8e7'
SUDOERS_SHA = 'c7085016bb14a1454cf9af466604888e0c9154e7562f02a91be28156704bc308'
HOME_ID = (16777234, 8730116, 590, 590, 0o700, 0)
PARENT_ID = (16777234, 8962577, 590, 590, 0o700, 0)
LEAF_ID = (16777234, 8962578, 590, 590, 0o700, 0)
LOCK_INODE = 8606499
ATTEMPTS = []
RESTORED = False
SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM)
ENV = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8', 'LC_ALL': 'en_US.UTF-8'}


class DiagnosticError(Exception):
    pass


def require(ok):
    if not ok:
        raise DiagnosticError('fixed diagnostic precondition failed')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def no_acl(path):
    if sys.platform == 'darwin':
        result = subprocess.run(['/bin/ls', '-lde', str(path)], env=ENV, stdin=subprocess.DEVNULL,
                                check=True, capture_output=True, text=True, timeout=10)
        require('+' not in result.stdout.split()[0])


def protected(path):
    for item in (path, *path.parents):
        info = item.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and not info.st_mode & 0o022 and not getattr(info, 'st_flags', 0))
        no_acl(item)


def read_file(path, mode, expected=None):
    protected(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
                and stat.S_IMODE(info.st_mode) == mode and info.st_nlink == 1
                and not getattr(info, 'st_flags', 0) and info.st_size < 2**20)
        no_acl(path)
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(2**20)
        require(expected is None or digest(data) == expected)
        return data
    finally:
        os.close(fd)


def original():
    # Load held bytes only after exact hash and root-controlled ancestry checks.
    current = read_file(TARGET, 0o644)
    data = current if digest(current) == ORIGINAL_SHA else read_file(BACKUP, 0o600, ORIGINAL_SHA)
    module = types.ModuleType('pinned_original_supervisor')
    exec(compile(data, '<pinned original supervisor>', 'exec'), module.__dict__)
    return module


def attest(base, temporary):
    installed = read_file(INSTALL / 'installation.json', 0o644, RECEIPT_SHA)
    require(read_file(STATE / 'installation.json', 0o600, RECEIPT_SHA) == installed)
    manifest = json.loads(installed)
    require(manifest['workflow_sha'] == 'dca2a86e4a874ab0421d1067b57bca4b4279ca51')
    require(set(manifest['files']) == set(base.FILES))
    for name, expected in manifest['files'].items():
        if temporary and name == TARGET.name:
            # This target is intentionally diagnostic code, not an attested dca payload.
            expected = digest(read_file(STAGED, 0o644))
        read_file(INSTALL / name, 0o644, expected)
    read_file(SUDOERS, 0o440, SUDOERS_SHA)
    require(pwd.getpwnam('m5mbp').pw_uid == 501)
    builder = pwd.getpwnam('buzzbuild')
    require(builder.pw_uid == builder.pw_gid == 590 and builder.pw_shell == '/usr/bin/false'
            and builder.pw_dir == str(HOME_PATH))


@contextlib.contextmanager
def locked(base):
    base.root_path(STATE, True)
    fd = os.open(STATE / 'supervisor.lock', os.O_RDWR | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1
                and info.st_ino == LOCK_INODE and not getattr(info, 'st_flags', 0))
        no_acl(STATE / 'supervisor.lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(not base.uid_processes(590))
        yield
    finally:
        os.close(fd)


def identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid,
            stat.S_IMODE(info.st_mode), getattr(info, 'st_flags', 0))


def stable(info):
    return identity(info) + (info.st_nlink, info.st_mtime_ns, info.st_ctime_ns)


def checked_parent(base):
    home = base.home_directory({'path': str(HOME_PATH), 'identity': list(HOME_ID)})
    try:
        parent = os.open('Library', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=home)
    finally:
        os.close(home)
    try:
        require(identity(os.fstat(parent)) == PARENT_ID)
        no_acl(HOME_PATH / 'Library')
        return parent
    except BaseException:
        os.close(parent)
        raise


def snapshot(parent):
    require(identity(os.fstat(parent)) == PARENT_ID)
    before = os.stat('Preferences', dir_fd=parent, follow_symlinks=False)
    require(identity(before) == LEAF_ID and stat.S_ISDIR(before.st_mode))
    child = os.open('Preferences', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        require(stable(os.fstat(child)) == stable(before) and not os.listdir(child))
        no_acl(HOME_PATH / 'Library' / 'Preferences')
        no_acl(HOME_PATH / 'Library')
        return stable(os.fstat(parent)), stable(os.fstat(child))
    finally:
        os.close(child)


def absent(parent):
    try:
        os.stat('Preferences', dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return True
    return False


def child_descriptors(parent, report):
    require(parent >= 3 and report >= 3 and parent != report)
    null = os.open('/dev/null', os.O_RDWR)
    try:
        for fd in (0, 1, 2):
            os.dup2(null, fd)
    finally:
        os.close(null)
    # fork inherits even non-inheritable descriptors; explicitly retain only these capabilities.
    for fd in map(int, os.listdir('/dev/fd')):
        if fd > 2 and fd not in (parent, report):
            try:
                os.close(fd)
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise


def child_result(base, parent, uid):
    if uid == 590:
        os.setgroups([])
        os.setgid(590)
        os.setuid(590)
    require(os.getuid() == os.geteuid() == uid)
    if uid == 590:
        require(os.getgid() == os.getegid() == 590 and set(base.kernel_groups()) <= {590})
    result = {'euid': os.geteuid(), 'uid': os.getuid(), 'pid': os.getpid(), 'ppid': os.getppid(),
              'operation': 'rmdir', 'category': 'fixed_empty_home_leaf', 'errno': 0}
    try:
        os.rmdir('Preferences', dir_fd=parent)
    except OSError as error:
        require(type(error.errno) is int and 0 < error.errno < 2**31)
        result['errno'] = error.errno
    return result


def attempt(base, parent, uid):
    require(uid in (0, 590))
    read_fd, report = os.pipe()
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
    try:
        pid = os.fork()
    except BaseException:
        os.close(read_fd)
        os.close(report)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        raise
    if pid == 0:
        try:
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM):
                signal.signal(sig, signal.SIG_DFL)
            child_descriptors(parent, report)
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            result = child_result(base, parent, uid)
            payload = json.dumps(result, sort_keys=True).encode()
            require(len(payload) < 1024 and os.write(report, payload) == len(payload))
            os._exit(0)
        except BaseException:
            os._exit(125)
    reaped = False
    try:
        os.close(report)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            # Keep cancellation from losing ownership state after waitpid reaps.
            previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
            try:
                found, status = os.waitpid(pid, os.WNOHANG)
                if found:
                    reaped = True
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            if found:
                require(os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0)
                break
            time.sleep(0.02)
        require(reaped)
        data = os.read(read_fd, 1025)
        require(len(data) < 1024)
        result = json.loads(data)
        require(set(result) == {'euid', 'uid', 'pid', 'ppid', 'operation', 'category', 'errno'})
        require(all(type(result[key]) is int for key in ('euid', 'uid', 'pid', 'ppid', 'errno')))
        require(result['euid'] == result['uid'] == uid and result['pid'] == pid
                and result['ppid'] == os.getpid() and result['operation'] == 'rmdir'
                and result['category'] == 'fixed_empty_home_leaf'
                and 0 <= result['errno'] < 2**31)
        return result
    finally:
        if not reaped:
            with base.cleanup_signals():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
        os.close(read_fd)


def experiment(base):
    parent = checked_parent(base)
    try:
        before = snapshot(parent)
        results = ATTEMPTS
        results.append(attempt(base, parent, 0))
        if results[0]['errno'] == errno.EPERM:
            require(snapshot(parent) == before and not base.uid_processes(590))
            results.append(attempt(base, parent, 590))
        if results[-1]['errno'] == 0:
            require(absent(parent) and identity(os.fstat(parent)) == PARENT_ID)
        else:
            require(snapshot(parent) == before)
        checked = checked_parent(base)
        os.close(checked)
        return results
    finally:
        os.close(parent)


def create_fd(path, mode):
    # Set modes at creation; HOME ownership, permissions and flags are never changed.
    previous = os.umask(0)
    try:
        return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    finally:
        os.umask(previous)


def write_fd(fd, data):
    with os.fdopen(fd, 'wb', closefd=False) as stream:
        stream.write(data)
        stream.flush()
    os.fsync(fd)


def create_file(path, data, mode):
    fd = create_fd(path, mode)
    try:
        write_fd(fd, data)
    finally:
        os.close(fd)


def replace_target(data):
    owned = None
    try:
        fd = create_fd(SWAP, 0o644)
        try:
            info = os.fstat(fd)
            owned = (info.st_dev, info.st_ino)
            write_fd(fd, data)
        finally:
            os.close(fd)
        read_file(SWAP, 0o644, digest(data))
        os.replace(SWAP, TARGET)
    finally:
        if owned is not None and os.path.lexists(SWAP):
            info = SWAP.lstat()
            require((info.st_dev, info.st_ino) == owned)
            os.unlink(SWAP)


def restore(base):
    global RESTORED
    current = read_file(TARGET, 0o644)
    if digest(current) != ORIGINAL_SHA:
        require(current == read_file(STAGED, 0o644))
        replace_target(read_file(BACKUP, 0o600, ORIGINAL_SHA))
    attest(base, False)
    RESTORED = True


def install(base, wrapper):
    with locked(base):
        attest(base, False)
        parent = checked_parent(base)
        try:
            snapshot(parent)
        finally:
            os.close(parent)
        require(not os.path.lexists(PACKET))
        try:
            with base.cleanup_signals():
                PACKET.mkdir(mode=0o700)
                create_file(BACKUP, read_file(TARGET, 0o644, ORIGINAL_SHA), 0o600)
                create_file(STAGED, wrapper, 0o644)
                replace_target(wrapper)
                attest(base, True)
        except BaseException:
            with base.cleanup_signals():
                restore(base)
            raise


def diagnostic(base):
    with locked(base):
        try:
            attest(base, True)
            signal.alarm(2)
            try:
                require(sys.stdin.buffer.read(1) == b'')
            finally:
                signal.alarm(0)
            create_file(ATTEMPT, b'consumed; no retry\n', 0o600)
            ATTEMPTS.clear()
            results = experiment(base)
            require(not base.uid_processes(590))
            return results
        finally:
            with base.cleanup_signals():
                restore(base)


def interrupted(_signum, _frame):
    raise DiagnosticError('diagnostic interrupted')


def main():
    require(sys.platform == 'darwin' and os.getuid() == os.geteuid() == os.getgid() == os.getegid() == 0)
    require(os.environ.get('SUDO_UID') == '501')
    os.environ.clear()
    os.environ.update(ENV)
    os.umask(0o077)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM):
        signal.signal(sig, interrupted)
    base = original()
    if Path(__file__) == TARGET:
        require(len(sys.argv) == 1)
        results = diagnostic(base)
        print(json.dumps({'schema': 1, 'supervisor_restored': True, 'attempts': results}, sort_keys=True))
    else:
        require(len(sys.argv) == 3 and sys.argv[1] in ('install', 'restore'))
        wrapper = read_file(Path(__file__), 0o644, sys.argv[2])
        if sys.argv[1] == 'install':
            install(base, wrapper)
            print('{"schema":1,"temporary_diagnostic_target":true}')
        else:
            with locked(base), base.cleanup_signals():
                restore(base)
            print('{"schema":1,"supervisor_restored":true}')


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        # Never emit paths, exception text, names, environment values or a traceback.
        value = getattr(error, 'errno', None)
        detail = {'schema': 1, 'diagnostic_failed': True, 'supervisor_restored': RESTORED,
                  'attempts': ATTEMPTS,
                  'class': type(error).__name__ if type(error).__name__ in
                  ('DiagnosticError', 'PermissionError', 'FileExistsError', 'FileNotFoundError', 'OSError') else 'other_exception'}
        if type(value) is int and 0 <= value < 2**31:
            detail['errno'] = value
        print(json.dumps(detail, sort_keys=True), file=sys.stderr)
        sys.exit(1)
