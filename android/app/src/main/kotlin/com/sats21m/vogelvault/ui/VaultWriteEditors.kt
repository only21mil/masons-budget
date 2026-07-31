package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.explicitBtcBuyOwner
import com.sats21m.vogelvault.data.BtcBuyInput
import com.sats21m.vogelvault.data.BudgetCategoryInput
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.domain.CategorySpend
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.ui.components.LedgerRow
import com.sats21m.vogelvault.ui.theme.VaultCream
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultSpace
import java.math.BigDecimal
import java.time.LocalDate
import java.time.format.DateTimeParseException
import java.util.UUID
import kotlinx.coroutines.launch

data class BudgetCategoryEditorSeed(
    val viewer: FamilyMember,
    val displayedMonth: String,
    val budgetDocumentMonth: String,
    val category: CategorySpend,
)

data class BudgetCategoryWriteRequest(
    val viewer: FamilyMember,
    val month: String,
    val categoryName: String,
    val budgetCents: Long,
    val icon: String?,
) {
    init {
        require(month.matches(Regex("""\d{4}-(0[1-9]|1[0-2])""")))
        require(categoryName.isNotBlank())
        require(budgetCents >= 0L)
    }
}

data class BtcBuyWriteRequest(
    val id: String,
    val owner: FamilyMember,
    val date: String,
    val source: String,
    val sats: Long,
    val priceUsdCents: Long,
    val usdCents: Long,
) {
    init {
        require(id.isNotBlank())
        require(runCatching { LocalDate.parse(date) }.isSuccess)
        require(source.isNotBlank())
        require(sats > 0L)
        require(priceUsdCents > 0L)
        require(usdCents > 0L)
    }
}

internal sealed interface WriteDraftResult<out T> {
    data class Valid<T>(val request: T) : WriteDraftResult<T>
    data class Invalid(val reason: String) : WriteDraftResult<Nothing>
}

internal fun budgetCategoryWriteRequest(
    seed: BudgetCategoryEditorSeed,
    dollars: String,
): WriteDraftResult<BudgetCategoryWriteRequest> {
    if (seed.displayedMonth != seed.budgetDocumentMonth) {
        return WriteDraftResult.Invalid("Only the current budget document month can be edited.")
    }
    val cents = exactPositiveMinorUnits(dollars, 2, allowZero = true)
        ?: return WriteDraftResult.Invalid("Enter a non-negative amount with at most two decimal places.")
    return WriteDraftResult.Valid(
        BudgetCategoryWriteRequest(
            viewer = seed.viewer,
            month = seed.budgetDocumentMonth,
            categoryName = seed.category.name,
            budgetCents = cents,
            icon = seed.category.icon,
        ),
    )
}

internal fun btcBuyWriteRequest(
    owner: FamilyMember,
    id: String,
    date: String,
    source: String,
    sats: String,
    priceUsd: String,
    purchaseUsd: String,
): WriteDraftResult<BtcBuyWriteRequest> {
    val normalizedDate =
        try {
            LocalDate.parse(date.trim()).toString()
        } catch (_: DateTimeParseException) {
            return WriteDraftResult.Invalid("Enter a date as yyyy-MM-dd.")
        }
    val normalizedSource = source.trim()
    if (normalizedSource.isEmpty()) return WriteDraftResult.Invalid("Enter a purchase source.")
    val exactSats = sats.trim().toLongOrNull()?.takeIf { it > 0L }
        ?: return WriteDraftResult.Invalid("Sats must be a positive whole number.")
    val priceCents = exactPositiveMinorUnits(priceUsd, 2, allowZero = false)
        ?: return WriteDraftResult.Invalid("Price must be positive with at most two decimal places.")
    val purchaseCents = exactPositiveMinorUnits(purchaseUsd, 2, allowZero = false)
        ?: return WriteDraftResult.Invalid("Purchase amount must be positive with at most two decimal places.")
    return WriteDraftResult.Valid(
        BtcBuyWriteRequest(
            id = id,
            owner = owner,
            date = normalizedDate,
            source = normalizedSource,
            sats = exactSats,
            priceUsdCents = priceCents,
            usdCents = purchaseCents,
        ),
    )
}

private fun exactPositiveMinorUnits(
    raw: String,
    scale: Int,
    allowZero: Boolean,
): Long? =
    runCatching {
        val normalized = raw.trim().removePrefix("$").replace(",", "")
        val value = BigDecimal(normalized)
        if (value.scale().coerceAtLeast(0) > scale) return null
        val minorUnits = value.movePointRight(scale).longValueExact()
        minorUnits.takeIf { if (allowZero) it >= 0L else it > 0L }
    }.getOrNull()

@Composable
internal fun EditableBudgetCategoryRow(
    category: CategorySpend,
    canEdit: Boolean,
    onOpenTransactions: () -> Unit,
    onEdit: () -> Unit,
) {
    Column {
        LedgerRow(
            primary = category.name,
            secondary = "planned ${Money.formatUsd(category.budgetCents)}",
            figure = Money.formatUsd(category.spentCents),
            figureColor = if (category.isOverBudget) VaultNegative else VaultCream,
            badge = if (category.isOverBudget) "over" else null,
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm)) {
            TextButton(onClick = onOpenTransactions) {
                Text(stringResource(R.string.budget_category_transactions_action))
            }
            if (canEdit) {
                TextButton(onClick = onEdit, modifier = Modifier.padding(horizontal = VaultSpace.sm)) {
                    Text(stringResource(R.string.budget_category_edit_action))
                }
            }
        }
    }
}

@Composable
internal fun BtcBuyEntryAction(onClick: () -> Unit) {
    Button(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.btc_buy_add_action))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BudgetCategoryEditorSheet(
    seed: BudgetCategoryEditorSeed,
    onDismiss: () -> Unit,
    onWriteSucceeded: () -> Unit,
) {
    val application = LocalContext.current.applicationContext as? VaultApplication
    val mutationClient = remember(application) { application?.convexMutationClient }
    var dollars by remember(seed) {
        mutableStateOf(Money.formatMinorUnits(seed.category.budgetCents, 2))
    }
    var message by remember(seed) { mutableStateOf<String?>(null) }
    var submitting by remember(seed) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(VaultSpace.md),
            verticalArrangement = Arrangement.spacedBy(VaultSpace.md),
        ) {
            Text(stringResource(R.string.budget_category_editor_title, seed.category.name))
            Text(stringResource(R.string.budget_category_editor_month, seed.budgetDocumentMonth))
            OutlinedTextField(
                value = dollars,
                onValueChange = { dollars = it },
                label = { Text(stringResource(R.string.budget_category_amount_label)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            message?.let { Text(it) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss, enabled = !submitting) {
                    Text(stringResource(R.string.write_cancel))
                }
                Button(
                    enabled = !submitting,
                    onClick = {
                        when (val draft = budgetCategoryWriteRequest(seed, dollars)) {
                            is WriteDraftResult.Invalid -> message = draft.reason
                            is WriteDraftResult.Valid -> {
                                val client = mutationClient
                                if (client == null) {
                                    message = "Budget not saved: the app write client is unavailable."
                                    return@Button
                                }
                                submitting = true
                                scope.launch {
                                    val request = draft.request
                                    val result =
                                        client.mutate(
                                            ConvexMutation.UpsertBudgetCategory(
                                                viewer = request.viewer,
                                                month = request.month,
                                                category =
                                                    BudgetCategoryInput(
                                                        name = request.categoryName,
                                                        budgetCents = request.budgetCents,
                                                        icon = request.icon,
                                                    ),
                                            ),
                                        )
                                    submitting = false
                                    when (result) {
                                        is ConvexResult.Ok -> {
                                            onWriteSucceeded()
                                            onDismiss()
                                        }
                                        ConvexResult.Unauthorized ->
                                            message =
                                                "Budget not saved: Convex rejected the sync token."
                                        ConvexResult.NotConfigured ->
                                            message =
                                                "Budget not saved: Convex is not configured on this device."
                                        ConvexResult.Disabled ->
                                            message =
                                                "Budget not saved: authenticated writes are disabled."
                                        ConvexResult.Missing ->
                                            message =
                                                "Budget not saved: Convex returned no write result."
                                        is ConvexResult.Failed ->
                                            message =
                                                "Budget not saved: the write failed (${result.reason})."
                                    }
                                }
                            }
                        }
                    },
                ) {
                    Text(stringResource(R.string.write_save))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BtcBuyEntrySheet(
    owner: FamilyMember,
    onDismiss: () -> Unit,
    onWriteSucceeded: () -> Unit,
) {
    val application = LocalContext.current.applicationContext as? VaultApplication
    val mutationClient = remember(application) { application?.convexMutationClient }
    val buyId = remember { "android-${UUID.randomUUID()}" }
    var date by remember { mutableStateOf(LocalDate.now().toString()) }
    var source by remember { mutableStateOf("") }
    var sats by remember { mutableStateOf("") }
    var priceUsd by remember { mutableStateOf("") }
    var purchaseUsd by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var submitting by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(VaultSpace.md),
            verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
        ) {
            Text(stringResource(R.string.btc_buy_editor_title))
            EditorField(date, { date = it }, R.string.btc_buy_date_label)
            EditorField(source, { source = it }, R.string.btc_buy_source_label)
            EditorField(sats, { sats = it }, R.string.btc_buy_sats_label, KeyboardType.Number)
            EditorField(priceUsd, { priceUsd = it }, R.string.btc_buy_price_label, KeyboardType.Decimal)
            EditorField(
                purchaseUsd,
                { purchaseUsd = it },
                R.string.btc_buy_purchase_amount_label,
                KeyboardType.Decimal,
            )
            Text(stringResource(R.string.btc_buy_independent_amounts_detail))
            message?.let { Text(it) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss, enabled = !submitting) {
                    Text(stringResource(R.string.write_cancel))
                }
                Button(
                    enabled = !submitting,
                    onClick = {
                        when (
                            val draft =
                                btcBuyWriteRequest(
                                    owner,
                                    buyId,
                                    date,
                                    source,
                                    sats,
                                    priceUsd,
                                    purchaseUsd,
                                )
                        ) {
                            is WriteDraftResult.Invalid -> message = draft.reason
                            is WriteDraftResult.Valid -> {
                                val client = mutationClient
                                if (client == null) {
                                    message = "Bitcoin buy not saved: the app write client is unavailable."
                                    return@Button
                                }
                                submitting = true
                                scope.launch {
                                    val request = draft.request
                                    val result =
                                        client.mutate(
                                            ConvexMutation.UpsertBtcBuy(
                                                buy =
                                                    BtcBuyInput(
                                                        id = request.id,
                                                        date = request.date,
                                                        source = request.source,
                                                        sats = request.sats,
                                                        priceUsdCents = request.priceUsdCents,
                                                        usdCents = request.usdCents,
                                                        owner = explicitBtcBuyOwner(request.owner),
                                                    ),
                                                sourceFile = request.owner.btcBuysDataFileName,
                                            ),
                                        )
                                    submitting = false
                                    when (result) {
                                        is ConvexResult.Ok -> {
                                            onWriteSucceeded()
                                            onDismiss()
                                        }
                                        ConvexResult.Unauthorized ->
                                            message =
                                                "Bitcoin buy not saved: Convex rejected the sync token."
                                        ConvexResult.NotConfigured ->
                                            message =
                                                "Bitcoin buy not saved: Convex is not configured on this device."
                                        ConvexResult.Disabled ->
                                            message =
                                                "Bitcoin buy not saved: authenticated writes are disabled."
                                        ConvexResult.Missing ->
                                            message =
                                                "Bitcoin buy not saved: Convex returned no write result."
                                        is ConvexResult.Failed ->
                                            message =
                                                "Bitcoin buy not saved: the write failed (${result.reason})."
                                    }
                                }
                            }
                        }
                    },
                ) {
                    Text(stringResource(R.string.write_save))
                }
            }
        }
    }
}

@Composable
private fun EditorField(
    value: String,
    onValueChange: (String) -> Unit,
    labelRes: Int,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(stringResource(labelRes)) },
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}
