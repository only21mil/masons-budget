package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexMutationClient
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.TransactionInput
import com.sats21m.vogelvault.data.TransactionKind
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.ui.theme.VaultNegative
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

interface TransactionActions {
    suspend fun save(
        original: Transaction,
        draft: TransactionDraft,
    ): TransactionActionResult

    suspend fun delete(transaction: Transaction): TransactionActionResult
}

internal class ConvexTransactionActions(
    private val client: ConvexMutationClient,
) : TransactionActions {
    override suspend fun save(
        original: Transaction,
        draft: TransactionDraft,
    ): TransactionActionResult {
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
                    card = draft.method.trim().ifEmpty { null },
                    note = draft.note.trim().ifEmpty { null },
                    owner = original.owner.ledgerOwner,
                )
            } catch (error: IllegalArgumentException) {
                return TransactionActionResult.Error(
                    error.message ?: "The transaction does not satisfy the ledger contract.",
                )
            }

        return client
            .mutate(
                ConvexMutation.UpsertTransaction(
                    transaction = transaction,
                    sourceFile = original.owner.ledgerOwner.transactionsDataFileName,
                ),
            ).toTransactionActionResult()
    }

    override suspend fun delete(transaction: Transaction): TransactionActionResult =
        client
            .mutate(
                ConvexMutation.DeleteTransaction(
                    txId = transaction.id,
                    owner = transaction.owner.ledgerOwner,
                    sourceFile = transaction.owner.ledgerOwner.transactionsDataFileName,
                ),
            ).toTransactionActionResult()
}

@Composable
fun TransactionDetailScreen(
    transaction: Transaction,
    actions: TransactionActions,
    onClose: () -> Unit,
    onChanged: () -> Unit,
) {
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
        if (working) return
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
                    OutlinedTextField(
                        value = merchant,
                        onValueChange = { merchant = it },
                        label = { Text(stringResource(R.string.transaction_merchant)) },
                        enabled = !working,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item {
                    OutlinedTextField(
                        value = category,
                        onValueChange = { category = it },
                        label = { Text(stringResource(R.string.transaction_category)) },
                        enabled = !working,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item {
                    OutlinedTextField(
                        value = amount,
                        onValueChange = { amount = it },
                        label = { Text(stringResource(R.string.transaction_amount)) },
                        supportingText = {
                            Text(stringResource(R.string.transaction_amount_sign_help))
                        },
                        enabled = !working,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item {
                    OutlinedTextField(
                        value = method,
                        onValueChange = { method = it },
                        label = { Text(stringResource(R.string.transaction_method)) },
                        enabled = !working,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item {
                    OutlinedTextField(
                        value = date,
                        onValueChange = { date = it },
                        label = { Text(stringResource(R.string.transaction_date)) },
                        supportingText = { Text(stringResource(R.string.transaction_date_help)) },
                        enabled = !working,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item {
                    OutlinedTextField(
                        value = note,
                        onValueChange = { note = it },
                        label = { Text(stringResource(R.string.transaction_note)) },
                        enabled = !working,
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
                        Button(
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
                            enabled = !working,
                            modifier = Modifier.weight(1f),
                        ) {
                            if (working) {
                                CircularProgressIndicator()
                            } else {
                                Text(stringResource(R.string.transaction_save))
                            }
                        }
                    }
                }
                item {
                    TextButton(
                        onClick = { confirmDelete = true },
                        enabled = !working,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            stringResource(R.string.transaction_delete),
                            color = VaultNegative,
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
                        color = VaultNegative,
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
