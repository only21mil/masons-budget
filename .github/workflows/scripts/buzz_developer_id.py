#!/usr/bin/env python3
"""Bounded Buzz Developer ID API bootstrap. ASC private key stays in memory."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.x509.oid import NameOID

API = "https://api.appstoreconnect.apple.com/v1/certificates"
CERT_TYPE = "DEVELOPER_ID_APPLICATION"
TEAM = "384ZGKG4GB"
SUBJECT = "Buzz Developer ID Application"


class Hold(Exception):
    """A fail-closed condition safe to report without a credential value."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Hold("Apple returned a redirect; credential forwarding refused")


def token():
    import jwt
    key_id = os.environ.get("ASC_KEY_ID", "")
    issuer = os.environ.get("ASC_ISSUER_ID", "")
    if not re.fullmatch(r"[A-Z0-9]{10}", key_id) or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", issuer):
        raise Hold("Required protected ASC metadata is missing or malformed")
    raw = os.environ.pop("ASC_API_KEY_P8", "").strip().encode()
    if not raw:
        raise Hold("ASC_API_KEY_P8 is missing")
    try:
        if not raw.startswith(b"-----BEGIN PRIVATE KEY-----"):
            raw = base64.b64decode(raw, validate=True)
        now = int(time.time())
        return jwt.encode({"iss": issuer, "iat": now, "exp": now + 300,
                           "aud": "appstoreconnect-v1"}, raw,
                          algorithm="ES256", headers={"kid": key_id})
    except Exception:
        raise Hold("ASC key could not sign the API request") from None


def request(method, bearer, payload=None):
    # No pagination URLs, arbitrary paths, redirects, or automatic POST retries.
    if method not in ("GET", "POST"):
        raise Hold("Unsupported Apple operation")
    url = API + ("?limit=200" if method == "GET" else "")
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer " + bearer, "Content-Type": "application/json"})
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(req, timeout=45) as response:
            return response.status, json.loads(response.read(2_000_000))
    except urllib.error.HTTPError as error:
        # Do not retain arbitrary response content that could echo inputs.
        try:
            body = json.loads(error.read(100_000))
        except Exception:
            body = {}
        codes = [e.get("code", "UNKNOWN") for e in body.get("errors", [])]
        safe = [c for c in codes if isinstance(c, str) and re.fullmatch(r"[A-Z0-9_.-]{1,100}", c)]
        return error.code, {"error_codes": safe}
    except (OSError, ValueError):
        raise Hold("Apple transport failed; reconcile with a probe before any further create") from None


def csr_input(encoded):
    try:
        pem = base64.b64decode(encoded, validate=True)
        if not re.fullmatch(rb"-----BEGIN CERTIFICATE REQUEST-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE REQUEST-----\s*", pem):
            raise ValueError()
        csr = x509.load_pem_x509_csr(pem)
        if not csr.is_signature_valid:
            raise ValueError()
        names = csr.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
        teams = csr.subject.get_attributes_for_oid(NameOID.ORGANIZATIONAL_UNIT_NAME)
        if [n.value for n in names] != [SUBJECT] or [t.value for t in teams] != [TEAM]:
            raise ValueError()
        return csr, pem.decode()
    except Exception:
        raise Hold("Expected exactly one valid public Buzz CSR for the approved team") from None


def public_bytes(key):
    return key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


def inspect_certificate(row, csr=None):
    attrs = row.get("attributes", {})
    if attrs.get("certificateType") not in (CERT_TYPE, "DEVELOPER_ID_APPLICATION_G2"):
        raise Hold("Apple certificate is not Developer ID Application")
    try:
        der = base64.b64decode(attrs["certificateContent"], validate=True)
        cert = x509.load_der_x509_certificate(der)
        teams = cert.subject.get_attributes_for_oid(NameOID.ORGANIZATIONAL_UNIT_NAME)
        if [t.value for t in teams] != [TEAM] or cert.not_valid_after_utc <= datetime.now(timezone.utc):
            raise ValueError()
        if csr is not None and public_bytes(cert.public_key()) != public_bytes(csr.public_key()):
            raise ValueError()
        return der, cert
    except Exception:
        raise Hold("Certificate team, expiry, public key, or DER validation failed") from None


def run(operation, encoded, out, api=request, bearer=None):
    if operation not in ("buzz-developer-id-probe", "buzz-developer-id-create"):
        raise Hold("Unsupported Buzz certificate operation")
    csr, pem = csr_input(encoded) if operation.endswith("create") else (None, None)
    if operation.endswith("probe") and encoded:
        raise Hold("A read-only probe does not accept a CSR")
    out.mkdir(parents=True, exist_ok=True)
    receipt = {"operation": operation, "team_id": TEAM, "certificate_type": CERT_TYPE,
               "create_permission": "unproven", "post_attempts": 0, "status": "HOLD"}
    try:
        bearer = bearer if bearer is not None else token()
        status, payload = api("GET", bearer)
        receipt["list_http_status"] = status
        if status != 200:
            receipt["apple_error_codes"] = payload.get("error_codes", [])
            raise Hold("Certificate visibility denied; no creation attempted")
        if payload.get("links", {}).get("next"):
            raise Hold("Certificate inventory exceeds one bounded page; no creation attempted")
        candidates = [r for r in payload.get("data", []) if r.get("attributes", {}).get("certificateType") in (CERT_TYPE, "DEVELOPER_ID_APPLICATION_G2")]
        receipt["developer_id_inventory"] = [{"id": r["id"], "type": r["attributes"]["certificateType"], "expires": r["attributes"].get("expirationDate")} for r in candidates]
        if csr is None:
            for row, summary in zip(candidates, receipt["developer_id_inventory"]):
                if not re.fullmatch(r"[A-Z0-9]{1,32}", row["id"]):
                    raise Hold("Unexpected Apple certificate identifier")
                der, _ = inspect_certificate(row)
                summary["certificate_sha256"] = hashlib.sha256(der).hexdigest()
                (out / (row["id"] + ".cer")).write_bytes(der)
            receipt["status"] = "READ_ONLY_PASS"
            return receipt
        receipt["csr_sha256"] = hashlib.sha256(pem.encode()).hexdigest()
        match = None
        for row in candidates:
            der, cert = inspect_certificate(row)
            if public_bytes(cert.public_key()) == public_bytes(csr.public_key()):
                match = row
                break
        if match is None:
            if len(candidates) >= 5:
                raise Hold("Developer ID certificate count is at the documented cap; no revocation permitted")
            receipt["post_attempts"] = 1
            # Save intent before the sole state-changing HTTP request.
            (out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
            status, payload = api("POST", bearer, {"data": {"type": "certificates", "attributes": {"certificateType": CERT_TYPE, "csrContent": pem}}})
            receipt["create_http_status"] = status
            if status != 201:
                receipt["apple_error_codes"] = payload.get("error_codes", [])
                raise Hold("Apple refused the sole create attempt; stop and assess the receipt")
            match = payload["data"]
            receipt["create_permission"] = "confirmed"
        else:
            receipt["reused_matching_public_key"] = True
        # Record issued ID even if subsequent local validation fails.
        receipt["certificate_id"] = match["id"]
        der, cert = inspect_certificate(match, csr)
        (out / "buzz-developer-id.cer").write_bytes(der)
        receipt["certificate_sha256"] = hashlib.sha256(der).hexdigest()
        receipt["certificate_expires"] = cert.not_valid_after_utc.isoformat()
        receipt["status"] = "CERTIFICATE_READY"
        return receipt
    except Hold as error:
        receipt["hold"] = str(error)
        raise
    finally:
        (out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    try:
        result = run(os.environ.get("BUZZ_CERTIFICATE_OPERATION", ""),
                     os.environ.get("BUZZ_DEVELOPER_ID_CSR_B64", ""),
                     Path(os.environ["BUZZ_CERTIFICATE_OUT"]))
        print(json.dumps(result, sort_keys=True))
    except Hold as error:
        print("HOLD: " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("HOLD: Unexpected bootstrap failure; inspect public receipt, do not retry creation blindly", file=sys.stderr)
        sys.exit(1)
