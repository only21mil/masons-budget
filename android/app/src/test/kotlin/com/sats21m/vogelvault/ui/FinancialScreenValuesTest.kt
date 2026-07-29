package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.BtcBillPay
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.IncomeEntry
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
}
