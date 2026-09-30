#!/usr/bin/env python3
"""Public-only actual-Worker issuer lookup, with owned, restorative cleanup."""
from __future__ import annotations

import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile

MAGIC = "vogel-vault-public-keychain-v1"
FIXTURES = Path("/tmp/vv-public-chain-rca-20260930")
G3 = "dcf21878c77f4198e4b4614f03d696d89c66c66008d4244e1b99161aac91601f"
EXPECTED = {
    "ios48-cert0": "dd78e110d3212eea29756a150f1b2d5d83b39e96f32a68a48e6da88eadfb0d46",
    "ios48-cert1": G3,
    "mac47-certs/certificate0.der": "cd21452e3a8ce18f7100801766e465335b1accd125809401f9f756f0aebd6c1d",
}


class ProbeError(Exception):
    """Deliberately contains only a step name, never command arguments."""


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def run_security(args):
    try:
        return subprocess.run(["/usr/bin/security", *args], capture_output=True,
                              text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        raise ProbeError("security-command-unavailable") from None


def checked(run, args, step):
    result = run(args)
    if result.returncode:
        raise ProbeError(step)
    return result


def snapshot(run):
    state = {}
    for domain in ("user", "dynamic"):
        result = checked(run, ["list-keychains", "-d", domain], "read-search-list")
        state[domain] = shlex.split(result.stdout)
    result = run(["default-keychain", "-d", "user"])
    if result.returncode == 0:
        paths = shlex.split(result.stdout)
        if len(paths) != 1:
            raise ProbeError("malformed-default-keychain")
        state["default"] = paths
    elif result.returncode == 1 and "a default keychain could not be found" in result.stderr.lower():
        state["default"] = []
    else:
        raise ProbeError("read-default-keychain")
    return state


def owned_file(path):
    return path.is_file() and not path.is_symlink() and path.stat().st_uid == os.getuid()


def cleanup(root, run=run_security):
    if not root.exists() and not root.is_symlink():
        return {"owned_fixture_absent": True}
    if root.is_symlink() or not root.is_dir() or root.stat().st_uid != os.getuid():
        raise ProbeError("unsafe-cleanup-root")
    marker = root / "owner"
    if not owned_file(marker) or marker.read_text() != MAGIC:
        raise ProbeError("unowned-cleanup-root")
    state_path = root / "original-state.json"
    if not owned_file(state_path):
        # State is saved before any security mutation. Never guess it later.
        if set(p.name for p in root.iterdir()) != {"owner"}:
            raise ProbeError("unexpected-incomplete-root")
        shutil.rmtree(root)
        return {"no_security_mutation": True, "owned_fixture_absent": True}
    saved = json.loads(state_path.read_text())
    if not isinstance(saved, dict) or set(saved) != {"state", "temporary_root"} or not isinstance(saved["temporary_root"], str):
        raise ProbeError("malformed-cleanup-state")
    temporary_root = Path(saved["temporary_root"])
    if not temporary_root.is_absolute() or temporary_root.name != root.name or temporary_root == root:
        raise ProbeError("unsafe-temporary-root-record")
    state = saved["state"]
    if not isinstance(state, dict) or set(state) != {"user", "dynamic", "default"} or any(
        not isinstance(v, list) or not all(isinstance(p, str) and p.startswith("/") for p in v)
        for v in state.values()
    ) or len(state["default"]) > 1:
        raise ProbeError("malformed-cleanup-state")
    keychain = temporary_root / "public-only.keychain-db"
    if temporary_root.exists() or temporary_root.is_symlink():
        temporary_marker = temporary_root / "owner"
        if temporary_root.is_symlink() or not temporary_root.is_dir() or (
            temporary_root.stat().st_uid != os.getuid()) or not owned_file(temporary_marker) or (
            temporary_marker.read_text() != MAGIC):
            raise ProbeError("unowned-temporary-root")
        if keychain.is_symlink() or (keychain.exists() and not owned_file(keychain)):
            raise ProbeError("unsafe-fixture-keychain")
    checked(run, ["list-keychains", "-d", "user", "-s", *state["user"]], "restore-search-list")
    if keychain.exists():
        checked(run, ["delete-keychain", str(keychain)], "delete-public-keychain")
    restored = snapshot(run)
    if restored != state or keychain.exists() or keychain.is_symlink():
        # Keep the original state/marker for the always() recovery step.
        raise ProbeError("cleanup-state-mismatch")
    if temporary_root.exists():
        shutil.rmtree(temporary_root)
    shutil.rmtree(root)
    return {"search_list_restored": True, "dynamic_unchanged": True,
            "default_unchanged": True, "owned_fixture_absent": True,
            "state_sha256": digest(restored)}


def find_g3(run, keychain=None):
    args = ["find-certificate", "-a", "-c",
            "Apple Worldwide Developer Relations Certification Authority", "-Z"]
    if keychain is not None:
        args.append(str(keychain))
    result = run(args)
    hashes = re.findall(r"SHA-256 hash:\s*([0-9A-Fa-f]{64})", result.stdout)
    return {"exit_code": result.returncode, "g3_found": G3 in [h.lower() for h in hashes],
            "certificate_count": len(hashes)}


def verify_leaf(run, name, policy, keychain=None, fixtures=FIXTURES, intermediate=None):
    args = ["verify-cert", "-L", "-p", policy, "-c", str(fixtures / name)]
    if intermediate is not None:
        args += ["-c", str(fixtures / intermediate)]
    if keychain is not None:
        args += ["-k", str(keychain)]
    result = run(args)
    # Some unsupported policies print an error but still exit zero.
    diagnostic = result.stdout + "\n" + result.stderr
    policy_valid = "policy creation failed" not in diagnostic.lower()
    return {"exit_code": result.returncode, "policy": policy,
            "policy_valid": policy_valid,
            "passed": result.returncode == 0 and policy_valid,
            # This command accepts hash-pinned public certificates only. Keep
            # both streams: security can report validation failures on stdout.
            "public_validation_message": diagnostic.strip()[:4096],
            "stderr_classes": [label for text, label in (
                ("unable to build chain", "missing-chain"),
                ("not trusted", "untrusted"), ("no error", "nonzero-no-error-text"),
                ("policy creation failed", "unsupported-policy"),
                ("errsecinternalcomponent", "errSecInternalComponent"))
                if text in diagnostic.lower() and (label != "nonzero-no-error-text" or result.returncode != 0)]}


def certificate_probe(fixtures, run=run_security):
    """Read-only chain comparison: no keychain or security-state operations."""
    result = {"observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "uid": os.getuid(), "public_only": True, "private_keys": False,
              "trust_overrides": False, "security_state_changes": False, "checks": {}}
    with tempfile.TemporaryDirectory(prefix="vogel-vault-public-certificates-") as directory:
        root = Path(directory)
        for name, data in fixtures.items():
            path = root / name
            path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o600)
        for label, name, policy in (("ios", "ios48-cert0", "codeSign"),
                                    ("installer", "mac47-certs/certificate0.der", "basic")):
            for chain, issuer in (("leaf", None), ("supplied_g3", "ios48-cert1")):
                result["checks"][label + "_" + chain] = verify_leaf(
                    run, name, policy, fixtures=root, intermediate=issuer)
    result["owned_public_copies_removed"] = True
    return result


def probe(root, temporary_root, fixtures, run=run_security):
    result = {"observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "pid": os.getpid(), "ppid": os.getppid(), "uid": os.getuid(),
              "public_only": True, "private_keys": False, "trust_overrides": False,
              "checks": {}, "test_completed": False}
    state = snapshot(run)
    root.mkdir(mode=0o700)
    (root / "owner").write_text(MAGIC)
    (root / "owner").chmod(0o600)
    try:
        state_path = root / "original-state.json"
        fd = os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump({"state": state, "temporary_root": str(temporary_root)}, out)
        # Read the already hash-verified bytes only once; use owned copies.
        for name, data in fixtures.items():
            path = root / "fixtures" / name
            path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o600)
        result["before_state_sha256"] = digest(state)
        result["before_search_counts"] = {k: len(state[k]) for k in ("user", "dynamic")}
        result["before_default_present"] = bool(state["default"])
        result["before_default_g3"] = find_g3(run)
        temporary_root.mkdir(mode=0o700)
        (temporary_root / "owner").write_text(MAGIC)
        (temporary_root / "owner").chmod(0o600)
        keychain = temporary_root / "public-only.keychain-db"
        password = secrets.token_urlsafe(24)
        checked(run, ["create-keychain", "-p", password, str(keychain)], "create-public-keychain")
        checked(run, ["set-keychain-settings", "-lut", "3600", str(keychain)], "keychain-settings")
        checked(run, ["unlock-keychain", "-p", password, str(keychain)], "unlock-public-keychain")
        checked(run, ["import", str(root / "fixtures/ios48-cert1"), "-k", str(keychain), "-t", "cert"], "import-public-g3")
        del password
        result["explicit_g3"] = find_g3(run, keychain)
        if not result["explicit_g3"]["g3_found"] or result["explicit_g3"]["certificate_count"] != 1:
            raise ProbeError("public-g3-store-mismatch")
        if snapshot(run)["default"] != state["default"]:
            raise ProbeError("unexpected-default-change")
        checked(run, ["list-keychains", "-d", "user", "-s", str(keychain), *state["user"]], "prepend-public-keychain")
        after = snapshot(run)
        result["search_list_readback_matches"] = after["user"] == [str(keychain), *state["user"]]
        result["dynamic_unchanged"] = after["dynamic"] == state["dynamic"]
        result["default_unchanged"] = after["default"] == state["default"]
        result["implicit_g3"] = find_g3(run)
        for label, name, policy in (("ios", "ios48-cert0", "codeSign"),
                                    ("installer", "mac47-certs/certificate0.der", "basic")):
            for lookup, path in (("implicit", None), ("explicit", keychain)):
                result["checks"][label + "_" + lookup] = verify_leaf(run, name, policy, path, root / "fixtures")
        result["test_completed"] = all((result["search_list_readback_matches"],
                                         result["dynamic_unchanged"], result["default_unchanged"]))
    except (ProbeError, OSError, ValueError) as error:
        result["error_class"] = type(error).__name__
        if isinstance(error, ProbeError):
            result["failed_step"] = str(error)
    finally:
        try:
            result["cleanup"] = cleanup(root, run)
        except (ProbeError, OSError, ValueError) as error:
            result["cleanup"] = {"failed": True, "error_class": type(error).__name__}
            if isinstance(error, ProbeError):
                result["cleanup"]["failed_step"] = str(error)
    return result


def location_paths(root, temp, standard):
    return [(label, root.with_name(root.name + "-" + label), directory / (root.name + "-" + label))
            for label, directory in (("runner-temp", temp), ("standard", standard))]


def location_probe(root, temp, standard, fixtures, run=run_security):
    """Compare public stores sequentially; each phase must restore before next."""
    paths = location_paths(root, temp, standard)
    if any(path.exists() or path.is_symlink() for _, recovery, store in paths
           for path in (recovery, store)):
        raise ProbeError("location-fixture-already-exists")
    before = snapshot(run)
    result = {"public_only": True, "private_keys": False, "trust_overrides": False,
              "before_state_sha256": digest(before), "locations": {}, "test_completed": False}
    for label, recovery, store in paths:
        phase = probe(recovery, store, fixtures, run)
        result["locations"][label] = phase
        if not phase["test_completed"] or phase.get("cleanup", {}).get("failed"):
            # Never start a second mutation while rollback needs recovery.
            return result
        if snapshot(run) != before:
            raise ProbeError("between-location-state-mismatch")
    result["final_state_sha256"] = digest(snapshot(run))
    result["test_completed"] = result["final_state_sha256"] == result["before_state_sha256"]
    return result


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in (
        "probe", "cleanup", "certificates", "locations", "locations-cleanup"):
        raise ProbeError("invalid-mode")
    if os.environ.get("RUNNER_NAME") != "macbook-pro-m5-ghrunner" or (
        os.getuid(), os.geteuid(), os.getgid()) != (502, 502, 502):
        raise ProbeError("wrong-runner")
    if sys.argv[1] == "certificates":
        fixtures = {}
        for name, expected in EXPECTED.items():
            path = FIXTURES / name
            data = path.read_bytes()
            if path.is_symlink() or hashlib.sha256(data).hexdigest() != expected:
                raise ProbeError("public-fixture-hash-mismatch")
            fixtures[name] = data
        print(json.dumps({"public_certificate_result": certificate_probe(fixtures)}, indent=2))
        return 0  # A recorded trust failure is diagnostic data, not job failure.
    run_id, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if not run_id.isdigit() or not attempt.isdigit():
        raise ProbeError("invalid-run-id")
    temp = Path(os.environ["RUNNER_TEMP"])
    if not temp.is_absolute() or temp.is_symlink() or not temp.is_dir():
        raise ProbeError("unsafe-runner-temp")
    home = Path(os.environ["HOME"])
    if not home.is_absolute() or home.is_symlink() or home.stat().st_uid != os.getuid():
        raise ProbeError("unsafe-home")
    recovery = home / ".local/state/vogel-vault-public-keychain"
    for path in (home / ".local", home / ".local/state", recovery):
        if path.is_symlink():
            raise ProbeError("unsafe-recovery-parent")
        path.mkdir(mode=0o700, exist_ok=True)
        if not path.is_dir() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o022:
            raise ProbeError("unsafe-recovery-parent")
    name = "vogel-vault-public-keychain-" + run_id + "-" + attempt
    root, temporary_root = recovery / name, temp / name
    if sys.argv[1] in ("locations", "locations-cleanup"):
        # Use only existing, runner-owned, non-writable standard parents.
        # The fixture is a unique 0700 child, never login/System/default.
        standard = home / "Library/Keychains"
        for parent in (home / "Library", standard):
            if parent.is_symlink() or not parent.is_dir() or (
                parent.stat().st_uid != os.getuid() or parent.stat().st_mode & 0o022):
                raise ProbeError("unsafe-standard-keychain-parent")
        if sys.argv[1] == "locations-cleanup":
            print(json.dumps({"public_locations_cleanup": {
                label: cleanup(owned) for label, owned, _ in location_paths(root, temp, standard)
            }}, indent=2))
            return 0
    if sys.argv[1] == "cleanup":
        print(json.dumps({"public_keychain_cleanup": cleanup(root)}, indent=2))
        return 0
    if root.exists() or root.is_symlink() or temporary_root.exists() or temporary_root.is_symlink():
        raise ProbeError("fixture-already-exists")
    # A new run must never supersede unfinished rollback state from an old one.
    if any(recovery.iterdir()):
        raise ProbeError("prior-recovery-pending")
    fixtures = {}
    for name, expected in EXPECTED.items():
        path = FIXTURES / name
        data = path.read_bytes()
        if path.is_symlink() or hashlib.sha256(data).hexdigest() != expected:
            raise ProbeError("public-fixture-hash-mismatch")
        fixtures[name] = data
    def stop(signum, frame):
        raise ProbeError("process-terminated")
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if sys.argv[1] == "locations":
        result = location_probe(root, temp, standard, fixtures)
        print(json.dumps({"public_locations_result": result}, indent=2))
    else:
        result = probe(root, temporary_root, fixtures)
        print(json.dumps({"public_keychain_result": result}, indent=2))
    return 0 if result["test_completed"] and not result.get("cleanup", {}).get("failed") else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ProbeError, OSError, ValueError, KeyError) as error:
        print(json.dumps({"public_keychain_error": type(error).__name__,
                          "step": str(error) if isinstance(error, ProbeError) else "unavailable"}))
        sys.exit(1)
