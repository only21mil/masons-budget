"""Captured macOS public dscl output and strict account-attribute refusal."""
import importlib.util
from pathlib import Path
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'provision', Path(__file__).resolve().parents[1] / 'buzz_macos_build_provision.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

# Exact public output captured before the refused upgrade on 2026-09-08.
PUBLIC_ATTRIBUTES = {'AuthenticationAuthority': 'AuthenticationAuthority: ;DisabledUser;\n', 'GeneratedUID': 'GeneratedUID: 59A769E8-234B-4994-A9FE-EABD149795FB\n', 'IsHidden': 'dsAttrTypeNative:IsHidden: 1\n', 'NFSHomeDirectory': 'NFSHomeDirectory: /var/empty\n', 'PrimaryGroupID': 'PrimaryGroupID: 590\n', 'UniqueID': 'UniqueID: 590\n', 'UserShell': 'UserShell: /usr/bin/false\n'}


class AccountAttributeTests(unittest.TestCase):
    def setUp(self):
        self.attrs = dict(PUBLIC_ATTRIBUTES)
        for name, value in {
            'command': self.command,
        }.items():
            mock = patch.object(p, name, value)
            mock.start()
            self.addCleanup(mock.stop)
        group = types.SimpleNamespace(gr_gid=590, gr_name='buzzbuild', gr_mem=[])
        for name, value in {'getgrnam': lambda _: group, 'getgrall': lambda: [group]}.items():
            mock = patch.object(p.grp, name, value)
            mock.start()
            self.addCleanup(mock.stop)

    def command(self, argv):
        self.assertEqual(argv[:-1], ['/usr/bin/dscl', '.', '-read', '/Users/buzzbuild'])
        return self.attrs[argv[-1]].encode()

    def test_captured_native_output_passes(self):
        result = p.account_attributes()
        self.assertEqual(result, {
            'UniqueID': '590', 'PrimaryGroupID': '590', 'UserShell': '/usr/bin/false',
            'NFSHomeDirectory': '/var/empty', 'AuthenticationAuthority': ';DisabledUser;',
            'GeneratedUID': '59A769E8-234B-4994-A9FE-EABD149795FB', 'IsHidden': '1'})

    def test_short_hidden_label_still_passes(self):
        self.attrs['IsHidden'] = 'IsHidden: 1\n'
        self.assertEqual(p.account_attributes()['IsHidden'], '1')

    def test_wrong_native_prefixes_refused(self):
        for output in ('dsAttrTypeStandard:IsHidden: 1\n', 'dsAttrTypeNative:Other: 1\n',
                       'dsAttrTypeNative:IsHiddenExtra: 1\n', 'prefix:dsAttrTypeNative:IsHidden: 1\n'):
            with self.subTest(output=output):
                self.attrs['IsHidden'] = output
                with self.assertRaises(RuntimeError):
                    p.account_attributes()

    def test_native_prefix_refused_for_other_attributes(self):
        for name in PUBLIC_ATTRIBUTES:
            if name == 'IsHidden':
                continue
            with self.subTest(name=name):
                self.attrs = dict(PUBLIC_ATTRIBUTES)
                self.attrs[name] = 'dsAttrTypeNative:' + self.attrs[name]
                with self.assertRaises(RuntimeError):
                    p.account_attributes()

    def test_duplicate_attributes_refused(self):
        for name in PUBLIC_ATTRIBUTES:
            with self.subTest(name=name):
                self.attrs = dict(PUBLIC_ATTRIBUTES)
                self.attrs[name] *= 2
                with self.assertRaises(RuntimeError):
                    p.account_attributes()

    def test_invalid_hidden_values_refused(self):
        for value in ('', '0', '2', '01', '1 1', '1: 1', '1\nIsHidden: 1'):
            with self.subTest(value=value):
                self.attrs['IsHidden'] = 'dsAttrTypeNative:IsHidden: ' + value + '\n'
                with self.assertRaises(RuntimeError):
                    p.account_attributes()

    def test_disabled_identity_values_still_refused(self):
        for name, value in {'UniqueID': '591', 'PrimaryGroupID': '591',
                            'UserShell': '/bin/zsh', 'AuthenticationAuthority': ';Basic;',
                            'GeneratedUID': ''}.items():
            with self.subTest(name=name):
                self.attrs = dict(PUBLIC_ATTRIBUTES)
                self.attrs[name] = name + ': ' + value + '\n'
                with self.assertRaises(RuntimeError):
                    p.account_attributes()


if __name__ == '__main__':
    unittest.main()
