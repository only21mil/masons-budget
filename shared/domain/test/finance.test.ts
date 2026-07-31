import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
  type FinanceAccount,
  type FinanceHolding,
  type MarketQuote,
  type MarketQuoteStatus,
  type MarketSymbol,
  assertMarketQuote,
  assertMarketQuoteSnapshot,
  budgetCategoryTransactionsFor,
  budgetHealth,
  selectNetWorth,
  valueFinanceAccount,
} from "../src/finance.ts"
import { type FamilyMember } from "../src/family.ts"
import { sharesToValueCents, usdCentsToSats } from "../src/money.ts"
import { type Transaction } from "../src/readModel.ts"

interface FixtureQuote {
  symbol: MarketSymbol
  priceCents: string | null
  source: string
  fetchedAt: string | null
  status: MarketQuoteStatus
}

interface FixtureAccount {
  key: string
  owner: FamilyMember
  provider: string
  totalValueCents: string
  weeklyContributionCents: string
  weeklyContributionDay: string | null
  holdings: Array<{
    name: string
    category: string
    ticker: string | null
    valueCents: string
    sharesDecimal: string
  }>
}

interface FinanceFixtures {
  rounding: string
  marketSnapshot: { quotes: FixtureQuote[] }
  usdToSats: Array<{
    label: string
    cents: string
    btcPriceCents: string
    expectedSats: string
  }>
  shareValuations: Array<{
    label: string
    sharesDecimal: string
    pricePerShareCents: string
    expectedValueCents: string
  }>
  budgetHealth: Array<{
    label: string
    plannedCents: string
    spentCents: string
    expected: {
      status: string
      label: string
      usedPercent: number
      barBasisPoints: number
      remainingPercent: number | null
      overPercent: number | null
    }
  }>
  categoryScope: {
    month: string
    category: string
    transactions: Array<{
      id: string
      date: string
      merchant: string
      amountCents: string
      category: string
      owner: FamilyMember
    }>
    profiles: Array<{ viewer: FamilyMember; expectedIds: string[] }>
  }
  netWorth: {
    bitcoinSats: string
    storedRetirementTotalCents: string
    accounts: FixtureAccount[]
    expectedAdult: {
      accountKeys: string[]
      retirementValueCents: string
      bitcoinValueCents: string
      retirementValueSats: string
      totalValueCents: string
      totalValueSats: string
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "finance-market-cases.json"), "utf8"),
) as FinanceFixtures

function quote(row: FixtureQuote): MarketQuote {
  return {
    symbol: row.symbol,
    priceCents: row.priceCents === null ? null : BigInt(row.priceCents),
    source: row.source,
    fetchedAt: row.fetchedAt,
    status: row.status,
  }
}

function holding(row: FixtureAccount["holdings"][number]): FinanceHolding {
  return {
    name: row.name,
    category: row.category,
    ticker: row.ticker,
    valueCents: BigInt(row.valueCents),
    costBasisCents: 0n,
    gainBps: 0n,
    sharesDecimal: row.sharesDecimal,
    avgCostCents: 0n,
    currentPricePerShareCents: 0n,
    isProxy: false,
    proxyNote: null,
    lots: [],
  }
}

function account(row: FixtureAccount): FinanceAccount {
  return {
    key: row.key,
    owner: row.owner,
    provider: row.provider,
    totalValueCents: BigInt(row.totalValueCents),
    weeklyContributionCents: BigInt(row.weeklyContributionCents),
    weeklyContributionDay: row.weeklyContributionDay,
    holdings: row.holdings.map(holding),
  }
}

const quotes = fixtures.marketSnapshot.quotes.map(quote)
const accounts = fixtures.netWorth.accounts.map(account)

test("shared quote snapshot is a closed BTC, VOO, and IBIT set", () => {
  assert.deepEqual(
    assertMarketQuoteSnapshot({ quotes }).quotes.map((entry) => entry.symbol),
    ["BTC", "VOO", "IBIT"],
  )
  assert.equal(assertMarketQuote(quotes[2]!).status, "stale", "stale is explicit but usable")

  assert.throws(
    () => assertMarketQuoteSnapshot({ quotes: [quotes[0]!, quotes[0]!, quotes[2]!] }),
    /Duplicate market quote/,
  )
  assert.throws(
    () => assertMarketQuote({ ...quotes[0]!, status: "unavailable" }),
    /must not carry a price/,
  )
  assert.throws(
    () => assertMarketQuote({ ...quotes[0]!, priceCents: 0n }),
    /positive price/,
  )
  assert.throws(
    () => assertMarketQuote({ ...quotes[0]!, status: "fresh" as MarketQuoteStatus }),
    /Unsupported market quote status/,
  )
})

test("shared exact conversion vectors match half-away rounding", () => {
  assert.equal(fixtures.rounding, "half away from zero")
  for (const row of fixtures.usdToSats) {
    assert.equal(
      usdCentsToSats(BigInt(row.cents), BigInt(row.btcPriceCents)),
      BigInt(row.expectedSats),
      row.label,
    )
  }
  assert.throws(() => usdCentsToSats(1n, 0n), /must be positive/)
})

test("shared fractional-share vectors never use floating point", () => {
  for (const row of fixtures.shareValuations) {
    assert.equal(
      sharesToValueCents(row.sharesDecimal, BigInt(row.pricePerShareCents)),
      BigInt(row.expectedValueCents),
      row.label,
    )
  }
  assert.throws(() => sharesToValueCents("1.2.3", 100n), /Not a decimal share quantity/)
})

test("budget health matches iOS green, yellow, red, and percentage boundaries", () => {
  for (const row of fixtures.budgetHealth) {
    assert.deepEqual(
      budgetHealth(BigInt(row.plannedCents), BigInt(row.spentCents)),
      row.expected,
      row.label,
    )
  }
})

test("category drill-down scopes viewer, exact month, and exact category", () => {
  const transactions: Transaction[] = fixtures.categoryScope.transactions.map((row) => ({
    id: row.id,
    updatedAtMs: 1,
    date: row.date,
    merchant: row.merchant,
    amount: BigInt(row.amountCents),
    category: row.category,
    card: null,
    note: null,
    owner: row.owner,
  }))

  for (const profile of fixtures.categoryScope.profiles) {
    const selected = budgetCategoryTransactionsFor(
      profile.viewer,
      transactions,
      fixtures.categoryScope.month,
      fixtures.categoryScope.category,
    )
    assert.deepEqual(selected.map((row) => row.id), profile.expectedIds, profile.viewer)
  }

  const adultRows = budgetCategoryTransactionsFor(
    "victor",
    transactions,
    fixtures.categoryScope.month,
    fixtures.categoryScope.category,
  )
  assert.ok(adultRows.some((row) => row.amount < 0n), "refund remains editable in drill-down")
})

test("net worth scopes adult accounts and values each retirement asset once", () => {
  const result = selectNetWorth({
    viewer: "victor",
    bitcoinSats: BigInt(fixtures.netWorth.bitcoinSats),
    financeAccounts: accounts,
    quotes,
  })
  const expected = fixtures.netWorth.expectedAdult

  assert.deepEqual(result.accounts.map((entry) => entry.account.key), expected.accountKeys)
  assert.equal(result.retirementValueCents, BigInt(expected.retirementValueCents))
  assert.equal(result.bitcoinValueCents, BigInt(expected.bitcoinValueCents))
  assert.equal(result.retirementValueSats, BigInt(expected.retirementValueSats))
  assert.equal(result.totalValueCents, BigInt(expected.totalValueCents))
  assert.equal(result.totalValueSats, BigInt(expected.totalValueSats))
  assert.notEqual(
    result.retirementValueCents,
    BigInt(fixtures.netWorth.storedRetirementTotalCents),
    "document projection is not added to scoped account values",
  )

  const victorAccount = result.accounts.find((entry) => entry.account.key === "victor-401k")
  assert.ok(victorAccount)
  assert.deepEqual(
    victorAccount.holdings.map((entry) => entry.basis),
    ["market-quote", "market-quote", "stored-value"],
  )
})

test("account total is fallback-only and missing BTC quote suppresses combined totals", () => {
  const rachel = accounts.find((entry) => entry.key === "rachel-401k")
  assert.ok(rachel)
  assert.equal(valueFinanceAccount(rachel, quotes).valueCents, rachel.totalValueCents)

  const unavailableBtc: MarketQuote[] = quotes.map((entry) =>
    entry.symbol === "BTC"
      ? {
          symbol: "BTC",
          priceCents: null,
          source: "Vogel Vault",
          fetchedAt: null,
          status: "unavailable",
        }
      : entry,
  )
  const result = selectNetWorth({
    viewer: "victor",
    bitcoinSats: BigInt(fixtures.netWorth.bitcoinSats),
    financeAccounts: accounts,
    quotes: unavailableBtc,
  })
  assert.equal(result.retirementValueCents, BigInt(fixtures.netWorth.expectedAdult.retirementValueCents))
  assert.equal(result.bitcoinValueCents, null)
  assert.equal(result.retirementValueSats, null)
  assert.equal(result.totalValueCents, null)
  assert.equal(result.totalValueSats, null)
})
