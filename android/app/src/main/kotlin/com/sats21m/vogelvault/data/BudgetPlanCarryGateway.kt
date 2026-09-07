package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.BudgetPlanCarryEligibility
import com.sats21m.vogelvault.domain.BudgetPlanCarryRejection
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.validateBudgetPlanCarry

/**
 * Local guard in front of the server's budget plan carry-forward.
 *
 * The month the plan is compared against comes from application authority,
 * not from the Budget picker. Convex repeats the identity, month-gap, and
 * revision checks before it advances the canonical budget document.
 *
 * Transport is the household sync-token client: Android bootstrap credentials
 * only carry `todos:write`, while this write needs the same admin surface as
 * [ConvexMutation.UpsertBudgetCategory].
 */
internal class BudgetPlanCarryGateway(
    private val client: ConvexMutationClient,
    private val trustedCurrentMonth: () -> String,
) {
    fun currentMonth(): String = trustedCurrentMonth()

    /** Pure decision the screen uses to show or hide the action. */
    fun eligibility(
        activeProfile: FamilyMember,
        budget: Budget,
        selectedMonth: String?,
    ): BudgetPlanCarryEligibility = validateBudgetPlanCarry(
        activeProfile = activeProfile,
        currentMonth = trustedCurrentMonth(),
        selectedMonth = selectedMonth,
        budget = budget,
        baseUpdatedAtMs = budget.updatedAtMs,
    )

    suspend fun copyForward(
        activeProfile: FamilyMember,
        budget: Budget,
        selectedMonth: String?,
    ): BudgetPlanCarryResult {
        val intent = eligibility(activeProfile, budget, selectedMonth).let {
            it.intent ?: return BudgetPlanCarryResult.Rejected(requireNotNull(it.rejection))
        }
        val result = client.mutate(
            ConvexMutation.CopyBudgetPlanForward(
                owner = intent.owner,
                sourceFile = intent.sourceFile,
                fromMonth = intent.fromMonth,
                toMonth = intent.toMonth,
                baseUpdatedAtMs = intent.baseUpdatedAtMs,
            ),
        )
        return BudgetPlanCarryResult.Submitted(intent.toMonth, result)
    }
}

internal sealed interface BudgetPlanCarryResult {
    data class Rejected(val reason: BudgetPlanCarryRejection) : BudgetPlanCarryResult
    data class Submitted(val toMonth: String, val result: ConvexResult<ConvexValue>) : BudgetPlanCarryResult
}
