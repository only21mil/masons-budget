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

Reuse instead of minting
------------------------
A run that fails halfway (the first run did, on an Apple HTTP 500 creating the
macOS profile) must not mint again on the retry. Three things stop that:
`--reuse-*-certificate-id` uses an existing certificate after checking its type
and expiry; before any POST the script looks for a live certificate of that
type whose name matches the CSR's subject CN; and `--platforms ios` skips the
installer certificate and the macOS profile entirely. Profile creation retries
on 5xx with backoff, and whatever was produced is written before exit, even on
failure, so the artifact upload always has something to save.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
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
# What each --platforms choice needs. The macOS App Store path needs the
# installer certificate for the .pkg; iOS never does.
PLATFORM_PLAN = {
    "ios": ((DIST_TYPE,), ("IOS_APP_STORE",)),
    "macos": ((DIST_TYPE, INSTALLER_TYPE), ("MAC_APP_STORE",)),
    "both": ((DIST_TYPE, INSTALLER_TYPE), ("IOS_APP_STORE", "MAC_APP_STORE")),
}
# Seconds to wait before each profile-creation retry on a 5xx.
PROFILE_RETRY_BACKOFF = (5, 15, 45)

# Indirections the tests replace.
sleep = time.sleep


def now():
    return datetime.now(timezone.utc)


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


def transient(status, payload):
    """A server-side failure worth retrying: any 5xx, or Apple's generic
    "An unexpected error occurred on the server side" detail."""
    if status >= 500:
        return True
    return "unexpected error" in error_detail(payload).lower()


def parse_apple_time(text):
    """Apple returns ISO-8601 with milliseconds and an offset, e.g.
    2027-09-05T00:00:00.000+00:00. Older payloads used a trailing Z."""
    if not text:
        return None
    value = str(text).replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def is_expired(row):
    expires = parse_apple_time(row.get("attributes", {}).get("expirationDate"))
    return expires is not None and expires <= now()


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


def csr_common_name(path):
    """The subject CN of a PEM CSR, or None when it cannot be read.

    Uses cryptography when it is importable (the workflow installs it for the
    JWT) and falls back to the openssl binary, which every runner has.
    """
    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID

        csr = x509.load_pem_x509_csr(Path(path).read_bytes())
        values = [a.value for a in csr.subject.get_attributes_for_oid(NameOID.COMMON_NAME)]
        return str(values[0]) if values else None
    except ImportError:
        pass
    except (OSError, ValueError):
        return None
    try:
        proc = subprocess.run(
            ["openssl", "req", "-noout", "-subject",
             "-nameopt", "sep_multiline,lname,utf8,esc_ctrl", "-in", str(path)],
            capture_output=True, text=True, check=False, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    for line in proc.stdout.splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key == "commonName":
            return value
    return None


# --- Certificates -----------------------------------------------------------


def list_certificates(send, token, cert_type):
    query = urllib.parse.urlencode({"filter[certificateType]": cert_type, "limit": 200})
    return paged(send, token, f"/certificates?{query}")


def oldest_certificate(rows):
    """The certificate with the earliest expirationDate. ISO-8601 sorts as text."""
    if not rows:
        raise MintError("no certificates of that type exist, so there is nothing to revoke")
    return min(rows, key=lambda c: str(c.get("attributes", {}).get("expirationDate", "")))


def describe(row):
    attrs = row.get("attributes", {})
    return (
        f"{row.get('id')} ({attrs.get('certificateType', '')}) "
        f"{attrs.get('displayName') or attrs.get('name') or ''} "
        f"expiring {str(attrs.get('expirationDate', ''))[:19]}"
    )


def check_reusable(row, cert_type, why):
    """Refuse a certificate that cannot serve as `cert_type`. Returns the row."""
    attrs = row.get("attributes", {})
    actual = attrs.get("certificateType")
    if actual != cert_type:
        raise MintError(f"{why}: certificate {row.get('id')} is {actual}, not {cert_type}")
    if is_expired(row):
        raise MintError(
            f"{why}: certificate {row.get('id')} expired on "
            f"{str(attrs.get('expirationDate'))[:19]}"
        )
    if not attrs.get("certificateContent"):
        raise MintError(f"{why}: certificate {row.get('id')} has no certificateContent")
    return row


def fetch_certificate(send, token, cert_id, cert_type):
    """GET one certificate by id for --reuse-*-certificate-id and vet it."""
    status, payload = send("GET", f"/certificates/{cert_id}", token)
    if status != 200:
        raise MintError(
            f"GET /certificates/{cert_id} failed with HTTP {status}: {error_detail(payload)}"
        )
    row = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(row, dict) or "id" not in row:
        raise MintError(f"GET /certificates/{cert_id} returned no certificate")
    return check_reusable(row, cert_type, f"--reuse for {cert_type}")


def find_certificate_named(send, token, cert_type, common_name):
    """A live certificate of `cert_type` whose displayName or name equals the
    CSR subject CN, or None. Picks the one expiring last when several match."""
    if not common_name:
        return None
    matches = [
        row for row in list_certificates(send, token, cert_type)
        if common_name in (
            row.get("attributes", {}).get("displayName"),
            row.get("attributes", {}).get("name"),
        )
        and not is_expired(row)
        and row.get("attributes", {}).get("certificateContent")
    ]
    if not matches:
        return None
    return max(matches, key=lambda c: str(c.get("attributes", {}).get("expirationDate", "")))


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


def delete_profiles_named(send, token, name):
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
    return replaced


def create_profile(send, token, profile_type, name, bundle_id, certificate_id):
    """Create the profile, deleting any existing profile of the same name first.

    A 5xx or Apple's "unexpected error" is retried after each backoff in
    PROFILE_RETRY_BACKOFF. The same-name sweep runs again before each retry,
    because a 500 can leave the profile created on Apple's side, and the next
    POST would then fail on the name. Returns (profile row, replaced ids).
    """
    replaced = delete_profiles_named(send, token, name)
    body = profile_payload(profile_type, name, bundle_id, certificate_id)
    attempts = 1 + len(PROFILE_RETRY_BACKOFF)
    for attempt in range(1, attempts + 1):
        status, payload = send("POST", "/profiles", token, body)
        if status in (200, 201):
            return payload["data"], replaced
        detail = error_detail(payload)
        if not transient(status, payload) or attempt == attempts:
            raise MintError(
                f"creating {profile_type} profile {name!r} failed with HTTP {status} "
                f"on attempt {attempt} of {attempts}: {detail}"
            )
        wait = PROFILE_RETRY_BACKOFF[attempt - 1]
        print(
            f"creating {profile_type} profile {name!r} hit HTTP {status} ({detail}); "
            f"retrying in {wait}s (attempt {attempt} of {attempts})"
        )
        sleep(wait)
        replaced.extend(delete_profiles_named(send, token, name))
    raise AssertionError("unreachable")


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


def summary_row(row, file_name, status=None):
    attrs = row.get("attributes", {})
    summary = {
        "id": row["id"],
        "name": attrs.get("name"),
        "type": attrs.get("certificateType") or attrs.get("profileType"),
        "expires": attrs.get("expirationDate"),
        "file": file_name,
    }
    if status is not None:
        summary["status"] = status
    return summary


class Run:
    """Everything a mint run has produced so far, so it can be written out
    whether the run finishes or dies halfway."""

    def __init__(self, cert_types, profile_types):
        self.bundle = None
        # kind -> {"status": ..., "row": row or None}
        self.certificates = {t: {"status": "skipped", "row": None} for t in cert_types}
        self.profiles = {t: {"status": "skipped", "row": None} for t in profile_types}
        self.revoked = []
        self.replaced = []
        self.error = None

    def set(self, section, kind, status, row=None):
        getattr(self, section)[kind] = {"status": status, "row": row}

    def fail(self, section, kind):
        if getattr(self, section)[kind]["status"] == "skipped":
            getattr(self, section)[kind]["status"] = "failed"


def write_outputs(out_dir, run):
    """Write DER certificates, profiles, and manifest.json. Returns the manifest.

    Items without a row (failed or skipped) get a manifest entry with only a
    status, so a partial artifact says what is missing and why.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    bundle = run.bundle or {}
    manifest = {
        "status": "failed" if run.error else "ok",
        "error": run.error,
        "bundle_id": bundle.get("attributes", {}).get("identifier"),
        "bundle_id_resource": bundle.get("id"),
        "certificates": {},
        "profiles": {},
        "revoked_certificates": [summary_row(r, None) for r in run.revoked],
        "replaced_profiles": list(run.replaced),
    }
    for cert_type, item in run.certificates.items():
        row = item["row"]
        if row is None:
            manifest["certificates"][cert_type] = {"status": item["status"]}
            continue
        file_name = CERTIFICATE_FILES[cert_type]
        write_bytes(out, file_name, decode_content(row, "certificateContent"))
        manifest["certificates"][cert_type] = summary_row(row, file_name, item["status"])
    for profile_type, item in run.profiles.items():
        row = item["row"]
        if row is None:
            manifest["profiles"][profile_type] = {"status": item["status"]}
            continue
        file_name = next(f for t, _, f in PROFILES if t == profile_type)
        write_bytes(out, file_name, decode_content(row, "profileContent"))
        manifest["profiles"][profile_type] = summary_row(row, file_name, item["status"])
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
            if "id" not in row:
                print(f"{row['status']:<9} {kind:<26}")
                continue
            print(
                f"{row['status']:<9} {kind:<26} {row['id']:<12} "
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
    if manifest["error"]:
        print(f"status: failed ({manifest['error']})")


# --- Command ----------------------------------------------------------------


CERT_INPUTS = {
    # cert type -> (csr attr, cn attr, reuse-id attr, flag names for messages)
    DIST_TYPE: ("dist_csr", "dist_cn", "reuse_distribution_certificate_id",
                "--dist-csr", "--reuse-distribution-certificate-id"),
    INSTALLER_TYPE: ("installer_csr", "installer_cn", "reuse_installer_certificate_id",
                     "--installer-csr", "--reuse-installer-certificate-id"),
}


def plan_certificates(args, cert_types):
    """Read every needed CSR up front so a missing input fails before any call.

    Returns cert type -> {"reuse_id", "csr", "cn"}.
    """
    plan = {}
    for cert_type in cert_types:
        csr_attr, cn_attr, reuse_attr, csr_flag, reuse_flag = CERT_INPUTS[cert_type]
        reuse_id = (getattr(args, reuse_attr, None) or "").strip() or None
        csr_path = getattr(args, csr_attr, None)
        if reuse_id:
            plan[cert_type] = {"reuse_id": reuse_id, "csr": None, "cn": None}
            continue
        if not csr_path:
            raise MintError(
                f"{csr_flag} is required for {cert_type} with --platforms "
                f"{args.platforms}, unless {reuse_flag} is given"
            )
        cn = getattr(args, cn_attr, None) or csr_common_name(csr_path)
        if not cn:
            print(
                f"warning: could not read a subject CN from {csr_path}; "
                f"skipping reuse-by-name for {cert_type}"
            )
        plan[cert_type] = {"reuse_id": None, "csr": read_csr(csr_path), "cn": cn}
    return plan


def obtain_certificate(send, token, cert_type, spec, revoke_oldest, run):
    if spec["reuse_id"]:
        row = fetch_certificate(send, token, spec["reuse_id"], cert_type)
        print(f"reused {describe(row)} (by id)")
        run.set("certificates", cert_type, "reused", row)
        return row
    existing = find_certificate_named(send, token, cert_type, spec["cn"])
    if existing is not None:
        print(f"reused {describe(existing)} (name matches CSR CN {spec['cn']!r})")
        run.set("certificates", cert_type, "reused", existing)
        return existing
    row, victim = create_certificate(send, token, cert_type, spec["csr"], revoke_oldest)
    run.set("certificates", cert_type, "created", row)
    if victim is not None:
        run.revoked.append(victim)
    return row


def mint(args, send, token):
    if not LABEL_PATTERN.match(args.label):
        raise MintError(
            "--label must be 1-64 characters of letters, digits, space, dot, "
            "underscore, or hyphen, and start with a letter or digit"
        )
    platforms = getattr(args, "platforms", None) or "both"
    if platforms not in PLATFORM_PLAN:
        raise MintError(f"--platforms must be one of {', '.join(PLATFORM_PLAN)}")
    cert_types, profile_types = PLATFORM_PLAN[platforms]
    specs = plan_certificates(args, cert_types)

    run = Run(cert_types, profile_types)
    try:
        for cert_type in cert_types:
            try:
                obtain_certificate(
                    send, token, cert_type, specs[cert_type], args.revoke_oldest_if_capped, run
                )
            except MintError:
                run.fail("certificates", cert_type)
                raise

        run.bundle = find_bundle_id(send, token, args.bundle_id)

        dist_id = run.certificates[DIST_TYPE]["row"]["id"]
        for profile_type, platform_word, _ in PROFILES:
            if profile_type not in profile_types:
                continue
            name = profile_name(platform_word, args.label)
            try:
                row, gone = create_profile(
                    send, token, profile_type, name, run.bundle["id"], dist_id
                )
            except MintError:
                run.fail("profiles", profile_type)
                raise
            run.set("profiles", profile_type, "created", row)
            run.replaced.extend(gone)
    except MintError as exc:
        run.error = str(exc)
        try:
            manifest = write_outputs(args.out, run)
        except MintError as write_exc:
            print(f"apple_signing_assets: could not write partial output: {write_exc}", file=sys.stderr)
            raise exc from None
        print_table(manifest)
        raise

    manifest = write_outputs(args.out, run)
    print_table(manifest)
    return manifest


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    m = sub.add_parser("mint", help="issue certificates from CSRs and create App Store profiles")
    m.add_argument("--dist-csr", help="PEM CSR for the Apple Distribution certificate")
    m.add_argument("--installer-csr", help="PEM CSR for the Mac Installer Distribution certificate")
    m.add_argument(
        "--platforms",
        choices=tuple(PLATFORM_PLAN),
        default="both",
        help="ios: distribution certificate and iOS profile only; macos: both certificates and the macOS profile; both (default)",
    )
    m.add_argument(
        "--reuse-distribution-certificate-id",
        help="use this existing DISTRIBUTION certificate instead of minting one",
    )
    m.add_argument(
        "--reuse-installer-certificate-id",
        help="use this existing MAC_INSTALLER_DISTRIBUTION certificate instead of minting one",
    )
    m.add_argument(
        "--dist-cn",
        help="name that marks an existing DISTRIBUTION certificate as reusable (default: the CSR subject CN)",
    )
    m.add_argument(
        "--installer-cn",
        help="name that marks an existing MAC_INSTALLER_DISTRIBUTION certificate as reusable (default: the CSR subject CN)",
    )
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
