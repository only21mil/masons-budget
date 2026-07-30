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
    fun `unsigned amount with a type column signs purchases and refunds apart`() {
        val imported = parse(
            """
            date,amount,type,memo
            2026-05-01,500,Purchase,Costco
            2026-05-02,500,Refund,Costco return
            """,
            CsvImportSource.CUSTOM,
        )

        assertEquals(2, imported.size)
        val (purchase, refund) = imported
        assertEquals(500L, purchase.sats, "an unsigned purchase stays positive")
        assertEquals(50L, purchase.amountUsdCents)
        assertEquals(-500L, refund.sats, "an unsigned refund must be signed by its type column")
        assertEquals(-50L, refund.amountUsdCents)

        val prepared = service.prepareTransactions(imported, FamilyMember.VICTOR)
        assertEquals(TransactionKind.SPEND, prepared[0].transaction.kind)
        assertEquals(50L, prepared[0].transaction.amountCents)
        assertEquals(TransactionKind.CREDIT, prepared[1].transaction.kind)
        assertEquals(-50L, prepared[1].transaction.amountCents)
    }

    @Test
    fun `unsigned debit and credit tokens set direction`() {
        val imported = parse(
            """
            date,amount,type,memo
            2026-05-01,1200,DEBIT,Shell gas
            2026-05-02,1200,CREDIT,Shell gas reversal
            """,
            CsvImportSource.CUSTOM,
        )

        assertEquals(1200L, imported[0].sats)
        assertEquals(-1200L, imported[1].sats)
        assertEquals(
            TransactionKind.CREDIT,
            service.prepareTransactions(imported, FamilyMember.VICTOR)[1].transaction.kind,
        )
    }

    @Test
    fun `kind is checked against the type column not the amount it came from`() {
        val refund = parse(
            "date,amount,type,memo\n2026-05-01,500,Refund,Costco return",
            CsvImportSource.CUSTOM,
        ).single()
        // Simulate a future regression that stops applying the type column: the
        // stored money says purchase while the source cell still says refund.
        val regressed = refund.copy(sats = 500L, amountUsdCents = 50L)

        val failure = assertFailsWith<CsvImportException.SignContradiction> {
            service.prepareTransactions(listOf(regressed), FamilyMember.VICTOR)
        }
        assertTrue(
            failure.message!!.contains("Refund"),
            "the rejection must name what the source said: ${failure.message}",
        )
    }

    @Test
    fun `a sign and type contradiction rejects the row naming what each source said`() {
        // Most banks export purchases negative while this app stores them positive,
        // so "-500,Purchase" is genuinely ambiguous: a refund of 500 under the
        // app's convention, a purchase of 500 under the bank's. Neither reading may
        // be picked silently, so nothing imports.
        assertEquals(
            "Row 2 contradicts itself: its amount \"-500\" says a refund but its type " +
                "\"Purchase\" says a purchase. Nothing was imported because neither " +
                "source can be trusted over the other; correct the row or drop one of " +
                "the two columns, then import again",
            assertFailsWith<CsvImportException.SignTypeContradiction> {
                parse(
                    "date,amount,type,memo\n2026-05-01,-500,Purchase,Costco",
                    CsvImportSource.CUSTOM,
                )
            }.message,
        )
    }

    @Test
    fun `a contradicted row is refused again on the way to the write client`() {
        val clean = parse(
            "date,amount,type,memo\n2026-05-01,500,Purchase,Costco",
            CsvImportSource.CUSTOM,
        ).single()
        // Simulate a future regression that stops rejecting at parse and hands a
        // contradicted row to the import button: prepareTransactions is the last
        // thing between these cells and a signed write, so it must refuse too.
        val contradicted = clean.copy(amountCell = "-500")

        val failure = assertFailsWith<CsvImportException.SignTypeContradiction> {
            service.prepareTransactions(listOf(contradicted), FamilyMember.VICTOR)
        }
        assertTrue(
            failure.message!!.contains("its amount \"-500\" says a refund") &&
                failure.message!!.contains("its type \"Purchase\" says a purchase"),
            "the rejection must name both sources: ${failure.message}",
        )
    }

    @Test
    fun `a sign that agrees with its type column is a convention not a contradiction`() {
        val refund = parse(
            "date,amount,type,memo\n2026-05-01,-500,Refund,Costco return",
            CsvImportSource.CUSTOM,
        ).single()
        val purchase = parse(
            "date,amount,type,memo\n2026-05-01,+500,Purchase,Costco",
            CsvImportSource.CUSTOM,
        ).single()

        assertEquals(-500L, refund.sats, "a signed refund typed Refund must still import")
        assertEquals(CsvDirectionEvidence.AMOUNT_SIGN, refund.signContract.evidence)
        assertEquals(500L, purchase.sats, "a signed purchase typed Purchase must still import")
        assertEquals(CsvDirectionEvidence.AMOUNT_SIGN, purchase.signContract.evidence)

        assertEquals(
            TransactionKind.CREDIT,
            service.prepareTransactions(listOf(refund), FamilyMember.VICTOR).single().transaction.kind,
        )
        assertEquals(
            TransactionKind.SPEND,
            service.prepareTransactions(listOf(purchase), FamilyMember.VICTOR).single().transaction.kind,
        )
    }

    @Test
    fun `a type cell naming both directions is never guessed at`() {
        val row = parse(
            "date,amount,type,memo\n2026-05-01,500,Credit Card Purchase,Costco",
            CsvImportSource.CUSTOM,
        ).single()

        assertEquals(500L, row.sats)
        assertEquals(CsvDirectionEvidence.DEFAULTED, row.signContract.evidence)
    }

    @Test
    fun `income keeps its positive house sign and rejects a negative amount by name`() {
        val deposit = parse(
            "date,amount,type,memo\n2026-05-01,100000,Credit,Direct Deposit",
            CsvImportSource.CUSTOM,
        ).single()

        assertEquals("Income", deposit.category)
        assertEquals(100_000L, deposit.sats, "income is stored positive with kind CREDIT")
        val prepared = service.prepareTransactions(listOf(deposit), FamilyMember.VICTOR).single()
        assertEquals(TransactionKind.CREDIT, prepared.transaction.kind)
        assertEquals(10_000L, prepared.transaction.amountCents)

        assertEquals(
            "Row 2 is income but its amount is negative; income must be positive",
            assertFailsWith<CsvImportException.IncomeSignContradiction> {
                parse("date,amount,memo\n2026-05-01,-100000,Direct Deposit", CsvImportSource.CUSTOM)
            }.message,
        )
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
    fun `cash app persists asset amount when generic fiat amount appears first`() {
        val imported = parse(
            """
            Date,Amount,Asset Amount,Fee,Notes
            2026-05-01,50.00,0.000005,0,Cash App buy
            """,
            CsvImportSource.CASH_APP,
        ).single()

        assertEquals(500L, imported.sats)
        assertEquals(50L, imported.amountUsdCents)

        val prepared = service.prepareTransactions(
            listOf(imported),
            FamilyMember.VICTOR,
        ).single()
        assertEquals(50L, prepared.transaction.amountCents)
        assertEquals("Imported from Cash App; 500 sats", prepared.transaction.note)
    }

    @Test
    fun `custom import rejects amount columns that share its best available match`() {
        val failure = assertFailsWith<CsvImportException.AmbiguousAmountColumns> {
            parse(
                """
                date,Amount,Asset Amount,memo
                2026-05-01,50.00,0.000005,Custom buy
                """,
                CsvImportSource.CUSTOM,
            )
        }

        assertEquals(
            "Multiple amount columns matched the same CSV preference: \"Amount\", " +
                "\"Asset Amount\". Nothing was imported because the app cannot safely " +
                "choose between financial columns",
            failure.message,
        )
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
        assertTrue(first.matches(Regex("""csv-[0-9a-f]{24}""")))
    }

    @Test
    fun `stable row id detects a retry even when the Bitcoin price changed`() {
        val csv = "date,amount,memo\n2026-05-01,500,Costco"
        val first = parse(csv, CsvImportSource.CUSTOM).single()
        val retryAtDifferentPrice = service.parse(
            csv.toByteArray(),
            CsvImportSource.CUSTOM,
            btcPriceCents = 20_000_000L,
        )
        val existing = transaction(FamilyMember.VICTOR).copy(
            id = first.id,
            amount = first.amountUsdCents!!,
        )

        assertTrue(
            service.filterDuplicates(
                retryAtDifferentPrice,
                listOf(existing),
                FamilyMember.RACHEL,
            ).isEmpty(),
        )
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
