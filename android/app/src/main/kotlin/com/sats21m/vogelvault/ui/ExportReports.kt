package com.sats21m.vogelvault.ui

import android.content.ClipData
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.content.FileProvider
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.ReadModel
import com.sats21m.vogelvault.domain.budgetBillPaysFor
import com.sats21m.vogelvault.domain.budgetTransactionsFor
import com.sats21m.vogelvault.domain.deriveBudgetSpend
import com.sats21m.vogelvault.domain.netWorthScopeFor
import com.sats21m.vogelvault.ui.components.Panel
import com.sats21m.vogelvault.ui.theme.VaultSpace
import java.io.File
import java.math.BigDecimal
import java.math.BigInteger
import java.time.LocalDate

internal data class CsvExport(
    val filename: String,
    val content: String,
)

internal object ExportReports {
    fun transactions(
        viewer: FamilyMember,
        data: ReadModel,
        generatedOn: LocalDate,
    ): CsvExport {
        val rows = data.transactions.value
            .netWorthScopeFor(viewer)
            .sortedByDescending { it.date }
        val content = buildString {
            appendLine("Date,Merchant,Amount,Category,Card,Note,Owner")
            for (transaction in rows) {
                appendCsvRow(
                    transaction.date,
                    formulaSafeText(transaction.merchant),
                    exactUsd(transaction.amount),
                    formulaSafeText(transaction.category),
                    formulaSafeText(
                        paymentSourceDisplay(transaction.card, missingLabel = "On-chain"),
                    ),
                    formulaSafeText(transaction.note.orEmpty()),
                    transaction.owner.key,
                )
            }
        }
        return CsvExport("transactions-$generatedOn.csv", content)
    }

    fun budgetSummary(
        viewer: FamilyMember,
        data: ReadModel,
    ): CsvExport {
        val budget = data.budget.value?.takeIf { viewer.sharesNetWorth(it.owner) }
        val actualsUnavailable = budget == null || data.budgetActualsUnavailable
        val derived = budget?.takeUnless { actualsUnavailable }?.let {
            deriveBudgetSpend(
                it,
                data.transactions.value.budgetTransactionsFor(viewer),
                data.btcBillPays.value.budgetBillPaysFor(viewer),
            )
        }
        val content = buildString {
            appendLine("Category,Budget,Actual,Remaining,Percent Used")
            if (derived == null) {
                // A report with no numeric rows is ambiguous; name the failure
                // rather than silently exporting a partial budget as zero spend.
                appendCsvRow("UNAVAILABLE", "", "", "", "")
            } else {
                derived.categories.forEach { category ->
                    appendCsvRow(
                        formulaSafeText(category.name),
                        exactUsd(category.budgetCents),
                        exactUsd(category.spentCents),
                        exactUsd(category.remainingCents),
                        percentUsed(category.spentCents, category.budgetCents),
                    )
                }
            }
        }
        return CsvExport("budget-${budget?.month ?: "unavailable"}.csv", content)
    }

    /**
     * Android currently receives one authoritative BTC net-worth snapshot, not a
     * historical series. Export that exact dated snapshot as the first history
     * row and never synthesize missing months or non-Bitcoin holdings.
     */
    fun netWorthHistory(
        viewer: FamilyMember,
        data: ReadModel,
        generatedOn: LocalDate,
    ): CsvExport {
        val balance = data.btcBalance.value?.takeIf { viewer.sharesNetWorth(it.owner) }
        val scopedAccounts = balance?.accounts.orEmpty().netWorthScopeFor(viewer)
        val totalCents = scopedAccounts.fold(0L) { total, account ->
            Math.addExact(total, account.fiatCents)
        }
        val content = buildString {
            appendLine("Date,Total USD,BTC USD")
            if (balance != null) {
                appendCsvRow(
                    balance.asOf,
                    exactUsd(totalCents),
                    exactUsd(totalCents),
                )
            }
        }
        return CsvExport("net-worth-$generatedOn.csv", content)
    }

    private fun StringBuilder.appendCsvRow(vararg fields: String) {
        appendLine(fields.joinToString(",") { csvEscape(it) })
    }

    private fun csvEscape(value: String): String =
        if (value.any { it == ',' || it == '"' || it == '\n' || it == '\r' }) {
            "\"${value.replace("\"", "\"\"")}\""
        } else {
            value
        }

    /**
     * Spreadsheet programs evaluate cells beginning with these characters as
     * formulas. Prefix only user-controlled text fields so signed numeric export
     * values remain numeric.
     */
    private fun formulaSafeText(value: String): String =
        if (
            value.firstOrNull() in FORMULA_CONTROL_PREFIXES ||
            value.trimStart().firstOrNull() in FORMULA_PREFIXES
        ) {
            "'$value"
        } else {
            value
        }

    private fun exactUsd(cents: Long): String =
        BigDecimal.valueOf(cents, 2).toPlainString()

    private fun percentUsed(actualCents: Long, budgetCents: Long): String {
        if (budgetCents <= 0L) return "0%"
        val percent = BigInteger.valueOf(actualCents)
            .multiply(BigInteger.valueOf(100L))
            .divide(BigInteger.valueOf(budgetCents))
        return "$percent%"
    }

    private val FORMULA_PREFIXES = setOf('=', '+', '-', '@')
    private val FORMULA_CONTROL_PREFIXES = setOf('\t', '\r', '\n')
}

@Composable
fun ExportScreen(
    state: VaultUiState,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val today = LocalDate.now()
    Panel(
        title = stringResource(R.string.export_reports_title),
        source = stringResource(R.string.export_reports_scope),
        modifier = modifier,
    ) {
        Column(
            verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
            modifier = Modifier
                .fillMaxWidth()
                .padding(VaultSpace.md),
        ) {
            ExportButton(stringResource(R.string.export_transactions)) {
                shareCsv(context, ExportReports.transactions(state.activeProfile, state.data, today))
            }
            ExportButton(stringResource(R.string.export_budget_summary)) {
                shareCsv(context, ExportReports.budgetSummary(state.activeProfile, state.data))
            }
            ExportButton(stringResource(R.string.export_net_worth_history)) {
                shareCsv(context, ExportReports.netWorthHistory(state.activeProfile, state.data, today))
            }
        }
    }
}

@Composable
private fun ExportButton(
    label: String,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Icon(Icons.Filled.Share, contentDescription = null)
        Text(label)
    }
}

private fun shareCsv(
    context: Context,
    report: CsvExport,
) {
    val exportDirectory = File(context.cacheDir, "exports").apply { mkdirs() }
    val file = File(exportDirectory, report.filename).apply {
        writeText(report.content, Charsets.UTF_8)
    }
    val uri = FileProvider.getUriForFile(
        context,
        "${context.packageName}.fileprovider",
        file,
    )
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/csv"
        putExtra(Intent.EXTRA_STREAM, uri)
        clipData = ClipData.newUri(context.contentResolver, report.filename, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(
        Intent.createChooser(intent, context.getString(R.string.export_share_chooser)),
    )
}
