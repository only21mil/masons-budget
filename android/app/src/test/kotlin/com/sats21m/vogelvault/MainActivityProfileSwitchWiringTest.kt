package com.sats21m.vogelvault

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.view.WindowManager
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.notifications.BudgetNotificationController
import com.sats21m.vogelvault.ui.ProfileSwitchRefusal
import com.sats21m.vogelvault.ui.VaultLockController
import com.sats21m.vogelvault.ui.VaultViewModel
import com.sats21m.vogelvault.ui.titleRes
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowSystemClock
import java.time.Duration

/**
 * Guards the actual MainActivity-to-VaultApp authentication receiver.
 *
 * The broader profile-switch suite drives the real shell and gate, but composes
 * them inside the test. That suite stayed green when MainActivity's receiver was
 * temporarily restored to null, recreating the production wiring defect. This
 * test owns that last boundary by creating MainActivity itself.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = MainActivityReadinessTestApplication::class)
class MainActivityProfileSwitchWiringTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    private lateinit var application: MainActivityReadinessTestApplication
    private var originalReadiness = false

    private val context: Context
        get() = compose.activity

    @Before
    fun openProductionShell() {
        application = compose.activity.application as MainActivityReadinessTestApplication
        originalReadiness = application.readReady
        application.readReady = true
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
        application.readReady = originalReadiness
    }

    @Test
    fun `production shell sends a profile selection to its authentication gate`() {
        compose.onNodeWithContentDescription(context.getString(R.string.profile_switcher_open))
            .performClick()
        compose.waitForIdle()
        compose.onNode(
            hasText(FamilyMember.MASON.displayName) and
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
    fun `production child profile requires authentication before returning to an adult`() {
        val model = compose.activity.privateField<VaultViewModel>("model")
        model.switchProfile(FamilyMember.MASON)
        compose.waitForIdle()
        compose.onNodeWithContentDescription(context.getString(R.string.profile_switcher_open)).performClick()
        compose.onNode(
            hasText(FamilyMember.VICTOR.displayName) and hasClickAction() and hasAnyAncestor(isPopup()),
        ).performClick()
        compose.waitForIdle()
        assertEquals(FamilyMember.MASON, model.state.value.activeProfile)
        assertTrue(compose.activity.privateField<VaultLockController>("lockController").snapshot().isAuthenticating)
    }

    @Test
    fun `production adult household switch skips authentication`() {
        compose.onNodeWithContentDescription(context.getString(R.string.profile_switcher_open)).performClick()
        compose.onNode(
            hasText(FamilyMember.RACHEL.displayName) and hasClickAction() and hasAnyAncestor(isPopup()),
        ).performClick()
        compose.waitForIdle()
        assertEquals(
            FamilyMember.RACHEL,
            compose.activity.privateField<VaultViewModel>("model").state.value.activeProfile,
        )
        assertFalse(compose.activity.privateField<VaultLockController>("lockController").snapshot().isAuthenticating)
    }

    @Test
    fun `production share chooser return keeps the session but the next background locks`() {
        val lock = compose.activity.privateField<VaultLockController>("lockController")
        compose.activity.startActivityForResult(
            Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain"), "Share"), 42, null,
        )
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        assertTrue(lock.snapshot().isUnlocked)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        assertTrue(lock.snapshot().isUnlocked)
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        assertFalse(lock.snapshot().isUnlocked)
    }

    @Test
    fun `production share return after thirty seconds requires an unlock`() {
        val lock = compose.activity.privateField<VaultLockController>("lockController")
        compose.activity.startActivityForResult(
            Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain"), "Share"), 42, null,
        )
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        ShadowSystemClock.advanceBy(Duration.ofSeconds(30))
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        assertFalse(lock.snapshot().isUnlocked)
        assertTrue(lock.snapshot().isAuthenticating)
    }

    @Test
    fun `unrelated app launched activity cannot grant return grace`() {
        val lock = compose.activity.privateField<VaultLockController>("lockController")
        compose.activity.startActivityForResult(Intent(Intent.ACTION_VIEW), 43, null)
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        assertFalse(lock.snapshot().isUnlocked)
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

    @Test
    fun `effective read rejection returns the unlocked shell to enrollment`() {
        application.readReady = false
        compose.waitForIdle()

        compose.onNodeWithText(context.getString(R.string.onboarding_title))
            .fetchSemanticsNode()
    }

    @Test
    fun `ledger activity is excluded from screenshots and the recents thumbnail`() {
        assertTrue(
            compose.activity.window.attributes.flags and
                WindowManager.LayoutParams.FLAG_SECURE != 0,
            "The ledger-bearing activity must set FLAG_SECURE.",
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

class MainActivityReadinessTestApplication : VaultApplication() {
    private val readiness = MutableStateFlow(false)
    override val effectiveReadReady: StateFlow<Boolean>
        get() = readiness

    var readReady: Boolean
        get() = readiness.value
        set(value) {
            readiness.value = value
        }
}
