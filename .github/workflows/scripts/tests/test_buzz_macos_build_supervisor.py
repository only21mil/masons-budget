#!/usr/bin/env python3
"""Filesystem and privilege contract checks, runnable without a Mac or sudo."""
import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]

def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded

s = module('buzz_macos_build_supervisor')
p = module('buzz_macos_build_provision')

class RequestTests(unittest.TestCase):
    def request(self):
        return dict(source_sha='a' * 40, workflow_sha='b' * 40, version='1.2.3', arch='aarch64',
                    updater_public_key='A' * 60,
                    updater_endpoint='https://github.com/only21mil/buzz/releases/download/buzz-desktop-latest/latest.json',
                    run_id='123', run_attempt='1', output_dir='/Users/m5mbp/work/job/unsigned')

    def parse(self, request):
        return s.request_from(io.BytesIO(json.dumps(request).encode()))

    def test_valid_public_request(self):
        self.assertEqual(self.parse(self.request()), self.request())

    def test_reject_controls_injection_and_unknown_fields(self):
        changes = [('source_sha', '--upload-pack=evil'), ('version', '1.2.3\ncommand'),
                   ('arch', '../../outside'), ('run_id', True), ('run_attempt', '0'),
                   ('updater_endpoint', 'https://attacker.invalid'), ('updater_public_key', 'key\nsecret'),
                   ('workflow_sha', 'main'), ('command', '/bin/sh'), ('uid', '0'),
                   ('output_dir', 'relative')]
        for key, value in changes:
            with self.subTest(key=key), self.assertRaises(s.BoundaryError):
                self.parse(dict(self.request(), **{key: value}))

    def test_duplicate_and_oversized_json(self):
        for raw in (b'{"arch":"aarch64","arch":"x86_64"}', b' ' * 16385):
            with self.assertRaises(s.BoundaryError):
                s.request_from(io.BytesIO(raw))

class FilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'build'
        self.root.mkdir(mode=0o700)
        self.unsigned = self.root / 'unsigned'
        self.unsigned.mkdir(mode=0o700)
        self.output = self.base / 'output'
        self.output.mkdir(mode=0o700)
        self.fd = s.caller_output(str(self.output), os.getuid())
        self.names = ('unsigned-aarch64.app.tar.gz', 'build-aarch64.json')
        for name in self.names:
            (self.unsigned / name).write_bytes(b'inert output')

    def tearDown(self):
        os.close(self.fd)
        self.temp.cleanup()

    def export(self):
        s.export_files(self.root, self.fd, os.getuid(), os.getuid(), os.getgid(), 'aarch64')

    def test_only_regular_files_exported(self):
        self.export()
        self.assertEqual(set(os.listdir(self.output)), set(self.names))
        for name in self.names:
            self.assertEqual((self.output / name).read_bytes(), b'inert output')
            self.assertEqual(stat.S_IMODE((self.output / name).stat().st_mode), 0o600)

    def test_parent_and_leaf_symlinks_refused(self):
        link = self.base / 'link'
        link.symlink_to(self.output, target_is_directory=True)
        for path in (link, link / 'child'):
            with self.assertRaises(OSError):
                s.open_directory(path)
        (self.unsigned / self.names[0]).unlink()
        (self.unsigned / self.names[0]).symlink_to('/etc/passwd')
        with self.assertRaises(OSError):
            self.export()
        self.assertFalse(os.listdir(self.output))

    def test_hardlink_fifo_and_extra_file_refused(self):
        target = self.unsigned / self.names[0]
        outside = self.base / 'outside'
        outside.write_bytes(b'outside')
        target.unlink()
        os.link(outside, target)
        with self.assertRaises(s.BoundaryError):
            self.export()
        target.unlink()
        os.mkfifo(target)
        with self.assertRaises(s.BoundaryError):
            self.export()
        target.unlink()
        target.write_bytes(b'app')
        (self.unsigned / 'unexpected').write_bytes(b'extra')
        with self.assertRaises(s.BoundaryError):
            self.export()
        self.assertFalse(os.listdir(self.output))

    def test_second_output_failure_rolls_back_first(self):
        (self.unsigned / self.names[1]).unlink()
        (self.unsigned / self.names[1]).symlink_to('/etc/passwd')
        with self.assertRaises(OSError):
            self.export()
        self.assertFalse(os.listdir(self.output))

    def test_preopened_output_fd_survives_path_replacement(self):
        held = self.base / 'held'
        self.output.rename(held)
        self.output.symlink_to(self.base)
        self.export()
        self.assertEqual(set(os.listdir(held)), set(self.names))
        self.assertFalse((self.base / self.names[0]).exists())

    def test_output_ownership_mode_and_emptiness(self):
        with self.assertRaises(s.BoundaryError):
            s.caller_output(str(self.output), os.getuid() + 1)
        self.output.chmod(0o755)
        with self.assertRaises(s.BoundaryError):
            s.caller_output(str(self.output), os.getuid())
        self.output.chmod(0o700)
        (self.output / 'stale').touch()
        with self.assertRaises(s.BoundaryError):
            s.caller_output(str(self.output), os.getuid())

class ScratchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name).resolve() / 'darwin'
        self.parent.mkdir(mode=0o755)
        for name in ('T', 'C', 'T/com.apple.trustd'):
            (self.parent / name).mkdir(mode=0o700)
        self.expected = self.snapshot()

    def snapshot(self, *_args):
        return {name: s.scratch_identity((self.parent / name).stat())
                for name in ('.', 'T', 'C', 'T/com.apple.trustd')}

    def clear(self):
        # Portable tests use ordinary current-user dirs; production attestation
        # of UID590 and OS ancestry is tested separately below.
        with patch.object(s, 'scratch_snapshot', side_effect=self.snapshot):
            return s.clear_darwin_scratch(self.parent, self.expected, 590, 590)

    def test_clears_contents_preserves_skeleton_and_never_follows_links(self):
        outside = Path(self.temp.name) / 'outside'
        outside.mkdir()
        (outside / 'private').write_text('untouched')
        (self.parent / 'C/link').symlink_to(outside, target_is_directory=True)
        (self.parent / 'T/cache').mkdir()
        (self.parent / 'T/cache/file').write_text('source cache')
        (self.parent / 'T/com.apple.trustd/entry').write_text('source cache')
        self.assertEqual(self.clear(), self.expected)
        self.assertEqual((outside / 'private').read_text(), 'untouched')
        self.assertEqual(os.listdir(self.parent / 'T'), ['com.apple.trustd'])
        self.assertEqual(os.listdir(self.parent / 'T/com.apple.trustd'), [])
        self.assertEqual(os.listdir(self.parent / 'C'), [])
        self.assertEqual(self.clear(), self.expected)

    def test_replaced_or_chmod_skeleton_refused_before_deletion(self):
        (self.parent / 'C/keep').touch()
        (self.parent / 'T').chmod(0o755)
        with self.assertRaisesRegex(s.BoundaryError, 'skeleton changed'):
            self.clear()
        self.assertTrue((self.parent / 'C/keep').exists())

    def test_unknown_protected_entry_refused_without_clearing_flags(self):
        (self.parent / 'C/protected').mkdir()
        original = s.os.stat
        def info(path, **kwargs):
            value = original(path, **kwargs)
            if path == 'protected':
                return types.SimpleNamespace(st_flags=1048576)
            return value
        with patch.object(s.os, 'stat', side_effect=info):
            with self.assertRaisesRegex(s.BoundaryError, 'protected scratch entry'):
                self.clear()
        self.assertTrue((self.parent / 'C/protected').is_dir())

    def test_snapshot_rejects_wrong_identity_mode_and_symlink(self):
        with self.assertRaises(s.BoundaryError):
            s.scratch_snapshot(self.parent, 501, 501)
        with patch.object(s, 'root_path'), patch.object(s, 'no_acl'):
            with self.assertRaisesRegex(s.BoundaryError, 'unsafe Darwin scratch'):
                s.scratch_snapshot(self.parent, 590, 590)
        (self.parent / 'C').rmdir()
        (self.parent / 'C').symlink_to(self.parent / 'T')
        with self.assertRaises(OSError):
            s.open_directory(self.parent / 'C')

    def test_getconf_paths_must_be_matching_fixed_darwin_roots(self):
        temp = '/var/folders/y9/_3fghj8j0114rb7z9dxsfyx00000kf/T/'
        self.assertEqual(str(s.scratch_parent_from_paths(temp, temp[:-2] + 'C/')),
                         '/private' + temp[:-3])
        for first, second in ((temp, temp.replace('/T/', '/other/')),
                              ('/private/tmp/T/', '/private/tmp/C/'),
                              (temp.replace('y9', '..'), temp[:-2] + 'C/')):
            with self.assertRaises(s.BoundaryError):
                s.scratch_parent_from_paths(first, second)


class ProcessTests(unittest.TestCase):
    def test_process_scan_checks_real_and_effective_uid(self):
        output = types.SimpleNamespace(stdout='10 590 501\n11 501 590\n12 0 0\n')
        with patch.object(s.subprocess, 'run', return_value=output):
            self.assertEqual(s.uid_processes(590), [10, 11])
        with patch.object(s.subprocess, 'run', return_value=types.SimpleNamespace(stdout='bad')):
            with self.assertRaises(s.BoundaryError):
                s.uid_processes(590)

    def test_cleanup_kills_by_uid_and_refuses_persistent_processes(self):
        with patch.object(s.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run, \
             patch.object(s, 'uid_processes', return_value=[42]), patch.object(s.time, 'sleep'):
            with self.assertRaises(s.BoundaryError):
                s.stop_builder(590)
            commands = [call.args[0] for call in run.call_args_list]
            self.assertTrue(all(command in (['/usr/bin/pkill', '-KILL', '-U', '590', '.'],
                                           ['/usr/bin/pkill', '-KILL', '-u', '590', '.'],
                                           ['/bin/launchctl', 'bootout', 'user/590']) for command in commands))

    def test_cleanup_refuses_other_uid_and_failed_domain_retirement(self):
        with patch.object(s.subprocess, 'run') as run:
            with self.assertRaises(s.BoundaryError):
                s.stop_builder(501)
            run.assert_not_called()
        with patch.object(s.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1)), \
             patch.object(s, 'uid_processes') as scan:
            with self.assertRaisesRegex(s.BoundaryError, 'user domain'):
                s.stop_builder(590)
            scan.assert_not_called()

    def test_cleanup_requires_two_empty_readbacks(self):
        with patch.object(s.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)), \
             patch.object(s, 'uid_processes', side_effect=[[], [42], [], []]) as scan, \
             patch.object(s.time, 'sleep'):
            s.stop_builder(590)
            self.assertEqual(scan.call_count, 4)

    def test_cleanup_reaps_killed_direct_child_before_empty_scan(self):
        events = []
        def command(argv, **_kwargs):
            if argv[:2] == ['/bin/launchctl', 'bootout']:
                events.append('retired')
            return types.SimpleNamespace(returncode=0)
        with patch.object(s.subprocess, 'run', side_effect=command), \
             patch.object(s.os, 'waitpid', side_effect=lambda pid, flags: events.append('reaped')), \
             patch.object(s, 'uid_processes', side_effect=lambda uid: events.append('scanned') or []), \
             patch.object(s.time, 'sleep'):
            s.stop_builder(590, 42)
        self.assertEqual(events, ['reaped', 'retired', 'scanned', 'scanned'])

    def test_preexisting_uid_process_refuses_build_and_export(self):
        caller = types.SimpleNamespace(pw_uid=501, pw_gid=20)
        builder = types.SimpleNamespace(pw_uid=590, pw_gid=590, pw_shell='/usr/bin/false')
        manifest = dict(builder_uid=590, builder_gid=590, caller_uid=501, workflow_sha='b' * 40)
        request = RequestTests().request()
        lock_info = types.SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600, st_nlink=1)
        with patch.object(s.sys, 'platform', 'darwin'), patch.object(s.sys, 'argv', ['supervisor']), \
             patch.object(s.os, 'geteuid', return_value=0), patch.object(s.os, 'umask'), \
             patch.dict(s.os.environ, SUDO_UID='501'), patch.object(s.pwd, 'getpwnam', side_effect=[caller, builder]), \
             patch.object(s, 'installed_manifest', return_value=manifest), patch.object(s.signal, 'alarm'), \
             patch.object(s, 'request_from', return_value=request), patch.object(s, 'caller_output', return_value=100), \
             patch.object(s.os, 'open', return_value=101), patch.object(s.os, 'fstat', return_value=lock_info), \
             patch.object(s.os, 'close'), patch.object(s.fcntl, 'flock'), \
             patch.object(s, 'uid_processes', return_value=[42]), patch.object(s.tempfile, 'mkdtemp') as create, \
             patch.object(s, 'export_files') as export:
            with self.assertRaisesRegex(s.BoundaryError, 'already active'):
                s.main()
            create.assert_not_called()
            export.assert_not_called()

    def test_scratch_failure_prevents_export_and_cleanup_follows_uid_drain(self):
        caller = types.SimpleNamespace(pw_uid=501, pw_gid=20)
        builder = types.SimpleNamespace(pw_uid=590, pw_gid=590, pw_shell='/usr/bin/false')
        manifest = dict(builder_uid=590, builder_gid=590, caller_uid=501, workflow_sha='b' * 40)
        lock_info = types.SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600, st_nlink=1)
        for failed in (False, True):
            events = []
            def clear(*_args):
                events.append('clear')
                if failed and events.count('clear') == 2:
                    raise s.BoundaryError('scratch cleanup failed')
                return {}
            def execute(*_args):
                # execute() itself owns the post-source UID drain (tested above).
                events.extend(['execute', 'drain'])
            patches = (patch.object(s.sys, 'platform', 'darwin'), patch.object(s.sys, 'argv', ['supervisor']),
                 patch.object(s.os, 'geteuid', return_value=0), patch.object(s.os, 'umask'),
                 patch.dict(s.os.environ, SUDO_UID='501'), patch.object(s.pwd, 'getpwnam', side_effect=[caller, builder]),
                 patch.object(s, 'installed_manifest', return_value=manifest), patch.object(s.signal, 'alarm'),
                 patch.object(s, 'request_from', return_value=RequestTests().request()),
                 patch.object(s, 'caller_output', return_value=100), patch.object(s.os, 'open', return_value=101),
                 patch.object(s.os, 'fstat', return_value=lock_info), patch.object(s.os, 'close'),
                 patch.object(s.fcntl, 'flock'), patch.object(s, 'uid_processes', return_value=[]),
                 patch.object(s, 'darwin_scratch_parent', return_value=Path('/owned/darwin')),
                 patch.object(s, 'scratch_snapshot', return_value={}),
                 patch.object(s, 'clear_darwin_scratch', side_effect=clear),
                 patch.object(s, 'stop_builder', side_effect=lambda *_: events.append('drain')),
                 patch.object(s.tempfile, 'mkdtemp', return_value='/owned/build'),
                 patch.object(s.Path, 'mkdir'), patch.object(s.os, 'chown'),
                 patch.object(s, 'execute', side_effect=execute),
                 patch.object(s, 'export_files', side_effect=lambda *_: events.append('export')),
                 patch.object(s.shutil, 'rmtree', side_effect=lambda *_: events.append('remove')))
            with contextlib.ExitStack() as stack:
                for item in patches:
                    stack.enter_context(item)
                if failed:
                    with self.assertRaisesRegex(s.BoundaryError, 'scratch cleanup failed'):
                        s.main()
                else:
                    s.main()
            expected = ['drain', 'clear', 'execute', 'drain', 'clear']
            if not failed:
                expected.append('export')
            self.assertEqual(events, expected + ['drain', 'clear', 'remove'])

    def test_diagnostic_tail_is_bounded_and_cannot_inject_workflow_commands(self):
        dangerous = b'::add-mask::value\n\x1b[31m'
        tail = bytearray(b'a' * 65536)
        with patch.object(s.os, 'read', side_effect=[dangerous, BlockingIOError()]):
            s.drain_log(5, tail)
        self.assertEqual(len(tail), 65536)
        self.assertTrue(tail.endswith(dangerous))
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            s.report_log(tail)
        text = output.getvalue()
        self.assertNotIn('::add-mask::', text)
        self.assertEqual(text.count('\n'), 1)
        self.assertEqual(base64.b64decode(text.split(': ', 1)[1]), tail)

    def test_child_drops_privileges_before_fixed_exec_and_scrubs_environment(self):
        for groups, allowed in (([], True), ([590], True), ([590, 80], False)):
            events = []
            class Executed(BaseException):
                pass
            def execve(program, argv, env):
                events.append(('exec', program, argv, env))
                raise Executed()
            def exit_child(code):
                raise Executed()
            builder = types.SimpleNamespace(pw_uid=590, pw_gid=590)
            with patch.object(s.os, 'pipe', return_value=(10, 11)), patch.object(s.os, 'fork', return_value=0), \
                 patch.object(s.os, 'close'), patch.object(s.os, 'dup2'), patch.object(s.os, 'open', return_value=12), \
                 patch.object(s.os, 'closerange'), patch.object(s.os, 'listdir', return_value=['0', '1', '2']), \
                 patch.object(s.os, 'setsid'), patch.object(s.os, 'chdir'), \
                 patch.object(s.os, 'setgroups', side_effect=lambda value: events.append(('groups', value))), \
                 patch.object(s.os, 'setgid', side_effect=lambda value: events.append(('gid', value))), \
                 patch.object(s.os, 'setuid', side_effect=lambda value: events.append(('uid', value))), \
                 patch.object(s.os, 'getuid', return_value=590), patch.object(s.os, 'geteuid', return_value=590), \
                 patch.object(s, 'kernel_groups', return_value=groups), patch.object(s.os, 'execve', side_effect=execve), \
                 patch.object(s.os, '_exit', side_effect=exit_child), patch.dict(os.environ, SECRET_CANARY='never inherit'):
                with self.assertRaises(Executed):
                    s.execute(Path('/private/var/db/buzz-macos-build/build-test'), {}, builder, Path('/owned/darwin'))
            self.assertEqual(events[:3], [('groups', []), ('gid', 590), ('uid', 590)])
            if not allowed:
                self.assertEqual(len(events), 3)
                continue
            self.assertEqual(events[3][1], '/usr/bin/python3')
            self.assertEqual(events[3][2][1:3], ['-I', str(s.INSTALL / 'buzz_macos_build_boundary.py')])
            self.assertNotIn('SECRET_CANARY', events[3][3])
            self.assertEqual(events[3][3]['BUZZ_DARWIN_ROOT'], '/owned/darwin')

class ProvisionTests(unittest.TestCase):
    def test_bundle_hash_is_external_authority_and_payload_is_held_in_memory(self):
        with tempfile.TemporaryDirectory() as temp:
            bundle = Path(temp)
            data = b'reviewed payload'
            for name in p.FILES:
                (bundle / name).write_bytes(data)
            manifest = {'schema': 1, 'workflow_sha': 'b' * 40, 'files': {name: p.digest(data) for name in p.FILES}}
            raw = json.dumps(manifest).encode()
            (bundle / 'bundle.json').write_bytes(raw)
            _, payload = p.load_bundle(bundle, p.digest(raw))
            (bundle / p.FILES[0]).write_bytes(b'replaced')
            self.assertEqual(payload[p.FILES[0]], data)
            with self.assertRaises(RuntimeError):
                p.load_bundle(bundle, p.digest(raw))
            with self.assertRaises(RuntimeError):
                p.load_bundle(bundle, '0' * 64)

    def test_narrow_sudoers_has_exact_python_and_no_wildcards(self):
        self.assertEqual(p.RULE, 'm5mbp ALL=(root) NOPASSWD: /usr/bin/python3 -I /usr/local/libexec/buzz-macos-build/buzz_macos_build_supervisor.py\n')

if __name__ == '__main__':
    unittest.main()
