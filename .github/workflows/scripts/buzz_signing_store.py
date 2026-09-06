#!/usr/bin/env python3
"""One-time local Buzz signing store. Never invoke from a build workflow.

Only --execute permits key generation or secret installation. Private values
exist in process memory and ~/.config/sats/secrets.env, never temporary files.
"""
from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import os
import re
import secrets
import shlex
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID, ObjectIdentifier

from buzz_developer_id import TEAM, SUBJECT, Hold, public_bytes

STORE = Path.home() / ".config/sats/secrets.env"
PREFIX = "BUZZ_"
APPLE_ROOT_SHA256 = "b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024"
REPO = "only21mil/masons-budget"
SECRET_NAMES = ("BUZZ_DEVELOPER_ID_P12_B64", "BUZZ_DEVELOPER_ID_P12_PASSWORD", "BUZZ_TAURI_SIGNING_PRIVATE_KEY")
PUBLIC_NAME = "BUZZ_TAURI_SIGNING_PUBLIC_KEY"


class Store:
    def __enter__(self):
        if STORE.parent.is_symlink() or STORE.is_symlink():
            raise Hold("Protected store must not be a symlink")
        STORE.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        info = STORE.parent.stat()
        if stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid():
            raise Hold("Protected store directory must be owned by this user and mode 0700")
        self.fd = os.open(STORE, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(self.fd)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid() or info.st_nlink != 1:
            os.close(self.fd)
            raise Hold("Protected store must be an owned mode-0600 regular file with one link")
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        self.text = os.read(self.fd, info.st_size).decode()
        self.values = {}
        for line in self.text.splitlines():
            match = re.match(r"(?:export\s+)?(BUZZ_[A-Z0-9_]+)=(.*)$", line)
            if match:
                parsed = shlex.split(match[2], comments=True)
                if len(parsed) != 1 or match[1] in self.values:
                    raise Hold("Buzz store entries must be unique single-line shell values")
                self.values[match[1]] = parsed[0]
        return self

    def require(self, name):
        if not self.values.get(name):
            raise Hold("Missing protected entry: " + name)
        return self.values[name]

    def append(self, values):
        if any(name in self.values for name in values):
            raise Hold("A requested Buzz credential already exists; rotation is not authorized")
        text = ("\n" if self.text and not self.text.endswith("\n") else "")
        for name, value in values.items():
            if not re.fullmatch(r"BUZZ_[A-Z0-9_]+", name) or "\n" in value or "\r" in value:
                raise Hold("Only single-line Buzz entries may be appended")
            text += name + "=" + shlex.quote(value) + "\n"
        encoded = text.encode()
        offset = 0
        while offset < len(encoded):
            offset += os.write(self.fd, encoded[offset:])
        os.fsync(self.fd)
        self.values.update(values)
        self.text += text

    def __exit__(self, *_):
        os.close(self.fd)


def output_public(path, content):
    if path is None:
        raise Hold("Public output path is required")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(content)


def developer_id_key(store, out):
    if out is None or out.exists():
        raise Hold("A new public CSR output path is required")
    name = "BUZZ_DEVELOPER_ID_PRIVATE_KEY_PEM_B64"
    if name in store.values:
        # Recover the same CSR public key after an interrupted write; never rotate.
        key = serialization.load_pem_private_key(base64.b64decode(store.require(name), validate=True), None)
    else:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        store.append({name: base64.b64encode(pem).decode()})
    csr = x509.CertificateSigningRequestBuilder().subject_name(x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, SUBJECT),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, TEAM),
    ])).sign(key, hashes.SHA256())
    pem = csr.public_bytes(serialization.Encoding.PEM)
    output_public(out, pem)
    return {"public_csr_sha256": hashlib.sha256(pem).hexdigest(), "public_csr": str(out)}


def updater_key(store, cli, out):
    if out is None or out.exists():
        raise Hold("A new public updater output path is required")
    if "BUZZ_TAURI_SIGNING_PRIVATE_KEY" in store.values:
        public = store.require(PUBLIC_NAME)
    else:
        if cli is None or not cli.is_absolute() or not cli.is_file():
            raise Hold("Pass the reviewed absolute Tauri CLI binary path")
        version = subprocess.run([str(cli), "--version"], capture_output=True, check=False)
        if version.returncode or version.stdout.strip() != b"tauri-cli 2.11.4":
            raise Hold("Expected the Buzz-pinned Tauri CLI 2.11.4")
        result = subprocess.run([str(cli), "signer", "generate", "--ci"], capture_output=True, check=False)
        if result.returncode:
            raise Hold("Updater key generation failed; captured output withheld")
        match = re.search(rb"Private: \(Keep it secret!\)\s+([A-Za-z0-9+/=]+)\s+Public:\s+([A-Za-z0-9+/=]+)", result.stdout)
        if not match:
            raise Hold("Unexpected Tauri generator output; captured output withheld")
        private, public = (v.decode() for v in match.groups())
        # Tauri exports base64 of minisign's textual key boxes.
        if not base64.b64decode(private, validate=True).startswith(b"untrusted comment:") or not base64.b64decode(public, validate=True).startswith(b"untrusted comment:"):
            raise Hold("Unexpected Tauri key format; captured output withheld")
        store.append({"BUZZ_TAURI_SIGNING_PRIVATE_KEY": private, PUBLIC_NAME: public})
    output_public(out, (public + "\n").encode())
    return {"updater_public_key_sha256": hashlib.sha256(base64.b64decode(public, validate=True)).hexdigest(), "updater_public_key_file": str(out)}


def load_cert(path):
    if path is None:
        raise Hold("Certificate, intermediate, and Apple root paths are required")
    raw = path.read_bytes()
    return x509.load_pem_x509_certificate(raw) if raw.startswith(b"-----BEGIN") else x509.load_der_x509_certificate(raw)


def verify_apple_chain(cert, intermediate, root):
    now = datetime.now(timezone.utc)
    if any(c.not_valid_before_utc > now or c.not_valid_after_utc <= now for c in (cert, intermediate, root)):
        raise Hold("Certificate chain is outside its validity period")
    if root.fingerprint(hashes.SHA256()).hex() != APPLE_ROOT_SHA256:
        raise Hold("Apple root fingerprint mismatch")
    # The exact DER SHA-256 pin establishes the trust anchor (RFC 5280 §6.1).
    # Its legacy SHA-1 self-signature is not a path signature and is unsupported
    # by current backends. Intermediate and leaf signatures remain mandatory.
    intermediate.verify_directly_issued_by(root)
    cert.verify_directly_issued_by(intermediate)


def assemble_p12(store, cert_path, intermediate_path, root_path):
    if any(name in store.values for name in SECRET_NAMES[:2]):
        raise Hold("Buzz p12 already exists; no overwrite or rotation permitted")
    key = serialization.load_pem_private_key(base64.b64decode(store.require("BUZZ_DEVELOPER_ID_PRIVATE_KEY_PEM_B64"), validate=True), None)
    cert, intermediate, root = (load_cert(p) for p in (cert_path, intermediate_path, root_path))
    verify_apple_chain(cert, intermediate, root)
    if public_bytes(key.public_key()) != public_bytes(cert.public_key()):
        raise Hold("Issued certificate does not match retained Buzz private key")
    teams = cert.subject.get_attributes_for_oid(NameOID.ORGANIZATIONAL_UNIT_NAME)
    if [t.value for t in teams] != [TEAM]:
        raise Hold("Issued certificate has the wrong Apple team")
    cert.extensions.get_extension_for_oid(ObjectIdentifier("1.2.840.113635.100.6.1.13"))
    password = secrets.token_urlsafe(36)
    encryption = (serialization.PrivateFormat.PKCS12.encryption_builder().kdf_rounds(50000)
                  .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
                  .hmac_hash(hashes.SHA1()).build(password.encode()))
    p12 = pkcs12.serialize_key_and_certificates(b"Buzz Developer ID Application", key, cert, [intermediate], encryption)
    # A local round trip proves retained certificate/key and chain agree.
    loaded_key, loaded_cert, chain = pkcs12.load_key_and_certificates(p12, password.encode())
    if public_bytes(loaded_key.public_key()) != public_bytes(loaded_cert.public_key()) or len(chain) != 1:
        raise Hold("p12 round-trip validation failed")
    store.append({SECRET_NAMES[0]: base64.b64encode(p12).decode(), SECRET_NAMES[1]: password})
    return {"certificate_sha256": cert.fingerprint(hashes.SHA256()).hex(), "p12_stored": True, "intermediate_sha256": intermediate.fingerprint(hashes.SHA256()).hex()}


def github_install(store):
    # GitHub values enter stdin, never argv. List metadata before any write.
    result = subprocess.run(["gh", "secret", "list", "-R", REPO, "--json", "name"], capture_output=True, check=False)
    variables = subprocess.run(["gh", "variable", "list", "-R", REPO, "--json", "name"], capture_output=True, check=False)
    if result.returncode or variables.returncode:
        raise Hold("GitHub protected input inventory failed")
    installed = {row["name"] for row in json.loads(result.stdout)}
    vars_installed = {row["name"] for row in json.loads(variables.stdout)}
    if any(name in installed for name in SECRET_NAMES) or PUBLIC_NAME in vars_installed:
        raise Hold("Buzz release inputs already or partially installed; reconcile metadata before continuing")
    values = {name: store.require(name) for name in (*SECRET_NAMES, PUBLIC_NAME)}
    for name in SECRET_NAMES:
        result = subprocess.run(["gh", "secret", "set", name, "-R", REPO], input=values[name].encode(), capture_output=True, check=False)
        if result.returncode:
            raise Hold("GitHub secret installation failed at " + name + "; output withheld; reconcile before retry")
    # gh variable set reads stdin when --body is omitted, just like secret set.
    result = subprocess.run(["gh", "variable", "set", PUBLIC_NAME, "-R", REPO], input=values[PUBLIC_NAME].encode(), capture_output=True, check=False)
    if result.returncode:
        raise Hold("GitHub public key variable installation failed; reconcile before retry")
    return {"repository": REPO, "installed_secret_names": list(SECRET_NAMES), "installed_public_variable": PUBLIC_NAME}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("developer-id-key", "updater-key", "assemble-p12", "install-github"))
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--tauri-cli", type=Path)
    parser.add_argument("--certificate", type=Path)
    parser.add_argument("--intermediate", type=Path)
    parser.add_argument("--apple-root", type=Path)
    args = parser.parse_args()
    if not args.execute:
        print(json.dumps({"dry_run": True, "command": args.command, "store": str(STORE), "repository": REPO, "remote_mutation": args.command == "install-github"}))
        return
    with Store() as store:
        if args.command == "developer-id-key":
            result = developer_id_key(store, args.out)
        elif args.command == "updater-key":
            result = updater_key(store, args.tauri_cli, args.out)
        elif args.command == "assemble-p12":
            result = assemble_p12(store, args.certificate, args.intermediate, args.apple_root)
        else:
            result = github_install(store)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Hold as error:
        print("HOLD: " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("HOLD: Store operation failed; private details withheld", file=sys.stderr)
        sys.exit(1)
