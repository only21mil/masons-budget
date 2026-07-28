import type { FamilyMember } from "@vogel-vault/domain/family"
import { visibleTo } from "@vogel-vault/domain/family"
import {
  formatBtc,
  formatSats,
  formatUsd,
  satsToUsdCents,
} from "@vogel-vault/domain/money"
import type { BTCBuy } from "@vogel-vault/domain/readModel"

export const DISPLAY_UNITS = [
  { storageKey: "btc", label: "BTC" },
  { storageKey: "sats", label: "SATS" },
  { storageKey: "usd", label: "USD" },
] as const

export type DisplayUnit = (typeof DISPLAY_UNITS)[number]["storageKey"]

export const PRICE_UNAVAILABLE = "Price unavailable"

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
