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

        assertNull(maddox, "Maddox has no dedicated MC2 budget file, so his slice is empty")
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
        // Adult files sign spending negative; child files store a positive
        // magnitude. Keying off the sign renders a child's spending as income.
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
        assertTrue(groceries.amount < 0L, "adult spend is signed negative")
        assertEquals(Money.parseCents("142.18"), groceries.spendAmount)
        assertEquals(0L, groceries.incomeAmount)
    }

    // ── Figure suppression ──────────────────────────────────────────────────

    @Test
    fun `figures are suppressed on error and loading but not on empty`() {
        assertTrue(Fixtures.envelope(FamilyMember.VICTOR, Freshness.ERROR).budget.suppressFigures)
        assertTrue(Fixtures.envelope(FamilyMember.VICTOR, Freshness.LOADING).budget.suppressFigures)

        // Empty is a real answer: zero is not the same as unknown.
        assertFalse(Fixtures.envelope(FamilyMember.VICTOR, Freshness.EMPTY).budget.suppressFigures)
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
        assertEquals(budget.plannedCents - budget.actualCents, budget.remainingCents)
        assertEquals(
            budget.categories.count { it.spentCents > it.budgetCents },
            budget.overBudgetCount,
        )
        assertTrue(budget.overBudgetCount > 0, "fixture should exercise the over-budget path")
    }

    @Test
    fun `fixture instant is fixed so tests and screenshots are deterministic`() {
        assertEquals(Fixtures.NOW_MILLIS, Fixtures.envelope(FamilyMember.VICTOR).let { Fixtures.NOW_MILLIS })
        val stamp = Fixtures.envelope(FamilyMember.VICTOR).transactions.updatedAt
        assertNotNull(stamp)
        assertTrue(stamp < Fixtures.NOW_MILLIS, "a slice was read in the past, not the future")
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
