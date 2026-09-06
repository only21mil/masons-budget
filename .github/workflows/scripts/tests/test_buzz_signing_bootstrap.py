#!/usr/bin/env python3
"""No network, real credential reads, key generation, or GitHub mutations."""
import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import buzz_developer_id as api
import buzz_signing_store as local


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.out = Path(self.temp.name) / "public"
        self.addCleanup(self.temp.cleanup)

    def test_probe_uses_only_one_get(self):
        transport = Mock(return_value=(200, {"data": []}))
        result = api.run("buzz-developer-id-probe", "", self.out, transport, "fake-token")
        transport.assert_called_once_with("GET", "fake-token")
        self.assertEqual(result["status"], "READ_ONLY_PASS")
        self.assertEqual(result["create_permission"], "unproven")

    def test_probe_rejects_csr_without_network(self):
        transport = Mock()
        with self.assertRaises(api.Hold):
            api.run("buzz-developer-id-probe", "anything", self.out, transport, "fake-token")
        transport.assert_not_called()

    def test_invalid_create_csr_never_accesses_network(self):
        transport = Mock()
        for text in ("", "!", base64.b64encode(b"-----BEGIN PRIVATE KEY-----\nAA==").decode()):
            with self.assertRaises(api.Hold):
                api.run("buzz-developer-id-create", text, self.out, transport, "fake-token")
        transport.assert_not_called()

    def test_get_failure_and_pagination_never_create(self):
        for status, payload in ((403, {"error_codes": ["FORBIDDEN_ERROR"]}),
                                (200, {"data": [], "links": {"next": "https://attacker.invalid"}})):
            transport = Mock(return_value=(status, payload))
            with patch.object(api, "csr_input", return_value=(Mock(), "public CSR")):
                with self.assertRaises(api.Hold):
                    api.run("buzz-developer-id-create", "public", self.out, transport, "fake-token")
            self.assertEqual(transport.call_count, 1)

    def test_single_post_refusal_is_retained_and_never_retried(self):
        transport = Mock(side_effect=[(200, {"data": []}), (403, {"error_codes": ["FORBIDDEN_ERROR"]})])
        with patch.object(api, "csr_input", return_value=(Mock(), "public CSR")):
            with self.assertRaises(api.Hold):
                api.run("buzz-developer-id-create", "public", self.out, transport, "fake-token")
        self.assertEqual([c.args[0] for c in transport.call_args_list], ["GET", "POST"])
        sent = transport.call_args.args[2]
        self.assertEqual(sent, {"data": {"type": "certificates", "attributes": {"certificateType": "DEVELOPER_ID_APPLICATION", "csrContent": "public CSR"}}})
        receipt = json.loads((self.out / "receipt.json").read_text())
        self.assertEqual(receipt["create_http_status"], 403)
        self.assertEqual(receipt["post_attempts"], 1)
        self.assertEqual(receipt["apple_error_codes"], ["FORBIDDEN_ERROR"])
        self.assertNotIn("fake-token", json.dumps(receipt))

    def test_cap_never_revokes_or_posts(self):
        rows = [{"id": str(i), "attributes": {"certificateType": api.CERT_TYPE}} for i in range(5)]
        transport = Mock(return_value=(200, {"data": rows}))
        with patch.object(api, "csr_input", return_value=(Mock(), "public CSR")), \
             patch.object(api, "inspect_certificate", return_value=(b"public DER", Mock())), \
             patch.object(api, "public_bytes", side_effect=[b"a", b"b"] * 5):
            with self.assertRaises(api.Hold):
                api.run("buzz-developer-id-create", "public", self.out, transport, "fake-token")
        transport.assert_called_once()

    def test_matching_public_key_reuses_certificate(self):
        row = {"id": "EXISTING", "attributes": {"certificateType": api.CERT_TYPE}}
        transport = Mock(return_value=(200, {"data": [row]}))
        cert = Mock()
        cert.not_valid_after_utc.isoformat.return_value = "2027-01-01T00:00:00Z"
        with patch.object(api, "csr_input", return_value=(Mock(), "public CSR")), \
             patch.object(api, "inspect_certificate", return_value=(b"public DER", cert)), \
             patch.object(api, "public_bytes", return_value=b"same public key"):
            result = api.run("buzz-developer-id-create", "public", self.out, transport, "fake-token")
        transport.assert_called_once()
        self.assertTrue(result["reused_matching_public_key"])
        self.assertEqual((self.out / "buzz-developer-id.cer").read_bytes(), b"public DER")

    def test_successful_create_retains_issued_id_before_der_failure(self):
        row = {"id": "NEWCERT", "attributes": {"certificateType": api.CERT_TYPE}}
        transport = Mock(side_effect=[(200, {"data": []}), (201, {"data": row})])
        with patch.object(api, "csr_input", return_value=(Mock(), "public CSR")), \
             patch.object(api, "inspect_certificate", side_effect=api.Hold("bad public DER")):
            with self.assertRaises(api.Hold):
                api.run("buzz-developer-id-create", "public", self.out, transport, "fake-token")
        receipt = json.loads((self.out / "receipt.json").read_text())
        self.assertEqual(receipt["certificate_id"], "NEWCERT")
        self.assertEqual(receipt["create_permission"], "confirmed")
        self.assertEqual(transport.call_count, 2)

    def test_redirect_is_never_followed(self):
        with self.assertRaises(api.Hold):
            api.NoRedirect().redirect_request(None, None, 302, "", {}, "https://attacker.invalid")

    def test_local_dry_run_does_not_open_store(self):
        with patch.object(sys, "argv", ["script", "developer-id-key"]), \
             patch.object(local, "Store") as store, patch("builtins.print"):
            local.main()
        store.assert_not_called()

    def test_store_appends_without_changing_unrelated_entries(self):
        path = Path(self.temp.name) / "protected" / "secrets.env"
        with patch.object(local, "STORE", path):
            with local.Store() as store:
                store.append({"BUZZ_TEST_PUBLIC": "synthetic-value"})
            original = path.read_bytes()
            with local.Store() as store:
                self.assertEqual(store.require("BUZZ_TEST_PUBLIC"), "synthetic-value")
                with self.assertRaises(api.Hold):
                    store.append({"BUZZ_TEST_PUBLIC": "overwrite"})
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)

    def test_store_refuses_symlink(self):
        target = Path(self.temp.name) / "target"
        target.write_text("synthetic")
        path = Path(self.temp.name) / "link"
        path.symlink_to(target)
        with patch.object(local, "STORE", path):
            with self.assertRaises(api.Hold):
                with local.Store():
                    self.fail("must not open symlink")

    def test_install_refuses_existing_inputs_before_writes(self):
        result = SimpleNamespace(returncode=0, stdout=json.dumps([{"name": local.SECRET_NAMES[0]}]).encode())
        with patch.object(local.subprocess, "run", return_value=result) as command:
            with self.assertRaises(api.Hold):
                local.github_install(Mock())
        self.assertTrue(all("set" not in c.args[0] for c in command.call_args_list))

    def test_install_values_are_stdin_only(self):
        result = SimpleNamespace(returncode=0, stdout=b"[]")
        store = Mock()
        store.require.return_value = "synthetic-value-not-a-credential"
        with patch.object(local.subprocess, "run", return_value=result) as command:
            local.github_install(store)
        for call in command.call_args_list:
            self.assertNotIn(store.require.return_value, " ".join(call.args[0]))
            if "set" in call.args[0]:
                self.assertEqual(call.kwargs["input"], store.require.return_value.encode())

    def test_root_fingerprint_has_exact_digest_length(self):
        self.assertEqual(len(bytes.fromhex(local.APPLE_ROOT_SHA256)), 32)


if __name__ == "__main__":
    unittest.main()
