package com.sats21m.vogelvault.notifications

import android.app.NotificationManager
import androidx.core.app.NotificationCompat
import androidx.core.content.getSystemService
import com.sats21m.vogelvault.domain.FamilyMember
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * L6 from the 2026-09-02 security audit: the notification body carries exact
 * spent/budget USD amounts, so the lock-screen visibility must be SECRET. The
 * amounts themselves must stay in the in-app shade — the guard is against the
 * lock screen, not against the alert.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BudgetNotificationVisibilityTest {
    @Test
    fun `published budget alerts hide every detail from the lock screen`() {
        val context = RuntimeEnvironment.getApplication()
        val publisher = AndroidBudgetAlertPublisher(context)

        publisher.publish(
            BudgetAlert(
                owner = FamilyMember.VICTOR,
                month = "2026-08",
                category = "Groceries",
                level = BudgetAlertLevel.OVER_LIMIT,
                spentCents = 121_99L,
                budgetCents = 100_00L,
            ),
        )

        val manager = context.getSystemService<NotificationManager>()
        val posted = manager?.activeNotifications.orEmpty().single().notification
        assertEquals(
            NotificationCompat.VISIBILITY_SECRET,
            posted.visibility,
            "Budget amounts must never render on the lock screen.",
        )
        assertTrue(
            NotificationCompat.getExtras(posted)
                ?.getString(NotificationCompat.EXTRA_TEXT)
                ?.contains("$121.99") == true,
            "The in-app shade still needs the exact amounts.",
        )
    }
}
