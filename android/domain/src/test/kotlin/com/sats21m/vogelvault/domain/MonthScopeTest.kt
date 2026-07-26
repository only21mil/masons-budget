package com.sats21m.vogelvault.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * A budget is for one month. Its spend must come from that month's transactions
 * and no others — "July should only show July transactions, June should only
 * show June" (Victor, 2026-07-26).
 *
 * Mirrors shared/domain/test/month.test.ts so Android and Linux cannot drift.
 */
class MonthScopeTest {

    private fun tx(date: String, category: String, amount: String, owner: FamilyMember = FamilyMember.VICTOR) =
        Transaction(
            id = date + category,
            date = date,
            merchant = "Sample",
            amount = Money.parseCents(amount),
            category = category,
            owner = owner,
        )

    private fun budget(month: String, categories: List<Pair<String, String>>) = Budget(
        month = month,
        categories = categories.map { (name, planned) ->
            // Reported spend is deliberately absurd. Nothing should read it.
            BudgetCategory(name, Money.parseCents(planned), Money.parseCents("99999"))
        },
        owner = FamilyMember.VICTOR,
    )

    private val mixed = listOf(
        tx("2026-07-26", "Groceries", "-100"),
        tx("2026-07-02", "Groceries", "-50"),
        tx("2026-06-30", "Groceries", "-999"),
        tx("2026-06-01", "Dining", "-40"),
        tx("2026-05-15", "Groceries", "-777"),
        tx("2026-08-01", "Groceries", "-888"),
    )

    @Test
    fun `monthOf takes the yyyy-MM prefix`() {
        assertEquals("2026-07", monthOf("2026-07-26"))
        assertEquals("2025-12", monthOf("2025-12-31"))
    }

    @Test
    fun `month boundaries do not shift with timezone`() {
        // String slicing rather than date arithmetic, precisely so a transaction
        // dated the 1st belongs to that month for every reader.
        assertEquals("2026-07", monthOf("2026-07-01"))
        assertEquals("2026-07", monthOf("2026-07-31"))
        assertEquals("2026-08", monthOf("2026-08-01"))
    }

    @Test
    fun `inMonth keeps only that month`() {
        assertEquals(listOf("2026-07-26", "2026-07-02"), mixed.inMonth("2026-07").map { it.date })
        assertEquals(listOf("2026-06-30", "2026-06-01"), mixed.inMonth("2026-06").map { it.date })
    }

    @Test
    fun `adjacent months do not bleed across the boundary`() {
        val july = mixed.inMonth("2026-07").map { it.date }
        assertFalse(july.contains("2026-06-30"), "June 30 leaked into July")
        assertFalse(july.contains("2026-08-01"), "August 1 leaked into July")
    }

    @Test
    fun `a month with no transactions yields nothing, not everything`() {
        assertTrue(mixed.inMonth("2026-03").isEmpty())
        assertTrue(emptyList<Transaction>().inMonth("2026-07").isEmpty())
    }

    @Test
    fun `monthsPresent lists distinct months newest first`() {
        assertEquals(listOf("2026-08", "2026-07", "2026-06", "2026-05"), mixed.monthsPresent())
    }

    @Test
    fun `July's budget counts only July's transactions`() {
        val result = deriveBudgetSpend(
            budget("2026-07", listOf("Groceries" to "900", "Dining" to "250")),
            mixed,
        )
        assertEquals(Money.parseCents("150"), result.categories.first { it.name == "Groceries" }.spentCents)
        assertEquals(0L, result.categories.first { it.name == "Dining" }.spentCents)
        assertEquals(Money.parseCents("150"), result.actualCents)
    }

    @Test
    fun `June's budget counts only June's transactions`() {
        val result = deriveBudgetSpend(
            budget("2026-06", listOf("Groceries" to "900", "Dining" to "250")),
            mixed,
        )
        assertEquals(Money.parseCents("999"), result.categories.first { it.name == "Groceries" }.spentCents)
        assertEquals(Money.parseCents("40"), result.categories.first { it.name == "Dining" }.spentCents)
        assertEquals(Money.parseCents("1039"), result.actualCents)
    }

    @Test
    fun `the same transactions give different answers for different months`() {
        // The regression this file exists for.
        val july = deriveBudgetSpend(budget("2026-07", listOf("Groceries" to "900")), mixed)
        val june = deriveBudgetSpend(budget("2026-06", listOf("Groceries" to "900")), mixed)
        assertNotEquals(july.actualCents, june.actualCents)
        assertEquals(Money.parseCents("150"), july.actualCents)
        assertEquals(Money.parseCents("999"), june.actualCents)
    }

    @Test
    fun `the reported spent field is ignored entirely`() {
        val result = deriveBudgetSpend(budget("2026-07", listOf("Groceries" to "900")), mixed)
        assertEquals(Money.parseCents("150"), result.categories[0].spentCents)
        assertNotEquals(Money.parseCents("99999"), result.actualCents)
    }

    @Test
    fun `income is not spend`() {
        val withIncome = mixed + tx("2026-07-15", "Income", "5000")
        val result = deriveBudgetSpend(
            budget("2026-07", listOf("Groceries" to "900", "Income" to "0")),
            withIncome,
        )
        assertEquals(0L, result.categories.first { it.name == "Income" }.spentCents)
        assertEquals(Money.parseCents("150"), result.actualCents)
    }

    @Test
    fun `child rows count as spend despite a positive amount`() {
        val childRow = tx("2026-07-10", "Entertainment", "24", FamilyMember.MASON)
        val result = deriveBudgetSpend(budget("2026-07", listOf("Entertainment" to "40")), listOf(childRow))
        assertEquals(Money.parseCents("24"), result.categories[0].spentCents)
    }

    @Test
    fun `spend with no matching category is surfaced, not dropped`() {
        val result = deriveBudgetSpend(budget("2026-07", listOf("Dining" to "250")), mixed)
        assertEquals(0L, result.actualCents)
        assertEquals(Money.parseCents("150"), result.uncategorisedCents)
    }

    @Test
    fun `totals are internally consistent`() {
        val result = deriveBudgetSpend(
            budget("2026-06", listOf("Groceries" to "900", "Dining" to "250")),
            mixed,
        )
        assertEquals(Money.parseCents("1150"), result.plannedCents)
        assertEquals(result.categories.sumOf { it.spentCents }, result.actualCents)
        assertEquals(result.plannedCents - result.actualCents, result.remainingCents)
        assertEquals(1, result.overBudgetCount, "June Groceries 999 exceeds 900")
    }

    @Test
    fun `an empty transaction set gives zero spend, not a crash`() {
        val result = deriveBudgetSpend(budget("2026-07", listOf("Groceries" to "900")), emptyList())
        assertEquals(0L, result.actualCents)
        assertEquals(Money.parseCents("900"), result.remainingCents)
        assertEquals(0, result.overBudgetCount)
        assertEquals(0L, result.uncategorisedCents)
    }
}
