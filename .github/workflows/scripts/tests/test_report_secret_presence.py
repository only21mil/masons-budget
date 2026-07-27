#!/usr/bin/env python3

from __future__ import annotations

import base64
import contextlib
import importlib.util
import io
import os
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "report_secret_presence.py"
SPEC = importlib.util.spec_from_file_location("report_secret_presence", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

DER = b"synthetic-der-for-envelope-only-test"
RAW_PEM = (
    "-----BEGIN PRIVATE KEY-----\n"
    + base64.b64encode(DER).decode("ascii")
    + "\n-----END PRIVATE KEY-----\n"
)


class PrivateKeyPresenceTests(unittest.TestCase):
    def test_accepts_raw_or_base64_wrapped_private_key_pem(self) -> None:
        self.assertTrue(MODULE.private_key_pem_well_formed(RAW_PEM)[0])
        wrapped = base64.b64encode(RAW_PEM.encode("ascii")).decode("ascii")
        self.assertTrue(MODULE.private_key_pem_well_formed(wrapped)[0])

    def test_rejects_non_pem_or_malformed_pem(self) -> None:
        self.assertFalse(MODULE.private_key_pem_well_formed("not-base64")[0])
        malformed = "-----BEGIN PRIVATE KEY-----\n%%%\n-----END PRIVATE KEY-----"
        self.assertFalse(MODULE.private_key_pem_well_formed(malformed)[0])

    def test_report_never_prints_secret_values(self) -> None:
        secret_marker = "DO_NOT_PRINT_THIS_KEY_ID"
        environment = {
            "ASC_API_KEY_P8": RAW_PEM,
            "ASC_KEY_ID": secret_marker,
            "ASC_ISSUER_ID": "12345678-1234-1234-1234-123456789abc",
        }
        output = io.StringIO()
        with patch.dict(os.environ, environment, clear=True), contextlib.redirect_stdout(output):
            self.assertEqual(MODULE.main(), 0)
        rendered = output.getvalue()
        self.assertNotIn(secret_marker, rendered)
        self.assertNotIn(base64.b64encode(DER).decode("ascii"), rendered)
        self.assertIn("ASC_API_KEY_P8", rendered)
        self.assertIn("PRESENT", rendered)


if __name__ == "__main__":
    unittest.main()
