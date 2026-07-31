import type { FamilyMember } from "@vogel-vault/domain/family"
import {
  assertMarketQuoteSnapshot,
  selectNetWorth,
  type FinanceAccount,
  type FinanceDocument,
  type FinanceHolding,
  type FinanceLot,
  type MarketQuoteSnapshot,
  type NetWorthSelection,
} from "@vogel-vault/domain/finance"
import type { Sats } from "@vogel-vault/domain/money"

import type {
  VogelVaultFinanceDocument,
  VogelVaultFinanceHolding,
  VogelVaultFinanceLot,
  VogelVaultMarketQuoteSnapshot,
  VogelVaultRowErrorCode,
  VogelVaultRowRequest,
  VogelVaultRowResult,
} from "../../../shared/ipc.ts"

export type QueryFinanceRows = (request: VogelVaultRowRequest) => Promise<VogelVaultRowResult>

export type FinanceReadSlice<T> =
  | { readonly status: "live"; readonly value: T }
  | { readonly status: "empty"; readonly value: null }
  | { readonly status: "error"; readonly value: null; readonly code: VogelVaultRowErrorCode }

export interface LinuxFinanceReadModel {
  readonly finance: FinanceReadSlice<FinanceDocument>
  readonly marketQuotes: FinanceReadSlice<MarketQuoteSnapshot>
}

function financeLot(row: VogelVaultFinanceLot): FinanceLot {
  return {
    date: row.date,
    type: row.type,
    pricePerShareCents: row.pricePerShareCents,
    sharesDecimal: row.sharesDecimal,
    amountInvestedCents: row.amountInvestedCents,
    note: row.note ?? null,
  }
}

function financeHolding(row: VogelVaultFinanceHolding): FinanceHolding {
  return {
    name: row.name,
    category: row.category,
    ticker: row.ticker ?? null,
    valueCents: row.valueCents,
    costBasisCents: row.costBasisCents,
    gainBps: row.gainBps,
    sharesDecimal: row.sharesDecimal,
    avgCostCents: row.avgCostCents,
    currentPricePerShareCents: row.currentPricePerShareCents,
    isProxy: row.isProxy,
    proxyNote: row.proxyNote ?? null,
    lots: row.lots.map(financeLot),
  }
}

/**
 * Adapt the already-scoped Convex document without deriving totals.
 *
 * The document-level retirement total remains compatibility metadata. Consumers
 * use `selectFinanceNetWorth`, which totals account rows once and never adds
 * this stored projection on top of them.
 */
export function adaptFinanceDocument(row: VogelVaultFinanceDocument): FinanceDocument {
  const accounts: FinanceAccount[] = row.accounts.map((account) => ({
    key: account.key,
    owner: account.owner,
    provider: account.provider,
    totalValueCents: account.totalValueCents,
    weeklyContributionCents: account.weeklyContributionCents,
    weeklyContributionDay: account.weeklyContributionDay ?? null,
    holdings: account.holdings.map(financeHolding),
  }))
  return {
    updatedAtMs: row.updatedAtMs,
    lastUpdated: row.lastUpdated,
    retirementTotalCents: row.retirementTotalCents ?? null,
    accounts,
  }
}

/** Reassert the closed three-symbol contract at the renderer adapter edge. */
export function adaptMarketQuoteSnapshot(
  row: VogelVaultMarketQuoteSnapshot,
): MarketQuoteSnapshot {
  return assertMarketQuoteSnapshot({
    quotes: row.quotes.map((quote) => ({
      symbol: quote.symbol,
      priceCents: quote.priceCents,
      source: quote.source,
      fetchedAt: quote.fetchedAt,
      status: quote.status,
    })),
  })
}

/**
 * Load ledger and operational quote observations independently.
 *
 * A quote refresh failure must not hide synchronized retirement accounts, and a
 * missing finance document must not turn market observations into fabricated
 * holdings. The eventual UI lane can therefore render each state honestly.
 */
export async function loadLinuxFinanceReadModel(
  query: QueryFinanceRows,
  viewer: FamilyMember,
): Promise<LinuxFinanceReadModel> {
  const [financeResult, quotesResult] = await Promise.all([
    query({ kind: "finance", viewer, scope: "netWorth" }),
    query({ kind: "marketQuotes" }),
  ])

  const finance: FinanceReadSlice<FinanceDocument> =
    financeResult.status === "error"
      ? { status: "error", value: null, code: financeResult.code }
      : financeResult.kind !== "finance"
        ? { status: "error", value: null, code: "invalid-response" }
        : financeResult.value === null
          ? { status: "empty", value: null }
          : { status: "live", value: adaptFinanceDocument(financeResult.value) }

  let marketQuotes: FinanceReadSlice<MarketQuoteSnapshot>
  if (quotesResult.status === "error") {
    marketQuotes = { status: "error", value: null, code: quotesResult.code }
  } else if (quotesResult.kind !== "marketQuotes") {
    marketQuotes = { status: "error", value: null, code: "invalid-response" }
  } else {
    try {
      marketQuotes = { status: "live", value: adaptMarketQuoteSnapshot(quotesResult.value) }
    } catch {
      marketQuotes = { status: "error", value: null, code: "invalid-response" }
    }
  }

  return { finance, marketQuotes }
}

/**
 * Shared selector entry point for Linux.
 *
 * Net worth scopes accounts again as defense in depth and totals them exactly
 * once. Missing quotes make conversions unavailable rather than zero.
 */
export function selectFinanceNetWorth(input: {
  readonly viewer: FamilyMember
  readonly bitcoinSats: Sats
  readonly model: LinuxFinanceReadModel
}): NetWorthSelection {
  return selectNetWorth({
    viewer: input.viewer,
    bitcoinSats: input.bitcoinSats,
    financeAccounts: input.model.finance.status === "live"
      ? input.model.finance.value.accounts
      : [],
    quotes: input.model.marketQuotes.status === "live"
      ? input.model.marketQuotes.value.quotes
      : [],
  })
}
