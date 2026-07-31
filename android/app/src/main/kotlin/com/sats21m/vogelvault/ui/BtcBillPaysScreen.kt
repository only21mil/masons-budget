package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.BtcBillPay
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.visibleTo
import com.sats21m.vogelvault.ui.components.Kpi
import com.sats21m.vogelvault.ui.components.KpiStrip
import com.sats21m.vogelvault.ui.components.LedgerRow
import com.sats21m.vogelvault.ui.components.Panel
import com.sats21m.vogelvault.ui.components.StateBlock
import com.sats21m.vogelvault.ui.components.VaultLazyListScope
import com.sats21m.vogelvault.ui.theme.VaultNegative

internal data class BtcBillPaysScreenSummary(
    val rows: List<BtcBillPay>,
    val totalSats: Long,
    val totalUsdCents: Long,
    val totalFeeUsdCents: Long,
)

internal fun btcBillPaysScreenSummary(
    rows: List<BtcBillPay>,
    viewer: FamilyMember,
): BtcBillPaysScreenSummary {
    val visibleRows = rows.visibleTo(viewer)
    return BtcBillPaysScreenSummary(
        rows = visibleRows,
        totalSats = visibleRows.sumExact(BtcBillPay::btcSpentSats),
        totalUsdCents = visibleRows.sumExact(BtcBillPay::amountUsdCents),
        totalFeeUsdCents = visibleRows.sumExact(BtcBillPay::feeUsdCents),
    )
}

internal fun formatBtcBillPayAmount(
    payment: BtcBillPay,
    displayUnit: DisplayUnit,
): String = formatFinancialAmount(
    FinancialAmount(
        usdCents = Math.negateExact(payment.amountUsdCents),
        sats = Math.negateExact(payment.btcSpentSats),
    ),
    displayUnit,
)

internal fun formatBtcBillPayTotal(
    summary: BtcBillPaysScreenSummary,
    displayUnit: DisplayUnit,
): String = formatFinancialAmount(
    FinancialAmount(usdCents = summary.totalUsdCents, sats = summary.totalSats),
    displayUnit,
)

internal fun formatBtcBillPayFee(
    feeUsdCents: Long,
    displayUnit: DisplayUnit,
    quote: MarketQuote?,
): String = formatFinancialAmount(
    FinancialAmount(usdCents = feeUsdCents),
    displayUnit,
    quote,
)

internal fun VaultLazyListScope.btcBillPaysScreen(
    state: VaultUiState,
    displayUnit: DisplayUnit,
    title: String,
) {
    val slice = state.data.btcBillPays
    if (slice.suppressFigures) {
        item {
            Panel(title, slice.source) {
                StateBlock(slice.status)
            }
        }
        return
    }

    val summary = btcBillPaysScreenSummary(slice.value, state.activeProfile)
    if (summary.rows.isEmpty()) {
        item {
            Panel(title, slice.source) {
                StateBlock(Freshness.EMPTY)
            }
        }
        return
    }

    item {
        val selectedTotal = formatBtcBillPayTotal(summary, displayUnit)
        val quote = state.operationalBitcoinQuote()
        KpiStrip(
            listOf(
                Kpi("Total paid", selectedTotal),
                Kpi("Fees", formatBtcBillPayFee(summary.totalFeeUsdCents, displayUnit, quote)),
                Kpi("Payments", summary.rows.size.toString()),
            ),
        )
    }
    keyedPanel(
        sectionKey = "btc-bill-pays-screen",
        title = "All bill pays",
        source = slice.source,
        rows = summary.rows,
        rowKey = BtcBillPay::id,
    ) { payment ->
        val quote = state.operationalBitcoinQuote()
        val fee = payment.feeUsdCents
            .takeIf { it != 0L }
            ?.let { " · fee ${formatBtcBillPayFee(it, displayUnit, quote)}" }
            .orEmpty()
        LedgerRow(
            primary = payment.merchant,
            secondary = "${payment.date} · ${payment.category} · ${payment.owner.displayName}$fee",
            figure = formatBtcBillPayAmount(payment, displayUnit),
            figureColor = VaultNegative,
            badge = payment.platform,
        )
    }
}

private inline fun <T> List<T>.sumExact(value: (T) -> Long): Long =
    fold(0L) { total, row -> Math.addExact(total, value(row)) }
