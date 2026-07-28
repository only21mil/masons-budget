import assert from "node:assert/strict"
import { test } from "vitest"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { FamilyMember } from "@vogel-vault/domain/family"
import type { BTCBuy } from "@vogel-vault/domain/readModel"

import { AppStateProvider, useAppState } from "../src/renderer/app/AppState.tsx"
import {
  DISPLAY_UNITS,
  PRICE_UNAVAILABLE,
  displayUnitFromStorageKey,
  formatBitcoin,
  newestVisibleBuyPrice,
} from "../src/renderer/data/bitcoinDisplay.ts"
import { resolvePage } from "../src/renderer/pages/index.ts"

const REFERENCE_PRICE_CENTS = 10_000_000n

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

test("USD UI labels the recorded buy date and plainly says the price is not live", () => {
  const markup = renderPage("dashboard", "victor", "usd")

  assert.ok(markup.includes('aria-label="Bitcoin display unit"'))
  assert.ok(markup.includes('aria-pressed="true">USD</button>'))
  assert.ok(markup.includes("Uses the last recorded Bitcoin buy price from 2026-07-24."))
  assert.ok(markup.includes("This is not a live price."))
})

test("USD UI shows Price unavailable when the required buy source is empty", () => {
  const markup = renderPage("dashboard", "victor", "usd", "empty")

  assert.ok(markup.includes(PRICE_UNAVAILABLE))
  assert.ok(markup.includes("No recorded Bitcoin buy price is available."))
})

function buy(id: string, date: string, priceUsd: bigint, owner: FamilyMember): BTCBuy {
  return {
    id,
    date,
    source: "Test",
    sats: 1n,
    priceUsd,
    usd: 1n,
    note: null,
    status: "settled",
    costBasisStatus: "confirmed",
    loggedBy: "test",
    owner,
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
): string {
  return renderToStaticMarkup(
    createElement(AppStateProvider, {
      initialProfile: profile,
      initialRoute: route,
      initialStateOverride: state,
      initialDisplayUnit: displayUnit,
      children: createElement(Harness, { route }),
    }),
  )
}
