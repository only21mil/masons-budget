package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Transaction
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class QuickAddTest {
    @Test fun `quick add amount validity respects each unit precision and range`() {
        for (unit in DisplayUnit.entries) {
            for (invalid in listOf("", "0", "-1", "nope", "1.2.3", "9223372036854775808")) {
                assertNotNull(quickAddAmountError(invalid, unit), "$unit must reject $invalid")
            }
        }
        for ((unit, valid, invalid) in listOf(
            Triple(DisplayUnit.USD, "0.01", "0.001"),
            Triple(DisplayUnit.BTC, "0.00000001", "0.000000001"),
            Triple(DisplayUnit.SATS, "1", "1.1"),
        )) {
            assertEquals(null, quickAddAmountError(valid, unit))
            assertNotNull(quickAddAmountError(invalid, unit))
        }
    }

    @Test fun `any pair derives missing quantity price or cents`() {
        val expected = DerivedBitcoinBuy("100000", "100000.00", "100.00")
        assertEquals(expected, deriveBitcoinBuy("100000", "100000", "").getOrThrow())
        assertEquals(expected, deriveBitcoinBuy("100000", "", "100").getOrThrow())
        assertEquals(expected, deriveBitcoinBuy("", "100000", "100").getOrThrow())
        assertEquals(expected, deriveBitcoinBuy("", "", "100", 10000000).getOrThrow())
        assertEquals(expected, deriveBitcoinBuy("100000", "", "", 10000000).getOrThrow())
    }
    @Test fun `receipt pair and override take precedence over quote`() {
        assertEquals("200000.00", deriveBitcoinBuy("100000", "", "200", 10000000).getOrThrow().priceUsd)
        assertEquals("50000", deriveBitcoinBuy("", "200000", "100", 10000000).getOrThrow().sats)
        assertEquals("101.00", deriveBitcoinBuy("100000", "100000", "101").getOrThrow().purchaseUsd)
    }
    @Test fun `derivation refuses fractional sats excess decimal places zero and overflow`() {
        for (values in listOf(Triple("1.5", "100000", ""), Triple("1", "0", ""),
            Triple("1", "100000.001", ""), Triple("", "0.01", "92233720368547758.07"),
            Triple("1", "", "0.01"))) {
            val result = deriveBitcoinBuy(values.first, values.second, values.third)
            if (values != Triple("1", "", "0.01")) assertTrue(result.isFailure)
            else assertEquals("1000000.00", result.getOrThrow().priceUsd)
        }
        assertTrue(deriveBitcoinBuy("", "", "1").isFailure)
        assertNotNull(quickAddAmountError("0.001", DisplayUnit.USD))
        assertNotNull(quickAddAmountError("1.1", DisplayUnit.SATS))
        assertEquals(null, quickAddAmountError("0.00000001", DisplayUnit.BTC))
    }
    @Test fun `suggestions rank six categories and use household not visible child history`() {
        fun row(id: String, category: String, owner: FamilyMember = FamilyMember.VICTOR) =
            Transaction(id, "2026-09-13", id, 100, category, owner = owner)
        val rows = listOf(row("a", "C"), row("b", "C"), row("c", "B"), row("private", "G", FamilyMember.MASON))
        val result = quickAddSuggestions(rows, FamilyMember.RACHEL, listOf("A", "B", "C", "D", "E", "F", "G"))
        assertEquals("C", result.lastCategory)
        assertEquals(listOf("C", "B", "A", "D", "E", "F"), result.categories)
        assertEquals(listOf("a", "b", "c"), result.merchants)
        assertEquals(listOf("private"), quickAddSuggestions(rows, FamilyMember.MASON, listOf("G")).merchants)
    }
}
