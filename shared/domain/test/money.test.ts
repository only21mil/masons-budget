// Money is Decimal, never Double (AGENTS.md). JavaScript has no Decimal, so the
// shared layer parses the lexical form straight into integer minor units. These
// tests pin the cases where a naive `value * 100` would drift.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  DISPLAY_UNITS,
  PRICE_UNAVAILABLE,
  SATS_PER_BTC,
  SHARES_DECIMAL_MAX_RAW_LENGTH,
  basisPoints,
  displayUnitForSurface,
  displayUnitFromStorageKey,
  formatBtc,
  formatBitcoin,
  formatSats,
  formatUsd,
  assertSharesDecimal,
  canonicalizeSharesDecimal,
  jsonNumberToCents,
  jsonNumberToMinorUnits,
  jsonNumberToSats,
  parseBtcToSats,
  parseCents,
  satsToUsdCents,
  sharesToValueCents,
  sum,
} from "../src/money.ts"

interface JsonNumberMoneyCase {
  label: string
  value: number
  expected?: string
  refuse?: boolean
}

interface JsonNumberMoneyCases {
  rounding: string
  cents: JsonNumberMoneyCase[]
  sats: JsonNumberMoneyCase[]
}

const jsonNumberCases = JSON.parse(
  readFileSync(new URL("../fixtures/json-number-money-cases.json", import.meta.url), "utf8"),
) as JsonNumberMoneyCases

test("parses plain decimal strings exactly", () => {
  assert.equal(parseCents("0"), 0n)
  assert.equal(parseCents("1"), 100n)
  assert.equal(parseCents("1.5"), 150n)
  assert.equal(parseCents("1234.56"), 123456n)
  assert.equal(parseCents("-95"), -9500n)
  assert.equal(parseCents("-0.01"), -1n)
})

test("handles the float-drift cases that break naive multiplication", () => {
  // 1.1 * 100 === 110.00000000000001 in IEEE 754.
  assert.equal(parseCents(1.1), 110n)
  assert.equal(parseCents(1.15), 115n)
  assert.equal(parseCents(0.07), 7n)
  assert.equal(parseCents(29.99), 2999n)
  assert.equal(parseCents(1e6), 100_000_000n)
})

test("converts adversarial JSON numbers from the shared fixture", () => {
  assert.equal(jsonNumberCases.rounding, "half away from zero")

  for (const fixture of jsonNumberCases.cents) {
    if (fixture.refuse === true) {
      assert.throws(
        () => jsonNumberToCents(fixture.value),
        RangeError,
        `cents fixture should be refused: ${fixture.label}`,
      )
    } else {
      assert.equal(
        jsonNumberToCents(fixture.value),
        BigInt(fixture.expected ?? assert.fail(`missing expected value: ${fixture.label}`)),
        fixture.label,
      )
    }
  }

  for (const fixture of jsonNumberCases.sats) {
    if (fixture.refuse === true) {
      assert.throws(
        () => jsonNumberToSats(fixture.value),
        RangeError,
        `sats fixture should be refused: ${fixture.label}`,
      )
    } else {
      assert.equal(
        jsonNumberToSats(fixture.value),
        BigInt(fixture.expected ?? assert.fail(`missing expected value: ${fixture.label}`)),
        fixture.label,
      )
    }
  }
})

test("exhaustively converts every cent from -$10,000 through $10,000", () => {
  for (let cents = -1_000_000; cents <= 1_000_000; cents += 1) {
    const lexical = `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(
      Math.abs(cents) % 100,
    ).padStart(2, "0")}`
    const value = JSON.parse(lexical) as number
    assert.equal(jsonNumberToCents(value), BigInt(cents), lexical)
  }
})

test("exhaustively converts eight-decimal BTC values across a two-million-sat window", () => {
  for (let sats = -1_000_000; sats <= 1_000_000; sats += 1) {
    const lexical = `${sats < 0 ? "-" : ""}0.${String(Math.abs(sats)).padStart(8, "0")}`
    const value = JSON.parse(lexical) as number
    assert.equal(jsonNumberToSats(value), BigInt(sats), lexical)
  }
})

test("converts broad BTC magnitudes without losing the eighth decimal place", () => {
  const wholeBtcValues = [0, 1, 21, 2_100, 21_000_000]
  const fractionalSats = [1, 7, 12_345_678, 50_000_001, 99_999_999]

  for (const wholeBtc of wholeBtcValues) {
    for (const fraction of fractionalSats) {
      const lexical = `${wholeBtc}.${String(fraction).padStart(8, "0")}`
      const value = JSON.parse(lexical) as number
      assert.equal(
        jsonNumberToSats(value),
        BigInt(wholeBtc) * SATS_PER_BTC + BigInt(fraction),
        lexical,
      )
    }
  }
})

test("rounds halfway values away from zero using decimal digits, not float multiplication", () => {
  assert.equal(jsonNumberToCents(0.1 + 0.2), 30n)
  assert.equal(jsonNumberToMinorUnits(1.005, 2), 101n)
  assert.equal(jsonNumberToMinorUnits(-1.005, 2), -101n)
  assert.equal(jsonNumberToMinorUnits(0.000000005, 8), 1n)
  assert.equal(jsonNumberToMinorUnits(-0.000000005, 8), -1n)
})

test("refuses non-finite numbers, invalid scales, and unsafe minor-unit results", () => {
  assert.throws(() => jsonNumberToMinorUnits(Number.NaN, 2), RangeError)
  assert.throws(() => jsonNumberToMinorUnits(Number.POSITIVE_INFINITY, 2), RangeError)
  assert.throws(() => jsonNumberToMinorUnits(1, -1), RangeError)
  assert.throws(() => jsonNumberToMinorUnits(1, 1.5), RangeError)
  assert.throws(() => jsonNumberToSats(90_071_992.54740992), RangeError)
  assert.throws(() => jsonNumberToSats(-90_071_992.54740992), RangeError)
})

test("treats absent values as zero rather than NaN", () => {
  assert.equal(parseCents(null), 0n)
  assert.equal(parseCents(undefined), 0n)
  assert.equal(parseCents(""), 0n)
})

test("rejects values that are not decimals", () => {
  assert.throws(() => parseCents("abc"), RangeError)
  assert.throws(() => parseCents("1.2.3"), RangeError)
  assert.throws(() => parseCents(Number.NaN), RangeError)
  assert.throws(() => parseCents(Number.POSITIVE_INFINITY), RangeError)
})

test("rounds half away from zero, matching NSDecimalNumber .plain", () => {
  assert.equal(parseCents("1.005"), 101n)
  assert.equal(parseCents("1.004"), 100n)
  assert.equal(parseCents("-1.005"), -101n)
  assert.equal(parseCents("2.675"), 268n)
})

test("BTC parses to satoshis at 8 decimal places", () => {
  assert.equal(parseBtcToSats("1"), SATS_PER_BTC)
  assert.equal(parseBtcToSats("3.5"), 350_000_000n)
  assert.equal(parseBtcToSats("0.05"), 5_000_000n)
  assert.equal(parseBtcToSats("0.01"), 1_000_000n)
  assert.equal(parseBtcToSats("0.00000001"), 1n)
  assert.equal(parseBtcToSats("21000000"), 2_100_000_000_000_000n)
})

test("sub-satoshi precision rounds rather than truncating to zero", () => {
  assert.equal(parseBtcToSats("0.000000004"), 0n)
  assert.equal(parseBtcToSats("0.000000005"), 1n)
})

test("formats USD with grouping and sign", () => {
  assert.equal(formatUsd(123456n), "$1,234.56")
  assert.equal(formatUsd(0n), "$0.00")
  assert.equal(formatUsd(-9500n), "-$95.00")
  assert.equal(formatUsd(500n, { showSign: true }), "+$5.00")
  assert.equal(formatUsd(100_000_000n), "$1,000,000.00")
  assert.equal(formatUsd(5n), "$0.05")
})

test("formats sats and BTC", () => {
  assert.equal(formatSats(1_234_567n), "1 234 567 sats")
  assert.equal(formatSats(0n), "0 sats")
  assert.equal(formatBtc(350_000_000n), "3.50000000 BTC")
  assert.equal(formatBtc(1n), "0.00000001 BTC")
})

test("converts sats to USD at a given price", () => {
  // 0.05 BTC at $100,000 → $5,000
  assert.equal(satsToUsdCents(5_000_000n, 10_000_000n), 500_000n)
  assert.equal(satsToUsdCents(0n, 10_000_000n), 0n)
  assert.equal(satsToUsdCents(SATS_PER_BTC, 6_543_21n), 654_321n)
  assert.equal(satsToUsdCents(-SATS_PER_BTC, 10_000_000n), -10_000_000n)
})

test("display units share storage keys, labels, fallback, and Budget USD semantics", () => {
  assert.deepEqual(DISPLAY_UNITS, [
    { storageKey: "btc", label: "BTC" },
    { storageKey: "sats", label: "SATS" },
    { storageKey: "usd", label: "USD" },
  ])
  assert.equal(displayUnitFromStorageKey("sats"), "sats")
  assert.equal(displayUnitFromStorageKey("unknown"), "btc")
  assert.equal(displayUnitFromStorageKey(null), "btc")
  assert.equal(displayUnitForSurface("bitcoin", "sats"), "sats")
  assert.equal(displayUnitForSurface("net-worth", "btc"), "btc")
  assert.equal(displayUnitForSurface("budget", "btc"), "usd")
  assert.equal(displayUnitForSurface("budget", "sats"), "usd")
})

test("formats Bitcoin units without treating an unavailable USD quote as zero", () => {
  const sats = 123_456_789n
  assert.equal(formatBitcoin(sats, "btc"), "1.23456789 BTC")
  assert.equal(formatBitcoin(sats, "sats"), "123 456 789 sats")
  assert.equal(formatBitcoin(sats, "usd", 9_500_000n), "$117,283.95")
  assert.equal(formatBitcoin(1n, "usd"), PRICE_UNAVAILABLE)
  assert.equal(formatBitcoin(1n, "usd", 0n), PRICE_UNAVAILABLE)
  assert.equal(formatBitcoin(1n, "usd", -1n), PRICE_UNAVAILABLE)
})

test("sums exactly across many values", () => {
  const values = Array.from({ length: 1000 }, () => parseCents("0.01"))
  assert.equal(sum(values), 1000n)
  assert.equal(sum([]), 0n)
})

test("basisPoints guards divide-by-zero", () => {
  assert.equal(basisPoints(50n, 100n), 5000)
  assert.equal(basisPoints(0n, 100n), 0)
  assert.equal(basisPoints(100n, 0n), 0)
})

// ── Share quantities ────────────────────────────────────────────────────────
//
// Two shapes reach us from blobs written before the contract tightened: IEEE-754
// noise (15-16 fractional digits against a retained scale of 12) and negative
// reconciliation lots. assertSharesDecimal still refuses both, because stored
// text either is canonical or is not; canonicalizeSharesDecimal is the single
// place allowed to repair one.

test("canonicalizing an in-bounds share quantity is the identity", () => {
  for (const value of [
    "0",
    "0.0",
    "2.5000",
    "12.34567890",
    "1393.9646307166",
    "999999999999.999999999999",
  ]) {
    assert.equal(canonicalizeSharesDecimal(value), value, value)
    assert.equal(canonicalizeSharesDecimal(value, { signed: true }), value, value)
    assert.equal(assertSharesDecimal(value), value, value)
  }
  // Trailing zeroes are retained source precision, not noise, so nothing trims
  // them; only zeroes the quantizer itself creates are dropped.
  assert.equal(canonicalizeSharesDecimal("-2.5000", { signed: true }), "-2.5000")
})

test("canonicalizing quantizes the 13th fractional digit half away from zero", () => {
  const cases: Array<[string, string]> = [
    ["1.0000000000004", "1"],
    ["1.0000000000005", "1.000000000001"],
    ["1.0000000000006", "1.000000000001"],
    ["1.1234567890123", "1.123456789012"],
    // The single live row: a VOO lot written straight from a double.
    ["1.7999999999999998", "1.8"],
    ["3.3000000000000003", "3.3"],
    ["999999999999.9999999999990", "999999999999.999999999999"],
  ]
  for (const [raw, expected] of cases) {
    assert.equal(canonicalizeSharesDecimal(raw), expected, raw)
  }
})

test("a quantization carry crosses the decimal point", () => {
  assert.equal(canonicalizeSharesDecimal("0.9999999999995"), "1")
  assert.equal(canonicalizeSharesDecimal("9.9999999999995"), "10")
  assert.equal(canonicalizeSharesDecimal("1.9999999999994"), "1.999999999999")
})

test("signed share quantities are lot-only and round away from zero", () => {
  assert.equal(
    canonicalizeSharesDecimal("-1.0000000000005", { signed: true }),
    "-1.000000000001",
  )
  assert.equal(canonicalizeSharesDecimal("-0.4200000000000001", { signed: true }), "-0.42")
  // 26 characters: the canonical maximum plus its sign.
  const widest = "-999999999999.999999999999"
  assert.equal(widest.length, 26)
  assert.equal(canonicalizeSharesDecimal(widest, { signed: true }), widest)
  // Unsigned is the default, and a position size never goes negative.
  assert.throws(
    () => canonicalizeSharesDecimal("-1.5"),
    /canonical share quantity/,
  )
  assert.throws(() => assertSharesDecimal("-1.5"), /canonical share quantity/)
  assert.equal(assertSharesDecimal("-1.5", { signed: true }), "-1.5")
})

test("minus zero normalizes to plain zero in every spelling", () => {
  for (const value of ["-0", "-0.0", "-0.000000000000", "-0.0000000000004"]) {
    assert.equal(canonicalizeSharesDecimal(value, { signed: true }), "0", value)
    // "-0" is two spellings of one value, so it is never canonical *stored*
    // text; the last case is out of bounds on its scale as well.
    assert.throws(
      () => assertSharesDecimal(value, { signed: true }),
      /share quantity/i,
      value,
    )
  }
})

test("canonicalizing still refuses corruption, before and after quantizing", () => {
  for (const value of ["", "+1", "1e3", " 1", "1 ", "01", "00.1", ".5", "1.", "1,5"]) {
    assert.throws(
      () => canonicalizeSharesDecimal(value, { signed: true }),
      /canonical share quantity/,
      value,
    )
  }
  assert.throws(() => canonicalizeSharesDecimal(1.5 as unknown), /canonical share quantity/)
  // Longer than any double can justify: corruption, not float noise.
  assert.throws(
    () => canonicalizeSharesDecimal(`0.${"1".repeat(SHARES_DECIMAL_MAX_RAW_LENGTH)}`),
    /canonical share quantity/,
  )
  // Bounds are enforced on the canonical result, so a rounding carry that
  // overflows the integer digits is still loud.
  assert.throws(() => canonicalizeSharesDecimal("1000000000000"), /exceeds bounds/)
  assert.throws(
    () => canonicalizeSharesDecimal("999999999999.9999999999995"),
    /exceeds bounds/,
  )
})

// A bigint is the obvious wrong guess for "an exact quantity", and it used to
// take the error renderer down with it: JSON.stringify refuses to serialize one,
// so the contract's RangeError was replaced by a TypeError from the message
// itself. A caller catching RangeError saw nothing and crashed instead.
test("a non-string quantity raises the contract's RangeError, not a serializer TypeError", () => {
  const nonStrings: unknown[] = [
    1n,
    -1n,
    1.5,
    true,
    null,
    undefined,
    { sharesDecimal: "1.5" },
    Symbol("shares"),
  ]
  for (const value of nonStrings) {
    for (const call of [
      () => assertSharesDecimal(value),
      () => assertSharesDecimal(value, { signed: true }),
      () => canonicalizeSharesDecimal(value),
      () => canonicalizeSharesDecimal(value, { signed: true }),
    ]) {
      assert.throws(
        call,
        { name: "RangeError", message: /canonical share quantity/ },
        String(typeof value),
      )
    }
  }
  // The rendering stays useful for the scalars, and never quotes an object's
  // contents — an unexpected object here is as likely to be a whole record.
  assert.throws(() => assertSharesDecimal(7n), /: 7n$/)
  assert.throws(() => assertSharesDecimal({ shares: "1.5" }), /: object$/)
})

test("canonicalized output always satisfies the strict assertion", () => {
  const raws = [
    "0",
    "2.5000",
    "1.7999999999999998",
    "0.9999999999995",
    "-1.0000000000005",
    "-0.0000000000004",
  ]
  for (const raw of raws) {
    const canonical = canonicalizeSharesDecimal(raw, { signed: true })
    assert.equal(assertSharesDecimal(canonical, { signed: true }), canonical, raw)
    assert.equal(canonicalizeSharesDecimal(canonical, { signed: true }), canonical, raw)
  }
})

test("valuing shares keeps the sign out of the magnitude digits", () => {
  // Holdings are the only caller today, so signed input is refused by default.
  assert.throws(() => sharesToValueCents("-1.5", 200n), /canonical share quantity/)
  assert.equal(sharesToValueCents("1.5", 200n), 300n)
  assert.equal(sharesToValueCents("-1.5", 200n, { signed: true }), -300n)
  // Half a cent rounds away from zero on both sides, not toward negative.
  assert.equal(sharesToValueCents("0.005", 100n), 1n)
  assert.equal(sharesToValueCents("-0.005", 100n, { signed: true }), -1n)
  assert.equal(sharesToValueCents("-0.004", 100n, { signed: true }), 0n)
})
