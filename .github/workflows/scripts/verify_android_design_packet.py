#!/usr/bin/env python3

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path


# Reviewed against DesignPacketTest.kt. Keeping the contract here avoids a
# circular gate that trusts the test output, while these explicit dimensions
# make each generated basename easy to audit when the packet changes.
DESTINATIONS = (
    "dashboard",
    "activity",
    "budget",
    "bitcoin",
    "btc_buys",
    "btc_bill_pays",
    "net_worth",
    "retirement",
    "export",
    "today",
    "tasks",
    "family",
    "settings",
)
DISPLAY_UNITS = ("btc", "sats", "usd")
SAMPLED_STATE_DESTINATIONS = ("dashboard", "budget", "activity", "net_worth")
NON_NORMAL_STATES = ("stale", "error", "empty", "loading")

DAYLIGHT_PNGS = frozenset(
    {"folded-status-and-unavailable-tokens.png"}
    | {f"folded-{destination}-victor-normal.png" for destination in DESTINATIONS}
    | {f"folded-{destination}-mason-normal.png" for destination in DESTINATIONS}
    | {f"folded-bitcoin-victor-{unit}.png" for unit in DISPLAY_UNITS}
    | {
        "folded-bitcoin-victor-usd-no-price.png",
        "folded-budget-victor-2026-06.png",
        "folded-budget-maddox-normal.png",
    }
    | {
        f"folded-{destination}-victor-{state}.png"
        for destination in SAMPLED_STATE_DESTINATIONS
        for state in NON_NORMAL_STATES
    }
    | {f"unfolded-{destination}-victor-normal.png" for destination in DESTINATIONS}
    | {
        "unfolded-dashboard-mason-normal.png",
        "unfolded-budget-victor-2026-06.png",
        # Two-pane unfolded captures added with the ledger sidebar (2026-09-05).
        "unfolded-dashboard-victor-two-pane.png",
        "unfolded-budget-victor-two-pane.png",
    }
)
TERMINAL_PNGS = frozenset(
    {
        "folded-dashboard-victor-terminal.png",
        "folded-status-and-unavailable-tokens-terminal.png",
        "unfolded-dashboard-victor-terminal.png",
    }
)
EXPECTED_PNGS = DAYLIGHT_PNGS | TERMINAL_PNGS

EXPECTED_COUNT = 69
if len(EXPECTED_PNGS) != EXPECTED_COUNT:
    raise RuntimeError(
        f"design-packet manifest has {len(EXPECTED_PNGS)} names; expected {EXPECTED_COUNT}"
    )


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
