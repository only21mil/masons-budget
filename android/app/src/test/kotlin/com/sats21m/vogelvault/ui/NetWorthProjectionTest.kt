package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.AccountValuation
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.FinanceAccount
import com.sats21m.vogelvault.domain.FinanceHolding
import com.sats21m.vogelvault.domain.HoldingValuation
import com.sats21m.vogelvault.domain.HoldingValuationBasis
import kotlin.test.Test
import kotlin.test.assertEquals

class NetWorthProjectionTest {
    @Test
    fun `Coldcard account names render as Multisig without changing their wire key`() {
        val account = BtcAccount(
            key = "coldcard",
            label = "Coldcard",
            custody = Custody.SELF_CUSTODY,
            sats = 1L,
            fiatCents = 1L,
            owner = FamilyMember.VICTOR,
        )

        assertEquals("Multisig", account.displayLabel())
        assertEquals("coldcard", account.key)
    }

    @Test
    fun `Victor specified projection rates and bitcoin contribution remain exact`() {
        assertEquals(1_100L, VOO_ANNUAL_GROWTH_BPS)
        assertEquals(1_600L, IBIT_AND_BITCOIN_ANNUAL_GROWTH_BPS)
        assertEquals(200_000L, BITCOIN_WEEKLY_CONTRIBUTION_CENTS)
    }

    @Test
    fun `one year growth resolves to the specified annual rates`() {
        assertEquals(111_000L, projectAssetCents(100_000L, 0L, VOO_ANNUAL_GROWTH_BPS, 1))
        assertEquals(116_000L, projectAssetCents(100_000L, 0L, IBIT_AND_BITCOIN_ANNUAL_GROWTH_BPS, 1))
    }

    @Test
    fun `projection grows bitcoin VOO and IBIT at their specified rates`() {
        val projection = projectNetWorth(
            bitcoinValueCents = 100_000L,
            retirementAccounts = listOf(
                account(
                    key = "wap",
                    weeklyContributionCents = 10_000L,
                    holdings = listOf(holding("VOO", 100_000L)),
                ),
                account(
                    key = "401k",
                    weeklyContributionCents = 5_000L,
                    holdings = listOf(
                        holding("IBIT", 50_000L),
                        holding(null, 25_000L),
                    ),
                ),
            ),
            years = 1,
        )

        assertEquals(11_258_236L, projection.bitcoinCents)
        assertEquals(656_723L, projection.vooCents)
        assertEquals(243_685L, projection.ibitCents)
        assertEquals(111_684L, projection.otherRetirementCents)
        assertEquals(1_012_092L, projection.retirementCents)
        assertEquals(12_270_328L, projection.totalCents)
    }

    @Test
    fun `retirement contributions follow the holdings in each account`() {
        val projection = projectNetWorth(
            bitcoinValueCents = 0L,
            retirementAccounts = listOf(
                account(
                    key = "mixed",
                    weeklyContributionCents = 12_000L,
                    holdings = listOf(
                        holding("VOO", 75_000L),
                        holding("IBIT", 25_000L),
                    ),
                ),
            ),
            years = 1,
        )

        assertEquals(3_000L, projection.ibitWeeklyContributionCents)
        assertEquals(9_000L, projection.vooWeeklyContributionCents)
    }

    private fun account(
        key: String,
        weeklyContributionCents: Long,
        holdings: List<HoldingValuation>,
    ) = AccountValuation(
        account = FinanceAccount(
            key = key,
            owner = FamilyMember.VICTOR,
            provider = key,
            totalValueCents = holdings.sumOf { it.valueCents },
            weeklyContributionCents = weeklyContributionCents,
            weeklyContributionDay = "Friday",
            holdings = holdings.map { it.holding },
        ),
        valueCents = holdings.sumOf { it.valueCents },
        holdings = holdings,
    )

    private fun holding(ticker: String?, valueCents: Long): HoldingValuation {
        val financeHolding = FinanceHolding(
            name = ticker ?: "Other",
            category = "Retirement",
            ticker = ticker,
            valueCents = valueCents,
            costBasisCents = valueCents,
            gainBps = 0L,
            sharesDecimal = "0",
            avgCostCents = 0L,
            currentPricePerShareCents = 0L,
            isProxy = false,
        )
        return HoldingValuation(
            holding = financeHolding,
            valueCents = valueCents,
            basis = HoldingValuationBasis.STORED_VALUE,
            quote = null,
        )
    }
}