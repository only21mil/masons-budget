package com.sats21m.vogelvault.csvimport

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.ui.theme.VaultAccent
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultLine
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultPositive
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultSurface
import com.sats21m.vogelvault.ui.theme.VaultSurfaceSunken
import com.sats21m.vogelvault.ui.theme.VaultTextDim
import com.sats21m.vogelvault.ui.theme.VaultTextMuted
import com.sats21m.vogelvault.ui.theme.VaultWarning
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal sealed interface CsvImportWriteResult {
    data class Success(val count: Int) : CsvImportWriteResult
    data object Failed : CsvImportWriteResult
}

private enum class CsvWizardStep {
    SOURCE,
    PREVIEW,
    DONE,
}

/**
 * Activity-screen entry point plus a full-screen source/preview/import wizard.
 *
 * [onImport] is deliberately nullable. Android has no approved runtime sync
 * credential composition yet, so unconfigured builds expose parsing and review
 * while disabling the final financial write instead of pretending it succeeded.
 */
@Composable
internal fun CsvImportLauncher(
    owner: FamilyMember,
    existingTransactions: List<Transaction>,
    btcPriceCents: Long,
    onImport: (suspend (List<CsvPreparedTransaction>) -> CsvImportWriteResult)?,
    modifier: Modifier = Modifier,
) {
    var open by rememberSaveable { mutableStateOf(false) }

    OutlinedButton(
        onClick = { open = true },
        modifier = modifier,
    ) {
        Text(stringResource(R.string.csv_import_action))
    }

    if (open) {
        CsvImportWizard(
            owner = owner,
            existingTransactions = existingTransactions,
            btcPriceCents = btcPriceCents.takeIf { it > 0L },
            onImport = onImport,
            onDismiss = { open = false },
        )
    }
}

@Composable
private fun CsvImportWizard(
    owner: FamilyMember,
    existingTransactions: List<Transaction>,
    btcPriceCents: Long?,
    onImport: (suspend (List<CsvPreparedTransaction>) -> CsvImportWriteResult)?,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val service = remember { CsvImportService() }
    var step by remember { mutableStateOf(CsvWizardStep.SOURCE) }
    var source by remember { mutableStateOf<CsvImportSource?>(null) }
    var rows by remember { mutableStateOf(emptyList<CsvImportedTransaction>()) }
    var selectedIds by remember { mutableStateOf(emptySet<String>()) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var importedCount by remember { mutableStateOf(0) }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        val pickedSource = source
        if (uri == null || pickedSource == null) return@rememberLauncherForActivityResult
        loading = true
        error = null
        scope.launch {
            val result = runCatching {
                val bytes = withContext(Dispatchers.IO) {
                    context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: throw IOException("The selected file could not be opened")
                }
                service.parse(bytes, pickedSource, btcPriceCents)
            }
            loading = false
            result.fold(
                onSuccess = { parsed ->
                    val unique = service.filterDuplicates(parsed, existingTransactions, owner)
                    rows = unique
                    selectedIds = unique.mapTo(mutableSetOf(), CsvImportedTransaction::id)
                    step = CsvWizardStep.PREVIEW
                },
                onFailure = {
                    error = it.message ?: context.getString(R.string.csv_import_parse_failed)
                },
            )
        }
    }

    Dialog(
        onDismissRequest = { if (!loading) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = VaultSurfaceSunken,
        ) {
            when (step) {
                CsvWizardStep.SOURCE -> CsvSourceStep(
                    loading = loading,
                    error = error,
                    onPick = {
                        source = it
                        picker.launch(arrayOf("text/csv", "text/comma-separated-values", "text/plain"))
                    },
                    onDismiss = onDismiss,
                )

                CsvWizardStep.PREVIEW -> CsvPreviewStep(
                    rows = rows,
                    selectedIds = selectedIds,
                    btcPriceCents = btcPriceCents,
                    writeAvailable = onImport != null,
                    loading = loading,
                    error = error,
                    onToggle = { id ->
                        selectedIds = if (id in selectedIds) selectedIds - id else selectedIds + id
                    },
                    onToggleAll = {
                        selectedIds = if (selectedIds.size == rows.size) {
                            emptySet()
                        } else {
                            rows.mapTo(mutableSetOf(), CsvImportedTransaction::id)
                        }
                    },
                    onBack = {
                        step = CsvWizardStep.SOURCE
                        error = null
                    },
                    onImport = {
                        val writer = onImport ?: return@CsvPreviewStep
                        val selected = rows.filter { it.id in selectedIds }
                        loading = true
                        error = null
                        scope.launch {
                            val prepared = runCatching {
                                service.prepareTransactions(selected, owner)
                            }.getOrElse {
                                loading = false
                                error = it.message ?: context.getString(R.string.csv_import_failed)
                                return@launch
                            }
                            when (val result = writer(prepared)) {
                                is CsvImportWriteResult.Success -> {
                                    loading = false
                                    importedCount = result.count
                                    step = CsvWizardStep.DONE
                                }
                                CsvImportWriteResult.Failed -> {
                                    loading = false
                                    error = context.getString(R.string.csv_import_failed)
                                }
                            }
                        }
                    },
                    onDismiss = onDismiss,
                )

                CsvWizardStep.DONE -> CsvDoneStep(importedCount, onDismiss)
            }
        }
    }
}

@Composable
private fun CsvSourceStep(
    loading: Boolean,
    error: String?,
    onPick: (CsvImportSource) -> Unit,
    onDismiss: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .padding(VaultSpace.lg),
        verticalArrangement = Arrangement.spacedBy(VaultSpace.md),
    ) {
        WizardHeader(
            title = stringResource(R.string.csv_import_title),
            subtitle = stringResource(R.string.csv_import_choose_source),
            onDismiss = onDismiss,
        )
        if (error != null) ErrorText(error)
        if (loading) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = VaultAccent)
            }
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
                contentPadding = PaddingValues(bottom = VaultSpace.lg),
            ) {
                items(CsvImportSource.entries, key = CsvImportSource::name) { source ->
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPick(source) },
                        color = VaultSurface,
                        shape = MaterialTheme.shapes.medium,
                    ) {
                        Column(Modifier.padding(VaultSpace.md)) {
                            Text(source.label, color = VaultCream, style = MaterialTheme.typography.titleMedium)
                            Text(
                                source.description,
                                color = VaultTextMuted,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CsvPreviewStep(
    rows: List<CsvImportedTransaction>,
    selectedIds: Set<String>,
    btcPriceCents: Long?,
    writeAvailable: Boolean,
    loading: Boolean,
    error: String?,
    onToggle: (String) -> Unit,
    onToggleAll: () -> Unit,
    onBack: () -> Unit,
    onImport: () -> Unit,
    onDismiss: () -> Unit,
) {
    val priceAvailable = btcPriceCents != null
    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier.padding(
                start = VaultSpace.lg,
                top = VaultSpace.lg,
                end = VaultSpace.lg,
                bottom = VaultSpace.sm,
            ),
        ) {
            WizardHeader(
                title = stringResource(R.string.csv_import_preview_title),
                subtitle = stringResource(R.string.csv_import_unique_rows, rows.size),
                onDismiss = onDismiss,
            )
            if (!priceAvailable) {
                WarningText(stringResource(R.string.csv_import_price_unavailable))
            } else {
                WarningText(
                    stringResource(
                        R.string.csv_import_price_basis,
                        Money.formatUsd(btcPriceCents),
                    ),
                )
            }
            if (!writeAvailable) {
                WarningText(stringResource(R.string.csv_import_write_unavailable))
            }
            if (error != null) ErrorText(error)
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.csv_import_selected_count, selectedIds.size, rows.size),
                    color = VaultTextMuted,
                    style = MaterialTheme.typography.bodySmall,
                )
                TextButton(onClick = onToggleAll, enabled = rows.isNotEmpty() && !loading) {
                    Text(
                        stringResource(
                            if (selectedIds.size == rows.size) {
                                R.string.csv_import_select_none
                            } else {
                                R.string.csv_import_select_all
                            },
                        ),
                    )
                }
            }
        }

        if (rows.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(
                    stringResource(R.string.csv_import_no_unique_rows),
                    color = VaultTextMuted,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        } else {
            LazyColumn(Modifier.weight(1f)) {
                items(rows, key = CsvImportedTransaction::id) { row ->
                    CsvPreviewRow(
                        row = row,
                        selected = row.id in selectedIds,
                        enabled = !loading,
                        onToggle = { onToggle(row.id) },
                    )
                    HorizontalDivider(color = VaultLine)
                }
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .padding(VaultSpace.md),
            horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm),
        ) {
            OutlinedButton(onClick = onBack, enabled = !loading) {
                Text(stringResource(R.string.csv_import_back))
            }
            Button(
                onClick = onImport,
                enabled =
                    selectedIds.isNotEmpty() &&
                        priceAvailable &&
                        writeAvailable &&
                        !loading,
                modifier = Modifier.weight(1f),
            ) {
                if (loading) {
                    CircularProgressIndicator(
                        modifier = Modifier.height(20.dp),
                        strokeWidth = 2.dp,
                        color = VaultSurfaceSunken,
                    )
                } else {
                    Text(stringResource(R.string.csv_import_confirm, selectedIds.size))
                }
            }
        }
    }
}

@Composable
private fun CsvPreviewRow(
    row: CsvImportedTransaction,
    selected: Boolean,
    enabled: Boolean,
    onToggle: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onToggle)
            .padding(horizontal = VaultSpace.md, vertical = VaultSpace.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = selected, onCheckedChange = { onToggle() }, enabled = enabled)
        Column(Modifier.weight(1f)) {
            Text(row.merchant, color = VaultCream, style = MaterialTheme.typography.bodyMedium)
            Text(
                "${row.date} · ${row.category}",
                color = VaultTextMuted,
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                Money.formatSats(row.sats),
                color = VaultTextDim,
                style = MaterialTheme.typography.labelSmall,
            )
        }
        Text(
            row.amountUsdCents?.let(Money::formatUsd)
                ?: stringResource(R.string.csv_import_price_short),
            color = when {
                row.amountUsdCents == null -> VaultWarning
                row.isIncome || row.amountUsdCents < 0L -> VaultPositive
                else -> VaultNegative
            },
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun CsvDoneStep(
    importedCount: Int,
    onDismiss: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .padding(VaultSpace.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            stringResource(R.string.csv_import_complete),
            color = VaultCream,
            style = MaterialTheme.typography.headlineMedium,
        )
        Spacer(Modifier.height(VaultSpace.sm))
        Text(
            stringResource(R.string.csv_import_complete_count, importedCount),
            color = VaultTextMuted,
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(VaultSpace.lg))
        Button(onClick = onDismiss) {
            Text(stringResource(R.string.csv_import_done))
        }
    }
}

@Composable
private fun WizardHeader(
    title: String,
    subtitle: String,
    onDismiss: () -> Unit,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f)) {
            Text(title, color = VaultCream, style = MaterialTheme.typography.headlineMedium)
            Text(subtitle, color = VaultTextMuted, style = MaterialTheme.typography.bodyMedium)
        }
        TextButton(onClick = onDismiss) {
            Text(stringResource(R.string.csv_import_cancel))
        }
    }
}

@Composable
private fun WarningText(message: String) {
    Text(
        message,
        color = VaultWarning,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.padding(vertical = VaultSpace.xs),
    )
}

@Composable
private fun ErrorText(message: String) {
    Text(
        message,
        color = VaultNegative,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.padding(vertical = VaultSpace.xs),
    )
}
