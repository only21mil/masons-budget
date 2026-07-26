#!/usr/bin/env python3
"""Report which declared secrets are present, without printing any value.

Reads each declared secret from the environment (the calling workflow binds them
one per env key) and emits PRESENT/ABSENT plus a cheap well-formedness verdict.

The only things this program is ever allowed to emit about a secret are booleans:
present or not, decodes as base64 or not, has stray surrounding whitespace or not.
No value, no prefix, no length, no hash. Length alone is enough to fingerprint a
short id, so it is not reported either.

Exits non-zero when a secret marked required_for_release is absent or malformed,
so a red run means "a release would fail today" — established without running,
signing, or uploading anything.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import sys
from pathlib import Path

INVENTORY = Path(__file__).resolve().parent.parent / "secrets-inventory.json"


def well_formed(value: str, encoding: str) -> tuple[bool, str]:
    """Return (ok, note). The note never derives from the secret's content."""
    if encoding == "base64":
        compact = "".join(value.split())
        try:
            decoded = base64.b64decode(compact, validate=True)
        except (binascii.Error, ValueError):
            return False, "not valid base64 — re-encode and paste again"
        if not decoded:
            return False, "decodes to zero bytes"
        return True, "decodes as base64"
    if value != value.strip():
        return False, "has leading/trailing whitespace — re-paste without it"
    return True, ""


def main() -> int:
    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))["secrets"]

    rows: list[tuple[str, str, str, str]] = []
    failures: list[str] = []
    present_count = 0

    for entry in inventory:
        name = entry["name"]
        required = bool(entry["required_for_release"])
        value = os.environ.get(name, "")

        if not value:
            status = "ABSENT"
            note = "" if required else "optional — falls back to a built-in default"
            if required:
                failures.append(f"{name} is required for a release and is not set")
        else:
            present_count += 1
            ok, note = well_formed(value, entry["encoding"])
            status = "PRESENT" if ok else "PRESENT but MALFORMED"
            if not ok and required:
                failures.append(f"{name} is set but {note}")

        rows.append((name, "yes" if required else "no", status, note))

    lines = [
        "## Release secrets preflight",
        "",
        f"{present_count} of {len(inventory)} declared secrets are set on this repository.",
        "No secret value is read, printed, decoded to disk, or otherwise exposed by this run.",
        "",
        "| Secret | Required for release | Status | Note |",
        "| --- | --- | --- | --- |",
    ]
    lines += [f"| `{n}` | {r} | {s} | {note} |" for n, r, s, note in rows]

    if failures:
        lines += ["", "### Blocking", ""]
        lines += [f"- {f}" for f in failures]
        lines += [
            "",
            "A TestFlight run would fail at the signing or upload step. "
            "Set the missing secrets before triggering `Deploy to TestFlight`.",
        ]
    else:
        lines += ["", "Every release-required secret is present and well formed."]

    report = "\n".join(lines)
    print(report)

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(report + "\n")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
