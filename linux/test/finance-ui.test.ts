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
import type { FixtureEnvelope } from "../src/renderer/data/fixtures.ts"

import { AppStateProvider, financeReadSucceeded } from "../src/renderer/app/AppState.tsx"
import { buildSanitizedFixtureEnvelope } from "../src/renderer/data/fixtures.ts"
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

function remoteData(profile: FamilyMember): FixtureEnvelope {
  const data = buildSanitizedFixtureEnvelope(profile)
  return {
    ...data,
    btcBalanceDocument: {
      ...data.btcBalanceDocument,
      status: "live",
      updatedAt: NOW,
      source: "Convex row tables · canonical BTC balance document",
    },
    btcAccounts: {
      ...data.btcAccounts,
      status: "live",
      updatedAt: NOW,
      source: "Convex row tables · BTC accounts",
    },
  }
}

function renderFinancePage(
  route: "retirement" | "net-worth",
  profile: FamilyMember,
  financeModel?: LinuxFinanceReadModel,
  displayUnit: "btc" | "sats" | "usd" = "usd",
  options: {
    readonly data?: FixtureEnvelope
    readonly state?: "normal" | "stale" | "error" | "empty" | "loading"
  } = {},
): string {
  const page = resolvePage(route, profile)
  assert.ok(page, `${route} should resolve for ${profile}`)
  const initialData = options.data ?? (financeModel ? remoteData(profile) : undefined)
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: profile,
      initialRoute: route,
      initialDisplayUnit: displayUnit,
      initialFinanceModel: financeModel,
      initialData,
      initialDataOrigin: initialData ? "remote" : "fixture",
      initialStateOverride: options.state,
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

test("retirement headline discloses stale quote revaluation provenance", () => {
  const markup = renderFinancePage("retirement", "victor", model())
  const totalAt = markup.indexOf("Retirement total")
  const accountsAt = markup.indexOf("Accounts", totalAt)

  assert.ok(totalAt >= 0 && accountsAt > totalAt)
  const totalMarkup = markup.slice(totalAt, accountsAt)
  assert.ok(totalMarkup.includes("vv-stale"))
  assert.ok(totalMarkup.includes("Stale quote revaluation"))
  assert.ok(totalMarkup.includes("Revalued with stale IBIT market quote"))
  assert.ok(!totalMarkup.includes("vv-actual"))
})

test("retirement preserves accounts without holdings and exposes contribution schedules", () => {
  const accountOnly: FinanceAccount = {
    key: "solo-pension",
    owner: "victor",
    provider: "Solo Pension",
    totalValueCents: 300_000n,
    weeklyContributionCents: 25_000n,
    weeklyContributionDay: "Friday",
    holdings: [],
  }
  const financeModel = model()
  const markup = renderFinancePage("retirement", "victor", {
    ...financeModel,
    finance: {
      status: "live",
      value: { ...FINANCE, accounts: [...FINANCE.accounts, accountOnly] },
    },
  })

  assert.ok(markup.includes("Solo Pension"))
  assert.ok(markup.includes("No holding detail"))
  assert.ok(markup.includes("$4,650.00"), "account total disappeared when holdings were absent")
  assert.ok(markup.includes("$250.00"))
  assert.ok(markup.includes("Friday"))
})

test("retirement converts USD-native values only through the operational BTC quote", () => {
  const satsMarkup = renderFinancePage("retirement", "victor", model(), "sats")
  assert.ok(satsMarkup.includes("1 650 000 sats"))

  const unavailableQuotes = QUOTES.map((quote) => quote.symbol === "BTC"
    ? { ...quote, priceCents: null, fetchedAt: null, status: "unavailable" as const }
    : quote)
  const unavailableMarkup = renderFinancePage(
    "retirement",
    "victor",
    model(unavailableQuotes),
    "btc",
  )
  assert.ok(unavailableMarkup.includes("Price unavailable"))
  assert.ok(!unavailableMarkup.includes("0.00000000 BTC"))
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
  assert.ok(markup.includes("BTC plus retirement · self only"))
  assert.ok(!markup.includes("no child balances"))
})

test("child net-worth failure copy stays profile-generic", () => {
  const unavailableFinance: LinuxFinanceReadModel = {
    ...model(),
    finance: { status: "error", value: null, code: "unavailable" },
  }
  const markup = renderFinancePage("net-worth", "mason", unavailableFinance)

  assert.ok(markup.includes("Net-worth total unavailable"))
  assert.ok(!markup.includes("Adult net-worth total unavailable"))
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

test("a missing canonical BTC document cannot become a zero-BTC combined total", () => {
  const data = buildSanitizedFixtureEnvelope("victor")
  const withoutBitcoin: FixtureEnvelope = {
    ...data,
    btcBalanceDocument: {
      status: "empty",
      value: null,
      updatedAt: null,
      source: "Convex row tables · no canonical BTC document",
    },
  }
  const markup = renderFinancePage("net-worth", "victor", model(), "usd", {
    data: withoutBitcoin,
  })

  assert.ok(markup.includes("$1,650.00"), "retirement should remain visible")
  const totalStart = markup.indexOf("Adult net worth")
  assert.ok(totalStart >= 0)
  const totalMarkup = markup.slice(totalStart, totalStart + 400)
  assert.ok(totalMarkup.includes("Unavailable"))
  assert.ok(!totalMarkup.includes("$1,650.00"),
    "retirement-only value was presented as combined net worth")
  assert.ok(!markup.includes("0.00000000 BTC"))
  assert.ok(markup.includes("Bitcoin balance unavailable"))
  assert.ok(markup.includes("Live BTC quote"), "the available quote was incorrectly blamed")
  assert.ok(!markup.includes("BTC market price unavailable"))
})

test("a demo BTC document never combines with live finance and quotes", () => {
  const page = resolvePage("net-worth", "victor")
  assert.ok(page)
  const markup = renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: "victor",
      initialRoute: "net-worth",
      initialFinanceModel: model(),
      children: createElement(page.Component),
    }),
  )

  assert.ok(markup.includes("DEMO DATA"))
  const totalStart = markup.indexOf("Adult net worth")
  assert.ok(totalStart >= 0)
  assert.ok(markup.slice(totalStart, totalStart + 400).includes("Unavailable"))
  assert.ok(!markup.includes("$125,106.79"))
})

test("QA finance overrides use one consistent state for tags, ledger, and quotes", () => {
  const stale = renderFinancePage("retirement", "victor", model(), "usd", { state: "stale" })
  assert.ok(stale.includes("Stale"))
  assert.ok(!stale.includes("No data"))
  assert.ok(!stale.includes("Adult 401k"))

  const loading = renderFinancePage("net-worth", "victor", model(), "usd", { state: "loading" })
  assert.ok(loading.includes("Loading"))
  assert.ok(!loading.includes("authenticated quote cache"))
})

test("pending authenticated finance reads render loading rather than authoritative empty", () => {
  const loading: LinuxFinanceReadModel = {
    finance: { status: "loading", value: null },
    marketQuotes: { status: "loading", value: null },
  }
  const markup = renderFinancePage("retirement", "victor", loading)

  assert.ok(markup.includes("Loading"))
  assert.ok(!markup.includes("No retirement document"))
  assert.ok(!markup.includes("No market quote snapshot"))
})

test("finance or quote errors fail the global refresh result", () => {
  assert.equal(financeReadSucceeded(model()), true)
  assert.equal(financeReadSucceeded({
    finance: { status: "error", value: null, code: "unavailable" },
    marketQuotes: model().marketQuotes,
  }), false)
  assert.equal(financeReadSucceeded({
    finance: model().finance,
    marketQuotes: { status: "error", value: null, code: "invalid-response" },
  }), false)
  assert.equal(financeReadSucceeded({
    finance: { status: "loading", value: null },
    marketQuotes: model().marketQuotes,
  }), false)
})

test("sync health includes finance and market quote state", () => {
  const page = resolvePage("sync-health", "victor")
  assert.ok(page)
  const data = remoteData("victor")
  const remoteRows: FixtureEnvelope = {
    ...data,
    transactions: {
      ...data.transactions,
      status: "live",
      updatedAt: NOW,
      source: "Convex row tables · transactions",
    },
  }
  const markup = renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: "victor",
      initialRoute: "sync-health",
      initialData: remoteRows,
      initialDataOrigin: "remote",
      initialFinanceModel: {
        finance: { status: "error", value: null, code: "unavailable" },
        marketQuotes: model().marketQuotes,
      },
      children: createElement(page.Component),
    }),
  )

  assert.ok(markup.includes("finance-document"))
  assert.ok(markup.includes("market-quotes"))
  assert.ok(markup.includes("Read failed"))
  assert.ok(markup.includes("Some authenticated Convex reads failed"))
  assert.ok(markup.includes("Stale"), "stale IBIT did not affect global quote freshness")
})

test("sync health does not timestamp a degraded snapshot from its newest quote", () => {
  const page = resolvePage("sync-health", "victor")
  assert.ok(page)
  const degraded = QUOTES.map((quote) => quote.symbol === "IBIT"
    ? { ...quote, priceCents: null, fetchedAt: null, status: "unavailable" as const }
    : quote)
  const markup = renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: "victor",
      initialRoute: "sync-health",
      initialData: remoteData("victor"),
      initialDataOrigin: "remote",
      initialFinanceModel: model(degraded),
      children: createElement(page.Component),
    }),
  )

  assert.ok(markup.includes("Stale · never"))
})

test("default fixture mode never labels retirement or market quotes as live", () => {
  const markup = renderFinancePage("retirement", "victor")

  assert.ok(markup.includes("No retirement document"))
  assert.ok(markup.includes("No market quote snapshot"))
  assert.ok(markup.includes("No fixture balances are substituted"))
  assert.ok(!markup.includes("Adult 401k"))
  assert.ok(!markup.includes("authenticated quote cache"))
})
