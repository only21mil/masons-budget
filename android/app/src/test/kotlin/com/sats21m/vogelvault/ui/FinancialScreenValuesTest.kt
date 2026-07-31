package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.BtcBillPay
import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.BudgetIncome
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.FiatValuation
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.IncomeEntry
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.Slice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FinancialScreenValuesTest {
    @Test
    fun `current budget summary remains available with failed or empty income rows`() {
        val values = incomeModel(incomeStatus = Freshness.ERROR, entries = emptyList())
            .dashboardIncomeValues(FamilyMember.RACHEL, "2026-07")

        assertEquals(496_000L, values?.mtdCents)
        assertEquals(3_472_000L, values?.ytdCents)
        assertTrue(values?.entries.orEmpty().isEmpty())
        assertEquals("test budget", values?.source)
        assertNull(
            incomeModel().dashboardIncomeValues(FamilyMember.MASON, "2026-07"),
            "a child must not inherit the adult household summary",
        )
    }

    @Test
    fun `current budget month uses canonical summary instead of row sum`() {
        val model = incomeModel(
            entries = listOf(
                incomeEntry("july-open", "2026-07", 222_222L),
                incomeEntry("july-close", "2026-07", 333_333L),
            ),
        )
        val values = model.dashboardIncomeValues(FamilyMember.RACHEL, "2026-07")

        assertEquals(496_000L, values?.mtdCents)
        assertEquals(3_472_000L, values?.ytdCents)
        assertEquals(2, values?.entries?.size)
    }

    @Test
    fun `historical month sums scoped rows for MTD and YTD`() {
        val model = incomeModel(
            entries = listOf(
                incomeEntry("may", "2026-05", 50_000L),
                incomeEntry("june-open", "2026-06", 100_000L),
                incomeEntry("june-close", "2026-06", 200_000L),
                incomeEntry("child-june", "2026-06", 999_000L, FamilyMember.MASON),
                incomeEntry("july", "2026-07", 400_000L),
            ),
        )

        val adult = model.dashboardIncomeValues(FamilyMember.RACHEL, "2026-06")
        assertEquals(300_000L, adult?.mtdCents)
        assertEquals(350_000L, adult?.ytdCents)
        assertEquals(listOf("june-open", "june-close"), adult?.entries?.map { it.id })

        val child = model.dashboardIncomeValues(FamilyMember.MASON, "2026-06")
        assertEquals(999_000L, child?.mtdCents)
        assertEquals(999_000L, child?.ytdCents)
        assertEquals(listOf("child-june"), child?.entries?.map { it.id })
    }

    @Test
    fun `budget month mismatch never leaks current summary into history`() {
        val model = incomeModel(entries = emptyList())

        assertNull(model.dashboardIncomeValues(FamilyMember.RACHEL, "2026-06"))
        assertNull(model.dashboardIncomeValues(FamilyMember.RACHEL, null))
    }

    @Test
    fun `explicit zero summary is available while a missing summary is not`() {
        val zeroSummary = budgetIncome(mtdCents = 0L, ytdCents = 0L)
        val zero = incomeModel(summary = zeroSummary, entries = emptyList())
            .dashboardIncomeValues(FamilyMember.RACHEL, "2026-07")

        assertEquals(0L, zero?.mtdCents)
        assertEquals(0L, zero?.ytdCents)
        assertNull(
            incomeModel(
                summary = null,
                entries = listOf(incomeEntry("row-must-not-substitute", "2026-07", 123_456L)),
            ).dashboardIncomeValues(FamilyMember.RACHEL, "2026-07"),
        )
    }

    @Test
    fun `failed canonical or historical source suppresses income totals`() {
        assertNull(
            incomeModel(budgetStatus = Freshness.ERROR)
                .dashboardIncomeValues(FamilyMember.RACHEL, "2026-07"),
        )
        assertNull(
            incomeModel(
                incomeStatus = Freshness.ERROR,
                entries = listOf(incomeEntry("june", "2026-06", 100_000L)),
            ).dashboardIncomeValues(FamilyMember.RACHEL, "2026-06"),
        )
    }

    @Test
    fun `canonical balance total is not recomputed from accounts`() {
        val model = Fixtures.envelope(FamilyMember.VICTOR).copy(
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

        assertEquals(Money.PRICE_UNAVAILABLE, formatCanonicalBalance(balance, DisplayUnit.USD, 0L))
        assertEquals(Money.PRICE_UNAVAILABLE, formatCanonicalAccount(account, DisplayUnit.USD, 0L))
        assertEquals("5.41782856 BTC", formatCanonicalBalance(balance, DisplayUnit.BTC, 0L))
        assertEquals("541 782 856 sats", formatCanonicalBalance(balance, DisplayUnit.SATS, 0L))
        assertTrue(balanceSnapshotBasis(balance).startsWith("Balance snapshot"))
        assertFalse(balanceSnapshotBasis(balance).contains("quote", ignoreCase = true))
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
            formatCanonicalBalance(balance(0L, FiatValuation(0L)), DisplayUnit.USD, 0L),
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
                0L,
            ),
        )
    }

    @Test
    fun `required empty sources are unavailable while empty todos remain countable`() {
        val model = Fixtures.envelope(FamilyMember.VICTOR, Freshness.EMPTY)

        assertNull(model.dashboardIncomeValues(FamilyMember.VICTOR, "2026-07"))
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

    private fun incomeModel(
        budgetStatus: Freshness = Freshness.LIVE,
        incomeStatus: Freshness = Freshness.LIVE,
        summary: BudgetIncome? = budgetIncome(),
        entries: List<IncomeEntry> = emptyList(),
    ) = Fixtures.envelope(FamilyMember.VICTOR).copy(
        budget = Slice(
            budgetStatus,
            Budget(
                month = "2026-07",
                categories = emptyList(),
                income = summary,
                owner = FamilyMember.VICTOR,
            ),
            1L,
            "test budget",
        ),
        income = Slice(incomeStatus, entries, 1L, "test income"),
    )

    private fun budgetIncome(
        mtdCents: Long = 496_000L,
        ytdCents: Long = 3_472_000L,
    ) = BudgetIncome(
        weeklyGrossCents = 124_000L,
        monthlyGrossCents = 496_000L,
        mtdIncomeCents = mtdCents,
        ytdIncomeCents = ytdCents,
        payFrequency = "weekly",
    )

    private fun incomeEntry(
        id: String,
        month: String,
        amountCents: Long,
        owner: FamilyMember = FamilyMember.VICTOR,
    ) = IncomeEntry(
        id = id,
        date = "$month-15",
        month = month,
        amountCents = amountCents,
        sourceName = "Payroll",
        note = null,
        owner = owner,
    )
}
