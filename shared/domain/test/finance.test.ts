import assert from "node:assert/strict"
import { test } from "node:test"

import {
  type FinanceAccount,
  type FinanceHolding,
  type MarketQuote,
  type MarketQuoteStatus,
  assertMarketQuote,
  assertMarketQuoteSnapshot,
  marketQuoteFor,
  selectNetWorth,
  usableMarketQuote,
  valueFinanceAccount,
  valueFinanceHolding,
} from "../src/finance.ts"
import { type FamilyMember } from "../src/family.ts"

const quotes: MarketQuote[] = [
  quote("BTC", 10_000_000n, "live"),
  quote("VOO", 55_000n, "live"),
  quote("IBIT", 6_000n, "stale"),
]

const accounts: FinanceAccount[] = [
  account("victor-401k", "victor", 999_999n, [
    holding("VOO holding", "VOO", "2.5", 100_000n),
    holding("IBIT holding", "IBIT", "10.125", 50_000n),
    holding("Cash", null, "0", 25_000n),
  ]),
  account("rachel-401k", "rachel", 100_000n, []),
  account("mason-401k", "mason", 50_000n, []),
]

test("quote snapshot is exactly BTC, VOO, and IBIT with explicit states", () => {
  assert.equal(assertMarketQuoteSnapshot({ quotes }).quotes.length, 3)
  assert.equal(usableMarketQuote(quotes, "IBIT")?.status, "stale")

  assert.throws(
    () => assertMarketQuoteSnapshot({ quotes: [quotes[0]!, quotes[0]!, quotes[2]!] }),
    /Duplicate market quote/,
  )
  assert.throws(
    () => assertMarketQuoteSnapshot({ quotes: quotes.slice(0, 2) }),
    /must contain 3 quotes/,
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
    () => assertMarketQuote({ ...quotes[0]!, fetchedAt: null }),
    /carry fetchedAt/,
  )
  assert.throws(
    () => assertMarketQuote({ ...quotes[0]!, status: "fresh" as MarketQuoteStatus }),
    /Unsupported market quote status/,
  )
})

test("holding valuation uses live and stale quotes while preserving their provenance", () => {
  const voo = valueFinanceHolding(accounts[0]!.holdings[0]!, quotes)
  const ibit = valueFinanceHolding(accounts[0]!.holdings[1]!, quotes)
  const cash = valueFinanceHolding(accounts[0]!.holdings[2]!, quotes)

  assert.equal(voo.valueCents, 137_500n)
  assert.equal(voo.basis, "market-quote")
  assert.equal(voo.quote?.status, "live")
  assert.equal(ibit.valueCents, 60_750n)
  assert.equal(ibit.basis, "market-quote")
  assert.equal(ibit.quote?.status, "stale")
  assert.equal(cash.valueCents, 25_000n)
  assert.equal(cash.basis, "stored-value")
  assert.equal(cash.quote, null)
})

test("unavailable equity quote uses stored value and remains distinguishable from absent", () => {
  const unavailable = quotes.map((entry) => entry.symbol === "IBIT"
    ? quote("IBIT", null, "unavailable")
    : entry)
  const holdingValue = valueFinanceHolding(accounts[0]!.holdings[1]!, unavailable)

  assert.equal(holdingValue.valueCents, 50_000n)
  assert.equal(holdingValue.basis, "stored-value")
  assert.equal(holdingValue.quote?.status, "unavailable")
  assert.equal(marketQuoteFor(unavailable, "IBIT")?.status, "unavailable")
  assert.equal(usableMarketQuote(unavailable, "IBIT"), null)

  const missing = valueFinanceHolding(accounts[0]!.holdings[1]!, unavailable.slice(0, 2))
  assert.equal(missing.basis, "stored-value")
  assert.equal(missing.quote, null)
})

test("account total is fallback-only when holdings have no positive total", () => {
  assert.equal(valueFinanceAccount(accounts[0]!, quotes).valueCents, 223_250n)
  assert.equal(valueFinanceAccount(accounts[1]!, quotes).valueCents, 100_000n)
})

test("adult net worth is eligible Bitcoin plus adult retirement exactly once", () => {
  const result = selectNetWorth({
    viewer: "victor",
    bitcoinSats: 100_000_000n,
    financeAccounts: accounts,
    quotes,
  })

  assert.deepEqual(result.accounts.map((entry) => entry.account.key), [
    "victor-401k",
    "rachel-401k",
  ])
  assert.equal(result.retirementValueCents, 323_250n)
  assert.equal(result.bitcoinValueCents, 10_000_000n)
  assert.equal(result.retirementValueSats, 3_232_500n)
  assert.equal(result.totalValueCents, 10_323_250n)
  assert.equal(result.totalValueSats, 103_232_500n)
  assert.equal(result.btcQuote?.status, "live")
  assert.ok(!result.accounts.some((entry) => entry.account.owner === "mason"))
})

test("Rachel receives the same adult scope while a child remains isolated", () => {
  const rachel = selectNetWorth({
    viewer: "rachel",
    bitcoinSats: 100_000_000n,
    financeAccounts: accounts,
    quotes,
  })
  const mason = selectNetWorth({
    viewer: "mason",
    bitcoinSats: 1_000n,
    financeAccounts: accounts,
    quotes,
  })

  assert.deepEqual(rachel.accounts.map((entry) => entry.account.key), [
    "victor-401k",
    "rachel-401k",
  ])
  assert.deepEqual(mason.accounts.map((entry) => entry.account.key), ["mason-401k"])
})

test("unavailable BTC quote keeps retirement known and combined conversions unavailable", () => {
  const unavailable = quotes.map((entry) => entry.symbol === "BTC"
    ? quote("BTC", null, "unavailable")
    : entry)
  const result = selectNetWorth({
    viewer: "victor",
    bitcoinSats: 100_000_000n,
    financeAccounts: accounts,
    quotes: unavailable,
  })

  assert.equal(result.retirementValueCents, 323_250n)
  assert.equal(result.bitcoinValueCents, null)
  assert.equal(result.retirementValueSats, null)
  assert.equal(result.totalValueCents, null)
  assert.equal(result.totalValueSats, null)
  assert.equal(result.btcQuote?.status, "unavailable")
})

function quote(
  symbol: MarketQuote["symbol"],
  priceCents: bigint | null,
  status: MarketQuoteStatus,
): MarketQuote {
  return {
    symbol,
    priceCents,
    source: "reviewed-provider",
    fetchedAt: status === "unavailable" ? null : "2026-07-30T15:00:00Z",
    status,
  }
}

function holding(
  name: string,
  ticker: string | null,
  sharesDecimal: string,
  valueCents: bigint,
): FinanceHolding {
  return {
    name,
    category: "Retirement",
    ticker,
    valueCents,
    costBasisCents: 0n,
    gainBps: 0n,
    sharesDecimal,
    avgCostCents: 0n,
    currentPricePerShareCents: 0n,
    isProxy: false,
    proxyNote: null,
    lots: [],
  }
}

function account(
  key: string,
  owner: FamilyMember,
  totalValueCents: bigint,
  holdings: readonly FinanceHolding[],
): FinanceAccount {
  return {
    key,
    owner,
    provider: "Test provider",
    totalValueCents,
    weeklyContributionCents: 0n,
    weeklyContributionDay: null,
    holdings,
  }
}
