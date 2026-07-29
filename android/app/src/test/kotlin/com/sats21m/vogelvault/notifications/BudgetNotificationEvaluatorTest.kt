package com.sats21m.vogelvault.notifications

import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.BudgetCategory
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.ui.VaultUiState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BudgetNotificationEvaluatorTest {
    private val evaluator = BudgetNotificationEvaluator()

    @Test
    fun `rachel receives canonical adult household alert`() {
        val state =
            state(
                viewer = FamilyMember.RACHEL,
                budgetOwner = FamilyMember.VICTOR,
                transactions =
                    listOf(
                        transaction("adult", 8_501L, FamilyMember.VICTOR),
                    ),
            )

        val alert = evaluator.evaluate(state).single()

        assertEquals(FamilyMember.VICTOR, alert.owner)
        assertEquals(BudgetAlertLevel.NEARING_LIMIT, alert.level)
        assertEquals(8_501L, alert.spentCents)
        assertEquals(10_000L, alert.budgetCents)
    }

    @Test
    fun `child can never receive an adult budget figure`() {
        val state =
            state(
                viewer = FamilyMember.MASON,
                budgetOwner = FamilyMember.VICTOR,
                transactions =
                    listOf(
                        transaction("adult", 10_001L, FamilyMember.VICTOR),
                    ),
            )

        assertTrue(evaluator.evaluate(state).isEmpty())
    }

    @Test
    fun `adult alert excludes child spending from household budget`() {
        val state =
            state(
                viewer = FamilyMember.VICTOR,
                budgetOwner = FamilyMember.VICTOR,
                transactions =
                    listOf(
                        transaction("adult", 8_000L, FamilyMember.VICTOR),
                        transaction("child", 3_000L, FamilyMember.MASON),
                    ),
            )

        assertTrue(evaluator.evaluate(state).isEmpty())
    }

    @Test
    fun `refunds reduce spend before threshold evaluation`() {
        val state =
            state(
                viewer = FamilyMember.VICTOR,
                budgetOwner = FamilyMember.VICTOR,
                transactions =
                    listOf(
                        transaction("purchase", 9_000L, FamilyMember.VICTOR),
                        transaction("refund", -1_000L, FamilyMember.RACHEL),
                    ),
            )

        assertTrue(evaluator.evaluate(state).isEmpty())
    }

    @Test
    fun `thresholds are strict and over budget wins`() {
        val atEightyFive =
            state(
                FamilyMember.VICTOR,
                FamilyMember.VICTOR,
                listOf(transaction("85", 8_500L, FamilyMember.VICTOR)),
            )
        val atOneHundred =
            state(
                FamilyMember.VICTOR,
                FamilyMember.VICTOR,
                listOf(transaction("100", 10_000L, FamilyMember.VICTOR)),
            )
        val over =
            state(
                FamilyMember.VICTOR,
                FamilyMember.VICTOR,
                listOf(transaction("over", 10_001L, FamilyMember.VICTOR)),
        )

        assertTrue(evaluator.evaluate(atEightyFive).isEmpty())
        assertEquals(
            BudgetAlertLevel.NEARING_LIMIT,
            evaluator.evaluate(atOneHundred).single().level,
        )
        assertEquals(BudgetAlertLevel.OVER_LIMIT, evaluator.evaluate(over).single().level)
    }

    @Test
    fun `demo loading and unauthorized figures never notify`() {
        val live =
            state(
                FamilyMember.VICTOR,
                FamilyMember.VICTOR,
                listOf(transaction("over", 10_001L, FamilyMember.VICTOR)),
            )

        assertTrue(
            evaluator.evaluate(
                live.copy(
                    data =
                        live.data.copy(
                            budget = live.data.budget.copy(status = Freshness.DEMO),
                        ),
                ),
            ).isEmpty(),
        )
        assertTrue(
            evaluator.evaluate(
                live.copy(
                    data =
                        live.data.copy(
                            transactions = live.data.transactions.copy(status = Freshness.LOADING),
                        ),
                ),
            ).isEmpty(),
        )
        assertTrue(evaluator.evaluate(live.copy(staleAuthorization = true)).isEmpty())
    }

    @Test
    fun `dispatcher publishes once per owner month category and level`() {
        val state =
            state(
                FamilyMember.VICTOR,
                FamilyMember.VICTOR,
                listOf(transaction("over", 10_001L, FamilyMember.VICTOR)),
            )
        val deduplicator = FakeDeduplicator()
        val publisher = FakePublisher()
        val dispatcher = BudgetNotificationDispatcher(evaluator, deduplicator, publisher)

        dispatcher.dispatch(state, enabled = true)
        dispatcher.dispatch(state, enabled = true)

        assertEquals(1, publisher.alerts.size)
        assertEquals(1, deduplicator.sent.size)
    }

    @Test
    fun `dispatcher can publish nearing and over levels once each`() {
        val nearing =
            state(
                FamilyMember.VICTOR,
                FamilyMember.VICTOR,
                listOf(transaction("near", 8_501L, FamilyMember.VICTOR)),
            )
        val over =
            state(
                FamilyMember.VICTOR,
                FamilyMember.VICTOR,
                listOf(transaction("over", 10_001L, FamilyMember.VICTOR)),
            )
        val deduplicator = FakeDeduplicator()
        val publisher = FakePublisher()
        val dispatcher = BudgetNotificationDispatcher(evaluator, deduplicator, publisher)

        dispatcher.dispatch(nearing, enabled = true)
        dispatcher.dispatch(over, enabled = true)
        dispatcher.dispatch(over, enabled = true)

        assertEquals(
            listOf(BudgetAlertLevel.NEARING_LIMIT, BudgetAlertLevel.OVER_LIMIT),
            publisher.alerts.map(BudgetAlert::level),
        )
    }

    @Test
    fun `overflowing category totals are suppressed`() {
        val state =
            state(
                FamilyMember.VICTOR,
                FamilyMember.VICTOR,
                listOf(
                    transaction("max", Long.MAX_VALUE, FamilyMember.VICTOR),
                    transaction("one-more", 1L, FamilyMember.RACHEL),
                ),
            )

        assertTrue(evaluator.evaluate(state).isEmpty())
    }

    @Test
    fun `dispatcher does not consume dedupe while permission is unavailable`() {
        val state =
            state(
                FamilyMember.VICTOR,
                FamilyMember.VICTOR,
                listOf(transaction("over", 10_001L, FamilyMember.VICTOR)),
            )
        val deduplicator = FakeDeduplicator()
        val publisher = FakePublisher(canPublish = false)
        val dispatcher = BudgetNotificationDispatcher(evaluator, deduplicator, publisher)

        dispatcher.dispatch(state, enabled = true)

        assertTrue(publisher.alerts.isEmpty())
        assertTrue(deduplicator.sent.isEmpty())
    }

    private fun state(
        viewer: FamilyMember,
        budgetOwner: FamilyMember,
        transactions: List<Transaction>,
    ): VaultUiState {
        val base = Fixtures.envelope(viewer, Freshness.LIVE)
        return VaultUiState(
            activeProfile = viewer,
            data =
                base.copy(
                    budget =
                        base.budget.copy(
                            status = Freshness.LIVE,
                            value =
                                Budget(
                                    month = MONTH,
                                    categories =
                                        listOf(
                                            BudgetCategory(
                                                name = CATEGORY,
                                                budgetCents = 10_000L,
                                                spentCents = 99_999_999L,
                                            ),
                                        ),
                                    owner = budgetOwner,
                                ),
                        ),
                    transactions =
                        base.transactions.copy(
                            status = Freshness.LIVE,
                            value = transactions,
                        ),
                ),
        )
    }

    private fun transaction(
        id: String,
        amount: Long,
        owner: FamilyMember,
    ): Transaction =
        Transaction(
            id = id,
            date = "$MONTH-10",
            merchant = id,
            amount = amount,
            category = CATEGORY,
            owner = owner,
        )

    private class FakeDeduplicator : BudgetAlertDeduplicator {
        val sent = mutableSetOf<String>()

        override fun wasSent(key: String): Boolean = key in sent

        override fun markSent(key: String) {
            sent += key
        }
    }

    private class FakePublisher(
        private val canPublish: Boolean = true,
    ) : BudgetAlertPublisher {
        val alerts = mutableListOf<BudgetAlert>()

        override fun canPublish(): Boolean = canPublish

        override fun publish(alert: BudgetAlert) {
            alerts += alert
        }
    }

    private companion object {
        const val MONTH = "2026-07"
        const val CATEGORY = "Groceries"
    }
}
