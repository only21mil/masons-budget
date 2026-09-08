"""Dedicated-home filesystem and account-preserving migration contracts."""
import contextlib
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
from unittest.mock import Mock, call, patch

SCRIPTS = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


s = module('buzz_macos_build_supervisor')
p = module('buzz_macos_build_provision')


class HomeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.home = self.base / 'home'
        self.home.mkdir(mode=0o700)
        self.outside = self.base / 'outside'
        self.outside.mkdir()
        (self.outside / 'canary').write_text('synthetic outside data')
        info = self.home.stat()
        self.expected = {'path': str(self.home), 'identity': [info.st_dev, info.st_ino, 590, 590, 0o700, 0]}
        self.real_stat, self.real_fstat = os.stat, os.fstat
        self.uid = self.gid = 590
        self.flags = 0
        self.child_flags = 0

    def numeric(self, info, flags=0):
        values = {name: getattr(info, name) for name in dir(info) if name.startswith('st_')}
        values.update(st_uid=self.uid, st_gid=self.gid, st_flags=flags)
        return types.SimpleNamespace(**values)

    @contextlib.contextmanager
    def host_metadata(self, acl=None):
        # Real no-follow descriptor traversal/deletion with only host UID/ACL metadata mocked.
        with patch.object(s, 'BUILD_HOME', self.home), patch.object(s, 'root_path'), \
             patch.object(s, 'no_acl', side_effect=acl), \
             patch.object(s.os, 'fstat', side_effect=lambda fd: self.numeric(self.real_fstat(fd), self.flags)), \
             patch.object(s.os, 'stat', side_effect=lambda *a, **kw: self.numeric(self.real_stat(*a, **kw), self.child_flags)):
            yield

    def clear(self):
        with self.host_metadata():
            s.clear_builder_home(self.expected)

    def test_preserves_home_inode_and_unlinks_child_symlinks_without_following(self):
        (self.home / 'Library').mkdir()
        (self.home / 'Library/file').write_text('task cache')
        (self.home / 'escape').symlink_to(self.outside, target_is_directory=True)
        self.clear()
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertEqual(self.home.stat().st_ino, self.expected['identity'][1])
        self.assertEqual((self.outside / 'canary').read_text(), 'synthetic outside data')

    def test_home_replacement_is_not_adopted(self):
        self.home.rename(self.base / 'old-home')
        self.home.mkdir(mode=0o700)
        (self.home / 'keep').touch()
        with self.assertRaises(s.BoundaryError):
            self.clear()
        self.assertTrue((self.home / 'keep').exists())

    def test_replacement_during_clear_is_detected_before_return(self):
        (self.home / 'task-file').touch()
        real_unlink = os.unlink
        def replace(name, **kwargs):
            real_unlink(name, **kwargs)
            self.home.rename(self.base / 'drained-home')
            self.home.mkdir(mode=0o700)
            (self.home / 'keep').touch()
        with self.host_metadata(), patch.object(s.os, 'unlink', side_effect=replace):
            with self.assertRaises(s.BoundaryError):
                s.clear_builder_home(self.expected)
        self.assertTrue((self.home / 'keep').exists())

    def test_home_symlink_and_symlink_ancestor_refused(self):
        self.home.rmdir()
        self.home.symlink_to(self.outside, target_is_directory=True)
        with self.assertRaises(OSError):
            self.clear()
        link = self.base / 'parent-link'
        link.symlink_to(self.base, target_is_directory=True)
        with self.assertRaises(OSError):
            s.open_directory(link / 'outside')

    def test_owner_group_mode_acl_and_flags_drift_refused(self):
        for attribute, value in (('uid', 501), ('gid', 20), ('flags', 1)):
            with self.subTest(attribute=attribute):
                old = getattr(self, attribute)
                setattr(self, attribute, value)
                with self.assertRaises(s.BoundaryError):
                    self.clear()
                setattr(self, attribute, old)
        self.home.chmod(0o755)
        with self.assertRaises(s.BoundaryError):
            self.clear()
        self.home.chmod(0o700)
        with self.host_metadata(acl=lambda *_: s.require(False, 'ACL drift')):
            with self.assertRaises(s.BoundaryError):
                s.clear_builder_home(self.expected)

    def test_flagged_or_acl_child_is_preserved_and_refused(self):
        child = self.home / 'keep'
        child.touch()
        self.child_flags = 1
        with self.assertRaises(s.BoundaryError):
            self.clear()
        self.child_flags = 0
        def acl(path):
            s.require(path != child, 'child ACL drift')
        with self.host_metadata(acl):
            with self.assertRaises(s.BoundaryError):
                s.clear_builder_home(self.expected)
        self.assertTrue(child.exists())

    def test_hardlinks_and_special_files_are_preserved_and_refused(self):
        child = self.home / 'bad'
        os.link(self.outside / 'canary', child)
        with self.assertRaises(s.BoundaryError):
            self.clear()
        child.unlink()
        os.mkfifo(child)
        with self.assertRaises(s.BoundaryError):
            self.clear()
        self.assertEqual((self.outside / 'canary').read_text(), 'synthetic outside data')

    def test_partial_cleanup_error_is_propagated(self):
        (self.home / 'one').touch()
        (self.home / 'two').touch()
        real_unlink = os.unlink
        calls = []
        def unlink(name, **kwargs):
            calls.append(name)
            if len(calls) == 2:
                raise PermissionError(13, 'synthetic failure')
            real_unlink(name, **kwargs)
        with self.host_metadata(), patch.object(s.os, 'unlink', side_effect=unlink):
            with self.assertRaises(PermissionError):
                s.clear_builder_home(self.expected)
        self.assertEqual(len(list(self.home.iterdir())), 1)

    def test_home_failures_identify_operation_category_and_euid_without_private_values(self):
        marker = 'PRIVATE_NAME_CONTENT_ATTRIBUTE_AND_EXCEPTION'
        cases = [('listdir', 'home'), ('listdir', 'directory'),
                 ('stat', 'unclassified_entry'), ('open', 'directory'),
                 ('fstat', 'directory'), ('close', 'directory'),
                 ('rmdir', 'directory'), ('unlink', 'regular_file'),
                 ('unlink', 'symlink'), ('acl_check', 'regular_file')]
        for operation, category in cases:
            with self.subTest(operation=operation, category=category):
                self.clear()
                child = self.home / (marker + '_directory')
                child.mkdir()
                entry = child / (marker + '_entry')
                if category == 'symlink':
                    entry.symlink_to(self.outside / 'canary')
                else:
                    entry.write_text(marker)
                child_inode = child.stat().st_ino
                error = PermissionError(1, marker, str(entry))
                error.filename2 = str(self.outside / marker)
                error.xattr_value = marker
                injected = False
                s.FAILURES.clear(); s.RECORDED_ERRORS.clear()
                s.phase('initial_home_clear')
                with self.host_metadata(), patch.object(s.os, 'geteuid', return_value=0):
                    owner, attribute = (s, 'no_acl') if operation == 'acl_check' else (s.os, operation)
                    original = getattr(owner, attribute)

                    def fail(*args, **kwargs):
                        nonlocal injected
                        selected = True
                        if operation in ('listdir', 'fstat', 'close'):
                            is_child = self.real_fstat(args[0]).st_ino == child_inode
                            selected = is_child if category == 'directory' else not is_child
                        elif operation == 'open':
                            selected = args[0] == child.name
                        elif operation == 'acl_check':
                            selected = args[0] == entry
                        if selected and not injected:
                            injected = True
                            if operation == 'close':
                                original(*args, **kwargs)
                            raise error
                        return original(*args, **kwargs)

                    with patch.object(owner, attribute, side_effect=fail), \
                         contextlib.redirect_stdout(io.StringIO()) as stdout, \
                         contextlib.redirect_stderr(io.StringIO()) as stderr:
                        with self.assertRaises(PermissionError) as raised:
                            s.clear_builder_home(self.expected)
                        # The outer failure handler must retain the original attribution.
                        s.phase('final_home_clear')
                        s.record_failure(raised.exception)
                self.assertIs(raised.exception, error)
                self.assertTrue(injected)
                self.assertEqual(s.FAILURES, [dict(phase='initial_home_clear',
                    **{'class': 'PermissionError'}, errno=1, operation=operation,
                    category=category, euid=0)])
                exported = json.dumps(s.FAILURES) + stdout.getvalue() + stderr.getvalue()
                for private in (marker, str(self.home), str(self.outside)):
                    self.assertNotIn(private, exported)
                self.assertEqual((self.outside / 'canary').read_text(), 'synthetic outside data')

    def test_home_attestation_failures_use_fixed_helper_or_syscall_labels(self):
        cases = [('ancestor_validation', s, 'root_path'),
                 ('directory_walk', s, 'open_directory'),
                 ('acl_check', s, 'no_acl'), ('fstat', s.os, 'fstat'),
                 ('close', s.os, 'close')]
        for operation, owner, attribute in cases:
            with self.subTest(operation=operation):
                error = PermissionError(1, 'PRIVATE_EXCEPTION', str(self.home))
                s.FAILURES.clear(); s.RECORDED_ERRORS.clear()
                s.phase('final_home_clear')
                with self.host_metadata(), patch.object(s.os, 'geteuid', return_value=0):
                    original = getattr(owner, attribute)

                    def fail(*args, **kwargs):
                        if operation == 'close':
                            # Ignore ancestor descriptors closed by the directory walk.
                            is_home = self.real_fstat(args[0]).st_ino == self.expected['identity'][1]
                            result = original(*args, **kwargs)
                            if not is_home:
                                return result
                        raise error

                    with patch.object(owner, attribute, side_effect=fail):
                        with self.assertRaises(PermissionError) as raised:
                            s.clear_builder_home(self.expected)
                self.assertIs(raised.exception, error)
                self.assertEqual(s.FAILURES, [dict(phase='final_home_clear',
                    **{'class': 'PermissionError'}, errno=1, operation=operation,
                    category='home', euid=0)])

    def test_cleanup_error_keeps_both_operations_and_original_exception_precedence(self):
        child = self.home / 'directory'
        child.mkdir()
        child_inode = child.stat().st_ino
        first = PermissionError(1, 'PRIVATE_FIRST')
        cleanup = OSError(5, 'PRIVATE_CLEANUP')
        original_close = os.close
        s.FAILURES.clear(); s.RECORDED_ERRORS.clear()
        s.phase('final_home_clear')

        def close(fd):
            is_child = self.real_fstat(fd).st_ino == child_inode
            original_close(fd)
            if is_child:
                raise cleanup

        def listdir(fd):
            if self.real_fstat(fd).st_ino == child_inode:
                raise first
            return [child.name]

        with self.host_metadata(), patch.object(s.os, 'geteuid', return_value=590), \
             patch.object(s.os, 'listdir', side_effect=listdir), \
             patch.object(s.os, 'close', side_effect=close):
            with self.assertRaises(OSError) as raised:
                s.clear_builder_home(self.expected)
            s.record_failure(raised.exception)
        self.assertIs(raised.exception, cleanup)
        self.assertIs(raised.exception.__context__, first)
        self.assertEqual(s.FAILURES, [
            dict(phase='final_home_clear', **{'class': 'PermissionError'}, errno=1,
                 operation='listdir', category='directory', euid=590),
            dict(phase='final_home_clear', **{'class': 'OSError'}, errno=5,
                 operation='close', category='directory', euid=590)])


class LifecycleTests(unittest.TestCase):
    def test_failure_or_cancellation_drains_and_clears_home_without_export(self):
        caller = types.SimpleNamespace(pw_uid=501, pw_gid=20)
        builder = types.SimpleNamespace(pw_uid=590, pw_gid=590, pw_shell='/usr/bin/false', pw_dir=str(s.BUILD_HOME))
        manifest = dict(builder_uid=590, builder_gid=590, caller_uid=501, workflow_sha='a' * 40, builder_home={})
        lock = types.SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600, st_nlink=1)
        for kind in ('cancellation', 'home_cleanup_failure', 'final_drain_failure', 'final_home_failure'):
            events = []
            s.FAILURES.clear(); s.RECORDED_ERRORS.clear()
            def execute(*_):
                events.append('execute')
                if kind in ('cancellation', 'final_drain_failure', 'final_home_failure'):
                    s.interrupted(15, None)
                events.append('drain')
            def clear_home(*_):
                events.append('home_clear')
                if kind in ('home_cleanup_failure', 'final_home_failure') and events.count('home_clear') == 2:
                    raise PermissionError(13, 'DO_NOT_PRINT private canary')
            def stop(*_):
                events.append('drain')
                if kind == 'final_drain_failure' and events.count('drain') == 2:
                    raise s.BoundaryError('DO_NOT_PRINT cleanup failure')
            patches = [patch.object(s.sys, 'platform', 'darwin'), patch.object(s.sys, 'argv', ['supervisor']),
                patch.object(s.os, 'geteuid', return_value=0), patch.object(s.os, 'umask'),
                patch.dict(s.os.environ, SUDO_UID='501'), patch.object(s.pwd, 'getpwnam', side_effect=[caller, builder]),
                patch.object(s, 'installed_manifest', return_value=manifest), patch.object(s.signal, 'alarm'),
                patch.object(s, 'request_from', return_value={'workflow_sha': 'a' * 40, 'output_dir': '/public', 'arch': 'ios'}),
                patch.object(s, 'caller_output', return_value=100), patch.object(s.os, 'open', return_value=101),
                patch.object(s.os, 'fstat', return_value=lock), patch.object(s.os, 'close'), patch.object(s.fcntl, 'flock'),
                patch.object(s, 'uid_processes', return_value=[]), patch.object(s, 'home_directory', return_value=102),
                patch.object(s, 'darwin_scratch_parent', return_value=Path('/fixed/scratch')),
                patch.object(s, 'scratch_snapshot', return_value={}), patch.object(s, 'clear_darwin_scratch'),
                patch.object(s, 'clear_builder_home', side_effect=clear_home),
                patch.object(s, 'stop_builder', side_effect=stop),
                patch.object(s.tempfile, 'mkdtemp', return_value='/fixed/build'), patch.object(s.Path, 'mkdir'),
                patch.object(s.os, 'chown'), patch.object(s, 'execute', side_effect=execute),
                patch.object(s, 'export_files') , patch.object(s.shutil, 'rmtree')]
            with self.subTest(kind=kind), contextlib.ExitStack() as stack:
                for item in patches: stack.enter_context(item)
                with self.assertRaises((s.BoundaryError, PermissionError)):
                    s.main()
                s.export_files.assert_not_called()
                if kind in ('final_drain_failure', 'final_home_failure'):
                    s.shutil.rmtree.assert_not_called()
                    self.assertEqual(len(s.FAILURES), 2)
                    self.assertEqual(s.FAILURES[1]['phase'], 'final_drain' if kind == 'final_drain_failure' else 'final_home_clear')
                else:
                    s.shutil.rmtree.assert_called_once()
            if kind != 'final_drain_failure':
                self.assertEqual(events[-2:], ['drain', 'home_clear'])
            self.assertNotIn('DO_NOT_PRINT', json.dumps(s.FAILURES))
            self.assertEqual(s.FAILURES[0]['phase'], 'post_payload_home_clear' if kind == 'home_cleanup_failure' else 'payload_execution')

    def test_child_setup_failure_emits_only_fixed_metadata(self):
        s.FAILURES.clear(); s.RECORDED_ERRORS.clear()
        stderr = io.StringIO()
        builder = types.SimpleNamespace(pw_uid=590, pw_gid=590)
        with contextlib.ExitStack() as stack:
            for item in (patch.object(s.os, 'pipe', side_effect=[(10, 11), (12, 13)]),
                         patch.object(s.os, 'fork', return_value=0), patch.object(s.os, 'close'),
                         patch.object(s.os, 'dup2'), patch.object(s.os, 'closerange'),
                         patch.object(s.os, 'listdir', return_value=['0', '1', '2']),
                         patch.object(s.os, 'setsid'), patch.object(s.os, 'setgroups'),
                         patch.object(s.os, 'setgid'),
                         patch.object(s.os, 'setuid', side_effect=PermissionError(13, 'DO_NOT_PRINT')),
                         patch.object(s.os, '_exit', side_effect=SystemExit(125)),
                         contextlib.redirect_stderr(stderr)):
                stack.enter_context(item)
            with self.assertRaises(SystemExit) as error:
                s.execute(Path('/owned/build'), {}, builder, Path('/owned/scratch'))
        self.assertEqual(error.exception.code, 125)
        self.assertNotIn('DO_NOT_PRINT', stderr.getvalue())
        self.assertIn('"phase": "child_privilege_drop"', stderr.getvalue())
        self.assertIn('"class": "PermissionError"', stderr.getvalue())
        self.assertIn('"errno": 13', stderr.getvalue())

    def test_cleanup_guard_restores_handlers_even_when_cleanup_fails(self):
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM)}
        failure = PermissionError('cleanup failed')
        with self.assertRaises(PermissionError) as error:
            with s.cleanup_signals():
                signal.raise_signal(signal.SIGTERM)
                raise failure
        self.assertIs(error.exception, failure)
        self.assertEqual({sig: signal.getsignal(sig) for sig in previous}, previous)

    def test_cleanup_guard_defers_each_signal_and_restores_handlers(self):
        signals = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM)
        previous = {sig: signal.getsignal(sig) for sig in signals}
        for sig in signals:
            events = []
            with self.subTest(signal=sig), self.assertRaisesRegex(s.BoundaryError, 'supervisor interrupted'):
                with s.cleanup_signals():
                    signal.raise_signal(sig)
                    signal.raise_signal(sig)
                    events.append('cleanup finished')
            self.assertEqual(events, ['cleanup finished'])
            self.assertEqual({sig: signal.getsignal(sig) for sig in signals}, previous)

    def test_cleanup_guard_preserves_original_unwinding_error(self):
        failure = PermissionError('original failure')
        events = []
        with self.assertRaises(PermissionError) as error:
            try:
                raise failure
            finally:
                with s.cleanup_signals():
                    signal.raise_signal(signal.SIGTERM)
                    events.append('cleanup finished')
        self.assertIs(error.exception, failure)
        self.assertEqual(events, ['cleanup finished'])

    def test_first_cancellation_during_child_or_final_cleanup_fails_after_cleanup(self):
        caller = types.SimpleNamespace(pw_uid=501, pw_gid=20)
        builder = types.SimpleNamespace(pw_uid=590, pw_gid=590, pw_shell='/usr/bin/false', pw_dir=str(s.BUILD_HOME))
        manifest = dict(builder_uid=590, builder_gid=590, caller_uid=501, workflow_sha='a' * 40, builder_home={})
        lock = types.SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600, st_nlink=1)
        for cancelled_phase in ('child_cleanup_drain', 'final_drain', None):
            events = []
            s.FAILURES.clear(); s.RECORDED_ERRORS.clear()
            def stop(*_):
                events.append(s.PHASE)
                if cancelled_phase is not None and s.PHASE == cancelled_phase:
                    signal.raise_signal(signal.SIGTERM)
                    events.append('cancellation deferred')
            def clear_home(*_):
                events.append(s.PHASE)
            def clear_scratch(*_):
                events.append(s.PHASE)
                return {}
            patches = [
                patch.object(s.sys, 'platform', 'darwin'), patch.object(s.sys, 'argv', ['supervisor']),
                patch.object(s.os, 'geteuid', return_value=0), patch.object(s.os, 'umask'),
                patch.dict(s.os.environ, SUDO_UID='501'), patch.object(s.pwd, 'getpwnam', side_effect=[caller, builder]),
                patch.object(s, 'installed_manifest', return_value=manifest), patch.object(s.signal, 'alarm'),
                patch.object(s, 'request_from', return_value={'workflow_sha': 'a' * 40, 'output_dir': '/public', 'arch': 'ios'}),
                patch.object(s, 'caller_output', return_value=100), patch.object(s.os, 'open', return_value=101),
                patch.object(s.os, 'fstat', return_value=lock), patch.object(s.os, 'close'), patch.object(s.fcntl, 'flock'),
                patch.object(s, 'uid_processes', return_value=[]), patch.object(s, 'home_directory', return_value=102),
                patch.object(s, 'darwin_scratch_parent', return_value=Path('/fixed/scratch')),
                patch.object(s, 'scratch_snapshot', return_value={}), patch.object(s, 'clear_darwin_scratch', side_effect=clear_scratch),
                patch.object(s, 'clear_builder_home', side_effect=clear_home), patch.object(s, 'stop_builder', side_effect=stop),
                patch.object(s.tempfile, 'mkdtemp', return_value='/fixed/build'), patch.object(s.Path, 'mkdir'),
                patch.object(s.os, 'chown'), patch.object(s.os, 'pipe', side_effect=[(10, 11), (12, 13)]),
                patch.object(s.os, 'fork', return_value=123), patch.object(s.os, 'set_blocking'),
                patch.object(s.os, 'fdopen', return_value=io.BytesIO()), patch.object(s, 'drain_log'),
                patch.object(s.os, 'waitpid', side_effect=[(123, 0), ChildProcessError()]),
                patch.object(s, 'export_files', side_effect=lambda *_: events.append('export')),
                patch.object(s.shutil, 'rmtree', side_effect=lambda *_: events.append('root cleared')),
            ]
            with self.subTest(cancelled_phase=cancelled_phase), contextlib.ExitStack() as stack:
                for item in patches:
                    stack.enter_context(item)
                if cancelled_phase is None:
                    s.main()
                    self.assertFalse(s.FAILURES)
                else:
                    with self.assertRaisesRegex(s.BoundaryError, 'supervisor interrupted'):
                        s.main()
                    self.assertEqual(len(s.FAILURES), 1)
                s.os.waitpid.assert_has_calls([call(123, os.WNOHANG)] * 2)
                s.os.close.assert_has_calls([call(101), call(100)])
                self.assertEqual(events[-3:], ['final_home_clear', 'final_scratch_clear', 'root cleared'])
                self.assertEqual('export' in events, cancelled_phase != 'child_cleanup_drain')

    def test_safe_diagnostics_keep_original_and_cleanup_classes_not_values(self):
        s.FAILURES.clear(); s.RECORDED_ERRORS.clear()
        first = PermissionError(13, 'DO_NOT_PRINT')
        s.phase('post_payload_home_clear'); s.record_failure(first)
        s.phase('final_drain'); s.record_failure(s.BoundaryError('DO_NOT_PRINT'))
        s.record_failure(first)
        self.assertEqual(s.FAILURES, [{'phase': 'post_payload_home_clear', 'class': 'PermissionError', 'errno': 13},
                                    {'phase': 'final_drain', 'class': 'BoundaryError'}])

    def test_home_diagnostic_labels_reject_private_values_and_keep_failure_bound(self):
        s.FAILURES.clear(); s.RECORDED_ERRORS.clear()
        s.phase('initial_home_clear')
        for operation, category in [('PRIVATE_OPERATION', 'home'), ('unlink', 'PRIVATE_CATEGORY')]:
            s.record_failure(PermissionError(1, 'PRIVATE_EXCEPTION'),
                             operation=operation, category=category)
        for _ in range(5):
            s.record_failure(PermissionError(1, 'PRIVATE_EXCEPTION'))
        self.assertEqual(s.FAILURES, [dict(phase='initial_home_clear',
            **{'class': 'PermissionError'}, errno=1)] * 4)


class UpgradeTests(unittest.TestCase):
    """Real bundle reads, file replacement and locking; only macOS identity/tools are mocked."""
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.install, self.state, self.bundle = [self.base / name for name in ('install', 'state', 'bundle')]
        for directory in (self.install, self.state, self.bundle): directory.mkdir()
        self.home, self.rule = self.base / 'home', self.base / 'sudoers'
        self.events = []
        self.account = dict(UniqueID='590', PrimaryGroupID='590', UserShell='/usr/bin/false',
                           NFSHomeDirectory='/var/empty', AuthenticationAuthority=';DisabledUser;',
                           GeneratedUID='synthetic-stable-account-uuid', IsHidden='1')
        self.original_account = dict(self.account)
        self.old = dict(schema=1, workflow_sha='a' * 40, builder_uid=590, builder_gid=590, caller_uid=501,
                        files={name: p.digest(('old ' + name).encode()) for name in p.FILES})
        self.new = dict(schema=2, workflow_sha='b' * 40,
                        files={name: p.digest(('new ' + name).encode()) for name in p.FILES})
        for name in p.FILES:
            (self.install / name).write_text('old ' + name)
            (self.install / name).chmod(0o644)
            (self.bundle / name).write_text('new ' + name)
        self.old_bytes = json.dumps(self.old).encode()
        self.new_bytes = json.dumps(self.new).encode()
        (self.bundle / 'bundle.json').write_bytes(self.new_bytes)
        for path, data, mode in ((self.install / 'installation.json', self.old_bytes, 0o644),
                                 (self.state / 'installation.json', self.old_bytes, 0o600),
                                 (self.state / 'sudoers.candidate', p.RULE.encode(), 0o440),
                                 (self.state / 'supervisor.lock', b'', 0o600),
                                 (self.rule, p.RULE.encode(), 0o440)):
            path.write_bytes(data); path.chmod(mode)
        self.lock_inode = (self.state / 'supervisor.lock').stat().st_ino
        self.real_lstat, self.real_fstat = Path.lstat, os.fstat
        self.real_create = p.create_file
        self.predecessor = types.SimpleNamespace(uid_processes=Mock(return_value=[]), stop_builder=Mock(side_effect=self.drain))
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        patches = [patch.object(p, 'INSTALL', self.install), patch.object(p, 'STATE', self.state),
                   patch.object(p, 'BUILD_HOME', self.home), patch.object(p, 'SUDOERS', self.rule),
                   patch.object(p.sys, 'platform', 'darwin'), patch.object(p.os, 'geteuid', return_value=0),
                   patch.object(p.os, 'umask'), patch.object(p.os, 'fchown'), patch.object(p.os, 'chown'),
                   patch.object(p, 'protected'), patch.object(p, 'command', side_effect=self.command),
                   patch.object(p.pwd, 'getpwnam', side_effect=self.getpwnam),
                   patch.object(p.grp, 'getgrnam', return_value=types.SimpleNamespace(gr_gid=590)),
                   patch.object(p.grp, 'getgrall', return_value=[]),
                   patch.object(p.Path, 'lstat', lambda path: self.metadata(self.real_lstat(path))),
                   patch.object(p.os, 'fstat', side_effect=self.fstat),
                   patch.object(p.importlib.util, 'module_from_spec', return_value=self.predecessor),
                   patch.object(p.importlib.util, 'spec_from_file_location', return_value=types.SimpleNamespace(loader=Mock())),
                   patch.object(p, 'create_file', side_effect=self.create)]
        for item in patches: self.stack.enter_context(item)

    def metadata(self, info, owner=0):
        values = {name: getattr(info, name) for name in dir(info) if name.startswith('st_')}
        return types.SimpleNamespace(**dict(values, st_uid=owner, st_gid=owner, st_flags=0))

    def fstat(self, fd):
        info = self.real_fstat(fd)
        owner = 590 if self.home.exists() and info.st_ino == self.home.stat().st_ino else 0
        return self.metadata(info, owner)

    def getpwnam(self, name):
        return types.SimpleNamespace(pw_uid=501 if name == 'm5mbp' else 590, pw_gid=590,
                                     pw_shell='/usr/bin/false', pw_dir=self.account['NFSHomeDirectory'])

    def command(self, argv):
        self.events.append(tuple(argv))
        if argv[:2] == ['/bin/ls', '-lde']: return b'drwx------ 1 root wheel'
        if argv[0] == '/usr/bin/dscl':
            if argv[2] == '-read': return (argv[4] + ': ' + self.account[argv[4]]).encode()
            self.assertEqual(argv[2:5], ['-create', '/Users/buzzbuild', 'NFSHomeDirectory'])
            self.assertFalse(self.rule.exists())
            self.assertTrue((self.state / 'upgrade-preimage.json').exists())
            self.account['NFSHomeDirectory'] = argv[5]
        return b''

    def create(self, path, data, mode):
        self.events.append(('write', str(path)))
        self.real_create(path, data, mode)

    def drain(self, uid):
        self.assertEqual(uid, 590)
        self.assertFalse(self.rule.exists())
        self.assertTrue((self.state / 'upgrade-preimage.json').exists())
        self.assertFalse(self.home.exists())

    def upgrade(self, **overrides):
        p.upgrade(self.bundle, overrides.get('expected', p.digest(self.new_bytes)),
                  overrides.get('from_commit', self.old['workflow_sha']),
                  overrides.get('from_manifest', p.digest(self.old_bytes)))

    def test_complete_upgrade_preserves_account_lock_and_exact_payload(self):
        self.upgrade()
        self.assertEqual(self.account, dict(self.original_account, NFSHomeDirectory=str(self.home)))
        self.assertEqual((self.state / 'supervisor.lock').stat().st_ino, self.lock_inode)
        self.assertEqual(self.rule.read_bytes(), p.RULE.encode())
        receipt = json.loads((self.state / 'installation.json').read_bytes())
        self.assertEqual(receipt['schema'], 2)
        self.assertEqual(receipt['builder_home'], p.home_receipt())
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertEqual((self.install / 'installation.json').read_bytes(), (self.state / 'installation.json').read_bytes())
        preimage = json.loads((self.state / 'upgrade-preimage.json').read_bytes())
        self.assertEqual(preimage['account'], self.original_account)
        self.assertEqual(preimage['from_manifest'], self.old)
        self.assertEqual(stat.S_IMODE((self.state / 'upgrade-preimage.json').stat().st_mode), 0o600)
        for name in p.FILES: self.assertEqual((self.install / name).read_text(), 'new ' + name)
        publication = self.events.index(('write', str(self.rule)))
        self.assertTrue(all(index < publication for index, event in enumerate(self.events)
                            if event[0] == 'write' and event[1] != str(self.rule)))
        self.assertEqual(self.events[publication + 1], ('/usr/sbin/visudo', '-c'))

    def test_exact_manifest_and_commit_required_before_revocation(self):
        for kwargs in ({'expected': '0' * 64}, {'from_manifest': '0' * 64}, {'from_commit': 'c' * 40}):
            with self.subTest(kwargs=kwargs), self.assertRaises(RuntimeError): self.upgrade(**kwargs)
            self.assertEqual(self.rule.read_bytes(), p.RULE.encode())
            self.assertFalse(self.home.exists())

    def test_payload_account_rule_and_lock_drift_refused(self):
        for path in (self.install / p.FILES[0], self.rule, self.state / 'sudoers.candidate'):
            original = path.read_bytes(); mode = stat.S_IMODE(path.stat().st_mode)
            path.chmod(0o600); path.write_bytes(b'drift'); path.chmod(mode)
            with self.subTest(path=path), self.assertRaises(RuntimeError): self.upgrade()
            path.chmod(0o600); path.write_bytes(original); path.chmod(mode)
            self.assertFalse(self.home.exists())
        for key, value in (('NFSHomeDirectory', '/unexpected'), ('AuthenticationAuthority', 'enabled')):
            original = self.account[key]; self.account[key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError): self.upgrade()
            self.account[key] = original
        lock = self.state / 'supervisor.lock'; lock.chmod(0o644)
        with self.assertRaises(RuntimeError): self.upgrade()
        lock.chmod(0o600)
        with lock.open('rb') as stream:
            p.fcntl.flock(stream.fileno(), p.fcntl.LOCK_EX | p.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): self.upgrade()
        self.assertEqual(self.rule.read_bytes(), p.RULE.encode())

    def test_existing_home_and_active_uid_are_never_adopted(self):
        self.home.mkdir(); (self.home / 'keep').touch()
        with self.assertRaises(RuntimeError): self.upgrade()
        self.assertTrue((self.home / 'keep').exists())
        (self.home / 'keep').unlink(); self.home.rmdir()
        self.predecessor.uid_processes.return_value = [123]
        with self.assertRaises(RuntimeError): self.upgrade()
        self.assertTrue(self.rule.exists())
        self.assertFalse((self.state / 'upgrade-preimage.json').exists())

    def test_partial_payload_failure_and_cancellation_keep_revoked_preimage(self):
        for exception in (PermissionError(13, 'synthetic failure'), KeyboardInterrupt()):
            # A new fixture per case retains each interrupted transition until its assertions finish.
            with self.subTest(exception=type(exception).__name__):
                def fail(path, data, mode):
                    if path == self.install / p.FILES[0]: raise exception
                    self.create(path, data, mode)
                with patch.object(p, 'create_file', side_effect=fail), self.assertRaises(type(exception)):
                    self.upgrade()
                self.assertFalse(self.rule.exists())
                self.assertTrue(self.home.exists())
                self.assertEqual(json.loads((self.state / 'installation.json').read_bytes()), self.old)
                self.assertTrue((self.state / 'upgrade-preimage.json').exists())
                self.assertEqual((self.state / 'supervisor.lock').stat().st_ino, self.lock_inode)
                # Restore only this synthetic fixture to exercise the second interruption class.
                (self.install / p.FILES[0]).write_text('old ' + p.FILES[0]); (self.install / p.FILES[0]).chmod(0o644)
                (self.state / 'upgrade-preimage.json').unlink(); self.home.rmdir()
                self.account = dict(self.original_account)
                self.rule.write_bytes(p.RULE.encode()); self.rule.chmod(0o440)

    def test_account_readback_drift_preserves_revoked_partial_state(self):
        command = self.command
        def drift(argv):
            result = command(argv)
            if argv[:3] == ['/usr/bin/dscl', '.', '-create']:
                self.account['GeneratedUID'] = 'unexpected-replacement'
            return result
        with patch.object(p, 'command', side_effect=drift), self.assertRaises(RuntimeError):
            self.upgrade()
        self.assertFalse(self.rule.exists())
        self.assertTrue(self.home.exists())
        self.assertTrue((self.state / 'upgrade-preimage.json').exists())
        self.assertEqual((self.install / p.FILES[0]).read_text(), 'old ' + p.FILES[0])

    def test_publication_write_validation_and_signal_failures_revoke_rule(self):
        import signal
        for kind in ('write', 'validation', 'signal'):
            self.rule.unlink()
            old_handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM)}
            def create(path, data, mode):
                self.real_create(path, data, mode)
                if kind == 'write': raise OSError(5, 'synthetic fsync failure')
            def command(_argv):
                if kind == 'signal': signal.raise_signal(signal.SIGTERM)
                raise RuntimeError('synthetic validation failure')
            with self.subTest(kind=kind), patch.object(p, 'create_file', side_effect=create), \
                 patch.object(p, 'command', side_effect=command), self.assertRaises((OSError, RuntimeError)):
                p.publish_rule()
            self.assertFalse(self.rule.exists())
            self.assertEqual({sig: signal.getsignal(sig) for sig in old_handlers}, old_handlers)
            self.rule.write_bytes(p.RULE.encode())

    def test_remove_refuses_nonempty_or_replaced_home_before_account_deletion(self):
        self.upgrade()
        (self.home / 'keep').touch()
        with self.assertRaises(RuntimeError): p.remove(self.new['workflow_sha'])
        self.assertTrue((self.home / 'keep').exists())
        self.home.rename(self.base / 'original-home'); self.home.mkdir(mode=0o700)
        with self.assertRaises(RuntimeError): p.remove(self.new['workflow_sha'])
        self.assertTrue(self.install.exists())
        self.assertFalse(any('-delete' in event for event in self.events))


if __name__ == '__main__':
    unittest.main()
