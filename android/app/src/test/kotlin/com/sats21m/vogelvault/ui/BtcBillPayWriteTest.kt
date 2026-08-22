package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.DraftIdWriteOutcome
import com.sats21m.vogelvault.domain.BillPayBudgetEffect
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class BtcBillPayWriteTest {
    private val categories = listOf("Housing", "Groceries")

    @Test
    fun `accepted bill pay with a stale draft id reports local recovery`() {
        assertEquals(
            "Convex accepted this Bitcoin bill pay, but this device could not retire its draft id. " +
                "Do not submit another bill pay until local storage is repaired.",
            btcBillPayWriteFailureMessage(DraftIdWriteOutcome.AcceptedLeaseResetFailed),
        )
    }

    @Test
    fun `budget category requires a real selected budget category`() {
        val result = btcBillPayWriteRequest(
            owner = FamilyMember.RACHEL,
            id = "bill-1",
            date = "2026-08-20",
            merchant = "Mortgage",
            category = "Housing",
            budgetEffect = BillPayBudgetEffect.BUDGET_CATEGORY,
            amountUsd = "1234.56",
            sats = "1000000",
            priceUsd = "123456.00",
            feeUsd = "0.25",
            note = "monthly",
            reference = "river-1",
            availableCategories = categories,
        )

        val valid = assertIs<WriteDraftResult.Valid<BtcBillPayWriteRequest>>(result)
        assertEquals(FamilyMember.VICTOR, valid.request.owner)
        assertEquals("Housing", valid.request.category)
        assertEquals(123_456L, valid.request.amountUsdCents)
        assertEquals(1_000_000L, valid.request.btcSpentSats)
        assertEquals(12_345_600L, valid.request.btcPriceCents)
        assertEquals(25L, valid.request.feeUsdCents)
        assertEquals("river-1", valid.request.reference)

        val invalid = btcBillPayWriteRequest(
            owner = FamilyMember.VICTOR,
            id = "bill-2",
            date = "2026-08-20",
            merchant = "Mystery",
            category = "Not a budget category",
            budgetEffect = BillPayBudgetEffect.BUDGET_CATEGORY,
            amountUsd = "1.00",
            sats = "1",
            priceUsd = "10000000",
            feeUsd = "0",
            availableCategories = categories,
        )
        assertIs<WriteDraftResult.Invalid>(invalid)
    }

    @Test
    fun `credit card effect forces the non-budget category`() {
        val result = assertIs<WriteDraftResult.Valid<BtcBillPayWriteRequest>>(
            btcBillPayWriteRequest(
                owner = FamilyMember.VICTOR,
                id = "bill-3",
                date = "2026-08-20",
                merchant = "Aven",
                category = "Housing",
                budgetEffect = BillPayBudgetEffect.CREDIT_CARD_PAYMENT,
                amountUsd = "12.00",
                sats = "2000",
                priceUsd = "600000.00",
                feeUsd = "0",
                availableCategories = categories,
            ),
        )

        assertEquals("Credit Card Payment", result.request.category)
        assertEquals(BillPayBudgetEffect.CREDIT_CARD_PAYMENT, result.request.budgetEffect)
    }

    @Test
    fun `children cannot create the adult-only Bitcoin bill-pay source`() {
        val result = btcBillPayWriteRequest(
            owner = FamilyMember.MASON,
            id = "bill-child",
            date = "2026-08-20",
            merchant = "Utility",
            category = "Housing",
            budgetEffect = BillPayBudgetEffect.BUDGET_CATEGORY,
            amountUsd = "12.00",
            sats = "2000",
            priceUsd = "600000.00",
            feeUsd = "0",
            availableCategories = categories,
        )

        assertIs<WriteDraftResult.Invalid>(result)
    }

    @Test
    fun `bill pay add action is live and adult scoped`() {
        assertEquals(true, canAddBtcBillPay(Freshness.LIVE, FamilyMember.VICTOR))
        assertEquals(true, canAddBtcBillPay(Freshness.LIVE, FamilyMember.RACHEL))
        assertEquals(false, canAddBtcBillPay(Freshness.LIVE, FamilyMember.MASON))
        assertEquals(true, canAddBtcBillPay(Freshness.EMPTY, FamilyMember.VICTOR))
        assertEquals(false, canAddBtcBillPay(Freshness.ERROR, FamilyMember.VICTOR))
    }
}
