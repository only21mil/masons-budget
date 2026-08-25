package com.sats21m.vogelvault.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RedesignContractsTest {
    @Test
    fun `todos use exact-owner access instead of adult-wide visibility`() {
        val todos = FamilyMember.entries.map { owner -> todo(owner.key, owner) }

        for (profile in FamilyMember.entries) {
            assertEquals(listOf(profile), todos.todosFor(profile).map { it.owner })
        }
        assertTrue(
            FamilyMember.RACHEL.canSee(FamilyMember.VICTOR),
            "financial visibility stays unchanged",
        )
        assertFalse(todo("victor", FamilyMember.VICTOR).isAccessibleTo(FamilyMember.RACHEL))
    }

    @Test
    fun `money out today uses the shared adult household and exact child owner`() {
        val transactions = listOf(
            transaction("adult", FamilyMember.VICTOR, 1_000L),
            transaction("rachel-tagged", FamilyMember.RACHEL, 9_000L),
            transaction("mason", FamilyMember.MASON, 300L),
            transaction("maddox", FamilyMember.MADDOX, 400L),
        )
        val billPays = listOf(
            billPay("adult", FamilyMember.VICTOR, amount = 500L, fee = 25L),
            billPay("rachel-tagged", FamilyMember.RACHEL, amount = 5_000L, fee = 50L),
            billPay("mason", FamilyMember.MASON, amount = 200L, fee = 10L),
        )

        assertEquals(15_575L, deriveMoneyOutTodayCents(FamilyMember.VICTOR, DAY, transactions, billPays))
        assertEquals(15_575L, deriveMoneyOutTodayCents(FamilyMember.RACHEL, DAY, transactions, billPays))
        assertEquals(510L, deriveMoneyOutTodayCents(FamilyMember.MASON, DAY, transactions, billPays))
        assertEquals(400L, deriveMoneyOutTodayCents(FamilyMember.MADDOX, DAY, transactions, billPays))
    }

    @Test
    fun `money out today excludes income and other days while refunds reduce without clamping`() {
        val transactions = listOf(
            transaction("purchase", FamilyMember.VICTOR, 1_000L),
            transaction("refund", FamilyMember.VICTOR, -1_250L),
            transaction("income", FamilyMember.VICTOR, 20_000L, category = "Income"),
            transaction("tomorrow", FamilyMember.VICTOR, 80_000L, day = "2026-08-26"),
        )

        assertEquals(-250L, deriveMoneyOutTodayCents(FamilyMember.VICTOR, DAY, transactions, emptyList()))
    }

    @Test
    fun `money out today adds bill-pay principal and manual fee once`() {
        val payment = billPay("bill", FamilyMember.VICTOR, amount = 12_345L, fee = 67L)

        assertEquals(
            12_412L,
            deriveMoneyOutTodayCents(FamilyMember.VICTOR, DAY, emptyList(), listOf(payment)),
        )
    }

    @Test
    fun `money out today rejects invalid days and every overflow boundary`() {
        assertFailsWith<IllegalArgumentException> {
            deriveMoneyOutTodayCents(FamilyMember.VICTOR, "2026-02-30", emptyList(), emptyList())
        }
        assertFailsWith<ArithmeticException> {
            deriveMoneyOutTodayCents(
                FamilyMember.VICTOR,
                DAY,
                listOf(
                    transaction("max", FamilyMember.VICTOR, Long.MAX_VALUE),
                    transaction("one", FamilyMember.VICTOR, 1L),
                ),
                emptyList(),
            )
        }
        assertFailsWith<ArithmeticException> {
            deriveMoneyOutTodayCents(
                FamilyMember.VICTOR,
                DAY,
                listOf(
                    transaction("min", FamilyMember.VICTOR, Long.MIN_VALUE),
                    transaction("negative-one", FamilyMember.VICTOR, -1L),
                ),
                emptyList(),
            )
        }
        assertFailsWith<ArithmeticException> {
            deriveMoneyOutTodayCents(
                FamilyMember.VICTOR,
                DAY,
                emptyList(),
                listOf(billPay("overflow", FamilyMember.VICTOR, Long.MAX_VALUE, 1L)),
            )
        }
    }

    @Test
    fun `Bitcoin fees default to zero and reject negatives`() {
        assertEquals(0L, buy().feeUsdCents)
        assertEquals(0L, billPay("default", FamilyMember.VICTOR, 1L).feeUsdCents)
        assertFailsWith<IllegalArgumentException> { buy(fee = -1L) }
        assertFailsWith<IllegalArgumentException> {
            billPay("negative", FamilyMember.VICTOR, amount = 1L, fee = -1L)
        }
    }

    @Test
    fun `adult current-month category delete requires canonical owner source category and revision`() {
        val budget = budget(FamilyMember.VICTOR)
        val intent = intent()

        assertEligible(
            validateCurrentMonthCategoryDelete(
                FamilyMember.RACHEL,
                MONTH,
                budget,
                REVISION,
                intent,
            ),
        )
        assertRejected(
            CategoryDeleteRejection.OWNER_MISMATCH,
            validateCurrentMonthCategoryDelete(
                FamilyMember.RACHEL,
                MONTH,
                budget.copy(owner = FamilyMember.RACHEL),
                REVISION,
                intent,
            ),
        )
        assertRejected(
            CategoryDeleteRejection.SOURCE_MISMATCH,
            validateCurrentMonthCategoryDelete(
                FamilyMember.RACHEL,
                MONTH,
                budget,
                REVISION,
                intent.copy(source = "mason-budget"),
            ),
        )
        assertRejected(
            CategoryDeleteRejection.CATEGORY_MISSING,
            validateCurrentMonthCategoryDelete(
                FamilyMember.RACHEL,
                MONTH,
                budget,
                REVISION,
                intent.copy(categoryName = "groceries"),
            ),
        )
    }

    @Test
    fun `category delete rejects invalid historical future mismatched and stale state`() {
        val budget = budget(FamilyMember.VICTOR)

        for (invalidMonth in listOf("2026-8", "2026-13", "0000-08")) {
            assertRejected(
                CategoryDeleteRejection.INVALID_CURRENT_MONTH,
                validateCurrentMonthCategoryDelete(
                    FamilyMember.VICTOR,
                    invalidMonth,
                    budget,
                    REVISION,
                    intent(),
                ),
            )
        }
        for (month in listOf("2026-07", "2026-09")) {
            assertRejected(
                CategoryDeleteRejection.NOT_CURRENT_MONTH,
                validateCurrentMonthCategoryDelete(
                    FamilyMember.VICTOR,
                    MONTH,
                    budget.copy(month = month),
                    REVISION,
                    intent(month = month),
                ),
            )
        }
        assertRejected(
            CategoryDeleteRejection.NOT_CURRENT_MONTH,
            validateCurrentMonthCategoryDelete(
                FamilyMember.VICTOR,
                MONTH,
                budget,
                REVISION,
                intent(month = "2026-07"),
            ),
        )
        for (revision in listOf(0L, -1L, REVISION - 1L)) {
            assertRejected(
                CategoryDeleteRejection.INVALID_REVISION,
                validateCurrentMonthCategoryDelete(
                    FamilyMember.VICTOR,
                    MONTH,
                    budget,
                    REVISION,
                    intent().copy(baseUpdatedAtMs = revision),
                ),
            )
        }
        assertRejected(
            CategoryDeleteRejection.INVALID_REVISION,
            validateCurrentMonthCategoryDelete(
                FamilyMember.VICTOR,
                MONTH,
                budget,
                0L,
                intent(),
            ),
        )
    }

    @Test
    fun `Mason budget delete is supported while Maddox is rejected`() {
        assertEligible(
            validateCurrentMonthCategoryDelete(
                FamilyMember.MASON,
                MONTH,
                budget(FamilyMember.MASON),
                REVISION,
                intent(owner = FamilyMember.MASON, source = "mason-budget"),
            ),
        )
        assertRejected(
            CategoryDeleteRejection.UNSUPPORTED_CHILD_BUDGET,
            validateCurrentMonthCategoryDelete(
                FamilyMember.MADDOX,
                MONTH,
                budget(FamilyMember.MADDOX),
                REVISION,
                intent(owner = FamilyMember.MADDOX, source = "maddox-budget"),
            ),
        )
    }

    private fun todo(id: String, owner: FamilyMember) = TodoItem(id = id, title = id, owner = owner)

    private fun transaction(
        id: String,
        owner: FamilyMember,
        amount: Long,
        category: String = "Shopping",
        day: String = DAY,
    ) = Transaction(
        id = id,
        date = day,
        merchant = id,
        amount = amount,
        category = category,
        owner = owner,
    )

    private fun billPay(
        id: String,
        owner: FamilyMember,
        amount: Long,
        fee: Long = 0L,
    ) = BtcBillPay(
        id = id,
        date = DAY,
        merchant = id,
        category = "Bills",
        amountUsdCents = amount,
        btcSpentSats = 1L,
        feeUsdCents = fee,
        platform = null,
        note = null,
        owner = owner,
    )

    private fun buy(fee: Long = 0L) = BtcBuy(
        id = "buy",
        date = DAY,
        source = "exchange",
        sats = 1L,
        priceUsdCents = 10_000_000L,
        usdCents = 1L,
        owner = FamilyMember.VICTOR,
        feeUsdCents = fee,
    )

    private fun budget(owner: FamilyMember) = Budget(
        month = MONTH,
        categories = listOf(BudgetCategory("Groceries", 50_000L, 12_000L)),
        owner = owner,
    )

    private fun intent(
        month: String = MONTH,
        owner: FamilyMember = FamilyMember.VICTOR,
        source: String = "budget",
    ) = CurrentMonthCategoryDeleteIntent(
        month = month,
        owner = owner,
        source = source,
        categoryName = "Groceries",
        baseUpdatedAtMs = REVISION,
    )

    private fun assertEligible(result: CategoryDeleteEligibility) {
        assertTrue(result.eligible)
        assertEquals(null, result.rejection)
    }

    private fun assertRejected(
        rejection: CategoryDeleteRejection,
        result: CategoryDeleteEligibility,
    ) {
        assertFalse(result.eligible)
        assertEquals(rejection, result.rejection)
    }

    private companion object {
        const val DAY = "2026-08-25"
        const val MONTH = "2026-08"
        const val REVISION = 1_800_000_000_000L
    }
}
