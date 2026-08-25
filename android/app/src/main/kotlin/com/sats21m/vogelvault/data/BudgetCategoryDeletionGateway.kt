package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.CategoryDeleteRejection
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.validateCurrentMonthCategoryDelete

/**
 * Local guard in front of the server's current-month category deletion.
 *
 * The injected month comes from application authority, not an editable field.
 * Convex repeats the clock, identity, folded-name, and revision checks before it
 * mutates the canonical budget document.
 */
internal class BudgetCategoryDeletionGateway(
    private val client: ConvexDeviceMutationClient,
    private val trustedCurrentMonth: () -> String,
) {
    suspend fun delete(
        activeProfile: FamilyMember,
        budget: Budget,
        sourceFile: String,
        categoryName: String,
        baseUpdatedAtMs: Long,
    ): BudgetCategoryDeleteResult {
        val currentMonth = trustedCurrentMonth()
        val eligibility = validateCurrentMonthCategoryDelete(
            activeProfile = activeProfile,
            currentMonth = currentMonth,
            budget = budget,
            sourceFile = sourceFile,
            categoryName = categoryName,
            baseUpdatedAtMs = baseUpdatedAtMs,
        )
        val intent = eligibility.intent
            ?: return BudgetCategoryDeleteResult.Rejected(requireNotNull(eligibility.rejection))
        val result = client.mutate(
            ConvexMutation.DeleteBudgetCategoryFromDevice(
                owner = intent.owner,
                sourceFile = intent.sourceFile,
                month = intent.month,
                entityId = intent.categoryName,
                baseUpdatedAtMs = intent.baseUpdatedAtMs,
                trustedCurrentMonth = currentMonth,
            ),
        )
        return BudgetCategoryDeleteResult.Submitted(result)
    }
}

internal sealed interface BudgetCategoryDeleteResult {
    data class Rejected(val reason: CategoryDeleteRejection) : BudgetCategoryDeleteResult
    data class Submitted(val result: ConvexResult<ConvexValue>) : BudgetCategoryDeleteResult
}
