package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.sats21m.vogelvault.R
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
    val totalSats: Long?,
    val totalUsdCents: Long?,
    val totalFeeUsdCents: Long?,
)

internal fun btcBillPaysScreenSummary(
    rows: List<BtcBillPay>,
    viewer: FamilyMember,
): BtcBillPaysScreenSummary {
    val visibleRows = rows.visibleTo(viewer)
    return BtcBillPaysScreenSummary(
        rows = visibleRows,
        totalSats = visibleRows.sumLongOrNull(BtcBillPay::btcSpentSats),
        totalUsdCents = visibleRows.sumLongOrNull(BtcBillPay::amountUsdCents),
        totalFeeUsdCents = visibleRows.sumLongOrNull(BtcBillPay::feeUsdCents),
    )
}

internal fun formatBtcBillPayAmount(
    payment: BtcBillPay,
    displayUnit: DisplayUnit,
): String {
    val amount = when (displayUnit) {
        DisplayUnit.USD -> payment.amountUsdCents.negateOrNull()?.let { FinancialAmount(usdCents = it) }
        DisplayUnit.BTC, DisplayUnit.SATS ->
            payment.btcSpentSats.negateOrNull()?.let { FinancialAmount(sats = it) }
    } ?: return com.sats21m.vogelvault.domain.Money.PRICE_UNAVAILABLE
    return formatFinancialAmount(amount, displayUnit)
}

internal fun formatBtcBillPayTotal(
    summary: BtcBillPaysScreenSummary,
    displayUnit: DisplayUnit,
): String {
    val amount = when (displayUnit) {
        DisplayUnit.USD -> summary.totalUsdCents?.let { FinancialAmount(usdCents = it) }
        DisplayUnit.BTC, DisplayUnit.SATS -> summary.totalSats?.let { FinancialAmount(sats = it) }
    } ?: return com.sats21m.vogelvault.domain.Money.PRICE_UNAVAILABLE
    return formatFinancialAmount(amount, displayUnit)
}

internal fun formatBtcBillPayFee(
    feeUsdCents: Long?,
    displayUnit: DisplayUnit,
    quote: MarketQuote?,
): String = feeUsdCents?.let {
    formatFinancialAmount(FinancialAmount(usdCents = it), displayUnit, quote)
} ?: com.sats21m.vogelvault.domain.Money.PRICE_UNAVAILABLE

internal fun VaultLazyListScope.btcBillPaysScreen(
    state: VaultUiState,
    displayUnit: DisplayUnit,
    title: String,
    onAddBillPay: () -> Unit,
) {
    val slice = state.data.btcBillPays
    if (canAddBtcBillPay(slice.status, state.activeProfile)) {
        item { BtcBillPayEntryAction(onAddBillPay) }
    }
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

    val convertsFees = displayUnit != DisplayUnit.USD && summary.rows.any { it.feeUsdCents != 0L }

    item {
        val selectedTotal = formatBtcBillPayTotal(summary, displayUnit)
        val quote = state.operationalBitcoinQuote()
        KpiStrip(
            listOf(
                Kpi("Total paid", selectedTotal),
                Kpi(
                    "Fees",
                    formatBtcBillPayFee(summary.totalFeeUsdCents, displayUnit, quote),
                    hint = if (convertsFees) state.bitcoinConversionProvenance() else null,
                ),
                Kpi("Payments", summary.rows.size.toString()),
            ),
        )
    }
    keyedPanel(
        sectionKey = "btc-bill-pays-screen",
        title = "All bill pays",
        source = if (convertsFees) {
            "${slice.source} · ${state.bitcoinConversionProvenance()}"
        } else {
            slice.source
        },
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

@Composable
internal fun BtcBillPayEntryAction(onClick: () -> Unit) {
    VaultButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.btc_bill_pay_add_action))
    }
}
