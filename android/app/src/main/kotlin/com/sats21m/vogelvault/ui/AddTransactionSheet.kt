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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.DraftIdWriteOutcome
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.TransactionDraftIdStore
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.draftIdWriteOutcome
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexMutationClient
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.TransactionInput
import com.sats21m.vogelvault.data.TransactionKind
import com.sats21m.vogelvault.data.TransactionWriteReceipt
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.IncomeEntry
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultTextMuted
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
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
    // `card` remains as a source-compatible bridge for the older add surface.
    // New callers must use paymentSource; new drafts carry the canonical persisted
    // card vocabulary rather than the selector routing wire.
    val card: String = PaymentSource.DEFAULT.persistedCard,
    val date: LocalDate = LocalDate.now(ZoneOffset.UTC),
    val note: String = "",
    val owner: FamilyMember = FamilyMember.VICTOR,
    val paymentSource: PaymentSource = PaymentSource.DEFAULT,
    val bitcoinAccountKey: String? = null,
)

internal data class PreparedTransaction(
    val input: TransactionInput,
    val sourceFile: String,
    val sats: Long?,
)

/** Values needed by the separate River bill-pay editor. */
data class BillPayPrefill(
    val merchant: String,
    val date: LocalDate,
    val amountUsd: String,
    val owner: FamilyMember,
) {
    /** Stable source identity for the receiving bill-pay form. */
    val sourceWire: String get() = PaymentSource.RIVER_BITCOIN_BILL_PAY.wire
    val amount: String get() = amountUsd
    val usdAmount: String get() = amountUsd
    val dateIso: String get() = date.toString()
}

internal typealias BillPayHandoff = BillPayPrefill

internal const val PAYMENT_SOURCE_SELECTOR_TEST_TAG = "payment-source-selector"
internal const val BITCOIN_ACCOUNT_SELECTOR_TEST_TAG = "bitcoin-account-selector"

private fun AddTransactionDraft.selectedPaymentSource(): PaymentSource {
    // Older callers supplied values such as "Debit" through `card`. Recognise a
    // valid wire from that bridge, while making the new enum selection primary.
    val legacy = PaymentSource.fromWire(card)
    return if (paymentSource == PaymentSource.DEFAULT && legacy != PaymentSource.DEFAULT) {
        legacy
    } else {
        paymentSource
    }
}

/** Accounts usable by a write for the active viewer's canonical ledger owner. */
internal fun bitcoinAccountsForEffectiveLedgerOwner(
    accounts: List<BtcAccount>,
    viewer: FamilyMember,
): List<BtcAccount> = accounts.filter { it.owner == viewer.ledgerOwner }

internal fun selectedBitcoinAccountKeyAfterSourceChange(
    source: PaymentSource,
    currentKey: String?,
    accounts: List<BtcAccount>,
    viewer: FamilyMember,
): String? {
    if (!source.isBitcoinTransaction) return null
    val owned = bitcoinAccountsForEffectiveLedgerOwner(accounts, viewer)
    return currentKey?.takeIf { key -> owned.any { it.key == key } }
        ?: owned.firstOrNull()?.key
}

internal fun prepareBillPayHandoff(
    draft: AddTransactionDraft,
): Result<BillPayPrefill> = runCatching {
    require(draft.selectedPaymentSource() == PaymentSource.RIVER_BITCOIN_BILL_PAY) {
        "Bill-pay handoff requires River Bitcoin Bill Pay"
    }
    require(draft.type == AddTransactionType.SPEND) {
        "River bill pay must be a spend"
    }
    require(draft.inputUnit == DisplayUnit.USD) {
        "River bill pay amount must be in USD"
    }
    val merchant = draft.merchant.trim()
    require(merchant.isNotEmpty()) { "Enter a merchant or bill-pay recipient" }
    val cents = parsePositiveDecimal(draft.amount)
        .toMinorUnitsExact(scale = 2, unitName = "USD")
    require(cents > 0L) { "Amount must resolve to at least one cent" }
    BillPayPrefill(
        merchant = merchant,
        date = draft.date,
        amountUsd = BigDecimal(cents)
            .movePointLeft(2)
            .setScale(2)
            .toPlainString(),
        owner = draft.owner.ledgerOwner,
    )
}

/**
 * New rows are the one legitimate unfenced write. The typed receipt installs
 * the server revision on the shared client before the refresh callback runs.
 */
internal suspend fun savePreparedTransaction(
    row: PreparedTransaction,
    client: ConvexMutationClient,
): ConvexResult<TransactionWriteReceipt> =
    client.upsertTransaction(
        ConvexMutation.UpsertTransaction(
            transaction = row.input,
            sourceFile = row.sourceFile,
        ),
    )

/** The payment-source surface uses the capability-scoped device gateway. */
internal suspend fun savePreparedTransaction(
    row: PreparedTransaction,
    gateway: TransactionDeviceMutationGateway,
): ConvexResult<DeviceTransactionWriteReceipt> = gateway.upsert(row)

/**
 * Starts the durable part of an add on a process-owned scope. The client
 * installs an accepted receipt before returning; a disposed sheet suppresses
 * only its stale UI callbacks, never the write, the receipt installation, or
 * the acceptance signal.
 */
internal fun launchPreparedTransactionSave(
    scope: CoroutineScope,
    row: PreparedTransaction,
    client: ConvexMutationClient,
    transactionDraftIds: TransactionDraftIdStore,
    isUiActive: () -> Boolean,
    onAccepted: () -> Unit,
    onUiResult: (DraftIdWriteOutcome<TransactionWriteReceipt>) -> Unit,
): Job = scope.launch {
    val result = savePreparedTransaction(row, client)
    val leaseReset = result !is ConvexResult.Ok ||
        transactionDraftIds.rotateAfterAcceptance(row.sourceFile, row.input.id)
    val outcome = draftIdWriteOutcome(result, leaseReset)
    if (outcome is DraftIdWriteOutcome.Accepted) {
        // The ledger refresh belongs to the screen's view model, which
        // outlives this sheet. An accepted write must become visible even
        // when the user dismissed mid-flight — suppressing this with the
        // sheet left committed, fenced rows invisible until an unrelated
        // refresh.
        onAccepted()
    }
    if (isUiActive()) {
        onUiResult(outcome)
    }
}

internal fun launchPreparedTransactionSave(
    scope: CoroutineScope,
    row: PreparedTransaction,
    gateway: TransactionDeviceMutationGateway,
    transactionDraftIds: TransactionDraftIdStore,
    isUiActive: () -> Boolean,
    onAccepted: () -> Unit,
    onUiResult: (DraftIdWriteOutcome<DeviceTransactionWriteReceipt>) -> Unit,
): Job = scope.launch {
    val result = savePreparedTransaction(row, gateway)
    val leaseReset = result !is ConvexResult.Ok ||
        transactionDraftIds.rotateAfterAcceptance(row.sourceFile, row.input.id)
    val outcome = draftIdWriteOutcome(result, leaseReset)
    if (outcome is DraftIdWriteOutcome.Accepted) {
        onAccepted()
    }
    if (isUiActive()) {
        onUiResult(outcome)
    }
}

/**
 * User-visible feedback for every remote transaction write result.
 *
 * Disabled is an operator switch; NotConfigured is a device/deployment setup
 * problem. Keeping those sentences separate tells the user which remedy is
 * available instead of reducing both causes to "not configured".
 */
internal fun transactionWriteFailureMessage(result: ConvexResult<*>): String? = when (result) {
    is ConvexResult.Ok -> null
    ConvexResult.Disabled -> "Remote transaction writes are switched off"
    ConvexResult.NotConfigured -> "Transaction writing has no usable Convex deployment or token"
    ConvexResult.Unauthorized -> "The sync credential is missing or was rejected"
    ConvexResult.Missing -> "Convex returned no write result"
    is ConvexResult.Failed -> "Transaction was not saved (${result.reason})"
}

internal fun transactionWriteFailureMessage(outcome: DraftIdWriteOutcome<*>): String? =
    when (outcome) {
        is DraftIdWriteOutcome.Accepted -> null
        DraftIdWriteOutcome.AcceptedLeaseResetFailed ->
            "Convex accepted this transaction, but this device could not retire its draft id. " +
                "Do not submit another transaction until local storage is repaired."
        is DraftIdWriteOutcome.Rejected -> transactionWriteFailureMessage(outcome.result)
    }

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
    bitcoinAccounts: List<BtcAccount> = emptyList(),
): Result<PreparedTransaction> = runCatching {
    require(draft.type != AddTransactionType.TRANSFER) {
        "Use the dedicated Bitcoin transfer flow for owned-wallet movement"
    }
    val source = draft.selectedPaymentSource()
    require(source.route != PaymentSourceRoute.BILL_PAY) {
        "River bill pay must be handed off to the bill-pay form"
    }
    val merchant = draft.merchant.trim()
    require(merchant.isNotEmpty()) { "Enter a merchant or transfer destination" }

    val parsed = parsePositiveDecimal(draft.amount)
    val (amountCents, satsFromInput) = when (draft.inputUnit) {
        DisplayUnit.USD -> {
            val cents = parsed.toMinorUnitsExact(scale = 2, unitName = "USD")
            cents to btcPriceCents.takeIf { it > 0L }?.let { Money.usdCentsToSats(cents, it) }
        }

        DisplayUnit.BTC -> {
            val exactSats = parsed.toMinorUnitsExact(scale = 8, unitName = "BTC")
            require(btcPriceCents > 0L) {
                "An operational Bitcoin market quote is required to save BTC input as USD cents"
            }
            satsToCentsExact(exactSats, btcPriceCents) to exactSats
        }

        DisplayUnit.SATS -> {
            val exactSats = parsed.toMinorUnitsExact(scale = 0, unitName = "sats")
            require(btcPriceCents > 0L) {
                "An operational Bitcoin market quote is required to save sats input as USD cents"
            }
            satsToCentsExact(exactSats, btcPriceCents) to exactSats
        }
    }
    require(amountCents > 0L) { "Amount must resolve to at least one cent" }

    val selectedAccountKey = if (source.isBitcoinTransaction) {
        val key = draft.bitcoinAccountKey?.trim().orEmpty()
        require(key.isNotEmpty()) { "Select a Bitcoin account" }
        val effectiveOwner = draft.owner.ledgerOwner
        require(
            bitcoinAccounts.any { it.key == key && it.owner == effectiveOwner },
        ) {
            "Select a Bitcoin account belonging to ${effectiveOwner.displayName}"
        }
        val sats = satsFromInput ?: 0L
        require(sats > 0L) { "Bitcoin amount must resolve to positive sats" }
        key
    } else {
        null
    }
    val satsForWire = satsFromInput.takeIf { source.isBitcoinTransaction }

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
            card = source.persistedCard,
            note = draft.note.trim().takeIf(String::isNotEmpty),
            // Fiat card sources deliberately omit both Bitcoin fields, even when
            // a stale account key or a converted input was present in the draft.
            amountSats = satsForWire,
            bitcoinAccountKey = selectedAccountKey,
            owner = draft.owner.ledgerOwner,
        ),
        sourceFile = draft.owner.ledgerOwner.transactionsDataFileName,
        sats = satsFromInput,
    )
}

/**
 * Converts the Budget income draft into the read-model shape consumed by the
 * atomic BTC-buy editor. This is deliberately only a pure seed conversion: it
 * does not call the legacy transaction mutation, so the eventual device write
 * can create the income row and buy row at one server boundary.
 */
internal fun incomeEntryForBitcoinBuy(
    draft: AddTransactionDraft,
    btcPriceCents: Long,
    id: String,
): WriteDraftResult<IncomeEntry> {
    if (!draft.owner.isAdult) {
        return WriteDraftResult.Invalid(
            "Only adult household profiles can add income as a Bitcoin buy.",
        )
    }
    if (draft.type != AddTransactionType.INCOME) {
        return WriteDraftResult.Invalid("Choose Income before adding it as a Bitcoin buy.")
    }
    if (id.isBlank()) {
        return WriteDraftResult.Invalid("The Bitcoin-buy draft id is missing.")
    }
    val prepared = prepareTransaction(draft, btcPriceCents, id).getOrElse {
        return WriteDraftResult.Invalid(it.message ?: "Income is invalid.")
    }
    return WriteDraftResult.Valid(
        IncomeEntry(
            id = id,
            date = prepared.input.date,
            month = prepared.input.date.substringBeforeLast('-'),
            amountCents = prepared.input.amountCents,
            sourceName = prepared.input.merchant,
            note = prepared.input.note,
            owner = draft.owner.ledgerOwner,
        ),
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
                val sats = Money.usdCentsToSats(cents, btcPriceCents)
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
            Money.usdCentsToSats(cents, btcPriceCents)
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
    allowIncomeBitcoinBuy: Boolean = false,
    onOpenIncomeBitcoinBuy: (IncomeEntry) -> Unit = {},
    onStartRiverBillPay: (BillPayPrefill) -> Unit = {},
) {
    val applicationContext = LocalContext.current.applicationContext
    val application = applicationContext as? VaultApplication
    val paymentSourceStore = remember(applicationContext, application) {
        application?.paymentSourceStore ?: PaymentSourceStore(applicationContext)
    }
    val fallbackTransactionDraftIds = remember { TransactionDraftIdStore() }
    val transactionDraftIds = application?.transactionDraftIds ?: fallbackTransactionDraftIds
    val btcBuyDraftIds = application?.btcBuyDraftIds
    val transactionGateway = remember(application) { application?.transactionDeviceMutationGateway }
    val saveScope = remember(application) { application?.applicationScope }
    val uiActive = remember { AtomicBoolean(true) }
    DisposableEffect(Unit) {
        uiActive.set(true)
        onDispose { uiActive.set(false) }
    }

    // The wire is both saveable UI state and durable process state. The latter is
    // the source of truth when a new composition is created without a saved-state
    // bundle; the former keeps the visible choice stable through recreation.
    var paymentSourceWire by rememberSaveable {
        mutableStateOf(paymentSourceStore.current().wire)
    }
    val paymentSource = PaymentSource.fromWire(paymentSourceWire)

    // One process-owned id survives dismissal and Activity recreation until the
    // device endpoint confirms acceptance. Every retry therefore addresses the
    // same server row in the same source-file scope.
    val draftScope = state.activeProfile.ledgerOwner.transactionsDataFileName
    val draftTransactionId = remember(draftScope, transactionDraftIds) {
        transactionDraftIds.currentId(draftScope)
    }
    var typeName by rememberSaveable { mutableStateOf(AddTransactionType.SPEND.name) }
    var inputUnitName by rememberSaveable { mutableStateOf(DisplayUnit.USD.name) }
    var merchant by rememberSaveable { mutableStateOf("") }
    var category by rememberSaveable { mutableStateOf("") }
    var amount by rememberSaveable { mutableStateOf("") }
    var bitcoinAccountKey by rememberSaveable { mutableStateOf<String?>(null) }
    var dateIso by rememberSaveable { mutableStateOf(LocalDate.now(ZoneOffset.UTC).toString()) }
    var note by rememberSaveable { mutableStateOf("") }
    var errorMessage by rememberSaveable { mutableStateOf<String?>(null) }
    // Deliberately NOT rememberSaveable: a recreated sheet cannot reconnect to
    // the in-flight job. A fresh sheet reconnects to the same process-owned id
    // and safely retries instead.
    var saving by remember { mutableStateOf(false) }
    var showDatePicker by rememberSaveable { mutableStateOf(false) }
    val type = AddTransactionType.valueOf(typeName)
    val inputUnit = if (paymentSource.route == PaymentSourceRoute.BILL_PAY) {
        DisplayUnit.USD
    } else {
        DisplayUnit.valueOf(inputUnitName)
    }
    val operationalBtcPriceCents = state.operationalBitcoinQuote()?.priceCents ?: 0L
    val eligibleBitcoinAccounts = remember(state.activeProfile, state.data.btcAccounts.value) {
        bitcoinAccountsForEffectiveLedgerOwner(
            accounts = state.data.btcAccounts.value,
            viewer = state.activeProfile,
        )
    }
    val selectedBitcoinAccountKey = selectedBitcoinAccountKeyAfterSourceChange(
        source = paymentSource,
        currentKey = bitcoinAccountKey,
        accounts = state.data.btcAccounts.value,
        viewer = state.activeProfile,
    )
    val accountOptionLabels = remember(eligibleBitcoinAccounts) {
        eligibleBitcoinAccounts.associateBy { account ->
            "${account.label} · ${account.key}"
        }
    }
    val selectedAccountLabel = eligibleBitcoinAccounts
        .firstOrNull { it.key == selectedBitcoinAccountKey }
        ?.let { "${it.label} · ${it.key}" }
        ?: "Select a Bitcoin account"
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
    fun currentDraft() = AddTransactionDraft(
        type = type,
        merchant = merchant,
        category = selectedCategory,
        amount = amount,
        inputUnit = inputUnit,
        card = paymentSource.persistedCard,
        date = LocalDate.parse(dateIso),
        note = note,
        owner = state.activeProfile,
        paymentSource = paymentSource,
        bitcoinAccountKey = selectedBitcoinAccountKey,
    )

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
                options = AddTransactionType.entries.filterNot { it == AddTransactionType.TRANSFER },
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

            DropdownField(
                label = "Payment source",
                selected = paymentSource.label,
                options = PaymentSource.entries.map(PaymentSource::label),
                modifier = Modifier.testTag(PAYMENT_SOURCE_SELECTOR_TEST_TAG),
                onSelect = { selectedLabel ->
                    val next = PaymentSource.entries.first { it.label == selectedLabel }
                    if (!paymentSourceStore.select(next)) {
                        errorMessage = "Payment source could not be saved"
                    } else {
                        paymentSourceWire = next.wire
                        bitcoinAccountKey = selectedBitcoinAccountKeyAfterSourceChange(
                            source = next,
                            currentKey = bitcoinAccountKey,
                            accounts = state.data.btcAccounts.value,
                            viewer = state.activeProfile,
                        )
                        if (next.route == PaymentSourceRoute.BILL_PAY) {
                            if (inputUnit != DisplayUnit.USD) {
                                amount = convertAmountForUnit(
                                    amount = amount,
                                    from = inputUnit,
                                    to = DisplayUnit.USD,
                                    btcPriceCents = operationalBtcPriceCents,
                                ).orEmpty()
                            }
                            inputUnitName = DisplayUnit.USD.name
                        }
                        errorMessage = null
                    }
                },
            )

            if (paymentSource.route == PaymentSourceRoute.BILL_PAY) {
                Text(
                    "River bill pay opens a separate Bitcoin bill-pay form in USD",
                    style = MaterialTheme.typography.bodySmall,
                )
            } else {
                OptionRow(
                    options = DisplayUnit.entries,
                    selected = inputUnit,
                    label = DisplayUnit::label,
                    onSelect = {
                        convertAmountForUnit(
                            amount = amount,
                            from = inputUnit,
                            to = it,
                            btcPriceCents = operationalBtcPriceCents,
                        )?.let { converted -> amount = converted }
                        inputUnitName = it.name
                        errorMessage = null
                    },
                )
            }

            OutlinedTextField(
                value = amount,
                onValueChange = {
                    amount = it
                    errorMessage = null
                },
                label = { Text(stringResource(R.string.add_transaction_amount)) },
                supportingText = {
                    conversionPreview(amount, inputUnit, operationalBtcPriceCents)?.let { Text(it) }
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            if (paymentSource.isBitcoinTransaction) {
                if (eligibleBitcoinAccounts.isEmpty()) {
                    Text(
                        "No Bitcoin accounts belong to ${state.activeProfile.ledgerOwner.displayName}",
                        color = VaultNegative,
                        style = MaterialTheme.typography.bodySmall,
                    )
                } else {
                    DropdownField(
                        label = "Bitcoin account",
                        selected = selectedAccountLabel,
                        options = accountOptionLabels.keys.toList(),
                        modifier = Modifier.testTag(BITCOIN_ACCOUNT_SELECTOR_TEST_TAG),
                        onSelect = { selected ->
                            bitcoinAccountKey = accountOptionLabels[selected]?.key
                            errorMessage = null
                        },
                    )
                }
            }

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

            if (allowIncomeBitcoinBuy && state.activeProfile.isAdult) {
                Column(verticalArrangement = Arrangement.spacedBy(VaultSpace.xs)) {
                    Text(
                        stringResource(R.string.budget_income_add_as_bitcoin_buy_detail),
                        color = VaultTextMuted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    OutlinedButton(
                        onClick = {
                            // Validate every user field before taking the
                            // process-owned Bitcoin-buy lease. The conversion
                            // does not inspect this temporary id.
                            val seed =
                                incomeEntryForBitcoinBuy(
                                    draft = currentDraft(),
                                    btcPriceCents = operationalBtcPriceCents,
                                    id = "validation-only",
                                )
                            when (seed) {
                                is WriteDraftResult.Invalid -> errorMessage = seed.reason
                                is WriteDraftResult.Valid -> {
                                    val btcBuyDraftScope = btcBuyDraftIdScope(
                                        surface = BtcBuyWriteSurface.INCOME_LINKED,
                                        profile = state.activeProfile,
                                    )
                                    val atomicIncomeDraftId =
                                        btcBuyDraftIds?.currentId(btcBuyDraftScope)
                                            ?: "android-${UUID.randomUUID()}"
                                    onOpenIncomeBitcoinBuy(seed.request.copy(id = atomicIncomeDraftId))
                                }
                            }
                        },
                        enabled = !saving && type == AddTransactionType.INCOME,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(stringResource(R.string.budget_income_add_as_bitcoin_buy))
                    }
                }
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
                        val selectedDate = runCatching { LocalDate.parse(dateIso) }.getOrElse {
                            errorMessage = "Enter a valid date"
                            return@Button
                        }
                        val draft = AddTransactionDraft(
                            type = type,
                            merchant = merchant,
                            category = selectedCategory,
                            amount = amount,
                            inputUnit = inputUnit,
                            card = paymentSource.persistedCard,
                            date = selectedDate,
                            note = note,
                            owner = state.activeProfile,
                            paymentSource = paymentSource,
                            bitcoinAccountKey = selectedBitcoinAccountKey,
                        )

                        if (paymentSource.route == PaymentSourceRoute.BILL_PAY) {
                            val handoff = prepareBillPayHandoff(draft).getOrElse {
                                errorMessage = it.message ?: "Bill-pay details are invalid"
                                return@Button
                            }
                            onStartRiverBillPay(handoff)
                            onDismiss()
                            return@Button
                        }

                        val row = prepareTransaction(
                            draft = draft,
                            btcPriceCents = operationalBtcPriceCents,
                            id = draftTransactionId,
                            bitcoinAccounts = state.data.btcAccounts.value,
                        ).getOrElse {
                            errorMessage = it.message ?: "Transaction is invalid"
                            return@Button
                        }
                        val gateway = transactionGateway
                        if (gateway == null) {
                            errorMessage = "Transaction writing is not configured"
                            return@Button
                        }
                        val scope = saveScope
                        if (scope == null) {
                            errorMessage = "Transaction writing is not configured"
                            return@Button
                        }
                        saving = true
                        launchPreparedTransactionSave(
                            scope = scope,
                            row = row,
                            gateway = gateway,
                            transactionDraftIds = transactionDraftIds,
                            isUiActive = uiActive::get,
                            // The acceptance signal goes to the process-owned
                            // flow, never to a composition-captured callback.
                            onAccepted = { application?.noteAcceptedWrite() },
                        ) { result ->
                            saving = false
                            val failure = transactionWriteFailureMessage(result)
                            if (failure == null) {
                                onDismiss()
                            } else {
                                errorMessage = failure
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
    modifier: Modifier = Modifier,
    onSelect: (String) -> Unit,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    Column(modifier.fillMaxWidth()) {
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
