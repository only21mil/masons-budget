// The renderer's Bitcoin display composition.
//
// The unit tokens themselves (DISPLAY_UNITS, DisplayUnit,
// PRICE_UNAVAILABLE, displayUnitFromStorageKey, formatBitcoin,
// usdCentsToSats) live in `@vogel-vault/domain/money` and are re-exported
// here — one definition, shared with iOS and Android, so a divergence between
// pages and clients cannot compile. This module adds only the composition the
// renderer needs on top: the quote gate, the mixed-native-unit formatter, and
// the newest-visible-buy price.

import type { FamilyMember } from "@vogel-vault/domain/family"
import { visibleTo } from "@vogel-vault/domain/family"
import { type MarketQuote, usableMarketQuote } from "@vogel-vault/domain/finance"
import {
  type DisplayUnit,
  PRICE_UNAVAILABLE,
  formatBtc,
  formatSats,
  formatUsd,
  satsToUsdCents,
  usdCentsToSats,
} from "@vogel-vault/domain/money"
import type { BTCBuy } from "@vogel-vault/domain/readModel"

export {
  DISPLAY_UNITS,
  PRICE_UNAVAILABLE,
  displayUnitFromStorageKey,
  formatBitcoin,
  usdCentsToSats,
} from "@vogel-vault/domain/money"
export type { DisplayUnit } from "@vogel-vault/domain/money"

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

/**
 * The renderer's cross-unit quote contract.
 *
 * Only the operational MarketQuote snapshot may convert a value whose native
 * unit differs from the selected unit. The shared domain validator guarantees
 * that returned quotes are live or explicitly stale with a positive price.
 * Balance ratios, buys, bill pays, and transaction arithmetic are never quotes.
 */
export function availableBtcQuote(
  quotes: readonly MarketQuote[],
): MarketQuote | null {
  return usableMarketQuote(quotes, "BTC")
}

/**
 * Format an amount in the selected unit, preferring the source's exact native
 * value and converting only through the explicit quote contract.
 *
 * `usdCentsToSats` throws on a non-positive price, so a price the shared
 * contract refuses yields PRICE_UNAVAILABLE here rather than an exception on a
 * render path — the same sentinel every other unavailable conversion produces.
 */
export function formatDisplayAmount(
  amount: DisplayAmount,
  unit: DisplayUnit,
  btcPriceCents: bigint | null,
): string {
  const usablePrice = btcPriceCents !== null && btcPriceCents > 0n

  if (unit === "usd") {
    if (amount.usdCents !== null && amount.usdCents !== undefined) {
      return formatUsd(amount.usdCents)
    }
    return amount.sats !== null && amount.sats !== undefined && usablePrice
      ? formatUsd(satsToUsdCents(amount.sats, btcPriceCents))
      : PRICE_UNAVAILABLE
  }

  let sats = amount.sats
  if ((sats === null || sats === undefined) &&
      amount.usdCents !== null &&
      amount.usdCents !== undefined &&
      usablePrice) {
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
