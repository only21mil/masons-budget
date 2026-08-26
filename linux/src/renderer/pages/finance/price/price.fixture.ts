import type { MarketQuote } from "@vogel-vault/domain/finance"

import type { PriceHistoryPoint } from "./index.tsx"

export const PRICE_PAGE_QUOTE_FIXTURE: MarketQuote = {
  symbol: "BTC",
  priceCents: 7_813_900n,
  source: "Vogel quote cache",
  fetchedAt: "2026-08-24T12:17:48Z",
  status: "live",
}

const PRICE_HISTORY_USD = [
  77_100, 76_400, 77_800, 79_200, 78_600, 77_300, 76_100, 76_800, 78_000, 79_600,
  80_700, 80_100, 79_100, 77_900, 76_700, 74_880, 76_000, 77_500, 78_700, 79_900,
  81_204, 80_800, 80_200, 79_500, 78_300, 77_600, 78_100, 79_000, 79_800, 78_139,
] as const

export const PRICE_PAGE_HISTORY_FIXTURE: readonly PriceHistoryPoint[] =
  PRICE_HISTORY_USD.map((priceUsd, index) => {
    const date = new Date(Date.UTC(2026, 6, 26 + index)).toISOString().slice(0, 10)
    return { date, priceCents: BigInt(priceUsd) * 100n }
  })
