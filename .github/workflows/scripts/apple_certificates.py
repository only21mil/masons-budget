#!/usr/bin/env python3
"""List and revoke Apple signing certificates through the App Store Connect API.

Why this exists
---------------
TF-003 (2026-05-03) and again on 2026-07-28: the release workflow archives with
`CODE_SIGN_STYLE=Automatic` plus `-allowProvisioningUpdates` and an App Store
Connect API key. That combination authorises xcodebuild to CREATE an Apple
Development certificate on a run that needs no development certificate at all.
Enough runs and the account hits its cap, and every subsequent archive fails
with "Choose a certificate to revoke" before a single line compiles.

The credentials that can clear this live only as Actions secrets, so the tool
that uses them has to run here. `list` is read-only and is the default; nothing
is destroyed without an explicit `revoke` and an explicit id.

Deliberately conservative
-------------------------
`revoke` refuses any certificate whose type is not a development type. The
distribution certificate is what `deploy.yml` signs releases with, the account
caps distribution certificates at two, and revoking one breaks shipping until a
replacement is issued from a Mac. That is a bad thing to do by accident at
02:00, so the guard is in the code rather than in a comment.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.appstoreconnect.apple.com/v1"

# Development certificates are the ones automatic signing mints. Anything else
# — distribution, installer, passes — is refused by `revoke` below.
DEVELOPMENT_TYPES = {
    "DEVELOPMENT",
    "IOS_DEVELOPMENT",
    "MAC_APP_DEVELOPMENT",
}


def fail(message):
    print(f"apple_certificates: {message}", file=sys.stderr)
    raise SystemExit(1)


def bearer_token():
    """Sign an ES256 JWT for the App Store Connect API."""
    try:
        import jwt  # PyJWT
    except ImportError:
        fail("PyJWT is required: pip install pyjwt cryptography")

    key_path = os.environ.get("ASC_KEY_PATH")
    key_id = os.environ.get("ASC_KEY_ID")
    issuer_id = os.environ.get("ASC_ISSUER_ID")
    for name, value in (
        ("ASC_KEY_PATH", key_path),
        ("ASC_KEY_ID", key_id),
        ("ASC_ISSUER_ID", issuer_id),
    ):
        if not value:
            fail(f"{name} is not set")
    if not os.path.isfile(key_path):
        fail(f"ASC_KEY_PATH does not exist: {key_path}")

    with open(key_path, "r", encoding="utf-8") as handle:
        private_key = handle.read()

    now = int(time.time())
    payload = {"iss": issuer_id, "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"}
    return jwt.encode(payload, private_key, algorithm="ES256", headers={"kid": key_id})


def request(method, path, token):
    req = urllib.request.Request(
        f"{API}{path}", method=method, headers={"Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            body = response.read()
            return response.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        return error.code, {"raw": body}


def certificates(token):
    found, page = [], "/certificates?limit=200"
    while page:
        status, payload = request("GET", page, token)
        if status != 200:
            fail(f"list failed with HTTP {status}: {str(payload)[:400]}")
        found.extend(payload.get("data", []))
        nxt = (payload.get("links") or {}).get("next")
        page = nxt.replace(API, "") if nxt else None
    return found


def command_list(token):
    rows = certificates(token)
    counts = {}
    print(f"{'id':<24} {'type':<24} {'expires':<22} name")
    print("-" * 100)
    for cert in sorted(rows, key=lambda c: c["attributes"].get("certificateType", "")):
        attributes = cert["attributes"]
        kind = attributes.get("certificateType", "?")
        counts[kind] = counts.get(kind, 0) + 1
        print(
            f"{cert['id']:<24} {kind:<24} "
            f"{str(attributes.get('expirationDate'))[:19]:<22} "
            f"{attributes.get('name', '')}"
        )
    print()
    print(f"total: {len(rows)}")
    for kind in sorted(counts):
        marker = "  <-- minted by automatic signing" if kind in DEVELOPMENT_TYPES else ""
        print(f"  {kind}: {counts[kind]}{marker}")
    print()
    print("To clear the cap, revoke DEVELOPMENT certificates only. Never revoke")
    print("distribution: deploy.yml signs releases with it and the account caps it at two.")


def command_revoke(token, wanted):
    rows = {c["id"]: c for c in certificates(token)}
    for cert_id in wanted:
        cert = rows.get(cert_id)
        if cert is None:
            fail(f"certificate {cert_id} not found; run `list` first")
        kind = cert["attributes"].get("certificateType", "?")
        if kind not in DEVELOPMENT_TYPES:
            fail(
                f"refusing to revoke {cert_id}: type {kind} is not a development "
                "certificate. This guard exists because revoking the distribution "
                "certificate stops releases until a Mac issues a replacement."
            )
        status, payload = request("DELETE", f"/certificates/{cert_id}", token)
        if status not in (200, 204):
            fail(f"revoke of {cert_id} failed with HTTP {status}: {str(payload)[:400]}")
        print(f"revoked {cert_id} ({kind}) {cert['attributes'].get('name', '')}")
    print(f"\nrevoked {len(wanted)} certificate(s)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("list", "revoke"))
    parser.add_argument(
        "--id",
        action="append",
        default=[],
        help="certificate id to revoke; repeatable. Required for revoke.",
    )
    args = parser.parse_args()

    token = bearer_token()
    if args.command == "list":
        command_list(token)
        return
    if not args.id:
        fail("revoke needs at least one --id. Run `list` first and choose deliberately.")
    command_revoke(token, args.id)


if __name__ == "__main__":
    main()
