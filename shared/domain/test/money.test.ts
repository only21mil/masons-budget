// Money is Decimal, never Double (AGENTS.md). JavaScript has no Decimal, so the
// shared layer parses the lexical form straight into integer minor units. These
// tests pin the cases where a naive `value * 100` would drift.

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  SATS_PER_BTC,
  basisPoints,
  formatBtc,
  formatSats,
  formatUsd,
  parseBtcToSats,
  parseCents,
  satsToUsdCents,
  sum,
} from "../src/money.ts"

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
