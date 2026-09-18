#!/usr/bin/env python3

from __future__ import annotations

import argparse
import itertools
import re
from collections import Counter
from pathlib import Path


# Read the source contract, never the recorded output or historical screenshots.
# Paths are relative to this script so direct CI invocation and unittest discovery
# both work regardless of the caller's working directory.
REPO_ROOT = Path(__file__).resolve().parents[3]
KOTLIN_ROOT = Path("android/app/src")
CAPTURE_SOURCE = KOTLIN_ROOT / "test/kotlin/com/sats21m/vogelvault/DesignPacketTest.kt"
DESTINATION_SOURCE = KOTLIN_ROOT / "main/kotlin/com/sats21m/vogelvault/ui/VaultApp.kt"
UNIT_SOURCE = Path("android/domain/src/main/kotlin/com/sats21m/vogelvault/domain/Money.kt")


def source_text(path: Path) -> str:
    # Ignore commented-out entries and captures.
    return re.sub(r"/\*.*?\*/|//[^\n]*", "", path.read_text(), flags=re.S)


def required_match(pattern: str, source: str) -> str:
    match = re.search(pattern, source, flags=re.S)
    if match is None:
        raise ValueError(f"unsupported Android capture contract: {pattern}")
    return match.group(1)


def expected_pngs(repo_root: Path = REPO_ROOT) -> frozenset[str]:
    captures = source_text(repo_root / CAPTURE_SOURCE)
    destinations = required_match(
        r"enum class Destination\([^{}]*\)\s*\{([^}]+)",
        source_text(repo_root / DESTINATION_SOURCE),
    ).split(";")[0]
    destination_names = re.findall(r'\b([A-Z][A-Z_]+)\s*\(', destinations)
    units = required_match(
        r"enum class DisplayUnit\([^{}]*\)\s*\{([^;]+);",
        source_text(repo_root / UNIT_SOURCE),
    )
    unit_keys = re.findall(r'[A-Z][A-Z_]+\s*\(\s*"([^"\n]+)"', units)
    sampled = re.findall(
        r"Destination\.([A-Z_]+)",
        required_match(r"val sampled = listOf\((.*?)\)", captures),
    )
    states = re.findall(
        r"Freshness\.([A-Z_]+)",
        required_match(r"val states = listOf\((.*?)\)", captures),
    )
    if not all((destination_names, unit_keys, sampled, states)):
        raise ValueError("empty Android capture catalog")
    if not set(sampled) <= set(destination_names):
        raise ValueError("sampled destination missing from Destination catalog")

    # Includes explicit captures and the status-token helper's default name.
    # The only interpolations in the current contract are expanded below. Fail
    # closed if the capture code introduces a new interpolation syntax.
    templates = re.findall(r'"((?:folded|unfolded)-[^"\n]+)"', captures)
    if not templates:
        raise ValueError("no Android capture filename templates found")
    names: set[str] = set()
    for template in templates:
        dimensions = {
            "${destination.name.lowercase()}": [
                name.lower() for name in (
                    sampled if "${status.name.lowercase()}" in template else destination_names
                )
            ],
            "${status.name.lowercase()}": [state.lower() for state in states],
            "${unit.storageKey}": unit_keys,
        }
        tokens = [token for token in dimensions if token in template]
        for values in itertools.product(*(dimensions[token] for token in tokens)):
            name = template
            for token, value in zip(tokens, values):
                name = name.replace(token, value)
            if "$" in name:
                raise ValueError(f"unsupported capture filename template: {template}")
            names.add(f"{name}.png")
    return frozenset(names)


EXPECTED_PNGS = expected_pngs()
EXPECTED_COUNT = len(EXPECTED_PNGS)


def verify(packet_dir: Path) -> list[str]:
    if not packet_dir.is_dir():
        return [f"packet directory does not exist: {packet_dir}"]

    names = [path.name for path in packet_dir.rglob("*.png") if path.is_file()]
    counts = Counter(names)
    actual = set(names)
    errors: list[str] = []

    missing = sorted(EXPECTED_PNGS - actual)
    unexpected = sorted(actual - EXPECTED_PNGS)
    duplicates = sorted(name for name, count in counts.items() if count > 1)

    if missing:
        errors.append(f"missing PNGs ({len(missing)}): {', '.join(missing)}")
    if unexpected:
        errors.append(f"unexpected PNGs ({len(unexpected)}): {', '.join(unexpected)}")
    if duplicates:
        errors.append(f"duplicate PNG basenames ({len(duplicates)}): {', '.join(duplicates)}")
    if len(names) != EXPECTED_COUNT and not errors:
        errors.append(f"found {len(names)} PNG files; expected {EXPECTED_COUNT}")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify the exact Android design-packet PNG contract."
    )
    parser.add_argument("packet_dir", type=Path)
    args = parser.parse_args()

    errors = verify(args.packet_dir)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    print(f"OK: Android design packet contains exactly {EXPECTED_COUNT} expected PNGs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
