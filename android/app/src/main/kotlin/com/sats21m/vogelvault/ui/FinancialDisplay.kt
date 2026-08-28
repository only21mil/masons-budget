package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.at
import com.sats21m.vogelvault.domain.marketQuoteFor

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

internal fun FinancialAmount.requiresOperationalQuote(unit: DisplayUnit): Boolean =
    when (unit) {
        DisplayUnit.USD -> usdCents == null
        DisplayUnit.BTC, DisplayUnit.SATS -> sats == null
    }

/** Global display conversion consumes only the operational market-quote feed. */
internal fun VaultUiState.bitcoinQuoteObservation(): MarketQuote? =
    marketQuotes?.at(now)?.quotes?.marketQuoteFor(MarketSymbol.BTC)

internal fun VaultUiState.operationalBitcoinQuote(): MarketQuote? =
    bitcoinQuoteObservation()?.takeIf { it.isUsable }

/** Write conversions fail closed unless the locally aged quote is live. */
internal fun VaultUiState.liveBitcoinQuote(): MarketQuote? =
    operationalBitcoinQuote()?.takeIf { it.status == MarketQuoteStatus.LIVE }

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
    return runCatching { when (unit) {
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
    } }.getOrDefault(Money.PRICE_UNAVAILABLE)
}

internal inline fun <T> Iterable<T>.sumLongOrNull(value: (T) -> Long): Long? =
    runCatching { fold(0L) { total, row -> Math.addExact(total, value(row)) } }.getOrNull()

internal fun Long.negateOrNull(): Long? = runCatching { Math.negateExact(this) }.getOrNull()
