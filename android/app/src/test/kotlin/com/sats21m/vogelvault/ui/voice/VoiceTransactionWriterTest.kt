package com.sats21m.vogelvault.ui.voice

import com.sats21m.vogelvault.data.TransactionKind
import com.sats21m.vogelvault.domain.FamilyMember
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class VoiceTransactionWriterTest {
    @Test
    fun `reviewed purchase remains positive spend for every owner`() {
        FamilyMember.entries.forEach { owner ->
            val input = draft(amountCents = 2_199L, owner = owner).toTransactionInput("tx-1")
            assertEquals(2_199L, input.amountCents)
            assertEquals(TransactionKind.SPEND, input.kind)
            assertEquals(owner, input.owner)
        }
    }

    @Test
    fun `adult writes share one source while child writes remain isolated`() {
        assertEquals("transactions", draft(owner = FamilyMember.VICTOR).toUpsertMutation("v").sourceFile)
        assertEquals("transactions", draft(owner = FamilyMember.RACHEL).toUpsertMutation("r").sourceFile)
        assertEquals(
            "mason-transactions",
            draft(owner = FamilyMember.MASON).toUpsertMutation("m").sourceFile,
        )
        assertEquals(
            "maddox-transactions",
            draft(owner = FamilyMember.MADDOX).toUpsertMutation("x").sourceFile,
        )
    }

    @Test
    fun `reviewed refund remains negative credit`() {
        val input = draft(amountCents = -2_199L).toTransactionInput("tx-refund")
        assertEquals(-2_199L, input.amountCents)
        assertEquals(TransactionKind.CREDIT, input.kind)
    }

    @Test
    fun `reviewed income remains positive credit`() {
        val input =
            draft(
                amountCents = 150_000L,
                category = "income",
            ).toTransactionInput("tx-income")
        assertEquals(150_000L, input.amountCents)
        assertEquals(TransactionKind.CREDIT, input.kind)
        assertEquals("Income", input.category)
    }

    @Test
    fun `invalid reviewed signs and zero are rejected rather than corrected`() {
        assertFailsWith<IllegalArgumentException> {
            draft(amountCents = -1L, category = "Income").toTransactionInput("bad-income")
        }
        assertFailsWith<IllegalArgumentException> {
            draft(amountCents = 0L).toTransactionInput("zero")
        }
    }

    @Test
    fun `optional fields are trimmed and blank fields are omitted`() {
        val input =
            draft()
                .copy(
                    merchant = "  Costco ",
                    category = " Groceries ",
                    card = " ",
                    note = " cake ",
                ).toTransactionInput("tx-trim")
        assertEquals("Costco", input.merchant)
        assertEquals("Groceries", input.category)
        assertNull(input.card)
        assertEquals("cake", input.note)
    }

    @Test
    fun `editable amount parser accepts cents and rejects rounding`() {
        assertEquals(4_500L, "45".toExactCents())
        assertEquals(-1_250L, "-12.50".toExactCents())
        assertEquals(123_456L, "$1,234.56".toExactCents())
        assertNull("12.345".toExactCents())
        assertNull("999999999999999999".toExactCents())
    }

    private fun draft(
        amountCents: Long = 4_500L,
        category: String = "Groceries",
        owner: FamilyMember = FamilyMember.VICTOR,
    ) = VoiceTransactionDraft(
        amountCents = amountCents,
        merchant = "Costco",
        category = category,
        date = LocalDate.of(2026, 7, 29),
        card = "Strike",
        note = null,
        owner = owner,
    )
}
