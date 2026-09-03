package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import com.sats21m.vogelvault.DraftIdWriteOutcome
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.TransactionDraftIdStore
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.draftIdWriteOutcome
import com.sats21m.vogelvault.onServerAccepted
import com.sats21m.vogelvault.data.BTC_BILL_PAYS_SOURCE_FILE
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.convexWriteFailureMessage
import com.sats21m.vogelvault.data.RIVER_BITCOIN_BILL_PAY_PLATFORM
import com.sats21m.vogelvault.domain.BillPayBudgetEffect
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.ui.theme.VaultSpace
import java.math.BigDecimal
import java.time.LocalDate
import java.time.format.DateTimeParseException
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

internal const val BTC_BILL_PAY_CATEGORY = "Credit Card Payment"

internal data class BtcBillPayWriteRequest(
    val id: String,
    val owner: FamilyMember,
    val date: String,
    val merchant: String,
    val category: String,
    val budgetEffect: BillPayBudgetEffect,
    val amountUsdCents: Long,
    val btcSpentSats: Long,
    val btcPriceCents: Long,
    val feeUsdCents: Long,
    val note: String? = null,
    val reference: String? = null,
)

internal fun canAddBtcBillPay(status: Freshness, owner: FamilyMember): Boolean =
    status in setOf(Freshness.LIVE, Freshness.EMPTY) && owner.isAdult

/**
 * Validates the editor into the exact request sent to the device mutation.
 * Adult profiles share the canonical Victor household owner; child profiles are
 * refused before a capability or network client is touched.
 */
internal fun btcBillPayWriteRequest(
    owner: FamilyMember,
    id: String,
    date: String,
    merchant: String,
    category: String,
    budgetEffect: BillPayBudgetEffect,
    amountUsd: String,
    sats: String,
    priceUsd: String,
    feeUsd: String,
    availableCategories: List<String>,
    note: String? = null,
    reference: String? = null,
): WriteDraftResult<BtcBillPayWriteRequest> {
    if (!owner.isAdult) {
        return WriteDraftResult.Invalid("Bitcoin bill pays can only be added from an adult profile.")
    }
    if (id.isBlank()) return WriteDraftResult.Invalid("A bill-pay draft id is required.")

    val normalizedDate = try {
        LocalDate.parse(date.trim()).toString()
    } catch (_: DateTimeParseException) {
        return WriteDraftResult.Invalid("Enter a date as yyyy-MM-dd.")
    }
    val normalizedMerchant = merchant.trim()
    if (normalizedMerchant.isEmpty()) {
        return WriteDraftResult.Invalid("Enter a merchant.")
    }

    val normalizedCategories = availableCategories.map(String::trim).filter(String::isNotEmpty).distinct()
    val normalizedCategory = when (budgetEffect) {
        BillPayBudgetEffect.BUDGET_CATEGORY -> {
            val selected = category.trim()
            if (selected !in normalizedCategories) {
                return WriteDraftResult.Invalid("Choose a real budget category for this payment.")
            }
            selected
        }
        BillPayBudgetEffect.CREDIT_CARD_PAYMENT -> BTC_BILL_PAY_CATEGORY
    }

    val amountCents = exactBillPayMinorUnits(amountUsd, scale = 2, allowZero = false)
        ?: return WriteDraftResult.Invalid("Amount must be positive with at most two decimal places.")
    val spentSats = sats.trim().replace(",", "").toLongOrNull()?.takeIf { it > 0L }
        ?: return WriteDraftResult.Invalid("Sats must be a positive whole number.")
    val priceCents = exactBillPayMinorUnits(priceUsd, scale = 2, allowZero = false)
        ?: return WriteDraftResult.Invalid("BTC price must be positive with at most two decimal places.")
    val feeCents = exactBillPayMinorUnits(feeUsd, scale = 2, allowZero = true)
        ?: return WriteDraftResult.Invalid("Fee must be non-negative with at most two decimal places.")

    return WriteDraftResult.Valid(
        BtcBillPayWriteRequest(
            id = id,
            owner = owner.ledgerOwner,
            date = normalizedDate,
            merchant = normalizedMerchant,
            category = normalizedCategory,
            budgetEffect = budgetEffect,
            amountUsdCents = amountCents,
            btcSpentSats = spentSats,
            btcPriceCents = priceCents,
            feeUsdCents = feeCents,
            note = note?.trim()?.takeIf(String::isNotEmpty),
            reference = reference?.trim()?.takeIf(String::isNotEmpty),
        ),
    )
}

private fun exactBillPayMinorUnits(raw: String, scale: Int, allowZero: Boolean): Long? =
    runCatching {
        val normalized = raw.trim().removePrefix("$").replace(",", "")
        if (normalized.isEmpty()) return@runCatching null
        val value = BigDecimal(normalized)
        if (value.scale().coerceAtLeast(0) > scale) return@runCatching null
        val minorUnits = value.movePointRight(scale).longValueExact()
        if (if (allowZero) minorUnits >= 0L else minorUnits > 0L) minorUnits else null
    }.getOrNull()

internal fun btcBillPayWriteFailureMessage(result: ConvexResult<*>): String? =
    convexWriteFailureMessage("Bitcoin bill pay not saved", result)

internal fun btcBillPayWriteFailureMessage(outcome: DraftIdWriteOutcome<*>): String? =
    when (outcome) {
        is DraftIdWriteOutcome.Accepted -> null
        DraftIdWriteOutcome.AcceptedLeaseResetFailed ->
            "Convex accepted this Bitcoin bill pay, but this device could not retire its draft id. " +
                "Do not submit another bill pay until local storage is repaired."
        is DraftIdWriteOutcome.Rejected -> btcBillPayWriteFailureMessage(outcome.result)
    }

/**
 * Runs one bill-pay mutation on the application-owned scope. A retry keeps the
 * same source-scoped draft id; only a definitive Ok releases it.
 */
internal fun launchBtcBillPaySave(
    scope: CoroutineScope,
    request: BtcBillPayWriteRequest,
    gateway: BtcBillPayMutationGateway,
    draftIds: TransactionDraftIdStore,
    baseUpdatedAtMs: Long? = null,
    onAccepted: () -> Unit = {},
    onResult: (DraftIdWriteOutcome<BtcBillPayUpsertReceipt>) -> Unit,
): Job = scope.launch {
    val result = gateway.upsert(request, baseUpdatedAtMs)
    val leaseReset = result !is ConvexResult.Ok ||
        draftIds.rotateAfterAcceptance(BTC_BILL_PAYS_SOURCE_FILE, request.id)
    val outcome = draftIdWriteOutcome(result, leaseReset)
    outcome.onServerAccepted {
        onAccepted()
    }
    onResult(outcome)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BtcBillPayEntrySheet(
    owner: FamilyMember,
    budgetCategories: List<String>,
    prefill: BillPayPrefill? = null,
    onDismiss: () -> Unit,
    onWriteSucceeded: () -> Unit,
) {
    val application = LocalContext.current.applicationContext as? VaultApplication
    val gateway = remember(application) { application?.btcBillPayMutationGateway }
    val draftIds = application?.btcBillPayDraftIds
    val writeScope = application?.applicationScope
    val draftId = remember(application) {
        draftIds?.currentId(BTC_BILL_PAYS_SOURCE_FILE) ?: "android-${UUID.randomUUID()}"
    }
    val stateKeys = arrayOf(owner.key, draftId, prefill?.dateIso.orEmpty(), prefill?.merchant.orEmpty())
    var date by rememberSaveable(*stateKeys) { mutableStateOf(prefill?.dateIso ?: LocalDate.now().toString()) }
    var merchant by rememberSaveable(*stateKeys) { mutableStateOf(prefill?.merchant.orEmpty()) }
    var effectWire by rememberSaveable(*stateKeys) {
        mutableStateOf(BillPayBudgetEffect.CREDIT_CARD_PAYMENT.wireValue)
    }
    var category by rememberSaveable(*stateKeys) {
        mutableStateOf(budgetCategories.firstOrNull().orEmpty())
    }
    var amountUsd by rememberSaveable(*stateKeys) { mutableStateOf(prefill?.amountUsd.orEmpty()) }
    var sats by rememberSaveable(*stateKeys) { mutableStateOf("") }
    var priceUsd by rememberSaveable(*stateKeys) { mutableStateOf("") }
    var feeUsd by rememberSaveable(*stateKeys) { mutableStateOf("0") }
    var note by rememberSaveable(*stateKeys) { mutableStateOf("") }
    var reference by rememberSaveable(*stateKeys) { mutableStateOf("") }
    var message by rememberSaveable(*stateKeys) { mutableStateOf<String?>(null) }
    var submitting by remember(*stateKeys) { mutableStateOf(false) }
    var effectMenuExpanded by remember(*stateKeys) { mutableStateOf(false) }
    var categoryMenuExpanded by remember(*stateKeys) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val effect = BillPayBudgetEffect.fromWireOrDefault(effectWire)

    ModalBottomSheet(onDismissRequest = { if (!submitting) onDismiss() }) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(VaultSpace.md),
            verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
        ) {
            Text(stringResource(R.string.btc_bill_pay_editor_title))
            BillPayEditorField(date, { date = it }, R.string.btc_bill_pay_date_label)
            BillPayEditorField(merchant, { merchant = it }, R.string.btc_bill_pay_merchant_label)

            Text(stringResource(R.string.btc_bill_pay_effect_label))
            OutlinedButton(
                onClick = { effectMenuExpanded = true },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    if (effect == BillPayBudgetEffect.BUDGET_CATEGORY) {
                        stringResource(R.string.btc_bill_pay_effect_budget_category)
                    } else {
                        stringResource(R.string.btc_bill_pay_effect_credit_card)
                    },
                )
            }
            DropdownMenu(
                expanded = effectMenuExpanded,
                onDismissRequest = { effectMenuExpanded = false },
            ) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.btc_bill_pay_effect_budget_category)) },
                    onClick = {
                        effectWire = BillPayBudgetEffect.BUDGET_CATEGORY.wireValue
                        effectMenuExpanded = false
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.btc_bill_pay_effect_credit_card)) },
                    onClick = {
                        effectWire = BillPayBudgetEffect.CREDIT_CARD_PAYMENT.wireValue
                        effectMenuExpanded = false
                    },
                )
            }

            if (effect == BillPayBudgetEffect.BUDGET_CATEGORY) {
                Text(stringResource(R.string.btc_bill_pay_category_label))
                OutlinedButton(
                    onClick = { categoryMenuExpanded = true },
                    enabled = budgetCategories.isNotEmpty(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(category.ifBlank { stringResource(R.string.btc_bill_pay_choose_category) })
                }
                DropdownMenu(
                    expanded = categoryMenuExpanded,
                    onDismissRequest = { categoryMenuExpanded = false },
                ) {
                    budgetCategories.forEach { option ->
                        DropdownMenuItem(
                            text = { Text(option) },
                            onClick = {
                                category = option
                                categoryMenuExpanded = false
                            },
                        )
                    }
                }
            } else {
                Text("Category: $BTC_BILL_PAY_CATEGORY")
            }

            BillPayEditorField(
                amountUsd,
                { amountUsd = it },
                R.string.btc_bill_pay_amount_label,
                KeyboardType.Decimal,
            )
            BillPayEditorField(
                sats,
                { sats = it },
                R.string.btc_bill_pay_sats_label,
                KeyboardType.Number,
            )
            BillPayEditorField(
                priceUsd,
                { priceUsd = it },
                R.string.btc_bill_pay_price_label,
                KeyboardType.Decimal,
            )
            BillPayEditorField(
                feeUsd,
                { feeUsd = it },
                R.string.btc_bill_pay_fee_label,
                KeyboardType.Decimal,
            )
            BillPayEditorField(note, { note = it }, R.string.btc_bill_pay_note_label)
            BillPayEditorField(reference, { reference = it }, R.string.btc_bill_pay_reference_label)
            message?.let { Text(it) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss, enabled = !submitting) {
                    Text(stringResource(R.string.write_cancel))
                }
                VaultButton(
                    enabled = !submitting,
                    onClick = {
                        when (
                            val draft = btcBillPayWriteRequest(
                                owner = owner,
                                id = draftId,
                                date = date,
                                merchant = merchant,
                                category = category,
                                budgetEffect = effect,
                                amountUsd = amountUsd,
                                sats = sats,
                                priceUsd = priceUsd,
                                feeUsd = feeUsd,
                                availableCategories = budgetCategories,
                                note = note,
                                reference = reference,
                            )
                        ) {
                            is WriteDraftResult.Invalid -> message = draft.reason
                            is WriteDraftResult.Valid -> {
                                val writeGateway = gateway
                                val processScope = writeScope
                                val processDraftIds = draftIds
                                if (writeGateway == null || processScope == null || processDraftIds == null) {
                                    message = "Bitcoin bill pay not saved: the app write client is unavailable."
                                    return@VaultButton
                                }
                                submitting = true
                                launchBtcBillPaySave(
                                    scope = processScope,
                                    request = draft.request,
                                    gateway = writeGateway,
                                    draftIds = processDraftIds,
                                    onAccepted = onWriteSucceeded,
                                ) { outcome ->
                                    submitting = false
                                    if (outcome is DraftIdWriteOutcome.Accepted) {
                                        onDismiss()
                                    } else {
                                        message = btcBillPayWriteFailureMessage(outcome)
                                    }
                                }
                            }
                        }
                    },
                ) {
                    Text(if (submitting) stringResource(R.string.add_transaction_saving) else stringResource(R.string.write_save))
                }
            }
        }
    }
}

@Composable
private fun BillPayEditorField(
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
