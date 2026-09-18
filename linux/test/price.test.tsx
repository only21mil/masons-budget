import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { PricePage } from "../src/renderer/pages/finance/price/index.tsx"
import { PRICE_PAGE_HISTORY_FIXTURE, PRICE_PAGE_QUOTE_FIXTURE } from "../src/renderer/pages/finance/price/price.fixture.ts"

function renderPrice(displayUnit: "usd" | "btc" | "sats" = "usd"): string {
  return renderToStaticMarkup(
    <PricePage
      quote={PRICE_PAGE_QUOTE_FIXTURE}
      change24hBasisPoints={82n}
      history={PRICE_PAGE_HISTORY_FIXTURE}
      displayUnit={displayUnit}
    />,
  )
}

describe("PricePage", () => {
  it("renders the operational BTC hero, delta, SATS identity, converter, and footer", () => {
    const markup = renderPrice()

    expect(markup).toContain("BTC / USD · VOGEL VAULT")
    expect(markup).toContain("78,139")
    expect(markup).toContain(".00")
    expect(markup).toContain("▲ 0.82% 24H")
    expect(markup).toContain("1 BTC = 100,000,000 SATS")
    expect(markup).toContain("CONVERT")
    expect(markup).toContain("SATS")
    expect(markup).toContain("OPERATIONAL QUOTE · FETCHED 12:17:48Z · VOGEL QUOTE CACHE")
  })

  it("renders exactly 30 sparkline bars and accents the current observation", () => {
    const markup = renderPrice()

    expect(markup.match(/data-price-bar=""/g)).toHaveLength(30)
    expect(markup.match(/vv-price-sparkline__bar--current/g)).toHaveLength(1)
    expect(markup).toContain("H 81,204 · L 74,880")
    expect(markup).toContain("26 JUL")
    expect(markup).toContain("24 AUG")
  })

  it.each([
    ["usd", "AMOUNT · USD", "data-input-unit=\"usd\"", "BTC", "SATS", "0.00127977"],
    ["btc", "AMOUNT · BTC", "data-input-unit=\"btc\"", "USD", "SATS", "$78,139.00"],
    ["sats", "AMOUNT · SATS", "data-input-unit=\"sats\"", "USD", "BTC", "1.00000000"],
  ] as const)("follows the %s display unit for converter input", (
    unit,
    label,
    marker,
    first,
    second,
    converted,
  ) => {
    const markup = renderPrice(unit)

    expect(markup).toContain(label)
    expect(markup).toContain(marker)
    expect(markup).toContain(`>${first}<`)
    expect(markup).toContain(`>${second}<`)
    expect(markup).toContain(converted)
  })
})
