package com.sats21m.vogelvault.notifications

import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.domain.budgetTransactionsFor
import com.sats21m.vogelvault.domain.deriveBudgetSpend
import com.sats21m.vogelvault.ui.VaultUiState
import java.math.BigInteger

enum class BudgetAlertLevel {
    NEARING_LIMIT,
    OVER_LIMIT,
}

data class BudgetAlert(
    val owner: FamilyMember,
    val month: String,
    val category: String,
    val level: BudgetAlertLevel,
    val spentCents: Long,
    val budgetCents: Long,
) {
    /**
     * Length-prefixed fields make categories containing separators unambiguous.
     * The canonical budget owner deliberately scopes both adult profiles to the
     * same household alert.
     */
    val deduplicationKey: String
        get() =
            "${owner.key.length}:${owner.key}|" +
                "${month.length}:$month|" +
                "${category.length}:$category|" +
                level.name
}

/**
 * Produces alerts only from figures the active profile's Budget screen may show.
 *
 * Budget actuals are re-derived from the same owner- and month-scoped
 * transactions as the screen. Reported category `spentCents` values are never
 * trusted here.
 */
class BudgetNotificationEvaluator {
    fun evaluate(state: VaultUiState): List<BudgetAlert> {
        if (state.staleAuthorization) return emptyList()
        if (!state.data.budget.status.canNotify || !state.data.transactions.status.canNotify) {
            return emptyList()
        }

        val viewer = state.activeProfile
        val budget = state.data.budget.value ?: return emptyList()
        if (!viewer.sharesNetWorth(with = budget.owner)) return emptyList()

        if (budget.categories.groupingBy { it.name }.eachCount().any { it.value > 1 }) {
            return emptyList()
        }
        val transactions = state.data.transactions.value.budgetTransactionsFor(viewer)
        if (!transactions.haveSafeCategoryTotals()) return emptyList()

        val spend =
            deriveBudgetSpend(
                budget = budget,
                transactions = transactions,
            ) ?: return emptyList()

        return spend.categories
            .mapNotNull { category ->
                val level = alertLevel(category.spentCents, category.budgetCents) ?: return@mapNotNull null
                BudgetAlert(
                    owner = budget.owner,
                    month = budget.month,
                    category = category.name,
                    level = level,
                    spentCents = category.spentCents,
                    budgetCents = category.budgetCents,
                )
            }
            .distinctBy(BudgetAlert::deduplicationKey)
    }

    private fun alertLevel(spentCents: Long, budgetCents: Long): BudgetAlertLevel? {
        if (budgetCents <= 0L || spentCents <= 0L) return null

        val spent = BigInteger.valueOf(spentCents)
        val budget = BigInteger.valueOf(budgetCents)
        return when {
            spent > budget -> BudgetAlertLevel.OVER_LIMIT
            spent * ONE_HUNDRED > budget * EIGHTY_FIVE -> BudgetAlertLevel.NEARING_LIMIT
            else -> null
        }
    }

    private fun List<Transaction>.haveSafeCategoryTotals(): Boolean {
        val totals = mutableMapOf<String, Long>()
        return try {
            for (transaction in this) {
                totals[transaction.category] =
                    Math.addExact(totals[transaction.category] ?: 0L, transaction.spendAmount)
            }
            true
        } catch (_: ArithmeticException) {
            false
        }
    }

    private val Freshness.canNotify: Boolean
        get() = this == Freshness.LIVE || this == Freshness.STALE

    private companion object {
        val EIGHTY_FIVE: BigInteger = BigInteger.valueOf(85L)
        val ONE_HUNDRED: BigInteger = BigInteger.valueOf(100L)
    }
}

interface BudgetAlertDeduplicator {
    fun wasSent(key: String): Boolean

    fun markSent(key: String)
}

interface BudgetAlertPublisher {
    fun canPublish(): Boolean

    fun publish(alert: BudgetAlert)
}

class BudgetNotificationDispatcher(
    private val evaluator: BudgetNotificationEvaluator,
    private val deduplicator: BudgetAlertDeduplicator,
    private val publisher: BudgetAlertPublisher,
) {
    fun dispatch(state: VaultUiState, enabled: Boolean) {
        if (!enabled || !publisher.canPublish()) return

        evaluator.evaluate(state).forEach { alert ->
            if (!deduplicator.wasSent(alert.deduplicationKey)) {
                publisher.publish(alert)
                deduplicator.markSent(alert.deduplicationKey)
            }
        }
    }
}
