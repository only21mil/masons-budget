#!/usr/bin/env python3
"""Mint Apple signing certificates and App Store profiles from local CSRs.

Why this exists
---------------
The manual release path (docs/apple-self-hosted-release.md) needs an Apple
Distribution certificate, a Mac Installer Distribution certificate, and App
Store profiles for iOS and macOS. Issuing those in the developer portal by hand
is slow and error-prone, and the App Store Connect API credentials that can do
it exist only as Actions secrets. So the minting runs here.

What never leaves Victor's machine
----------------------------------
The private keys. Victor generates the key pairs locally and sends only the
certificate signing requests (CSRs) to this workflow. Apple signs the public
half, and this script writes back DER certificates and provisioning profiles.
Nothing this script writes is, or contains, a private key. The CSR reader
refuses input that carries one.

Cap handling
------------
Apple caps distribution certificates per type. When the POST is refused for
that reason and `--revoke-oldest-if-capped` is set, the certificate of that
type with the earliest expiry is revoked, printed, and the POST retried once.
Without the flag the script fails with Apple's error detail so the choice of
what to revoke stays with a human.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from apple_certificates import API, bearer_token, request  # noqa: E402

DIST_TYPE = "DISTRIBUTION"
INSTALLER_TYPE = "MAC_INSTALLER_DISTRIBUTION"

PROFILES = (
    # (profileType, platform word in the profile name, output file name)
    ("IOS_APP_STORE", "iOS", "ios-app-store.mobileprovision"),
    ("MAC_APP_STORE", "macOS", "mac-app-store.provisionprofile"),
)
CERTIFICATE_FILES = {
    DIST_TYPE: "apple-distribution.cer",
    INSTALLER_TYPE: "mac-installer-distribution.cer",
}

LABEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$")
CSR_HEADER = "-----BEGIN CERTIFICATE REQUEST-----"
CSR_FOOTER = "-----END CERTIFICATE REQUEST-----"


class MintError(Exception):
    """A failure the operator needs to read. Reported without a traceback."""


# --- HTTP -------------------------------------------------------------------


def request_json(method, path, token, body):
    """Like apple_certificates.request, but with a JSON body.

    Error bodies are parsed when they are JSON so the caller can read Apple's
    `errors[].detail`, which is what distinguishes a cap refusal from any other
    4xx.
    """
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {"raw": raw}


def http_send(method, path, token, body=None):
    """Default transport. Tests substitute a fake with the same signature."""
    if body is None:
        return request(method, path, token)
    return request_json(method, path, token, body)


def error_detail(payload):
    """Flatten an App Store Connect error payload into one readable line."""
    if isinstance(payload, dict) and "raw" in payload:
        try:
            payload = json.loads(payload["raw"])
        except (json.JSONDecodeError, TypeError):
            return str(payload["raw"])[:400]
    errors = payload.get("errors") if isinstance(payload, dict) else None
    if not errors:
        return str(payload)[:400]
    parts = []
    for item in errors:
        title = item.get("title") or ""
        detail = item.get("detail") or ""
        parts.append(f"{title}: {detail}".strip(": "))
    return "; ".join(parts)[:400]


def cap_reached(status, payload):
    """Apple refused the POST because the type is at its certificate limit."""
    if status == 409:
        return True
    detail = error_detail(payload).lower()
    return "maximum" in detail or "limit" in detail


def paged(send, token, path):
    found = []
    while path:
        status, payload = send("GET", path, token)
        if status != 200:
            raise MintError(f"GET {path} failed with HTTP {status}: {error_detail(payload)}")
        found.extend(payload.get("data", []))
        nxt = (payload.get("links") or {}).get("next")
        path = nxt.replace(API, "") if nxt else None
    return found


# --- CSR --------------------------------------------------------------------


def strip_pem(text):
    """Return the base64 body of a PEM CSR with header, footer, and newlines removed.

    Refuses anything that is not exactly one CERTIFICATE REQUEST block, and in
    particular anything carrying a private key: the whole point of this tool
    is that private keys never reach the runner.
    """
    if "PRIVATE KEY" in text:
        raise MintError("the CSR input contains a private key; send only the CSR")
    if CSR_HEADER not in text or CSR_FOOTER not in text:
        raise MintError("the CSR input is not a PEM certificate request")
    start = text.index(CSR_HEADER) + len(CSR_HEADER)
    end = text.index(CSR_FOOTER)
    if end < start:
        raise MintError("the CSR input has its PEM footer before its header")
    body = "".join(text[start:end].split())
    if not body:
        raise MintError("the CSR input has an empty PEM body")
    try:
        base64.b64decode(body, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise MintError(f"the CSR body is not valid base64: {exc}") from exc
    return body


def read_csr(path):
    try:
        return strip_pem(Path(path).read_text(encoding="utf-8"))
    except OSError as exc:
        raise MintError(f"cannot read CSR {path}: {exc}") from exc


# --- Certificates -----------------------------------------------------------


def list_certificates(send, token, cert_type):
    query = urllib.parse.urlencode({"filter[certificateType]": cert_type, "limit": 200})
    return paged(send, token, f"/certificates?{query}")


def oldest_certificate(rows):
    """The certificate with the earliest expirationDate. ISO-8601 sorts as text."""
    if not rows:
        raise MintError("no certificates of that type exist, so there is nothing to revoke")
    return min(rows, key=lambda c: str(c.get("attributes", {}).get("expirationDate", "")))


def certificate_payload(cert_type, csr_content):
    return {
        "data": {
            "type": "certificates",
            "attributes": {"certificateType": cert_type, "csrContent": csr_content},
        }
    }


def create_certificate(send, token, cert_type, csr_content, revoke_oldest):
    """POST the CSR. On a cap refusal, optionally revoke the oldest and retry once.

    Returns (certificate row, revoked row or None).
    """
    body = certificate_payload(cert_type, csr_content)
    status, payload = send("POST", "/certificates", token, body)
    if status in (200, 201):
        return payload["data"], None
    if not cap_reached(status, payload):
        raise MintError(f"creating {cert_type} failed with HTTP {status}: {error_detail(payload)}")
    if not revoke_oldest:
        raise MintError(
            f"Apple refused a new {cert_type} certificate (HTTP {status}): "
            f"{error_detail(payload)}. Re-run with --revoke-oldest-if-capped to "
            "revoke the one that expires soonest, or revoke by hand first."
        )

    victim = oldest_certificate(list_certificates(send, token, cert_type))
    status, payload = send("DELETE", f"/certificates/{victim['id']}", token)
    if status not in (200, 204):
        raise MintError(
            f"revoking {victim['id']} failed with HTTP {status}: {error_detail(payload)}"
        )
    attrs = victim.get("attributes", {})
    print(
        f"revoked {victim['id']} ({cert_type}) {attrs.get('name', '')} "
        f"expiring {str(attrs.get('expirationDate', ''))[:19]}"
    )

    status, payload = send("POST", "/certificates", token, body)
    if status not in (200, 201):
        raise MintError(
            f"creating {cert_type} still failed after revoking {victim['id']} "
            f"(HTTP {status}): {error_detail(payload)}"
        )
    return payload["data"], victim


# --- Bundle id and profiles -------------------------------------------------


def find_bundle_id(send, token, identifier):
    query = urllib.parse.urlencode({"filter[identifier]": identifier, "limit": 200})
    # Apple's identifier filter is a prefix match, so narrow to the exact id.
    rows = [
        r for r in paged(send, token, f"/bundleIds?{query}")
        if r.get("attributes", {}).get("identifier") == identifier
    ]
    if len(rows) != 1:
        raise MintError(
            f"expected exactly one bundle id matching {identifier}, found {len(rows)}"
        )
    return rows[0]


def profile_name(platform_word, label):
    return f"Vogel Vault {platform_word} App Store {label}"


def profile_payload(profile_type, name, bundle_id, certificate_id):
    return {
        "data": {
            "type": "profiles",
            "attributes": {"name": name, "profileType": profile_type},
            "relationships": {
                "bundleId": {"data": {"type": "bundleIds", "id": bundle_id}},
                "certificates": {"data": [{"type": "certificates", "id": certificate_id}]},
            },
        }
    }


def profiles_named(send, token, name):
    query = urllib.parse.urlencode({"filter[name]": name, "limit": 200})
    return [
        r for r in paged(send, token, f"/profiles?{query}")
        if r.get("attributes", {}).get("name") == name
    ]


def create_profile(send, token, profile_type, name, bundle_id, certificate_id):
    """Create the profile, deleting any existing profile of the same name first.

    Returns (profile row, list of replaced profile ids).
    """
    replaced = []
    for existing in profiles_named(send, token, name):
        status, payload = send("DELETE", f"/profiles/{existing['id']}", token)
        if status not in (200, 204):
            raise MintError(
                f"deleting existing profile {existing['id']} ({name}) failed with "
                f"HTTP {status}: {error_detail(payload)}"
            )
        replaced.append(existing["id"])
        print(f"replaced profile {existing['id']} {name}")

    body = profile_payload(profile_type, name, bundle_id, certificate_id)
    status, payload = send("POST", "/profiles", token, body)
    if status not in (200, 201):
        raise MintError(
            f"creating {profile_type} profile {name!r} failed with HTTP {status}: "
            f"{error_detail(payload)}"
        )
    return payload["data"], replaced


# --- Output -----------------------------------------------------------------


def decode_content(row, key):
    content = row.get("attributes", {}).get(key)
    if not content:
        raise MintError(f"{row.get('type')} {row.get('id')} has no {key} in the response")
    try:
        return base64.b64decode(content)
    except (binascii.Error, ValueError) as exc:
        raise MintError(f"{key} of {row.get('id')} is not valid base64: {exc}") from exc


def write_bytes(out_dir, name, data):
    path = Path(out_dir) / name
    path.write_bytes(data)
    return path


def summary_row(row, file_name):
    attrs = row.get("attributes", {})
    return {
        "id": row["id"],
        "name": attrs.get("name"),
        "type": attrs.get("certificateType") or attrs.get("profileType"),
        "expires": attrs.get("expirationDate"),
        "file": file_name,
    }


def write_outputs(out_dir, bundle, certificates, profiles, revoked, replaced):
    """Write DER certificates, profiles, and manifest.json. Returns the manifest."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    manifest = {
        "bundle_id": bundle.get("attributes", {}).get("identifier"),
        "bundle_id_resource": bundle.get("id"),
        "certificates": {},
        "profiles": {},
        "revoked_certificates": [
            summary_row(r, None) for r in revoked
        ],
        "replaced_profiles": list(replaced),
    }
    for cert_type, row in certificates.items():
        file_name = CERTIFICATE_FILES[cert_type]
        write_bytes(out, file_name, decode_content(row, "certificateContent"))
        manifest["certificates"][cert_type] = summary_row(row, file_name)
    for profile_type, row in profiles.items():
        file_name = next(f for t, _, f in PROFILES if t == profile_type)
        write_bytes(out, file_name, decode_content(row, "profileContent"))
        manifest["profiles"][profile_type] = summary_row(row, file_name)
    (out / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return manifest


def print_table(manifest):
    print()
    print(f"{'action':<9} {'kind':<26} {'id':<12} {'expires':<20} name")
    print("-" * 100)
    for section in ("certificates", "profiles"):
        for kind, row in manifest[section].items():
            print(
                f"{'created':<9} {kind:<26} {row['id']:<12} "
                f"{str(row['expires'])[:19]:<20} {row['name'] or ''}"
            )
    for row in manifest["revoked_certificates"]:
        print(
            f"{'revoked':<9} {row['type'] or '':<26} {row['id']:<12} "
            f"{str(row['expires'])[:19]:<20} {row['name'] or ''}"
        )
    for profile_id in manifest["replaced_profiles"]:
        print(f"{'replaced':<9} {'profile':<26} {profile_id:<12}")
    print()
    print(f"bundle id: {manifest['bundle_id']} ({manifest['bundle_id_resource']})")


# --- Command ----------------------------------------------------------------


def mint(args, send, token):
    if not LABEL_PATTERN.match(args.label):
        raise MintError(
            "--label must be 1-64 characters of letters, digits, space, dot, "
            "underscore, or hyphen, and start with a letter or digit"
        )
    dist_csr = read_csr(args.dist_csr)
    installer_csr = read_csr(args.installer_csr)

    revoked = []
    certificates = {}
    for cert_type, csr in ((DIST_TYPE, dist_csr), (INSTALLER_TYPE, installer_csr)):
        row, victim = create_certificate(send, token, cert_type, csr, args.revoke_oldest_if_capped)
        certificates[cert_type] = row
        if victim is not None:
            revoked.append(victim)

    bundle = find_bundle_id(send, token, args.bundle_id)

    profiles = {}
    replaced = []
    dist_id = certificates[DIST_TYPE]["id"]
    for profile_type, platform_word, _ in PROFILES:
        name = profile_name(platform_word, args.label)
        row, gone = create_profile(send, token, profile_type, name, bundle["id"], dist_id)
        profiles[profile_type] = row
        replaced.extend(gone)

    manifest = write_outputs(args.out, bundle, certificates, profiles, revoked, replaced)
    print_table(manifest)
    return manifest


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    m = sub.add_parser("mint", help="issue certificates from CSRs and create App Store profiles")
    m.add_argument("--dist-csr", required=True, help="PEM CSR for the Apple Distribution certificate")
    m.add_argument("--installer-csr", required=True, help="PEM CSR for the Mac Installer Distribution certificate")
    m.add_argument("--bundle-id", required=True, help="bundle identifier the profiles are for")
    m.add_argument("--label", required=True, help="suffix used in the profile names")
    m.add_argument(
        "--revoke-oldest-if-capped",
        action="store_true",
        help="when Apple refuses a certificate for being at the cap, revoke the one expiring soonest and retry once",
    )
    m.add_argument("--out", required=True, help="directory for certificates, profiles, and manifest.json")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        token = bearer_token()
        mint(args, http_send, token)
    except MintError as exc:
        print(f"apple_signing_assets: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
