package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.visibleTo
import com.sats21m.vogelvault.ui.components.Kpi
import com.sats21m.vogelvault.ui.components.KpiStrip
import com.sats21m.vogelvault.ui.components.LedgerRow
import com.sats21m.vogelvault.ui.components.Panel
import com.sats21m.vogelvault.ui.components.StateBlock
import com.sats21m.vogelvault.ui.components.VaultLazyListScope
import com.sats21m.vogelvault.ui.theme.VaultCream
import java.math.BigDecimal
import java.math.RoundingMode

internal data class BtcBuysScreenSummary(
    val rows: List<BtcBuy>,
    val totalSats: Long,
    val totalUsdCents: Long,
) {
    val averageExecutionPriceCents: Long?
        get() =
            totalSats.takeIf { it > 0L }?.let {
                runCatching {
                    BigDecimal(totalUsdCents)
                        .multiply(BigDecimal(Money.SATS_PER_BTC))
                        .divide(BigDecimal(it), 0, RoundingMode.HALF_UP)
                        .longValueExact()
                }.getOrNull()
            }
}

internal fun btcBuysScreenSummary(
    rows: List<BtcBuy>,
    viewer: FamilyMember,
): BtcBuysScreenSummary {
    val visibleRows = rows.visibleTo(viewer)
    return BtcBuysScreenSummary(
        rows = visibleRows,
        totalSats = visibleRows.sumExact(BtcBuy::sats),
        totalUsdCents = visibleRows.sumExact(BtcBuy::usdCents),
    )
}

internal fun formatBtcBuyAmount(
    buy: BtcBuy,
    displayUnit: DisplayUnit,
): String = formatFinancialAmount(
    FinancialAmount(usdCents = buy.usdCents, sats = buy.sats),
    displayUnit,
)

internal fun formatBtcBuyTotal(
    summary: BtcBuysScreenSummary,
    displayUnit: DisplayUnit,
): String = formatFinancialAmount(
    FinancialAmount(usdCents = summary.totalUsdCents, sats = summary.totalSats),
    displayUnit,
)

internal fun VaultLazyListScope.btcBuysScreen(
    state: VaultUiState,
    displayUnit: DisplayUnit,
    title: String,
) {
    val slice = state.data.btcBuys
    if (slice.suppressFigures) {
        item {
            Panel(title, slice.source) {
                StateBlock(slice.status)
            }
        }
        return
    }

    val summary = btcBuysScreenSummary(slice.value, state.activeProfile)
    if (summary.rows.isEmpty()) {
        item {
            Panel(title, slice.source) {
                StateBlock(Freshness.EMPTY)
            }
        }
        return
    }

    item {
        val selectedTotal = formatBtcBuyTotal(summary, displayUnit)
        KpiStrip(
            listOf(
                Kpi("Total bought", selectedTotal),
                Kpi(
                    "Average price",
                    summary.averageExecutionPriceCents
                        ?.let { "${Money.formatUsd(it)}/BTC" }
                        ?: Money.PRICE_UNAVAILABLE,
                ),
                Kpi("Buys", summary.rows.size.toString()),
            ),
        )
    }
    keyedPanel(
        sectionKey = "btc-buys-screen",
        title = "All buys",
        source = slice.source,
        rows = summary.rows,
        rowKey = BtcBuy::id,
    ) { buy ->
        LedgerRow(
            primary = buy.source,
            secondary = "${buy.date} · ${buy.owner.displayName} · ${Money.formatUsd(buy.priceUsdCents)}/BTC",
            figure = formatBtcBuyAmount(buy, displayUnit),
            figureColor = VaultCream,
            badge = buy.costBasisStatus,
        )
    }
}

private inline fun <T> List<T>.sumExact(value: (T) -> Long): Long =
    fold(0L) { total, row -> Math.addExact(total, value(row)) }
