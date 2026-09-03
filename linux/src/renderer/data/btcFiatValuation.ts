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
 * The structural input the legacy-decoding rule needs.
 *
 * Domain rows (`BTCAccount`, `BTCTotals`) and the IPC wire rows both satisfy
 * this shape, so there is exactly one decoder for both — the wire adapter maps
 * field names, never semantics. An embedded valuation's optional fields are
 * normalised to nulls here so partial wire values cannot masquerade as full
 * FiatValuation records.
 */
export type FiatValuationSource = {
  readonly sats: bigint
  readonly fiat: bigint
  readonly fiatValuation?: {
    readonly cents: bigint
    readonly priceCents?: bigint | null
    readonly quotedAt?: string | null
    readonly source?: string | null
    readonly confidence?: string | null
  } | null
}

/**
 * Resolve transition rows without treating a confident sats balance as a USD
 * valuation. Explicit availability wins; legacy positive-sats/zero-fiat rows
 * are conservatively unavailable.
 */
export function fiatValuationOf(value: FiatValuationSource): FiatValuation | null {
  if (Object.hasOwn(value, "fiatValuation")) {
    const embedded = value.fiatValuation
    if (embedded === null || embedded === undefined) return null
    return {
      cents: embedded.cents,
      priceCents: embedded.priceCents ?? null,
      quotedAt: embedded.quotedAt ?? null,
      source: embedded.source ?? null,
      confidence: embedded.confidence ?? null,
    }
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
