package com.sats21m.vogelvault.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class BtcBillPayBudgetTest {
    private val budget = Budget(
        month = "2026-08",
        categories = listOf(
            BudgetCategory("Housing", 200_000L, 0L),
            BudgetCategory("Groceries", 50_000L, 0L),
        ),
        owner = FamilyMember.VICTOR,
    )

    @Test
    fun `budget category bill pay contributes its USD amount to the selected month`() {
        val billPay = BtcBillPay(
            id = "bill-1",
            date = "2026-08-12",
            merchant = "Mortgage",
            category = "Housing",
            budgetEffect = BillPayBudgetEffect.BUDGET_CATEGORY,
            amountUsdCents = 123_456L,
            btcSpentSats = 1_000_000L,
            btcPriceCents = 12_345_600L,
            feeUsdCents = 0L,
            platform = "river_bitcoin_bill_pay",
            note = null,
            owner = FamilyMember.VICTOR,
        )

        val spend = assertNotNull(deriveBudgetSpend(budget, emptyList(), listOf(billPay)))

        assertEquals(123_456L, spend.categories.single { it.name == "Housing" }.spentCents)
        assertEquals(123_456L, spend.actualCents)
    }

    @Test
    fun `credit card bill pay contributes zero even when its amount is nonzero`() {
        val billPay = BtcBillPay(
            id = "bill-2",
            date = "2026-08-13",
            merchant = "Aven",
            category = "Credit Card Payment",
            budgetEffect = BillPayBudgetEffect.CREDIT_CARD_PAYMENT,
            amountUsdCents = 999_999L,
            btcSpentSats = 2_000_000L,
            btcPriceCents = 49_999_950L,
            feeUsdCents = 100L,
            platform = "river_bitcoin_bill_pay",
            note = null,
            owner = FamilyMember.VICTOR,
        )

        val spend = assertNotNull(deriveBudgetSpend(budget, emptyList(), listOf(billPay)))

        assertEquals(0L, spend.actualCents)
    }
}
