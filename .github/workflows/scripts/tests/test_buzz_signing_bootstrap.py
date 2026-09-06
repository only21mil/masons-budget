#!/usr/bin/env python3
"""No network, real credential reads, key generation, or GitHub mutations."""
import base64
import json
import multiprocessing
import sys
from datetime import datetime, timezone
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from cryptography.exceptions import InvalidSignature

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import buzz_developer_id as api
import buzz_signing_store as local


# Public Apple CA DER only, downloaded from Apple PKI on 2026-09-05.
# Inline fixtures keep the public-certificate regressions self-contained.
PUBLIC_APPLE_CA = {
    'AppleIncRootCertificate': (
        'MIIEuzCCA6OgAwIBAgIBAjANBgkqhkiG9w0BAQUFADBiMQswCQYDVQQGEwJVUzETMBEGA1UEChMKQXBwbGUgSW5j'
        'LjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkxFjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0Ew'
        'HhcNMDYwNDI1MjE0MDM2WhcNMzUwMjA5MjE0MDM2WjBiMQswCQYDVQQGEwJVUzETMBEGA1UEChMKQXBwbGUgSW5j'
        'LjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkxFjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0Ew'
        'ggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDkkakJH5HbHkdQ6wXtXnmELes2oldMVeyLGYne+Uts9Qer'
        'IjAC6Bg++FAJ039BqJj50cpmnCRrEdCju+QbKsMflZ56DKRHi1vUFjczy8QPTc4UadHJGXL1XQ7Vf1+b8iUDulWP'
        'TV0N8WQ1IxVLFVkds5T39pyez1C6wVhQZ48ItCD3y6wsIG9wtj8BMIy3Q88PnT3zK0koGsj+zrW5DtleHNbLPbU6'
        'rfQPDgCSC7EhFi501TwN22IWq6NxkkdTVcGvL0Gz+PvjcM3mo0xFfh9Ma1CWQYnEdGILEINBhzOKgbEwWOxaBDKM'
        'aLOPHd5lc/9nXmW8Sdh2nzMUZaF3lMktAgMBAAGjggF6MIIBdjAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUw'
        'AwEB/zAdBgNVHQ4EFgQUK9BpR5R2Cf70a40uQKb3R01/CF4wHwYDVR0jBBgwFoAUK9BpR5R2Cf70a40uQKb3R01/'
        'CF4wggERBgNVHSAEggEIMIIBBDCCAQAGCSqGSIb3Y2QFATCB8jAqBggrBgEFBQcCARYeaHR0cHM6Ly93d3cuYXBw'
        'bGUuY29tL2FwcGxlY2EvMIHDBggrBgEFBQcCAjCBthqBs1JlbGlhbmNlIG9uIHRoaXMgY2VydGlmaWNhdGUgYnkg'
        'YW55IHBhcnR5IGFzc3VtZXMgYWNjZXB0YW5jZSBvZiB0aGUgdGhlbiBhcHBsaWNhYmxlIHN0YW5kYXJkIHRlcm1z'
        'IGFuZCBjb25kaXRpb25zIG9mIHVzZSwgY2VydGlmaWNhdGUgcG9saWN5IGFuZCBjZXJ0aWZpY2F0aW9uIHByYWN0'
        'aWNlIHN0YXRlbWVudHMuMA0GCSqGSIb3DQEBBQUAA4IBAQBcNplMLXi37Yyb3PN3m/J20ncwT8EfhYOFG5k9Rzfy'
        'qZtAjizUsZAS2L70c5vu0mQPy3lPNNiiPvl4/2vIB+x9OYOLUyDTOMSxv5pPCmv/K/xZpwUJfBdAVhEedNO3iyM7'
        'R6PVbyTi69G3cN8PReEnyvFteO3ntRcXqNx+IjXKJdXZD9Zr1KIkIxH3oayPc4FgxhtbCS+SsvhESPBgOJ4V9T0m'
        'ZyCKM2r3DYLP3uujL/lTaltkwGMzd/c6ByxW69oPIQ7aunMZT7XZNn/Bh1XZp5m5MkL72NVxnn6hUrcbvZNCJBIq'
        'xw8dtk2cXmPIS4AXUKqK1drk/NAJBzewdXUh'
    ),
    'DeveloperIDCA': (
        'MIIEBDCCAuygAwIBAgIIGHqpqMKWIQwwDQYJKoZIhvcNAQELBQAwYjELMAkGA1UEBhMCVVMxEzARBgNVBAoTCkFw'
        'cGxlIEluYy4xJjAkBgNVBAsTHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRYwFAYDVQQDEw1BcHBsZSBS'
        'b290IENBMB4XDTEyMDIwMTIyMTIxNVoXDTI3MDIwMTIyMTIxNVoweTEtMCsGA1UEAwwkRGV2ZWxvcGVyIElEIENl'
        'cnRpZmljYXRpb24gQXV0aG9yaXR5MSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEG'
        'A1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCJdk8G'
        'W5pB7qUjKwKjX9dzP8A1sIuECj8GJH+nlT/rTw6Tr7QO0Mg+5W0Ysx/oiUe/1wkI5P9WmCkV55SduTWjCs20wOHi'
        'YPTK7Cl4RWlpYGtfipL8niPmOsIiszFPHLrytjRZQu6wqQIDGJEEtrN4LjMfgEUNRW+7Dlpbfzrn2AjXCw4ybfuG'
        'NuRsq8QRinCEJqqfRNHxuMZ7lBebSPcLWBa6I8WfFTl+yl3DMl8P4FJ/QOq+rAhklVvJGpzlgMofakQcbD7EsCYf'
        'Hex7r16gaj1HqVgSMT8gdihtHRywwk4RaSaLy9bQEYLJTg/xVnTQ2QhLZniiq6yn4tJMh1nJAgMBAAGjgaYwgaMw'
        'HQYDVR0OBBYEFFcX7aLP3HyYoRDg/L6HLSzy4xdUMA8GA1UdEwEB/wQFMAMBAf8wHwYDVR0jBBgwFoAUK9BpR5R2'
        'Cf70a40uQKb3R01/CF4wLgYDVR0fBCcwJTAjoCGgH4YdaHR0cDovL2NybC5hcHBsZS5jb20vcm9vdC5jcmwwDgYD'
        'VR0PAQH/BAQDAgGGMBAGCiqGSIb3Y2QGAgYEAgUAMA0GCSqGSIb3DQEBCwUAA4IBAQBCOXRrodzGpI83KoyzHQpE'
        'vJUsf7xZuKxh+weQkjK51L87wVA5akR0ouxbH3Dlqt1LbBwjcS1f0cWTvu6binBlgp0W4xoQF4ktqM39DHhYSQwo'
        'fzPuAHobtHastrW7T9+oG53IGZdKC1ZnL8I+trPEgzrwd210xC4jUe6apQNvYPSlSKcGwrta4h8fRkV+5Jf1JxC3'
        'ICJyb3LaxlB1xT0lj12jAOmfNoxIOY+zO+qQgC6VmmD0eM70DgpTPqL6T9geroSVjTK8Vk2J6XgY4KyaQrp6RhuE'
        'oonOFOiI0ViL9q5WxCwFKkWvC9lLqQIPNKyIx2FViUTJJ3MH7oLlTvVw'
    ),
    'DeveloperIDG2CA': (
        'MIIEPjCCAyagAwIBAgIUf7QAP82XSXrLg02SpIp4c8KEXUMwDQYJKoZIhvcNAQELBQAwYjELMAkGA1UEBhMCVVMx'
        'EzARBgNVBAoTCkFwcGxlIEluYy4xJjAkBgNVBAsTHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRYwFAYD'
        'VQQDEw1BcHBsZSBSb290IENBMB4XDTIxMDkyMjE4NTUxMFoXDTMxMDkxNzAwMDAwMFowXjEtMCsGA1UEAwwkRGV2'
        'ZWxvcGVyIElEIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MQswCQYDVQQLDAJHMjETMBEGA1UECgwKQXBwbGUgSW5j'
        'LjELMAkGA1UEBhMCVVMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDTLJVoIVSRir9lccIYTvbNDeGR'
        'KHXXA7qVH9MSmVJE3oBGZ/wpiwCFiIowh01Mbkq0x+UC49djTKrM6uzbQi+RfSXpX6RLKlRvF6wwnykoNKR/j+V4'
        '410jKiFG0InDX/hql51xGxiosgzJAwo1sgKnLfWz3BuDxSchQHKm5zd2Mee7Br90svZwrEysLc3JXkWLz/sI5mLV'
        'QJW1N1zMGw7h79yl5Y3JULdAnwojJUVAj5Rne+CU6jnTeKU00cLL4DN/LrYsw+Um1SXOqo0qd/yeFJaX4PVfLvLo'
        'p3GnO6OZTHoio03vcBHV1oaBgvFnM5MzWkCxksSqc5YdxFz/4es3AgMBAAGjge8wgewwEgYDVR0TAQH/BAgwBgEB'
        '/wIBADAfBgNVHSMEGDAWgBQr0GlHlHYJ/vRrjS5ApvdHTX8IXjBEBggrBgEFBQcBAQQ4MDYwNAYIKwYBBQUHMAGG'
        'KGh0dHA6Ly9vY3NwLmFwcGxlLmNvbS9vY3NwMDMtYXBwbGVyb290Y2EwLgYDVR0fBCcwJTAjoCGgH4YdaHR0cDov'
        'L2NybC5hcHBsZS5jb20vcm9vdC5jcmwwHQYDVR0OBBYEFPg6DGkRduDtrNHrpln6N9XEVbAeMA4GA1UdDwEB/wQE'
        'AwIBBjAQBgoqhkiG92NkBgIGBAIFADANBgkqhkiG9w0BAQsFAAOCAQEAwf1DClm/8bG3QxBa1hgyMBRWJuERSGMr'
        'aXKXSB+OW8peJhX7dCOAM1QzGaEihlrYuEtpqqfOlpbCCsc1atBvzoppg2JtSjn1/oNN16LUiB/tiMAP+PkzHrQQ'
        't8JcETdENwSwpESdjGgNe30dfsy1k/DWbz0VeoCldNPhj33SiOgxp5jFH9/iglmugIFgRhbsnrmKQKobKuFhhgqM'
        'cA/ZSizsTKIFEdZ5jKVjJSEjAm+TW1pXoddFbd/M93+fX9vH7WSnb0Qvb009eHgKVrQ71zrIK2Wik+rbWOqO1LnE'
        'wDD8MhpNupIMJDmYgjqgmd7n5OS8DryFr1qrXND828wQww=='
    ),
}


def concurrent_store_writer(path, channel, first):
    """Use separate descriptors and real flock; all values are synthetic nonkeys."""
    original_flock = local.fcntl.flock

    def report_contention(fd, operation):
        try:
            original_flock(fd, operation | local.fcntl.LOCK_NB)
        except BlockingIOError:
            channel.send("waiting-on-lock")
            return original_flock(fd, operation)
        raise AssertionError("second process did not contend on the first lock")

    try:
        with patch.object(local, "STORE", path), patch.object(
            local.fcntl, "flock", original_flock if first else report_contention
        ):
            with local.Store() as store:
                if first:
                    channel.send("locked")
                    if not channel.poll(10) or channel.recv() != "append":
                        raise AssertionError("first process was not released")
                    store.append({"BUZZ_SYNTHETIC_FIRST": "synthetic-first-not-a-key"})
                else:
                    seen = store.values.get("BUZZ_SYNTHETIC_FIRST")
                    refused = False
                    try:
                        store.append({"BUZZ_SYNTHETIC_FIRST": "synthetic-replacement-not-a-key"})
                    except api.Hold:
                        refused = True
                    store.append({"BUZZ_SYNTHETIC_SECOND": "synthetic-second-not-a-key"})
                    channel.send((seen, refused))
    finally:
        channel.close()


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

    def test_waiting_store_reads_locked_contents_and_preserves_both_appends(self):
        path = Path(self.temp.name) / "protected" / "fixture.env"
        path.parent.mkdir(mode=0o700)
        original = b"UNRELATED=synthetic-preserved-without-final-newline"
        path.write_bytes(original)
        path.chmod(0o600)
        context = multiprocessing.get_context("spawn")
        processes, channels = [], []

        def start(first):
            parent, child = context.Pipe()
            process = context.Process(target=concurrent_store_writer, args=(path, child, first))
            process.start()
            child.close()
            processes.append(process)
            channels.append(parent)
            return parent

        def receive(channel):
            self.assertTrue(channel.poll(10), "store process did not respond")
            return channel.recv()

        try:
            first = start(True)
            self.assertEqual(receive(first), "locked")
            second = start(False)
            self.assertEqual(receive(second), "waiting-on-lock")
            first.send("append")
            observed = receive(second)
            for process in processes:
                process.join(10)
                self.assertEqual(process.exitcode, 0)
            self.assertEqual(observed, ("synthetic-first-not-a-key", True))
            self.assertEqual(path.read_bytes(), original + (
                b"\nBUZZ_SYNTHETIC_FIRST=synthetic-first-not-a-key\n"
                b"BUZZ_SYNTHETIC_SECOND=synthetic-second-not-a-key\n"
            ))
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                process.join(10)
                process.close()
            for channel in channels:
                channel.close()

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


class AppleChainTests(unittest.TestCase):
    def setUp(self):
        self.certs = {name: local.x509.load_der_x509_certificate(base64.b64decode(der))
                      for name, der in PUBLIC_APPLE_CA.items()}
        self.root = self.certs["AppleIncRootCertificate"]
        self.intermediate = self.certs["DeveloperIDG2CA"]
        # Fix time to the public fixture acquisition date, never the wall clock.
        clock = patch.object(local, "datetime")
        clock.start().now.return_value = datetime(2026, 9, 5, tzinfo=timezone.utc)
        self.addCleanup(clock.stop)

    def leaf(self):
        cert = Mock()
        cert.not_valid_before_utc = datetime(2026, 1, 1, tzinfo=timezone.utc)
        cert.not_valid_after_utc = datetime(2027, 1, 1, tzinfo=timezone.utc)
        return cert

    def test_exact_public_root_accepts_both_real_developer_id_intermediates(self):
        self.assertEqual(self.root.fingerprint(local.hashes.SHA256()).hex(), local.APPLE_ROOT_SHA256)
        self.assertEqual(self.root.signature_algorithm_oid.dotted_string, "1.2.840.113549.1.1.5")
        for name in ("DeveloperIDCA", "DeveloperIDG2CA"):
            with self.subTest(intermediate=name):
                cert = self.leaf()
                local.verify_apple_chain(cert, self.certs[name], self.root)
                cert.verify_directly_issued_by.assert_called_once_with(self.certs[name])

    def test_changed_root_bytes_fail_pin_even_with_same_public_key(self):
        raw = bytearray(base64.b64decode(PUBLIC_APPLE_CA["AppleIncRootCertificate"]))
        raw[-1] ^= 1
        root = local.x509.load_der_x509_certificate(bytes(raw))
        self.assertEqual(api.public_bytes(root.public_key()), api.public_bytes(self.root.public_key()))
        cert = self.leaf()
        with self.assertRaisesRegex(api.Hold, "root fingerprint mismatch"):
            local.verify_apple_chain(cert, self.intermediate, root)
        cert.verify_directly_issued_by.assert_not_called()

    def test_corrupted_intermediate_signature_fails(self):
        raw = bytearray(base64.b64decode(PUBLIC_APPLE_CA["DeveloperIDG2CA"]))
        raw[-1] ^= 1
        intermediate = local.x509.load_der_x509_certificate(bytes(raw))
        cert = self.leaf()
        with self.assertRaises(InvalidSignature):
            local.verify_apple_chain(cert, intermediate, self.root)
        cert.verify_directly_issued_by.assert_not_called()

    def test_wrong_leaf_issuer_fails(self):
        with self.assertRaises(ValueError):
            local.verify_apple_chain(self.certs["DeveloperIDCA"], self.intermediate, self.root)

    def test_chain_validity_remains_required(self):
        for field, value in (("not_valid_before_utc", datetime(2026, 10, 1, tzinfo=timezone.utc)),
                             ("not_valid_after_utc", datetime(2026, 9, 5, tzinfo=timezone.utc))):
            cert = self.leaf()
            setattr(cert, field, value)
            with self.subTest(field=field), self.assertRaisesRegex(api.Hold, "validity period"):
                local.verify_apple_chain(cert, self.intermediate, self.root)
            cert.verify_directly_issued_by.assert_not_called()


class KeyPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name) / "public"
        self.store = Mock(values={})
        self.store.require.return_value = base64.b64encode(b"synthetic, not a private key").decode()
        self.private = base64.b64encode(b"untrusted comment: synthetic private fixture\nnot-a-key\n").decode()
        self.public = base64.b64encode(b"untrusted comment: synthetic public fixture\nnot-a-key\n").decode()
        self.cli = Path(self.temp.name) / "tauri"
        self.cli.touch()

    def test_updater_uses_pinned_stdout_layout_and_retains_only_in_store(self):
        # Official generate.rs, tauri-cli-v2.11.4, lines 42-50, no --write-keys.
        stdout = ("\nYour keys were generated successfully!\n\nPrivate: (Keep it secret!)\n"
                  + self.private + "\n\nPublic:\n" + self.public + "\n").encode()
        results = [SimpleNamespace(returncode=0, stdout=b"tauri-cli 2.11.4\n"),
                   SimpleNamespace(returncode=0, stdout=stdout)]
        with patch.object(local.subprocess, "run", side_effect=results) as command:
            result = local.updater_key(self.store, self.cli, self.out)
        self.assertEqual([c.args[0] for c in command.call_args_list],
                         [[str(self.cli), "--version"], [str(self.cli), "signer", "generate", "--ci"]])
        self.store.append.assert_called_once_with({"BUZZ_TAURI_SIGNING_PRIVATE_KEY": self.private,
                                                  local.PUBLIC_NAME: self.public})
        self.assertEqual(self.out.read_text(), self.public + "\n")
        self.assertNotIn(self.private, json.dumps(result))

    def test_updater_reuses_retained_pair_without_subprocess(self):
        self.store.values = {"BUZZ_TAURI_SIGNING_PRIVATE_KEY": self.private}
        self.store.require.return_value = self.public
        with patch.object(local.subprocess, "run") as command:
            local.updater_key(self.store, None, self.out)
        command.assert_not_called()
        self.store.append.assert_not_called()
        self.assertEqual(self.out.read_text(), self.public + "\n")

    def test_updater_rejects_wrong_version_or_output_without_retention(self):
        for results in ([SimpleNamespace(returncode=0, stdout=b"tauri-cli 2.11.3\n")],
                        [SimpleNamespace(returncode=0, stdout=b"tauri-cli 2.11.4\n"),
                         SimpleNamespace(returncode=0, stdout=b"Private: /path (Keep it secret!)\nPublic: /path.pub\n")]):
            with self.subTest(results=len(results)), patch.object(local.subprocess, "run", side_effect=results):
                with self.assertRaises(api.Hold):
                    local.updater_key(self.store, self.cli, self.out)
            self.store.append.assert_not_called()
            self.assertFalse(self.out.exists())

    def test_developer_key_recovers_same_csr_without_rotation(self):
        name = "BUZZ_DEVELOPER_ID_PRIVATE_KEY_PEM_B64"
        self.store.values = {name: self.store.require.return_value}
        with patch.object(local.rsa, "generate_private_key") as generate, \
             patch.object(local.serialization, "load_pem_private_key") as load, \
             patch.object(local.x509, "CertificateSigningRequestBuilder") as builder:
            builder.return_value.subject_name.return_value.sign.return_value.public_bytes.return_value = b"public CSR fixture"
            local.developer_id_key(self.store, self.out)
        generate.assert_not_called()
        self.store.append.assert_not_called()
        self.assertEqual(builder.return_value.subject_name.return_value.sign.call_args.args[0], load.return_value)
        self.assertEqual(self.out.read_bytes(), b"public CSR fixture")

    def test_developer_new_key_is_retained_before_public_csr(self):
        with patch.object(local.rsa, "generate_private_key") as generate, \
             patch.object(local.x509, "CertificateSigningRequestBuilder") as builder:
            generate.return_value.private_bytes.return_value = b"synthetic private fixture"
            builder.return_value.subject_name.return_value.sign.return_value.public_bytes.return_value = b"public CSR fixture"
            local.developer_id_key(self.store, self.out)
        generate.assert_called_once_with(public_exponent=65537, key_size=2048)
        self.store.append.assert_called_once_with({"BUZZ_DEVELOPER_ID_PRIVATE_KEY_PEM_B64":
                                                  base64.b64encode(b"synthetic private fixture").decode()})
        self.assertEqual(self.out.read_bytes(), b"public CSR fixture")

    def test_assembly_identity_oid_and_round_trip_gates(self):
        for fault in (None, "key", "team", "oid", "round_trip", "chain"):
            with self.subTest(fault=fault):
                self.store.reset_mock()
                key, cert, intermediate, root = (Mock() for _ in range(4))
                key.public_key.return_value = b"retained public key"
                cert.public_key.return_value = b"wrong key" if fault == "key" else b"retained public key"
                cert.subject.get_attributes_for_oid.return_value = [SimpleNamespace(value="WRONG" if fault == "team" else api.TEAM)]
                if fault == "oid":
                    cert.extensions.get_extension_for_oid.side_effect = local.x509.ExtensionNotFound("missing", local.ObjectIdentifier("1.2.840.113635.100.6.1.13"))
                with patch.object(local, "load_cert", side_effect=[cert, intermediate, root]), \
                     patch.object(local, "verify_apple_chain", side_effect=api.Hold("bad chain") if fault == "chain" else None) as verify, \
                     patch.object(local.serialization, "load_pem_private_key", return_value=key), \
                     patch.object(local, "public_bytes", side_effect=lambda value: value), \
                     patch.object(local.secrets, "token_urlsafe", return_value="synthetic password"), \
                     patch.object(local.pkcs12, "serialize_key_and_certificates", return_value=b"synthetic p12") as serialize, \
                     patch.object(local.pkcs12, "load_key_and_certificates", return_value=(key, cert, [] if fault == "round_trip" else [intermediate])):
                    if fault is None:
                        local.assemble_p12(self.store, "cert", "intermediate", "root")
                        verify.assert_called_once_with(cert, intermediate, root)
                        cert.extensions.get_extension_for_oid.assert_called_once_with(local.ObjectIdentifier("1.2.840.113635.100.6.1.13"))
                        self.assertEqual(serialize.call_args.args[1:4], (key, cert, [intermediate]))
                        self.store.append.assert_called_once_with({local.SECRET_NAMES[0]: base64.b64encode(b"synthetic p12").decode(),
                                                                  local.SECRET_NAMES[1]: "synthetic password"})
                    else:
                        with self.assertRaises((api.Hold, local.x509.ExtensionNotFound)):
                            local.assemble_p12(self.store, "cert", "intermediate", "root")
                        self.store.append.assert_not_called()
                        if fault != "round_trip":
                            serialize.assert_not_called()


if __name__ == "__main__":
    unittest.main()
