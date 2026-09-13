package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.BudgetPlanCarryResult
import com.sats21m.vogelvault.data.convexWriteFailureMessage
import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.validateBudgetPlanCarry
import com.sats21m.vogelvault.ui.components.HorizontalHairline
import com.sats21m.vogelvault.ui.components.StatusBanner
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.rememberLedgerHaptics
import kotlinx.coroutines.launch

/**
 * "Copy August plan to September."
 *
 * Shown only when the live plan lags the month the screen is scoped to or the
 * trusted current month, decided by the shared carry contract. One tap arms
 * the action, a second tap commits it; the ledger button is the only control.
 * Success hands the target month back so the screen can scope to it and
 * reload the plan; failure stays on screen in the standard banner.
 */
@Composable
internal fun BudgetPlanCarryAction(
    activeProfile: FamilyMember,
    budget: Budget,
    selectedMonth: String?,
    onCopied: (String) -> Unit,
    unavailableReason: String? = null,
) {
    val application = LocalContext.current.applicationContext as? VaultApplication ?: return
    val gateway = remember(application) { application.budgetPlanCarryGateway }
    // Keyed on the trusted month as well, so a recomposition after midnight
    // re-decides rather than serving the intent computed for yesterday.
    val currentMonth = gateway.currentMonth()
    val intent = remember(activeProfile, budget, selectedMonth, currentMonth) {
        validateBudgetPlanCarry(
            activeProfile = activeProfile,
            currentMonth = currentMonth,
            selectedMonth = selectedMonth,
            budget = budget,
            baseUpdatedAtMs = budget.updatedAtMs,
        ).intent
    } ?: return

    val tokens = LocalLedgerTheme.current
    val haptics = rememberLedgerHaptics()
    val scope = rememberCoroutineScope()
    var confirming by remember(intent) { mutableStateOf(false) }
    var submitting by remember(intent) { mutableStateOf(false) }
    var failure by remember(intent) { mutableStateOf<String?>(null) }
    val fromName = budgetMonthName(intent.fromMonth)
    val toName = budgetMonthName(intent.toMonth)
    val failedPrefix = stringResource(R.string.budget_plan_copy_failed)

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(VaultSpace.sm)) {
        Text(
            stringResource(R.string.budget_plan_copy_label).uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = tokens.colors.foregroundTertiary,
        )
        HorizontalHairline()
        Text(
            stringResource(R.string.budget_plan_copy_title, toName),
            style = tokens.type.rowPrimary,
            color = tokens.colors.foreground,
        )
        Text(
            stringResource(
                R.string.budget_plan_copy_detail,
                fromName,
                budget.categories.size,
                budget.plannedCents?.let { Money.formatUsd(it) } ?: Money.PRICE_UNAVAILABLE,
            ),
            style = tokens.type.body,
            color = tokens.colors.foregroundSecondary,
        )
        unavailableReason?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        Row(horizontalArrangement = Arrangement.spacedBy(VaultSpace.sm)) {
            VaultButton(
                label = if (confirming) {
                    stringResource(R.string.budget_plan_copy_confirm, toName)
                } else {
                    stringResource(R.string.budget_plan_copy_action, fromName, toName)
                },
                enabled = !submitting && unavailableReason == null,
                onClick = {
                    if (!confirming) {
                        confirming = true
                        failure = null
                        return@VaultButton
                    }
                    submitting = true
                    scope.launch {
                        val result = gateway.copyForward(activeProfile, budget, selectedMonth)
                        submitting = false
                        val message = when (result) {
                            is BudgetPlanCarryResult.Rejected ->
                                "$failedPrefix: ${result.reason.name.lowercase().replace('_', ' ')}."
                            is BudgetPlanCarryResult.Submitted ->
                                convexWriteFailureMessage(failedPrefix, result.result)
                        }
                        if (message == null) {
                            haptics.confirm()
                            confirming = false
                            onCopied((result as BudgetPlanCarryResult.Submitted).toMonth)
                        } else {
                            failure = message
                            haptics.reject()
                        }
                    }
                },
            )
            if (confirming) {
                VaultButton(
                    label = stringResource(R.string.budget_plan_copy_cancel, fromName),
                    enabled = !submitting,
                    secondary = true,
                    onClick = {
                        confirming = false
                        failure = null
                    },
                )
            }
        }
        failure?.let { StatusBanner(it, tone = tokens.colors.loss) }
        HorizontalHairline()
    }
}

private val FULL_MONTH_NAMES = listOf(
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)

/**
 * `2026-09` becomes `September`. A fixed table rather than a date formatter
 * so the label matches on device and in the design packet; an unexpected key
 * falls through to itself.
 */
internal fun budgetMonthName(month: String): String {
    val index = month.split("-").getOrNull(1)?.toIntOrNull() ?: return month
    return FULL_MONTH_NAMES.getOrNull(index - 1) ?: month
}
