package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.FinanceDocumentSnapshot
import com.sats21m.vogelvault.data.MarketQuoteReadSnapshot
import com.sats21m.vogelvault.data.RowReadFailure
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.FinanceAccount
import com.sats21m.vogelvault.domain.FinanceDocument
import com.sats21m.vogelvault.domain.FinanceHolding
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.HoldingValuationBasis
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteSnapshot
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.Slice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FinancePresentationTest {
    @Test
    fun `finance conversion overflow renders unavailable`() {
        val state = financeState(FamilyMember.VICTOR).copy(
            marketQuotes = MarketQuoteSnapshot(
                listOf(
                    MarketQuote(MarketSymbol.BTC, 1L, "market adapter", "2026-07-30T12:00:00Z", MarketQuoteStatus.LIVE),
                    MarketQuote(MarketSymbol.VOO, null, "market adapter", null, MarketQuoteStatus.UNAVAILABLE),
                    MarketQuote(MarketSymbol.IBIT, null, "market adapter", null, MarketQuoteStatus.UNAVAILABLE),
                ),
            ),
        )
        assertEquals(Money.PRICE_UNAVAILABLE, state.formatFinanceCents(Long.MAX_VALUE, DisplayUnit.SATS))
    }
    @Test
    fun `adult total uses quote-valued retirement once and excludes child accounts`() {
        val state = financeState(FamilyMember.VICTOR)

        val selection = requireNotNull(state.adultNetWorthSelection())

        assertEquals(1, selection.accounts.size)
        assertEquals(12_000L, selection.retirementValueCents)
        assertEquals(10_000_000L, selection.bitcoinValueCents)
        assertEquals(10_012_000L, selection.totalValueCents)
        assertEquals(
            "market service · 2026-07-31T12:00:00Z",
            selection.valuationQualityHint(),
        )
    }

    @Test
    fun `adult total discloses stale and stored retirement valuation inputs`() {
        val voo = account("adult", FamilyMember.VICTOR).holdings.single()
        val ibit = voo.copy(name = "IBIT holding", ticker = "IBIT", sharesDecimal = "3")
        val state = financeState(FamilyMember.VICTOR).copy(
            financeDocument = document().copy(
                accounts = listOf(
                    account("adult", FamilyMember.VICTOR).copy(holdings = listOf(voo, ibit)),
                ),
            ),
            marketQuotes = MarketQuoteSnapshot(
                listOf(
                    MarketQuote(
                        MarketSymbol.BTC,
                        10_000_000L,
                        "market service",
                        "2026-07-31T12:00:00Z",
                        MarketQuoteStatus.LIVE,
                    ),
                    MarketQuote(
                        MarketSymbol.VOO,
                        6_000L,
                        "market service",
                        "2026-07-30T12:00:00Z",
                        MarketQuoteStatus.STALE,
                    ),
                    MarketQuote(
                        MarketSymbol.IBIT,
                        null,
                        "market service",
                        null,
                        MarketQuoteStatus.UNAVAILABLE,
                    ),
                ),
            ),
        )

        val selection = requireNotNull(state.adultNetWorthSelection())

        assertEquals(
            "market service · 2026-07-31T12:00:00Z · Retirement: 1 stale quote · 1 stored value",
            selection.valuationQualityHint(),
        )
        assertEquals(
            listOf(HoldingValuationBasis.MARKET_QUOTE, HoldingValuationBasis.STORED_VALUE),
            selection.accounts.single().holdings.map { it.basis },
        )
    }

    @Test
    fun `child profile sees only self-owned retirement and no household total`() {
        val state = financeState(FamilyMember.MASON)

        assertEquals(listOf(FamilyMember.MASON), state.retirementAccounts().map { it.account.owner })
        assertNull(state.adultNetWorthSelection())
    }

    @Test
    fun `unavailable BTC quote suppresses combined total without suppressing retirement`() {
        val quotes = quotes().quotes.map {
            if (it.symbol == MarketSymbol.BTC) {
                MarketQuote(MarketSymbol.BTC, null, "market service", null, MarketQuoteStatus.UNAVAILABLE)
            } else {
                it
            }
        }
        val state = financeState(FamilyMember.VICTOR).copy(
            marketQuotes = MarketQuoteSnapshot(quotes),
        )

        val selection = requireNotNull(state.adultNetWorthSelection())

        assertNull(selection.totalValueCents)
        assertEquals(12_000L, selection.retirementValueCents)
        assertEquals("Price unavailable", state.formatFinanceCents(12_000L, DisplayUnit.SATS))
    }

    @Test
    fun `retirement unit conversion uses the operational BTC quote`() {
        val state = financeState(FamilyMember.VICTOR)

        assertEquals("120 000 sats", state.formatFinanceCents(12_000L, DisplayUnit.SATS))
        assertEquals("0.00120000 BTC", state.formatFinanceCents(12_000L, DisplayUnit.BTC))
        assertEquals("\$120.00", state.formatFinanceCents(12_000L, DisplayUnit.USD))
    }

    @Test
    fun `retirement accounts retain weekly schedule even without holding detail`() {
        val scheduled = account("scheduled", FamilyMember.VICTOR).copy(
            weeklyContributionCents = 25_000L,
            weeklyContributionDay = "Friday",
            holdings = emptyList(),
        )
        val state = financeState(FamilyMember.VICTOR).copy(
            financeDocument = document().copy(accounts = listOf(scheduled)),
        )

        val account = state.retirementAccountsResult().getOrThrow().single()

        assertEquals("scheduled", account.account.key)
        assertEquals(25_000L, account.account.weeklyContributionCents)
        assertEquals("Friday", account.account.weeklyContributionDay)
        assertTrue(account.holdings.isEmpty())
        assertEquals(9_999L, account.valueCents)
    }

    @Test
    fun `overflowing retirement arithmetic becomes unavailable instead of throwing`() {
        val first = account("first", FamilyMember.VICTOR).copy(
            totalValueCents = Long.MAX_VALUE,
            holdings = emptyList(),
        )
        val second = account("second", FamilyMember.RACHEL).copy(
            totalValueCents = Long.MAX_VALUE,
            holdings = emptyList(),
        )
        val state = financeState(FamilyMember.VICTOR).copy(
            financeDocument = document().copy(accounts = listOf(first, second)),
        )

        assertTrue(state.adultNetWorthSelectionResult().isFailure)
        assertNull(state.adultNetWorthSelection())
        assertEquals(
            "Price unavailable",
            state.formatFinanceCents(Long.MAX_VALUE, DisplayUnit.SATS),
        )
    }

    @Test
    fun `incomplete adapter envelopes are errors and expose no partial values`() {
        val result = financeSurfaceState(
            ConvexResult.Ok(FinanceDocumentSnapshot(document(), complete = false)),
            ConvexResult.Ok(MarketQuoteReadSnapshot(quotes(), complete = false)),
        )

        assertEquals(Freshness.ERROR, result.financeStatus)
        assertEquals(Freshness.ERROR, result.marketQuoteStatus)
        assertNull(result.financeDocument)
        assertNull(result.marketQuotes)
    }

    @Test
    fun `finance authorization rejection retains unauthorized taxonomy`() {
        val result = financeSurfaceState(
            ConvexResult.Unauthorized,
            ConvexResult.Unauthorized,
        )

        assertEquals(setOf(RowReadFailure.UNAUTHORIZED), result.readFailures)
        assertEquals(true, result.unauthorized)
        assertEquals(Freshness.ERROR, result.financeStatus)
        assertEquals(Freshness.ERROR, result.marketQuoteStatus)
    }

    private fun financeState(viewer: FamilyMember): VaultUiState {
        val balance = BtcBalance(
            owner = FamilyMember.VICTOR,
            asOf = "2026-07-31",
            accounts = listOf(
                BtcAccount(
                    key = "cold",
                    label = "Cold storage",
                    custody = Custody.SELF_CUSTODY,
                    sats = 100_000_000L,
                    fiatCents = 0L,
                    owner = FamilyMember.VICTOR,
                ),
            ),
            totalSats = 100_000_000L,
            fiatCents = 0L,
            exchangeSats = 0L,
            selfCustodySats = 100_000_000L,
        )
        return VaultUiState(
            activeProfile = viewer,
            data = Fixtures.envelope(viewer).copy(
                btcBalance = Slice(Freshness.LIVE, balance, 1L, "test balance"),
            ),
            financeDocument = document(),
            financeStatus = Freshness.LIVE,
            marketQuotes = quotes(),
            marketQuoteStatus = Freshness.LIVE,
        )
    }

    private fun document() = FinanceDocument(
        updatedAtMs = 1L,
        lastUpdated = "2026-07-31",
        retirementTotalCents = 999_999L,
        accounts = listOf(
            account("adult", FamilyMember.VICTOR),
            account("child", FamilyMember.MASON),
        ),
    )

    private fun account(key: String, owner: FamilyMember) = FinanceAccount(
        key = key,
        owner = owner,
        provider = "Test brokerage",
        totalValueCents = 9_999L,
        weeklyContributionCents = 0L,
        weeklyContributionDay = null,
        holdings = listOf(
            FinanceHolding(
                name = "VOO holding",
                category = "ETF",
                ticker = "VOO",
                valueCents = 9_999L,
                costBasisCents = 8_000L,
                gainBps = 0L,
                sharesDecimal = "2",
                avgCostCents = 4_000L,
                currentPricePerShareCents = 4_999L,
                isProxy = false,
            ),
        ),
    )

    private fun quotes() = MarketQuoteSnapshot(
        listOf(
            MarketQuote(MarketSymbol.BTC, 10_000_000L, "market service", "2026-07-31T12:00:00Z", MarketQuoteStatus.LIVE),
            MarketQuote(MarketSymbol.VOO, 6_000L, "market service", "2026-07-31T12:00:00Z", MarketQuoteStatus.LIVE),
            MarketQuote(MarketSymbol.IBIT, 4_000L, "market service", "2026-07-31T12:00:00Z", MarketQuoteStatus.STALE),
        ),
    )
}
