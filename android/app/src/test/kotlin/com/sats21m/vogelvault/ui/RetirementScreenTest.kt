package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteSnapshot
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.domain.Slice
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RetirementScreenTest {
    @Test
    fun `production shaped balance requires an operational btc quote`() {
        val usable = stateWithProductionBalance()

        val inputs = assertIs<RetirementInputResult.Available>(retirementInputs(usable)).inputs
        assertEquals(541_782_856L, inputs.startingSats)
        assertEquals(11_500_000L, inputs.btcPriceCents)

        assertEquals(
            RetirementInputResult.Unavailable(RetirementUnavailableReason.MARKET_QUOTE),
            retirementInputs(usable.copy(marketQuotes = null, marketQuoteStatus = Freshness.ERROR)),
            "a missing operational snapshot cannot value a positive stack",
        )
        assertEquals(
            RetirementBitcoinStack(541_782_856L, "2026-07-16", null),
            retirementBitcoinStack(usable.copy(marketQuotes = null, marketQuoteStatus = Freshness.ERROR)),
            "the native Bitcoin stack remains present when fiat conversion is unavailable",
        )
        assertEquals(
            RetirementInputResult.Unavailable(RetirementUnavailableReason.MARKET_QUOTE),
            retirementInputs(usable.withBtcQuote(unavailableBtcQuote())),
            "an unavailable operational BTC quote cannot value a positive stack",
        )
        assertIs<RetirementInputResult.Available>(
            retirementInputs(usable.withBtcQuote(btcQuote(11_500_000L, MarketQuoteStatus.STALE))),
        )
    }

    @Test
    fun `income and budget availability gate only the projection`() {
        val usable = stateWithProductionBalance()
        val expectedStack = requireNotNull(retirementBitcoinStack(usable))
        val missingIncome = usable.copy(
            data = usable.data.copy(
                income = usable.data.income.copy(status = Freshness.ERROR),
            ),
        )
        val missingBudget = usable.copy(
            data = usable.data.copy(
                budget = usable.data.budget.copy(status = Freshness.EMPTY),
            ),
        )

        assertEquals(expectedStack, retirementBitcoinStack(missingIncome))
        assertEquals(
            RetirementInputResult.Unavailable(RetirementUnavailableReason.INCOME),
            retirementInputs(missingIncome),
        )
        assertEquals(expectedStack, retirementBitcoinStack(missingBudget))
        assertEquals(
            RetirementInputResult.Unavailable(RetirementUnavailableReason.BUDGET),
            retirementInputs(missingBudget),
        )
    }

    @Test
    fun `projection matches Apple monthly growth and contribution semantics`() {
        val inputs = RetirementProjectionInputs(
            startingSats = 541_782_856L,
            btcQuote = btcQuote(11_500_000L),
            balanceAsOf = "2026-07-16",
            monthlyIncomeCents = 3_489_347L,
            monthlyBudgetCents = 2_500_000L,
            adultAnnualBonusCents = 9_700_000L,
        )

        val projection = projectRetirement(inputs, 10)

        assertEquals(
            RetirementProjection(
                years = 10,
                projectedSats = 9_210_373_969L,
                monthlyDcaSats = 9_093_000L,
                monthlySurplusSats = 8_603_017L,
                monthlyBonusSats = 7_028_986L,
            ),
            projection,
        )
    }

    @Test
    fun `Rachel shares Victor inputs while a child cannot consume them`() {
        val victorState = stateWithProductionBalance()
        val rachel = victorState.copy(activeProfile = FamilyMember.RACHEL)
        val mason = victorState.copy(activeProfile = FamilyMember.MASON)

        assertIs<RetirementInputResult.Available>(retirementInputs(rachel))
        assertEquals(retirementBitcoinStack(victorState), retirementBitcoinStack(rachel))
        assertNull(retirementBitcoinStack(mason))
        assertEquals(
            RetirementInputResult.Unavailable(RetirementUnavailableReason.BITCOIN_BALANCE),
            retirementInputs(mason),
        )
    }

    @Test
    fun `negative surplus is floored at zero and child bonuses stay excluded`() {
        val inputs = RetirementProjectionInputs(
            startingSats = 100_000_000L,
            btcQuote = btcQuote(10_000_000L),
            balanceAsOf = "2026-07-16",
            monthlyIncomeCents = 100_000L,
            monthlyBudgetCents = 200_000L,
            adultAnnualBonusCents = 0L,
        )

        val projection = requireNotNull(projectRetirement(inputs, 10))

        assertEquals(0L, inputs.monthlySurplusCents)
        assertEquals(0L, projection.monthlySurplusSats)
        assertEquals(0L, projection.monthlyBonusSats)
        assertTrue(projection.projectedSats > inputs.startingSats)
    }

    private fun VaultUiState.withBtcQuote(quote: MarketQuote): VaultUiState =
        copy(marketQuotes = quoteSnapshot(quote), marketQuoteStatus = Freshness.LIVE)

    private fun stateWithProductionBalance(): VaultUiState {
        val original = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val balance = BtcBalance(
            owner = FamilyMember.VICTOR,
            asOf = "2026-07-16",
            accounts = listOf(
                BtcAccount(
                    key = "cold-storage",
                    label = "Cold storage",
                    custody = Custody.SELF_CUSTODY,
                    sats = 541_782_856L,
                    fiatCents = 0L,
                    owner = FamilyMember.VICTOR,
                ),
            ),
            totalSats = 541_782_856L,
            fiatCents = 0L,
            exchangeSats = 0L,
            selfCustodySats = 541_782_856L,
        )
        return VaultUiState(
            activeProfile = FamilyMember.VICTOR,
            destination = Destination.NET_WORTH,
            data = original.copy(
                btcBalance = Slice(Freshness.LIVE, balance, 1L, "production-shaped test"),
                // A newer execution price must remain irrelevant to retirement conversion.
                btcPriceCents = 20_000_000L,
                btcPriceAsOf = "2026-07-31",
            ),
            now = Instant.parse("2026-07-30T12:05:00Z").toEpochMilli(),
            marketQuotes = quoteSnapshot(btcQuote(11_500_000L)),
            marketQuoteStatus = Freshness.LIVE,
        )
    }

    private fun btcQuote(
        cents: Long,
        status: MarketQuoteStatus = MarketQuoteStatus.LIVE,
    ) = MarketQuote(
        MarketSymbol.BTC,
        cents,
        "market adapter",
        "2026-07-30T12:00:00Z",
        status,
    )

    private fun unavailableBtcQuote() = MarketQuote(
        MarketSymbol.BTC,
        null,
        "market adapter",
        null,
        MarketQuoteStatus.UNAVAILABLE,
    )

    private fun quoteSnapshot(btc: MarketQuote) = MarketQuoteSnapshot(
        listOf(
            btc,
            MarketQuote(MarketSymbol.VOO, null, "market adapter", null, MarketQuoteStatus.UNAVAILABLE),
            MarketQuote(MarketSymbol.IBIT, null, "market adapter", null, MarketQuoteStatus.UNAVAILABLE),
        ),
    )
}
