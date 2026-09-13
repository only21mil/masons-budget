package com.sats21m.vogelvault.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import com.sats21m.vogelvault.ui.components.LedgerTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.TransactionDraftIdStore
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.BtcBuyInput
import com.sats21m.vogelvault.data.BudgetCategoryInput
import com.sats21m.vogelvault.data.BudgetCategoryDeleteResult
import com.sats21m.vogelvault.data.ConvexDeviceMutationClient
import com.sats21m.vogelvault.data.ConvexMutation
import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.convexWriteFailureMessage
import com.sats21m.vogelvault.data.ConvexValue
import com.sats21m.vogelvault.data.LinkedIncomeInput
import com.sats21m.vogelvault.domain.BudgetHealth
import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.BudgetHealthStatus
import com.sats21m.vogelvault.domain.CategorySpend
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.IncomeEntry
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.budgetHealth
import com.sats21m.vogelvault.ui.theme.LedgerMotion
import com.sats21m.vogelvault.ui.theme.LedgerSpacing
import com.sats21m.vogelvault.ui.theme.LocalLedgerEffects
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.rememberLedgerHaptics
import java.time.LocalDate
import java.time.format.DateTimeParseException
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

data class BudgetCategoryEditorSeed(
    val viewer: FamilyMember,
    val displayedMonth: String,
    val budgetDocumentMonth: String,
    val category: CategorySpend,
    val budget: Budget? = null,
    val sourceFile: String? = null,
)

internal fun budgetCategoryDeleteSourceFile(viewer: FamilyMember): String? = when {
    viewer.isAdult -> "budget"
    viewer == FamilyMember.MASON -> "mason-budget"
    else -> null
}

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
    val feeUsdCents: Long = 0L,
) {
    init {
        require(id.isNotBlank())
        require(runCatching { LocalDate.parse(date) }.isSuccess)
        require(source.isNotBlank())
        require(sats > 0L)
        require(priceUsdCents > 0L)
        require(usdCents > 0L)
        require(feeUsdCents >= 0L)
    }
}

internal data class BtcBuyFromIncomeWriteRequest(
    val id: String,
    /** Canonical owner sent to the device mutation. */
    val owner: FamilyMember,
    /** Active profile identity used only to namespace the retry lease. */
    val profile: FamilyMember,
    val date: String,
    val source: String,
    val sats: Long,
    val priceUsdCents: Long,
    val usdCents: Long,
    val feeUsdCents: Long = 0L,
    val incomeSource: String,
    val incomeNote: String?,
    val buyNote: String?,
    val loggedBy: String? = null,
) {
    val buy: BtcBuyInput = BtcBuyInput(
        id = id,
        owner = owner,
        date = date,
        source = source,
        sats = sats,
        priceUsdCents = priceUsdCents,
        usdCents = usdCents,
        feeUsdCents = feeUsdCents,
        note = buyNote,
        loggedBy = loggedBy,
    )
    val linkedIncome: LinkedIncomeInput = LinkedIncomeInput(
        id = id,
        owner = owner,
        date = date,
        amountCents = usdCents,
        source = incomeSource,
        note = incomeNote,
        loggedBy = loggedBy,
    )

    init {
        require(profile.isAdult)
        require(owner == profile.ledgerOwner)
        require(owner.isAdult)
        require(id.isNotBlank())
        require(runCatching { LocalDate.parse(date) }.isSuccess)
        require(source.isNotBlank())
        require(sats > 0L)
        require(priceUsdCents > 0L)
        require(usdCents > 0L)
        require(feeUsdCents >= 0L)
        require(incomeSource.isNotBlank())
    }
}

internal const val BITCOIN_BUY_SOURCE_FILE = "bitcoin-buys"

/**
 * A Bitcoin-buy lease is narrower than the server data file. The data file is
 * the wire idempotency domain, while these values identify the UI operation
 * and the active profile that owns the retry state.
 */
internal enum class BtcBuyWriteSurface(val wire: String) {
    STANDALONE("standalone"),
    INCOME_LINKED("income-linked"),
}

internal fun btcBuyDraftIdScope(
    surface: BtcBuyWriteSurface,
    profile: FamilyMember,
): String =
    listOf(
        "btc-buy-v1",
        surface.wire,
        profile.btcBuysDataFileName,
        profile.ledgerOwner.key,
        profile.key,
    ).joinToString(":")

internal class BtcBuyIncomeMutationGateway(
    private val client: ConvexDeviceMutationClient,
) {
    suspend fun upsert(request: BtcBuyFromIncomeWriteRequest): ConvexResult<ConvexValue> =
        client.mutate(
            ConvexMutation.UpsertBtcBuyFromDevice(
                owner = request.owner,
                sourceFile = BITCOIN_BUY_SOURCE_FILE,
                buy = request.buy,
                linkedIncome = request.linkedIncome,
            ),
        )
}

internal fun btcBuyFromIncomeWriteRequest(
    viewer: FamilyMember,
    id: String,
    income: com.sats21m.vogelvault.domain.IncomeEntry,
    source: String,
    sats: String,
    priceUsd: String,
    buyNote: String? = null,
): WriteDraftResult<BtcBuyFromIncomeWriteRequest> {
    if (!viewer.isAdult) {
        return WriteDraftResult.Invalid("Only adult household profiles can add income as a Bitcoin buy.")
    }
    if (!income.owner.isAdult) {
        return WriteDraftResult.Invalid("Child income cannot be added to the adult Bitcoin ledger.")
    }
    val normalizedId = id.trim()
    if (normalizedId.isEmpty()) return WriteDraftResult.Invalid("The Bitcoin-buy draft id is missing.")
    val normalizedDate =
        try {
            LocalDate.parse(income.date.trim()).toString()
        } catch (_: DateTimeParseException) {
            return WriteDraftResult.Invalid("The income date is invalid.")
        }
    val normalizedSource = source.trim()
    if (normalizedSource.isEmpty()) return WriteDraftResult.Invalid("Enter a purchase source.")
    val exactSats = sats.trim().toLongOrNull()?.takeIf { it > 0L }
        ?: return WriteDraftResult.Invalid("Sats must be a positive whole number.")
    val priceCents = Money.exactPositiveMinorUnitsOrNull(priceUsd, 2, allowZero = false)
        ?: return WriteDraftResult.Invalid("Price must be positive with at most two decimal places.")
    if (income.amountCents <= 0L) {
        return WriteDraftResult.Invalid("Income amount must be positive.")
    }
    val normalizedIncomeSource = income.sourceName.trim()
    if (normalizedIncomeSource.isEmpty()) {
        return WriteDraftResult.Invalid("The income source is missing.")
    }
    return WriteDraftResult.Valid(
        BtcBuyFromIncomeWriteRequest(
            id = normalizedId,
            owner = viewer.ledgerOwner,
            profile = viewer,
            date = normalizedDate,
            source = normalizedSource,
            sats = exactSats,
            priceUsdCents = priceCents,
            usdCents = income.amountCents,
            incomeSource = normalizedIncomeSource,
            incomeNote = income.note?.trim()?.takeIf { it.isNotEmpty() },
            buyNote = buyNote?.trim()?.takeIf { it.isNotEmpty() },
        ),
    )
}

internal fun launchBtcBuyFromIncomeSave(
    scope: CoroutineScope,
    request: BtcBuyFromIncomeWriteRequest,
    gateway: BtcBuyIncomeMutationGateway,
    buyDraftIds: TransactionDraftIdStore,
    onResult: (BtcBuySaveOutcome) -> Unit,
): Job = scope.launch {
    val leaseScope = btcBuyDraftIdScope(BtcBuyWriteSurface.INCOME_LINKED, request.profile)
    val result = gateway.upsert(request)
    val leaseReset =
        result !is ConvexResult.Ok || buyDraftIds.rotateAfterAcceptance(leaseScope, request.id)
    onResult(btcBuySaveOutcome(result, leaseReset))
}

internal sealed interface BtcBuySaveOutcome {
    data object Accepted : BtcBuySaveOutcome
    data object AcceptedLeaseResetFailed : BtcBuySaveOutcome
    data class Rejected(val result: ConvexResult<ConvexValue>) : BtcBuySaveOutcome
}

internal fun btcBuySaveOutcome(
    result: ConvexResult<ConvexValue>,
    leaseReset: Boolean,
): BtcBuySaveOutcome =
    when {
        result !is ConvexResult.Ok -> BtcBuySaveOutcome.Rejected(result)
        leaseReset -> BtcBuySaveOutcome.Accepted
        else -> BtcBuySaveOutcome.AcceptedLeaseResetFailed
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
    val cents = Money.exactPositiveMinorUnitsOrNull(dollars, 2, allowZero = true)
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

internal data class BudgetCategoryProgress(
    val health: BudgetHealth,
    val percentageLabel: String,
    val fillFraction: Float,
) {
    val statusLabel: String get() = health.label
}

/**
 * Presentation-only mapping over the canonical Android domain selector.
 * Negative stored limits are invalid targets and normalize to the domain's
 * zero-limit state, preserving the safe no-division behavior at this boundary.
 */
internal fun budgetCategoryProgress(spentCents: Long, limitCents: Long): BudgetCategoryProgress {
    val health = budgetHealth(limitCents.coerceAtLeast(0L), spentCents)
    val percentageLabel =
        health.overPercent?.let { "+$it% over" }
            ?: "${health.remainingPercent ?: 0}% left"
    return BudgetCategoryProgress(
        health = health,
        percentageLabel = percentageLabel,
        fillFraction = health.barBasisPoints / 10_000f,
    )
}

internal fun budgetProgressAccessibilityLabel(
    category: CategorySpend,
    progress: BudgetCategoryProgress,
): String =
    "${category.name}, ${Money.formatUsd(category.spentCents)} spent of " +
        "${Money.formatUsd(category.budgetCents)} planned, " +
        "${Money.formatUsd(category.remainingCents)} remaining, " +
        "${progress.statusLabel}, ${progress.percentageLabel}"

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
    val priceCents = Money.exactPositiveMinorUnitsOrNull(priceUsd, 2, allowZero = false)
        ?: return WriteDraftResult.Invalid("Price must be positive with at most two decimal places.")
    val purchaseCents = Money.exactPositiveMinorUnitsOrNull(purchaseUsd, 2, allowZero = false)
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

/**
 * Category remaining amount and planned limit, followed by the spend progress bar.
 *
 * The whole row opens the drilldown, where editing lives, so there is no badge,
 * no percent text, and no edit link. The bar fills over 300ms when the fraction
 * changes and snaps under reduce-motion. The bar turns loss when over; the
 * figure follows it, and the CLOSE state dims the bar only.
 */
@Composable
internal fun EditableBudgetCategoryRow(
    category: CategorySpend,
    selected: Boolean = false,
    transactionsContentDescription: String = "View ${category.name} transactions",
    onOpenTransactions: () -> Unit = {},
) {
    val tokens = LocalLedgerTheme.current
    val colors = tokens.colors
    val progress = budgetCategoryProgress(category.spentCents, category.budgetCents)
    val over = progress.health.status == BudgetHealthStatus.OVER
    val barColor = when (progress.health.status) {
        BudgetHealthStatus.ON_TRACK -> colors.gain
        BudgetHealthStatus.CLOSE -> colors.foregroundSecondary
        BudgetHealthStatus.OVER -> colors.loss
    }
    val fraction by animateFloatAsState(
        targetValue = progress.fillFraction,
        animationSpec = if (LocalLedgerEffects.current.animate) {
            tween(LedgerMotion.progressAndThemeMillis, easing = FastOutSlowInEasing)
        } else {
            snap()
        },
        label = "budget-category-fill",
    )
    Box(
        Modifier
            .fillMaxWidth()
            .clickable(
                onClickLabel = transactionsContentDescription,
                role = Role.Button,
                onClick = onOpenTransactions,
            )
            .semantics {
                contentDescription = transactionsContentDescription
                this.selected = selected
            }
            .drawBehind {
                if (selected) {
                    drawRect(colors.bitcoinSoft)
                    drawRect(colors.bitcoin, Offset.Zero, Size(2.dp.toPx(), size.height))
                }
            }
            .padding(start = VaultSpace.sm),
    ) {
        Column(
            Modifier
                .clearAndSetSemantics {
                    contentDescription = budgetProgressAccessibilityLabel(category, progress)
                    progressBarRangeInfo = ProgressBarRangeInfo(progress.fillFraction, 0f..1f)
                }
                .padding(vertical = tokens.density.categoryRowVerticalPadding),
            verticalArrangement = Arrangement.spacedBy(LedgerSpacing.small),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    category.name,
                    style = tokens.type.rowPrimary,
                    color = colors.foreground,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        "${Money.formatUsd(category.remainingCents)} left",
                        style = tokens.type.rowFigure,
                        color = if (over) colors.loss else colors.foreground,
                    )
                    Text("OF ${Money.formatUsd(category.budgetCents)} planned",
                        style = tokens.type.rowMeta, color = colors.foregroundTertiary)
                }
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(3.dp)
                    .background(colors.line),
            ) {
                Box(
                    Modifier
                        .fillMaxHeight()
                        .fillMaxWidth(fraction)
                        .background(barColor),
                )
            }
        }
    }
}

@Composable
internal fun BtcBuyEntryAction(onClick: () -> Unit, enabled: Boolean = true) {
    VaultButton(label = stringResource(R.string.btc_buy_add_action), onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth())
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BudgetCategoryEditorSheet(
    seed: BudgetCategoryEditorSeed,
    onDismiss: () -> Unit,
    onWriteSucceeded: () -> Unit,
) {
    val colors = LocalLedgerTheme.current.colors
    val application = LocalContext.current.applicationContext as? VaultApplication
    val mutationClient = remember(application) { application?.deviceMutationClient }
    if (WriteAccessBlockedSheet(seed.viewer, com.sats21m.vogelvault.data.DeviceCapability.BUDGET, onDismiss)) return
    if (seed.budget == null || seed.sourceFile == null || seed.budget.updatedAtMs <= 0L) {
        ModalBottomSheet(onDismissRequest = onDismiss) {
            Column(Modifier.padding(VaultSpace.md)) {
                Text("Refresh the budget before editing this category.")
                TextButton(onClick = onDismiss) { Text("Close") }
            }
        }
        return
    }
    var dollars by remember(seed) {
        mutableStateOf(Money.formatMinorUnits(seed.category.budgetCents, 2))
    }
    var message by remember(seed) { mutableStateOf<String?>(null) }
    var submitting by remember(seed) { mutableStateOf(false) }
    var confirmingDelete by remember(seed) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val haptics = rememberLedgerHaptics()

    LedgerSheet(
        title = stringResource(R.string.budget_category_editor_title, seed.category.name),
        onDismissRequest = { if (!submitting) onDismiss() },
        actions = {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                if (
                    seed.displayedMonth == seed.budgetDocumentMonth &&
                    seed.budget.updatedAtMs > 0L
                ) {
                    TextButton(
                        enabled = !submitting,
                        onClick = {
                            if (!confirmingDelete) {
                                confirmingDelete = true
                                message = "Tap delete again to remove ${seed.category.name} from the current budget."
                                return@TextButton
                            }
                            val app = application
                            if (app == null) {
                                message = "Category not deleted: the app write client is unavailable."
                                return@TextButton
                            }
                            submitting = true
                            scope.launch {
                                val result = app.budgetCategoryDeletionGateway.delete(
                                    activeProfile = seed.viewer,
                                    budget = seed.budget,
                                    sourceFile = seed.sourceFile,
                                    categoryName = seed.category.name,
                                    baseUpdatedAtMs = seed.budget.updatedAtMs,
                                )
                                submitting = false
                                val deleteFailure = when (result) {
                                    is BudgetCategoryDeleteResult.Rejected -> {
                                        confirmingDelete = false
                                        "Category not deleted: ${result.reason.name.lowercase().replace('_', ' ')}."
                                    }
                                    is BudgetCategoryDeleteResult.Submitted -> when (val submitted = result.result) {
                                        is ConvexResult.Ok -> null
                                        ConvexResult.Unauthorized -> "Category not deleted: this device is not authorized."
                                        ConvexResult.NotConfigured -> "Category not deleted: household sync is not connected."
                                        ConvexResult.Disabled -> "Category not deleted: authenticated writes are disabled."
                                        ConvexResult.Missing -> "Category not deleted: household sync returned no result."
                                        is ConvexResult.Failed -> "Category not deleted: ${submitted.reason}."
                                    }
                                }
                                if (deleteFailure == null) {
                                    haptics.confirm()
                                    onWriteSucceeded()
                                    onDismiss()
                                } else {
                                    message = deleteFailure
                                    haptics.reject()
                                }
                            }
                        },
                    ) {
                        Text(if (confirmingDelete) "Confirm delete" else "Delete category", color = colors.loss)
                    }
                }
                TextButton(onClick = onDismiss, enabled = !submitting) {
                    Text(stringResource(R.string.write_cancel))
                }
                VaultButton(
                    label = stringResource(R.string.write_save),
                    enabled = !submitting,
                    onClick = {
                        when (val draft = budgetCategoryWriteRequest(seed, dollars)) {
                            is WriteDraftResult.Invalid -> {
                                message = draft.reason
                                haptics.reject()
                            }
                            is WriteDraftResult.Valid -> {
                                val client = mutationClient
                                if (client == null) {
                                    message = "Budget not saved: the app write client is unavailable."
                                    haptics.reject()
                                    return@VaultButton
                                }
                                submitting = true
                                scope.launch {
                                    val request = draft.request
                                    val result =
                                        client.mutate(
                                            ConvexMutation.UpsertBudgetCategoryFromDevice(
                                                baseUpdatedAtMs = requireNotNull(seed.budget).updatedAtMs,
                                                sourceFile = requireNotNull(seed.sourceFile),
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
                                    val budgetFailure = convexWriteFailureMessage("Budget not saved", result)
                                    if (budgetFailure == null) {
                                        haptics.confirm()
                                        onWriteSucceeded()
                                        onDismiss()
                                    } else {
                                        message = budgetFailure
                                        haptics.reject()
                                    }
                                }
                            }
                        }
                    },
                )
            }
        },
    ) {
        Text(stringResource(R.string.budget_category_editor_month, seed.budgetDocumentMonth))
        LedgerTextField(
            value = dollars,
            onValueChange = { dollars = it },
            label = stringResource(R.string.budget_category_amount_label),
            prefix = "$",
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        message?.let { Text(it) }
    }
}

/**
 * Starts the durable part of a Bitcoin buy on a process-owned scope and owns
 * the draft-id lifecycle for it.
 *
 * The id rotates ONLY on a confirmed acceptance, and before the caller's
 * refresh/dismiss runs: a rejected or ambiguous buy keeps the id so the retry
 * supersedes the same row instead of crediting River twice, while a confirmed
 * buy releases it so the NEXT legitimate buy gets a fresh id rather than
 * colliding with the previous one forever.
 *
 * The sheet calls exactly this function, so its regressions exercise the
 * shipped lifecycle rather than a parallel copy.
 */
internal fun launchBtcBuySave(
    scope: CoroutineScope,
    request: BtcBuyWriteRequest,
    client: ConvexDeviceMutationClient,
    buyDraftIds: TransactionDraftIdStore,
    onResult: (BtcBuySaveOutcome) -> Unit,
): Job = scope.launch {
    // One expression feeds both the wire and the lease so acquisition,
    // acceptance, and release can never disagree about the server scope.
    val sourceFile = request.owner.btcBuysDataFileName
    val leaseScope = btcBuyDraftIdScope(BtcBuyWriteSurface.STANDALONE, request.owner)
    val result = client.mutate(
        ConvexMutation.UpsertBtcBuyFromDevice(
            owner = request.owner.ledgerOwner,
            buy = BtcBuyInput(
                id = request.id,
                date = request.date,
                source = request.source,
                sats = request.sats,
                priceUsdCents = request.priceUsdCents,
                usdCents = request.usdCents,
                feeUsdCents = request.feeUsdCents,
                owner = request.owner.ledgerOwner,
            ),
            sourceFile = sourceFile,
        ),
    )
    val leaseReset =
        result !is ConvexResult.Ok || buyDraftIds.rotateAfterAcceptance(leaseScope, request.id)
    onResult(btcBuySaveOutcome(result, leaseReset))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BtcBuyEntrySheet(
    owner: FamilyMember,
    onDismiss: () -> Unit,
    onWriteSucceeded: () -> Unit,
    quoteCents: Long = 0,
) {
    val application = LocalContext.current.applicationContext as? VaultApplication
    val mutationClient = remember(application) { application?.deviceMutationClient }
    if (WriteAccessBlockedSheet(owner, com.sats21m.vogelvault.data.DeviceCapability.BITCOIN, onDismiss)) return
    val buyDraftIds = application?.btcBuyDraftIds
    // Process-owned, exactly like the transaction sheet: dismissing this sheet
    // mid-write and reopening must resubmit the SAME id, or a committed buy
    // whose response was lost is credited to River a second time. Leases are
    // scoped to this owner and surface so another pending operation cannot
    // leak into this sheet's write.
    val buyScope = btcBuyDraftIdScope(BtcBuyWriteSurface.STANDALONE, owner)
    val buyId = remember(buyScope) {
        buyDraftIds?.currentId(buyScope) ?: "android-${UUID.randomUUID()}"
    }
    val saveScope = remember(application) { application?.applicationScope }
    var date by remember { mutableStateOf(ledgerToday().toString()) }
    var source by remember { mutableStateOf("") }
    var sats by remember { mutableStateOf("") }
    var priceUsd by remember { mutableStateOf("") }
    var purchaseUsd by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var submitting by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val haptics = rememberLedgerHaptics()

    var writeAccepted by remember { mutableStateOf(false) }
    val retrySave: () -> Unit = retrySave@ {
        if (submitting) return@retrySave
        val derived = deriveBitcoinBuy(sats, priceUsd, purchaseUsd, quoteCents).getOrElse {
            message = it.message ?: "Check the buy amounts"
            return@retrySave
        }
        when (
            val draft =
                btcBuyWriteRequest(
                    owner,
                    buyId,
                    date,
                    source,
                    derived.sats,
                    derived.priceUsd,
                    derived.purchaseUsd,
                )
        ) {
            is WriteDraftResult.Invalid -> message = draft.reason
            is WriteDraftResult.Valid -> {
                val client = mutationClient
                if (client == null) {
                    message = "Bitcoin buy not saved: the app write client is unavailable."
                    return@retrySave
                }
                val writeScope = saveScope
                val draftIds = buyDraftIds
                if (writeScope == null || draftIds == null) {
                    message = "Bitcoin buy not saved: the app write client is unavailable."
                    return@retrySave
                }
                submitting = true
                // The application scope owns the request so a
                // dismissal cannot cancel a write the server
                // may already have committed.
                launchBtcBuySave(
                    scope = writeScope,
                    request = draft.request,
                    client = client,
                    buyDraftIds = draftIds,
                ) { outcome ->
                    submitting = false
                    writeAccepted = outcome !is BtcBuySaveOutcome.Rejected
                    when (outcome) {
                        BtcBuySaveOutcome.Accepted -> {
                            haptics.confirm()
                            onWriteSucceeded()
                            onDismiss()
                        }
                        BtcBuySaveOutcome.AcceptedLeaseResetFailed ->
                            message = acceptedBtcBuyLeaseResetFailure
                        is BtcBuySaveOutcome.Rejected -> {
                            check(outcome.result !is ConvexResult.Ok) {
                                "Accepted result cannot be rejected"
                            }
                            haptics.reject()
                            message = convexWriteFailureMessage(
                                "Bitcoin buy not saved",
                                outcome.result,
                            )
                        }
                    }
                }
            }
        }
    }

    LedgerSheet(
        title = stringResource(R.string.btc_buy_editor_title),
        onDismissRequest = { if (!submitting) onDismiss() },
        actions = {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss, enabled = !submitting) {
                    Text(stringResource(R.string.write_cancel))
                }
                VaultButton(
                    label = stringResource(R.string.write_save),
                    enabled = !submitting,
                    onClick = retrySave,
                )
            }
        },
    ) {
        LedgerDateField(date, { date = it }, stringResource(R.string.btc_buy_date_label), enabled = !submitting)
        EditorField(source, { source = it }, R.string.btc_buy_source_label)
        EditorField(sats, { sats = it }, R.string.btc_buy_sats_label, KeyboardType.Number)
        EditorField(priceUsd, { priceUsd = it }, R.string.btc_buy_price_label, KeyboardType.Decimal)
        EditorField(
            purchaseUsd,
            { purchaseUsd = it },
            R.string.btc_buy_purchase_amount_label,
            KeyboardType.Decimal,
        )
        Text("Enter any two of sats, price and dollars. Leave the third blank to calculate it.")
        if (quoteCents > 0) Text("Live price: ${Money.formatUsd(quoteCents)}. Enter a price to override it.")
        deriveBitcoinBuy(sats, priceUsd, purchaseUsd, quoteCents).getOrNull()?.let { result ->
            Text("${result.sats} sats · $${result.priceUsd} per BTC · $${result.purchaseUsd}")
        }
        com.sats21m.vogelvault.ui.components.WriteRefusalLine(
            message, retry = retrySave, enabled = !submitting, accepted = writeAccepted,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BtcBuyFromIncomeEntrySheet(
    viewer: FamilyMember,
    income: IncomeEntry,
    onDismiss: () -> Unit,
    onWriteSucceeded: () -> Unit,
    quoteCents: Long = 0,
) {
    val colors = LocalLedgerTheme.current.colors
    val application = LocalContext.current.applicationContext as? VaultApplication
    if (WriteAccessBlockedSheet(viewer, com.sats21m.vogelvault.data.DeviceCapability.BITCOIN, onDismiss)) return
    if (WriteAccessBlockedSheet(viewer, com.sats21m.vogelvault.data.DeviceCapability.TRANSACTIONS, onDismiss)) return
    val gateway = remember(application) { application?.btcBuyIncomeMutationGateway }
    val draftIds = application?.btcBuyDraftIds
    val writeScope = application?.applicationScope
    var source by rememberSaveable(income.id) { mutableStateOf("") }
    var sats by rememberSaveable(income.id) { mutableStateOf("") }
    var priceUsd by rememberSaveable(income.id) { mutableStateOf("") }
    var buyNote by rememberSaveable(income.id) { mutableStateOf("") }
    var message by rememberSaveable(income.id) { mutableStateOf<String?>(null) }
    var submitting by remember(income.id) { mutableStateOf(false) }
    val haptics = rememberLedgerHaptics()
    val purchaseUsd = java.math.BigDecimal(income.amountCents).movePointLeft(2).toPlainString()

    var writeAccepted by remember { mutableStateOf(false) }
    val retrySave: () -> Unit = retrySave@ {
        if (submitting) return@retrySave
        val derived = deriveBitcoinBuy(sats, priceUsd, purchaseUsd, quoteCents).getOrElse {
            message = it.message ?: "Check the buy amounts"
            return@retrySave
        }
        when (
            val draft = btcBuyFromIncomeWriteRequest(
                viewer = viewer,
                id = income.id,
                income = income,
                source = source,
                sats = derived.sats,
                priceUsd = derived.priceUsd,
                buyNote = buyNote,
            )
        ) {
            is WriteDraftResult.Invalid -> message = draft.reason
            is WriteDraftResult.Valid -> {
                val writeGateway = gateway
                val processDraftIds = draftIds
                val processScope = writeScope
                if (writeGateway == null || processDraftIds == null || processScope == null) {
                    message = "Income and Bitcoin buy not saved: the app write client is unavailable."
                    return@retrySave
                }
                submitting = true
                launchBtcBuyFromIncomeSave(
                    scope = processScope,
                    request = draft.request,
                    gateway = writeGateway,
                    buyDraftIds = processDraftIds,
                ) { outcome ->
                    submitting = false
                    writeAccepted = outcome !is BtcBuySaveOutcome.Rejected
                    when (outcome) {
                        BtcBuySaveOutcome.Accepted -> {
                            haptics.confirm()
                            onWriteSucceeded()
                            onDismiss()
                        }
                        BtcBuySaveOutcome.AcceptedLeaseResetFailed ->
                            message = acceptedBtcBuyLeaseResetFailure
                        is BtcBuySaveOutcome.Rejected -> {
                            check(outcome.result !is ConvexResult.Ok) {
                                "Accepted result cannot be rejected"
                            }
                            haptics.reject()
                            message = convexWriteFailureMessage(
                                "Income and Bitcoin buy not saved",
                                outcome.result,
                            )
                        }
                    }
                }
            }
        }
    }

    LedgerSheet(
        title = stringResource(R.string.budget_income_add_as_bitcoin_buy),
        onDismissRequest = { if (!submitting) onDismiss() },
        actions = {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss, enabled = !submitting) {
                    Text(stringResource(R.string.write_cancel))
                }
                VaultButton(
                    label = stringResource(R.string.write_save),
                    enabled = !submitting,
                    onClick = retrySave,
                )
            }
        },
    ) {
        Text(
            "${income.sourceName} income: ${Money.formatUsd(income.amountCents)}",
            color = colors.foregroundSecondary,
        )
        Text(stringResource(R.string.budget_income_add_as_bitcoin_buy_detail))
        EditorField(source, { source = it }, R.string.btc_buy_source_label)
        EditorField(sats, { sats = it }, R.string.btc_buy_sats_label, KeyboardType.Number)
        EditorField(priceUsd, { priceUsd = it }, R.string.btc_buy_price_label, KeyboardType.Decimal)
        Text("Income supplies the dollars. Enter sats or price to calculate the other.")
        if (quoteCents > 0) Text("Live price: ${Money.formatUsd(quoteCents)}. Enter a price to override it.")
        deriveBitcoinBuy(sats, priceUsd, purchaseUsd, quoteCents).getOrNull()?.let { result ->
            Text("${result.sats} sats · $${result.priceUsd} per BTC · $${result.purchaseUsd}")
        }
        EditorField(buyNote, { buyNote = it }, R.string.transaction_note)
        com.sats21m.vogelvault.ui.components.WriteRefusalLine(message, retrySave, !submitting, writeAccepted)
    }
}

private const val acceptedBtcBuyLeaseResetFailure =
    "Household sync accepted this Bitcoin buy, but this device could not retire its draft id. " +
        "Do not submit another buy until local storage is repaired."

@Composable
private fun EditorField(
    value: String,
    onValueChange: (String) -> Unit,
    labelRes: Int,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    LedgerTextField(
        value = value,
        onValueChange = onValueChange,
        label = stringResource(labelRes),
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}
