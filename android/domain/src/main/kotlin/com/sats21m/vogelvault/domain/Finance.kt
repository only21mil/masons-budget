package com.sats21m.vogelvault.domain

import java.math.BigInteger
import java.time.Instant

/**
 * Synced retirement data and operational quotes intentionally use different
 * contracts. A quote cached on one device is not a Convex retirement record.
 */
enum class MarketSymbol { BTC, VOO, IBIT }

enum class MarketQuoteStatus { LIVE, STALE, UNAVAILABLE }

data class MarketQuote(
    val symbol: MarketSymbol,
    val priceCents: Long?,
    val source: String,
    val fetchedAt: String?,
    val status: MarketQuoteStatus,
) {
    init {
        require(source.isNotBlank()) { "Market quote source must not be empty" }
        when (status) {
            MarketQuoteStatus.UNAVAILABLE ->
                require(priceCents == null) { "Unavailable $symbol quote must not carry a price" }
            MarketQuoteStatus.LIVE, MarketQuoteStatus.STALE -> {
                require(priceCents != null && priceCents > 0L) {
                    "$status $symbol quote must carry a positive price"
                }
                require(fetchedAt != null && fetchedAt.isCanonicalQuoteInstant()) {
                    "$status $symbol quote must carry a canonical ISO-8601 fetchedAt"
                }
            }
        }
    }

    val isUsable: Boolean
        get() = status != MarketQuoteStatus.UNAVAILABLE
}

private val canonicalQuoteInstant =
    Regex("""\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z""")

private fun String.isCanonicalQuoteInstant(): Boolean {
    if (!canonicalQuoteInstant.matches(this)) return false
    val normalized = try {
        Instant.parse(this).toString()
    } catch (_: java.time.format.DateTimeParseException) {
        return false
    }
    return this == normalized || this == normalized.removeSuffix("Z") + ".000Z"
}

data class MarketQuoteSnapshot(val quotes: List<MarketQuote>) {
    init {
        require(quotes.size == MarketSymbol.entries.size) {
            "Market quote snapshot must contain ${MarketSymbol.entries.size} quotes"
        }
        require(quotes.map { it.symbol }.toSet() == MarketSymbol.entries.toSet()) {
            "Market quote snapshot must contain BTC, VOO, and IBIT exactly once"
        }
    }
}

fun List<MarketQuote>.marketQuoteFor(symbol: MarketSymbol): MarketQuote? =
    firstOrNull { it.symbol == symbol }

fun List<MarketQuote>.usableQuote(symbol: MarketSymbol): MarketQuote? =
    marketQuoteFor(symbol)?.takeIf { it.isUsable }

data class FinanceLot(
    val date: String,
    val type: String,
    val pricePerShareCents: Long,
    val sharesDecimal: String,
    val amountInvestedCents: Long,
    val note: String? = null,
)

data class FinanceHolding(
    val name: String,
    val category: String,
    val ticker: String?,
    val valueCents: Long,
    val costBasisCents: Long,
    val gainBps: Long,
    val sharesDecimal: String,
    val avgCostCents: Long,
    val currentPricePerShareCents: Long,
    val isProxy: Boolean,
    val proxyNote: String? = null,
    val lots: List<FinanceLot> = emptyList(),
)

data class FinanceAccount(
    val key: String,
    override val owner: FamilyMember,
    val provider: String,
    val totalValueCents: Long,
    val weeklyContributionCents: Long,
    /** Synced schedule metadata, not an instruction to execute a market order. */
    val weeklyContributionDay: String?,
    val holdings: List<FinanceHolding>,
) : Owned

data class FinanceDocument(
    val updatedAtMs: Long,
    val lastUpdated: String,
    /**
     * Compatibility projection only. Net worth derives scoped [accounts] and
     * never adds this total again.
     */
    val retirementTotalCents: Long?,
    val accounts: List<FinanceAccount>,
)

enum class HoldingValuationBasis { MARKET_QUOTE, STORED_VALUE }

data class HoldingValuation(
    val holding: FinanceHolding,
    val valueCents: Long,
    val basis: HoldingValuationBasis,
    val quote: MarketQuote?,
)

data class AccountValuation(
    val account: FinanceAccount,
    val valueCents: Long,
    val holdings: List<HoldingValuation>,
)

fun FinanceHolding.marketValue(quotes: List<MarketQuote>): HoldingValuation {
    val symbol = when (ticker?.trim()?.uppercase()) {
        "VOO" -> MarketSymbol.VOO
        "IBIT" -> MarketSymbol.IBIT
        else -> null
    }
    val observation = symbol?.let(quotes::marketQuoteFor)
    val quote = observation?.takeIf { it.isUsable }
    return if (quote != null) {
        HoldingValuation(
            holding = this,
            valueCents = Money.sharesToValueCents(sharesDecimal, checkNotNull(quote.priceCents)),
            basis = HoldingValuationBasis.MARKET_QUOTE,
            quote = quote,
        )
    } else {
        HoldingValuation(this, valueCents, HoldingValuationBasis.STORED_VALUE, observation)
    }
}

fun FinanceAccount.marketValue(quotes: List<MarketQuote>): AccountValuation {
    val holdingValues = holdings.map { it.marketValue(quotes) }
    val holdingTotal = holdingValues.fold(0L) { total, holding ->
        Math.addExact(total, holding.valueCents)
    }
    return AccountValuation(
        account = this,
        valueCents = if (holdingTotal > 0L) holdingTotal else totalValueCents,
        holdings = holdingValues,
    )
}

data class NetWorthSelection(
    val bitcoinSats: Long,
    val bitcoinValueCents: Long?,
    val retirementValueCents: Long,
    val retirementValueSats: Long?,
    val totalValueCents: Long?,
    val totalValueSats: Long?,
    val accounts: List<AccountValuation>,
    val btcQuote: MarketQuote?,
)

/**
 * Select one profile's net worth without adding the same retirement holdings
 * both as account values and as the document-level retirement projection.
 */
fun selectNetWorth(
    viewer: FamilyMember,
    bitcoinSats: Long,
    financeAccounts: List<FinanceAccount>,
    quotes: List<MarketQuote>,
): NetWorthSelection {
    val accounts = financeAccounts.netWorthScopeFor(viewer).map { it.marketValue(quotes) }
    val retirementCents = accounts.fold(0L) { total, account ->
        Math.addExact(total, account.valueCents)
    }
    val btcObservation = quotes.marketQuoteFor(MarketSymbol.BTC)
    val btcQuote = btcObservation?.takeIf { it.isUsable }
        ?: return NetWorthSelection(
            bitcoinSats = bitcoinSats,
            bitcoinValueCents = null,
            retirementValueCents = retirementCents,
            retirementValueSats = null,
            totalValueCents = null,
            totalValueSats = null,
            accounts = accounts,
            btcQuote = btcObservation,
        )

    val price = checkNotNull(btcQuote.priceCents)
    val bitcoinCents = Money.satsToUsdCents(bitcoinSats, price)
    val retirementSats = Money.usdCentsToSats(retirementCents, price)
    return NetWorthSelection(
        bitcoinSats = bitcoinSats,
        bitcoinValueCents = bitcoinCents,
        retirementValueCents = retirementCents,
        retirementValueSats = retirementSats,
        totalValueCents = Math.addExact(bitcoinCents, retirementCents),
        totalValueSats = Math.addExact(bitcoinSats, retirementSats),
        accounts = accounts,
        btcQuote = btcQuote,
    )
}

enum class BudgetHealthStatus { ON_TRACK, CLOSE, OVER }

data class BudgetHealth(
    val status: BudgetHealthStatus,
    val label: String,
    val usedPercent: Int,
    val barBasisPoints: Int,
    val remainingPercent: Int?,
    val overPercent: Int?,
)

/**
 * iOS parity: green below 85%, yellow from 85% through exactly 100%, red only
 * when spend exceeds the limit. Percentages are truncated whole numbers.
 */
fun budgetHealth(plannedCents: Long, spentCents: Long): BudgetHealth {
    if (plannedCents <= 0L) {
        val isOver = spentCents > plannedCents
        return BudgetHealth(
            status = if (isOver) BudgetHealthStatus.OVER else BudgetHealthStatus.ON_TRACK,
            label = if (isOver) "OVER" else "ON TRACK",
            usedPercent = if (isOver) 200 else 0,
            barBasisPoints = if (isOver) 10_000 else 0,
            remainingPercent = if (isOver) null else 100,
            overPercent = if (isOver) 100 else null,
        )
    }

    val planned = BigInteger.valueOf(plannedCents)
    val spent = BigInteger.valueOf(spentCents)
    val rawBps = spent.multiply(BigInteger.valueOf(10_000L)).divide(planned)
    val visualBps = rawBps.coerceIn(BigInteger.ZERO, BigInteger.valueOf(20_000L))
    val isOver = spentCents > plannedCents
    val isClose = rawBps >= BigInteger.valueOf(8_500L) && !isOver
    val status = when {
        isOver -> BudgetHealthStatus.OVER
        isClose -> BudgetHealthStatus.CLOSE
        else -> BudgetHealthStatus.ON_TRACK
    }
    val remaining = if (isOver) null else {
        planned.subtract(spent).multiply(BigInteger.valueOf(100L)).divide(planned).toInt()
    }
    val over = if (isOver) {
        spent.subtract(planned)
            .multiply(BigInteger.valueOf(100L))
            .divide(planned)
            .coerceIn(BigInteger.ZERO, BigInteger.valueOf(100L))
            .toInt()
    } else {
        null
    }
    return BudgetHealth(
        status = status,
        label = when (status) {
            BudgetHealthStatus.ON_TRACK -> "ON TRACK"
            BudgetHealthStatus.CLOSE -> "CLOSE"
            BudgetHealthStatus.OVER -> "OVER"
        },
        usedPercent = visualBps.divide(BigInteger.valueOf(100L)).toInt(),
        barBasisPoints = visualBps.coerceAtMost(BigInteger.valueOf(10_000L)).toInt(),
        remainingPercent = remaining,
        overPercent = over,
    )
}

/**
 * Exact category rows for one viewer and month, including refunds/credits that
 * reduce the signed category spend.
 */
fun List<Transaction>.budgetCategoryTransactionsFor(
    viewer: FamilyMember,
    month: String,
    category: String,
): List<Transaction> =
    budgetTransactionsFor(viewer)
        .inMonth(month)
        .filter { it.category == category }
