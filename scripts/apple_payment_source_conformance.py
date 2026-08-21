#!/usr/bin/env python3
"""Payment-source conformance gate.

Diffs the Swift TransactionSourceCatalog against the closed wire contract in
shared/domain/fixtures/payment-source-cases.json. The fixture's `sources` array
order is the canonical picker order; the Swift `common` array must match it
position for position (wire, label, count). The Swift-side conformance test
(MasonsBudgetTests/PaymentSourceConformanceTests.swift) pins the catalogue
against hardcoded contract values; this gate diffs against the live fixture
JSON so drift in either direction is caught.

Usage:
    scripts/check-apple-payment-source-conformance.py [--root <repo root>]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

FIXTURE_RELATIVE = Path("shared/domain/fixtures/payment-source-cases.json")
SWIFT_RELATIVE = Path("MasonsBudget/MasonsBudget/Models/TransactionSource.swift")

# Swift enum case names to fixture snake_case values. Classification and
# activities are contract columns too: a catalogue entry with the right wire
# and label but the wrong classification silently drops sources from pickers.
SWIFT_TO_FIXTURE_CLASSIFICATION = {
    "bitcoinNative": "bitcoin_native",
    "fiatCard": "fiat_card",
    "billPay": "bill_pay",
}
SWIFT_TO_FIXTURE_ACTIVITY = {
    "spend": "spend",
    "income": "income",
    "transfer": "transfer",
    "btcBillPay": "btc_bill_pay",
}

# Matches `TransactionSourceOption(wire: "river", label: "River", ...)` at the
# start of a catalogue entry. Robust to attribute order and multiline entries
# because the wire/label are pulled off each entry's first line by name.
ENTRY_LINE = re.compile(
    r"TransactionSourceOption\(\s*wire:\s*\"(?P<wire>[^\"]+)\"\s*,\s*"
    r"label:\s*\"(?P<label>[^\"]+)\"",
)
CLASSIFICATION_LINE = re.compile(r"classification:\s*\.(\w+)")
ACTIVITIES_LINE = re.compile(r"supportedActivities:\s*\[([^\]]*)\]")


def fail(message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"FAIL: {message}")
    sys.exit(1)


def swift_activities_to_fixture(raw: str) -> list[str]:
    """Map `[.spend, .income]` to `["spend", "income"]`, sorted for comparison.

    The Swift field is a Set, so its literal order carries no contract meaning;
    the fixture's array order is canonical and both sides are compared sorted.
    """
    cases = re.findall(r"\.(\w+)", raw)
    mapped = []
    for case in cases:
        fixture_name = SWIFT_TO_FIXTURE_ACTIVITY.get(case)
        if fixture_name is None:
            fail(f"unknown Swift activity case `.{case}` in catalogue entry")
        mapped.append(fixture_name)
    return sorted(mapped)


def load_fixture(path: Path) -> tuple[str, list[dict]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"fixture not found: {path}")
    except json.JSONDecodeError as error:
        fail(f"fixture is not valid JSON ({path}): {error}")

    contract_version = str(data.get("contractVersion", "?"))
    sources = data.get("sources")
    if not isinstance(sources, list) or not sources:
        fail(f"fixture has no non-empty `sources` array: {path}")
    for index, source in enumerate(sources):
        for key in ("wire", "label", "classification"):
            if not isinstance(source.get(key), str):
                fail(f"fixture source[{index}] is missing a string `{key}`: {path}")
        activities = source.get("supportedActivities")
        if not isinstance(activities, list) or not all(
            isinstance(activity, str) for activity in activities
        ):
            fail(f"fixture source[{index}] is missing a `supportedActivities` string array: {path}")
    return contract_version, sources


def load_swift_catalogue(path: Path) -> list[dict]:
    """Return the catalogue entries of the `common` array, in file order.

    Each entry is a dict with wire, label, classification, and a sorted list
    of supported activities, so every contract column is pinned, not just
    wire and label. Only entries inside the
    `static let common: [TransactionSourceOption]` array count, so a synthetic
    option built inside `sources(for:including:)` (whose entry line has no
    literal wire) never pollutes the comparison.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        fail(f"Swift catalogue not found: {path}")

    start = text.find("static let common: [TransactionSourceOption]")
    if start == -1:
        start = text.find("static let common:")
    if start == -1:
        fail(f"no `static let common` catalogue array found in {path}")

    # The array literal starts at the first `[` after the declaration's `=`
    # (skipping the `[TransactionSourceOption]` type annotation).
    assignment = text.find("=", start)
    if assignment == -1:
        fail(f"`common` declaration has no array literal in {path}")
    open_bracket = text.find("[", assignment)
    if open_bracket == -1:
        fail(f"`common` declaration has no array literal in {path}")
    depth = 0
    end = -1
    for position in range(open_bracket, len(text)):
        character = text[position]
        if character == "[":
            depth += 1
        elif character == "]":
            depth -= 1
            if depth == 0:
                end = position
                break
    if end == -1:
        fail(f"unbalanced array literal for `common` in {path}")

    body = text[open_bracket:end]
    entries = []
    for match in ENTRY_LINE.finditer(body):
        classification = CLASSIFICATION_LINE.search(body, match.end())
        activities = ACTIVITIES_LINE.search(body, match.end())
        # The next entry bounds where this entry's attributes may appear.
        next_entry = ENTRY_LINE.search(body, match.end())
        attribute_limit = next_entry.start() if next_entry else len(body)
        if classification is None or classification.start() >= attribute_limit:
            fail(f"catalogue entry {match['wire']!r} has no `classification:` within its span")
        if activities is None or activities.start() >= attribute_limit:
            fail(f"catalogue entry {match['wire']!r} has no `supportedActivities:` within its span")
        fixture_classification = SWIFT_TO_FIXTURE_CLASSIFICATION.get(classification.group(1))
        if fixture_classification is None:
            fail(f"unknown Swift classification case `.{classification.group(1)}` on {match['wire']!r}")
        entries.append(
            {
                "wire": match["wire"],
                "label": match["label"],
                "classification": fixture_classification,
                "supportedActivities": swift_activities_to_fixture(activities.group(1)),
            }
        )
    return entries


def diff_list(name: str, swift: list[str], fixture: list[str]) -> None:
    if swift == fixture:
        return
    lines = [f"{name} mismatch (Swift catalogue vs fixture):"]
    only_swift = [value for value in swift if value not in fixture]
    only_fixture = [value for value in fixture if value not in swift]
    for value in only_swift:
        lines.append(f"  only in Swift catalogue: {value!r}")
    for value in only_fixture:
        lines.append(f"  only in fixture:        {value!r}")
    if not only_swift and not only_fixture:
        lines.append("  same values, different order:")
        for index, (swift_value, fixture_value) in enumerate(zip(swift, fixture)):
            if swift_value != fixture_value:
                lines.append(f"    position {index}: Swift {swift_value!r} vs fixture {fixture_value!r}")
    else:
        for index, (swift_value, fixture_value) in enumerate(zip(swift, fixture)):
            if swift_value != fixture_value:
                lines.append(f"    position {index}: Swift {swift_value!r} vs fixture {fixture_value!r}")
    fail("\n".join(lines))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="Repository root (default: parent of this script)",
    )
    arguments = parser.parse_args()

    fixture_path = arguments.root / FIXTURE_RELATIVE
    swift_path = arguments.root / SWIFT_RELATIVE

    contract_version, sources = load_fixture(fixture_path)
    catalogue = load_swift_catalogue(swift_path)

    fixture_wires = [source["wire"] for source in sources]
    fixture_labels = [source["label"] for source in sources]
    swift_wires = [entry["wire"] for entry in catalogue]
    swift_labels = [entry["label"] for entry in catalogue]

    if len(swift_wires) != len(fixture_wires):
        fail(
            "count mismatch: Swift catalogue has "
            f"{len(swift_wires)} sources, fixture has {len(fixture_wires)}"
        )

    diff_list("wire order", swift_wires, fixture_wires)
    diff_list("label order", swift_labels, fixture_labels)

    for index, (swift_entry, fixture_source) in enumerate(zip(catalogue, sources)):
        swift_classification = swift_entry["classification"]
        fixture_classification = fixture_source["classification"]
        if swift_classification != fixture_classification:
            fail(
                f"classification mismatch at position {index} "
                f"({swift_entry['wire']}): Swift {swift_classification!r} vs "
                f"fixture {fixture_classification!r}"
            )
        swift_activities = swift_entry["supportedActivities"]
        fixture_activities = sorted(fixture_source["supportedActivities"])
        if swift_activities != fixture_activities:
            fail(
                f"supportedActivities mismatch at position {index} "
                f"({swift_entry['wire']}): Swift {swift_activities!r} vs "
                f"fixture {fixture_activities!r}"
            )

    print(
        f"PASS: Apple payment-source catalogue conforms to "
        f"shared/domain/fixtures/payment-source-cases.json "
        f"(contractVersion {contract_version}; {len(swift_wires)} Swift sources, "
        f"{len(fixture_wires)} fixture sources)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
