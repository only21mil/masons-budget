package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Slice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RetirementScreenTest {
    @Test
    fun `production shaped positive sats and zero fiat refuse a zero-price projection`() {
        val state = stateWithProductionBalance().copy(
            data = stateWithProductionBalance().data.copy(
                btcPriceCents = 0L,
                btcPriceAsOf = null,
            ),
        )

        val result = retirementInputs(state)

        assertEquals(
            RetirementInputResult.Unavailable(RetirementUnavailableReason.RECORDED_PRICE),
            result,
        )
        assertNull((result as? RetirementInputResult.Available)?.let {
            projectRetirement(it.inputs, 10)
        })
    }

    @Test
    fun `projection matches Apple monthly growth and contribution semantics`() {
        val inputs = RetirementProjectionInputs(
            startingSats = 541_782_856L,
            btcPriceCents = 11_500_000L,
            btcPriceAsOf = "2026-07-01",
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
        assertEquals(
            RetirementInputResult.Unavailable(RetirementUnavailableReason.BITCOIN_BALANCE),
            retirementInputs(mason),
        )
    }

    @Test
    fun `negative surplus is floored at zero and child bonuses stay excluded`() {
        val inputs = RetirementProjectionInputs(
            startingSats = 100_000_000L,
            btcPriceCents = 10_000_000L,
            btcPriceAsOf = "2026-07-01",
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
            destination = Destination.RETIREMENT,
            data = original.copy(
                btcBalance = Slice(Freshness.LIVE, balance, 1L, "production-shaped test"),
                btcPriceCents = 11_500_000L,
                btcPriceAsOf = "2026-07-01",
            ),
        )
    }
}
