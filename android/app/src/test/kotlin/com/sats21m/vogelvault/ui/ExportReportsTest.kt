package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.BudgetCategory
import com.sats21m.vogelvault.domain.BillPayBudgetEffect
import com.sats21m.vogelvault.domain.BtcBillPay
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Transaction
import java.io.File
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ExportReportsTest {
    @Test
    fun `transaction export keeps shared adults and excludes child rows`() {
        val data = Fixtures.envelope(FamilyMember.VICTOR).copy(
            transactions = Fixtures.envelope(FamilyMember.VICTOR).transactions.copy(
                value = listOf(
                    transaction("victor-purchase", 1_234L, FamilyMember.VICTOR),
                    transaction("rachel-refund", -250L, FamilyMember.RACHEL),
                    transaction("mason-purchase", 999L, FamilyMember.MASON),
                ),
            ),
        )

        val csv = ExportReports.transactions(
            FamilyMember.VICTOR,
            data,
            LocalDate.parse("2026-07-29"),
        )

        assertContains(csv.content, "victor-purchase")
        assertContains(csv.content, "12.34")
        assertContains(csv.content, "rachel-refund")
        assertContains(csv.content, "-2.50")
        assertFalse(csv.content.contains("mason-purchase"), csv.content)
    }

    @Test
    fun `child transaction export is self only`() {
        val fixture = Fixtures.envelope(FamilyMember.MASON)
        val data = fixture.copy(
            transactions = fixture.transactions.copy(
                value = listOf(
                    transaction("adult", 100L, FamilyMember.VICTOR),
                    transaction("mason", 200L, FamilyMember.MASON),
                    transaction("maddox", 300L, FamilyMember.MADDOX),
                ),
            ),
        )

        val csv = ExportReports.transactions(
            FamilyMember.MASON,
            data,
            LocalDate.parse("2026-07-29"),
        )

        assertFalse(csv.content.contains("adult"), csv.content)
        assertContains(csv.content, "mason")
        assertFalse(csv.content.contains("maddox"), csv.content)
    }

    @Test
    fun `transaction export renders a known payment-source label and preserves a legacy card`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR)
        val data = fixture.copy(
            transactions = fixture.transactions.copy(
                value = listOf(
                    transaction(
                        merchant = "canonical-wire",
                        amount = 100L,
                        owner = FamilyMember.VICTOR,
                        card = "coinbase_card",
                    ),
                    transaction(
                        merchant = "legacy-card",
                        amount = 200L,
                        owner = FamilyMember.VICTOR,
                        card = "Fold card",
                    ),
                ),
            ),
        )

        val csv = ExportReports.transactions(
            FamilyMember.VICTOR,
            data,
            LocalDate.parse("2026-07-29"),
        )

        assertContains(csv.content, "canonical-wire,1.00,Groceries,Coinbase Card")
        assertFalse(csv.content.contains("coinbase_card"), csv.content)
        assertContains(csv.content, "legacy-card,2.00,Groceries,Fold card")
    }

    @Test
    fun `transaction export renders a missing payment source as On-chain`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR)
        val data = fixture.copy(
            transactions = fixture.transactions.copy(
                value = listOf(
                    transaction(
                        merchant = "missing-source",
                        amount = 100L,
                        owner = FamilyMember.VICTOR,
                        card = null,
                    ),
                ),
            ),
        )

        val csv = ExportReports.transactions(
            FamilyMember.VICTOR,
            data,
            LocalDate.parse("2026-07-29"),
        )

        assertContains(csv.content, "missing-source,1.00,Groceries,On-chain")
    }

    @Test
    fun `budget summary preserves purchase and refund signs without child spend`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR)
        val budget = Budget(
            month = "2026-07",
            categories = listOf(BudgetCategory("Groceries", 10_000L, 0L)),
            owner = FamilyMember.VICTOR,
        )
        val data = fixture.copy(
            budget = fixture.budget.copy(value = budget),
            transactions = fixture.transactions.copy(
                value = listOf(
                    transaction("purchase", 2_000L, FamilyMember.VICTOR),
                    transaction("refund", -500L, FamilyMember.RACHEL),
                    transaction("child", 8_000L, FamilyMember.MASON),
                ),
            ),
        )

        val csv = ExportReports.budgetSummary(FamilyMember.VICTOR, data)

        assertContains(csv.content, "Groceries,100.00,15.00,85.00,15%")
    }

    @Test
    fun `budget export includes budget-category bill pays and excludes credit-card payments`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR)
        val budget = Budget(
            month = "2026-07",
            categories = listOf(BudgetCategory("Groceries", 10_000L, 0L)),
            owner = FamilyMember.VICTOR,
        )
        val budgetBillPay = billPay(
            id = "budget-bill-pay",
            amountCents = 2_000L,
            effect = BillPayBudgetEffect.BUDGET_CATEGORY,
        )
        val creditCardPayment = billPay(
            id = "credit-card-payment",
            amountCents = 99_999L,
            effect = BillPayBudgetEffect.CREDIT_CARD_PAYMENT,
        )
        val data = fixture.copy(
            budget = fixture.budget.copy(value = budget),
            transactions = fixture.transactions.copy(value = emptyList()),
            btcBillPays = fixture.btcBillPays.copy(
                status = com.sats21m.vogelvault.domain.Freshness.LIVE,
                value = listOf(budgetBillPay, creditCardPayment),
            ),
        )

        val csv = ExportReports.budgetSummary(FamilyMember.VICTOR, data)

        assertContains(csv.content, "Groceries,100.00,20.00,80.00,20%")
        assertFalse(csv.content.contains("999.99"), csv.content)
    }

    @Test
    fun `budget export marks actuals unavailable when bill-pay ledger fails`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR)
        val budget = Budget(
            month = "2026-07",
            categories = listOf(BudgetCategory("Groceries", 10_000L, 0L)),
            owner = FamilyMember.VICTOR,
        )
        val data = fixture.copy(
            budget = fixture.budget.copy(value = budget),
            transactions = fixture.transactions.copy(value = emptyList()),
            btcBillPays = fixture.btcBillPays.copy(
                status = com.sats21m.vogelvault.domain.Freshness.ERROR,
                value = listOf(
                    billPay(
                        id = "stale-bill-pay",
                        amountCents = 2_000L,
                        effect = BillPayBudgetEffect.BUDGET_CATEGORY,
                    ),
                ),
            ),
        )

        val csv = ExportReports.budgetSummary(FamilyMember.VICTOR, data)

        assertEquals(
            "Category,Budget,Actual,Remaining,Percent Used\nUNAVAILABLE,,,,\n",
            csv.content,
        )
    }

    @Test
    fun `net worth export recomputes adult total without child accounts`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR)
        val adult = account("adult", 12_345L, FamilyMember.VICTOR)
        val child = account("child", 98_765L, FamilyMember.MASON)
        val balance = BtcBalance(
            owner = FamilyMember.VICTOR,
            asOf = "2026-07-28",
            accounts = listOf(adult, child),
            totalSats = adult.sats + child.sats,
            fiatCents = adult.fiatCents + child.fiatCents,
            exchangeSats = adult.sats + child.sats,
            selfCustodySats = 0L,
        )
        val data = fixture.copy(btcBalance = fixture.btcBalance.copy(value = balance))

        val csv = ExportReports.netWorthHistory(
            FamilyMember.VICTOR,
            data,
            LocalDate.parse("2026-07-29"),
        )

        assertContains(csv.content, "2026-07-28,123.45,123.45")
        assertFalse(csv.content.contains("1111.10"), csv.content)
    }

    @Test
    fun `overflowing account total degrades the export instead of crashing the click`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR)
        val nearMax = account("near-max", Long.MAX_VALUE, FamilyMember.VICTOR)
        val overflow = account("overflow", 1L, FamilyMember.RACHEL)
        val balance = BtcBalance(
            owner = FamilyMember.VICTOR,
            asOf = "2026-07-28",
            accounts = listOf(nearMax, overflow),
            totalSats = 0L,
            fiatCents = 0L,
            exchangeSats = 0L,
            selfCustodySats = 0L,
        )
        val data = fixture.copy(btcBalance = fixture.btcBalance.copy(value = balance))

        val csv = ExportReports.netWorthHistory(
            FamilyMember.VICTOR,
            data,
            LocalDate.parse("2026-07-29"),
        )

        assertEquals("Date,Total USD,BTC USD\n", csv.content)
    }

    @Test
    fun `export cleanup removes leftover csv files from the exports cache directory`() {
        val context = RuntimeEnvironment.getApplication()
        val exportDirectory = File(context.cacheDir, "exports").apply { mkdirs() }
        File(exportDirectory, "transactions-2026-07-29.csv").writeText("Date,Merchant\n")
        File(exportDirectory, "budget-2026-07.csv").writeText("Category,Budget\n")
        val subdirectory = File(exportDirectory, "keep-dir").apply { mkdirs() }

        purgeExportedCsvFiles(context)

        assertTrue(exportDirectory.isDirectory)
        assertEquals(listOf("keep-dir"), exportDirectory.listFiles()?.map { it.name })
        subdirectory.delete()
    }

    @Test
    fun `csv escaping preserves commas quotes and newlines`() {
        val fixture = Fixtures.envelope(FamilyMember.MASON)
        val data = fixture.copy(
            transactions = fixture.transactions.copy(
                value = listOf(
                    transaction(
                        merchant = "Shop, \"North\"\nDesk",
                        amount = 100L,
                        owner = FamilyMember.MASON,
                    ),
                ),
            ),
        )

        val csv = ExportReports.transactions(
            FamilyMember.MASON,
            data,
            LocalDate.parse("2026-07-29"),
        )

        assertContains(csv.content, "\"Shop, \"\"North\"\"\nDesk\"")
        assertEquals("transactions-2026-07-29.csv", csv.filename)
    }

    @Test
    fun `user controlled cells are formula neutralized without changing signed money`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR)
        val dangerous =
            Transaction(
                id = "formula",
                date = "2026-07-20",
                merchant = "=HYPERLINK(\"https://example.invalid\")",
                amount = -250L,
                spendAmount = -250L,
                category = "+SUM(A1:A2)",
                card = "@command",
                note = "  -2+3",
                owner = FamilyMember.VICTOR,
            )
        val data = fixture.copy(
            transactions = fixture.transactions.copy(value = listOf(dangerous)),
        )

        val csv = ExportReports.transactions(
            FamilyMember.VICTOR,
            data,
            LocalDate.parse("2026-07-29"),
        )

        assertContains(csv.content, "\"'=HYPERLINK(\"\"https://example.invalid\"\")\"")
        assertContains(
            csv.content,
            "-2.50",
            message = "signed numeric columns must remain numeric",
        )
        assertContains(csv.content, "'+SUM(A1:A2)")
        assertContains(csv.content, "'@command")
        assertContains(csv.content, "'  -2+3")
        assertFalse(csv.content.contains(",'-2.50,"), csv.content)
    }

    private fun billPay(
        id: String,
        amountCents: Long,
        effect: BillPayBudgetEffect,
    ) = BtcBillPay(
        id = id,
        date = "2026-07-20",
        merchant = id,
        category = "Groceries",
        budgetEffect = effect,
        amountUsdCents = amountCents,
        btcSpentSats = 1_000L,
        btcPriceCents = 200_000L,
        feeUsdCents = 0L,
        platform = "river_bitcoin_bill_pay",
        note = null,
        owner = FamilyMember.VICTOR,
    )

    private fun transaction(
        merchant: String,
        amount: Long,
        owner: FamilyMember,
        card: String? = null,
    ) = Transaction(
        id = "$owner-$merchant",
        date = "2026-07-20",
        merchant = merchant,
        amount = amount,
        spendAmount = amount,
        category = "Groceries",
        card = card,
        owner = owner,
    )

    private fun account(
        key: String,
        fiatCents: Long,
        owner: FamilyMember,
    ) = BtcAccount(
        key = key,
        label = key,
        custody = Custody.EXCHANGE,
        sats = fiatCents,
        fiatCents = fiatCents,
        owner = owner,
    )
}
