import assert from "node:assert/strict"
import { test } from "vitest"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type {
  FinanceAccount,
  FinanceDocument,
  FinanceHolding,
  MarketQuote,
} from "@vogel-vault/domain/finance"
import type { FamilyMember } from "@vogel-vault/domain/family"

import { AppStateProvider } from "../src/renderer/app/AppState.tsx"
import type { LinuxFinanceReadModel } from "../src/renderer/data/financeReadModel.ts"
import { resolvePage } from "../src/renderer/pages/index.ts"

const NOW = Date.UTC(2026, 6, 31, 1, 0, 0)

function holding(input: {
  name: string
  ticker: "VOO" | "IBIT"
  shares: string
  storedValueCents: bigint
}): FinanceHolding {
  return {
    name: input.name,
    category: "Index fund",
    ticker: input.ticker,
    valueCents: input.storedValueCents,
    costBasisCents: input.storedValueCents,
    gainBps: 0n,
    sharesDecimal: input.shares,
    avgCostCents: input.storedValueCents,
    currentPricePerShareCents: input.storedValueCents,
    isProxy: false,
    proxyNote: null,
    lots: [],
  }
}

function account(
  key: string,
  owner: FamilyMember,
  provider: string,
  holdings: readonly FinanceHolding[],
): FinanceAccount {
  return {
    key,
    owner,
    provider,
    totalValueCents: holdings.reduce((total, item) => total + item.valueCents, 0n),
    weeklyContributionCents: 0n,
    weeklyContributionDay: null,
    holdings,
  }
}

const FINANCE: FinanceDocument = {
  updatedAtMs: NOW,
  lastUpdated: "2026-07-31T01:00:00.000Z",
  retirementTotalCents: 9_999_999n,
  accounts: [
    account("victor-401k", "victor", "Adult 401k", [
      holding({ name: "VOO position", ticker: "VOO", shares: "2.5", storedValueCents: 100_000n }),
    ]),
    account("rachel-ira", "rachel", "Rachel IRA", [
      holding({ name: "IBIT position", ticker: "IBIT", shares: "10", storedValueCents: 35_000n }),
    ]),
    account("mason-custodial", "mason", "Mason Custodial", [
      holding({ name: "Mason VOO", ticker: "VOO", shares: "1", storedValueCents: 50_000n }),
    ]),
  ],
}

const QUOTES: readonly MarketQuote[] = [
  {
    symbol: "BTC",
    priceCents: 10_000_000n,
    source: "authenticated quote cache",
    fetchedAt: "2026-07-31T00:59:00.000Z",
    status: "live",
  },
  {
    symbol: "VOO",
    priceCents: 50_000n,
    source: "authenticated quote cache",
    fetchedAt: "2026-07-31T00:59:00.000Z",
    status: "live",
  },
  {
    symbol: "IBIT",
    priceCents: 4_000n,
    source: "authenticated quote cache",
    fetchedAt: "2026-07-30T18:00:00.000Z",
    status: "stale",
  },
]

function model(quotes: readonly MarketQuote[] = QUOTES): LinuxFinanceReadModel {
  return {
    finance: { status: "live", value: FINANCE },
    marketQuotes: { status: "live", value: { quotes } },
  }
}

function renderFinancePage(
  route: "retirement" | "net-worth",
  profile: FamilyMember,
  financeModel?: LinuxFinanceReadModel,
  displayUnit: "btc" | "sats" | "usd" = "usd",
): string {
  const page = resolvePage(route, profile)
  assert.ok(page, `${route} should resolve for ${profile}`)
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: profile,
      initialRoute: route,
      initialDisplayUnit: displayUnit,
      initialFinanceModel: financeModel,
      children: createElement(page.Component),
    }),
  )
}

test("retirement renders scoped holdings with honest live, stale, and ledger valuation bases", () => {
  const markup = renderFinancePage("retirement", "victor", model())

  assert.ok(markup.includes("Adult 401k"))
  assert.ok(markup.includes("Rachel IRA"))
  assert.ok(!markup.includes("Mason Custodial"), "child retirement leaked into the adult scope")
  assert.ok(markup.includes("$1,650.00"), "retirement did not use VOO and stale IBIT quotes")
  assert.ok(markup.includes("Live VOO quote"))
  assert.ok(markup.includes("Stale IBIT quote"))
  assert.ok(markup.includes("BTC"))
  assert.ok(markup.includes("VOO"))
  assert.ok(markup.includes("IBIT"))
  assert.ok(markup.includes("STALE"))
})

test("adult net worth uses operational BTC/VOO/IBIT quotes and excludes child holdings", () => {
  const markup = renderFinancePage("net-worth", "victor", model())

  assert.ok(markup.includes("Adult net worth"))
  assert.ok(markup.includes("$123,456.79"), "Bitcoin was not valued from the operational BTC quote")
  assert.ok(markup.includes("$1,650.00"), "adult retirement omitted a household account")
  assert.ok(markup.includes("$125,106.79"), "adult total was not combined exactly once")
  assert.ok(!markup.includes("$125,606.79"), "child retirement leaked into the adult total")
  assert.ok(markup.includes("$120,000.00"), "canonical BTC account fiat was not preserved")
})

test("child net worth remains self-only even when the injected document contains adult accounts", () => {
  const markup = renderFinancePage("net-worth", "mason", model())

  assert.ok(markup.includes("$620.00"), "Mason's BTC and custodial account were not totaled")
  assert.ok(!markup.includes("$125,106.79"))
  assert.ok(!markup.includes("Adult net worth"))
})

test("an unavailable BTC quote withholds combined totals without hiding retirement", () => {
  const unavailableQuotes: readonly MarketQuote[] = QUOTES.map((quote) =>
    quote.symbol === "BTC"
      ? { ...quote, priceCents: null, fetchedAt: null, status: "unavailable" as const }
      : quote,
  )
  const markup = renderFinancePage("net-worth", "victor", model(unavailableQuotes))

  assert.ok(markup.includes("BTC market price unavailable"))
  assert.ok(markup.includes("$1,650.00"), "retirement should survive a quote failure")
  assert.ok(!markup.includes("$125,106.79"), "unavailable BTC was rendered as a live total")
  assert.ok(markup.includes("Unavailable"), "the suppressed total has no accessible label")
})

test("default fixture mode never labels retirement or market quotes as live", () => {
  const markup = renderFinancePage("retirement", "victor")

  assert.ok(markup.includes("No retirement document"))
  assert.ok(markup.includes("No market quote snapshot"))
  assert.ok(markup.includes("No fixture balances are substituted"))
  assert.ok(!markup.includes("Adult 401k"))
  assert.ok(!markup.includes("authenticated quote cache"))
})
