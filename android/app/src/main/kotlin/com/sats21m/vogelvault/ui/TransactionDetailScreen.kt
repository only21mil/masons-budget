package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import com.sats21m.vogelvault.ui.components.LedgerTextField
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalContext
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.DeviceCapabilities
import com.sats21m.vogelvault.data.DeviceCapability
import com.sats21m.vogelvault.domain.FamilyMember
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.TransactionInput
import com.sats21m.vogelvault.data.TransactionKind
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultSpace
import java.math.BigDecimal
import java.time.LocalDate
import java.time.format.DateTimeParseException
import kotlinx.coroutines.launch

data class TransactionDraft(
    val merchant: String,
    val category: String,
    val amount: String,
    val method: String,
    val date: String,
    val note: String,
)

sealed interface TransactionActionResult {
    data object Success : TransactionActionResult

    data class Error(val message: String) : TransactionActionResult
}

internal const val TRANSACTION_REVISION_REQUIRED_MESSAGE =
    "This transaction has no server revision. Refresh and try again."

interface TransactionActions {
    suspend fun save(
        original: Transaction,
        draft: TransactionDraft,
    ): TransactionActionResult

    suspend fun delete(transaction: Transaction): TransactionActionResult
}

internal class ConvexTransactionActions(
    private val client: ConvexDeviceMutationClient,
) : TransactionActions {
    override suspend fun save(
        original: Transaction,
        draft: TransactionDraft,
    ): TransactionActionResult {
        // The detail screen only receives rows from the server-backed ledger.
        // A missing revision here is stale local state, never a new create, so
        // refuse before the write can silently become unfenced.
        val baseUpdatedAtMs = original.updatedAtMs.takeIf { it > 0L }
            ?: return TransactionActionResult.Error(TRANSACTION_REVISION_REQUIRED_MESSAGE)
        val amountCents =
            parseTransactionCents(draft.amount)
                ?: return TransactionActionResult.Error("Enter a valid signed amount with at most two decimals.")
        if (!isIsoDate(draft.date)) {
            return TransactionActionResult.Error("Enter the date as YYYY-MM-DD.")
        }

        val transaction =
            try {
                TransactionInput(
                    id = original.id,
                    date = draft.date.trim(),
                    merchant = draft.merchant.trim(),
                    amountCents = amountCents,
                    category = draft.category.trim(),
                    kind = originalKind(original),
                    card = editedPaymentSourceCard(original.card, draft.method),
                    note = draft.note.trim().ifEmpty { null },
                    amountSats = original.amountSats,
                    bitcoinAccountKey = original.bitcoinAccountKey,
                    owner = original.owner.ledgerOwner,
                )
            } catch (error: IllegalArgumentException) {
                return TransactionActionResult.Error(
                    error.message ?: "The transaction does not satisfy the ledger contract.",
                )
            }

        return client
            .mutate(
                ConvexMutation.UpsertTransactionFromDevice(
                    owner = original.owner,
                    transaction = transaction,
                    sourceFile = original.owner.ledgerOwner.transactionsDataFileName,
                    baseUpdatedAtMs = baseUpdatedAtMs,
                ),
            ).toTransactionActionResult()
    }

    override suspend fun delete(transaction: Transaction): TransactionActionResult {
        // Deletes are fenced by the same revision as edits; an absent fence is
        // especially dangerous because it can remove a newly changed sat row.
        val baseUpdatedAtMs = transaction.updatedAtMs.takeIf { it > 0L }
            ?: return TransactionActionResult.Error(TRANSACTION_REVISION_REQUIRED_MESSAGE)
        return client
            .mutate(
                ConvexMutation.DeleteTransactionFromDevice(
                    entityId = transaction.id,
                    owner = transaction.owner.ledgerOwner,
                    sourceFile = transaction.owner.ledgerOwner.transactionsDataFileName,
                    baseUpdatedAtMs = baseUpdatedAtMs,
                ),
            ).toTransactionActionResult()
    }
}

@Composable
fun TransactionDetailScreen(
    transaction: Transaction,
    actions: TransactionActions,
    onClose: () -> Unit,
    onChanged: () -> Unit,
    viewer: FamilyMember = transaction.owner,
) {
    val application = LocalContext.current.applicationContext as? VaultApplication
    val access = application?.deviceCapabilities ?: DeviceCapabilities()
    val writeReason = access.unavailableReason(viewer, DeviceCapability.TRANSACTIONS)
        ?: if (transaction.amountSats != null || transaction.bitcoinAccountKey != null) {
            access.unavailableReason(viewer, DeviceCapability.BITCOIN)
        } else null
    val unavailableReason = writeReason
        ?: if (transaction.updatedAtMs <= 0L) "Refresh this transaction before editing it." else null
        ?: if (viewer.ledgerOwner != transaction.owner.ledgerOwner) "Switch to this record's profile to make changes." else null
    val canWrite = unavailableReason == null && viewer.ledgerOwner == transaction.owner.ledgerOwner
    val stateKeys = arrayOf(transaction.owner.key, transaction.id)
    var merchant by rememberSaveable(*stateKeys) { mutableStateOf(transaction.merchant) }
    var category by rememberSaveable(*stateKeys) { mutableStateOf(transaction.category) }
    var amount by rememberSaveable(*stateKeys) {
        mutableStateOf(editableTransactionAmount(transaction.amount))
    }
    var method by rememberSaveable(*stateKeys) { mutableStateOf(transaction.card.orEmpty()) }
    var date by rememberSaveable(*stateKeys) { mutableStateOf(transaction.date) }
    var note by rememberSaveable(*stateKeys) { mutableStateOf(transaction.note.orEmpty()) }
    var working by remember(*stateKeys) { mutableStateOf(false) }
    var error by remember(*stateKeys) { mutableStateOf<String?>(null) }
    var confirmDelete by remember(*stateKeys) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun runAction(block: suspend () -> TransactionActionResult) {
        if (working || !canWrite) return
        working = true
        error = null
        scope.launch {
            when (val result = block()) {
                TransactionActionResult.Success -> {
                    working = false
                    onChanged()
                    onClose()
                }

                is TransactionActionResult.Error -> {
                    error = result.message
                    working = false
                }
            }
        }
    }

    Dialog(
        onDismissRequest = { if (!working) onClose() },
        properties =
            DialogProperties(
                dismissOnBackPress = !working,
                dismissOnClickOutside = false,
                usePlatformDefaultWidth = false,
            ),
    ) {
        Surface(Modifier.fillMaxSize()) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(VaultSpace.lg),
                verticalArrangement = Arrangement.spacedBy(VaultSpace.md),
            ) {
                item {
                    unavailableReason?.let { Text(it) }
                    Text(
                        stringResource(R.string.transaction_detail_title),
                        style = MaterialTheme.typography.headlineMedium,
                    )
                }
                item {
                    Text(
                        stringResource(
                            R.string.transaction_detail_owner_source,
                            transaction.owner.displayName,
                            transaction.owner.transactionsDataFileName,
                        ),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                item {
                    LedgerTextField(
                        value = merchant,
                        onValueChange = { merchant = it },
                        label = stringResource(R.string.transaction_merchant),
                        enabled = !working && canWrite,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item {
                    LedgerTextField(
                        value = category,
                        onValueChange = { category = it },
                        label = stringResource(R.string.transaction_category),
                        enabled = !working && canWrite,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item {
                    LedgerTextField(
                        value = amount,
                        onValueChange = { amount = it },
                        label = stringResource(R.string.transaction_amount),
                        supporting = stringResource(R.string.transaction_amount_sign_help),
                        enabled = !working && canWrite,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item {
                    TransactionPaymentSourcePicker(
                        selectedCard = method,
                        allowedRoute = transaction.paymentSourceRouteForEdit(),
                        legacyCard = transaction.card?.takeIf {
                            it.isNotBlank() && PaymentSource.fromWireOrNull(it) == null
                        },
                        onSelect = { method = it },
                        enabled = !working && canWrite,
                    )
                }
                item {
                    LedgerTextField(
                        value = date,
                        onValueChange = { date = it },
                        label = stringResource(R.string.transaction_date),
                        supporting = stringResource(R.string.transaction_date_help),
                        enabled = !working && canWrite,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item {
                    LedgerTextField(
                        value = note,
                        onValueChange = { note = it },
                        label = stringResource(R.string.transaction_note),
                        enabled = !working && canWrite,
                        singleLine = false,
                        minLines = 3,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                error?.let { message ->
                    item {
                        Text(
                            message,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm),
                    ) {
                        OutlinedButton(
                            onClick = onClose,
                            enabled = !working,
                            modifier = Modifier.weight(1f),
                        ) {
                            Text(stringResource(R.string.transaction_cancel))
                        }
                        VaultButton(
                            label = stringResource(
                                if (working) R.string.add_transaction_saving else R.string.transaction_save,
                            ),
                            onClick = {
                                val draft =
                                    TransactionDraft(
                                        merchant = merchant,
                                        category = category,
                                        amount = amount,
                                        method = method,
                                        date = date,
                                        note = note,
                                    )
                                runAction { actions.save(transaction, draft) }
                            },
                            enabled = !working && canWrite,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                item {
                    TextButton(
                        onClick = { confirmDelete = true },
                        enabled = !working && canWrite,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            stringResource(R.string.transaction_delete),
                            color = LocalLedgerTheme.current.colors.loss,
                        )
                    }
                }
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(stringResource(R.string.transaction_delete_confirm_title)) },
            text = { Text(stringResource(R.string.transaction_delete_confirm_detail)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDelete = false
                        runAction { actions.delete(transaction) }
                    },
                ) {
                    Text(
                        stringResource(R.string.transaction_delete_confirm_action),
                        color = LocalLedgerTheme.current.colors.loss,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) {
                    Text(stringResource(R.string.transaction_cancel))
                }
            },
        )
    }
}

@Composable
private fun TransactionPaymentSourcePicker(
    selectedCard: String,
    allowedRoute: PaymentSourceRoute,
    legacyCard: String?,
    onSelect: (String) -> Unit,
    enabled: Boolean,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Text(
            stringResource(R.string.transaction_method),
            style = MaterialTheme.typography.labelSmall,
        )
        OutlinedButton(
            onClick = { expanded = true },
            enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                paymentSourceDisplay(selectedCard.ifEmpty { null }, missingLabel = "On-chain"),
            )
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            if (legacyCard != null) {
                DropdownMenuItem(
                    text = { Text(legacyCard) },
                    onClick = {
                        expanded = false
                        onSelect(legacyCard)
                    },
                )
            }
            PaymentSource.entries.filter { it.route == allowedRoute }.forEach { source ->
                DropdownMenuItem(
                    text = { Text(source.label) },
                    onClick = {
                        expanded = false
                        onSelect(source.wire)
                    },
                )
            }
        }
    }
}

private fun Transaction.paymentSourceRouteForEdit(): PaymentSourceRoute {
    val source = PaymentSource.fromWireOrNull(card)
    return if (
        source?.route == PaymentSourceRoute.BITCOIN_TRANSACTION ||
        PaymentSource.isRetiredTransactionWire(card) ||
        amountSats != null ||
        bitcoinAccountKey != null
    ) {
        PaymentSourceRoute.BITCOIN_TRANSACTION
    } else {
        PaymentSourceRoute.CARD_TRANSACTION
    }
}

internal fun parseTransactionCents(value: String): Long? =
    runCatching {
        value
            .trim()
            .removePrefix("$")
            .toBigDecimal()
            .movePointRight(2)
            .longValueExact()
    }.getOrNull()

internal fun editableTransactionAmount(cents: Long): String =
    BigDecimal.valueOf(cents, 2).toPlainString()

private fun editedPaymentSourceCard(
    originalCard: String?,
    editedCard: String,
): String? =
    if (PaymentSource.fromWireOrNull(originalCard) == null && editedCard == originalCard) {
        originalCard
    } else {
        editedCard.trim().ifEmpty { null }
    }

private fun originalKind(transaction: Transaction): TransactionKind =
    if (transaction.category == "Income" || transaction.amount < 0L) {
        TransactionKind.CREDIT
    } else {
        TransactionKind.SPEND
    }

private fun isIsoDate(value: String): Boolean =
    try {
        LocalDate.parse(value.trim())
        true
    } catch (error: DateTimeParseException) {
        false
    }

private fun ConvexResult<*>.toTransactionActionResult(): TransactionActionResult =
    when (this) {
        is ConvexResult.Ok -> TransactionActionResult.Success
        ConvexResult.Disabled -> TransactionActionResult.Error("Transaction writes are disabled.")
        ConvexResult.NotConfigured ->
            TransactionActionResult.Error("The secure Convex write path is not configured.")
        ConvexResult.Unauthorized ->
            TransactionActionResult.Error("The secure Convex write credential was not accepted.")
        ConvexResult.Missing -> TransactionActionResult.Error("Convex returned no mutation result.")
        is ConvexResult.Failed ->
            TransactionActionResult.Error("Convex refused the change (${this.reason}).")
    }
