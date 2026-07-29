package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.TransactionKind
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class AddTransactionSheetTest {
    @Test
    fun `fiat purchase reaches the payload as positive integer cents`() {
        val prepared = prepare(
            amount = "142.18",
            unit = DisplayUnit.USD,
            owner = FamilyMember.VICTOR,
        )

        assertEquals(14_218L, prepared.input.amountCents)
        assertEquals(TransactionKind.SPEND, prepared.input.kind)
        assertEquals("transactions", prepared.sourceFile)
    }

    @Test
    fun `income and transfer preserve the server sign convention`() {
        val income = prepare(
            amount = "21.00",
            unit = DisplayUnit.USD,
            type = AddTransactionType.INCOME,
            category = "Ignored",
        )
        val transfer = prepare(
            amount = "21.00",
            unit = DisplayUnit.USD,
            type = AddTransactionType.TRANSFER,
            category = "",
        )

        assertEquals(2_100L, income.input.amountCents)
        assertEquals(TransactionKind.CREDIT, income.input.kind)
        assertEquals("Income", income.input.category)
        assertEquals(2_100L, transfer.input.amountCents)
        assertEquals(TransactionKind.SPEND, transfer.input.kind)
        assertEquals("Transfer", transfer.input.category)
    }

    @Test
    fun `btc and sats input convert through the integer cent price without doubles`() {
        val oneBtc = prepare("1.00000000", DisplayUnit.BTC)
        val halfPriceInSats = prepare("50,000,000", DisplayUnit.SATS)

        assertEquals(BTC_PRICE_CENTS, oneBtc.input.amountCents)
        assertEquals(100_000_000L, oneBtc.sats)
        assertEquals(BTC_PRICE_CENTS / 2L, halfPriceInSats.input.amountCents)
        assertEquals(50_000_000L, halfPriceInSats.sats)
    }

    @Test
    fun `switching the sheet input unit converts the entered value`() {
        assertEquals(
            "100000000",
            convertAmountForUnit("117000.00", DisplayUnit.USD, DisplayUnit.SATS, BTC_PRICE_CENTS),
        )
        assertEquals(
            "0.5",
            convertAmountForUnit("50000000", DisplayUnit.SATS, DisplayUnit.BTC, BTC_PRICE_CENTS),
        )
        assertEquals(
            "58500.00",
            convertAmountForUnit("0.5", DisplayUnit.BTC, DisplayUnit.USD, BTC_PRICE_CENTS),
        )
    }

    @Test
    fun `child transactions use the child source file and never the adult file`() {
        listOf(FamilyMember.MASON, FamilyMember.MADDOX).forEach { owner ->
            val prepared = prepare("1.00", DisplayUnit.USD, owner = owner)

            assertEquals("${owner.key}-transactions", prepared.sourceFile)
            assertEquals(owner, prepared.input.owner)
            assertTrue(prepared.sourceFile != "transactions")
        }
    }

    @Test
    fun `unsupported precision and unavailable conversion price fail closed`() {
        assertFails {
            prepare("1.001", DisplayUnit.USD)
        }
        assertFails {
            prepare("1.5", DisplayUnit.SATS)
        }
        assertFails {
            prepareTransaction(
                draft(amount = "100", unit = DisplayUnit.SATS),
                btcPriceCents = 0L,
                id = "test-id",
            ).getOrThrow()
        }
    }

    @Test
    fun `sub-cent bitcoin conversion is rejected rather than stored as zero`() {
        assertFails {
            prepare("1", DisplayUnit.SATS)
        }
    }

    @Test
    fun `disabled and not configured writes name different causes`() {
        val disabled = assertNotNull(transactionWriteFailureMessage(ConvexResult.Disabled))
        val notConfigured = assertNotNull(
            transactionWriteFailureMessage(ConvexResult.NotConfigured),
        )

        assertNotEquals(disabled, notConfigured)
        assertTrue(disabled.contains("switched off"))
        assertTrue(notConfigured.contains("deployment"))
        assertTrue(notConfigured.contains("token"))
    }

    private fun prepare(
        amount: String,
        unit: DisplayUnit,
        owner: FamilyMember = FamilyMember.VICTOR,
        type: AddTransactionType = AddTransactionType.SPEND,
        category: String = "Groceries",
    ) = prepareTransaction(
        draft(amount, unit, owner, type, category),
        btcPriceCents = BTC_PRICE_CENTS,
        id = "test-id",
    ).getOrThrow()

    private fun draft(
        amount: String,
        unit: DisplayUnit,
        owner: FamilyMember = FamilyMember.VICTOR,
        type: AddTransactionType = AddTransactionType.SPEND,
        category: String = "Groceries",
    ) = AddTransactionDraft(
        type = type,
        merchant = "Neighborhood Market",
        category = category,
        amount = amount,
        inputUnit = unit,
        card = "Debit",
        date = LocalDate.parse("2026-07-29"),
        note = "Regression test",
        owner = owner,
    )

    private companion object {
        const val BTC_PRICE_CENTS = 11_700_000L
    }
}
