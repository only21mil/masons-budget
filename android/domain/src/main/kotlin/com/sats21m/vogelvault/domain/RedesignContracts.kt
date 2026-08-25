package com.sats21m.vogelvault.domain

import java.time.DateTimeException
import java.time.LocalDate
import java.time.YearMonth
import java.util.Locale

/** Todo representations stay outside the adult-wide financial [Owned] contract. */
interface ProfileScopedTodo {
    val owner: FamilyMember
}

/** Todos are private records, even though adults retain wide financial visibility. */
fun ProfileScopedTodo.isAccessibleTo(activeProfile: FamilyMember): Boolean = owner == activeProfile

/** Exact-owner todo projection. Never use [visibleTo] for a todo list. */
fun <T : ProfileScopedTodo> List<T>.todosFor(activeProfile: FamilyMember): List<T> =
    filter { it.isAccessibleTo(activeProfile) }

data class MoneyOutToday(
    val date: String,
    val owner: FamilyMember,
    val totalCents: Long,
    val sourceIds: List<String>,
)

/**
 * Derive Money Out Today for an injected ISO calendar day.
 *
 * Adults read all adult-household rows. Children read only their own rows. The
 * result is not stored and every addition is checked.
 */
fun deriveMoneyOutTodayCents(
    activeProfile: FamilyMember,
    day: String,
    transactions: List<Transaction>,
    billPays: List<BtcBillPay>,
): Long = deriveMoneyOutToday(activeProfile, day, transactions, billPays).totalCents

fun deriveMoneyOutToday(
    activeProfile: FamilyMember,
    day: String,
    transactions: List<Transaction>,
    billPays: List<BtcBillPay>,
): MoneyOutToday {
    require(day.isCanonicalIsoDay()) { "Money Out Today day must be ISO yyyy-MM-dd: $day" }
    var total = 0L
    val sourceIds = mutableListOf<String>()

    for (transaction in transactions) {
        if (
            activeProfile.ledgerOwner == transaction.owner.ledgerOwner &&
            transaction.date == day &&
            transaction.category != "Income"
        ) {
            total = Math.addExact(total, transaction.spendAmount)
            sourceIds += transaction.id
        }
    }

    for (billPay in billPays) {
        if (
            activeProfile.ledgerOwner == billPay.owner.ledgerOwner &&
            billPay.date == day &&
            billPay.budgetEffect != BillPayBudgetEffect.CREDIT_CARD_PAYMENT
        ) {
            total = Math.addExact(total, billPay.amountUsdCents)
            total = Math.addExact(total, billPay.feeUsdCents)
            sourceIds += billPay.id
        }
    }

    return MoneyOutToday(
        date = day,
        owner = activeProfile.ledgerOwner,
        totalCents = total,
        sourceIds = sourceIds,
    )
}

data class CurrentMonthCategoryDeleteIntent(
    val owner: FamilyMember,
    val sourceFile: String,
    val month: String,
    val categoryName: String,
    val baseUpdatedAtMs: Long,
)

enum class CategoryDeleteRejection {
    INVALID_CURRENT_MONTH,
    UNSUPPORTED_PROFILE,
    OWNER_MISMATCH,
    MONTH_MISMATCH,
    SOURCE_MISMATCH,
    INVALID_CATEGORY,
    MISSING_CATEGORY,
    AMBIGUOUS_CATEGORY,
    INVALID_REVISION,
    REVISION_MISMATCH,
}

data class CategoryDeleteEligibility(
    val intent: CurrentMonthCategoryDeleteIntent? = null,
    val rejection: CategoryDeleteRejection?,
) {
    val eligible: Boolean get() = rejection == null
}

/**
 * Validate a current-month category delete without creating a mutation.
 *
 * [budgetUpdatedAtMs] is the exact remote document revision. The intent must
 * repeat it so a stale screen cannot delete from a newer budget document.
 */
fun validateCurrentMonthCategoryDelete(
    activeProfile: FamilyMember,
    currentMonth: String,
    budget: Budget,
    sourceFile: String,
    categoryName: String,
    baseUpdatedAtMs: Long,
): CategoryDeleteEligibility {
    if (!currentMonth.isCanonicalIsoMonth()) {
        return CategoryDeleteEligibility(rejection = CategoryDeleteRejection.INVALID_CURRENT_MONTH)
    }

    val canonicalSource = when {
        activeProfile.isAdult -> "budget"
        activeProfile == FamilyMember.MASON -> "mason-budget"
        else -> return CategoryDeleteEligibility(rejection = CategoryDeleteRejection.UNSUPPORTED_PROFILE)
    }
    val canonicalOwner = activeProfile.ledgerOwner

    if (budget.owner.ledgerOwner != canonicalOwner) {
        return CategoryDeleteEligibility(rejection = CategoryDeleteRejection.OWNER_MISMATCH)
    }
    if (budget.month != currentMonth) {
        return CategoryDeleteEligibility(rejection = CategoryDeleteRejection.MONTH_MISMATCH)
    }
    if (sourceFile != canonicalSource) {
        return CategoryDeleteEligibility(rejection = CategoryDeleteRejection.SOURCE_MISMATCH)
    }
    if (categoryName.isEmpty() || categoryName.trim() != categoryName) {
        return CategoryDeleteEligibility(rejection = CategoryDeleteRejection.INVALID_CATEGORY)
    }
    val foldedName = categoryName.foldedCategoryName()
    val matches = budget.categories.filter { it.name.foldedCategoryName() == foldedName }
    if (matches.size > 1) {
        return CategoryDeleteEligibility(rejection = CategoryDeleteRejection.AMBIGUOUS_CATEGORY)
    }
    val canonicalCategoryName = matches.singleOrNull()?.name
        ?: return CategoryDeleteEligibility(rejection = CategoryDeleteRejection.MISSING_CATEGORY)
    if (baseUpdatedAtMs <= 0L || baseUpdatedAtMs > MAX_SAFE_INTEGER) {
        return CategoryDeleteEligibility(rejection = CategoryDeleteRejection.INVALID_REVISION)
    }
    if (baseUpdatedAtMs != budget.updatedAtMs) {
        return CategoryDeleteEligibility(rejection = CategoryDeleteRejection.REVISION_MISMATCH)
    }
    return CategoryDeleteEligibility(
        intent = CurrentMonthCategoryDeleteIntent(
            owner = canonicalOwner,
            sourceFile = canonicalSource,
            month = currentMonth,
            categoryName = canonicalCategoryName,
            baseUpdatedAtMs = baseUpdatedAtMs,
        ),
        rejection = null,
    )
}

private fun String.foldedCategoryName(): String = trim().lowercase(Locale.US)

private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

private fun String.isCanonicalIsoDay(): Boolean {
    if (!matches(Regex("""\d{4}-\d{2}-\d{2}"""))) return false
    return try {
        val parsed = LocalDate.parse(this)
        parsed.year > 0 && parsed.toString() == this
    } catch (_: DateTimeException) {
        false
    }
}

private fun String.isCanonicalIsoMonth(): Boolean {
    if (!matches(Regex("""\d{4}-\d{2}"""))) return false
    return try {
        val parsed = YearMonth.parse(this)
        parsed.year > 0 && parsed.toString() == this
    } catch (_: DateTimeException) {
        false
    }
}
