// Shared retirement, market-quote, and net-worth contracts.
//
// Retirement rows are synchronized household data. Quotes are operational
// observations with independent availability and freshness. Keeping the two
// contracts separate prevents a cache observation from masquerading as a
// durable holding value.

import { type FamilyMember, netWorthScopeFor } from "./family.ts"
import {
  type Cents,
  type Sats,
  satsToUsdCents,
  sharesToValueCents,
  sum,
  usdCentsToSats,
} from "./money.ts"

export const MARKET_SYMBOLS = ["BTC", "VOO", "IBIT"] as const
export type MarketSymbol = (typeof MARKET_SYMBOLS)[number]
export type MarketQuoteStatus = "live" | "stale" | "unavailable"

/**
 * A single evidenced market observation.
 *
 * Live and stale observations carry a positive integer-cent price and fetch
 * time. Unavailable is explicit and carries no price; it is never `$0.00`.
 */
export interface MarketQuote {
  readonly symbol: MarketSymbol
  readonly priceCents: Cents | null
  readonly source: string
  readonly fetchedAt: string | null
  readonly status: MarketQuoteStatus
}

/** Structurally complete even when one or more observations are unavailable. */
export interface MarketQuoteSnapshot {
  readonly quotes: readonly MarketQuote[]
}

export function isMarketSymbol(value: unknown): value is MarketSymbol {
  return typeof value === "string" && (MARKET_SYMBOLS as readonly string[]).includes(value)
}

/** Refuse contradictory observation states at an adapter boundary. */
export function assertMarketQuote(quote: MarketQuote): MarketQuote {
  if (!isMarketSymbol(quote.symbol)) {
    throw new RangeError(`Unsupported market symbol: ${String(quote.symbol)}`)
  }
  if (quote.status !== "live" && quote.status !== "stale" && quote.status !== "unavailable") {
    throw new RangeError(`Unsupported market quote status: ${String(quote.status)}`)
  }
  if (quote.source.trim() === "") throw new RangeError("Market quote source must not be empty")

  if (quote.status === "unavailable") {
    if (quote.priceCents !== null) {
      throw new RangeError(`Unavailable ${quote.symbol} quote must not carry a price`)
    }
    return quote
  }

  if (quote.priceCents === null || quote.priceCents <= 0n) {
    throw new RangeError(`${quote.status} ${quote.symbol} quote must carry a positive price`)
  }
  if (quote.fetchedAt === null || quote.fetchedAt.trim() === "") {
    throw new RangeError(`${quote.status} ${quote.symbol} quote must carry fetchedAt`)
  }
  return quote
}

/** Require exactly one BTC, VOO, and IBIT entry. */
export function assertMarketQuoteSnapshot(snapshot: MarketQuoteSnapshot): MarketQuoteSnapshot {
  if (snapshot.quotes.length !== MARKET_SYMBOLS.length) {
    throw new RangeError(`Market quote snapshot must contain ${MARKET_SYMBOLS.length} quotes`)
  }

  const seen = new Set<MarketSymbol>()
  for (const quote of snapshot.quotes) {
    assertMarketQuote(quote)
    if (seen.has(quote.symbol)) throw new RangeError(`Duplicate market quote: ${quote.symbol}`)
    seen.add(quote.symbol)
  }
  for (const symbol of MARKET_SYMBOLS) {
    if (!seen.has(symbol)) throw new RangeError(`Missing market quote: ${symbol}`)
  }
  return snapshot
}

/** Return an observation including explicit unavailable state, or null if absent. */
export function marketQuoteFor(
  quotes: readonly MarketQuote[],
  symbol: MarketSymbol,
): MarketQuote | null {
  const quote = quotes.find((candidate) => candidate.symbol === symbol) ?? null
  return quote === null ? null : assertMarketQuote(quote)
}

/** Live and stale are usable; unavailable and absent are not. */
export function usableMarketQuote(
  quotes: readonly MarketQuote[],
  symbol: MarketSymbol,
): MarketQuote | null {
  const quote = marketQuoteFor(quotes, symbol)
  return quote?.status === "live" || quote?.status === "stale" ? quote : null
}

export interface FinanceLot {
  readonly date: string
  readonly type: string
  readonly pricePerShareCents: Cents
  readonly sharesDecimal: string
  readonly amountInvestedCents: Cents
  readonly note: string | null
}

export interface FinanceHolding {
  readonly name: string
  readonly category: string
  readonly ticker: string | null
  readonly valueCents: Cents
  readonly costBasisCents: Cents
  readonly gainBps: bigint
  readonly sharesDecimal: string
  readonly avgCostCents: Cents
  readonly currentPricePerShareCents: Cents
  readonly isProxy: boolean
  readonly proxyNote: string | null
  readonly lots: readonly FinanceLot[]
}

export interface FinanceAccount {
  readonly key: string
  readonly owner: FamilyMember
  readonly provider: string
  readonly totalValueCents: Cents
  readonly weeklyContributionCents: Cents
  /** Schedule metadata such as "Friday"; never a trade instruction. */
  readonly weeklyContributionDay: string | null
  readonly holdings: readonly FinanceHolding[]
}

export interface FinanceDocument {
  readonly updatedAtMs: number
  readonly lastUpdated: string
  /** Compatibility projection only; selectors derive scoped accounts once. */
  readonly retirementTotalCents: Cents | null
  readonly accounts: readonly FinanceAccount[]
}

export type HoldingValuationBasis = "market-quote" | "stored-value"

export interface HoldingValuation {
  readonly holding: FinanceHolding
  readonly valueCents: Cents
  readonly basis: HoldingValuationBasis
  /** Includes explicit unavailable state when the snapshot supplied it. */
  readonly quote: MarketQuote | null
}

export interface AccountValuation {
  readonly account: FinanceAccount
  readonly valueCents: Cents
  readonly holdings: readonly HoldingValuation[]
}

/**
 * Revalue VOO/IBIT from a usable quote. Other holdings keep their synchronized
 * stored value. Stale observations are usable but remain labeled stale.
 */
export function valueFinanceHolding(
  holding: FinanceHolding,
  quotes: readonly MarketQuote[],
): HoldingValuation {
  const ticker = holding.ticker?.trim().toUpperCase() ?? ""
  const symbol: MarketSymbol | null = ticker === "VOO" || ticker === "IBIT" ? ticker : null
  const observation = symbol === null ? null : marketQuoteFor(quotes, symbol)
  const quote = observation?.status === "live" || observation?.status === "stale"
    ? observation
    : null

  if (quote !== null) {
    const priceCents = quote.priceCents
    if (priceCents === null) throw new RangeError(`${quote.symbol} quote lost its validated price`)
    return {
      holding,
      valueCents: sharesToValueCents(holding.sharesDecimal, priceCents),
      basis: "market-quote",
      quote,
    }
  }

  return {
    holding,
    valueCents: holding.valueCents,
    basis: "stored-value",
    quote: observation,
  }
}

/** Holdings are detail when their sum is positive; account total is fallback-only. */
export function valueFinanceAccount(
  account: FinanceAccount,
  quotes: readonly MarketQuote[],
): AccountValuation {
  const holdings = account.holdings.map((holding) => valueFinanceHolding(holding, quotes))
  const holdingTotal = sum(holdings.map((holding) => holding.valueCents))
  return {
    account,
    valueCents: holdingTotal > 0n ? holdingTotal : account.totalValueCents,
    holdings,
  }
}

export interface NetWorthSelection {
  /** Canonical already-net-worth-scoped Bitcoin balance supplied by the adapter. */
  readonly bitcoinSats: Sats
  readonly bitcoinValueCents: Cents | null
  readonly retirementValueCents: Cents
  readonly retirementValueSats: Sats | null
  readonly totalValueCents: Cents | null
  readonly totalValueSats: Sats | null
  readonly accounts: readonly AccountValuation[]
  /** Preserves live, stale, unavailable, or absent quote state. */
  readonly btcQuote: MarketQuote | null
}

/**
 * Adult household net worth is eligible Bitcoin plus adult retirement once.
 *
 * The adapter must supply the canonical Bitcoin balance already scoped for net
 * worth. Retirement accounts are defense-in-depth scoped here, excluding child
 * accounts from adult totals even though adults may see those accounts. The
 * document-level retirement projection is intentionally not an input.
 */
export function selectNetWorth(input: {
  readonly viewer: FamilyMember
  readonly bitcoinSats: Sats
  readonly financeAccounts: readonly FinanceAccount[]
  readonly quotes: readonly MarketQuote[]
}): NetWorthSelection {
  const accounts = netWorthScopeFor(input.viewer, input.financeAccounts)
    .map((account) => valueFinanceAccount(account, input.quotes))
  const retirementValueCents = sum(accounts.map((account) => account.valueCents))
  const btcObservation = marketQuoteFor(input.quotes, "BTC")
  const btcQuote = btcObservation?.status === "live" || btcObservation?.status === "stale"
    ? btcObservation
    : null

  if (btcQuote === null) {
    return {
      bitcoinSats: input.bitcoinSats,
      bitcoinValueCents: null,
      retirementValueCents,
      retirementValueSats: null,
      totalValueCents: null,
      totalValueSats: null,
      accounts,
      btcQuote: btcObservation,
    }
  }

  const btcPriceCents = btcQuote.priceCents
  if (btcPriceCents === null) throw new RangeError("BTC quote lost its validated price")
  const bitcoinValueCents = satsToUsdCents(input.bitcoinSats, btcPriceCents)
  const retirementValueSats = usdCentsToSats(retirementValueCents, btcPriceCents)
  return {
    bitcoinSats: input.bitcoinSats,
    bitcoinValueCents,
    retirementValueCents,
    retirementValueSats,
    totalValueCents: bitcoinValueCents + retirementValueCents,
    totalValueSats: input.bitcoinSats + retirementValueSats,
    accounts,
    btcQuote,
  }
}
