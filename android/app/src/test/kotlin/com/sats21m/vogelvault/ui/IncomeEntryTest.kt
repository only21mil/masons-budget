package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class IncomeEntryTest {
    private fun draft(owner: FamilyMember = FamilyMember.RACHEL) = AddTransactionDraft(
        type = AddTransactionType.INCOME, merchant = " Payroll ", category = "Income",
        amount = "1234.56", inputUnit = DisplayUnit.USD, owner = owner,
        date = LocalDate.of(2026, 9, 13), note = " September ",
    )

    @Test fun `standalone income canonicalizes adults and preserves child ownership`() {
        val adult = prepareIncome(draft(), "stable-id").getOrThrow()
        assertEquals(FamilyMember.VICTOR, adult.owner)
        assertEquals(123456L, adult.amountCents)
        assertEquals("2026-09", adult.month)
        assertEquals("Payroll", adult.sourceName)
        assertEquals("September", adult.note)
        for (child in listOf(FamilyMember.MASON, FamilyMember.MADDOX)) {
            assertEquals(child, prepareIncome(draft(child), "child-id").getOrThrow().owner)
        }
    }

    @Test fun `income rejects invalid precision missing source and non USD input`() {
        for (invalid in listOf(draft().copy(amount = "0"), draft().copy(amount = "1.001"),
            draft().copy(merchant = " "), draft().copy(inputUnit = DisplayUnit.BTC))) {
            assertTrue(prepareIncome(invalid, "stable-id").isFailure)
        }
    }

    @Test fun `canonical income search uses source note and cents without transaction rows`() {
        val income = prepareIncome(draft(), "stable-id").getOrThrow()
        for (query in listOf("PAYROLL", "September", "1234.56")) {
            assertEquals(listOf(income), filterIncomeEntries(listOf(income), query))
        }
        assertTrue(filterIncomeEntries(listOf(income), "unrelated").isEmpty())
    }
}
