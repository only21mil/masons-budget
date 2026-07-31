package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.Transaction
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FinancialDisplayTest {
    private val quote = RecordedBitcoinQuote(cents = 10_000_000L, asOf = "2026-07-30")

    @Test
    fun `paired amounts prefer each exact native side`() {
        val amount = FinancialAmount(usdCents = 123_456L, sats = 9_876_543L)

        assertEquals("$1,234.56", formatFinancialAmount(amount, DisplayUnit.USD))
        assertEquals("0.09876543 BTC", formatFinancialAmount(amount, DisplayUnit.BTC))
        assertEquals("9 876 543 sats", formatFinancialAmount(amount, DisplayUnit.SATS))
    }

    @Test
    fun `fiat only amounts require an explicit quote for bitcoin units`() {
        val amount = FinancialAmount(usdCents = 100L)

        assertEquals("$1.00", formatFinancialAmount(amount, DisplayUnit.USD))
        assertEquals("0.00001000 BTC", formatFinancialAmount(amount, DisplayUnit.BTC, quote))
        assertEquals("1 000 sats", formatFinancialAmount(amount, DisplayUnit.SATS, quote))
        assertEquals(Money.PRICE_UNAVAILABLE, formatFinancialAmount(amount, DisplayUnit.BTC))
    }

    @Test
    fun `sats only amounts require an explicit quote for usd`() {
        val amount = FinancialAmount(sats = 1_000L)

        assertEquals("$1.00", formatFinancialAmount(amount, DisplayUnit.USD, quote))
        assertEquals(Money.PRICE_UNAVAILABLE, formatFinancialAmount(amount, DisplayUnit.USD))
    }

    @Test
    fun `activity signs survive every display unit`() {
        val spend = Transaction(
            id = "spend",
            date = "2026-07-30",
            merchant = "Grocer",
            amount = 100L,
            category = "Groceries",
            owner = FamilyMember.VICTOR,
        )
        val credit = spend.copy(
            id = "credit",
            amount = -100L,
            spendAmount = -100L,
            displaySpendAmount = 100L,
        )

        assertEquals("-$1.00", formatTransactionAmount(spend, DisplayUnit.USD, quote))
        assertEquals("-0.00001000 BTC", formatTransactionAmount(spend, DisplayUnit.BTC, quote))
        assertEquals("-1 000 sats", formatTransactionAmount(spend, DisplayUnit.SATS, quote))
        assertEquals("1 000 sats", formatTransactionAmount(credit, DisplayUnit.SATS, quote))
        assertEquals(
            Money.PRICE_UNAVAILABLE,
            formatTransactionAmount(spend, DisplayUnit.BTC, null),
        )
    }

    @Test
    fun `quote accepts stale recorded rows but rejects failed rows`() {
        val model = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val stale = model.copy(btcBuys = model.btcBuys.copy(status = Freshness.STALE))
        val failed = model.copy(btcBuys = model.btcBuys.copy(status = Freshness.ERROR))

        assertEquals(model.btcPriceCents, stale.recordedBitcoinQuote()?.cents)
        assertEquals(model.btcPriceAsOf, stale.recordedBitcoinQuote()?.asOf)
        assertNull(failed.recordedBitcoinQuote())
    }

    @Test
    fun `only financial destinations expose the global selector and budget stays usd`() {
        val financial = setOf(
            Destination.DASHBOARD,
            Destination.ACTIVITY,
            Destination.BITCOIN,
            Destination.BTC_BUYS,
            Destination.BTC_BILL_PAYS,
            Destination.NET_WORTH,
            Destination.RETIREMENT,
        )

        Destination.entries.forEach { destination ->
            assertEquals(destination in financial, destination.supportsFinancialDisplayUnit)
        }
        assertFalse(Destination.BUDGET.supportsFinancialDisplayUnit)
        assertTrue(Destination.ACTIVITY.supportsFinancialDisplayUnit)
    }
}
