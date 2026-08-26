import { useAppState } from "../../app/AppState.tsx"
import { availableBtcQuote } from "../../data/bitcoinDisplay.ts"
import type { PageDefinition } from "../types.ts"
import { PricePage } from "./price/index.tsx"
import {
  PRICE_PAGE_HISTORY_FIXTURE,
  PRICE_PAGE_QUOTE_FIXTURE,
} from "./price/price.fixture.ts"

function PriceRoutePage() {
  const { dataOrigin, displayUnit, financeModel, navigate } = useAppState()
  const quote = financeModel.marketQuotes.status === "live"
    ? availableBtcQuote(financeModel.marketQuotes.value.quotes)
    : dataOrigin === "fixture" ? PRICE_PAGE_QUOTE_FIXTURE : null
  const history = dataOrigin === "fixture" ? PRICE_PAGE_HISTORY_FIXTURE : []

  return (
    <PricePage
      quote={quote}
      change24hBasisPoints={null}
      history={history}
      displayUnit={displayUnit}
      onBack={() => navigate("bitcoin")}
    />
  )
}

export const pricePageDefinition: PageDefinition = {
  id: "price",
  label: "Price",
  icon: "bitcoin",
  Component: PriceRoutePage,
}
