package com.sats21m.vogelvault.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Read model and fixture behaviour.
 *
 * Several of these guard bugs that actually shipped in the Linux client before a
 * screenshot caught them. They are cheaper to catch here.
 */
class ReadModelTest {
    @Test
    fun `production signs keep purchases positive and refunds negative in budget actuals`() {
        fun row(id: String, owner: FamilyMember, amount: Long) = Transaction(
            id = id,
            date = "2026-03-15",
            merchant = id,
            amount = amount,
            category = "Shopping",
            owner = owner,
        )
        val adultPurchase = row("Etsy", FamilyMember.VICTOR, 3_762L)
        val adultRefund = row("Paypal *ebay", FamilyMember.VICTOR, -123_469L)
        val childPurchase = row("Mason purchase", FamilyMember.MASON, 3_762L)
        val budget = Budget(
            month = "2026-03",
            categories = listOf(BudgetCategory("Shopping", 200_000L, 0L)),
            owner = FamilyMember.VICTOR,
        )
        val monthRows = listOf(
            adultPurchase,
            row("Production-sized purchase", FamilyMember.VICTOR, 123_469L),
            adultRefund,
        )

        assertEquals(3_762L, adultPurchase.spendAmount)
        assertFalse(adultPurchase.hasOppositeSpendSign)
        assertEquals(-123_469L, adultRefund.spendAmount)
        assertTrue(adultRefund.hasOppositeSpendSign)
        assertEquals(3_762L, childPurchase.spendAmount)
        assertFalse(childPurchase.hasOppositeSpendSign)
        assertEquals(3_762L, requireNotNull(deriveBudgetSpend(budget, monthRows)).actualCents)
    }

    @Test
    fun `row credits reduce derived budget spend while rendering as a magnitude`() {
        val budget = Budget(
            month = "2026-07",
            categories = listOf(BudgetCategory("Groceries", 50_000L, 0L)),
            owner = FamilyMember.VICTOR,
        )
        val rows = listOf(
            Transaction(
                id = "purchase",
                date = "2026-07-10",
                merchant = "Market",
                amount = 10_000L,
                category = "Groceries",
                owner = FamilyMember.VICTOR,
            ),
            Transaction(
                id = "credit",
                date = "2026-07-11",
                merchant = "Market credit",
                amount = -2_500L,
                category = "Groceries",
                owner = FamilyMember.VICTOR,
            ),
        )

        assertEquals(-2_500L, rows.last().spendAmount)
        assertEquals(2_500L, rows.last().displaySpendAmount)
        assertTrue(rows.last().hasOppositeSpendSign)
        assertEquals(7_500L, requireNotNull(deriveBudgetSpend(budget, rows)).actualCents)
    }


    // ── The Maddox budget leak ──────────────────────────────────────────────

    @Test
    fun `budget is per owner with no fall-through to the adult budget`() {
        // The Linux client defaulted any non-Mason profile to the adult budget,
        // which showed household categories to Maddox.
        val victor = Fixtures.envelope(FamilyMember.VICTOR).budget.value
        val rachel = Fixtures.envelope(FamilyMember.RACHEL).budget.value
        val mason = Fixtures.envelope(FamilyMember.MASON).budget.value
        val maddox = Fixtures.envelope(FamilyMember.MADDOX).budget.value

        assertNotNull(victor)
        assertNotNull(rachel)
        assertEquals(FamilyMember.VICTOR, victor.owner, "adults share one household budget")
        assertEquals(victor, rachel, "Victor and Rachel see the identical budget")

        assertNotNull(mason)
        assertEquals(FamilyMember.MASON, mason.owner)

        assertNull(maddox, "Maddox has no dedicated budget data, so his slice is empty")
    }

    @Test
    fun `no household category reaches a child budget`() {
        val householdCategories = Fixtures.envelope(FamilyMember.VICTOR).budget.value!!
            .categories.map { it.name }.toSet()
        val masonCategories = Fixtures.envelope(FamilyMember.MASON).budget.value!!
            .categories.map { it.name }.toSet()

        assertFalse(
            masonCategories.contains("Groceries"),
            "household categories must not appear in a child budget",
        )
        assertTrue(masonCategories.isNotEmpty())
        assertTrue((masonCategories - householdCategories).isNotEmpty())
    }

    // ── Child spend sign ────────────────────────────────────────────────────

    @Test
    fun `child spending is spend, not income, despite a positive amount`() {
        // Child purchases are positive, just like adult purchases. Income still
        // depends on category rather than the raw amount sign.
        val transactions = Fixtures.envelope(FamilyMember.MASON).transactions.value
            .visibleTo(FamilyMember.MASON)

        assertTrue(transactions.isNotEmpty())
        for (transaction in transactions) {
            assertTrue(transaction.amount > 0L, "${transaction.merchant} is a positive child row")
            assertTrue(transaction.isSpend, "${transaction.merchant} must count as spend")
            assertEquals(0L, transaction.incomeAmount, "${transaction.merchant} is not income")
        }
    }

    @Test
    fun `adult spend and income separate correctly`() {
        val transactions = Fixtures.envelope(FamilyMember.VICTOR).transactions.value
            .visibleTo(FamilyMember.VICTOR)

        val income = transactions.filter { it.category == "Income" }
        assertTrue(income.isNotEmpty())
        for (row in income) {
            assertFalse(row.isSpend)
            assertTrue(row.incomeAmount > 0L)
        }

        val groceries = transactions.first { it.merchant == "Neighborhood Market" }
        assertTrue(groceries.amount > 0L, "adult spend is stored positive")
        assertEquals(Money.parseCents("142.18"), groceries.spendAmount)
        assertEquals(0L, groceries.incomeAmount)
    }

    // ── Figure suppression ──────────────────────────────────────────────────

    @Test
    fun `required figures are suppressed when a source has no readable value`() {
        assertTrue(
            Fixtures.envelope(FamilyMember.VICTOR, Freshness.ERROR)
                .budget.requiredProjectionUnavailable,
        )
        assertTrue(
            Fixtures.envelope(FamilyMember.VICTOR, Freshness.LOADING)
                .budget.requiredProjectionUnavailable,
        )
        assertTrue(
            Fixtures.envelope(FamilyMember.VICTOR, Freshness.EMPTY)
                .budget.requiredProjectionUnavailable,
        )
        assertFalse(
            Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
                .budget.requiredProjectionUnavailable,
        )
        assertFalse(
            Fixtures.envelope(FamilyMember.VICTOR, Freshness.STALE)
                .budget.requiredProjectionUnavailable,
        )
    }

    @Test
    fun `required financial figures are unavailable on empty without hiding zero todos`() {
        assertTrue(Fixtures.envelope(FamilyMember.VICTOR, Freshness.ERROR).budget.suppressFigures)
        assertTrue(Fixtures.envelope(FamilyMember.VICTOR, Freshness.LOADING).budget.suppressFigures)

        val empty = Fixtures.envelope(FamilyMember.VICTOR, Freshness.EMPTY)
        assertFalse(empty.budget.suppressFigures)
        assertTrue(empty.budget.requiredProjectionUnavailable)
        assertTrue(empty.incomeFiguresUnavailable)
        assertTrue(empty.netWorthFiguresUnavailable)
        assertTrue(empty.billPayLedgerUnavailable)
        assertFalse(empty.todos.suppressFigures, "zero open todos remains a real zero")
        assertFalse(Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE).budget.suppressFigures)
        assertFalse(Fixtures.envelope(FamilyMember.VICTOR, Freshness.STALE).budget.suppressFigures)
    }

    @Test
    fun `an empty envelope really is empty`() {
        val empty = Fixtures.envelope(FamilyMember.VICTOR, Freshness.EMPTY)
        assertTrue(empty.transactions.value.isEmpty())
        assertTrue(empty.btcAccounts.value.isEmpty())
        assertTrue(empty.todos.value.isEmpty())
        assertNull(empty.budget.value)
        assertNull(empty.transactions.updatedAt, "an empty slice has never been read")
    }

    // ── Visibility through the envelope ─────────────────────────────────────

    @Test
    fun `fixtures are unfiltered so screens must apply visibility themselves`() {
        // If the envelope pre-filtered, a screen missing its filter would look
        // correct in review. It must not.
        val envelope = Fixtures.envelope(FamilyMember.MASON)
        val owners = envelope.transactions.value.map { it.owner }.toSet()
        assertTrue(
            owners.contains(FamilyMember.VICTOR),
            "the envelope carries adult rows even on a child profile",
        )
        assertEquals(
            setOf(FamilyMember.MASON),
            envelope.transactions.value.visibleTo(FamilyMember.MASON).map { it.owner }.toSet(),
        )
    }

    @Test
    fun `a child stack is visible to an adult but excluded from net worth`() {
        val accounts = Fixtures.envelope(FamilyMember.VICTOR).btcAccounts.value
        val visible = accounts.visibleTo(FamilyMember.VICTOR).map { it.label }
        val counted = accounts.netWorthScopeFor(FamilyMember.VICTOR).map { it.label }

        assertTrue(visible.contains("Mason Stack"))
        assertFalse(counted.contains("Mason Stack"))
        assertFalse(counted.contains("Maddox Stack"))
    }

    @Test
    fun `siblings never see each other`() {
        val envelope = Fixtures.envelope(FamilyMember.MASON)
        val masonAccounts = envelope.btcAccounts.value.visibleTo(FamilyMember.MASON).map { it.label }
        assertEquals(listOf("Mason Stack"), masonAccounts)

        val masonTx = envelope.transactions.value.visibleTo(FamilyMember.MASON).map { it.merchant }
        assertFalse(masonTx.contains("App Store"), "Maddox's rows must not reach Mason")
        assertFalse(masonTx.contains("Ice Cream"))
    }

    // ── Budget arithmetic ───────────────────────────────────────────────────

    @Test
    fun `budget totals are exact integer cents`() {
        val budget = Fixtures.envelope(FamilyMember.VICTOR).budget.value!!
        assertEquals(budget.categories.sumOf { it.budgetCents }, budget.plannedCents)
        assertEquals(budget.categories.sumOf { it.spentCents }, budget.actualCents)
        assertEquals(
            requireNotNull(budget.plannedCents) - requireNotNull(budget.actualCents),
            budget.remainingCents,
        )
        assertEquals(
            budget.categories.count { it.spentCents > it.budgetCents },
            budget.overBudgetCount,
        )
        assertTrue(budget.overBudgetCount > 0, "fixture should exercise the over-budget path")
    }

    @Test
    fun `reported budget overflow is unavailable rather than wrapped`() {
        val summed = Budget(
            month = "2026-07",
            categories = listOf(
                BudgetCategory("First", Long.MAX_VALUE, Long.MAX_VALUE),
                BudgetCategory("Second", 1L, 1L),
            ),
            owner = FamilyMember.VICTOR,
        )
        val remainingOverflow = Budget(
            month = "2026-07",
            categories = listOf(BudgetCategory("Refund", Long.MAX_VALUE, -1L)),
            owner = FamilyMember.VICTOR,
        )
        val summedUnderflow = Budget(
            month = "2026-07",
            categories = listOf(
                BudgetCategory("First", Long.MIN_VALUE, Long.MIN_VALUE),
                BudgetCategory("Second", -1L, -1L),
            ),
            owner = FamilyMember.VICTOR,
        )

        assertNull(summed.plannedCents)
        assertNull(summed.actualCents)
        assertNull(summed.remainingCents)
        assertNull(summedUnderflow.plannedCents)
        assertNull(summedUnderflow.actualCents)
        assertNull(summedUnderflow.remainingCents)
        assertNull(remainingOverflow.categories.single().remainingCents)
        assertNull(remainingOverflow.remainingCents)
    }

    @Test
    fun `derived category accumulation overflow is unavailable`() {
        val budget = Budget(
            month = "2026-07",
            categories = listOf(BudgetCategory("Groceries", Long.MAX_VALUE, 0L)),
            owner = FamilyMember.VICTOR,
        )
        val rows = listOf(
            budgetTransaction("first", "Groceries", Long.MAX_VALUE),
            budgetTransaction("second", "Groceries", 1L),
        )

        assertNull(deriveBudgetSpend(budget, rows))
        assertNull(
            deriveBudgetSpend(
                budget,
                listOf(
                    budgetTransaction("first", "Groceries", Long.MIN_VALUE),
                    budgetTransaction("second", "Groceries", -1L),
                ),
            ),
        )
    }

    @Test
    fun `derived totals remaining and uncategorised overflow are unavailable`() {
        val actualOverflowBudget = Budget(
            month = "2026-07",
            categories = listOf(
                BudgetCategory("First", Long.MAX_VALUE, 0L),
                BudgetCategory("Second", 1L, 0L),
            ),
            owner = FamilyMember.VICTOR,
        )
        val remainingOverflowBudget = Budget(
            month = "2026-07",
            categories = listOf(BudgetCategory("Refund", Long.MAX_VALUE, 0L)),
            owner = FamilyMember.VICTOR,
        )
        val ordinaryBudget = Budget(
            month = "2026-07",
            categories = emptyList(),
            owner = FamilyMember.VICTOR,
        )

        assertNull(
            deriveBudgetSpend(
                actualOverflowBudget,
                listOf(
                    budgetTransaction("first", "First", Long.MAX_VALUE),
                    budgetTransaction("second", "Second", 1L),
                ),
            ),
        )
        assertNull(
            deriveBudgetSpend(
                remainingOverflowBudget,
                listOf(budgetTransaction("refund", "Refund", -1L)),
            ),
        )
        assertNull(
            deriveBudgetSpend(
                ordinaryBudget,
                listOf(
                    budgetTransaction("first", "Outside one", Long.MAX_VALUE),
                    budgetTransaction("second", "Outside two", 1L),
                ),
            ),
        )
    }

    private fun budgetTransaction(id: String, category: String, amount: Long) = Transaction(
        id = id,
        date = "2026-07-15",
        merchant = id,
        amount = amount,
        category = category,
        owner = FamilyMember.VICTOR,
    )

    @Test
    fun `fixture instant is fixed so tests and screenshots are deterministic`() {
        val simulatedLive = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val stamp = simulatedLive.transactions.updatedAt
        assertNotNull(stamp)
        assertEquals(
            Fixtures.NOW_MILLIS - 4 * 60_000L,
            stamp,
            "the simulated live read is pinned to the fixture clock",
        )
    }
}

/** Due-date predicates. ISO dates compare lexically, which is why they are ISO. */
class TodoDueTest {

    private fun todo(due: String?, done: Boolean = false) =
        TodoItem(id = "t", title = "t", done = done, due = due, owner = FamilyMember.VICTOR)

    @Test
    fun `undated todos are never due`() {
        assertFalse(todo(null).isDueOnOrBefore("2026-07-26"))
        assertFalse(todo(null).isDueBy("2026-07-26"))
    }

    @Test
    fun `due today and overdue both count, future does not`() {
        assertTrue(todo("2026-07-26").isDueBy("2026-07-26"))
        assertTrue(todo("2026-07-01").isDueBy("2026-07-26"))
        assertFalse(todo("2026-07-27").isDueBy("2026-07-26"))
    }

    @Test
    fun `a completed todo is not due even when overdue`() {
        assertTrue(todo("2026-07-01").isDueOnOrBefore("2026-07-26"))
        assertFalse(todo("2026-07-01", done = true).isDueBy("2026-07-26"))
    }

    @Test
    fun `lexical comparison holds across month and year boundaries`() {
        assertTrue(todo("2025-12-31").isDueBy("2026-01-01"))
        assertFalse(todo("2026-01-02").isDueBy("2026-01-01"))
        assertTrue(todo("2026-09-01").isDueBy("2026-10-01"))
    }
}
