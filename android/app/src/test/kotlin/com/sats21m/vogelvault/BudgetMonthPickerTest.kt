package com.sats21m.vogelvault

import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.BudgetCategory
import com.sats21m.vogelvault.domain.BudgetSpend
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.ReadModel
import com.sats21m.vogelvault.domain.Slice
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.domain.budgetMonthsFor
import com.sats21m.vogelvault.domain.budgetTransactionsFor
import com.sats21m.vogelvault.domain.deriveBudgetSpend
import com.sats21m.vogelvault.domain.resolveBudgetMonth
import com.sats21m.vogelvault.domain.visibleTo
import com.sats21m.vogelvault.ui.Destination
import com.sats21m.vogelvault.ui.VaultUiState
import com.sats21m.vogelvault.ui.VaultViewModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Budget month picker.
 *
 * Plain JVM — no Robolectric. Everything the picker decides lives in
 * the shared budget month helpers, which are pure functions of the envelope, so
 * these run in milliseconds and always run.
 *
 * The Android twin of `linux/test/month-picker.test.ts`. Same fixtures, same
 * derivation rule, so the two clients cannot answer the same question
 * differently: the picker offers the months that are actually present, selecting
 * one re-derives the totals from that month, and a child never learns that a
 * month exists from an adult's ledger.
 */
class BudgetMonthPickerTest {

    private val july = "2026-07"
    private val june = "2026-06"

    /** No fixture row anywhere. Used as the month that must never resolve. */
    private val may = "2026-05"

    private fun state(
        profile: FamilyMember,
        selectedMonth: String? = null,
        status: Freshness = Freshness.LIVE,
    ) = VaultUiState.of(profile, Destination.BUDGET, status, selectedMonth)

    private fun months(state: VaultUiState): List<String> =
        state.data.transactions.value.budgetMonthsFor(state.activeProfile, state.data.budget.value?.month)

    private fun activeMonth(state: VaultUiState): String? =
        resolveBudgetMonth(state.selectedMonth, months(state), state.data.budget.value?.month)

    /**
     * The Budget screen's derivation, mirrored from `Screens.kt`'s `budget()`.
     *
     * MC2 publishes one budget file per profile carrying the current month's
     * targets, so an earlier month is scoped by re-labelling that budget and
     * re-deriving its actuals. Duplicated rather than shared because the screen
     * owns it inside a composable, and asking Robolectric to answer a question
     * about arithmetic would be the slow way to get the same number.
     */
    private fun derive(state: VaultUiState, month: String? = null): BudgetSpend? {
        val budget = state.data.budget.value ?: return null
        val scope = month ?: activeMonth(state)
        val scoped = if (scope == null || scope == budget.month) budget else budget.copy(month = scope)
        return deriveBudgetSpend(scoped, state.data.transactions.value.budgetTransactionsFor(state.activeProfile))
    }

    private fun BudgetSpend.spentOn(category: String): Long =
        categories.first { it.name == category }.spentCents

    // ── The offered list ────────────────────────────────────────────────────

    @Test
    fun `the offered months come from budget-scoped transactions plus the budget's own`() {
        assertEquals(listOf(july, june), months(state(FamilyMember.VICTOR)))
        assertEquals(listOf(july, june), months(state(FamilyMember.RACHEL)))
        assertEquals(listOf(july, june), months(state(FamilyMember.MASON)))
        // Maddox has July rows only, and no budget file to contribute a month.
        assertEquals(listOf(july), months(state(FamilyMember.MADDOX)))
    }

    @Test
    fun `Rachel is offered exactly what Victor is`() {
        // Victor and Rachel are one household. Adult MC2 records default to owner
        // "victor", so a strict `owner == activeProfile` check anywhere in this
        // path empties Rachel's picker — the v0.3 bug, in month form.
        val victor = state(FamilyMember.VICTOR)
        val rachel = state(FamilyMember.RACHEL)

        assertEquals(months(victor), months(rachel))
        assertEquals(activeMonth(victor), activeMonth(rachel))
        assertTrue(months(rachel).size > 1, "an empty or single-month list would pass by accident")

        // And the same figures behind them, on both months.
        assertEquals(derive(victor, july), derive(rachel, july))
        assertEquals(derive(victor, june), derive(rachel, june))
    }

    @Test
    fun `months are newest first`() {
        val offered = months(state(FamilyMember.VICTOR))
        assertEquals(offered.sortedDescending(), offered)
        assertTrue(offered.indexOf(july) < offered.indexOf(june), "the current month leads the list")
    }

    @Test
    fun `the budget's own month is offered with nothing spent in it`() {
        // A month with no transactions is a real answer; an absent month is not.
        val ui = VaultUiState(
            activeProfile = FamilyMember.VICTOR,
            destination = Destination.BUDGET,
            data = model(
                transactions = listOf(
                    tx("2026-07-04", "Groceries", "-30", FamilyMember.VICTOR),
                    tx("2026-06-04", "Groceries", "-40", FamilyMember.VICTOR),
                ),
                budget = budget(may, FamilyMember.VICTOR),
            ),
        )

        assertEquals(listOf(july, june, may), months(ui), "the budget's month must be offered")
        assertEquals(may, activeMonth(ui), "and it is what the screen opens on")
        assertEquals(0L, derive(ui)!!.actualCents, "May really did have no spending")
    }

    // ── Visibility ──────────────────────────────────────────────────────────

    @Test
    fun `a child is never offered a month only an adult has`() {
        val data = model(
            transactions = listOf(
                tx("2026-05-11", "Groceries", "-120", FamilyMember.VICTOR),
                tx("2026-04-09", "Entertainment", "18", FamilyMember.MASON),
            ),
            budget = budget("2026-04", FamilyMember.MASON),
        )
        val mason = VaultUiState(FamilyMember.MASON, Destination.BUDGET, data)

        assertEquals(listOf("2026-04"), months(mason))
        assertFalse(may in months(mason), "an adult month reached a child's picker")

        // Against the real fixtures every offered month must be backed by Mason's
        // own budget scope or by his budget file's month.
        val fixture = state(FamilyMember.MASON)
        val own = fixture.data.transactions.value.budgetTransactionsFor(FamilyMember.MASON)
            .map { it.date.take(7) }
            .distinct()
        val budgetMonth = fixture.data.budget.value?.month
        for (month in months(fixture)) {
            assertTrue(month == budgetMonth || month in own, "$month is not Mason's to see")
        }
    }

    @Test
    fun `an adult is not offered a child-only month, though the row remains visible`() {
        // Adult oversight uses canSee, but adult budget totals use the narrower
        // net-worth-sharing scope. A child-only month must not become a budget
        // choice just because the adult can inspect its row on Activity.
        val data = model(
            transactions = listOf(
                tx("2026-07-04", "Groceries", "-120", FamilyMember.VICTOR),
                tx("2026-04-09", "Entertainment", "18", FamilyMember.MASON),
            ),
            budget = budget(july, FamilyMember.VICTOR),
        )
        val victor = VaultUiState(FamilyMember.VICTOR, Destination.BUDGET, data)

        assertEquals(listOf(july), months(victor))
        assertTrue(data.transactions.value.visibleTo(FamilyMember.VICTOR).any { it.owner == FamilyMember.MASON })
        assertEquals(0L, derive(victor, "2026-04")!!.actualCents)
    }

    @Test
    fun `a child's month totals no adult spending`() {
        // Mason's budget has no Groceries or Utilities category, so an adult row
        // leaking into his scope would land in uncategorised rather than being
        // silently absorbed. Zero there is the assertion.
        for (month in listOf(july, june)) {
            val derived = derive(state(FamilyMember.MASON), month)!!
            assertEquals(0L, derived.uncategorisedCents, "adult rows leaked into Mason's $month")
        }

        val mason = derive(state(FamilyMember.MASON), june)!!
        val adult = derive(state(FamilyMember.VICTOR), june)!!
        assertNotEquals(adult.actualCents, mason.actualCents)
        assertEquals(Money.parseCents("18.00"), mason.actualCents, "Mason's June is one book fair")
    }

    // ── Falling back ────────────────────────────────────────────────────────

    @Test
    fun `a seeded month this profile has no data for falls back`() {
        // The seed can outlive the data it was chosen against. Reporting an empty
        // May would look like a month with no spending rather than a bad scope.
        val victor = state(FamilyMember.VICTOR, selectedMonth = may)
        assertFalse(may in months(victor), "May was never an option")
        assertEquals(july, activeMonth(victor), "expected a fall back to the budget's month")

        // Maddox has no budget file at all, so there is no budget month to fall
        // back to — the newest month he does have is the answer.
        val maddox = state(FamilyMember.MADDOX, selectedMonth = june)
        assertNull(maddox.data.budget.value)
        assertEquals(july, activeMonth(maddox))
    }

    @Test
    fun `a seeded month that is real is honoured`() {
        // Otherwise the test above would pass against a picker that ignores the
        // seed entirely, and the design packet would render July every time.
        assertEquals(june, activeMonth(state(FamilyMember.VICTOR, selectedMonth = june)))
        assertEquals(june, activeMonth(state(FamilyMember.MASON, selectedMonth = june)))
    }

    @Test
    fun `an empty read offers no months and scopes to nothing`() {
        val empty = state(FamilyMember.VICTOR, status = Freshness.EMPTY)
        assertEquals(emptyList(), months(empty))
        assertNull(activeMonth(empty), "a picker over no months is not a picker")

        // A failed read still knows which months exist — the screen hides the
        // control instead, because choosing between months of untrusted figures
        // is a control over nothing.
        assertEquals(listOf(july, june), months(state(FamilyMember.VICTOR, status = Freshness.ERROR)))
    }

    // ── Switching profile ───────────────────────────────────────────────────

    @Test
    fun `switching profile drops the month scope`() {
        val viewModel = VaultViewModel()
        viewModel.navigate(Destination.BUDGET)
        viewModel.switchProfile(FamilyMember.MASON)

        val after = viewModel.state.value
        assertEquals(FamilyMember.MASON, after.activeProfile)
        assertNull(after.selectedMonth, "a month picked against another profile's ledger must not carry over")
        assertEquals(Destination.BUDGET, after.destination, "the screen itself is still allowed")
        assertEquals(july, activeMonth(after), "Mason opens on his own budget's month")

        // The ViewModel exposes no way to set a month — the live selection is
        // remembered by the screen, keyed on the profile — so the guarantee this
        // can assert is that the state a switch produces carries no seed at all.
        for (target in FamilyMember.entries) {
            val switcher = VaultViewModel()
            switcher.switchProfile(target)
            assertNull(switcher.state.value.selectedMonth, "switching to $target left a month behind")
        }
    }

    @Test
    fun `a child cannot switch away, so the scope cannot be swapped under them`() {
        val viewModel = VaultViewModel()
        viewModel.switchProfile(FamilyMember.MASON)
        viewModel.switchProfile(FamilyMember.VICTOR)

        val after = viewModel.state.value
        assertEquals(FamilyMember.MASON, after.activeProfile, "a child reached an adult profile")
        assertEquals(
            FamilyMember.MASON,
            after.data.budget.value?.owner,
            "and would have been scoping an adult budget",
        )
    }

    // ── Selecting a month changes the figures ───────────────────────────────

    @Test
    fun `selecting June re-derives the totals from June's transactions`() {
        val victor = state(FamilyMember.VICTOR)
        val julySpend = derive(victor, july)!!
        val juneSpend = derive(victor, june)!!

        // Groceries: July is 142.18 + 52.00, June is a single 388.90 row.
        assertEquals(Money.parseCents("194.18"), julySpend.spentOn("Groceries"))
        assertEquals(Money.parseCents("388.90"), juneSpend.spentOn("Groceries"))

        // Transport is a June-only category, Home and Health are July-only.
        assertEquals(0L, julySpend.spentOn("Transport"))
        assertEquals(Money.parseCents("92.60"), juneSpend.spentOn("Transport"))
        assertEquals(Money.parseCents("88.40"), julySpend.spentOn("Home"))
        assertEquals(0L, juneSpend.spentOn("Home"))

        assertEquals(Money.parseCents("611.17"), julySpend.actualCents)
        assertEquals(Money.parseCents("741.05"), juneSpend.actualCents)

        // Planned comes from the July budget file either way — that is what the
        // provenance banner on the screen is there to say — so remaining moves
        // with actual and nothing else.
        assertEquals(julySpend.plannedCents, juneSpend.plannedCents)
        assertEquals(Money.parseCents("2058.83"), julySpend.remainingCents)
        assertEquals(Money.parseCents("1928.95"), juneSpend.remainingCents)

        // Child rows stay visible on Activity but never reach the adult budget,
        // whether or not their category matches an adult target.
        assertEquals(0L, julySpend.uncategorisedCents)
        assertEquals(0L, juneSpend.uncategorisedCents)
    }

    @Test
    fun `income rows never count as spending in either month`() {
        // Adult files sign spend negative, the child files store a positive
        // magnitude, and there is a paycheque in both months. Keying off the sign
        // would turn Mason's spending into income and the paycheque into spend.
        val victor = state(FamilyMember.VICTOR)
        for (month in listOf(july, june)) {
            val derived = derive(victor, month)!!
            assertTrue(derived.actualCents > 0L)
            assertTrue(
                derived.actualCents < Money.parseCents("2480.00"),
                "a payroll deposit was counted as spending in $month",
            )
        }
    }

    @Test
    fun `the month the screen opens on is the one the figures are derived from`() {
        // The chip's selected state is `derived.month`, so a mismatch here would
        // highlight one month while reporting another.
        for (profile in listOf(FamilyMember.VICTOR, FamilyMember.RACHEL, FamilyMember.MASON)) {
            for (seed in listOf(null, july, june, may)) {
                val ui = state(profile, selectedMonth = seed)
                val active = assertNotNull(activeMonth(ui), "$profile scoped to nothing on $seed")
                assertEquals(active, derive(ui)!!.month)
                assertTrue(active in months(ui), "$profile opened on a month it does not offer")
            }
        }
    }

    // ── Synthetic envelopes ─────────────────────────────────────────────────
    //
    // The fixtures give Mason and the adults the same two months, so a leak in
    // either direction is invisible against them. These build the asymmetric case
    // the fixtures cannot express.

    private fun tx(date: String, category: String, amount: String, owner: FamilyMember) = Transaction(
        id = "$owner-$date-$category",
        date = date,
        merchant = "Sample",
        amount = Money.parseCents(amount),
        category = category,
        owner = owner,
    )

    private fun budget(month: String, owner: FamilyMember) = Budget(
        month = month,
        categories = listOf(
            // Reported spend is deliberately absurd: nothing may read it.
            BudgetCategory("Groceries", Money.parseCents("500"), Money.parseCents("99999")),
            BudgetCategory("Entertainment", Money.parseCents("100"), Money.parseCents("99999")),
        ),
        owner = owner,
    )

    private fun model(transactions: List<Transaction>, budget: Budget?) = ReadModel(
        transactions = Slice(Freshness.LIVE, transactions, Fixtures.NOW_MILLIS, "test"),
        budget = Slice(Freshness.LIVE, budget, Fixtures.NOW_MILLIS, "test"),
        btcAccounts = Slice(Freshness.LIVE, emptyList(), Fixtures.NOW_MILLIS, "test"),
        btcBuys = Slice(Freshness.LIVE, emptyList(), Fixtures.NOW_MILLIS, "test"),
        todos = Slice(Freshness.LIVE, emptyList(), Fixtures.NOW_MILLIS, "test"),
        btcPriceCents = 0L,
    )
}
