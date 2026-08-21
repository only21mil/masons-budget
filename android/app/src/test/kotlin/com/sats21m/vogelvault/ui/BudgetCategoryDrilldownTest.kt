package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.domain.budgetCategoryTransactionsFor
import kotlin.test.Test
import kotlin.test.assertEquals

class BudgetCategoryDrilldownTest {
    @Test
    fun `drilldown is scoped to the selected month and exact category`() {
        val rows =
            listOf(
                transaction("july-grocery", "2026-07-02", "Groceries", 12_34L),
                transaction("june-grocery", "2026-06-30", "Groceries", 45_67L),
                transaction("july-utility", "2026-07-03", "Utilities", 89_00L),
            ).budgetCategoryTransactionsFor(
                viewer = FamilyMember.VICTOR,
                month = "2026-07",
                category = "Groceries",
            )

        assertEquals(listOf("july-grocery"), rows.map(Transaction::id))
    }

    @Test
    fun `drilldown applies budget owner scope before exposing rows`() {
        val rows =
            listOf(
                transaction("household", "2026-07-02", "Groceries", 12_34L),
                transaction(
                    id = "child-only",
                    date = "2026-07-03",
                    category = "Groceries",
                    amount = 56_78L,
                    owner = FamilyMember.MASON,
                ),
            ).budgetCategoryTransactionsFor(
                viewer = FamilyMember.VICTOR,
                month = "2026-07",
                category = "Groceries",
            )

        assertEquals(listOf("household"), rows.map(Transaction::id))
    }

    @Test
    fun `drilldown preserves stored signed amounts for editing`() {
        val rows =
            listOf(
                transaction("purchase", "2026-07-02", "Groceries", 12_34L),
                transaction("refund", "2026-07-04", "Groceries", -5_67L),
            ).budgetCategoryTransactionsFor(
                viewer = FamilyMember.VICTOR,
                month = "2026-07",
                category = "Groceries",
            )

        assertEquals(listOf(12_34L, -5_67L), rows.map(Transaction::amount))
        assertEquals(listOf("12.34", "-5.67"), rows.map { editableTransactionAmount(it.amount) })
    }

    private fun transaction(
        id: String,
        date: String,
        category: String,
        amount: Long,
        owner: FamilyMember = FamilyMember.VICTOR,
    ) =
        Transaction(
            id = id,
            date = date,
            merchant = "Merchant $id",
            amount = amount,
            category = category,
            owner = owner,
        )
}
