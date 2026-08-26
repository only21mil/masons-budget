import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "vitest"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { MarketQuote } from "@vogel-vault/domain/finance"
import type { FamilyMember } from "@vogel-vault/domain/family"
import type { BTCBuy } from "@vogel-vault/domain/readModel"

import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import {
  DISPLAY_UNITS,
  PRICE_UNAVAILABLE,
  availableBtcQuote,
  displayUnitFromStorageKey,
  formatDisplayAmount,
  formatBitcoin,
  newestVisibleBuyPrice,
  usdCentsToSats,
} from "../src/renderer/data/bitcoinDisplay.ts"
import {
  type FixtureEnvelope,
  buildKnownSatsUnavailableFiatEnvelope,
  buildSanitizedFixtureEnvelope,
} from "../src/renderer/data/fixtures.ts"
import type { LinuxFinanceReadModel } from "../src/renderer/data/financeReadModel.ts"
import { dashboardIncomeMtd } from "../src/renderer/pages/finance/index.tsx"
import { resolvePage } from "../src/renderer/pages/index.ts"

const REFERENCE_PRICE_CENTS = 10_000_000n
const FIXTURE_MONTH = "2026-07"

const boundaries = [
  {
    sats: 1n,
    btc: "0.00000001 BTC",
    satsLabel: "1 sats",
    usd: "$0.00",
  },
  {
    sats: 99_999_999n,
    btc: "0.99999999 BTC",
    satsLabel: "99 999 999 sats",
    usd: "$100,000.00",
  },
  {
    sats: 100_000_000n,
    btc: "1.00000000 BTC",
    satsLabel: "100 000 000 sats",
    usd: "$100,000.00",
  },
  {
    sats: 2_100_000_000_000_000n,
    btc: "21000000.00000000 BTC",
    satsLabel: "2 100 000 000 000 000 sats",
    usd: "$2,100,000,000,000.00",
  },
] as const

test("display units match Android storage keys, labels, order, and fallback", () => {
  assert.deepEqual(DISPLAY_UNITS, [
    { storageKey: "btc", label: "BTC" },
    { storageKey: "sats", label: "SATS" },
    { storageKey: "usd", label: "USD" },
  ])
  assert.equal(displayUnitFromStorageKey("sats"), "sats")
  assert.equal(displayUnitFromStorageKey("unknown"), "btc")
  assert.equal(displayUnitFromStorageKey(null), "btc")
})

test("formats every required satoshi boundary in BTC, SATS, and USD without floating point", () => {
  for (const boundary of boundaries) {
    assert.equal(formatBitcoin(boundary.sats, "btc"), boundary.btc)
    assert.equal(formatBitcoin(boundary.sats, "sats"), boundary.satsLabel)
    assert.equal(formatBitcoin(boundary.sats, "usd", REFERENCE_PRICE_CENTS), boundary.usd)
  }
})

test("USD is unavailable without a positive integer-cent price", () => {
  assert.equal(formatBitcoin(1n, "usd"), PRICE_UNAVAILABLE)
  assert.equal(formatBitcoin(1n, "usd", 0n), PRICE_UNAVAILABLE)
  assert.equal(formatBitcoin(1n, "usd", -1n), PRICE_UNAVAILABLE)
})

test("cross-unit values prefer exact native amounts and use only an accepted quote", () => {
  assert.equal(formatDisplayAmount({ sats: 12_345n }, "sats", null), "12 345 sats")
  assert.equal(formatDisplayAmount({ usdCents: 12_345n }, "usd", null), "$123.45")
  assert.equal(
    formatDisplayAmount({ sats: 12_345n, usdCents: 67_890n }, "usd", REFERENCE_PRICE_CENTS),
    "$678.90",
    "an exact native USD value was replaced by a quote-derived estimate",
  )
  assert.equal(
    formatDisplayAmount({ usdCents: 12_345n }, "sats", REFERENCE_PRICE_CENTS),
    "123 450 sats",
  )
  assert.equal(
    formatDisplayAmount({ usdCents: -12_345n }, "btc", REFERENCE_PRICE_CENTS),
    "-0.00123450 BTC",
  )
  assert.equal(formatDisplayAmount({ usdCents: 12_345n }, "btc", null), PRICE_UNAVAILABLE)
})

test("USD-to-sats rounds half away from zero without floating point", () => {
  assert.equal(usdCentsToSats(1n, 3n), 33_333_333n)
  assert.equal(usdCentsToSats(-1n, 3n), -33_333_333n)
  assert.equal(usdCentsToSats(1n, 0n), null)
})

test("only a live or explicitly stale operational BTC MarketQuote can convert", () => {
  for (const status of ["live", "stale"] as const) {
    const quote = marketQuote("BTC", status, REFERENCE_PRICE_CENTS)
    assert.deepEqual(availableBtcQuote([quote]), quote)
  }
  assert.equal(
    availableBtcQuote([marketQuote("BTC", "unavailable", null)]),
    null,
  )
  assert.equal(availableBtcQuote([]), null)
})

test("Dashboard MTD uses month-scoped net-worth income rows with signed corrections", () => {
  const rows = [
    incomeRow("2026-07-01", "2026-07", 1_000n, "victor"),
    incomeRow("2026-07-02", "2026-07", -250n, "rachel"),
    incomeRow("2026-07-03", "2026-07", 500n, "mason"),
    incomeRow("2026-06-30", "2026-06", 9_999n, "victor"),
  ]

  assert.equal(dashboardIncomeMtd("victor", "2026-07", "live", rows), 750n)
  assert.equal(dashboardIncomeMtd("mason", "2026-07", "live", rows), 500n)
})

test("Dashboard MTD preserves a nonempty zero and rejects incomplete or unsafe ledgers", () => {
  const zero = [incomeRow("2026-07-01", "2026-07", 0n, "victor")]
  assert.equal(dashboardIncomeMtd("victor", "2026-07", "stale", zero), 0n)

  for (const status of ["loading", "empty", "error"] as const) {
    assert.equal(dashboardIncomeMtd("victor", "2026-07", status, zero), null)
  }
  assert.equal(dashboardIncomeMtd("victor", "2026-07", "live", []), null)
  assert.equal(
    dashboardIncomeMtd(
      "victor",
      "2026-07",
      "live",
      [incomeRow("2026-07-32", "2026-07", 1n, "victor")],
    ),
    null,
  )
  assert.equal(
    dashboardIncomeMtd(
      "victor",
      "2026-07",
      "live",
      [
        incomeRow("2026-07-01", "2026-07", (1n << 63n) - 1n, "victor"),
        incomeRow("2026-07-02", "2026-07", 1n, "victor"),
      ],
    ),
    null,
  )
})

test("reference price is the newest visible buy and carries its date", () => {
  const buys = [
    buy("adult-old", "2026-07-01", 8_000_000n, "victor"),
    buy("child-newer", "2026-07-20", 9_000_000n, "mason"),
    buy("adult-newest", "2026-07-18", 8_500_000n, "victor"),
  ]

  assert.deepEqual(newestVisibleBuyPrice("rachel", buys), {
    cents: 9_000_000n,
    date: "2026-07-20",
  })
  assert.deepEqual(newestVisibleBuyPrice("mason", buys), {
    cents: 9_000_000n,
    date: "2026-07-20",
  })
})

test("a non-positive newest visible buy is unavailable instead of falling back", () => {
  const buys = [
    buy("priced", "2026-07-01", 8_000_000n, "victor"),
    buy("unpriced-newest", "2026-07-20", 0n, "victor"),
  ]

  assert.equal(newestVisibleBuyPrice("victor", buys), null)
  assert.equal(newestVisibleBuyPrice("maddox", buys), null)
})

test("USD UI labels the canonical BTC snapshot date and plainly says it is not live", () => {
  const markup = renderPage("dashboard", "victor", "usd")

  assert.ok(markup.includes('aria-label="Bitcoin display unit"'))
  assert.ok(markup.includes('aria-pressed="true">USD</button>'))
  assert.ok(markup.includes("Uses the canonical BTC balance document from 2026-07-16."))
  assert.ok(markup.includes("This is not a live price."))
})

test("display-unit buttons expose pressed semantics and 24px minimum targets", () => {
  const markup = renderPage("dashboard", "victor", "usd")
  const css = readFileSync(
    new URL("../src/renderer/styles/components.css", import.meta.url),
    "utf8",
  )
  const optionRule = /\.vv-unit-toggle__option\s*\{([^}]*)\}/.exec(css)?.[1] ?? ""

  assert.ok(markup.includes('role="group" aria-label="Bitcoin display unit"'))
  assert.equal((markup.match(/type="button"/g) ?? []).length, 3)
  assert.equal((markup.match(/aria-pressed="true"/g) ?? []).length, 1)
  assert.equal((markup.match(/aria-pressed="false"/g) ?? []).length, 2)
  assert.match(optionRule, /\bmin-width:\s*24px\s*;/)
  assert.match(optionRule, /\bmin-height:\s*24px\s*;/)
})

test("USD UI shows Price unavailable when the required BTC document source is empty", () => {
  const markup = renderPage("dashboard", "victor", "usd", "empty")

  assert.ok(markup.includes(PRICE_UNAVAILABLE))
  assert.ok(markup.includes("No canonical BTC balance document is available."))
})

test.each(["dashboard", "bitcoin", "net-worth"])(
  "%s keeps production sats visible while every canonical USD surface is unavailable",
  (route) => {
    const markup = renderPage(
      route,
      "victor",
      "usd",
      "normal",
      buildKnownSatsUnavailableFiatEnvelope(),
    )

    assert.ok(markup.includes(PRICE_UNAVAILABLE), `${route} did not suppress unavailable fiat`)
    assert.ok(
      markup.includes("The BTC balance is known, but no supported USD valuation exists."),
      `${route} did not explain the mixed-availability snapshot`,
    )
    assert.ok(!markup.includes("$0.00"), `${route} rendered the legacy zero as a valuation`)
  },
)

test("the production-shaped stack remains exact in BTC and SATS modes", () => {
  const data = buildKnownSatsUnavailableFiatEnvelope()
  const btc = renderPage("dashboard", "victor", "btc", "normal", data)
  const sats = renderPage("dashboard", "victor", "sats", "normal", data)

  assert.ok(btc.includes("5.41782856 BTC"))
  assert.ok(sats.includes("541 782 856 sats"))
})

test.each([
  ["btc", "0.07777770 BTC", "0.00673460 BTC"],
  ["sats", "7 777 770 sats", "673 460 sats"],
  ["usd", "$7,777.77", "$673.46"],
] as const)(
  "Dashboard income MTD and spend honor %s with a live operational quote",
  (unit, expectedIncome, expectedSpend) => {
    const markup = renderPage(
      "dashboard",
      "victor",
      unit,
      "normal",
      liveQuoteEnvelope(),
      marketQuoteModel(),
    )
    assert.ok(markup.includes("Income MTD"))
    assert.ok(markup.includes(expectedIncome), `missing ${unit} MTD income`)
    assert.ok(markup.includes(expectedSpend), `missing ${unit} spend`)
  },
)

test("Dashboard renders a valid nonempty zero-income month instead of a dash", () => {
  const base = liveQuoteEnvelope()
  const first = base.income.value[0]
  assert.ok(first)
  const markup = renderPage(
    "dashboard",
    "victor",
    "usd",
    "normal",
    {
      ...base,
      income: {
        ...base.income,
        value: [{ ...first, amount: 0n }],
      },
    },
  )
  const incomeAt = markup.indexOf("Income MTD")
  const stackAt = markup.indexOf("Stack", incomeAt)
  assert.ok(incomeAt >= 0 && stackAt > incomeAt)
  assert.ok(markup.slice(incomeAt, stackAt).includes("$0.00"))
  assert.ok(!markup.slice(incomeAt, stackAt).includes("Unavailable"))
})

test("a canonical balance ratio cannot drive display conversion", () => {
  const data = liveQuoteEnvelope()
  const markup = renderPage(
    "activity",
    "victor",
    "btc",
    "normal",
    data,
  )

  assert.ok(markup.includes(PRICE_UNAVAILABLE))
  assert.ok(markup.includes("No live or explicitly stale operational BTC market quote"))
  assert.ok(!markup.includes("0.00142180 BTC"), "a transaction amount inferred a BTC quote")
})

test("Budget remains USD and never renders the unit selector", () => {
  for (const unit of ["btc", "sats", "usd"] as const) {
    const markup = renderPage("budget", "victor", unit, "normal", liveQuoteEnvelope())
    assert.ok(markup.includes("$2,670.00"), `${unit} changed the planned Budget unit`)
    assert.ok(markup.includes("$753.45"), `${unit} changed the Budget actual unit`)
    assert.ok(!markup.includes('aria-label="Bitcoin display unit"'))
  }
})

test("exact native USD does not warn when the operational quote is unavailable", () => {
  const markup = renderPage("bitcoin-buys", "victor", "usd", "normal", liveQuoteEnvelope())
  assert.ok(markup.includes("$803.74"))
  assert.ok(!markup.includes("No live or explicitly stale operational BTC market quote"))
})

test("an explicitly stale operational BTC quote still drives conversion", () => {
  const markup = renderPage(
    "dashboard",
    "victor",
    "sats",
    "normal",
    liveQuoteEnvelope(),
    marketQuoteModel("stale"),
  )
  assert.ok(markup.includes("7 777 770 sats"))
  assert.ok(!markup.includes("No live or explicitly stale operational BTC market quote"))
})

test.each([
  ["bitcoin-buys", "btc", "0.00874000 BTC"],
  ["bitcoin-buys", "sats", "874 000 sats"],
  ["bitcoin-buys", "usd", "$803.74"],
  ["bills", "btc", "0.00289000 BTC"],
  ["bills", "sats", "289 000 sats"],
  ["bills", "usd", "$266.54"],
] as const)("%s uses its exact native ledger total in %s", (route, unit, expected) => {
  const markup = renderPage(route, "victor", unit, "normal", liveQuoteEnvelope())
  assert.ok(markup.includes(expected), `${route} lost the exact ${unit} total`)
})

function buy(id: string, date: string, priceUsd: bigint, owner: FamilyMember): BTCBuy {
  return {
    id,
    updatedAtMs: 1,
    date,
    source: "Test",
    sats: 1n,
    priceUsd,
    usd: 1n,
    feeUsd: 0n,
    note: null,
    status: "settled",
    costBasisStatus: "confirmed",
    loggedBy: "test",
    archimedesRequestId: null,
    owner,
  }
}

function incomeRow(
  date: string,
  month: string,
  amount: bigint,
  owner: FamilyMember,
) {
  return { date, month, amount, owner }
}

function liveQuoteEnvelope(): FixtureEnvelope {
  const base = buildSanitizedFixtureEnvelope("victor")
  return {
    ...base,
    transactions: { ...base.transactions, status: "live" },
    income: { ...base.income, status: "live" },
    budget: { ...base.budget, status: "live" },
    btcBalanceDocument: { ...base.btcBalanceDocument, status: "live" },
    btcAccounts: { ...base.btcAccounts, status: "live" },
    btcBuys: { ...base.btcBuys, status: "live" },
    billPays: { ...base.billPays, status: "live" },
    todos: { ...base.todos, status: "live" },
    btcPriceUsd: REFERENCE_PRICE_CENTS,
  }
}

function marketQuote(
  symbol: "BTC" | "VOO" | "IBIT",
  status: "live" | "stale" | "unavailable",
  priceCents: bigint | null,
): MarketQuote {
  return {
    symbol,
    status,
    priceCents,
    source: "operational test quote",
    fetchedAt: status === "unavailable" ? null : "2026-07-31T12:00:00Z",
  }
}

function marketQuoteModel(
  btcStatus: "live" | "stale" | "unavailable" = "live",
): LinuxFinanceReadModel {
  return {
    finance: { status: "empty", value: null },
    marketQuotes: {
      status: "live",
      value: {
        quotes: [
          marketQuote(
            "BTC",
            btcStatus,
            btcStatus === "unavailable" ? null : REFERENCE_PRICE_CENTS,
          ),
          marketQuote("VOO", "unavailable", null),
          marketQuote("IBIT", "unavailable", null),
        ],
      },
    },
  }
}

function Harness({ route }: { route: string }) {
  const { activeProfile } = useAppState()
  const page = resolvePage(route, activeProfile)
  return page ? createElement(page.Component) : null
}

function renderPage(
  route: string,
  profile: FamilyMember,
  displayUnit: "btc" | "sats" | "usd",
  state: "normal" | "empty" = "normal",
  initialData?: FixtureEnvelope,
  initialFinanceModel?: LinuxFinanceReadModel,
): string {
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: profile,
      initialRoute: route,
      initialStateOverride: state,
      initialCurrentMonth: FIXTURE_MONTH,
      initialDisplayUnit: displayUnit,
      initialData,
      initialFinanceModel,
      children: createElement(Harness, { route }),
    }),
  )
}
