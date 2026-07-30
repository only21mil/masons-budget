package com.sats21m.vogelvault

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.notifications.BudgetNotificationController
import com.sats21m.vogelvault.ui.ProfileSwitchRefusal
import com.sats21m.vogelvault.ui.VaultLockController
import com.sats21m.vogelvault.ui.VaultViewModel
import com.sats21m.vogelvault.ui.titleRes
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Guards the actual MainActivity-to-VaultApp authentication receiver.
 *
 * The broader profile-switch suite drives the real shell and gate, but composes
 * them inside the test. That suite stayed green when MainActivity's receiver was
 * temporarily restored to null, recreating the production wiring defect. This
 * test owns that last boundary by creating MainActivity itself.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityProfileSwitchWiringTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    private lateinit var application: VaultApplication
    private lateinit var originalConfig: ConvexConfig

    private val context: Context
        get() = compose.activity

    @Before
    fun openProductionShell() {
        application = compose.activity.application as VaultApplication
        originalConfig = application.convexConfigSource.current()
        application.convexConfigSource.update(
            ConvexConfig(
                deploymentUrl = "https://keen-elephant-452.convex.cloud",
                readToken = "unit-test-placeholder",
                remoteReadEnabled = true,
            ),
        )
        compose.activityRule.scenario.recreate()

        val activity = compose.activity
        val lock = activity.privateField<VaultLockController>("lockController")
        lock.authenticationSucceeded()
        activity.privateMethod("publishLockState")
        compose.waitForIdle()
    }

    @After
    fun restoreReadConfiguration() {
        notificationManager.cancelAll()
        application.convexConfigSource.update(originalConfig)
    }

    @Test
    fun `production shell sends a profile selection to its authentication gate`() {
        compose.onNodeWithContentDescription(context.getString(R.string.profile_switcher_open))
            .performClick()
        compose.waitForIdle()
        compose.onNode(
            hasText(FamilyMember.RACHEL.displayName) and
                hasClickAction() and
                hasAnyAncestor(isPopup()),
        ).performClick()
        compose.waitForIdle()

        val activity = compose.activity
        val model = activity.privateField<VaultViewModel>("model")
        assertEquals(FamilyMember.VICTOR, model.state.value.activeProfile)
        val lock = activity.privateField<VaultLockController>("lockController")
        assertTrue(
            lock.snapshot().isAuthenticating,
            "The production receiver did not begin profile-switch authentication.",
        )
        assertTrue(
            compose.onAllNodesWithText(
                context.getString(ProfileSwitchRefusal.SHELL_NOT_CONNECTED.titleRes),
            ).fetchSemanticsNodes().isEmpty(),
            "MainActivity composed VaultApp without its authentication receiver.",
        )
    }

    @Test
    fun `production shell removes visible budget amounts when the vault backgrounds`() {
        publishBudgetNotification()
        assertTrue(
            notificationManager.activeNotifications.any { it.notification.channelId == BUDGET_CHANNEL_ID },
            "the privacy test never placed a budget notification in the shade",
        )

        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)

        assertFalse(
            notificationManager.activeNotifications.any { it.notification.channelId == BUDGET_CHANNEL_ID },
            "MainActivity.onStop left a budget notification visible after relocking",
        )
    }

    @Test
    fun `disabling budget alerts removes an already visible amount`() {
        publishBudgetNotification()
        assertTrue(notificationManager.activeNotifications.isNotEmpty())

        BudgetNotificationController(context).setEnabled(FamilyMember.VICTOR, false)

        assertFalse(
            notificationManager.activeNotifications.any { it.notification.channelId == BUDGET_CHANNEL_ID },
            "turning budget alerts off left the previous amount visible",
        )
    }

    private val notificationManager: NotificationManager
        get() = context.getSystemService(NotificationManager::class.java)

    private fun publishBudgetNotification() {
        notificationManager.createNotificationChannel(
            NotificationChannel(
                BUDGET_CHANNEL_ID,
                "Budget privacy test",
                NotificationManager.IMPORTANCE_DEFAULT,
            ),
        )
        notificationManager.notify(
            "budget-privacy-test",
            1,
            Notification.Builder(context, BUDGET_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher_monochrome)
                .setContentTitle("Groceries over budget")
                .setContentText("\$123.45 of \$100.00")
                .build(),
        )
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> MainActivity.privateField(name: String): T {
        val field = MainActivity::class.java.getDeclaredField(name)
        field.isAccessible = true
        return field.get(this) as T
    }

    private fun MainActivity.privateMethod(name: String) {
        val method = MainActivity::class.java.getDeclaredMethod(name)
        method.isAccessible = true
        method.invoke(this)
    }

    private companion object {
        const val BUDGET_CHANNEL_ID = "budget_alerts"
    }
}
