package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.TransactionInput
import com.sats21m.vogelvault.data.TransactionKind
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultSpace
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.UUID
import kotlinx.coroutines.launch

internal enum class AddTransactionType(val label: String) {
    SPEND("Spend"),
    INCOME("Income"),
    TRANSFER("Transfer"),
}

internal data class AddTransactionDraft(
    val type: AddTransactionType,
    val merchant: String,
    val category: String,
    val amount: String,
    val inputUnit: DisplayUnit,
    val card: String,
    val date: LocalDate,
    val note: String,
    val owner: FamilyMember,
)

internal data class PreparedTransaction(
    val input: TransactionInput,
    val sourceFile: String,
    val sats: Long?,
)

/**
 * Turns user input into the exact row mutation payload.
 *
 * No binary floating point enters this path. USD allows at most two decimal
 * places, BTC at most eight, and sats must be whole. Spend, income, and transfer
 * are all positive on the wire; only a separate refund/credit flow may be
 * negative under the server's requireSignAgrees contract.
 */
internal fun prepareTransaction(
    draft: AddTransactionDraft,
    btcPriceCents: Long,
    id: String = "android-${UUID.randomUUID()}",
): Result<PreparedTransaction> = runCatching {
    val merchant = draft.merchant.trim()
    require(merchant.isNotEmpty()) { "Enter a merchant or transfer destination" }
    require(draft.card.isNotBlank()) { "Select a card or payment method" }

    val parsed = parsePositiveDecimal(draft.amount)
    val (amountCents, sats) = when (draft.inputUnit) {
        DisplayUnit.USD -> {
            val cents = parsed.toMinorUnitsExact(scale = 2, unitName = "USD")
            cents to btcPriceCents.takeIf { it > 0L }?.let { price ->
                BigDecimal(cents)
                    .multiply(BigDecimal(Money.SATS_PER_BTC))
                    .divide(BigDecimal(price), 0, RoundingMode.HALF_UP)
                    .longValueExact()
            }
        }

        DisplayUnit.BTC -> {
            val exactSats = parsed.toMinorUnitsExact(scale = 8, unitName = "BTC")
            require(btcPriceCents > 0L) {
                "A recorded Bitcoin price is required to save BTC input as USD cents"
            }
            satsToCentsExact(exactSats, btcPriceCents) to exactSats
        }

        DisplayUnit.SATS -> {
            val exactSats = parsed.toMinorUnitsExact(scale = 0, unitName = "sats")
            require(btcPriceCents > 0L) {
                "A recorded Bitcoin price is required to save sats input as USD cents"
            }
            satsToCentsExact(exactSats, btcPriceCents) to exactSats
        }
    }
    require(amountCents > 0L) { "Amount must resolve to at least one cent" }

    val kind = if (draft.type == AddTransactionType.INCOME) {
        TransactionKind.CREDIT
    } else {
        TransactionKind.SPEND
    }
    val category = when (draft.type) {
        AddTransactionType.INCOME -> "Income"
        AddTransactionType.TRANSFER -> draft.category.trim().ifEmpty { "Transfer" }
        AddTransactionType.SPEND -> draft.category.trim().ifEmpty { "Other" }
    }

    PreparedTransaction(
        input = TransactionInput(
            id = id,
            date = draft.date.toString(),
            merchant = merchant,
            amountCents = amountCents,
            category = category,
            kind = kind,
            card = draft.card.trim(),
            note = draft.note.trim().takeIf(String::isNotEmpty),
            owner = draft.owner,
        ),
        sourceFile = draft.owner.transactionsDataFileName,
        sats = sats,
    )
}

internal fun conversionPreview(
    amount: String,
    inputUnit: DisplayUnit,
    btcPriceCents: Long,
): String? = runCatching {
    val parsed = parsePositiveDecimal(amount)
    when (inputUnit) {
        DisplayUnit.USD -> {
            val cents = parsed.toMinorUnitsExact(2, "USD")
            if (btcPriceCents <= 0L) {
                Money.PRICE_UNAVAILABLE
            } else {
                val sats = BigDecimal(cents)
                    .multiply(BigDecimal(Money.SATS_PER_BTC))
                    .divide(BigDecimal(btcPriceCents), 0, RoundingMode.HALF_UP)
                    .longValueExact()
                "${Money.formatSats(sats)} / ${Money.formatBtc(sats)}"
            }
        }

        DisplayUnit.BTC -> {
            val sats = parsed.toMinorUnitsExact(8, "BTC")
            if (btcPriceCents <= 0L) {
                "${Money.formatSats(sats)} / ${Money.PRICE_UNAVAILABLE}"
            } else {
                "${Money.formatSats(sats)} / ${Money.formatUsd(satsToCentsExact(sats, btcPriceCents))}"
            }
        }

        DisplayUnit.SATS -> {
            val sats = parsed.toMinorUnitsExact(0, "sats")
            if (btcPriceCents <= 0L) {
                "${Money.formatBtc(sats)} / ${Money.PRICE_UNAVAILABLE}"
            } else {
                "${Money.formatBtc(sats)} / ${Money.formatUsd(satsToCentsExact(sats, btcPriceCents))}"
            }
        }
    }
}.getOrNull()

internal fun convertAmountForUnit(
    amount: String,
    from: DisplayUnit,
    to: DisplayUnit,
    btcPriceCents: Long,
): String? = runCatching {
    if (from == to) return@runCatching amount
    val parsed = parsePositiveDecimal(amount)
    val sats = when (from) {
        DisplayUnit.USD -> {
            require(btcPriceCents > 0L) { "Bitcoin price unavailable" }
            val cents = parsed.toMinorUnitsExact(2, "USD")
            BigDecimal(cents)
                .multiply(BigDecimal(Money.SATS_PER_BTC))
                .divide(BigDecimal(btcPriceCents), 0, RoundingMode.HALF_UP)
                .longValueExact()
        }
        DisplayUnit.BTC -> parsed.toMinorUnitsExact(8, "BTC")
        DisplayUnit.SATS -> parsed.toMinorUnitsExact(0, "sats")
    }
    when (to) {
        DisplayUnit.SATS -> sats.toString()
        DisplayUnit.BTC -> BigDecimal(sats)
            .movePointLeft(8)
            .stripTrailingZeros()
            .toPlainString()
        DisplayUnit.USD -> {
            require(btcPriceCents > 0L) { "Bitcoin price unavailable" }
            BigDecimal(satsToCentsExact(sats, btcPriceCents))
                .movePointLeft(2)
                .setScale(2)
                .toPlainString()
        }
    }
}.getOrNull()

private fun parsePositiveDecimal(raw: String): BigDecimal {
    val cleaned = raw.trim()
        .replace(",", "")
        .removePrefix("$")
        .removePrefix("₿")
        .trim()
    require(cleaned.isNotEmpty()) { "Enter an amount" }
    val value = cleaned.toBigDecimalOrNull() ?: throw IllegalArgumentException("Enter a valid amount")
    require(value > BigDecimal.ZERO) { "Amount must be positive" }
    return value
}

private fun BigDecimal.toMinorUnitsExact(
    scale: Int,
    unitName: String,
): Long = try {
    setScale(scale, RoundingMode.UNNECESSARY)
        .movePointRight(scale)
        .longValueExact()
} catch (error: ArithmeticException) {
    throw IllegalArgumentException(
        when (scale) {
            0 -> "$unitName must be a whole number"
            else -> "$unitName supports at most $scale decimal places"
        },
        error,
    )
}

private fun satsToCentsExact(
    sats: Long,
    btcPriceCents: Long,
): Long = try {
    BigDecimal(sats)
        .multiply(BigDecimal(btcPriceCents))
        .divide(BigDecimal(Money.SATS_PER_BTC), 0, RoundingMode.HALF_UP)
        .longValueExact()
} catch (error: ArithmeticException) {
    throw IllegalArgumentException("Amount is outside the supported range", error)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AddTransactionSheet(
    state: VaultUiState,
    onDismiss: () -> Unit,
) {
    val applicationContext = LocalContext.current.applicationContext
    val application = applicationContext as? VaultApplication
    // WA1 owns encrypted sync-token storage and exposes one process-scoped
    // client. The sheet sees the transport, never the credential or its store.
    val mutationClient = remember(application) { application?.convexMutationClient }

    var typeName by rememberSaveable { mutableStateOf(AddTransactionType.SPEND.name) }
    var inputUnitName by rememberSaveable { mutableStateOf(DisplayUnit.USD.name) }
    var merchant by rememberSaveable { mutableStateOf("") }
    var category by rememberSaveable { mutableStateOf("") }
    var amount by rememberSaveable { mutableStateOf("") }
    var card by rememberSaveable { mutableStateOf(CARD_OPTIONS.first()) }
    var dateIso by rememberSaveable { mutableStateOf(LocalDate.now(ZoneOffset.UTC).toString()) }
    var note by rememberSaveable { mutableStateOf("") }
    var errorMessage by rememberSaveable { mutableStateOf<String?>(null) }
    var saving by rememberSaveable { mutableStateOf(false) }
    var showDatePicker by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val type = AddTransactionType.valueOf(typeName)
    val inputUnit = DisplayUnit.valueOf(inputUnitName)
    val categories = remember(state.data.budget.value, type) {
        when (type) {
            AddTransactionType.INCOME -> listOf("Income")
            AddTransactionType.TRANSFER -> listOf("Transfer")
            AddTransactionType.SPEND ->
                state.data.budget.value?.categories
                    ?.map { it.name }
                    ?.distinct()
                    .orEmpty()
                    .ifEmpty { listOf("Other") }
        }
    }
    val selectedCategory = category.takeIf { it in categories } ?: categories.first()

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = VaultSpace.lg, vertical = VaultSpace.sm),
            verticalArrangement = Arrangement.spacedBy(VaultSpace.md),
        ) {
            Text(
                stringResource(R.string.add_transaction_title),
                style = MaterialTheme.typography.headlineMedium,
            )

            OptionRow(
                options = AddTransactionType.entries,
                selected = type,
                label = AddTransactionType::label,
                onSelect = {
                    typeName = it.name
                    category = ""
                    errorMessage = null
                },
            )

            OutlinedTextField(
                value = merchant,
                onValueChange = {
                    merchant = it
                    errorMessage = null
                },
                label = { Text(stringResource(R.string.add_transaction_merchant)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            DropdownField(
                label = stringResource(R.string.add_transaction_category),
                selected = selectedCategory,
                options = categories,
                onSelect = {
                    category = it
                    errorMessage = null
                },
            )

            OptionRow(
                options = DisplayUnit.entries,
                selected = inputUnit,
                label = DisplayUnit::label,
                onSelect = {
                    convertAmountForUnit(
                        amount = amount,
                        from = inputUnit,
                        to = it,
                        btcPriceCents = state.data.btcPriceCents,
                    )?.let { converted -> amount = converted }
                    inputUnitName = it.name
                    errorMessage = null
                },
            )

            OutlinedTextField(
                value = amount,
                onValueChange = {
                    amount = it
                    errorMessage = null
                },
                label = { Text(stringResource(R.string.add_transaction_amount)) },
                supportingText = {
                    conversionPreview(amount, inputUnit, state.data.btcPriceCents)?.let { Text(it) }
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            DropdownField(
                label = stringResource(R.string.add_transaction_card),
                selected = card,
                options = CARD_OPTIONS,
                onSelect = {
                    card = it
                    errorMessage = null
                },
            )

            OutlinedButton(
                onClick = { showDatePicker = true },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("${stringResource(R.string.add_transaction_date)}: $dateIso")
            }

            OutlinedTextField(
                value = note,
                onValueChange = { note = it },
                label = { Text(stringResource(R.string.add_transaction_note)) },
                modifier = Modifier.fillMaxWidth(),
                minLines = 2,
                maxLines = 4,
            )

            errorMessage?.let {
                Text(it, color = VaultNegative, style = MaterialTheme.typography.bodySmall)
            }

            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm),
            ) {
                OutlinedButton(
                    onClick = onDismiss,
                    enabled = !saving,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(stringResource(R.string.add_transaction_cancel))
                }
                Button(
                    onClick = {
                        val draft = AddTransactionDraft(
                            type = type,
                            merchant = merchant,
                            category = selectedCategory,
                            amount = amount,
                            inputUnit = inputUnit,
                            card = card,
                            date = LocalDate.parse(dateIso),
                            note = note,
                            owner = state.activeProfile,
                        )
                        val prepared = prepareTransaction(draft, state.data.btcPriceCents)
                        val row = prepared.getOrElse {
                            errorMessage = it.message ?: "Transaction is invalid"
                            return@Button
                        }
                        val client = mutationClient
                        if (client == null) {
                            errorMessage = "Transaction writing is not configured"
                            return@Button
                        }
                        saving = true
                        scope.launch {
                            val result = client.mutate(
                                ConvexMutation.UpsertTransaction(
                                    transaction = row.input,
                                    sourceFile = row.sourceFile,
                                ),
                            )
                            saving = false
                            when (result) {
                                is ConvexResult.Ok -> onDismiss()
                                ConvexResult.Unauthorized ->
                                    errorMessage = "The sync credential is missing or was rejected"
                                ConvexResult.NotConfigured,
                                ConvexResult.Disabled,
                                -> errorMessage = "Transaction writing is not configured"
                                ConvexResult.Missing ->
                                    errorMessage = "Convex returned no write result"
                                is ConvexResult.Failed ->
                                    errorMessage = "Transaction was not saved (${result.reason})"
                            }
                        }
                    },
                    enabled = !saving,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(
                        stringResource(
                            if (saving) {
                                R.string.add_transaction_saving
                            } else {
                                R.string.add_transaction_save
                            },
                        ),
                    )
                }
            }
            Spacer(Modifier.height(VaultSpace.lg))
        }
    }

    if (showDatePicker) {
        val initialMillis = LocalDate.parse(dateIso)
            .atStartOfDay(ZoneOffset.UTC)
            .toInstant()
            .toEpochMilli()
        val pickerState = rememberDatePickerState(initialSelectedDateMillis = initialMillis)
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(
                    onClick = {
                        pickerState.selectedDateMillis?.let {
                            dateIso = Instant.ofEpochMilli(it)
                                .atZone(ZoneOffset.UTC)
                                .toLocalDate()
                                .toString()
                        }
                        showDatePicker = false
                    },
                ) {
                    Text(stringResource(R.string.add_transaction_date_confirm))
                }
            },
            dismissButton = {
                TextButton(onClick = { showDatePicker = false }) {
                    Text(stringResource(R.string.add_transaction_cancel))
                }
            },
        ) {
            DatePicker(state = pickerState)
        }
    }
}

@Composable
private fun <T> OptionRow(
    options: List<T>,
    selected: T,
    label: (T) -> String,
    onSelect: (T) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm),
    ) {
        options.forEach { option ->
            if (option == selected) {
                Button(
                    onClick = { onSelect(option) },
                    modifier = Modifier.weight(1f),
                ) {
                    Text(label(option))
                }
            } else {
                OutlinedButton(
                    onClick = { onSelect(option) },
                    modifier = Modifier.weight(1f),
                ) {
                    Text(label(option))
                }
            }
        }
    }
}

@Composable
private fun DropdownField(
    label: String,
    selected: String,
    options: List<String>,
    onSelect: (String) -> Unit,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelSmall)
        OutlinedButton(
            onClick = { expanded = true },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(selected)
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            options.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option) },
                    onClick = {
                        expanded = false
                        onSelect(option)
                    },
                )
            }
        }
    }
}

private val CARD_OPTIONS = listOf("Debit", "Credit", "Lightning", "On-chain", "Bank")
