#!/usr/bin/env python3
"""Buzz's inert artifact boundary and trusted Mac signing driver.

No source or artifact-provided program executes in this process. Apple and Tauri
commands are trusted host tools. Command failures never render secret argv/input.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tarfile

TEAM = "384ZGKG4GB"
ENDPOINT = "https://github.com/only21mil/buzz/releases/download/buzz-desktop-latest/latest.json"
SCRIPT = Path(__file__).resolve().parent
ENTITLEMENTS = {
    "com.apple.security.device.audio-input": True,
    "com.apple.security.device.camera": True,
    "com.apple.security.cs.disable-library-validation": True,
}
SECRET_NAMES = (
    "BUZZ_DEVELOPER_ID_P12_B64", "BUZZ_DEVELOPER_ID_P12_PASSWORD",
    "BUZZ_TAURI_SIGNING_PRIVATE_KEY", "ASC_API_KEY_P8", "ASC_KEY_ID", "ASC_ISSUER_ID",
)
MACHO = {bytes.fromhex(x) for x in ("feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca")}


def require(ok: bool, message: str) -> None:
    if not ok:
        raise ValueError(message)


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def record(path: Path) -> dict:
    require(path.is_file() and not path.is_symlink(), "receipt is not a regular file")
    return {"name": path.name, "sha256": sha(path), "size": path.stat().st_size}


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def public_key() -> tuple[str, str]:
    encoded = os.environ.get("BUZZ_UPDATER_PUBLIC_KEY", "").strip()
    decoded = base64.b64decode(encoded, validate=True)
    lines = decoded.decode("ascii").splitlines()
    require(len(lines) == 2 and lines[0].startswith("untrusted comment:"), "invalid updater public key text")
    packet = base64.b64decode(lines[1], validate=True)
    require(len(packet) == 42 and packet[:2] == b"Ed", "invalid updater public key packet")
    require(os.environ.get("BUZZ_UPDATER_ENDPOINT") == ENDPOINT, "wrong updater endpoint")
    return encoded, hashlib.sha256(decoded).hexdigest()


def inputs(args: argparse.Namespace) -> None:
    require(re.fullmatch(r"[0-9a-f]{40}", args.source) is not None, "source must be an immutable lowercase SHA")
    require(re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?", args.version) is not None, "invalid version")
    require(args.arch in ("aarch64", "x86_64"), "unsupported architecture")
    public_key()


def clean_env(extra: dict | None = None) -> dict:
    # Do not inherit DYLD_*, PYTHONPATH, NODE_OPTIONS, npm hooks or credentials.
    env = {k: os.environ[k] for k in ("HOME", "PATH", "TMPDIR", "DEVELOPER_DIR", "LANG") if k in os.environ}
    env.update(extra or {})
    return env


PHASES = {
    "create-keychain": "keychain-create", "set-keychain-settings": "keychain-settings",
    "unlock-keychain": "keychain-unlock", "import": "pkcs12-import",
    "set-key-partition-list": "keychain-partitions", "find-identity": "keychain-identities",
    "delete-keychain": "keychain-delete",
    "codesign": "codesign", "lipo": "architecture-check", "openssl": "certificate-check",
    "ditto": "app-copy-or-zip", "hdiutil": "dmg-create", "tar": "updater-archive",
    "node": "updater-sign", "bash": "entitlements-check", "spctl": "gatekeeper-check",
    "xcrun": "apple-tool",
}


def command_phase(argv: list[str]) -> str:
    tool = Path(argv[0]).name
    key = argv[1] if tool == "security" and len(argv) > 1 else tool
    return PHASES.get(key, "trusted-command")


def phase_event(phase: str, status: str, result=None) -> None:
    # Only constants and integer process metadata. Never argv, stdin, tool text,
    # exception messages, credential values, identity names or filesystem paths.
    require(phase in set(PHASES.values()) | {"trusted-command"}, "unknown public phase")
    require(status in ("started", "passed", "failed"), "unknown public status")
    data = {"schema": "buzz-macos-sign-phase-v1", "phase": phase, "status": status}
    if result is not None:
        data.update(exit_code=int(result.returncode), stdout_bytes=len(result.stdout), stderr_bytes=len(result.stderr))
    print(json.dumps(data, sort_keys=True), flush=True)


def run(argv: list[str], *, output: Path | None = None, input_data: bytes | None = None,
        extra: dict | None = None, confidential: bool = False, phase: str | None = None) -> bytes:
    require(not (confidential and output is not None), "confidential output cannot be retained")
    phase = phase or command_phase(argv)
    phase_event(phase, "started")
    result = subprocess.run(argv, input=input_data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=clean_env(extra), check=False)
    phase_event(phase, "passed" if result.returncode == 0 else "failed", result)
    if output is not None:
        output.write_bytes(result.stdout + result.stderr + (b"\nPASS\n" if result.returncode == 0 else b"\nFAIL\n"))
    if result.returncode:
        # No subprocess exception or command/input interpolation: security -i may
        # echo its input, which must never reach logs or a retained receipt.
        raise RuntimeError("trusted signing command failed" if confidential else f"{Path(argv[0]).name} failed; exit {result.returncode}")
    return result.stdout


def safe_members(tf: tarfile.TarFile) -> list[tarfile.TarInfo]:
    members = tf.getmembers()
    require(0 < len(members) < 100000, "invalid archive member count")
    total = 0
    seen: set[str] = set()
    links: set[str] = set()
    for member in members:
        name = member.name.rstrip("/")
        path = PurePosixPath(name)
        require(name not in seen, "duplicate archive member")
        seen.add(name)
        require(not path.is_absolute() and path.parts and path.parts[0] == "Buzz.app"
                and all(p not in ("..", ".") for p in path.parts)
                and "\\" not in name and all(ord(c) >= 32 for c in name), "unsafe archive path")
        require(member.isfile() or member.isdir() or member.issym(), "unsupported archive member")
        require(not member.mode & 0o7000, "privileged archive mode")
        total += member.size
        if member.issym():
            target = PurePosixPath(member.linkname)
            require(not target.is_absolute() and "\\" not in member.linkname, "absolute symlink")
            stack = list(path.parent.parts)
            for part in target.parts:
                if part == "..":
                    require(len(stack) > 1, "escaping symlink")
                    stack.pop()
                elif part != ".":
                    stack.append(part)
            require(stack and stack[0] == "Buzz.app", "escaping symlink")
            links.add(name)
    require(total < 12 * 1024**3, "archive exceeds extraction limit")
    for name in seen:
        require(not any(str(parent) in links for parent in PurePosixPath(name).parents), "archive writes through symlink")
    return members


def extract(archive: Path, destination: Path) -> Path:
    require(not destination.exists(), "extraction destination already exists")
    with tarfile.open(archive, "r:gz") as tf:
        members = safe_members(tf)
        destination.mkdir(mode=0o700)
        # Files precede links, so the archive cannot redirect any write.
        for member in sorted(members, key=lambda m: (m.issym(), len(PurePosixPath(m.name).parts))):
            target = destination / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(exist_ok=True)
            elif member.issym():
                target.symlink_to(member.linkname)
            else:
                stream = tf.extractfile(member)
                require(stream is not None, "missing archive stream")
                with target.open("xb") as out:
                    shutil.copyfileobj(stream, out)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
        root = destination.resolve()
        for member in members:
            require((destination/member.name).resolve().is_relative_to(root/"Buzz.app"), "resolved symlink escapes app")
        # The enclosing extraction/secret directories stay private. Published
        # bundle directories, including implicit parents, must be traversable.
        app = destination / "Buzz.app"
        for directory in [app, *app.rglob("*")]:
            if directory.is_dir() and not directory.is_symlink():
                directory.chmod(0o755)
    return destination / "Buzz.app"


def app_info(app: Path, version: str) -> dict:
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    require(info.get("CFBundleShortVersionString") == version, "bundle version differs")
    require(info.get("CFBundleIdentifier") == "xyz.block.buzz.app", "bundle identifier differs")
    executable = info.get("CFBundleExecutable", "")
    require(re.fullmatch(r"[A-Za-z0-9_-]+", executable) is not None, "unsafe executable name")
    require((app / "Contents/MacOS" / executable).is_file(), "missing main executable")
    return info


def pack(args: argparse.Namespace) -> None:
    inputs(args)
    app_info(args.app, args.version)
    args.output.mkdir(mode=0o700)
    archive = args.output / f"unsigned-{args.arch}.app.tar.gz"
    with tarfile.open(archive, "w:gz", dereference=False) as tf:
        tf.add(args.app, arcname="Buzz.app")
    with tarfile.open(archive, "r:gz") as tf:
        safe_members(tf)
    key, fingerprint = public_key()
    config = json.loads(Path("desktop/src-tauri/tauri.release.conf.json").read_text())
    require(config["plugins"]["updater"] == {"pubkey": key, "endpoints": [ENDPOINT]}, "build updater config differs")
    # Verifier is reviewed and executed from Budget on the signing host.
    verifier = Path("desktop/scripts/verify-macos-entitlements.sh")
    require(sha(verifier) == sha(SCRIPT / "buzz-verify-macos-entitlements.sh"), "source entitlement verifier changed; review and update trusted copy")
    write_json(args.output / f"build-{args.arch}.json", {
        "schema": "buzz-macos-build-v1", "source": args.source,
        "version": args.version, "arch": args.arch, "target": f"{args.arch}-apple-darwin",
        "archive": record(archive), "updater_public_key_sha256": fingerprint,
        "updater_endpoint": ENDPOINT, "release_config_sha256": sha(Path("desktop/src-tauri/tauri.release.conf.json")),
        "entitlements_verifier_sha256": sha(verifier), "run_id": os.environ["GITHUB_RUN_ID"],
        "run_attempt": os.environ["GITHUB_RUN_ATTEMPT"], "workflow_sha": os.environ["GITHUB_SHA"],
        "features": ["mesh-llm"] if args.arch == "aarch64" else [],
    })


def paths(arch: str) -> tuple[Path, Path]:
    run_id, attempt = os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"]
    require(run_id.isdigit() and attempt.isdigit() and arch in ("aarch64", "x86_64"), "unsafe run identity")
    # Mac ephemeral signing material follows the proven protected Apple route.
    root = Path(os.environ["RUNNER_TEMP"]) / f"buzz-macos-signing-{run_id}-{attempt}-{arch}"
    return root, Path.cwd() / "signed"


def check_build(args: argparse.Namespace) -> tuple[Path, dict]:
    inputs(args)
    require(args.source == "d9abae67a7d9dfab3d693e968477561456694898" and args.version == "0.5.20", "recovery source differs")
    archive = args.input / f"unsigned-{args.arch}.app.tar.gz"
    receipt_path = args.input / f"build-{args.arch}.json"
    require(not args.input.is_symlink() and not receipt_path.is_symlink(), "unsafe input path")
    receipt = json.loads(receipt_path.read_text())
    expected = {"schema": "buzz-macos-build-v1", "source": args.source, "version": args.version,
                "arch": args.arch, "target": f"{args.arch}-apple-darwin", "archive": record(archive),
                "updater_public_key_sha256": public_key()[1], "updater_endpoint": ENDPOINT,
                "run_id": "34223564212", "run_attempt": "1",
                "workflow_sha": "dca2a86e4a874ab0421d1067b57bca4b4279ca51",
                "entitlements_verifier_sha256": sha(SCRIPT/"buzz-verify-macos-entitlements.sh")}
    require(all(receipt.get(k) == v for k, v in expected.items()), "unsigned build receipt binding differs")
    return archive, receipt


def prepare(args: argparse.Namespace) -> None:
    archive, _ = check_build(args)
    root, output = paths(args.arch)
    require(not root.exists() and not output.exists(), "stale release directory; inspect and clean before retry")
    root.mkdir(mode=0o700)
    app = extract(archive, root / "extracted")
    app_info(app, args.version)
    output.mkdir(mode=0o700)
    record(Path(f"recovery-download-{args.arch}.json"))
    shutil.copyfile(f"recovery-download-{args.arch}.json", output/f"recovery-download-{args.arch}.json")


def security_command(words: list[str]) -> bytes:
    # security's interactive command lexer accepts quoted strings; passwords are
    # URL-safe ASCII by bootstrap contract. No secret ever becomes an OS argv.
    require(all("\n" not in w and "\r" not in w and "\x00" not in w for w in words), "invalid security command token")
    command = " ".join('"' + w.replace("\\", "\\\\").replace('"', '\\"') + '"' for w in words)
    return run(["/usr/bin/security", "-i"], input_data=(command + "\n").encode(), confidential=True, phase=PHASES[words[0]])


def cleanup(arch: str) -> None:
    root, _ = paths(arch)
    if not root.exists():
        return
    require(not root.is_symlink() and root.is_dir(), "unsafe cleanup root")
    errors = []
    keychain = root / "signing.keychain-db"
    if keychain.exists():
        try:
            run(["/usr/bin/security", "delete-keychain", str(keychain)])
        except RuntimeError:
            errors.append("could not delete temporary keychain")
    # Remove raw private material even if the temporary keychain cannot be deleted.
    for filename in ("developer-id.p12", "AuthKey.p8", "updater.key"):
        (root/filename).unlink(missing_ok=True)
    require(not errors, "; ".join(errors))
    shutil.rmtree(root)


def notary_diagnostics(result: subprocess.CompletedProcess) -> dict:
    # Never retain arbitrary tool text: errors can echo auth argv or key bytes.
    # Allowlisted causes preserve useful stderr diagnostics without relying on
    # an exhaustive secret/encoding denylist. Bound both scanning and output.
    limit = 65536
    text = (result.stdout[:limit] + b"\n" + result.stderr[:limit]).decode("utf-8", errors="replace").lower()
    causes = []
    for pattern, cause in (
        (r"\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid credentials|authentication|unauthenticated", "Authentication or authorization failed; check the approved ASC credential route and notarization access."),
        (r"timed? out|timeout|time out", "Notarization request or wait timed out; check submission status before retrying."),
        (r"network|internet|connect|dns|resolve host|offline|tls|ssl", "Network, name resolution, or TLS failure; check signing-host connectivity."),
        (r"\b(?:429|500|502|503|504)\b|rate limit|service unavailable", "Apple service unavailable or rate limited; check service status before retrying."),
        (r"unknown (?:option|argument)|unexpected argument|usage:|missing required|invalid value", "notarytool rejected the invocation; check the installed tool and required input format."),
        (r"invalid|rejected", "Submission or input rejected; inspect any retained notarization log."),
    ):
        if re.search(pattern, text):
            causes.append(cause)
    return {"exit_code": result.returncode, "stdout_bytes": len(result.stdout),
            "stderr_bytes": len(result.stderr),
            "scan_truncated": len(result.stdout) > limit or len(result.stderr) > limit,
            "causes": causes or ["No recognized public diagnostic; inspect the submission status and approved host/tool configuration."]}


def notarize(path: Path, kind: str, arch: str, output: Path, notary_auth: list[str]) -> dict:
    submission = output/f"{arch}-notary-{kind}-submission.json"
    log = output/f"{arch}-notary-{kind}-log.json"
    result = subprocess.run(["/usr/bin/xcrun", "notarytool", "submit", str(path), *notary_auth, "--wait", "--timeout", "45m", "--output-format", "json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=clean_env())
    write_json(output/f"{arch}-notary-{kind}-diagnostics.json", notary_diagnostics(result))
    data = json.loads(result.stdout)
    require(isinstance(data, dict), "notarization returned no object")
    require(re.fullmatch(r"[0-9a-fA-F-]{36}", data.get("id", "")) is not None, "notarization returned no submission ID")
    require(data.get("status") in ("Accepted", "Invalid", "In Progress", "Rejected"), "unknown notarization status")
    # Keep only public receipt fields; error messages may contain input values.
    write_json(submission, {"id": data["id"], "status": data["status"]})
    run(["/usr/bin/xcrun", "notarytool", "log", data["id"], *notary_auth, str(log)])
    report = json.loads(log.read_text())
    require(result.returncode == 0 and data["status"] == "Accepted" and report.get("status") == "Accepted", "notarization not Accepted; retained diagnostic JSON")
    return {"id": data["id"], "status": "Accepted", "submission": record(submission), "log": record(log)}


def sign(args: argparse.Namespace) -> None:
    archive, receipt = check_build(args)
    root, output = paths(args.arch)
    require(root.is_dir() and not root.is_symlink() and output.is_dir(), "prepare must pass first")
    app = root / "extracted/Buzz.app"
    app_info(app, args.version)
    private = {k: os.environ.pop(k, "") for k in SECRET_NAMES}
    require(all(private.values()), "missing protected Apple or updater credential")
    require(re.fullmatch(r"[A-Za-z0-9_-]{32,128}", private["BUZZ_DEVELOPER_ID_P12_PASSWORD"]) is not None, "p12 password violates bootstrap contract")
    require(re.fullmatch(r"[A-Z0-9]{10}", private["ASC_KEY_ID"]) is not None, "invalid ASC key ID")
    require(re.fullmatch(r"[0-9a-fA-F-]{36}", private["ASC_ISSUER_ID"]) is not None, "invalid ASC issuer")
    keychain = root / "signing.keychain-db"
    password = secrets.token_urlsafe(36)
    for filename, data in (("developer-id.p12", base64.b64decode(private["BUZZ_DEVELOPER_ID_P12_B64"], validate=True)),
                           ("updater.key", private["BUZZ_TAURI_SIGNING_PRIVATE_KEY"].encode())):
        (root/filename).write_bytes(data)
        (root/filename).chmod(0o600)
    asc = private["ASC_API_KEY_P8"].strip().encode()
    if not asc.startswith(b"-----BEGIN PRIVATE KEY-----"):
        asc = base64.b64decode(asc, validate=True)
    require(asc.startswith(b"-----BEGIN PRIVATE KEY-----"), "ASC key format invalid")
    (root/"AuthKey.p8").write_bytes(asc)
    (root/"AuthKey.p8").chmod(0o600)
    security_command(["create-keychain", "-p", password, str(keychain)])
    run(["/usr/bin/security", "set-keychain-settings", "-lut", "7200", str(keychain)])
    security_command(["unlock-keychain", "-p", password, str(keychain)])
    security_command(["import", str(root/"developer-id.p12"), "-k", str(keychain), "-P", private["BUZZ_DEVELOPER_ID_P12_PASSWORD"], "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"])
    security_command(["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, str(keychain)])
    identities = run(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning", str(keychain)]).decode()
    found = re.findall(r'\b([0-9A-F]{40}) "(Developer ID Application: [^"\n]+ \(' + TEAM + r'\))"', identities)
    require(len(found) == 1, "expected one valid Developer ID Application identity on approved team")
    identity, name = found[0]
    entitlements = root/"entitlements.plist"
    entitlements.write_bytes(plistlib.dumps(ENTITLEMENTS))
    macho = []
    for path in app.rglob("*"):
        if path.is_file() and not path.is_symlink():
            with path.open("rb") as f:
                if f.read(4) in MACHO:
                    macho.append(path)
    require(macho, "app contains no Mach-O code")
    for path in macho:
        arches = run(["/usr/bin/lipo", "-archs", str(path)]).decode().split()
        require(("arm64" if args.arch == "aarch64" else "x86_64") in arches, "nested code lacks target architecture")
    targets = macho + [p for p in app.rglob("*") if p.is_dir() and not p.is_symlink() and p.suffix in (".framework", ".xpc", ".app", ".bundle")]
    for path in sorted(set(targets), key=lambda p: len(p.parts), reverse=True) + [app]:
        run(["/usr/bin/codesign", "--force", "--sign", identity, "--keychain", str(keychain), "--timestamp", "--options", "runtime", "--entitlements", str(entitlements), str(path)])
    cert_prefix = str(root/"certificate-")
    run(["/usr/bin/codesign", "--display", "--extract-certificates", cert_prefix, str(app)])
    cert_hash = sha(Path(cert_prefix+"0"))
    cert_info = run(["/usr/bin/openssl", "x509", "-inform", "DER", "-in", cert_prefix+"0", "-noout", "-subject"]).decode()
    require(TEAM in cert_info and "Developer ID Application:" in cert_info, "signed certificate identity differs")
    notary_auth = ["--key", str(root/"AuthKey.p8"), "--key-id", private["ASC_KEY_ID"], "--issuer", private["ASC_ISSUER_ID"]]
    # ASC identifiers are not key material; key bytes remain in a private file.
    app_zip = root/"Buzz.app.zip"
    run(["/usr/bin/ditto", "-c", "-k", "--keepParent", str(app), str(app_zip)])
    app_notary = notarize(app_zip, "app", args.arch, output, notary_auth)
    verification = {}
    for label, command in (
        ("stapler_app", ["/usr/bin/xcrun", "stapler", "staple", str(app)]),
        ("codesign", ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)]),
        ("spctl", ["/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=4", str(app)]),
        ("entitlements", ["/bin/bash", str(SCRIPT/"buzz-verify-macos-entitlements.sh"), str(app)]),
    ):
        path = output/f"{args.arch}-verify-{label}.txt"
        run(command, output=path)
        if label == "stapler_app":
            run(["/usr/bin/xcrun", "stapler", "validate", str(app)], output=path)
        verification[label] = record(path)
    stem = f"Buzz_{args.version}_{args.arch}"
    dmg_root = root/"dmg-content"
    dmg_root.mkdir()
    dmg_root.chmod(0o755)
    run(["/usr/bin/ditto", str(app), str(dmg_root/"Buzz.app")])
    (dmg_root/"Applications").symlink_to("/Applications")
    dmg = output/(stem+".dmg")
    run(["/usr/bin/hdiutil", "create", "-volname", "Buzz", "-srcfolder", str(dmg_root), "-format", "UDZO", str(dmg)])
    # Sleep during Apple's wait can lock this run-scoped keychain. Re-unlock
    # immediately before the next signing operation, using confidential stdin.
    security_command(["unlock-keychain", "-p", password, str(keychain)])
    run(["/usr/bin/codesign", "--force", "--sign", identity, "--keychain", str(keychain), "--timestamp", str(dmg)])
    dmg_notary = notarize(dmg, "dmg", args.arch, output, notary_auth)
    run(["/usr/bin/xcrun", "stapler", "staple", str(dmg)])
    staple_log = output/f"{args.arch}-verify-stapler_dmg.txt"
    run(["/usr/bin/xcrun", "stapler", "validate", str(dmg)], output=staple_log)
    verification["stapler_dmg"] = record(staple_log)
    run(["/usr/bin/codesign", "--verify", "--strict", str(dmg)])
    updater = output/(stem+".app.tar.gz")
    run(["/usr/bin/tar", "-czf", str(updater), "-C", str(app.parent), "Buzz.app"])
    # Absolute locked tool, no package scripts, no source cwd/config.
    tool = SCRIPT/"buzz-macos-tools/node_modules/@tauri-apps/cli/tauri.js"
    run([shutil.which("node") or "node", str(tool), "signer", "sign", "--private-key-path", str(root/"updater.key"), str(updater)],
        extra={"TAURI_SIGNING_PRIVATE_KEY_PASSWORD": "", "CI": "true"}, confidential=True)
    signature = Path(str(updater)+".sig")
    require(signature.is_file() and signature.stat().st_size > 0, "missing updater signature")
    build_receipt = output/f"build-{args.arch}.json"
    shutil.copyfile(args.input/build_receipt.name, build_receipt)
    key, fingerprint = public_key()
    write_json(output/f"mac-release-{args.arch}.json", {
        "schema": "buzz-macos-release-recovery-v1", "source": {"repository": "only21mil/buzz", "sha": args.source},
        "version": args.version, "arch": args.arch, "target": f"{args.arch}-apple-darwin",
        "updater": {"endpoint": ENDPOINT, "public_key": key, "public_key_sha256": fingerprint},
        "signing": {"identity": name, "team_id": TEAM, "certificate_sha256": cert_hash},
        "run": {"repository": "only21mil/masons-budget", "id": os.environ["GITHUB_RUN_ID"], "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
                "url": f"https://github.com/only21mil/masons-budget/actions/runs/{os.environ['GITHUB_RUN_ID']}", "workflow_sha": os.environ["GITHUB_SHA"]},
        "assets": {"dmg": record(dmg), "archive": record(updater), "signature": record(signature)},
        "notarization": {"app": app_notary, "dmg": dmg_notary}, "verification": verification,
        "build": {"receipt": record(build_receipt), "unsigned_archive_sha256": sha(archive),
                  "recovery_download": record(output/f"recovery-download-{args.arch}.json"),
                  "repository": "only21mil/masons-budget", "run_id": receipt["run_id"],
                  "run_attempt": receipt["run_attempt"], "workflow_sha": receipt["workflow_sha"]},
    })


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "sign", "cleanup"))
    parser.add_argument("--source", default="")
    parser.add_argument("--version", default="")
    parser.add_argument("--arch", required=True, choices=("aarch64", "x86_64"))
    parser.add_argument("--app", type=Path)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.command == "cleanup":
            cleanup(args.arch)
        elif args.command == "sign":
            def interrupted(_sig, _frame):
                raise RuntimeError("signing interrupted")
            signal.signal(signal.SIGTERM, interrupted)
            try:
                sign(args)
            finally:
                cleanup(args.arch)
        else:
            globals()[args.command](args)
    except Exception as error:
        # Do not print repr/traceback: decoded secret parsers can include input.
        print(f"::error::Buzz Mac {args.command} failed ({type(error).__name__}); inspect public receipts and step status", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
