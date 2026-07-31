package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.usableQuote

/**
 * Native values available for one financial amount.
 *
 * When both sides exist, the selected side is always rendered directly. A
 * missing side may be derived only when the caller supplies a usable quote.
 */
internal data class FinancialAmount(
    val usdCents: Long? = null,
    val sats: Long? = null,
) {
    init {
        require(usdCents != null || sats != null)
    }
}

/** Global display conversion consumes only the operational market-quote feed. */
internal fun VaultUiState.operationalBitcoinQuote(): MarketQuote? =
    marketQuotes?.quotes?.usableQuote(MarketSymbol.BTC)

internal fun formatFinancialAmount(
    amount: FinancialAmount,
    unit: DisplayUnit,
    quote: MarketQuote? = null,
): String {
    val btcQuote = quote?.takeIf {
        it.symbol == MarketSymbol.BTC &&
            (it.status == MarketQuoteStatus.LIVE || it.status == MarketQuoteStatus.STALE)
    }
    val priceCents = btcQuote?.priceCents
    return when (unit) {
        DisplayUnit.USD ->
            amount.usdCents?.let(Money::formatUsd)
                ?: amount.sats
                    ?.takeIf { priceCents != null }
                    ?.let { Money.formatBitcoin(it, DisplayUnit.USD, priceCents) }
                ?: Money.PRICE_UNAVAILABLE

        DisplayUnit.BTC, DisplayUnit.SATS ->
            amount.sats?.let { Money.formatBitcoin(it, unit) }
                ?: amount.usdCents
                    ?.let { cents -> priceCents?.let { Money.usdCentsToSats(cents, it) } }
                    ?.let { Money.formatBitcoin(it, unit) }
                ?: Money.PRICE_UNAVAILABLE
    }
}
