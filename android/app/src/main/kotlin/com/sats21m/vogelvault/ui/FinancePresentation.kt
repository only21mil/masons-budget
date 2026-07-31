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

internal fun VaultUiState.retirementAccounts(): List<AccountValuation> {
    if (financeStatus != Freshness.LIVE) return emptyList()
    val quotes = marketQuotes?.quotes.orEmpty()
    return financeDocument?.accounts.orEmpty()
        .netWorthScopeFor(activeProfile)
        .map { it.marketValue(quotes) }
}

internal fun VaultUiState.adultNetWorthSelection(): NetWorthSelection? {
    if (!activeProfile.isAdult || financeStatus != Freshness.LIVE) return null
    val document = financeDocument ?: return null
    val quotes = marketQuotes?.quotes ?: return null
    val balance = data.netWorthBalanceForDisplay()
        ?.takeIf { activeProfile.sharesNetWorth(it.owner) }
        ?: return null
    return selectNetWorth(activeProfile, balance.totalSats, document.accounts, quotes)
}

internal fun VaultLazyListScope.financeNetWorthSummary(
    state: VaultUiState,
    displayUnit: DisplayUnit,
) {
    if (!state.activeProfile.isAdult) return
    val selection = state.adultNetWorthSelection()
    item {
        KpiStrip(
            listOf(
                Kpi(
                    label = "Adult net worth",
                    value = selection?.let { selected ->
                        when (displayUnit) {
                            DisplayUnit.USD -> selected.totalValueCents?.let(Money::formatUsd)
                            DisplayUnit.BTC -> selected.totalValueSats?.let(Money::formatBtc)
                            DisplayUnit.SATS -> selected.totalValueSats?.let(Money::formatSats)
                        }
                    } ?: SUPPRESSED,
                    hint = selection?.btcQuote?.quoteHint(),
                    provenance = Provenance.ESTIMATED,
                ),
                Kpi(
                    label = "Retirement",
                    value = if (state.financeStatus == Freshness.LIVE) {
                        state.formatFinanceCents(
                            selection?.retirementValueCents
                                ?: state.retirementAccounts().fold(0L) { total, account ->
                                    Math.addExact(total, account.valueCents)
                                },
                            displayUnit,
                        )
                    } else {
                        SUPPRESSED
                    },
                    hint = "Adult accounts only",
                    provenance = Provenance.ESTIMATED,
                ),
            ),
        )
    }
    if (selection?.totalValueCents == null) {
        item {
            StatusBanner(
                text = "Adult total unavailable",
                detail = when {
                    state.financeStatus != Freshness.LIVE ->
                        "The retirement document is unavailable or incomplete. Bitcoin alone is not shown as household net worth."
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
            val rows = state.retirementAccounts().flatMap { account ->
                account.holdings.map { RetirementHoldingRow(account, it) }
            }
            if (rows.isEmpty()) {
                item {
                    Panel("Retirement holdings", "Convex finance document") {
                        StateBlock(
                            Freshness.EMPTY,
                            title = "No retirement holdings in scope",
                            detail = "Child profiles cannot consume adult retirement accounts.",
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
): String {
    if (displayUnit == DisplayUnit.USD) return Money.formatUsd(cents)
    val btcQuote = marketQuotes?.quotes
        ?.firstOrNull { it.symbol == MarketSymbol.BTC && it.status != MarketQuoteStatus.UNAVAILABLE }
        ?: return Money.PRICE_UNAVAILABLE
    val sats = Money.usdCentsToSats(cents, checkNotNull(btcQuote.priceCents))
    return Money.formatBitcoin(sats, displayUnit, btcQuote.priceCents)
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
