// The Vogel Vault — shared retirement, market quote, and net-worth contract.
//
// Convex finance rows are durable household data. Market quotes are a separate
// operational snapshot and must always carry provenance and freshness. Keeping
// those boundaries distinct prevents a device-local quote cache from looking
// like synchronized retirement data.

import { type FamilyMember, netWorthScopeFor } from "./family.ts"
import {
  type Cents,
  type Sats,
  satsToUsdCents,
  sharesToValueCents,
  sum,
  usdCentsToSats,
} from "./money.ts"
import {
  type MonthKey,
  type Transaction,
  budgetTransactionsFor,
  transactionsInMonth,
} from "./readModel.ts"

export const MARKET_SYMBOLS = ["BTC", "VOO", "IBIT"] as const
export type MarketSymbol = (typeof MARKET_SYMBOLS)[number]
export type MarketQuoteStatus = "live" | "stale" | "unavailable"

/**
 * One price observation. A live/stale quote has a positive integer-cent price;
 * unavailable has no price. No fixed or last-buy fallback may use this type.
 */
export interface MarketQuote {
  readonly symbol: MarketSymbol
  readonly priceCents: Cents | null
  readonly source: string
  readonly fetchedAt: string | null
  readonly status: MarketQuoteStatus
}

/** Closed three-symbol snapshot suitable for a client cache or future query. */
export interface MarketQuoteSnapshot {
  readonly quotes: readonly MarketQuote[]
}

export function isMarketSymbol(value: unknown): value is MarketSymbol {
  return typeof value === "string" && (MARKET_SYMBOLS as readonly string[]).includes(value)
}

/** Refuse contradictory quote states at the adapter boundary. */
export function assertMarketQuote(quote: MarketQuote): MarketQuote {
  if (!isMarketSymbol(quote.symbol)) {
    throw new RangeError(`Unsupported market symbol: ${quote.symbol as string}`)
  }
  if (quote.status !== "live" && quote.status !== "stale" && quote.status !== "unavailable") {
    throw new RangeError(`Unsupported market quote status: ${quote.status as string}`)
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
  if (quote.fetchedAt === null || !isCanonicalIsoInstant(quote.fetchedAt)) {
    throw new RangeError(
      `${quote.status} ${quote.symbol} quote must carry a canonical ISO-8601 fetchedAt`,
    )
  }
  return quote
}

const CANONICAL_ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/

/** Accept canonical UTC whole seconds or exactly three millisecond digits. */
function isCanonicalIsoInstant(value: string): boolean {
  if (!CANONICAL_ISO_INSTANT.test(value)) return false

  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) return false
  const normalized = new Date(millis).toISOString()
  return value === normalized || value === normalized.replace(".000Z", "Z")
}

/**
 * Validate the minimal snapshot: every fixed symbol appears exactly once.
 *
 * Transport wrappers may add fields, but the symbol union and cardinality stay
 * closed so a caller can never turn the quote service into an arbitrary ticker
 * or URL proxy.
 */
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

export function usableMarketQuote(
  quotes: readonly MarketQuote[],
  symbol: MarketSymbol,
): MarketQuote | null {
  const quote = marketQuoteFor(quotes, symbol)
  return quote?.status === "live" || quote?.status === "stale" ? quote : null
}

// ── Synced finance document ─────────────────────────────────────────────────

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
  /** Synced schedule metadata (for example, "Friday"), not a trade instruction. */
  readonly weeklyContributionDay: string | null
  readonly holdings: readonly FinanceHolding[]
}

export interface FinanceDocument {
  readonly updatedAtMs: number
  readonly lastUpdated: string
  /**
   * Stored compatibility projection. Net worth derives scoped accounts instead
   * of adding this value, which would double-count the same retirement assets.
   */
  readonly retirementTotalCents: Cents | null
  readonly accounts: readonly FinanceAccount[]
}

export interface HoldingValuation {
  readonly holding: FinanceHolding
  readonly valueCents: Cents
  readonly basis: "market-quote" | "stored-value"
  readonly quote: MarketQuote | null
}

export interface AccountValuation {
  readonly account: FinanceAccount
  readonly valueCents: Cents
  readonly holdings: readonly HoldingValuation[]
}

/**
 * Revalue VOO/IBIT from the operational quote snapshot. Other holdings retain
 * their synchronized stored value. A missing quote falls back visibly through
 * `basis: stored-value`; callers must not label it live.
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
    const marketValueCents = sharesToValueCents(holding.sharesDecimal, priceCents)
    if (holding.valueCents > 0n && /^0(?:\.0+)?$/.test(holding.sharesDecimal)) {
      return {
        holding,
        valueCents: holding.valueCents,
        basis: "stored-value",
        quote,
      }
    }
    return {
      holding,
      valueCents: marketValueCents,
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

/**
 * Value an account once. Holdings are the detail when present; the account
 * projection is only a fallback when there is no positive holding total.
 */
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
  readonly bitcoinSats: Sats
  readonly bitcoinValueCents: Cents | null
  readonly retirementValueCents: Cents
  readonly retirementValueSats: Sats | null
  readonly totalValueCents: Cents | null
  readonly totalValueSats: Sats | null
  readonly accounts: readonly AccountValuation[]
  readonly btcQuote: MarketQuote | null
}

/**
 * Select one profile's net worth without double-counting.
 *
 * `bitcoinSats` is the canonical already-scoped BTC balance. Retirement is
 * derived from net-worth-scoped accounts exactly once; the document-level
 * retirement total is intentionally not an input. USD/BTC combined totals are
 * unavailable when a positive BTC market quote is unavailable.
 */
export function selectNetWorth(input: {
  readonly viewer: FamilyMember
  readonly bitcoinSats: Sats
  readonly financeAccounts: readonly FinanceAccount[]
  readonly quotes: readonly MarketQuote[]
}): NetWorthSelection {
  const scopedAccounts = netWorthScopeFor(input.viewer, input.financeAccounts)
  const accounts = scopedAccounts.map((account) => valueFinanceAccount(account, input.quotes))
  const retirementValueCents = sum(accounts.map((account) => account.valueCents))
  const btcObservation = marketQuoteFor(input.quotes, "BTC")
  const btcQuote = btcObservation?.status === "live" || btcObservation?.status === "stale"
    ? btcObservation
    : null

  if (!btcQuote) {
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

// ── Budget selectors ────────────────────────────────────────────────────────

export type BudgetHealthStatus = "on-track" | "close" | "over"

export interface BudgetHealth {
  readonly status: BudgetHealthStatus
  readonly label: "ON TRACK" | "CLOSE" | "OVER"
  /** Truncated whole percentage, capped at 200% like the iOS presentation. */
  readonly usedPercent: number
  /** 0...10000 for a progress bar capped at its full width. */
  readonly barBasisPoints: number
  readonly remainingPercent: number | null
  readonly overPercent: number | null
}

/**
 * Match BudgetView's traffic-light boundaries without floating point:
 * green below 85%, yellow from 85% through exactly 100%, red only above 100%.
 */
export function budgetHealth(plannedCents: Cents, spentCents: Cents): BudgetHealth {
  if (plannedCents <= 0n) {
    const isOver = spentCents > plannedCents
    return {
      status: isOver ? "over" : "on-track",
      label: isOver ? "OVER" : "ON TRACK",
      usedPercent: isOver ? 200 : 0,
      barBasisPoints: isOver ? 10_000 : 0,
      remainingPercent: isOver ? null : 100,
      overPercent: isOver ? 100 : null,
    }
  }

  const rawBasisPoints = (spentCents * 10_000n) / plannedCents
  const visualBasisPoints = clampBigInt(rawBasisPoints, 0n, 20_000n)
  const isOver = spentCents > plannedCents
  const isClose = rawBasisPoints >= 8_500n && !isOver
  const status: BudgetHealthStatus = isOver ? "over" : isClose ? "close" : "on-track"
  const remainingPercent = isOver
    ? null
    : Number(((plannedCents - spentCents) * 100n) / plannedCents)
  const overPercent = isOver
    ? Number(clampBigInt(((spentCents - plannedCents) * 100n) / plannedCents, 0n, 100n))
    : null

  return {
    status,
    label: status === "over" ? "OVER" : status === "close" ? "CLOSE" : "ON TRACK",
    usedPercent: Number(visualBasisPoints / 100n),
    barBasisPoints: Number(clampBigInt(visualBasisPoints, 0n, 10_000n)),
    remainingPercent,
    overPercent,
  }
}

/**
 * Exact category drill-down rows for one viewer and budget month.
 *
 * Preserve source order and include credits/refunds so editing the detail rows
 * cannot disagree with the signed category spend shown by the budget.
 */
export function budgetCategoryTransactionsFor(
  viewer: FamilyMember,
  transactions: readonly Transaction[],
  month: MonthKey,
  category: string,
): Transaction[] {
  return transactionsInMonth(budgetTransactionsFor(viewer, transactions), month)
    .filter((transaction) => transaction.category === category)
}

function clampBigInt(value: bigint, minimum: bigint, maximum: bigint): bigint {
  if (value < minimum) return minimum
  if (value > maximum) return maximum
  return value
}
