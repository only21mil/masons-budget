package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteSnapshot
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketQuoteErrorCode
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.ui.components.ledgerRowContentDescription
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class FinancialDisplayTest {
    private val quote = marketQuote(10_000_000L)

    @Test
    fun `paired amounts prefer each exact native side`() {
        val amount = FinancialAmount(usdCents = 123_456L, sats = 9_876_543L)

        assertEquals("$1,234.56", formatFinancialAmount(amount, DisplayUnit.USD))
        assertEquals("0.09876543 BTC", formatFinancialAmount(amount, DisplayUnit.BTC))
        assertEquals("9 876 543 sats", formatFinancialAmount(amount, DisplayUnit.SATS))
    }

    @Test
    fun `paired sides never claim an operational conversion`() {
        val paired = FinancialAmount(usdCents = 100L, sats = 1_000L)
        assertFalse(paired.requiresOperationalQuote(DisplayUnit.USD))
        assertFalse(paired.requiresOperationalQuote(DisplayUnit.BTC))
        assertTrue(FinancialAmount(usdCents = 100L).requiresOperationalQuote(DisplayUnit.SATS))
        assertTrue(FinancialAmount(sats = 1_000L).requiresOperationalQuote(DisplayUnit.USD))
    }

    @Test
    fun `conversion overflow fails closed`() {
        val oneCentQuote = marketQuote(1L)
        assertEquals(
            Money.PRICE_UNAVAILABLE,
            formatFinancialAmount(
                FinancialAmount(usdCents = Long.MAX_VALUE),
                DisplayUnit.SATS,
                oneCentQuote,
            ),
        )
        assertEquals(
            Money.PRICE_UNAVAILABLE,
            formatFinancialAmount(
                FinancialAmount(sats = Long.MAX_VALUE),
                DisplayUnit.USD,
                marketQuote(Long.MAX_VALUE),
            ),
        )
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
    fun `operational quote accepts stale but rejects unavailable`() {
        val stale = marketQuote(10_000_000L, MarketQuoteStatus.STALE)
        val unavailable = MarketQuote(
            symbol = MarketSymbol.BTC,
            priceCents = null,
            source = "market adapter",
            fetchedAt = null,
            status = MarketQuoteStatus.UNAVAILABLE,
        )

        assertEquals(
            "1 000 sats",
            formatFinancialAmount(FinancialAmount(usdCents = 100L), DisplayUnit.SATS, stale),
        )
        assertEquals(
            Money.PRICE_UNAVAILABLE,
            formatFinancialAmount(FinancialAmount(usdCents = 100L), DisplayUnit.SATS, unavailable),
        )
    }

    @Test
    fun `stale display quote is visible but refused for writes`() {
        val now = java.time.Instant.parse("2026-07-30T10:20:00Z").toEpochMilli()
        val state = VaultUiState(
            now = now,
            marketQuotes = quoteSnapshot(
                marketQuote(10_000_000L).copy(
                    status = MarketQuoteStatus.STALE,
                    lastAttemptedAt = "2026-07-30T10:05:00Z",
                    errorCode = MarketQuoteErrorCode.TIMEOUT,
                ),
            ),
            marketQuoteStatus = Freshness.LIVE,
        )

        assertEquals(MarketQuoteStatus.STALE, state.operationalBitcoinQuote()?.status)
        assertEquals(null, state.liveBitcoinQuote())
        assertEquals(
            "market adapter · cached · 20 min ago · refresh failed: timeout",
            state.operationalBitcoinQuote()?.quoteHint(now),
        )
        assertEquals(
            "BTC, market adapter · cached · 20 min ago · refresh failed: timeout, STALE, $100,000.00",
            ledgerRowContentDescription(
                primary = "BTC",
                secondary = state.operationalBitcoinQuote()?.quoteHint(now),
                figure = "$100,000.00",
                badge = "STALE",
            ),
        )
        assertEquals(
            "market adapter · now",
            marketQuote(10_000_000L).quoteHint(
                java.time.Instant.parse("2026-07-30T10:00:00Z").toEpochMilli(),
            ),
        )
        assertEquals(
            "market adapter · unavailable",
            MarketQuote(
                MarketSymbol.BTC,
                null,
                "market adapter",
                null,
                MarketQuoteStatus.UNAVAILABLE,
            ).quoteHint(now),
        )
    }

    @Test
    fun `newer buy execution price cannot override operational quote`() {
        val data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE).copy(
            btcPriceCents = 20_000_000L,
            btcPriceAsOf = "2026-07-31",
        )
        val state = VaultUiState(
            data = data,
            now = java.time.Instant.parse("2026-07-30T12:01:00Z").toEpochMilli(),
            marketQuotes = quoteSnapshot(marketQuote(10_000_000L, fetchedAt = "2026-07-30T12:00:00Z")),
            marketQuoteStatus = Freshness.LIVE,
        )

        val selectedQuote = state.operationalBitcoinQuote()
        assertEquals(10_000_000L, selectedQuote?.priceCents)
        assertEquals(
            "1 000 sats",
            formatFinancialAmount(FinancialAmount(usdCents = 100L), DisplayUnit.SATS, selectedQuote),
        )
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

    private fun marketQuote(
        priceCents: Long,
        status: MarketQuoteStatus = MarketQuoteStatus.LIVE,
        fetchedAt: String = "2026-07-30T10:00:00Z",
    ) = MarketQuote(
        symbol = MarketSymbol.BTC,
        priceCents = priceCents,
        source = "market adapter",
        fetchedAt = fetchedAt,
        status = status,
    )

    private fun quoteSnapshot(btc: MarketQuote) = MarketQuoteSnapshot(
        listOf(
            btc,
            MarketQuote(MarketSymbol.VOO, null, "market adapter", null, MarketQuoteStatus.UNAVAILABLE),
            MarketQuote(MarketSymbol.IBIT, null, "market adapter", null, MarketQuoteStatus.UNAVAILABLE),
        ),
    )
}
