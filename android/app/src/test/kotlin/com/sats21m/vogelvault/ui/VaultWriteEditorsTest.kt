package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.CategorySpend
import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class VaultWriteEditorsTest {
    @Test
    fun `budget edit accepts only the exact budget document month`() {
        val current = seed(displayedMonth = "2026-07")
        val earlier = seed(displayedMonth = "2026-06")
        val future = seed(displayedMonth = "2026-08")

        val valid = assertIs<WriteDraftResult.Valid<BudgetCategoryWriteRequest>>(
            budgetCategoryWriteRequest(current, "975.01"),
        )
        assertEquals("2026-07", valid.request.month)
        assertEquals(97_501L, valid.request.budgetCents)
        assertIs<WriteDraftResult.Invalid>(budgetCategoryWriteRequest(earlier, "975.01"))
        assertIs<WriteDraftResult.Invalid>(budgetCategoryWriteRequest(future, "975.01"))
    }

    @Test
    fun `budget amount rejects hidden rounding`() {
        assertIs<WriteDraftResult.Invalid>(
            budgetCategoryWriteRequest(seed(displayedMonth = "2026-07"), "975.001"),
        )
    }

    @Test
    fun `btc entry preserves independently entered sats price and fiat`() {
        val result = assertIs<WriteDraftResult.Valid<BtcBuyWriteRequest>>(
            btcBuyWriteRequest(
                owner = FamilyMember.MASON,
                id = "android-test",
                date = "2026-07-29",
                source = "Strike",
                sats = "123456",
                priceUsd = "117000.25",
                purchaseUsd = "121.99",
            ),
        )

        assertEquals(123_456L, result.request.sats)
        assertEquals(11_700_025L, result.request.priceUsdCents)
        assertEquals(12_199L, result.request.usdCents)
    }

    @Test
    fun `btc entry rejects fractional sats and overprecise fiat`() {
        assertIs<WriteDraftResult.Invalid>(
            btcBuyWriteRequest(
                FamilyMember.VICTOR,
                "fractional-sats",
                "2026-07-29",
                "River",
                "1.5",
                "117000.25",
                "10.00",
            ),
        )
        assertIs<WriteDraftResult.Invalid>(
            btcBuyWriteRequest(
                FamilyMember.VICTOR,
                "rounded-fiat",
                "2026-07-29",
                "River",
                "1000",
                "117000.251",
                "10.00",
            ),
        )
    }

    private fun seed(displayedMonth: String) =
        BudgetCategoryEditorSeed(
            viewer = FamilyMember.RACHEL,
            displayedMonth = displayedMonth,
            budgetDocumentMonth = "2026-07",
            category = CategorySpend("Groceries", 90_000L, 50_000L),
        )
}
