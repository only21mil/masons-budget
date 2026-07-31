package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.AccountValuation
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.HoldingValuation
import com.sats21m.vogelvault.domain.HoldingValuationBasis
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.NetWorthSelection
import com.sats21m.vogelvault.domain.marketValue
import com.sats21m.vogelvault.domain.netWorthScopeFor
import com.sats21m.vogelvault.domain.selectNetWorth
import com.sats21m.vogelvault.ui.components.Kpi
import com.sats21m.vogelvault.ui.components.KpiStrip
import com.sats21m.vogelvault.ui.components.LedgerRow
import com.sats21m.vogelvault.ui.components.Panel
import com.sats21m.vogelvault.ui.components.Provenance
import com.sats21m.vogelvault.ui.components.StateBlock
import com.sats21m.vogelvault.ui.components.StatusBanner
import com.sats21m.vogelvault.ui.components.SUPPRESSED
import com.sats21m.vogelvault.ui.components.VaultLazyListScope
import com.sats21m.vogelvault.ui.theme.VaultTextMuted
import com.sats21m.vogelvault.ui.theme.VaultWarning

internal data class RetirementHoldingRow(
    val account: AccountValuation,
    val holding: HoldingValuation,
) {
    val key: String get() = "${account.account.owner.key}:${account.account.key}:${holding.holding.name}"
}

private val retirementMarketTickers = setOf("VOO", "IBIT")

internal fun VaultUiState.retirementAccountsResult(): Result<List<AccountValuation>> {
    if (financeStatus != Freshness.LIVE) return Result.success(emptyList())
    return try {
        val quotes = marketQuotes?.quotes.orEmpty()
        Result.success(
            financeDocument?.accounts.orEmpty()
                .netWorthScopeFor(activeProfile)
                .map { it.marketValue(quotes) },
        )
    } catch (error: ArithmeticException) {
        Result.failure(error)
    }
}

internal fun VaultUiState.retirementAccounts(): List<AccountValuation> =
    retirementAccountsResult().getOrDefault(emptyList())

internal fun VaultUiState.netWorthSelectionResult(): Result<NetWorthSelection?> {
    if (financeStatus != Freshness.LIVE) return Result.success(null)
    val document = financeDocument ?: return Result.success(null)
    val quotes = marketQuotes?.quotes ?: return Result.success(null)
    val balance = data.netWorthBalanceForDisplay()
        ?.takeIf { activeProfile.sharesNetWorth(it.owner) }
        ?: return Result.success(null)
    return try {
        Result.success(selectNetWorth(activeProfile, balance.totalSats, document.accounts, quotes))
    } catch (error: ArithmeticException) {
        Result.failure(error)
    }
}

internal fun VaultUiState.netWorthSelection(): NetWorthSelection? {
    return netWorthSelectionResult().getOrNull()
}

internal data class NetWorthPresentationLabels(
    val total: String,
    val retirementHint: String,
    val unavailableTotal: String,
    val unavailableFinanceDetail: String,
    val emptyRetirementDetail: String,
)

internal fun VaultUiState.netWorthPresentationLabels(): NetWorthPresentationLabels =
    if (activeProfile.isAdult) {
        NetWorthPresentationLabels(
            total = "Adult net worth",
            retirementHint = "Adult accounts only",
            unavailableTotal = "Adult total unavailable",
            unavailableFinanceDetail =
                "The retirement document is unavailable or incomplete. Bitcoin alone is not shown as household net worth.",
            emptyRetirementDetail = "No retirement accounts are available for the adult household.",
        )
    } else {
        NetWorthPresentationLabels(
            total = "Net worth",
            retirementHint = "This profile only",
            unavailableTotal = "Net worth unavailable",
            unavailableFinanceDetail =
                "The retirement document is unavailable or incomplete. Bitcoin alone is not shown as this profile's net worth.",
            emptyRetirementDetail = "No retirement accounts are available for this profile.",
        )
    }

internal fun VaultLazyListScope.financeNetWorthSummary(
    state: VaultUiState,
    displayUnit: DisplayUnit,
) {
    val labels = state.netWorthPresentationLabels()
    val selectionResult = state.netWorthSelectionResult()
    val accountsResult = state.retirementAccountsResult()
    val selection = selectionResult.getOrNull()
    val retirementFallback = accountsResult.getOrNull()?.sumAccountValuesOrNull()
    val calculationFailed =
        selectionResult.isFailure ||
            accountsResult.isFailure ||
            (accountsResult.getOrNull()?.isNotEmpty() == true && retirementFallback == null)
    if (selection != null) item { BitcoinConversionNotice(state) }
    item {
        KpiStrip(
            listOf(
                Kpi(
                    label = labels.total,
                    value = selection?.let { selected ->
                        when (displayUnit) {
                            DisplayUnit.USD -> selected.totalValueCents?.let(Money::formatUsd)
                            DisplayUnit.BTC -> selected.totalValueSats?.let(Money::formatBtc)
                            DisplayUnit.SATS -> selected.totalValueSats?.let(Money::formatSats)
                        }
                    } ?: SUPPRESSED,
                    hint = selection?.valuationQualityHint(),
                    provenance = Provenance.ESTIMATED,
                ),
                Kpi(
                    label = "Retirement",
                    value = if (state.financeStatus == Freshness.LIVE && !calculationFailed) {
                        (selection?.retirementValueCents ?: retirementFallback)
                            ?.let { state.formatFinanceCentsOrNull(it, displayUnit) }
                            ?: SUPPRESSED
                    } else {
                        SUPPRESSED
                    },
                    hint = labels.retirementHint,
                    provenance = Provenance.ESTIMATED,
                ),
            ),
        )
    }
    if (selection?.totalValueCents == null || calculationFailed) {
        item {
            StatusBanner(
                text = labels.unavailableTotal,
                detail = when {
                    calculationFailed ->
                        "The finance values exceed Android's supported numeric range. No partial total was shown."
                    state.financeStatus != Freshness.LIVE ->
                        labels.unavailableFinanceDetail
                    state.marketQuoteStatus != Freshness.LIVE ->
                        "The market quote snapshot is unavailable or incomplete. No live value was invented."
                    else -> "The BTC quote is unavailable. Retirement remains visible, but the combined USD total does not."
                },
                tone = VaultWarning,
            )
        }
    }
}

internal fun VaultLazyListScope.retirementHoldings(
    state: VaultUiState,
    displayUnit: DisplayUnit,
) {
    item { QuotePanel(state) }
    when (state.financeStatus) {
        Freshness.LOADING, Freshness.ERROR -> item {
            Panel("Retirement holdings", "Convex finance document") {
                StateBlock(state.financeStatus)
            }
        }
        Freshness.EMPTY -> item {
            Panel("Retirement holdings", "Convex finance document") {
                StateBlock(
                    Freshness.EMPTY,
                    title = "Retirement holdings unavailable",
                    detail = "No complete finance document was returned for this profile.",
                )
            }
        }
        else -> {
            val accountResult = state.retirementAccountsResult()
            if (accountResult.isFailure) {
                item {
                    Panel("Retirement accounts", "Convex finance document") {
                        StateBlock(
                            Freshness.ERROR,
                            title = "Retirement values unavailable",
                            detail = "The synchronized values exceed Android's supported numeric range.",
                        )
                    }
                }
                return
            }
            val accounts = accountResult.getOrThrow()
            if (accounts.isEmpty()) {
                item {
                    Panel("Retirement accounts", "Convex finance document") {
                        StateBlock(
                            Freshness.EMPTY,
                            title = "No retirement accounts in scope",
                            detail = state.netWorthPresentationLabels().emptyRetirementDetail,
                        )
                    }
                }
                return
            }
            keyedPanel(
                sectionKey = "retirement-accounts",
                title = "Retirement accounts",
                source = state.financeDocument?.lastUpdated?.let { "Finance snapshot · $it" },
                rows = accounts,
                rowKey = { "${it.account.owner.key}:${it.account.key}" },
            ) { account ->
                LedgerRow(
                    primary = account.account.provider,
                    secondary = buildString {
                        append(account.account.owner.displayName)
                        append(" · ")
                        append(
                            state.formatFinanceCentsOrNull(
                                account.account.weeklyContributionCents,
                                displayUnit,
                            ) ?: Money.PRICE_UNAVAILABLE,
                        )
                        append(" weekly")
                    },
                    figure = state.formatFinanceCentsOrNull(account.valueCents, displayUnit)
                        ?: Money.PRICE_UNAVAILABLE,
                    badge = account.account.weeklyContributionDay?.uppercase() ?: "NOT SCHEDULED",
                )
            }
            val rows = accounts.flatMap { account ->
                account.holdings.map { RetirementHoldingRow(account, it) }
            }
            if (rows.isEmpty()) {
                item {
                    Panel("Retirement holdings", "Convex finance document") {
                        StateBlock(
                            Freshness.EMPTY,
                            title = "No holding detail in scope",
                            detail = "The synchronized account totals and weekly schedules remain visible above.",
                        )
                    }
                }
            } else {
                keyedPanel(
                    sectionKey = "retirement-holdings",
                    title = "Retirement holdings",
                    source = state.financeDocument?.lastUpdated?.let { "Finance snapshot · $it" },
                    rows = rows,
                    rowKey = RetirementHoldingRow::key,
                ) { row ->
                    val quote = row.holding.quote
                    LedgerRow(
                        primary = row.holding.holding.name,
                        secondary = buildString {
                            append(row.account.account.provider)
                            row.holding.holding.ticker?.let { append(" · $it") }
                            append(" · ${row.holding.holding.sharesDecimal} shares")
                        },
                        figure = state.formatFinanceCents(row.holding.valueCents, displayUnit),
                        badge = when {
                            quote?.status == MarketQuoteStatus.STALE -> "STALE QUOTE"
                            quote?.status == MarketQuoteStatus.UNAVAILABLE -> "QUOTE UNAVAILABLE"
                            row.holding.basis == HoldingValuationBasis.MARKET_QUOTE -> "QUOTE"
                            else -> "STORED VALUE"
                        },
                        badgeAccented = row.holding.basis == HoldingValuationBasis.MARKET_QUOTE &&
                            quote?.status == MarketQuoteStatus.LIVE,
                    )
                }
            }
        }
    }
}

internal fun VaultUiState.formatFinanceCents(
    cents: Long,
    displayUnit: DisplayUnit,
): String = formatFinanceCentsOrNull(cents, displayUnit) ?: Money.PRICE_UNAVAILABLE

internal fun VaultUiState.formatFinanceCentsOrNull(
    cents: Long,
    displayUnit: DisplayUnit,
): String? {
    if (displayUnit == DisplayUnit.USD) return Money.formatUsd(cents)
    val btcQuote = marketQuotes?.quotes
        ?.firstOrNull { it.symbol == MarketSymbol.BTC && it.status != MarketQuoteStatus.UNAVAILABLE }
        ?: return null
    return try {
        val sats = Money.usdCentsToSats(cents, checkNotNull(btcQuote.priceCents))
        Money.formatBitcoin(sats, displayUnit, btcQuote.priceCents)
    } catch (_: ArithmeticException) {
        null
    }
}

private fun List<AccountValuation>.sumAccountValuesOrNull(): Long? =
    try {
        fold(0L) { total, account -> Math.addExact(total, account.valueCents) }
    } catch (_: ArithmeticException) {
        null
    }

internal fun NetWorthSelection.valuationQualityHint(): String? {
    val retirementHoldings = accounts.flatMap(AccountValuation::holdings)
        .filter { holding ->
            holding.holding.ticker?.trim()?.uppercase() in retirementMarketTickers
        }
    val staleQuotes = retirementHoldings.count {
        it.basis == HoldingValuationBasis.MARKET_QUOTE &&
            it.quote?.status == MarketQuoteStatus.STALE
    }
    val storedValues = retirementHoldings.count {
        it.basis == HoldingValuationBasis.STORED_VALUE
    }
    val retirementQuality = buildList {
        if (staleQuotes > 0) add("$staleQuotes stale quote${if (staleQuotes == 1) "" else "s"}")
        if (storedValues > 0) add("$storedValues stored value${if (storedValues == 1) "" else "s"}")
    }.takeIf { it.isNotEmpty() }?.joinToString(" · ", prefix = "Retirement: ")

    return listOfNotNull(btcQuote?.quoteHint(), retirementQuality)
        .takeIf { it.isNotEmpty() }
        ?.joinToString(" · ")
}

@androidx.compose.runtime.Composable
private fun QuotePanel(state: VaultUiState) {
    val quotes = state.marketQuotes?.quotes
    if (quotes == null) {
        Panel("Market prices", "BTC · VOO · IBIT") {
            StateBlock(
                state.marketQuoteStatus,
                title = "Market prices unavailable",
                detail = "No complete quote snapshot was returned. Stored holding values are labelled when used.",
            )
        }
        return
    }
    Panel("Market prices", "BTC · VOO · IBIT") {
        MarketSymbol.entries.forEach { symbol ->
            val quote = quotes.first { it.symbol == symbol }
            LedgerRow(
                primary = symbol.name,
                secondary = quote.quoteHint(),
                figure = quote.priceCents?.let(Money::formatUsd) ?: Money.PRICE_UNAVAILABLE,
                badge = quote.status.name,
                badgeAccented = quote.status == MarketQuoteStatus.LIVE,
                figureColor = if (quote.status == MarketQuoteStatus.LIVE) {
                    com.sats21m.vogelvault.ui.theme.VaultCream
                } else {
                    VaultTextMuted
                },
            )
        }
    }
}

private fun MarketQuote.quoteHint(): String = when (status) {
    MarketQuoteStatus.LIVE -> "$source · $fetchedAt"
    MarketQuoteStatus.STALE -> "$source · stale since $fetchedAt"
    MarketQuoteStatus.UNAVAILABLE -> "$source · unavailable"
}
