package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.BtcBillPay
import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.netWorthScopeFor
import kotlin.test.Test
import kotlin.test.assertEquals

class BtcLedgerScreensTest {
    private val adultBuy = BtcBuy(
        id = "adult-buy",
        date = "2026-07-01",
        source = "River",
        sats = 100_000_000L,
        priceUsdCents = 6_000_000L,
        usdCents = 6_000_125L,
        owner = FamilyMember.VICTOR,
    )
    private val childBuy = BtcBuy(
        id = "child-buy",
        date = "2026-07-02",
        source = "Gift",
        sats = 25_000_000L,
        priceUsdCents = 8_000_000L,
        usdCents = 2_000_075L,
        owner = FamilyMember.MASON,
    )

    @Test
    fun `adult sees child buys but adult net worth excludes them`() {
        val allRows = listOf(adultBuy, childBuy)
        val summary = btcBuysScreenSummary(allRows, FamilyMember.RACHEL)

        assertEquals(listOf(adultBuy, childBuy), summary.rows)
        assertEquals(125_000_000L, summary.totalSats)
        assertEquals(8_000_200L, summary.totalUsdCents)
        assertEquals(6_400_160L, summary.averageExecutionPriceCents)
        assertEquals(
            listOf(adultBuy),
            allRows.netWorthScopeFor(FamilyMember.RACHEL),
            "wide ledger visibility must not widen adult net-worth scope",
        )
    }

    @Test
    fun `child buy screen is self only`() {
        val allRows = listOf(adultBuy, childBuy)

        assertEquals(listOf(childBuy), btcBuysScreenSummary(allRows, FamilyMember.MASON).rows)
    }

    @Test
    fun `buy fiat display uses canonical paid cents instead of recomputed price`() {
        assertEquals("$60,001.25", formatBtcBuyAmount(adultBuy, DisplayUnit.USD))
        assertEquals("1.00000000 BTC", formatBtcBuyAmount(adultBuy, DisplayUnit.BTC))
        assertEquals("100 000 000 sats", formatBtcBuyAmount(adultBuy, DisplayUnit.SATS))
    }

    @Test
    fun `bill pay totals and rows honor all display units`() {
        val payment = BtcBillPay(
            id = "bill-pay",
            date = "2026-07-03",
            merchant = "Mortgage",
            category = "Housing",
            amountUsdCents = 123_456L,
            btcSpentSats = 1_500_000L,
            feeUsdCents = 99L,
            platform = "River",
            note = null,
            owner = FamilyMember.MASON,
        )
        val summary = btcBillPaysScreenSummary(listOf(payment), FamilyMember.VICTOR)

        assertEquals(listOf(payment), summary.rows)
        assertEquals(1_500_000L, summary.totalSats)
        assertEquals(123_456L, summary.totalUsdCents)
        assertEquals(99L, summary.totalFeeUsdCents)
        assertEquals("-$1,234.56", formatBtcBillPayAmount(payment, DisplayUnit.USD))
        assertEquals("-0.01500000 BTC", formatBtcBillPayAmount(payment, DisplayUnit.BTC))
        assertEquals("-1 500 000 sats", formatBtcBillPayAmount(payment, DisplayUnit.SATS))
        assertEquals("$0.99", formatBtcBillPayFee(99L, DisplayUnit.USD, null))
        assertEquals(
            "990 sats",
            formatBtcBillPayFee(
                99L,
                DisplayUnit.SATS,
                RecordedBitcoinQuote(10_000_000L, "2026-07-03"),
            ),
        )
        assertEquals(
            com.sats21m.vogelvault.domain.Money.PRICE_UNAVAILABLE,
            formatBtcBillPayFee(99L, DisplayUnit.BTC, null),
        )
    }

    @Test
    fun `child bill pay screen cannot see adult rows`() {
        val adultPayment = BtcBillPay(
            id = "adult-bill-pay",
            date = "2026-07-03",
            merchant = "Utility",
            category = "Bills",
            amountUsdCents = 10_000L,
            btcSpentSats = 12_000L,
            feeUsdCents = 0L,
            platform = null,
            note = null,
            owner = FamilyMember.VICTOR,
        )

        assertEquals(
            emptyList(),
            btcBillPaysScreenSummary(listOf(adultPayment), FamilyMember.MADDOX).rows,
        )
    }
}
