import type {
  BTCAccount,
  BTCSnapshot,
  BTCTotals,
} from "@vogel-vault/domain/readModel"

export interface FiatValuation {
  readonly cents: bigint
  readonly priceCents: bigint | null
  readonly quotedAt: string | null
  readonly source: string | null
  readonly confidence: string | null
}

export type BTCAccountWithFiatValuation = BTCAccount & {
  readonly fiatValuation?: FiatValuation | null
}

export type BTCTotalsWithFiatValuation = BTCTotals & {
  readonly fiatValuation?: FiatValuation | null
}

export type BTCSnapshotWithFiatAvailability = BTCSnapshot & {
  /** Confidence in the sats balance only. */
  readonly balanceConfidence?: string | null
}

/**
 * Resolve transition rows without treating a confident sats balance as a USD
 * valuation. Explicit availability wins; legacy positive-sats/zero-fiat rows
 * are conservatively unavailable.
 */
export function fiatValuationOf(
  value: BTCAccount | BTCTotals,
): FiatValuation | null {
  const transition = value as BTCAccountWithFiatValuation | BTCTotalsWithFiatValuation
  if (Object.hasOwn(transition, "fiatValuation")) {
    return transition.fiatValuation ?? null
  }
  if (value.sats > 0n && value.fiat === 0n) return null
  return {
    cents: value.fiat,
    priceCents: null,
    quotedAt: null,
    source: null,
    confidence: null,
  }
}

export function fiatCentsOf(value: BTCAccount | BTCTotals): bigint | null {
  return fiatValuationOf(value)?.cents ?? null
}
