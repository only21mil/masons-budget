#!/usr/bin/env python3
"""Hosted iOS release failure boundaries, using public synthetic fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


ios = module('buzz_ios_release')


class HostedSigningTests(unittest.TestCase):
    def test_keychain_restores_after_codesign_failure(self):
        before = ['/Users/runner/Library/Keychains/login.keychain-db']
        state = before.copy()
        def read(_argv):
            return ''.join('    "' + p + '"\n' for p in state).encode()
        def write(argv):
            state[:] = argv[4:]
        with patch.dict(os.environ, RUNNER_ENVIRONMENT='github-hosted'), \
             patch.object(ios, 'run', side_effect=read), patch.object(ios.common, 'security_command', side_effect=write):
            with self.assertRaisesRegex(RuntimeError, 'codesign fixture'):
                with ios.hosted_keychain(Path('/owned/signing.keychain-db')):
                    self.assertEqual(state[-1], '/owned/signing.keychain-db')
                    raise RuntimeError('codesign fixture')
            self.assertEqual(state, before)

    def test_persistent_host_rejected_before_credential_use(self):
        with patch.dict(os.environ, RUNNER_ENVIRONMENT='self-hosted'), patch.object(ios, 'check_build') as check:
            with self.assertRaisesRegex(ValueError, 'hosted signing VM required'):
                ios.sign(None)
            check.assert_not_called()

    def test_workflow_has_no_build_secrets_and_separate_hosted_jobs(self):
        import yaml
        workflow = yaml.safe_load((SCRIPTS.parent / 'buzz-ios-release.yml').read_text())
        jobs = workflow['jobs']
        self.assertNotIn('secrets.', json.dumps(jobs['build']))
        self.assertEqual(jobs['build']['runs-on'], 'macos-26')
        self.assertEqual(jobs['sign-upload']['runs-on'], 'macos-26')
        self.assertEqual(jobs['sign-upload']['needs'], 'build')
        self.assertNotIn('buzz_macos_build_boundary', json.dumps(workflow))
        self.assertNotIn('buzz-apple-release', workflow['concurrency']['group'])

    def test_receipt_retention_survives_processing_or_cleanup_failure(self):
        import yaml
        workflow = yaml.safe_load((SCRIPTS.parent / 'buzz-ios-release.yml').read_text())
        steps = workflow['jobs']['sign-upload']['steps']
        retention = steps[-1]
        self.assertEqual(retention['name'], 'Preserve upload receipt after cleanup')
        self.assertEqual(retention['if'], 'always()')
        self.assertIn('signed-ios/upload.json', retention['with']['path'])
        self.assertIn('signed-ios/asc-*.json', retention['with']['path'])
        # A pre-prepare failure has no receipt. It must keep the original failure
        # without requiring a nonexistent successful-upload file for recovery.
        self.assertEqual(retention['with']['if-no-files-found'], 'warn')


if __name__ == '__main__':
    unittest.main()
