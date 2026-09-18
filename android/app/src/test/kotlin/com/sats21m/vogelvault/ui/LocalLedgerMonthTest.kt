package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.VaultApplication
import com.sats21m.vogelvault.data.BudgetCategoryDeleteResult
import com.sats21m.vogelvault.data.BudgetPlanCarryResult
import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.BudgetCategory
import com.sats21m.vogelvault.domain.FamilyMember
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.runBlocking
import kotlin.test.assertEquals
import kotlin.test.assertIs
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = MonthBoundaryApplication::class)
class LocalLedgerMonthTest {
    @Test fun `Chicago month end screens drafts delete and carry agree after UTC midnight`() = runBlocking {
        val application = RuntimeEnvironment.getApplication() as MonthBoundaryApplication
        val clock = application.ledgerClock
        val today = ledgerToday(clock)
        assertEquals(LocalDate.of(2026, 9, 30), today)
        assertEquals(today, calendarDate(clock.millis(), clock.zone))
        assertEquals("2026-09", calendarMonth(clock.millis(), clock.zone))
        assertEquals("2026-09-30", accountAsOf(null, today))
        assertEquals("2026-09", application.budgetPlanCarryGateway.currentMonth())

        val current = Budget(
            month = "2026-09",
            categories = listOf(BudgetCategory("Groceries", 1L, 0L)),
            owner = FamilyMember.VICTOR,
            updatedAtMs = 123L,
        )
        // No device credential is installed: Submitted proves the local month guard
        // allowed the request, while the device client refuses it before any HTTP call.
        assertIs<BudgetCategoryDeleteResult.Submitted>(application.budgetCategoryDeletionGateway.delete(
            FamilyMember.RACHEL, current, "budget", "Groceries", 123L,
        ))
        val carry = assertIs<BudgetPlanCarryResult.Submitted>(application.budgetPlanCarryGateway.copyForward(
            FamilyMember.RACHEL, current.copy(month = "2026-08"), "2026-09",
        ))
        assertEquals("2026-09", carry.toMonth)
    }
}

class MonthBoundaryApplication : VaultApplication() {
    override val ledgerClock: Clock = Clock.fixed(
        Instant.parse("2026-10-01T02:30:00Z"), ZoneId.of("America/Chicago"),
    )
}
