"""Fixed-inode experiment and temporary-target restoration; no Mac mutation."""
import contextlib
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]

def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

d = module('buzz_home_rmdir_diagnostic')
s = module('buzz_macos_build_supervisor')


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        install, state, home = (self.root / name for name in ('install', 'state', 'home'))
        for path in (install, state, home):
            path.mkdir(mode=0o700)
        self.parent = home / 'Library'
        self.parent.mkdir(mode=0o700)
        self.leaf = self.parent / 'Preferences'
        self.leaf.mkdir(mode=0o700)
        self.target = install / 'buzz_macos_build_supervisor.py'
        self.original = b'marker = True\n'
        self.wrapper = b'fixed diagnostic wrapper fixture\n'
        self.target.write_bytes(self.original)
        self.target.chmod(0o644)
        (install / 'other.py').write_bytes(b'other original payload')
        (install / 'other.py').chmod(0o644)
        manifest = {'workflow_sha': 'dca2a86e4a874ab0421d1067b57bca4b4279ca51',
                    'files': {name: hashlib.sha256((install / name).read_bytes()).hexdigest()
                              for name in (self.target.name, 'other.py')}}
        receipt = json.dumps(manifest).encode()
        for path, mode in ((install / 'installation.json', 0o644), (state / 'installation.json', 0o600)):
            path.write_bytes(receipt)
            path.chmod(mode)
        sudoers = self.root / 'sudoers'
        sudoers.write_bytes(b'fixed sudo rule\n')
        sudoers.chmod(0o440)
        lock = state / 'supervisor.lock'
        lock.touch(mode=0o600)
        packet = self.root / 'diagnostic'
        constants = dict(INSTALL=install, STATE=state, HOME_PATH=home, TARGET=self.target,
                         PACKET=packet, BACKUP=packet / 'supervisor.original.py', STAGED=packet / 'diagnostic.py',
                         ATTEMPT=packet / 'ATTEMPT', SWAP=install / '.diagnostic-swap', SUDOERS=sudoers,
                         ORIGINAL_SHA=d.digest(self.original), RECEIPT_SHA=d.digest(receipt),
                         SUDOERS_SHA=d.digest(sudoers.read_bytes()), LOCK_INODE=lock.stat().st_ino,
                         HOME_ID=d.identity(home.stat()), PARENT_ID=d.identity(self.parent.stat()),
                         LEAF_ID=d.identity(self.leaf.stat()))
        for name, value in constants.items():
            self.stack.enter_context(patch.object(d, name, value))
        # Real descriptor traversal, locking, unlink/replace and file modes. Only host
        # account/root ownership and macOS ACL tools are substituted on Linux.
        self.stack.enter_context(patch.object(d, 'protected'))
        self.stack.enter_context(patch.object(d, 'no_acl'))
        real_fstat = os.fstat
        def metadata(fd):
            info = real_fstat(fd)
            if stat.S_ISREG(info.st_mode):
                fields = {key: getattr(info, key) for key in dir(info) if key.startswith('st_')}
                fields.update(st_uid=0, st_gid=0)
                return types.SimpleNamespace(**fields)
            return info
        self.stack.enter_context(patch.object(d.os, 'fstat', side_effect=metadata))
        self.stack.enter_context(patch.object(d.pwd, 'getpwnam', side_effect=lambda name:
            types.SimpleNamespace(pw_uid=501) if name == 'm5mbp' else
            types.SimpleNamespace(pw_uid=590, pw_gid=590, pw_shell='/usr/bin/false', pw_dir=str(home))))
        self.base = types.SimpleNamespace(FILES=(self.target.name, 'other.py'), root_path=lambda *_: None,
            uid_processes=lambda _: [], cleanup_signals=s.cleanup_signals,
            home_directory=lambda _: os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
        self.stack.enter_context(patch.object(d.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO())))
        d.ATTEMPTS.clear()
        d.RESTORED = False

    def result(self, uid, error=0):
        return dict(uid=uid, euid=uid, pid=1, ppid=2, operation='rmdir', category='fixed_empty_home_leaf', errno=error)

    def remove(self, _base, parent, uid):
        os.rmdir('Preferences', dir_fd=parent)
        return self.result(uid)

    def test_root_success_removes_only_leaf_and_restores_all_payload_hashes(self):
        d.install(self.base, self.wrapper)
        self.assertEqual(self.target.read_bytes(), self.wrapper)
        with patch.object(d, 'attempt', side_effect=self.remove) as attempt:
            result = d.diagnostic(self.base)
        self.assertEqual([item['euid'] for item in result], [0])
        self.assertEqual(attempt.call_count, 1)
        self.assertFalse(self.leaf.exists())
        self.assertTrue(self.parent.exists() and d.ATTEMPT.exists())
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertTrue(d.RESTORED)
        d.attest(self.base, False)

    def test_only_stable_eperm_allows_matched_uid_fallback(self):
        d.install(self.base, self.wrapper)
        def attempt(base, parent, uid):
            return self.result(uid, errno.EPERM) if uid == 0 else self.remove(base, parent, uid)
        with patch.object(d, 'attempt', side_effect=attempt) as run:
            result = d.diagnostic(self.base)
        self.assertEqual([item['euid'] for item in result], [0, 590])
        self.assertEqual(run.call_count, 2)
        self.assertFalse(self.leaf.exists())
        self.assertTrue(d.RESTORED)

    def test_other_errno_and_changed_metadata_never_fall_back(self):
        for changed in (False, True):
            with self.subTest(changed=changed):
                d.ATTEMPTS.clear()
                def attempt(_base, _parent, uid):
                    if changed:
                        self.leaf.chmod(0o755)
                    return self.result(uid, errno.EPERM if changed else errno.EACCES)
                with patch.object(d, 'attempt', side_effect=attempt) as run:
                    if changed:
                        with self.assertRaises(d.DiagnosticError):
                            d.experiment(self.base)
                    else:
                        self.assertEqual(d.experiment(self.base)[0]['errno'], errno.EACCES)
                self.assertEqual(run.call_count, 1)
                self.leaf.chmod(0o700)

    def test_nonempty_replaced_symlink_acl_or_identity_drift_refuses_before_syscall(self):
        for kind in ('nonempty', 'replaced', 'symlink', 'acl', 'mode'):
            with self.subTest(kind=kind):
                if kind == 'nonempty':
                    (self.leaf / 'private').touch()
                elif kind in ('replaced', 'symlink'):
                    self.leaf.rename(self.parent / 'original')
                    if kind == 'replaced':
                        self.leaf.mkdir(mode=0o700)
                    else:
                        self.leaf.symlink_to(self.parent / 'original')
                elif kind == 'mode':
                    self.leaf.chmod(0o755)
                acl = patch.object(d, 'no_acl', side_effect=d.DiagnosticError()) if kind == 'acl' else contextlib.nullcontext()
                with acl, patch.object(d, 'attempt') as attempt:
                    with self.assertRaises((d.DiagnosticError, OSError)):
                        d.experiment(self.base)
                    attempt.assert_not_called()
                if kind == 'nonempty':
                    (self.leaf / 'private').unlink()
                elif kind in ('replaced', 'symlink'):
                    self.leaf.unlink() if kind == 'symlink' else self.leaf.rmdir()
                    (self.parent / 'original').rename(self.leaf)
                elif kind == 'mode':
                    self.leaf.chmod(0o700)

    def test_normal_build_input_is_refused_and_target_restored(self):
        d.install(self.base, self.wrapper)
        with patch.object(d.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(b'PRIVATE_INPUT'))), \
             patch.object(d, 'attempt') as attempt:
            with self.assertRaises(d.DiagnosticError):
                d.diagnostic(self.base)
        attempt.assert_not_called()
        self.assertFalse(d.ATTEMPT.exists())
        self.assertTrue(d.RESTORED)

    def test_consumed_attempt_and_backup_mismatch_fail_closed(self):
        d.install(self.base, self.wrapper)
        d.create_file(d.ATTEMPT, b'consumed', 0o600)
        with patch.object(d, 'attempt') as attempt:
            with self.assertRaises(FileExistsError):
                d.diagnostic(self.base)
        attempt.assert_not_called()
        self.assertTrue(d.RESTORED)
        d.replace_target(self.wrapper)
        d.BACKUP.write_bytes(b'changed backup')
        with self.assertRaises(d.DiagnosticError):
            d.original()

    def test_install_cancellation_after_publication_restores_original(self):
        previous = signal.signal(signal.SIGTERM, d.interrupted)
        self.addCleanup(signal.signal, signal.SIGTERM, previous)
        replace = d.replace_target
        def cancelled(data):
            replace(data)
            if data == self.wrapper:
                signal.raise_signal(signal.SIGTERM)
        with patch.object(d, 'replace_target', side_effect=cancelled):
            with self.assertRaises(s.BoundaryError):
                d.install(self.base, self.wrapper)
        self.assertEqual(self.target.read_bytes(), self.original)
        self.assertTrue(d.RESTORED)

    def test_diagnostic_cancellation_after_removal_restores_without_fallback(self):
        d.install(self.base, self.wrapper)
        def interrupted(base, parent, uid):
            self.remove(base, parent, uid)
            raise d.DiagnosticError('PRIVATE_CANCELLATION')
        with patch.object(d, 'attempt', side_effect=interrupted) as attempt:
            with self.assertRaises(d.DiagnosticError):
                d.diagnostic(self.base)
        self.assertEqual(attempt.call_count, 1)
        self.assertFalse(self.leaf.exists())
        self.assertTrue(d.ATTEMPT.exists() and d.RESTORED)

    def test_restore_failure_is_explicit_and_operator_can_restore_later(self):
        d.install(self.base, self.wrapper)
        with patch.object(d, 'attempt', side_effect=lambda *_: self.result(0, errno.EACCES)), \
             patch.object(d.os, 'replace', side_effect=OSError(errno.EIO, 'PRIVATE_ERROR')):
            with self.assertRaises(OSError):
                d.diagnostic(self.base)
        self.assertFalse(d.RESTORED)
        self.assertEqual(self.target.read_bytes(), self.wrapper)
        self.assertEqual(d.BACKUP.read_bytes(), self.original)
        with d.locked(self.base):
            d.restore(self.base)
        self.assertTrue(d.RESTORED)
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_restore_refuses_unrelated_target_and_install_refuses_reuse(self):
        d.install(self.base, self.wrapper)
        self.target.write_bytes(b'unrelated target')
        with self.assertRaises(d.DiagnosticError):
            d.restore(self.base)
        self.assertEqual(self.target.read_bytes(), b'unrelated target')
        self.target.write_bytes(self.original)
        with self.assertRaises(d.DiagnosticError):
            d.install(self.base, self.wrapper)

    def test_partial_restore_write_cleans_only_its_owned_temp_for_recovery(self):
        d.install(self.base, self.wrapper)
        def partial(fd, data):
            os.write(fd, data[:3])
            raise OSError(errno.EIO, 'PRIVATE_WRITE_ERROR')
        with patch.object(d, 'write_fd', side_effect=partial):
            with self.assertRaises(OSError):
                d.restore(self.base)
        self.assertEqual(self.target.read_bytes(), self.wrapper)
        self.assertFalse(d.SWAP.exists())
        d.restore(self.base)
        self.assertTrue(d.RESTORED)

    def test_preexisting_swap_is_preserved(self):
        d.install(self.base, self.wrapper)
        d.SWAP.write_bytes(b'unrelated')
        with self.assertRaises(FileExistsError):
            d.restore(self.base)
        self.assertEqual(d.SWAP.read_bytes(), b'unrelated')
        self.assertEqual(self.target.read_bytes(), self.wrapper)

    def test_real_fork_closes_inherited_descriptors_and_returns_bounded_metadata(self):
        extra = os.open(d.STATE / 'supervisor.lock', os.O_RDONLY)
        self.addCleanup(os.close, extra)
        parent = d.checked_parent(self.base)
        self.addCleanup(os.close, parent)
        def result(_base, capability, uid):
            with self.assertRaises(OSError):
                os.fstat(extra)
            self.assertEqual(capability, parent)
            os.rmdir('Preferences', dir_fd=capability)
            # Unix identity is substituted only here; the descriptor and fork boundary is real.
            return dict(uid=uid, euid=uid, pid=os.getpid(), ppid=os.getppid(),
                        operation='rmdir', category='fixed_empty_home_leaf', errno=0)
        with patch.object(d, 'child_result', side_effect=result):
            result = d.attempt(self.base, parent, 0)
        self.assertEqual(result['errno'], 0)
        self.assertFalse(self.leaf.exists())
        self.assertGreater(os.fstat(extra).st_ino, 0)

    def test_uid_drop_orders_groups_gid_uid_and_refuses_incomplete_drop(self):
        events = []
        with patch.object(d.os, 'setgroups', side_effect=lambda value: events.append(('groups', value))), \
             patch.object(d.os, 'setgid', side_effect=lambda value: events.append(('gid', value))), \
             patch.object(d.os, 'setuid', side_effect=lambda value: events.append(('uid', value))), \
             patch.object(d.os, 'getuid', return_value=590), patch.object(d.os, 'geteuid', return_value=0), \
             patch.object(d.os, 'rmdir') as remove:
            with self.assertRaises(d.DiagnosticError):
                d.child_result(self.base, 3, 590)
        self.assertEqual(events, [('groups', []), ('gid', 590), ('uid', 590)])
        remove.assert_not_called()

    def test_both_denials_keep_leaf_and_restore_carrier(self):
        d.install(self.base, self.wrapper)
        with patch.object(d, 'attempt', side_effect=lambda _base, _parent, uid: self.result(uid, errno.EPERM)):
            results = d.diagnostic(self.base)
        self.assertEqual([item['errno'] for item in results], [errno.EPERM, errno.EPERM])
        self.assertTrue(self.leaf.exists() and d.RESTORED)

    def test_fork_failure_closes_pipes_and_restores_signal_mask(self):
        parent = d.checked_parent(self.base)
        self.addCleanup(os.close, parent)
        real_pipe = os.pipe
        created = []
        def pipe():
            pair = real_pipe()
            created.extend(pair)
            return pair
        before = signal.pthread_sigmask(signal.SIG_BLOCK, [])
        with patch.object(d.os, 'pipe', side_effect=pipe), \
             patch.object(d.os, 'fork', side_effect=OSError(errno.EAGAIN, 'PRIVATE_FORK_ERROR')):
            with self.assertRaises(OSError):
                d.attempt(self.base, parent, 0)
        self.assertEqual(signal.pthread_sigmask(signal.SIG_BLOCK, []), before)
        for fd in created:
            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_timeout_kills_and_reaps_only_owned_child(self):
        parent = d.checked_parent(self.base)
        self.addCleanup(os.close, parent)
        children = []
        real_fork = os.fork
        def fork():
            pid = real_fork()
            if pid:
                children.append(pid)
            return pid
        with patch.object(d.os, 'fork', side_effect=fork), \
             patch.object(d, 'child_result', side_effect=lambda *_: signal.pause()), \
             patch.object(d.time, 'monotonic', side_effect=[0, 11]):
            with self.assertRaises(d.DiagnosticError):
                d.attempt(self.base, parent, 0)
        self.assertEqual(len(children), 1)
        with self.assertRaises(ChildProcessError):
            os.waitpid(children[0], os.WNOHANG)
        self.assertTrue(self.leaf.exists())

    def test_cancellation_immediately_after_real_reap_never_signals_reaped_pid(self):
        d.install(self.base, self.wrapper)
        previous = signal.signal(signal.SIGTERM, d.interrupted)
        self.addCleanup(signal.signal, signal.SIGTERM, previous)
        real_waitpid = os.waitpid
        reaped = []
        def waitpid(pid, options):
            found, status = real_waitpid(pid, options)
            if found and options == os.WNOHANG:
                reaped.append(found)
                # This signal must remain pending until the caller records reaped=True.
                signal.raise_signal(signal.SIGTERM)
            return found, status
        def result(_base, parent, uid):
            os.rmdir('Preferences', dir_fd=parent)
            return dict(uid=uid, euid=uid, pid=os.getpid(), ppid=os.getppid(),
                        operation='rmdir', category='fixed_empty_home_leaf', errno=0)
        with patch.object(d, 'child_result', side_effect=result), \
             patch.object(d.os, 'waitpid', side_effect=waitpid), \
             patch.object(d.os, 'kill', side_effect=AssertionError('signal after reap')) as kill:
            with self.assertRaises(d.DiagnosticError):
                d.diagnostic(self.base)
        self.assertEqual(len(reaped), 1)
        kill.assert_not_called()
        self.assertTrue(d.RESTORED and d.ATTEMPT.exists())
        self.assertFalse(self.leaf.exists())
        self.assertEqual(self.target.read_bytes(), self.original)

    def test_manual_workflow_uses_only_existing_fixed_entrypoint(self):
        workflow = (SCRIPTS.parent / 'buzz-home-rmdir-diagnostic.yml').read_text()
        self.assertIn('workflow_dispatch:', workflow)
        self.assertIn('permissions: {}', workflow)
        self.assertIn('group: buzz-apple-release', workflow)
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn('sudo -n /usr/bin/python3 -I /usr/local/libexec/buzz-macos-build/buzz_macos_build_supervisor.py </dev/null', workflow)
        for text in ('checkout', 'secrets.', 'uses:', 'source_sha', 'workflow_call'):
            self.assertNotIn(text, workflow)



class AncestorFlagsTests(unittest.TestCase):
    # Captured fixed host metadata, not a dynamically inferred flag allowlist.
    observed = {'/': 1048576, '/private': 1081344, '/private/var': 1048576,
                '/private/var/db': 1048576, '/usr': 557056, '/usr/local': 1048576,
                '/usr/local/libexec': 0, '/private/etc': 0, '/private/etc/sudoers.d': 0}

    def metadata(self, path):
        return types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0,
                                     st_flags=self.observed.get(str(path), 0))

    def test_observed_fixed_ancestors_and_zero_flag_task_paths_pass(self):
        with patch.object(Path, 'lstat', lambda path: self.metadata(path)), patch.object(d, 'no_acl') as acl:
            for path in (*self.observed, str(d.INSTALL), str(d.PACKET), str(d.STATE)):
                d.protected(Path(path))
            self.assertGreater(acl.call_count, len(self.observed))

    def test_changed_ancestor_or_flagged_task_directory_refuses(self):
        for path, flags in (('/', 0), ('/usr', 1048576), ('/usr/local', 1048577),
                            (str(d.INSTALL), 1048576), (str(d.PACKET), 1081344)):
            with self.subTest(path=path, flags=flags):
                def metadata(item):
                    info = self.metadata(item)
                    if str(item) == path:
                        info.st_flags = flags
                    return info
                with patch.object(Path, 'lstat', metadata), patch.object(d, 'no_acl'):
                    with self.assertRaises(d.DiagnosticError):
                        d.protected(Path(path))

    def test_observed_flags_do_not_bypass_type_owner_mode_or_acl(self):
        for field, value in (('st_mode', stat.S_IFLNK | 0o755), ('st_uid', 501),
                             ('st_mode', stat.S_IFDIR | 0o777)):
            def metadata(path):
                info = self.metadata(path)
                if str(path) == '/usr/local':
                    setattr(info, field, value)
                return info
            with patch.object(Path, 'lstat', metadata), patch.object(d, 'no_acl'):
                with self.assertRaises(d.DiagnosticError):
                    d.protected(Path('/usr/local'))
        with patch.object(Path, 'lstat', lambda path: self.metadata(path)), \
             patch.object(d, 'no_acl', side_effect=d.DiagnosticError()):
            with self.assertRaises(d.DiagnosticError):
                d.protected(Path('/usr/local'))


    def test_observed_ancestor_flag_is_still_rejected_on_task_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'task.py'
            path.write_bytes(b'public fixture')
            info = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_gid=0,
                                         st_nlink=1, st_flags=1048576, st_size=14)
            with patch.object(d, 'protected'), patch.object(d, 'no_acl'), \
                 patch.object(d.os, 'fstat', return_value=info):
                with self.assertRaises(d.DiagnosticError):
                    d.read_file(path, 0o644)


if __name__ == '__main__':
    unittest.main()
