#!/usr/bin/env python3
"""Preserved iOS provenance and redacted signing failure boundaries."""
import argparse
from contextlib import redirect_stdout
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ios_recovery', SCRIPTS / 'buzz_ios_recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
ENV = {'GITHUB_RUN_ID': '999', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_SHA': 'c' * 40,
       'RUNNER_ENVIRONMENT': 'github-hosted'}


def provider():
    return [
        {'id': int(recovery.BUILD_RUN), 'run_attempt': 1, 'workflow_id': 352536614,
         'head_sha': recovery.BUILD_WORKFLOW, 'event': 'workflow_dispatch', 'status': 'completed'},
        {'total_count': 2, 'jobs': [{'id': recovery.BUILD_JOB, 'name': 'build', 'conclusion': 'success'},
                                  {'id': 2, 'name': 'sign-upload', 'conclusion': 'failure'}]},
        {'id': recovery.ARTIFACT, 'expired': False, 'name': 'buzz-ios-unsigned-' + recovery.SOURCE,
         'digest': 'sha256:' + recovery.ZIP_SHA,
         'workflow_run': {'id': int(recovery.BUILD_RUN), 'head_sha': recovery.BUILD_WORKFLOW}},
    ]


class RecoveryTests(unittest.TestCase):
    def test_original_binding_survives_without_rewriting_execution_environment(self):
        args = recovery.arguments()
        with patch.dict(os.environ, ENV):
            result = recovery.ios.binding(args)
            self.assertEqual(result['run_id'], recovery.BUILD_RUN)
            self.assertEqual(result['workflow_sha'], recovery.BUILD_WORKFLOW)
            self.assertEqual(os.environ['GITHUB_RUN_ID'], '999')
            self.assertEqual(os.environ['GITHUB_SHA'], 'c' * 40)
            del args.build_origin
            self.assertEqual(recovery.ios.binding(args)['run_id'], '999')

    def test_provider_binds_successful_build_even_when_original_signer_failed(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, ENV), \
             patch.object(recovery, 'request', side_effect=provider()):
            old = Path.cwd()
            try:
                os.chdir(temp); recovery.provenance()
                proof = json.loads(Path('ios-recovery-provenance.json').read_text())
                self.assertEqual(proof['source_run'], recovery.BUILD_RUN)
                self.assertEqual(proof['current_run'], '999')
            finally:
                os.chdir(old)

    def test_failed_build_wrong_source_or_changed_artifact_stops_provenance(self):
        cases = [(0, 'head_sha', 'b' * 40), (0, 'run_attempt', 2), (1, 'total_count', 3),
                 (2, 'expired', True), (2, 'digest', 'sha256:' + '0' * 64), (2, 'name', 'other-artifact')]
        for index, field, value in cases:
            responses = provider(); responses[index][field] = value
            with self.subTest(field=field), patch.dict(os.environ, ENV), \
                 patch.object(recovery, 'request', side_effect=responses), redirect_stdout(io.StringIO()):
                with self.assertRaises(recovery.RecoveryError):
                    recovery.provenance()
        responses = provider(); responses[1]['jobs'][0]['conclusion'] = 'failure'
        with patch.dict(os.environ, ENV), patch.object(recovery, 'request', side_effect=responses), redirect_stdout(io.StringIO()):
            with self.assertRaises(recovery.RecoveryError):
                recovery.provenance()

    def test_changed_preserved_bytes_stop_before_prepare_or_sign(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, ENV), \
             patch.object(recovery, 'request', side_effect=provider()), redirect_stdout(io.StringIO()):
            old = Path.cwd()
            try:
                os.chdir(temp); recovery.provenance(); Path('unsigned').mkdir()
                Path('unsigned/unsigned-ios.app.tar.gz').write_bytes(b'tampered')
                Path('unsigned/build-ios.json').write_bytes(b'tampered')
                with patch.object(recovery.ios, 'check_build') as checked:
                    with self.assertRaises(recovery.RecoveryError):
                        recovery.verify_input(recovery.arguments())
                    checked.assert_not_called()
            finally:
                os.chdir(old)

    def test_native_error_output_is_classified_without_secret_or_path_leakage(self):
        private = b'secret-password /Users/private-owner/secret-path'
        result = subprocess.CompletedProcess([], 1, private, b'The specified item could not be found in the keychain\n' + private)
        stream = io.StringIO()
        with patch.object(recovery.subprocess, 'run', return_value=result), redirect_stdout(stream):
            with self.assertRaises(recovery.RecoveryError):
                recovery.traced_run(['/usr/bin/codesign', '--force', '--sign', 'secret-identity', '/private/app'])
        output = stream.getvalue()
        self.assertIn('KEYCHAIN_ITEM_NOT_FOUND', output)
        for value in ['secret-password', 'private-owner', 'secret-path', 'secret-identity', '/private/app']:
            self.assertNotIn(value, output)

    def test_security_stdin_and_assertions_never_render_values(self):
        stream = io.StringIO()
        with redirect_stdout(stream), patch.object(recovery.subprocess, 'run',
                return_value=subprocess.CompletedProcess([], 1, b'private-echo', b'private-echo')):
            recovery.CURRENT_PHASE = 'security.import'
            with self.assertRaises(recovery.RecoveryError):
                recovery.traced_run(['/usr/bin/security', '-i'], input_data=b'private-input', confidential=True)
            with self.assertRaises(recovery.RecoveryError):
                recovery.checked(False, 'private-value-in-unexpected-message')
        self.assertNotIn('private-', stream.getvalue())
        self.assertIn('security.import', stream.getvalue())
        self.assertIn('assertion_id', stream.getvalue())

    def test_failed_keychain_deletion_still_unlinks_raw_credentials_and_fails(self):
        with tempfile.TemporaryDirectory() as temp, redirect_stdout(io.StringIO()):
            root = Path(temp)
            keychain = root / 'signing.keychain-db'
            p12 = root / 'distribution.p12'
            p8 = root / 'AuthKey_TEST.p8'
            for path in [keychain, p12, p8]:
                path.write_bytes(b'synthetic-fixture')
            with patch.object(recovery.ios, 'paths', return_value=(root, root)), \
                 patch.object(recovery.ios, 'run', recovery.traced_run), \
                 patch.object(recovery.ios, 'require', recovery.checked), \
                 patch.object(recovery.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'')):
                with self.assertRaises(recovery.RecoveryError):
                    recovery.ios.cleanup()
            self.assertFalse(p12.exists())
            self.assertFalse(p8.exists())
            self.assertTrue(keychain.exists())

    def test_workflow_never_builds_and_always_retains_diagnostics(self):
        import yaml
        workflow = yaml.safe_load((SCRIPTS.parent / 'buzz-ios-signing-recovery.yml').read_text())
        self.assertEqual(set(workflow['jobs']), {'sign-upload'})
        job = workflow['jobs']['sign-upload']
        self.assertEqual(job['runs-on'], 'macos-26')
        self.assertNotIn('flutter build', json.dumps(job))
        download = next(s for s in job['steps'] if str(s.get('uses', '')).startswith('actions/download-artifact@'))
        self.assertEqual(download['with']['artifact-ids'], str(recovery.ARTIFACT))
        self.assertEqual(download['with']['run-id'], recovery.BUILD_RUN)
        self.assertEqual(job['steps'][-1]['if'], 'always()')
        self.assertIn('signed-ios/recovery-events.jsonl', job['steps'][-1]['with']['path'])
        self.assertEqual(job['steps'][-2]['if'], 'always()')


if __name__ == '__main__':
    unittest.main()
