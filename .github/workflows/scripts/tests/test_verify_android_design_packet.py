#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "verify_android_design_packet.py"
SPEC = importlib.util.spec_from_file_location("verify_android_design_packet", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AndroidDesignPacketTests(unittest.TestCase):
    def populate(self, directory: Path, names: set[str] | frozenset[str]) -> None:
        for name in names:
            (directory / name).touch()

    def test_current_capture_contract(self) -> None:
        # Independent regression oracle for the reviewed capture contract. Do not
        # populate this fixture from the verifier's own expected set.
        destinations = (
            "home", "budget", "activity", "bitcoin", "btc_buys",
            "btc_bill_pays", "export", "tasks", "family", "settings",
        )
        expected = {
            f"{posture}-{destination}-{profile}-normal.png"
            for posture, profile in (
                ("folded", "victor"), ("folded", "mason"), ("unfolded", "victor")
            )
            for destination in destinations
        } | {
            f"folded-{destination}-victor-{state}.png"
            for destination in ("home", "budget", "activity", "bitcoin")
            for state in ("stale", "error", "empty", "loading")
        } | {
            f"folded-bitcoin-victor-{unit}.png" for unit in ("btc", "sats", "usd")
        } | {
            "folded-status-and-unavailable-tokens.png",
            "folded-status-and-unavailable-tokens-terminal.png",
            "folded-dashboard-victor-terminal.png",
            "unfolded-dashboard-victor-terminal.png",
            "folded-bitcoin-victor-usd-no-price.png",
            "folded-budget-victor-2026-06.png",
            "folded-budget-maddox-normal.png",
            "unfolded-dashboard-mason-normal.png",
            "unfolded-dashboard-victor-two-pane.png",
            "unfolded-budget-victor-two-pane.png",
            "unfolded-budget-victor-2026-06.png",
        }
        self.assertEqual(60, len(expected))
        self.assertEqual(expected, MODULE.EXPECTED_PNGS)

    def changed_catalog(self, path: Path, old: str, new: str) -> frozenset[str]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in (
                MODULE.CAPTURE_SOURCE, MODULE.DESTINATION_SOURCE, MODULE.UNIT_SOURCE
            ):
                text = (MODULE.REPO_ROOT / relative).read_text()
                if relative == path:
                    self.assertIn(old, text)
                    text = text.replace(old, new)
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)
            return MODULE.expected_pngs(root)

    def test_new_destination_updates_all_profiles_and_postures(self) -> None:
        actual = self.changed_catalog(
            MODULE.DESTINATION_SOURCE, 'HOME("Home")', 'SAVINGS("Savings"), HOME("Home")'
        )
        self.assertEqual(MODULE.EXPECTED_PNGS | {
            "folded-savings-victor-normal.png", "folded-savings-mason-normal.png",
            "unfolded-savings-victor-normal.png",
        }, actual)

    def test_sampled_destinations_follow_capture_test(self) -> None:
        actual = self.changed_catalog(
            MODULE.CAPTURE_SOURCE, "val sampled = listOf(",
            "val sampled = listOf(Destination.TASKS,",
        )
        self.assertEqual(MODULE.EXPECTED_PNGS | {
            f"folded-tasks-victor-{state}.png"
            for state in ("stale", "error", "empty", "loading")
        }, actual)

    def test_display_units_follow_storage_keys(self) -> None:
        actual = self.changed_catalog(MODULE.UNIT_SOURCE, 'SATS("sats",', 'SATS("satoshi",')
        self.assertEqual(
            (MODULE.EXPECTED_PNGS - {"folded-bitcoin-victor-sats.png"})
            | {"folded-bitcoin-victor-satoshi.png"}, actual,
        )

    def test_states_follow_capture_test(self) -> None:
        actual = self.changed_catalog(
            MODULE.CAPTURE_SOURCE, "Freshness.STALE, Freshness.ERROR",
            "Freshness.ERROR",
        )
        self.assertEqual(MODULE.EXPECTED_PNGS - {
            f"folded-{destination}-victor-stale.png"
            for destination in ("home", "budget", "activity", "bitcoin")
        }, actual)

    def test_profile_and_explicit_captures_follow_test(self) -> None:
        actual = self.changed_catalog(MODULE.CAPTURE_SOURCE, "-mason-normal", "-rachel-normal")
        self.assertEqual({
            name.replace("-mason-normal", "-rachel-normal")
            for name in MODULE.EXPECTED_PNGS
        }, actual)

    def test_commented_destination_is_ignored(self) -> None:
        actual = self.changed_catalog(
            MODULE.DESTINATION_SOURCE, 'HOME("Home")',
            '/* OLD("Old"), */ HOME("Home")',
        )
        self.assertEqual(MODULE.EXPECTED_PNGS, actual)

    def test_unknown_interpolation_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported capture filename"):
            self.changed_catalog(
                MODULE.CAPTURE_SOURCE, "${unit.storageKey}", "${unit.newKey}"
            )

    def test_missing_catalog_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported Android capture contract"):
            self.changed_catalog(MODULE.DESTINATION_SOURCE, "enum class Destination", "enum class Other")

    def test_digit_bearing_destination_is_included(self) -> None:
        actual = self.changed_catalog(
            MODULE.DESTINATION_SOURCE, 'HOME("Home")', 'V2("V2"), HOME("Home")'
        )
        self.assertEqual(MODULE.EXPECTED_PNGS | {
            "folded-v2-victor-normal.png", "folded-v2-mason-normal.png",
            "unfolded-v2-victor-normal.png",
        }, actual)

    def test_named_storage_key_is_included(self) -> None:
        actual = self.changed_catalog(
            MODULE.UNIT_SOURCE, 'SATS("sats", "SATS")',
            'SATS(label = "sats", storageKey = "satoshi")',
        )
        self.assertEqual(
            (MODULE.EXPECTED_PNGS - {"folded-bitcoin-victor-sats.png"})
            | {"folded-bitcoin-victor-satoshi.png"}, actual,
        )

    def test_unusual_prefix_is_included(self) -> None:
        actual = self.changed_catalog(
            MODULE.CAPTURE_SOURCE, '"folded-budget-maddox-normal"',
            '"tablet-budget-maddox-normal"',
        )
        self.assertEqual(
            (MODULE.EXPECTED_PNGS - {"folded-budget-maddox-normal.png"})
            | {"tablet-budget-maddox-normal.png"}, actual,
        )

    def test_named_capture_argument_is_included(self) -> None:
        actual = self.changed_catalog(
            MODULE.CAPTURE_SOURCE, '"folded-budget-maddox-normal",',
            'name = "folded-budget-maddox-normal",',
        )
        self.assertEqual(MODULE.EXPECTED_PNGS, actual)

    def test_filtered_iterations_fail_closed(self) -> None:
        for old, new in (
            ("Destination.entries)", "Destination.entries.take(3))"),
            ("DisplayUnit.entries)", "DisplayUnit.entries.reversed())"),
            ("destination in sampled)", "destination in sampled.drop(1))"),
            ("status in states)", "status in states.filter { true })"),
        ):
            with self.subTest(new=new), self.assertRaisesRegex(ValueError, "iteration"):
                self.changed_catalog(MODULE.CAPTURE_SOURCE, old, new)

    def test_filtered_capture_list_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "filtered list"):
            self.changed_catalog(
                MODULE.CAPTURE_SOURCE, "Freshness.LOADING)",
                "Freshness.LOADING).take(2)",
            )

    def test_foreach_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "control flow"):
            self.changed_catalog(
                MODULE.CAPTURE_SOURCE, "for (destination in Destination.entries) {",
                "Destination.entries.forEach { destination ->",
            )

    def test_unbound_interpolation_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported capture filename"):
            self.changed_catalog(
                MODULE.CAPTURE_SOURCE, "-maddox-normal", "-${status.name.lowercase()}",
            )

    def test_duplicate_capture_names_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate Android capture filenames"):
            self.changed_catalog(
                MODULE.CAPTURE_SOURCE, '"folded-budget-maddox-normal"',
                '"folded-budget-victor-2026-06"',
            )

    def test_commented_captures_are_ignored(self) -> None:
        actual = self.changed_catalog(
            MODULE.CAPTURE_SOURCE, "fun maddoxBudgetIsEmpty() {",
            'fun maddoxBudgetIsEmpty() { /* nested /* comment */ capture("ignored", state) */',
        )
        self.assertEqual(MODULE.EXPECTED_PNGS, actual)

    def test_comment_markers_inside_strings_survive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.kt"
            source.write_text('val name = "a//b/*c*/" // gone\n')
            self.assertIn('"a//b/*c*/"', MODULE.source_text(source))
            self.assertNotIn("gone", MODULE.source_text(source))
        with self.assertRaisesRegex(ValueError, "basename"):
            self.changed_catalog(
                MODULE.CAPTURE_SOURCE, '"folded-budget-maddox-normal"',
                '"unusual//capture"',
            )

    def test_unrelated_filename_string_does_not_enter_manifest(self) -> None:
        actual = self.changed_catalog(
            MODULE.CAPTURE_SOURCE, "fun maddoxBudgetIsEmpty() {",
            'fun maddoxBudgetIsEmpty() { val ignored = "folded-unused"',
        )
        self.assertEqual(MODULE.EXPECTED_PNGS, actual)

    def test_capture_helper_output_change_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "helper output path"):
            self.changed_catalog(
                MODULE.CAPTURE_SOURCE, '$name.png', 'prefix-$name.png',
            )

    def test_malformed_catalog_entry_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "Destination entry"):
            self.changed_catalog(
                MODULE.DESTINATION_SOURCE, 'HOME("Home")', 'HOME("Home") { override() }',
            )

    def test_renamed_loop_variable_keeps_its_catalog(self) -> None:
        actual = self.changed_catalog(MODULE.CAPTURE_SOURCE, "unit", "displayChoice")
        self.assertEqual(MODULE.EXPECTED_PNGS, actual)

    def test_two_fields_of_one_entry_stay_bound(self) -> None:
        actual = self.changed_catalog(
            MODULE.CAPTURE_SOURCE, "${unit.storageKey}",
            "${unit.name.lowercase()}-${unit.storageKey}",
        )
        self.assertEqual(
            (MODULE.EXPECTED_PNGS - {
                f"folded-bitcoin-victor-{unit}.png" for unit in ("btc", "sats", "usd")
            }) | {
                f"folded-bitcoin-victor-{unit}-{unit}.png" for unit in ("btc", "sats", "usd")
            }, actual,
        )

    def test_accepts_complete_packet(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            packet_dir = Path(directory)
            self.populate(packet_dir, MODULE.EXPECTED_PNGS)

            self.assertEqual([], MODULE.verify(packet_dir))

    def test_rejects_missing_png(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            packet_dir = Path(directory)
            missing = min(MODULE.EXPECTED_PNGS)
            self.populate(packet_dir, MODULE.EXPECTED_PNGS - {missing})

            errors = MODULE.verify(packet_dir)
            self.assertTrue(any(f"missing PNGs (1): {missing}" in error for error in errors))

    def test_rejects_unexpected_png(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            packet_dir = Path(directory)
            self.populate(packet_dir, MODULE.EXPECTED_PNGS | {"unexpected.png"})

            errors = MODULE.verify(packet_dir)
            self.assertTrue(
                any("unexpected PNGs (1): unexpected.png" in error for error in errors)
            )

    def test_rejects_empty_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            errors = MODULE.verify(Path(directory))

            self.assertTrue(any(f"missing PNGs ({MODULE.EXPECTED_COUNT})" in error for error in errors))

    def test_rejects_duplicate_basename(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            packet_dir = Path(directory)
            self.populate(packet_dir, MODULE.EXPECTED_PNGS)
            duplicate = min(MODULE.EXPECTED_PNGS)
            nested = packet_dir / "nested"
            nested.mkdir()
            (nested / duplicate).touch()

            errors = MODULE.verify(packet_dir)
            self.assertTrue(
                any(f"duplicate PNG basenames (1): {duplicate}" in error for error in errors)
            )


if __name__ == "__main__":
    unittest.main()
