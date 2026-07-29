package com.sats21m.vogelvault.csvimport

import com.sats21m.vogelvault.data.TransactionKind
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Transaction
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class CsvImportServiceTest {
    private val service = CsvImportService()

    @Test
    fun `positive custom purchase stays positive and is not income`() {
        val imported = parse(
            """
            date,amount,memo
            2026-05-01,500,Costco
            """,
            CsvImportSource.CUSTOM,
        )

        assertEquals(1, imported.size)
        assertEquals(500L, imported.single().sats)
        assertEquals(50L, imported.single().amountUsdCents)
        assertEquals("Groceries", imported.single().category)
        assertFalse(imported.single().isIncome)

        val prepared = service.prepareTransactions(imported, FamilyMember.VICTOR).single()
        assertEquals(50L, prepared.transaction.amountCents)
        assertEquals(TransactionKind.SPEND, prepared.transaction.kind)
    }

    @Test
    fun `negative refund preserves both sats and fiat signs`() {
        val imported = parse(
            """
            date,amount,memo
            2026-05-01,-500,Costco refund
            """,
            CsvImportSource.CUSTOM,
        )

        assertEquals(-500L, imported.single().sats)
        assertEquals(-50L, imported.single().amountUsdCents)
        assertEquals("Groceries", imported.single().category)
        assertFalse(imported.single().isIncome)

        val prepared = service.prepareTransactions(imported, FamilyMember.MASON).single()
        assertEquals(-50L, prepared.transaction.amountCents)
        assertEquals(TransactionKind.CREDIT, prepared.transaction.kind)
        assertEquals("mason-transactions", prepared.sourceFile)
    }

    @Test
    fun `bitcoin and fiat remain separate integer units`() {
        val imported = service.parse(
            """
            date,amount,memo
            2026-05-01,0.01,Strike DCA
            """.trimIndent().toByteArray(),
            CsvImportSource.CUSTOM,
            btcPriceCents = 9_000_000L,
        ).single()

        assertEquals(1_000_000L, imported.sats)
        assertEquals(90_000L, imported.amountUsdCents)
    }

    @Test
    fun `all six source mappings locate their date amount and memo`() {
        val cases = listOf(
            CsvImportSource.STRIKE to
                "Date,Amount BTC,Type,Memo\n2026-05-01,0.000005,Buy,Strike DCA",
            CsvImportSource.CASH_APP to
                "Date,Asset Amount,Fee,Notes\n2026-05-01,0.000005,0,Cash App buy",
            CsvImportSource.COINBASE to
                "Timestamp,Quantity,Transaction Type\n2026-05-01T12:00:00Z,0.000005,Coinbase buy",
            CsvImportSource.KRAKEN to
                "time,asset,amount,fee,type\n2026-05-01 12:00:00,XXBT,500,0,Kraken buy",
            CsvImportSource.SELF_CUSTODY to
                "date,sats,description\n2026-05-01,500,Node receive",
            CsvImportSource.CUSTOM to
                "when_date,qty,narrative\n2026-05-01,500,Custom row",
        )

        cases.forEach { (source, csv) ->
            val row = parse(csv, source).single()
            assertEquals(500L, row.sats, source.name)
            assertNotEquals(source.label, row.merchant, source.name)
        }
    }

    @Test
    fun `quoted commas escaped quotes and line breaks stay in one memo`() {
        val row = parse(
            "date,amount,memo\n2026-05-01,500,\"Coffee, \"\"beans\"\"\nand more\"",
            CsvImportSource.CUSTOM,
        ).single()

        assertEquals("Coffee, \"beans\"\nand more", row.merchant)
    }

    @Test
    fun `duplicate filtering shares adults but excludes child balances`() {
        val imported = parse(
            "date,amount,memo\n2026-05-01,500,Costco",
            CsvImportSource.CUSTOM,
        )
        val adultMatch = transaction(FamilyMember.VICTOR)
        val childMatch = transaction(FamilyMember.MASON)

        assertTrue(
            service.filterDuplicates(imported, listOf(adultMatch), FamilyMember.RACHEL).isEmpty(),
            "Rachel must deduplicate against the shared adult household",
        )
        assertEquals(
            imported,
            service.filterDuplicates(imported, listOf(childMatch), FamilyMember.VICTOR),
            "A child row must not suppress an adult-household import",
        )
        assertTrue(
            service.filterDuplicates(imported, listOf(childMatch), FamilyMember.MASON).isEmpty(),
            "A child must deduplicate against their own rows",
        )
    }

    @Test
    fun `same file produces stable row ids for idempotent retries`() {
        val csv = "date,amount,memo\n2026-05-01,500,Costco"

        val first = parse(csv, CsvImportSource.CUSTOM).single().id
        val second = parse(csv, CsvImportSource.CUSTOM).single().id

        assertEquals(first, second)
    }

    @Test
    fun `unknown price never becomes a confident zero dollar transaction`() {
        val imported = service.parse(
            "date,amount,memo\n2026-05-01,500,Costco".toByteArray(),
            CsvImportSource.CUSTOM,
            btcPriceCents = null,
        )

        assertEquals(null, imported.single().amountUsdCents)
        assertFailsWith<CsvImportException.PriceUnavailable> {
            service.prepareTransactions(imported, FamilyMember.VICTOR)
        }
    }

    @Test
    fun `missing required columns and bad rows report the row`() {
        assertFailsWith<CsvImportException.MissingRequiredColumns> {
            parse("merchant,category\nCostco,Groceries", CsvImportSource.CUSTOM)
        }
        assertEquals(
            "Could not parse the amount on row 2",
            assertFailsWith<CsvImportException.AmountParseFailure> {
                parse("date,amount\n2026-05-01,nope", CsvImportSource.CUSTOM)
            }.message,
        )
    }

    private fun parse(
        csv: String,
        source: CsvImportSource,
    ): List<CsvImportedTransaction> =
        service.parse(
            csv.trimIndent().toByteArray(),
            source,
            btcPriceCents = 10_000_000L,
        )

    private fun transaction(owner: FamilyMember) = Transaction(
        id = "existing-${owner.key}",
        date = "2026-05-01",
        merchant = "Costco",
        amount = 50L,
        category = "Groceries",
        owner = owner,
    )
}
