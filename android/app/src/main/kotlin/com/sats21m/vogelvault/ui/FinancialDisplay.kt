package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.ReadModel
import java.math.BigDecimal
import java.math.RoundingMode

/** A dated, profile-scoped recorded buy price that may support a conversion. */
internal data class RecordedBitcoinQuote(
    val cents: Long,
    val asOf: String,
)

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

/** Error/loading/empty reads cannot lend stale rows the authority of a quote. */
internal fun ReadModel.recordedBitcoinQuote(): RecordedBitcoinQuote? {
    if (btcBuys.status !in setOf(Freshness.LIVE, Freshness.STALE, Freshness.DEMO)) return null
    val asOf = btcPriceAsOf?.takeIf(String::isNotBlank) ?: return null
    return btcPriceCents.takeIf { it > 0L }?.let { RecordedBitcoinQuote(it, asOf) }
}

internal fun formatFinancialAmount(
    amount: FinancialAmount,
    unit: DisplayUnit,
    quote: RecordedBitcoinQuote? = null,
): String =
    when (unit) {
        DisplayUnit.USD ->
            amount.usdCents?.let(Money::formatUsd)
                ?: amount.sats
                    ?.takeIf { quote != null }
                    ?.let { Money.formatBitcoin(it, DisplayUnit.USD, quote?.cents) }
                ?: Money.PRICE_UNAVAILABLE

        DisplayUnit.BTC, DisplayUnit.SATS ->
            amount.sats?.let { Money.formatBitcoin(it, unit) }
                ?: amount.usdCents
                    ?.let { cents -> quote?.let { usdCentsToSats(cents, it.cents) } }
                    ?.let { Money.formatBitcoin(it, unit) }
                ?: Money.PRICE_UNAVAILABLE
    }

/** Decimal-only conversion with one intentional, deterministic satoshi rounding boundary. */
private fun usdCentsToSats(usdCents: Long, btcPriceCents: Long): Long? =
    runCatching {
        BigDecimal(usdCents)
            .multiply(BigDecimal(Money.SATS_PER_BTC))
            .divide(BigDecimal(btcPriceCents), 0, RoundingMode.HALF_UP)
            .longValueExact()
    }.getOrNull()
