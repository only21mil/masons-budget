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
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from argparse import Namespace
from contextlib import redirect_stdout
from datetime import datetime, timezone
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


FUTURE = "2027-09-05T00:00:00.000+00:00"
PAST = "2025-01-01T00:00:00.000+00:00"
SERVER_ERROR = {
    "errors": [
        {
            "status": "500",
            "code": "UNEXPECTED_ERROR",
            "title": "An unexpected error occurred.",
            "detail": "An unexpected error occurred on the server side. If this issue continues, contact us at https://developer.apple.com/contact/.",
        }
    ]
}


def cert_row(cert_id, cert_type, expires, name=None, content=b"DER", display_name=None):
    attrs = {
        "certificateType": cert_type,
        "name": name or f"{cert_type} {cert_id}",
        "expirationDate": expires,
        "certificateContent": base64.b64encode(content).decode("ascii"),
    }
    if display_name is not None:
        attrs["displayName"] = display_name
    return {"type": "certificates", "id": cert_id, "attributes": attrs}


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

    def __init__(self, certificates=(), bundle_ids=(), profiles=(), cap_types=(),
                 profile_failures=None):
        self.certificates = list(certificates)
        self.bundle_ids = list(bundle_ids)
        self.profiles = list(profiles)
        # Certificate types that refuse a POST until one has been deleted.
        self.cap_types = set(cap_types)
        # profileType -> list of (status, payload) to return before succeeding.
        self.profile_failures = {k: list(v) for k, v in (profile_failures or {}).items()}
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
        if method == "GET" and parts.path.startswith("/certificates/"):
            cert_id = parts.path.rsplit("/", 1)[1]
            for row in self.certificates:
                if row["id"] == cert_id:
                    return 200, {"data": row}
            return 404, {"errors": [{"title": "Not found", "detail": cert_id}]}
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
            pending = self.profile_failures.get(attrs["profileType"])
            if pending:
                return pending.pop(0)
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


def run_mint(api, tmp, label="manual", revoke=False, bundle=BUNDLE, platforms="both",
             reuse_dist=None, reuse_installer=None, dist_cn=None, installer_cn=None,
             write_dist_csr=True, write_installer_csr=True):
    dist = Path(tmp) / "dist.csr"
    installer = Path(tmp) / "installer.csr"
    if write_dist_csr:
        dist.write_text(DIST_CSR_PEM, encoding="utf-8")
    if write_installer_csr:
        installer.write_text(INSTALLER_CSR_PEM, encoding="utf-8")
    args = Namespace(
        dist_csr=str(dist) if write_dist_csr else None,
        installer_csr=str(installer) if write_installer_csr else None,
        platforms=platforms,
        reuse_distribution_certificate_id=reuse_dist,
        reuse_installer_certificate_id=reuse_installer,
        dist_cn=dist_cn,
        installer_cn=installer_cn,
        bundle_id=bundle,
        label=label,
        revoke_oldest_if_capped=revoke,
        out=str(Path(tmp) / "out"),
    )
    out = io.StringIO()
    with redirect_stdout(out):
        manifest = MODULE.mint(args, api, TOKEN)
    return manifest, out.getvalue()


def read_manifest(tmp):
    return json.loads((Path(tmp) / "out" / "manifest.json").read_text(encoding="utf-8"))


def listdir(tmp):
    return sorted(p.name for p in (Path(tmp) / "out").iterdir())


class FakeSleep:
    def __init__(self):
        self.waits = []

    def __call__(self, seconds):
        self.waits.append(seconds)


def frozen_now():
    return datetime(2026, 9, 5, tzinfo=timezone.utc)


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
            self.assertEqual(row["status"], "created")
        self.assertEqual(manifest["status"], "ok")
        self.assertIsNone(manifest["error"])
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


class PlatformFilterTests(unittest.TestCase):
    def test_ios_only_mints_distribution_and_ios_profile(self) -> None:
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            manifest, _ = run_mint(api, tmp, platforms="ios", write_installer_csr=False)
            self.assertEqual(
                listdir(tmp),
                ["apple-distribution.cer", "ios-app-store.mobileprovision", "manifest.json"],
            )
        self.assertEqual(list(manifest["certificates"]), ["DISTRIBUTION"])
        self.assertEqual(list(manifest["profiles"]), ["IOS_APP_STORE"])
        posted = [b["data"]["attributes"]["certificateType"] for b in api.posts("/certificates")]
        self.assertEqual(posted, ["DISTRIBUTION"])
        self.assertEqual(
            [b["data"]["attributes"]["profileType"] for b in api.posts("/profiles")],
            ["IOS_APP_STORE"],
        )

    def test_macos_only_mints_both_certificates_and_mac_profile(self) -> None:
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            manifest, _ = run_mint(api, tmp, platforms="macos")
            self.assertEqual(
                listdir(tmp),
                [
                    "apple-distribution.cer",
                    "mac-app-store.provisionprofile",
                    "mac-installer-distribution.cer",
                    "manifest.json",
                ],
            )
        self.assertEqual(
            sorted(manifest["certificates"]), ["DISTRIBUTION", "MAC_INSTALLER_DISTRIBUTION"]
        )
        self.assertEqual(list(manifest["profiles"]), ["MAC_APP_STORE"])

    def test_both_is_the_default_when_platforms_is_absent(self) -> None:
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            manifest, _ = run_mint(api, tmp, platforms=None)
        self.assertEqual(sorted(manifest["profiles"]), ["IOS_APP_STORE", "MAC_APP_STORE"])

    def test_missing_installer_csr_fails_before_any_call_when_macos_needs_it(self) -> None:
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(MODULE.MintError, "--installer-csr is required"):
                run_mint(api, tmp, platforms="both", write_installer_csr=False)
        self.assertEqual(api.calls, [])

    def test_parser_accepts_platforms_and_reuse_flags(self) -> None:
        args = MODULE.build_parser().parse_args(
            [
                "mint", "--platforms", "ios", "--reuse-distribution-certificate-id", "ABC",
                "--bundle-id", BUNDLE, "--label", "x", "--out", "o",
            ]
        )
        self.assertEqual(args.platforms, "ios")
        self.assertEqual(args.reuse_distribution_certificate_id, "ABC")
        self.assertIsNone(args.dist_csr)
        self.assertIsNone(args.installer_csr)
        self.assertIsNone(args.reuse_installer_certificate_id)
        self.assertIsNone(args.dist_cn)
        self.assertIsNone(args.installer_cn)
        with self.assertRaises(SystemExit), unittest.mock.patch("sys.stderr", io.StringIO()):
            MODULE.build_parser().parse_args(
                ["mint", "--platforms", "tvos", "--bundle-id", BUNDLE, "--label", "x", "--out", "o"]
            )


class ReuseByIdTests(unittest.TestCase):
    def setUp(self) -> None:
        self.old_now = MODULE.now
        MODULE.now = frozen_now
        self.dist = cert_row("D1", "DISTRIBUTION", FUTURE, content=b"DER-D1")
        self.installer = cert_row("I1", "MAC_INSTALLER_DISTRIBUTION", FUTURE, content=b"DER-I1")

    def tearDown(self) -> None:
        MODULE.now = self.old_now

    def test_reuse_by_id_skips_minting_and_needs_no_csr(self) -> None:
        api = FakeApi(certificates=[self.dist, self.installer], bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            manifest, out = run_mint(
                api, tmp, reuse_dist="D1", reuse_installer="I1",
                write_dist_csr=False, write_installer_csr=False,
            )
            self.assertEqual((Path(tmp) / "out" / "apple-distribution.cer").read_bytes(), b"DER-D1")
            self.assertEqual(
                (Path(tmp) / "out" / "mac-installer-distribution.cer").read_bytes(), b"DER-I1"
            )
        self.assertEqual(api.posts("/certificates"), [])
        self.assertEqual(manifest["certificates"]["DISTRIBUTION"]["status"], "reused")
        self.assertEqual(manifest["certificates"]["MAC_INSTALLER_DISTRIBUTION"]["status"], "reused")
        self.assertIn("reused D1 (DISTRIBUTION)", out)
        for body in api.posts("/profiles"):
            self.assertEqual(
                body["data"]["relationships"]["certificates"]["data"],
                [{"type": "certificates", "id": "D1"}],
            )
        self.assertIn(("GET", "/certificates/D1", None), api.calls)

    def test_reuse_by_id_rejects_type_mismatch(self) -> None:
        api = FakeApi(certificates=[self.dist, self.installer], bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(
                MODULE.MintError, "I1 is MAC_INSTALLER_DISTRIBUTION, not DISTRIBUTION"
            ):
                run_mint(api, tmp, reuse_dist="I1", write_dist_csr=False)
        self.assertEqual(api.posts("/certificates"), [])
        self.assertEqual(api.posts("/profiles"), [])

    def test_reuse_by_id_rejects_expired(self) -> None:
        expired = cert_row("D0", "DISTRIBUTION", PAST)
        api = FakeApi(certificates=[expired], bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(MODULE.MintError, "D0 expired on 2025-01-01"):
                run_mint(api, tmp, reuse_dist="D0", write_dist_csr=False)
        self.assertEqual(api.posts("/certificates"), [])

    def test_reuse_by_id_unknown_id_reports_apple_status(self) -> None:
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(MODULE.MintError, "GET /certificates/NOPE failed with HTTP 404"):
                run_mint(api, tmp, reuse_dist="NOPE", write_dist_csr=False)

    def test_reuse_by_id_requires_content(self) -> None:
        bare = cert_row("D2", "DISTRIBUTION", FUTURE)
        del bare["attributes"]["certificateContent"]
        api = FakeApi(certificates=[bare])
        with self.assertRaisesRegex(MODULE.MintError, "no certificateContent"):
            MODULE.fetch_certificate(api, TOKEN, "D2", "DISTRIBUTION")


class ReuseByNameTests(unittest.TestCase):
    def setUp(self) -> None:
        self.old_now = MODULE.now
        MODULE.now = frozen_now

    def tearDown(self) -> None:
        MODULE.now = self.old_now

    def test_live_certificate_with_matching_display_name_is_reused(self) -> None:
        match = cert_row(
            "D1", "DISTRIBUTION", FUTURE, name="Victor Vogel",
            display_name="Vogel Vault Dist", content=b"DER-D1",
        )
        other = cert_row("D2", "DISTRIBUTION", FUTURE, name="someone else")
        api = FakeApi(certificates=[other, match], bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            manifest, out = run_mint(api, tmp, platforms="ios", dist_cn="Vogel Vault Dist")
            self.assertEqual((Path(tmp) / "out" / "apple-distribution.cer").read_bytes(), b"DER-D1")
        self.assertEqual(api.posts("/certificates"), [])
        self.assertEqual(manifest["certificates"]["DISTRIBUTION"]["id"], "D1")
        self.assertEqual(manifest["certificates"]["DISTRIBUTION"]["status"], "reused")
        self.assertIn("name matches CSR CN 'Vogel Vault Dist'", out)

    def test_matching_name_attribute_counts_too(self) -> None:
        match = cert_row("I1", "MAC_INSTALLER_DISTRIBUTION", FUTURE, name="Vogel Vault Installer")
        api = FakeApi(certificates=[match], bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            manifest, _ = run_mint(api, tmp, installer_cn="Vogel Vault Installer")
        posted = [b["data"]["attributes"]["certificateType"] for b in api.posts("/certificates")]
        self.assertEqual(posted, ["DISTRIBUTION"])
        self.assertEqual(manifest["certificates"]["MAC_INSTALLER_DISTRIBUTION"]["id"], "I1")

    def test_expired_match_is_ignored_and_a_new_one_is_minted(self) -> None:
        stale = cert_row("D0", "DISTRIBUTION", PAST, name="Vogel Vault Dist")
        api = FakeApi(certificates=[stale], bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            manifest, _ = run_mint(api, tmp, platforms="ios", dist_cn="Vogel Vault Dist")
        self.assertEqual(len(api.posts("/certificates")), 1)
        self.assertEqual(manifest["certificates"]["DISTRIBUTION"]["status"], "created")

    def test_match_of_other_type_is_not_reused(self) -> None:
        wrong_type = cert_row("I9", "MAC_INSTALLER_DISTRIBUTION", FUTURE, name="Vogel Vault Dist")
        api = FakeApi(certificates=[wrong_type], bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            manifest, _ = run_mint(api, tmp, platforms="ios", dist_cn="Vogel Vault Dist")
        self.assertEqual(manifest["certificates"]["DISTRIBUTION"]["status"], "created")
        self.assertNotEqual(manifest["certificates"]["DISTRIBUTION"]["id"], "I9")

    def test_latest_expiring_match_wins(self) -> None:
        a = cert_row("A", "DISTRIBUTION", "2026-12-01T00:00:00.000+00:00", name="n")
        b = cert_row("B", "DISTRIBUTION", FUTURE, name="n")
        api = FakeApi(certificates=[a, b])
        self.assertEqual(MODULE.find_certificate_named(api, TOKEN, "DISTRIBUTION", "n")["id"], "B")
        self.assertIsNone(MODULE.find_certificate_named(api, TOKEN, "DISTRIBUTION", None))

    def test_unreadable_cn_warns_and_mints(self) -> None:
        # The fixture CSRs are not real DER, so the CN cannot be parsed.
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE)])
        with tempfile.TemporaryDirectory() as tmp:
            manifest, out = run_mint(api, tmp, platforms="ios")
        self.assertIn("could not read a subject CN", out)
        self.assertEqual(manifest["certificates"]["DISTRIBUTION"]["status"], "created")

    @unittest.skipUnless(shutil.which("openssl"), "openssl not installed")
    def test_common_name_is_read_from_a_real_csr(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            csr = Path(tmp) / "real.csr"
            subprocess.run(
                [
                    "openssl", "req", "-new", "-newkey", "ec",
                    "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                    "-subj", "/CN=Vogel Vault Dist, 2026/O=Sats",
                    "-keyout", str(Path(tmp) / "key.pem"), "-out", str(csr),
                ],
                check=True, capture_output=True,
            )
            self.assertEqual(MODULE.csr_common_name(csr), "Vogel Vault Dist, 2026")
            bogus = Path(tmp) / "bogus.csr"
            bogus.write_text(DIST_CSR_PEM, encoding="utf-8")
            self.assertIsNone(MODULE.csr_common_name(bogus))


class ProfileRetryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.old_sleep = MODULE.sleep
        self.sleep = FakeSleep()
        MODULE.sleep = self.sleep

    def tearDown(self) -> None:
        MODULE.sleep = self.old_sleep

    def test_transient_detection(self) -> None:
        self.assertTrue(MODULE.transient(500, SERVER_ERROR))
        self.assertTrue(MODULE.transient(503, {"raw": "gateway"}))
        self.assertTrue(MODULE.transient(400, SERVER_ERROR))
        self.assertTrue(MODULE.transient(400, {"raw": json.dumps(SERVER_ERROR)}))
        self.assertFalse(MODULE.transient(409, {"errors": [{"title": "x", "detail": "name taken"}]}))
        self.assertFalse(MODULE.transient(403, {"errors": [{"title": "x", "detail": "no role"}]}))

    def test_5xx_is_retried_with_backoff_then_succeeds(self) -> None:
        api = FakeApi(
            bundle_ids=[bundle_row(BUNDLE)],
            profile_failures={"MAC_APP_STORE": [(500, SERVER_ERROR), (502, {"raw": "bad gateway"})]},
        )
        with tempfile.TemporaryDirectory() as tmp:
            manifest, out = run_mint(api, tmp)
        self.assertEqual(self.sleep.waits, [5, 15])
        mac_posts = [
            b for b in api.posts("/profiles") if b["data"]["attributes"]["profileType"] == "MAC_APP_STORE"
        ]
        self.assertEqual(len(mac_posts), 3)
        self.assertEqual(manifest["profiles"]["MAC_APP_STORE"]["status"], "created")
        self.assertIn("retrying in 5s (attempt 1 of 4)", out)
        self.assertIn("retrying in 15s (attempt 2 of 4)", out)

    def test_gives_up_after_three_retries(self) -> None:
        failures = [(500, SERVER_ERROR)] * 4
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE)], profile_failures={"IOS_APP_STORE": failures})
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(MODULE.MintError, "HTTP 500 on attempt 4 of 4"):
                run_mint(api, tmp, platforms="ios")
        self.assertEqual(self.sleep.waits, [5, 15, 45])
        self.assertEqual(len(api.posts("/profiles")), 4)

    def test_non_transient_error_is_not_retried(self) -> None:
        forbidden = {"errors": [{"title": "Forbidden", "detail": "key lacks the role"}]}
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE)], profile_failures={"IOS_APP_STORE": [(403, forbidden)]})
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(MODULE.MintError, "attempt 1 of 4: Forbidden: key lacks the role"):
                run_mint(api, tmp, platforms="ios")
        self.assertEqual(self.sleep.waits, [])
        self.assertEqual(len(api.posts("/profiles")), 1)

    def test_profile_created_during_a_500_is_replaced_on_retry(self) -> None:
        # Apple can return 500 after creating the profile. The retry must not
        # then fail on the name conflict; it deletes and recreates.
        name = MODULE.profile_name("macOS", "manual")
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE)], profile_failures={"MAC_APP_STORE": [(500, SERVER_ERROR)]})
        original_call = api.__call__

        def call(method, path, token, body=None):
            status, payload = original_call(method, path, token, body)
            if method == "POST" and path == "/profiles" and status == 500:
                api.profiles.append(profile_row("GHOST", "MAC_APP_STORE", name))
            return status, payload

        with tempfile.TemporaryDirectory() as tmp:
            manifest, _ = run_mint(call, tmp)
        self.assertEqual(manifest["replaced_profiles"], ["GHOST"])
        self.assertEqual(api.deletes("/profiles/"), ["/profiles/GHOST"])
        self.assertEqual(manifest["profiles"]["MAC_APP_STORE"]["status"], "created")


class PartialOutputTests(unittest.TestCase):
    def setUp(self) -> None:
        self.old_sleep = MODULE.sleep
        MODULE.sleep = FakeSleep()

    def tearDown(self) -> None:
        MODULE.sleep = self.old_sleep

    def test_mac_profile_failure_still_writes_certificates_and_ios_profile(self) -> None:
        # The shape of the first real run: both certificates minted, iOS
        # profile created, then Apple 500s on the macOS profile for good.
        api = FakeApi(
            bundle_ids=[bundle_row(BUNDLE)],
            profile_failures={"MAC_APP_STORE": [(500, SERVER_ERROR)] * 4},
        )
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(MODULE.MintError, "MAC_APP_STORE"):
                run_mint(api, tmp)
            self.assertEqual(
                listdir(tmp),
                [
                    "apple-distribution.cer",
                    "ios-app-store.mobileprovision",
                    "mac-installer-distribution.cer",
                    "manifest.json",
                ],
            )
            manifest = read_manifest(tmp)
        self.assertEqual(manifest["status"], "failed")
        self.assertIn("HTTP 500", manifest["error"])
        self.assertEqual(manifest["bundle_id"], BUNDLE)
        self.assertEqual(manifest["certificates"]["DISTRIBUTION"]["status"], "created")
        self.assertEqual(manifest["certificates"]["MAC_INSTALLER_DISTRIBUTION"]["status"], "created")
        self.assertEqual(manifest["profiles"]["IOS_APP_STORE"]["status"], "created")
        self.assertEqual(manifest["profiles"]["MAC_APP_STORE"], {"status": "failed"})
        # The ids needed for a reuse run are in the manifest.
        for cert_type in ("DISTRIBUTION", "MAC_INSTALLER_DISTRIBUTION"):
            self.assertTrue(manifest["certificates"][cert_type]["id"].startswith("NEW"))

    def test_failure_on_second_certificate_writes_the_first(self) -> None:
        def api(method, path, token, body=None):
            if method == "POST" and path == "/certificates":
                kind = body["data"]["attributes"]["certificateType"]
                if kind == "DISTRIBUTION":
                    return 201, {"data": cert_row("NEW1", kind, FUTURE, content=b"DER-1")}
                return 403, {"errors": [{"title": "Forbidden", "detail": "key lacks the role"}]}
            raise AssertionError(f"unexpected call {method} {path}")

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(MODULE.MintError, "key lacks the role"):
                run_mint(api, tmp)
            self.assertEqual(listdir(tmp), ["apple-distribution.cer", "manifest.json"])
            manifest = read_manifest(tmp)
        self.assertEqual(manifest["status"], "failed")
        self.assertIsNone(manifest["bundle_id"])
        self.assertEqual(manifest["certificates"]["DISTRIBUTION"]["status"], "created")
        self.assertEqual(manifest["certificates"]["MAC_INSTALLER_DISTRIBUTION"], {"status": "failed"})
        self.assertEqual(manifest["profiles"]["IOS_APP_STORE"], {"status": "skipped"})
        self.assertEqual(manifest["profiles"]["MAC_APP_STORE"], {"status": "skipped"})

    def test_failure_report_names_each_item_in_the_table(self) -> None:
        api = FakeApi(bundle_ids=[bundle_row("com.example.other")])
        with tempfile.TemporaryDirectory() as tmp:
            out = io.StringIO()
            with redirect_stdout(out), self.assertRaisesRegex(MODULE.MintError, "found 0"):
                run_mint(api, tmp, platforms="ios")
            manifest = read_manifest(tmp)
        self.assertEqual(manifest["profiles"]["IOS_APP_STORE"], {"status": "skipped"})
        self.assertEqual(manifest["certificates"]["DISTRIBUTION"]["status"], "created")

    def test_main_exits_nonzero_but_leaves_partial_output(self) -> None:
        api = FakeApi(bundle_ids=[bundle_row(BUNDLE)], profile_failures={"IOS_APP_STORE": [(500, SERVER_ERROR)] * 4})
        old_send, old_token = MODULE.http_send, MODULE.bearer_token
        MODULE.http_send, MODULE.bearer_token = api, lambda: TOKEN
        try:
            with tempfile.TemporaryDirectory() as tmp:
                dist = Path(tmp) / "dist.csr"
                dist.write_text(DIST_CSR_PEM, encoding="utf-8")
                err = io.StringIO()
                with redirect_stdout(io.StringIO()), unittest.mock.patch("sys.stderr", err):
                    rc = MODULE.main(
                        [
                            "mint", "--platforms", "ios", "--dist-csr", str(dist),
                            "--bundle-id", BUNDLE, "--label", "manual",
                            "--out", str(Path(tmp) / "out"),
                        ]
                    )
                self.assertEqual(rc, 1)
                self.assertIn("apple_signing_assets:", err.getvalue())
                self.assertEqual(listdir(tmp), ["apple-distribution.cer", "manifest.json"])
        finally:
            MODULE.http_send, MODULE.bearer_token = old_send, old_token


if __name__ == "__main__":
    unittest.main()
