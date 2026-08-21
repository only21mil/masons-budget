package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.BtcBillPay
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.FiatValuation
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.IncomeEntry
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteSnapshot
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.Slice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FinancialScreenValuesTest {
    @Test
    fun `dashboard income follows the selected month at month boundaries`() {
        val model = Fixtures.envelope(FamilyMember.VICTOR).copy(
            income = Slice(
                Freshness.LIVE,
                listOf(
                    IncomeEntry(
                        id = "june-close",
                        date = "2026-06-30",
                        month = "2026-06",
                        amountCents = 111_111L,
                        sourceName = "Payroll",
                        note = null,
                        owner = FamilyMember.VICTOR,
                    ),
                    IncomeEntry(
                        id = "july-open",
                        date = "2026-07-01",
                        month = "2026-07",
                        amountCents = 222_222L,
                        sourceName = "Payroll",
                        note = null,
                        owner = FamilyMember.VICTOR,
                    ),
                    IncomeEntry(
                        id = "july-close",
                        date = "2026-07-31",
                        month = "2026-07",
                        amountCents = 333_333L,
                        sourceName = "Payroll",
                        note = null,
                        owner = FamilyMember.VICTOR,
                    ),
                    IncomeEntry(
                        id = "august-open",
                        date = "2026-08-01",
                        month = "2026-08",
                        amountCents = 444_444L,
                        sourceName = "Payroll",
                        note = null,
                        owner = FamilyMember.VICTOR,
                    ),
                ),
                1L,
                "test income",
            ),
            btcBalance = Slice(
                Freshness.LIVE,
                BtcBalance(
                    owner = FamilyMember.VICTOR,
                    asOf = "2026-07-16",
                    accounts = listOf(
                        BtcAccount(
                            key = "account",
                            label = "Account",
                            custody = Custody.SELF_CUSTODY,
                            sats = 1L,
                            fiatCents = 1L,
                            owner = FamilyMember.VICTOR,
                        ),
                    ),
                    totalSats = 541_782_856L,
                    fiatCents = 60_000_000L,
                    exchangeSats = 41_782_856L,
                    selfCustodySats = 500_000_000L,
                ),
                1L,
                "test balance",
            ),
        )

        assertEquals(111_111L, model.dashboardIncomeCents(FamilyMember.RACHEL, "2026-06"))
        assertEquals(555_555L, model.dashboardIncomeCents(FamilyMember.RACHEL, "2026-07"))
        assertEquals(444_444L, model.dashboardIncomeCents(FamilyMember.RACHEL, "2026-08"))
        assertNull(model.dashboardIncomeCents(FamilyMember.RACHEL, "2026-09"))
        assertNull(model.dashboardIncomeCents(FamilyMember.RACHEL, null))
        assertEquals(541_782_856L, model.netWorthBalanceForDisplay()?.totalSats)
        assertEquals(
            1L,
            model.netWorthBalanceForDisplay()?.accounts?.single()?.sats,
            "the displayed total must not be recomputed from accounts",
        )
    }

    @Test
    fun `known sats with unavailable fiat never render a confident zero`() {
        val balance = Fixtures.btcBalanceWithoutFiatValuation()
        val account = balance.accounts.single()

        assertEquals(Money.PRICE_UNAVAILABLE, formatCanonicalBalance(balance, DisplayUnit.USD))
        assertEquals(Money.PRICE_UNAVAILABLE, formatCanonicalAccount(account, DisplayUnit.USD))
        assertEquals("5.41782856 BTC", formatCanonicalBalance(balance, DisplayUnit.BTC))
        assertEquals("541 782 856 sats", formatCanonicalBalance(balance, DisplayUnit.SATS))
        assertTrue(balanceSnapshotBasis(balance).startsWith("Balance snapshot"))
        assertFalse(balanceSnapshotBasis(balance).contains("quote", ignoreCase = true))
    }

    @Test
    fun `operational quote fills missing canonical fiat without changing native bitcoin`() {
        val balance = Fixtures.btcBalanceWithoutFiatValuation()
        val account = balance.accounts.single()
        val live = marketQuote(10_000_000L)
        val stale = marketQuote(10_000_000L, MarketQuoteStatus.STALE)
        val unavailable = MarketQuote(
            symbol = MarketSymbol.BTC,
            priceCents = null,
            source = "market adapter",
            fetchedAt = null,
            status = MarketQuoteStatus.UNAVAILABLE,
        )

        assertEquals("\$541,782.86", formatCanonicalBalance(balance, DisplayUnit.USD, live))
        assertEquals("\$541,782.86", formatCanonicalAccount(account, DisplayUnit.USD, stale))
        assertEquals(
            Money.PRICE_UNAVAILABLE,
            formatCanonicalBalance(balance, DisplayUnit.USD, unavailable),
        )
        assertEquals("5.41782856 BTC", formatCanonicalBalance(balance, DisplayUnit.BTC, live))
        assertEquals("541 782 856 sats", formatCanonicalAccount(account, DisplayUnit.SATS, live))
    }

    @Test
    fun `newest buy cannot replace the operational reference or value balances`() {
        val balance = Fixtures.btcBalanceWithoutFiatValuation()
        val operational = marketQuote(10_000_000L, MarketQuoteStatus.STALE)
        val state = VaultUiState(
            data = Fixtures.envelope(FamilyMember.VICTOR).copy(
                btcPriceCents = 20_000_000L,
                btcPriceAsOf = "2026-07-31",
            ),
            marketQuotes = quoteSnapshot(operational),
            marketQuoteStatus = Freshness.STALE,
        )
        val selected = state.operationalBitcoinQuote()

        assertEquals("\$100,000.00", formatOperationalBitcoinPrice(selected))
        assertEquals(
            "market adapter · stale · 2026-07-30T10:00:00Z",
            operationalBitcoinPriceBasis(selected),
        )
        assertEquals("\$541,782.86", formatCanonicalBalance(balance, DisplayUnit.USD, selected))
    }

    @Test
    fun `canonical bitcoin quote overflow fails closed`() {
        val balance = Fixtures.btcBalanceWithoutFiatValuation()
        val account = balance.accounts.single()
        val extremeQuote = marketQuote(Long.MAX_VALUE)

        assertEquals(
            Money.PRICE_UNAVAILABLE,
            formatCanonicalBalance(
                balance.copy(totalSats = Long.MAX_VALUE),
                DisplayUnit.USD,
                extremeQuote,
            ),
        )
        assertEquals(
            Money.PRICE_UNAVAILABLE,
            formatCanonicalAccount(
                account.copy(sats = Long.MAX_VALUE),
                DisplayUnit.USD,
                extremeQuote,
            ),
        )
    }

    @Test
    fun `available zero fiat remains a real zero`() {
        fun balance(sats: Long, valuation: FiatValuation) = BtcBalance(
            owner = FamilyMember.VICTOR,
            asOf = "2026-07-29",
            accounts = emptyList(),
            totalSats = sats,
            fiatCents = valuation.cents,
            exchangeSats = 0L,
            selfCustodySats = sats,
            fiatValuation = valuation,
        )

        assertEquals(
            "\$0.00",
            formatCanonicalBalance(balance(0L, FiatValuation(0L)), DisplayUnit.USD),
        )
        assertEquals(
            "\$0.00",
            formatCanonicalBalance(
                balance(
                    1L,
                    FiatValuation(
                        cents = 0L,
                        priceCents = 6_000_000L,
                        quotedAt = "2026-07-29T12:00:00Z",
                        source = "fixture quote",
                        confidence = "verified",
                    ),
                ),
                DisplayUnit.USD,
                marketQuote(10_000_000L),
            ),
        )
    }

    @Test
    fun `required empty sources are unavailable while empty todos remain countable`() {
        val model = Fixtures.envelope(FamilyMember.VICTOR, Freshness.EMPTY)

        assertNull(model.dashboardIncomeCents(FamilyMember.VICTOR, "2026-07"))
        assertNull(model.netWorthBalanceForDisplay())
        assertFalse(model.billPaysAvailableTo(FamilyMember.VICTOR))
        assertFalse(model.todos.suppressFigures)
    }

    @Test
    fun `bill pays are exposed as a ledger without changing a headline`() {
        val model = Fixtures.envelope(FamilyMember.VICTOR).copy(
            btcBillPays = Slice(
                Freshness.LIVE,
                listOf(
                    BtcBillPay(
                        id = "bill-pay",
                        date = "2026-07-01",
                        merchant = "Utilities",
                        category = "Bills",
                        amountUsdCents = 2_563_405L,
                        btcSpentSats = 25_000_000L,
                        feeUsdCents = 0L,
                        platform = "Strike",
                        note = null,
                        owner = FamilyMember.VICTOR,
                    ),
                ),
                1L,
                "test bill pays",
            ),
        )

        assertTrue(model.billPaysAvailableTo(FamilyMember.VICTOR))
        assertEquals(2_563_405L, model.btcBillPays.value.single().amountUsdCents)
    }

    private fun marketQuote(
        priceCents: Long,
        status: MarketQuoteStatus = MarketQuoteStatus.LIVE,
    ) = MarketQuote(
        symbol = MarketSymbol.BTC,
        priceCents = priceCents,
        source = "market adapter",
        fetchedAt = "2026-07-30T10:00:00Z",
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
