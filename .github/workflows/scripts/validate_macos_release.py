#!/usr/bin/env python3
"""Validate existing Mac App Store assets without printing signing metadata."""
import plistlib
import re
import subprocess
import sys
from pathlib import Path

TEAM = "384ZGKG4GB"
BUNDLE = "com.sats21m.masonsbudget"
INSTALLER_NAME = rf'(?:Mac Installer Distribution|3rd Party Mac Developer Installer): (?:[^"\n]+ \({TEAM}\)|{TEAM})'


def require(condition):
    if not condition:
        raise ValueError("Mac App Store validation failed")


def installer_identity(text):
    # security -v includes valid identities with private keys, not certificates alone.
    require(any(re.fullmatch(rf'\s*\d+\) [A-Fa-f0-9]{{40}} "{INSTALLER_NAME}"', line)
                for line in text.splitlines()))


def non_debug(entitlements):
    require(isinstance(entitlements, dict))
    for key in ("get-task-allow", "com.apple.security.get-task-allow"):
        require(key not in entitlements or entitlements[key] is False)


def profile(data):
    require(isinstance(data, dict))
    require(isinstance(data.get("UUID"), str) and re.fullmatch(
        r"[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}", data["UUID"]))
    require(data.get("TeamIdentifier") == [TEAM] and data.get("Platform") == ["OSX"])
    entitlements = data.get("Entitlements")
    non_debug(entitlements)
    require(entitlements.get("com.apple.application-identifier") == f"{TEAM}.{BUNDLE}")


def signed_entitlements(data):
    non_debug(data)
    require(data.get("com.apple.application-identifier") == f"{TEAM}.{BUNDLE}")
    require(data.get("com.apple.developer.team-identifier") == TEAM)


def checked(argv):
    result = subprocess.run(argv, capture_output=True)
    require(result.returncode == 0)
    return result.stdout


def package(export_dir, release_root):
    packages = list(Path(export_dir).glob("*.pkg"))
    require(len(packages) == 1 and packages[0].is_file() and not packages[0].is_symlink())
    signature = checked(["/usr/sbin/pkgutil", "--check-signature", str(packages[0])]).decode()
    require(any(re.fullmatch(rf'\s*1\. {INSTALLER_NAME}', line) for line in signature.splitlines()))
    expanded = Path(release_root) / "verified-macos-package"
    require(not expanded.exists())
    checked(["/usr/sbin/pkgutil", "--expand-full", str(packages[0]), str(expanded)])
    apps = list(expanded.rglob("*.app"))
    require(len(apps) == 1 and apps[0].is_dir() and not apps[0].is_symlink())
    checked(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(apps[0])])
    info = plistlib.loads((apps[0] / "Contents/Info.plist").read_bytes())
    require(info.get("CFBundleIdentifier") == BUNDLE)
    entitlements = checked(["/usr/bin/codesign", "--display", "--entitlements", "-", "--xml", str(apps[0])])
    signed_entitlements(plistlib.loads(entitlements))


def main():
    if sys.argv[1:] == ["installer-identity"]:
        installer_identity(sys.stdin.read())
    elif len(sys.argv) == 3 and sys.argv[1] == "profile":
        profile(plistlib.loads(Path(sys.argv[2]).read_bytes()))
    elif len(sys.argv) == 4 and sys.argv[1] == "package":
        package(sys.argv[2], sys.argv[3])
    else:
        raise ValueError("Invalid validation mode")
    print("Mac App Store validation passed.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Mac App Store validation failed; protected metadata omitted.", file=sys.stderr)
        sys.exit(1)
