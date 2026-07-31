import type { FamilyMember } from "@vogel-vault/domain/family"
import { visibleTo } from "@vogel-vault/domain/family"
import {
  SATS_PER_BTC,
  formatBtc,
  formatSats,
  formatUsd,
  satsToUsdCents,
} from "@vogel-vault/domain/money"
import type { Freshness, BTCBuy } from "@vogel-vault/domain/readModel"

export const DISPLAY_UNITS = [
  { storageKey: "btc", label: "BTC" },
  { storageKey: "sats", label: "SATS" },
  { storageKey: "usd", label: "USD" },
] as const

export type DisplayUnit = (typeof DISPLAY_UNITS)[number]["storageKey"]

export const PRICE_UNAVAILABLE = "Price unavailable"

export interface DisplayAmount {
  /** Exact ledger quantity, when the source records sats. */
  readonly sats?: bigint | null
  /** Exact ledger quantity, when the source records USD cents. */
  readonly usdCents?: bigint | null
}

export interface RecordedBitcoinPrice {
  readonly cents: bigint
  readonly date: string
}

export function displayUnitFromStorageKey(value: string | null | undefined): DisplayUnit {
  return DISPLAY_UNITS.some((unit) => unit.storageKey === value)
    ? value as DisplayUnit
    : "btc"
}

/**
 * Format one exact satoshi value in the selected presentation unit.
 *
 * USD requires an explicitly supplied positive integer-cent price. Missing,
 * zero, and negative prices are unknown rather than a confident "$0.00".
 */
export function formatBitcoin(
  sats: bigint,
  unit: DisplayUnit,
  btcPriceCents?: bigint | null,
): string {
  switch (unit) {
    case "btc":
      return formatBtc(sats)
    case "sats":
      return formatSats(sats)
    case "usd":
      return btcPriceCents !== null &&
        btcPriceCents !== undefined &&
        btcPriceCents > 0n
        ? formatUsd(satsToUsdCents(sats, btcPriceCents))
        : PRICE_UNAVAILABLE
  }
}

/**
 * The renderer's cross-unit quote contract.
 *
 * Only the explicit BTC quote delivered with a live or stale canonical balance
 * read may convert a value whose native unit differs from the selected unit.
 * Demo/loading/empty/error reads, absent quotes, and non-positive quotes do not
 * become an inferred price from buys, bill pays, or transaction arithmetic.
 */
export function availableBtcQuote(
  status: Freshness,
  btcPriceCents: bigint | null | undefined,
): bigint | null {
  return (status === "live" || status === "stale") &&
    btcPriceCents !== null &&
    btcPriceCents !== undefined &&
    btcPriceCents > 0n
    ? btcPriceCents
    : null
}

/** Convert cents to sats with the same half-away-from-zero rule as sats->USD. */
export function usdCentsToSats(
  usdCents: bigint,
  btcPriceCents: bigint,
): bigint | null {
  if (btcPriceCents <= 0n) return null
  const numerator = usdCents * SATS_PER_BTC
  const half = btcPriceCents / 2n
  return numerator >= 0n
    ? (numerator + half) / btcPriceCents
    : -((-numerator + half) / btcPriceCents)
}

/**
 * Format an amount in the selected unit, preferring the source's exact native
 * value and converting only through the explicit quote contract.
 */
export function formatDisplayAmount(
  amount: DisplayAmount,
  unit: DisplayUnit,
  btcPriceCents: bigint | null,
): string {
  if (unit === "usd") {
    if (amount.usdCents !== null && amount.usdCents !== undefined) {
      return formatUsd(amount.usdCents)
    }
    return amount.sats !== null && amount.sats !== undefined && btcPriceCents !== null
      ? formatUsd(satsToUsdCents(amount.sats, btcPriceCents))
      : PRICE_UNAVAILABLE
  }

  let sats = amount.sats
  if ((sats === null || sats === undefined) &&
      amount.usdCents !== null &&
      amount.usdCents !== undefined &&
      btcPriceCents !== null) {
    sats = usdCentsToSats(amount.usdCents, btcPriceCents)
  }
  if (sats === null || sats === undefined) return PRICE_UNAVAILABLE
  return unit === "btc" ? formatBtc(sats) : formatSats(sats)
}

/**
 * The USD reference is the newest buy this viewer can see.
 *
 * Do not fall back to account fiat totals, an older buy, or a bill-pay price.
 * The selected buy's date travels with the price so callers cannot present the
 * result as live. A newest row without a positive price makes USD unavailable.
 */
export function newestVisibleBuyPrice(
  viewer: FamilyMember,
  buys: readonly BTCBuy[],
): RecordedBitcoinPrice | null {
  const latest = visibleTo(viewer, buys).reduce<BTCBuy | null>(
    (current, buy) => current === null || buy.date > current.date ? buy : current,
    null,
  )

  if (latest === null || latest.priceUsd <= 0n) return null
  return { cents: latest.priceUsd, date: latest.date }
}
