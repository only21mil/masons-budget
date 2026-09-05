#!/usr/bin/env python3
"""Tests for apple_signing_assets.py against a fake App Store Connect transport.

No network, no JWT, no key material. The fake records every call so the tests
can assert the exact payloads Apple would receive.
"""

from __future__ import annotations

import base64
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from argparse import Namespace
from contextlib import redirect_stdout
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


SCRIPT = Path(__file__).resolve().parents[1] / "apple_signing_assets.py"
SPEC = importlib.util.spec_from_file_location("apple_signing_assets", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

TOKEN = "fake-token"
BUNDLE = "com.sats21m.masonsbudget"
DIST_CSR_PEM = (
    "-----BEGIN CERTIFICATE REQUEST-----\n"
    "QUJDREVG\nR0hJSktM\n"
    "-----END CERTIFICATE REQUEST-----\n"
)
INSTALLER_CSR_PEM = (
    "-----BEGIN CERTIFICATE REQUEST-----\n"
    "TU5PUFFS\n"
    "-----END CERTIFICATE REQUEST-----\n"
)
CAP_ERROR = {
    "errors": [
        {
            "status": "400",
            "title": "There is a problem with the request entity",
            "detail": "You already have a current Distribution certificate or a pending certificate request. Maximum number reached.",
        }
    ]
}


def cert_row(cert_id, cert_type, expires, name=None, content=b"DER"):
    return {
        "type": "certificates",
        "id": cert_id,
        "attributes": {
            "certificateType": cert_type,
            "name": name or f"{cert_type} {cert_id}",
            "expirationDate": expires,
            "certificateContent": base64.b64encode(content).decode("ascii"),
        },
    }


def profile_row(profile_id, profile_type, name, content=b"PROFILE"):
    return {
        "type": "profiles",
        "id": profile_id,
        "attributes": {
            "profileType": profile_type,
            "name": name,
            "expirationDate": "2027-09-05T00:00:00.000+00:00",
            "profileContent": base64.b64encode(content).decode("ascii"),
        },
    }


class FakeApi:
    """Enough of /certificates, /bundleIds, and /profiles to drive `mint`."""

    def __init__(self, certificates=(), bundle_ids=(), profiles=(), cap_types=()):
        self.certificates = list(certificates)
        self.bundle_ids = list(bundle_ids)
        self.profiles = list(profiles)
        # Certificate types that refuse a POST until one has been deleted.
        self.cap_types = set(cap_types)
        self.calls = []
        self.counter = 0

    def __call__(self, method, path, token, body=None):
        assert token == TOKEN
        self.calls.append((method, path, body))
        parts = urlsplit(path)
        query = {k: v[0] for k, v in parse_qs(parts.query).items()}
        route = (method, parts.path)
        if route == ("GET", "/certificates"):
            kind = query.get("filter[certificateType]")
            rows = [c for c in self.certificates if c["attributes"]["certificateType"] == kind]
            return 200, {"data": rows, "links": {}}
        if route == ("POST", "/certificates"):
            attrs = body["data"]["attributes"]
            kind = attrs["certificateType"]
            if kind in self.cap_types:
                return 400, CAP_ERROR
            self.counter += 1
            row = cert_row(
                f"NEW{self.counter}", kind, "2027-09-05T00:00:00.000+00:00",
                content=f"DER-{kind}-{attrs['csrContent']}".encode(),
            )
            self.certificates.append(row)
            return 201, {"data": row}
        if method == "DELETE" and parts.path.startswith("/certificates/"):
            cert_id = parts.path.rsplit("/", 1)[1]
            before = len(self.certificates)
            self.certificates = [c for c in self.certificates if c["id"] != cert_id]
            if len(self.certificates) == before:
                return 404, {"errors": [{"title": "Not found", "detail": cert_id}]}
            kind = next(iter(self.cap_types), None)
            if kind:
                self.cap_types.discard(kind)
            return 204, {}
        if route == ("GET", "/bundleIds"):
            wanted = query.get("filter[identifier]")
            rows = [b for b in self.bundle_ids if b["attributes"]["identifier"].startswith(wanted)]
            return 200, {"data": rows}
        if route == ("GET", "/profiles"):
            wanted = query.get("filter[name]")
            rows = [p for p in self.profiles if p["attributes"]["name"] == wanted]
            return 200, {"data": rows}
        if route == ("POST", "/profiles"):
            attrs = body["data"]["attributes"]
            self.counter += 1
            row = profile_row(
                f"PROF{self.counter}", attrs["profileType"], attrs["name"],
                content=f"PROFILE-{attrs['profileType']}".encode(),
            )
            self.profiles.append(row)
            return 201, {"data": row}
        if method == "DELETE" and parts.path.startswith("/profiles/"):
            profile_id = parts.path.rsplit("/", 1)[1]
            self.profiles = [p for p in self.profiles if p["id"] != profile_id]
            return 204, {}
        raise AssertionError(f"unexpected call {method} {path}")

    def posts(self, path):
        return [body for method, p, body in self.calls if method == "POST" and p == path]

    def deletes(self, prefix):
        return [p for method, p, _ in self.calls if method == "DELETE" and p.startswith(prefix)]


def bundle_row(identifier, bundle_id="BID1"):
    return {"type": "bundleIds", "id": bundle_id, "attributes": {"identifier": identifier}}


def run_mint(api, tmp, label="manual", revoke=False, bundle=BUNDLE):
    dist = Path(tmp) / "dist.csr"
    installer = Path(tmp) / "installer.csr"
    dist.write_text(DIST_CSR_PEM, encoding="utf-8")
    installer.write_text(INSTALLER_CSR_PEM, encoding="utf-8")
    args = Namespace(
        dist_csr=str(dist),
        installer_csr=str(installer),
        bundle_id=bundle,
        label=label,
        revoke_oldest_if_capped=revoke,
        out=str(Path(tmp) / "out"),
    )
    out = io.StringIO()
    with redirect_stdout(out):
        manifest = MODULE.mint(args, api, TOKEN)
    return manifest, out.getvalue()


class PemStrippingTests(unittest.TestCase):
    def test_strips_header_footer_and_newlines(self) -> None:
        self.assertEqual(MODULE.strip_pem(DIST_CSR_PEM), "QUJDREVGR0hJSktM")

    def test_tolerates_crlf_and_surrounding_text(self) -> None:
        text = "note\r\n-----BEGIN CERTIFICATE REQUEST-----\r\nQUJD\r\n-----END CERTIFICATE REQUEST-----\r\n"
        self.assertEqual(MODULE.strip_pem(text), "QUJD")

    def test_refuses_private_key(self) -> None:
        text = DIST_CSR_PEM + "-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n"
        with self.assertRaisesRegex(MODULE.MintError, "private key"):
            MODULE.strip_pem(text)

    def test_refuses_non_csr(self) -> None:
        with self.assertRaisesRegex(MODULE.MintError, "not a PEM certificate request"):
            MODULE.strip_pem("-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n")

    def test_refuses_invalid_base64_body(self) -> None:
        with self.assertRaisesRegex(MODULE.MintError, "not valid base64"):
            MODULE.strip_pem("-----BEGIN CERTIFICATE REQUEST-----\n@@@@\n-----END CERTIFICATE REQUEST-----\n")


class CapDetectionTests(unittest.TestCase):
    def test_409_is_a_cap(self) -> None:
        self.assertTrue(MODULE.cap_reached(409, {"errors": []}))

    def test_maximum_or_limit_in_detail_is_a_cap(self) -> None:
        self.assertTrue(MODULE.cap_reached(400, CAP_ERROR))
        limit = {"errors": [{"title": "x", "detail": "certificate limit exceeded"}]}
        self.assertTrue(MODULE.cap_reached(400, limit))

    def test_raw_json_error_body_is_inspected(self) -> None:
        # apple_certificates.request returns {"raw": body} on HTTPError.
        self.assertTrue(MODULE.cap_reached(400, {"raw": json.dumps(CAP_ERROR)}))

    def test_other_errors_are_not_a_cap(self) -> None:
        other = {"errors": [{"title": "Forbidden", "detail": "key lacks the role"}]}
        self.assertFalse(MODULE.cap_reached(403, other))


class CertificateCapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.old = cert_row("OLD", "DISTRIBUTION", "2026-10-01T00:00:00.000+00:00", name="oldest")
        self.newer = cert_row("NEWER", "DISTRIBUTION", "2027-03-01T00:00:00.000+00:00", name="newer")
        self.other_type = cert_row("INST", "MAC_INSTALLER_DISTRIBUTION", "2026-01-01T00:00:00.000+00:00")

    def test_capped_without_flag_fails_with_detail(self) -> None:
        api = FakeApi(certificates=[self.old, self.newer], cap_types={"DISTRIBUTION"})
        with self.assertRaisesRegex(MODULE.MintError, "Maximum number reached"):
            MODULE.create_certificate(api, TOKEN, "DISTRIBUTION", "QUJD", revoke_oldest=False)
        self.assertEqual(api.deletes("/certificates/"), [])
        self.assertEqual(len(api.posts("/certificates")), 1)

    def test_capped_with_flag_revokes_oldest_of_that_type_and_retries_once(self) -> None:
        api = FakeApi(
            certificates=[self.newer, self.other_type, self.old],
            cap_types={"DISTRIBUTION"},
        )
        out = io.StringIO()
        with redirect_stdout(out):
            row, victim = MODULE.create_certificate(
                api, TOKEN, "DISTRIBUTION", "QUJD", revoke_oldest=True
            )
        self.assertEqual(victim["id"], "OLD")
        self.assertEqual(api.deletes("/certificates/"), ["/certificates/OLD"])
        self.assertEqual(len(api.posts("/certificates")), 2)
        self.assertEqual(row["attributes"]["certificateType"], "DISTRIBUTION")
        self.assertIn("revoked OLD (DISTRIBUTION) oldest", out.getvalue())
        # The other type's older certificate was never a candidate.
        self.assertTrue(any(c["id"] == "INST" for c in api.certificates))

    def test_certificate_payload_shape(self) -> None:
        self.assertEqual(
            MODULE.certificate_payload("MAC_INSTALLER_DISTRIBUTION", "QUJD"),
            {
                "data": {
                    "type": "certificates",
                    "attributes": {
                        "certificateType": "MAC_INSTALLER_DISTRIBUTION",
                        "csrContent": "QUJD",
                    },
                }
            },
        )

    def test_non_cap_error_is_not_retried_even_with_flag(self) -> None:
        def forbidden(method, path, token, body=None):
            return 403, {"errors": [{"title": "Forbidden", "detail": "key lacks the role"}]}

        with self.assertRaisesRegex(MODULE.MintError, "key lacks the role"):
            MODULE.create_certificate(forbidden, TOKEN, "DISTRIBUTION", "QUJD", revoke_oldest=True)

    def test_oldest_by_expiry(self) -> None:
        self.assertEqual(MODULE.oldest_certificate([self.newer, self.old])["id"], "OLD")
        with self.assertRaises(MODULE.MintError):
            MODULE.oldest_certificate([])


class BundleLookupTests(unittest.TestCase):
    def test_exactly_one_match_is_required(self) -> None:
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE)])
        self.assertEqual(MODULE.find_bundle_id(api, TOKEN, BUNDLE)["id"], "BID1")

    def test_zero_matches_fail(self) -> None:
        api = FakeApi(bundle_ids=[bundle_row("com.example.other")])
        with self.assertRaisesRegex(MODULE.MintError, "found 0"):
            MODULE.find_bundle_id(api, TOKEN, BUNDLE)

    def test_prefix_matches_from_apple_are_ignored(self) -> None:
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE), bundle_row(BUNDLE + ".watch", "BID2")])
        self.assertEqual(MODULE.find_bundle_id(api, TOKEN, BUNDLE)["id"], "BID1")

    def test_duplicate_exact_matches_fail(self) -> None:
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE), bundle_row(BUNDLE, "BID2")])
        with self.assertRaisesRegex(MODULE.MintError, "found 2"):
            MODULE.find_bundle_id(api, TOKEN, BUNDLE)


class ProfileTests(unittest.TestCase):
    def test_profile_payloads_for_both_platforms(self) -> None:
        for profile_type, platform_word in (("IOS_APP_STORE", "iOS"), ("MAC_APP_STORE", "macOS")):
            name = MODULE.profile_name(platform_word, "manual")
            self.assertEqual(name, f"Vogel Vault {platform_word} App Store manual")
            self.assertEqual(
                MODULE.profile_payload(profile_type, name, "BID1", "NEW1"),
                {
                    "data": {
                        "type": "profiles",
                        "attributes": {"name": name, "profileType": profile_type},
                        "relationships": {
                            "bundleId": {"data": {"type": "bundleIds", "id": "BID1"}},
                            "certificates": {"data": [{"type": "certificates", "id": "NEW1"}]},
                        },
                    }
                },
            )

    def test_existing_profile_of_same_name_is_deleted_then_recreated(self) -> None:
        name = MODULE.profile_name("iOS", "manual")
        api = FakeApi(profiles=[profile_row("STALE", "IOS_APP_STORE", name)])
        out = io.StringIO()
        with redirect_stdout(out):
            row, replaced = MODULE.create_profile(api, TOKEN, "IOS_APP_STORE", name, "BID1", "NEW1")
        self.assertEqual(replaced, ["STALE"])
        self.assertEqual(api.deletes("/profiles/"), ["/profiles/STALE"])
        self.assertEqual(row["attributes"]["name"], name)
        self.assertNotEqual(row["id"], "STALE")
        self.assertIn("replaced profile STALE", out.getvalue())

    def test_profile_without_existing_name_is_not_deleted(self) -> None:
        api = FakeApi()
        _, replaced = MODULE.create_profile(api, TOKEN, "MAC_APP_STORE", "fresh", "BID1", "NEW1")
        self.assertEqual(replaced, [])
        self.assertEqual(api.deletes("/profiles/"), [])


class MintEndToEndTests(unittest.TestCase):
    def test_writes_certificates_profiles_and_manifest(self) -> None:
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            manifest, out = run_mint(api, tmp, label="tf-2026-09")
            out_dir = Path(tmp) / "out"
            self.assertEqual(
                sorted(p.name for p in out_dir.iterdir()),
                [
                    "apple-distribution.cer",
                    "ios-app-store.mobileprovision",
                    "mac-app-store.provisionprofile",
                    "mac-installer-distribution.cer",
                    "manifest.json",
                ],
            )
            self.assertEqual(
                (out_dir / "apple-distribution.cer").read_bytes(),
                b"DER-DISTRIBUTION-QUJDREVGR0hJSktM",
            )
            self.assertEqual(
                (out_dir / "mac-installer-distribution.cer").read_bytes(),
                b"DER-MAC_INSTALLER_DISTRIBUTION-TU5PUFFS",
            )
            self.assertEqual(
                (out_dir / "ios-app-store.mobileprovision").read_bytes(), b"PROFILE-IOS_APP_STORE"
            )
            self.assertEqual(
                (out_dir / "mac-app-store.provisionprofile").read_bytes(), b"PROFILE-MAC_APP_STORE"
            )
            written = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(written, manifest)
            for name in out_dir.iterdir():
                self.assertNotIn(b"PRIVATE KEY", name.read_bytes())

        self.assertEqual(manifest["bundle_id"], BUNDLE)
        self.assertEqual(manifest["bundle_id_resource"], "BID1")
        self.assertEqual(
            sorted(manifest["certificates"]), ["DISTRIBUTION", "MAC_INSTALLER_DISTRIBUTION"]
        )
        self.assertEqual(sorted(manifest["profiles"]), ["IOS_APP_STORE", "MAC_APP_STORE"])
        for row in list(manifest["certificates"].values()) + list(manifest["profiles"].values()):
            for key in ("id", "name", "type", "expires", "file"):
                self.assertIn(key, row)
        self.assertEqual(manifest["revoked_certificates"], [])
        self.assertEqual(manifest["replaced_profiles"], [])

        # Both profiles are bound to the new distribution certificate, not the installer one.
        dist_id = manifest["certificates"]["DISTRIBUTION"]["id"]
        for body in api.posts("/profiles"):
            self.assertEqual(
                body["data"]["relationships"]["certificates"]["data"],
                [{"type": "certificates", "id": dist_id}],
            )
            self.assertEqual(body["data"]["relationships"]["bundleId"]["data"]["id"], "BID1")
        names = sorted(b["data"]["attributes"]["name"] for b in api.posts("/profiles"))
        self.assertEqual(
            names,
            ["Vogel Vault iOS App Store tf-2026-09", "Vogel Vault macOS App Store tf-2026-09"],
        )
        self.assertIn("created", out)
        self.assertIn("bundle id: com.sats21m.masonsbudget (BID1)", out)

    def test_cap_path_records_revocation_in_manifest(self) -> None:
        old = cert_row("OLD", "DISTRIBUTION", "2026-10-01T00:00:00.000+00:00", name="oldest")
        api = FakeApi(certificates=[old], bundle_ids=[bundle_row(BUNDLE)], cap_types={"DISTRIBUTION"})
        with tempfile.TemporaryDirectory() as tmp:
            manifest, out = run_mint(api, tmp, revoke=True)
        self.assertEqual([r["id"] for r in manifest["revoked_certificates"]], ["OLD"])
        self.assertIn("revoked   DISTRIBUTION", out)

    def test_bad_label_is_rejected_before_any_call(self) -> None:
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(MODULE.MintError, "--label"):
                run_mint(api, tmp, label="bad/label")
        self.assertEqual(api.calls, [])


if __name__ == "__main__":
    unittest.main()
